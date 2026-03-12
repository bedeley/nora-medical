import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { postDeliverySettlementEntry } from "@/lib/accounting-posting";

const schema = z.object({
  orderIds: z.array(z.string().min(1)).min(1).max(200),
  receivedBy: z.string().min(2).max(80),
  destination: z.enum(["CASH", "BANK"]).optional(),
  reference: z.string().max(80).optional(),
  note: z.string().max(240).optional(),
});

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-delivery-settlement", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const payload = parsed.data;
  const orderIds = Array.from(new Set(payload.orderIds));
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds }, deletedAt: null, status: { not: "CANCELLED" } },
    select: { id: true, invoiceNumber: true, deliveryStatus: true, balance: true },
  });
  if (orders.length !== orderIds.length) {
    return NextResponse.json({ error: "Some orders were not found" }, { status: 404 });
  }
  const invalid = orders.find((o) => String(o.deliveryStatus || "").toUpperCase() !== "DELIVERED");
  if (invalid) {
    return NextResponse.json({ error: "Only delivered orders can be settled" }, { status: 409 });
  }

  const existingSettlementLogs = await prisma.auditLog.findMany({
    where: {
      entityType: "ORDER",
      entityId: { in: orderIds },
      action: "ORDER_DELIVERY_COLLECTION_SETTLED",
    },
    select: { entityId: true, meta: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const alreadySettled = new Set(existingSettlementLogs.map((r) => r.entityId));
  if (alreadySettled.size > 0) {
    const conflicts = orders
      .filter((o) => alreadySettled.has(o.id))
      .map((o) => o.invoiceNumber || o.id)
      .slice(0, 10);
    return NextResponse.json(
      { error: "Some selected orders are already settled", conflicts },
      { status: 409 },
    );
  }

  const collectionLogs = await prisma.auditLog.findMany({
    where: {
      entityType: "ORDER",
      entityId: { in: orderIds },
      action: { in: ["ORDER_DELIVERY_COLLECTION_RECORDED", "ORDER_DELIVERY_COLLECTION_CONFIRMED"] },
    },
    select: { entityId: true, action: true, meta: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  const latestClaimByOrder = new Map<
    string,
    {
      createdAt: Date;
      amount: number;
      collectorId: string | null;
      collectorName: string | null;
      collectorRole: string | null;
    }
  >();
  const latestConfirmByOrder = new Map<string, Date>();

  for (const row of collectionLogs) {
    if (row.action === "ORDER_DELIVERY_COLLECTION_RECORDED" && !latestClaimByOrder.has(row.entityId)) {
      let meta: Record<string, unknown> | null = null;
      try {
        meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null;
      } catch {
        meta = null;
      }
      latestClaimByOrder.set(row.entityId, {
        createdAt: row.createdAt,
        amount: Number(meta?.amount || 0),
        collectorId: String(meta?.collectorId || "").trim() || null,
        collectorName: String(meta?.collectorName || "").trim() || null,
        collectorRole: String(meta?.collectorRole || "").trim().toUpperCase() || null,
      });
    } else if (row.action === "ORDER_DELIVERY_COLLECTION_CONFIRMED" && !latestConfirmByOrder.has(row.entityId)) {
      latestConfirmByOrder.set(row.entityId, row.createdAt);
    }
  }

  const missingClaims = orders.filter((order) => {
    const claim = latestClaimByOrder.get(order.id);
    if (!claim) return true;
    const confirmAt = latestConfirmByOrder.get(order.id);
    return Boolean(confirmAt && confirmAt.getTime() >= claim.createdAt.getTime());
  });
  if (missingClaims.length > 0) {
    return NextResponse.json(
      {
        error: "Settlement requires pending dispatcher collection claims for all selected orders.",
        conflicts: missingClaims.map((o) => o.invoiceNumber || o.id).slice(0, 10),
      },
      { status: 409 },
    );
  }

  const collectorKeys = new Set(
    orders.map((order) => {
      const claim = latestClaimByOrder.get(order.id)!;
      const idPart = claim.collectorId || "";
      const namePart = (claim.collectorName || "").toLowerCase();
      return `${idPart}|${namePart}`;
    }),
  );
  if (collectorKeys.size > 1) {
    return NextResponse.json(
      {
        error: "Selected orders belong to different collectors/riders. Settle one collector batch at a time.",
      },
      { status: 409 },
    );
  }

  const settlementId = `DS-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const settledAt = new Date().toISOString();
  const settledAtDate = new Date(settledAt);
  const totalClaimed = orders.reduce((sum, o) => sum + Number(latestClaimByOrder.get(o.id)?.amount || 0), 0);
  const receivedBy = payload.receivedBy.trim();
  const destination = payload.destination || "CASH";
  const reference = String(payload.reference || "").trim() || null;
  const note = String(payload.note || "").trim() || null;
  let postingStatus: "POSTED" | "FAILED" | "SKIPPED" = "SKIPPED";
  let postingJournalId: string | null = null;
  let postingError: string | null = null;

  if (totalClaimed > 0) {
    try {
      const posted = await postDeliverySettlementEntry({
        settlementId,
        amount: totalClaimed,
        settledAt: settledAtDate,
        receivedBy,
        reference,
        note,
        destination,
      });
      if (posted?.id) {
        postingStatus = "POSTED";
        postingJournalId = posted.id;
      } else {
        postingStatus = "SKIPPED";
      }
    } catch (error) {
      postingStatus = "FAILED";
      postingError = error instanceof Error ? error.message : "Failed to post journal entry";
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        actorId: user?.id || null,
        action: "DELIVERY_COLLECTION_SETTLEMENT_CREATED",
        entityType: "DELIVERY_SETTLEMENT",
        entityId: settlementId,
        meta: JSON.stringify({
          settlementId,
          settledAt,
          receivedBy,
          reference,
          note,
          destination,
          orderIds,
          orderCount: orders.length,
          totalClaimed,
          postingStatus,
          postingJournalId,
          postingError,
        }),
      },
    });

    for (const order of orders) {
      await tx.auditLog.create({
        data: {
          actorId: user?.id || null,
          action: "ORDER_DELIVERY_COLLECTION_SETTLED",
          entityType: "ORDER",
          entityId: order.id,
          meta: JSON.stringify({
            settlementId,
            settledAt,
            receivedBy,
            destination,
            reference,
            note,
            balanceAtSettlement: Number(order.balance || 0),
            claimAmountAtSettlement: Number(latestClaimByOrder.get(order.id)?.amount || 0),
            postingStatus,
            postingJournalId,
            postingError,
          }),
        },
      });
    }
  });

  const settledInvoices = orders.map((o) => o.invoiceNumber || o.id);
  return NextResponse.json({
    ok: true,
    settlement: {
      id: settlementId,
      settledAt,
      orderCount: orders.length,
      totalClaimed,
      receivedBy,
      destination,
      reference,
      note,
      postingStatus,
      postingJournalId,
      postingError,
      orders: settledInvoices,
    },
  });
}
