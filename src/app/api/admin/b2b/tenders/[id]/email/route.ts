import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { generateTenderPdf, getLatestTenderSnapshot, type TenderSnapshot } from "@/lib/b2b-tender";
import { sanitizeFreeText } from "@/lib/tender-sanitization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  to: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().email("Recipient email is invalid"),
  ),
  cc: z.preprocess(
    (v) => {
      if (typeof v !== "string") return undefined;
      const trimmed = v.trim();
      return trimmed || undefined;
    },
    z.string().email("CC email is invalid").optional(),
  ),
  message: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.string().max(4000).optional(),
  ),
  versionNo: z.preprocess(
    (v) => {
      if (v == null || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    },
    z.number().int().min(1).optional(),
  ),
});

const SEND_ELIGIBLE_STATUSES = new Set(["SUBMITTED", "SENT"]);

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-b2b-tender-email", 60_000, 20);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const params = await context.params;
  const requireApproval = process.env.B2B_TENDER_REQUIRE_APPROVAL !== "0";
  const protectedAdmins = String(process.env.PROTECTED_ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const actorEmail = String(user?.email || "").trim().toLowerCase();
  const isProtectedAdmin = !!actorEmail && protectedAdmins.includes(actorEmail);
  const latestVersion = await prisma.tenderVersion.findFirst({
    where: { tenderId: params.id },
    select: { versionNo: true },
    orderBy: { versionNo: "desc" },
  });
  if (!latestVersion) {
    return NextResponse.json({ error: "No tender version found. Save tender before sending." }, { status: 409 });
  }
  const tender = await prisma.tender.findUnique({
    where: { id: params.id },
    select: { id: true, status: true, tenderNumber: true, buyerName: true, _count: { select: { versions: true } } },
  });
  if (!tender) return NextResponse.json({ error: "Tender not found" }, { status: 404 });
  if (!SEND_ELIGIBLE_STATUSES.has(tender.status)) {
    return NextResponse.json(
      {
        error:
          tender.status === "DRAFT"
            ? "Submit the tender before sending."
            : `Cannot send tender while status is ${tender.status}.`,
        currentStatus: tender.status,
        allowedStatuses: Array.from(SEND_ELIGIBLE_STATUSES),
      },
      { status: 409 },
    );
  }
  if (requireApproval && !isProtectedAdmin) {
    const latestApproval = await prisma.auditLog.findFirst({
      where: {
        entityType: "B2B_TENDER",
        entityId: params.id,
        action: "B2B_TENDER_APPROVED",
      },
      orderBy: { createdAt: "desc" },
      select: { meta: true, createdAt: true, actorId: true },
    });
    let approvedVersionNo = 0;
    try {
      const meta = latestApproval?.meta ? (JSON.parse(latestApproval.meta) as { approvedVersionNo?: number }) : null;
      approvedVersionNo = Number(meta?.approvedVersionNo || 0);
    } catch {
      approvedVersionNo = 0;
    }
    if (approvedVersionNo < latestVersion.versionNo) {
      return NextResponse.json(
        { error: "Tender must be approved for the latest version before sending." },
        { status: 409 },
      );
    }
  }

  const latestSnapshot = await getLatestTenderSnapshot(params.id);
  if (!latestSnapshot) return NextResponse.json({ error: "Tender not found" }, { status: 404 });
  let snapshot = latestSnapshot;
  if (parsed.data.versionNo != null) {
    const version = await prisma.tenderVersion.findFirst({
      where: { tenderId: params.id, versionNo: parsed.data.versionNo },
      select: { snapshot: true },
    });
    if (!version) {
      return NextResponse.json({ error: "Requested tender version not found" }, { status: 404 });
    }
    const candidate = version.snapshot as unknown;
    if (!candidate || typeof candidate !== "object") {
      return NextResponse.json({ error: "Invalid tender version snapshot" }, { status: 500 });
    }
    snapshot = candidate as TenderSnapshot;
  }

  const pdf = await generateTenderPdf(snapshot);
  const to = parsed.data.to.trim();
  const cc = parsed.data.cc?.trim();
  const intro = parsed.data.message ? sanitizeFreeText(parsed.data.message, 4000) : "";
  const subject = `Tender submission - ${snapshot.tenderNumber}`;
  const text = [
    intro || `Please find attached our tender submission for ${snapshot.buyerName}.`,
    "",
    `Tender Number: ${snapshot.tenderNumber}`,
    `Tender Reference: ${snapshot.tenderRef || "-"}`,
    `Lot: ${snapshot.lotTitle || "-"}`,
    `Total: ${snapshot.currency} ${snapshot.total.toFixed(2)}`,
    "",
    "Regards,",
    "Noralls Medical Supplies",
  ].join("\n");
  const html = text.replace(/\n/g, "<br/>");

  const sent = await sendEmail(to, subject, text, html, {
    attachments: [
      {
        filename: `${snapshot.tenderNumber}.pdf`,
        content: pdf,
        type: "application/pdf",
      },
    ],
  });
  if (!sent.ok) {
    await prisma.auditLog.create({
      data: {
        actorId: user?.id || null,
        action: "B2B_TENDER_SEND_FAILED",
        entityType: "B2B_TENDER",
        entityId: snapshot.id,
        outcome: "FAILED",
        meta: JSON.stringify({
          sourcePage: "admin/b2b/tenders",
          operation: "send_email",
          tenderNumber: snapshot.tenderNumber,
          buyerName: snapshot.buyerName,
          before: { status: tender.status },
          after: { status: tender.status },
          delivery: {
            to,
            cc: cc || null,
            toStatus: "FAILED",
            ccStatus: cc ? "SKIPPED" : null,
            error: sent.error || "Failed to send email",
            channel: "email",
            latestVersionNo: latestVersion.versionNo,
            requestedVersionNo: parsed.data.versionNo || latestVersion.versionNo,
          },
          actor: { id: user?.id || null, email: user?.email || null, name: user?.name || null },
        }),
      },
    });
    return NextResponse.json({ error: sent.error || "Failed to send email" }, { status: 500 });
  }

  // BUG-2 FIX: CC failure is a non-blocking warning — primary send already succeeded.
  // We proceed to update DB state and return ccWarning in the response so the UI can surface it.
  let ccWarning: string | null = null;
  if (cc) {
    const ccResult = await sendEmail(cc, subject, text, html, {
      attachments: [
        {
          filename: `${snapshot.tenderNumber}.pdf`,
          content: pdf,
          type: "application/pdf",
        },
      ],
    });
    if (!ccResult.ok) {
      ccWarning = ccResult.error || "CC email could not be delivered";
      console.warn(`[tender-email] CC delivery failed for tender ${snapshot.id}: ${ccWarning}`);
    }
  }

  const now = new Date().toISOString();
  const updatedSnapshot: TenderSnapshot = {
    ...snapshot,
    status: "SENT",
    sentAt: now,
    updatedAt: now,
  };
  await prisma.tender.update({
    where: { id: snapshot.id },
    data: {
      status: "SENT",
      sentAt: new Date(now),
      recipients: {
        create: [
          {
            recipientType: "TO",
            email: to,
            deliveryChannel: "EMAIL",
            deliveryStatus: "SENT",
            lastSentAt: new Date(now),
            sentById: user?.id || null,
          },
          ...(cc
            ? [
                {
                  recipientType: "CC" as const,
                  email: cc,
                  deliveryChannel: "EMAIL" as const,
                  deliveryStatus: ccWarning ? ("FAILED" as const) : ("SENT" as const),
                  lastSentAt: ccWarning ? null : new Date(now),
                  lastError: ccWarning || null,
                  sentById: user?.id || null,
                },
              ]
            : []),
        ],
      },
    },
  });
  await prisma.tenderVersion.create({
    data: {
      tenderId: snapshot.id,
      versionNo: (tender._count.versions || 0) + 1,
      status: "SENT",
      snapshot: updatedSnapshot as unknown as object,
      changeNote: tender.status === "SENT" ? "Tender resent via email" : "Tender sent via email",
      createdById: user?.id || null,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: tender.status === "SENT" ? "B2B_TENDER_RESENT" : "B2B_TENDER_SENT",
      entityType: "B2B_TENDER",
      entityId: snapshot.id,
      meta: JSON.stringify({
        sourcePage: "admin/b2b/tenders",
        operation: tender.status === "SENT" ? "resend_email" : "send_email",
        before: { status: tender.status },
        after: { status: "SENT" },
        tenderNumber: snapshot.tenderNumber,
        buyerName: snapshot.buyerName,
        snapshot: updatedSnapshot,
        delivery: {
          to,
          cc: cc || null,
          toStatus: "SENT",
          ccStatus: cc ? (ccWarning ? "FAILED" : "SENT") : null,
          ccWarning: ccWarning || null,
          channel: "email",
          at: now,
          latestVersionNo: latestVersion.versionNo,
          requestedVersionNo: parsed.data.versionNo || latestVersion.versionNo,
        },
        actor: { id: user?.id || null, email: user?.email || null, name: user?.name || null },
        outcome: ccWarning ? "PARTIAL" : "SUCCESS",
      }),
      outcome: ccWarning ? "PARTIAL" : "SUCCESS",
    },
  });

  return NextResponse.json({ ok: true, snapshot: updatedSnapshot, ccWarning: ccWarning || undefined });
}
