import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { getLatestTenderSnapshot, mapTenderStatusFromUi } from "@/lib/b2b-tender";

const schema = z.object({
  status: z.enum(["DRAFT", "SUBMITTED", "SENT", "WON", "LOST", "EXPIRED", "CANCELLED"]),
  note: z.string().max(500).optional(),
});

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["SENT", "WON", "LOST", "EXPIRED", "CANCELLED"],
  SENT: ["WON", "LOST", "EXPIRED", "CANCELLED"],
  WON: [],
  LOST: [],
  EXPIRED: [],
  CANCELLED: [],
};

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
  const limited = await rateLimit(req, "admin-b2b-tender-status", 60_000, 50);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  const status = mapTenderStatusFromUi(parsed.data.status);

  const params = await context.params;
  const tender = await prisma.tender.findUnique({
    where: { id: params.id },
    select: { id: true, status: true, _count: { select: { versions: true } } },
  });
  if (!tender) return NextResponse.json({ error: "Tender not found" }, { status: 404 });
  if (tender.status === status) {
    const snapshotNoChange = await getLatestTenderSnapshot(params.id);
    return NextResponse.json({ ok: true, snapshot: snapshotNoChange, unchanged: true });
  }
  if (tender.status !== "DRAFT" && status === "DRAFT") {
    return NextResponse.json(
      { error: `Cannot move tender from ${tender.status} back to DRAFT.` },
      { status: 409 },
    );
  }
  const allowedTargets = ALLOWED_TRANSITIONS[tender.status] || [];
  if (!allowedTargets.includes(status)) {
    return NextResponse.json(
      { error: `Cannot move tender from ${tender.status} to ${status}.` },
      { status: 409 },
    );
  }

  const now = new Date();
  await prisma.tender.update({
    where: { id: params.id },
    data: {
      status,
      submittedAt: status === "SUBMITTED" ? now : undefined,
      sentAt: status === "SENT" ? now : undefined,
      wonAt: status === "WON" ? now : undefined,
      lostAt: status === "LOST" ? now : undefined,
      expiredAt: status === "EXPIRED" ? now : undefined,
      cancelledAt: status === "CANCELLED" ? now : undefined,
    },
  });
  const snapshot = await getLatestTenderSnapshot(params.id);
  if (!snapshot) return NextResponse.json({ error: "Tender not found" }, { status: 404 });
  await prisma.tenderVersion.create({
    data: {
      tenderId: params.id,
      versionNo: (tender._count.versions || 0) + 1,
      status,
      snapshot: snapshot as unknown as object,
      changeNote: parsed.data.note?.trim() || `Status updated to ${status}`,
      createdById: user?.id || null,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: "B2B_TENDER_STATUS_UPDATED",
      entityType: "B2B_TENDER",
      entityId: params.id,
      outcome: "SUCCESS",
      meta: JSON.stringify({
        sourcePage: "admin/b2b/tenders",
        operation: "status_update",
        before: { status: tender.status },
        after:  { status },
        note: parsed.data.note?.trim() || null,
        tenderNumber: snapshot.tenderNumber,
        buyerName: snapshot.buyerName,
        actor: { id: user?.id || null, email: user?.email || null, name: user?.name || null },
      }),
    },
  });

  return NextResponse.json({ ok: true, snapshot });
}
