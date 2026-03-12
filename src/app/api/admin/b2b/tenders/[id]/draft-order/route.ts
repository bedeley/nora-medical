import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";

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
  const limited = await rateLimit(req, "admin-b2b-tender-draft-order", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const params = await context.params;
  const normalizePhone = (value: string | null | undefined) =>
    String(value || "").replace(/\D/g, "");
  const tender = await prisma.tender.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      tenderNumber: true,
      status: true,
      tenderRef: true,
      buyerName: true,
      buyerContact: true,
      buyerEmail: true,
      notes: true,
      items: {
        orderBy: { lineNo: "asc" },
        select: {
          lineNo: true,
          requestedDescription: true,
          quantity: true,
          matchedProductId: true,
          matchedProductName: true,
          bidDisposition: true,
          leadTimeDays: true,
          supplyNote: true,
        },
      },
    },
  });
  if (!tender) return NextResponse.json({ error: "Tender not found" }, { status: 404 });
  if (tender.status !== "WON") {
    return NextResponse.json({ error: "Only WON tenders can be converted to order drafts." }, { status: 409 });
  }

  let linkedCustomer: { id: string } | null = null;
  let customerLinkMethod: "EMAIL" | "PROCUREMENT_REF" | "PHONE" | "NONE" = "NONE";

  if (tender.buyerEmail) {
    linkedCustomer = await prisma.user.findFirst({
      where: { email: tender.buyerEmail, archived: false },
      select: { id: true },
    });
    if (linkedCustomer) customerLinkMethod = "EMAIL";
  }

  if (!linkedCustomer && tender.tenderRef && /^b2b-req-/i.test(tender.tenderRef)) {
    const reqAudit = await prisma.auditLog.findFirst({
      where: {
        entityType: "B2B_PROCUREMENT_REQUEST",
        entityId: tender.tenderRef,
        action: {
          in: [
            "B2B_PROCUREMENT_REQUEST_CREATED",
            "B2B_PROCUREMENT_REQUEST_ASSIGNED",
            "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      select: { meta: true },
    });
    let customerIdFromRef = "";
    try {
      const meta = reqAudit?.meta ? (JSON.parse(reqAudit.meta) as { snapshot?: { customerId?: string } }) : null;
      customerIdFromRef = String(meta?.snapshot?.customerId || "").trim();
    } catch {
      customerIdFromRef = "";
    }
    if (customerIdFromRef) {
      const byRef = await prisma.user.findFirst({
        where: { id: customerIdFromRef, archived: false },
        select: { id: true },
      });
      if (byRef) {
        linkedCustomer = byRef;
        customerLinkMethod = "PROCUREMENT_REF";
      }
    }
  }

  if (!linkedCustomer && tender.buyerName) {
    const normalizeText = (value: string | null | undefined) =>
      String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    const clinicNameNorm = normalizeText(tender.buyerName);
    const buyerContactNorm = normalizeText(tender.buyerContact);
    const buyerPhoneDigits = normalizePhone(tender.buyerContact);

    const reqLogs = await prisma.auditLog.findMany({
      where: {
        entityType: "B2B_PROCUREMENT_REQUEST",
        action: {
          in: [
            "B2B_PROCUREMENT_REQUEST_CREATED",
            "B2B_PROCUREMENT_REQUEST_ASSIGNED",
            "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED",
          ],
        },
        meta: { contains: `"clinicName":"${tender.buyerName.replace(/"/g, '\\"')}` },
      },
      orderBy: { createdAt: "desc" },
      select: { meta: true, createdAt: true },
      take: 100,
    });

    let matchedCustomerId = "";
    for (const log of reqLogs) {
      try {
        const meta = log.meta ? (JSON.parse(log.meta) as { snapshot?: Record<string, unknown> }) : null;
        const snap = (meta?.snapshot || {}) as {
          customerId?: string;
          clinicName?: string | null;
          contactEmail?: string | null;
          contactPhone?: string | null;
          contactName?: string | null;
        };
        if (!snap.customerId) continue;
        const snapClinicNorm = normalizeText(snap.clinicName);
        if (!snapClinicNorm || snapClinicNorm !== clinicNameNorm) continue;
        const snapPhoneDigits = normalizePhone(snap.contactPhone);
        const snapContactNorm = normalizeText(snap.contactName);
        const contactMatches =
          (!!buyerPhoneDigits &&
            !!snapPhoneDigits &&
            (snapPhoneDigits === buyerPhoneDigits ||
              (snapPhoneDigits.length >= 9 &&
                buyerPhoneDigits.length >= 9 &&
                snapPhoneDigits.slice(-9) === buyerPhoneDigits.slice(-9)))) ||
          (!!buyerContactNorm && !!snapContactNorm && snapContactNorm === buyerContactNorm);
        if (contactMatches || !tender.buyerContact) {
          matchedCustomerId = String(snap.customerId).trim();
          break;
        }
      } catch {
        // ignore malformed audit rows
      }
    }
    if (matchedCustomerId) {
      const byClinic = await prisma.user.findFirst({
        where: { id: matchedCustomerId, archived: false },
        select: { id: true },
      });
      if (byClinic) {
        linkedCustomer = byClinic;
        customerLinkMethod = "PROCUREMENT_REF";
      }
    }
  }

  if (!linkedCustomer) {
    const buyerPhoneDigits = normalizePhone(tender.buyerContact);
    if (buyerPhoneDigits.length >= 8) {
      const users = await prisma.user.findMany({
        where: { archived: false, role: "CUSTOMER", phone: { not: null } },
        select: { id: true, phone: true },
        take: 5000,
      });
      linkedCustomer =
        users.find((u) => {
          const p = normalizePhone(u.phone);
          return p === buyerPhoneDigits || (p.length >= 9 && buyerPhoneDigits.length >= 9 && p.slice(-9) === buyerPhoneDigits.slice(-9));
        }) || null;
      if (linkedCustomer) customerLinkMethod = "PHONE";
    }
  }
  const lines = tender.items
    .filter((line) => line.bidDisposition !== "NO_BID")
    .map((line) => ({
      raw: `${line.requestedDescription}, qty ${line.quantity}`,
      itemRef: line.requestedDescription,
      quantity: Math.max(1, Number(line.quantity || 1)),
      productId: line.matchedProductId,
      productName: line.matchedProductName,
      matchedBy: line.matchedProductId ? "tender" : null,
      leadTimeDays: line.leadTimeDays,
      supplyNote: line.supplyNote,
    }));

  const matchedCount = lines.filter((line) => !!line.productId).length;
  const unmatchedCount = lines.length - matchedCount;

  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: "B2B_TENDER_DRAFT_ORDER_PREPARED",
      entityType: "B2B_TENDER",
      entityId: tender.id,
      meta: JSON.stringify({
        tenderNumber: tender.tenderNumber,
        matchedCount,
        unmatchedCount,
        customerLinkMethod,
      }),
    },
  });

  return NextResponse.json({
    ok: true,
    draft: {
      tenderId: tender.id,
      tenderNumber: tender.tenderNumber,
      customerId: linkedCustomer?.id || null,
      customerLinkMethod,
      buyerName: tender.buyerName,
      buyerContact: tender.buyerContact || null,
      buyerEmail: tender.buyerEmail || null,
      notes: tender.notes || null,
      lines,
      matchedCount,
      unmatchedCount,
      canPrefill: matchedCount > 0,
    },
  });
}
