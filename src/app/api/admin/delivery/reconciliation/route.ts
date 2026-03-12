import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type AssignmentMeta = {
  riderName?: string;
  riderPhone?: string;
};

type SettlementMeta = {
  settlementId?: string;
  reference?: string;
  receivedBy?: string;
};

type CollectionClaimMeta = {
  amount?: number;
  method?: string;
  reference?: string;
  note?: string;
  collectedAt?: string;
  collectorRole?: string;
  collectorId?: string;
  collectorName?: string;
};

type DeliveryMeta = {
  status?: string;
  recipientName?: string;
  recipientPhone?: string;
  deliveryNote?: string;
  proofImageUrl?: string;
};

function parseMeta(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim().toLowerCase();
  const onlyOpen = searchParams.get("onlyOpen") === "1";
  const podMissingOnly = searchParams.get("podMissingOnly") === "1";
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const pageSize = Math.min(100, Math.max(10, Number(searchParams.get("pageSize") || 25)));

  const deliveredOrders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      status: { not: "CANCELLED" },
      deliveryStatus: "DELIVERED",
    },
    select: {
      id: true,
      invoiceNumber: true,
      createdAt: true,
      deliveredAt: true,
      total: true,
      amountPaid: true,
      balance: true,
      walkInName: true,
      walkInPhone: true,
      user: { select: { id: true, name: true, phone: true } },
    },
    orderBy: { deliveredAt: "desc" },
    take: 1000,
  });

  const orderIds = deliveredOrders.map((o) => o.id);
  const assignmentLogs = orderIds.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "ORDER",
          entityId: { in: orderIds },
          action: "ORDER_DELIVERY_ASSIGN",
        },
        select: {
          entityId: true,
          meta: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const settlementLogs = orderIds.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "ORDER",
          entityId: { in: orderIds },
          action: "ORDER_DELIVERY_COLLECTION_SETTLED",
        },
        select: {
          entityId: true,
          meta: true,
          createdAt: true,
          actor: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const collectionLogs = orderIds.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "ORDER",
          entityId: { in: orderIds },
          action: { in: ["ORDER_DELIVERY_COLLECTION_RECORDED", "ORDER_DELIVERY_COLLECTION_CONFIRMED"] },
        },
        select: {
          entityId: true,
          action: true,
          meta: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const deliveryLogs = orderIds.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "ORDER",
          entityId: { in: orderIds },
          action: "ORDER_DELIVERY_STATUS_UPDATE",
        },
        select: {
          entityId: true,
          meta: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const assignmentByOrder = new Map<string, AssignmentMeta>();
  const deliveryByOrder = new Map<
    string,
    { recipientName?: string; recipientPhone?: string; deliveryNote?: string; proofImageUrl?: string }
  >();
  const settlementByOrder = new Map<
    string,
    {
      settlementId?: string;
      reference?: string;
      receivedBy?: string;
      settledAt: string;
      settledBy?: string | null;
      postingStatus?: "POSTED" | "UNPOSTED";
      postingJournalId?: string | null;
    }
  >();
  const collectionClaimByOrder = new Map<
    string,
    {
      amount: number;
      method: string;
      reference: string | null;
      note: string | null;
      collectedAt: string | null;
      collectorRole: string | null;
      collectorId: string | null;
      collectorName: string | null;
      claimCreatedAt: string;
    }
  >();
  const collectionConfirmedAtByOrder = new Map<string, string>();
  for (const row of assignmentLogs) {
    if (assignmentByOrder.has(row.entityId)) continue;
    const meta = parseMeta(row.meta);
    assignmentByOrder.set(row.entityId, {
      riderName: String(meta?.riderName || "").trim() || undefined,
      riderPhone: String(meta?.riderPhone || "").trim() || undefined,
    });
  }
  for (const row of deliveryLogs) {
    if (deliveryByOrder.has(row.entityId)) continue;
    const meta = (parseMeta(row.meta) as DeliveryMeta | null) || null;
    if (String(meta?.status || "").toUpperCase() !== "DELIVERED") continue;
    deliveryByOrder.set(row.entityId, {
      recipientName: String(meta?.recipientName || "").trim() || undefined,
      recipientPhone: String(meta?.recipientPhone || "").trim() || undefined,
      deliveryNote: String(meta?.deliveryNote || "").trim() || undefined,
      proofImageUrl: String(meta?.proofImageUrl || "").trim() || undefined,
    });
  }
  for (const row of settlementLogs) {
    if (settlementByOrder.has(row.entityId)) continue;
    const meta = (parseMeta(row.meta) as SettlementMeta | null) || null;
    settlementByOrder.set(row.entityId, {
      settlementId: String(meta?.settlementId || "").trim() || undefined,
      reference: String(meta?.reference || "").trim() || undefined,
      receivedBy: String(meta?.receivedBy || "").trim() || undefined,
      settledAt: row.createdAt.toISOString(),
      settledBy: row.actor?.name || null,
    });
  }
  for (const row of collectionLogs) {
    if (row.action === "ORDER_DELIVERY_COLLECTION_RECORDED" && !collectionClaimByOrder.has(row.entityId)) {
      const meta = (parseMeta(row.meta) as CollectionClaimMeta | null) || null;
      collectionClaimByOrder.set(row.entityId, {
        amount: Number(meta?.amount || 0),
        method: String(meta?.method || "").trim().toLowerCase() || "cash",
        reference: String(meta?.reference || "").trim() || null,
        note: String(meta?.note || "").trim() || null,
        collectedAt: String(meta?.collectedAt || "").trim() || null,
        collectorRole: String(meta?.collectorRole || "").trim().toUpperCase() || null,
        collectorId: String(meta?.collectorId || "").trim() || null,
        collectorName: String(meta?.collectorName || "").trim() || null,
        claimCreatedAt: row.createdAt.toISOString(),
      });
    }
    if (row.action === "ORDER_DELIVERY_COLLECTION_CONFIRMED" && !collectionConfirmedAtByOrder.has(row.entityId)) {
      collectionConfirmedAtByOrder.set(row.entityId, row.createdAt.toISOString());
    }
  }
  const settlementIds = Array.from(
    new Set(Array.from(settlementByOrder.values()).map((entry) => entry.settlementId).filter(Boolean)),
  ) as string[];
  const postedEntries = settlementIds.length
    ? await prisma.journalEntry.findMany({
        where: { sourceType: "MANUAL", sourceId: { in: settlementIds }, status: "POSTED" },
        select: { id: true, sourceId: true },
      })
    : [];
  const postedBySettlementId = new Map(postedEntries.map((entry) => [entry.sourceId as string, entry.id]));

  const now = Date.now();
  const rows = deliveredOrders
    .map((order) => {
      const rider = assignmentByOrder.get(order.id) || null;
      const deliveredAt = order.deliveredAt || order.createdAt;
      const deliveredMs = deliveredAt.getTime();
      const ageDays = Math.max(0, Math.floor((now - deliveredMs) / 86_400_000));
      const balance = Number(order.balance || 0);
      const settlement = settlementByOrder.get(order.id) || null;
      const claim = collectionClaimByOrder.get(order.id) || null;
      const claimConfirmedAt = collectionConfirmedAtByOrder.get(order.id) || null;
      const hasPendingClaim =
        Boolean(claim) &&
        (!claimConfirmedAt || new Date(claimConfirmedAt).getTime() < new Date(claim!.claimCreatedAt).getTime());
      const pod = deliveryByOrder.get(order.id) || null;
      const podMissing = !String(pod?.recipientName || "").trim() && !String(pod?.recipientPhone || "").trim();
      const settlementPostingStatus = settlement?.settlementId
        ? postedBySettlementId.has(settlement.settlementId)
          ? "POSTED"
          : "UNPOSTED"
        : null;
      const needsAttention = hasPendingClaim || settlementPostingStatus === "UNPOSTED";
      return {
        id: order.id,
        invoiceNumber: order.invoiceNumber,
        deliveredAt: deliveredAt.toISOString(),
        ageDays,
        total: Number(order.total || 0),
        amountPaid: Number(order.amountPaid || 0),
        balance,
        collectionState: balance <= 0.01 ? "CLEARED" : hasPendingClaim ? "PENDING" : "CLEARED",
        hasPendingClaim,
        claimAmount: claim?.amount ?? null,
        claimMethod: claim?.method ?? null,
        claimReference: claim?.reference ?? null,
        claimCollectorName: claim?.collectorName ?? null,
        claimCollectorId: claim?.collectorId ?? null,
        claimCreatedAt: claim?.claimCreatedAt ?? null,
        podMissing,
        recipientName: pod?.recipientName || null,
        recipientPhone: pod?.recipientPhone || null,
        deliveryNote: pod?.deliveryNote || null,
        proofImageUrl: pod?.proofImageUrl || null,
        reconciliationState: settlement ? "SETTLED" : "UNSETTLED",
        settlementId: settlement?.settlementId || null,
        settlementReference: settlement?.reference || null,
        settlementReceivedBy: settlement?.receivedBy || null,
        settledAt: settlement?.settledAt || null,
        settledBy: settlement?.settledBy || null,
        settlementPostingStatus,
        settlementJournalId: settlement?.settlementId
          ? postedBySettlementId.get(settlement.settlementId) || null
          : null,
        needsAttention,
        customer: order.user
          ? {
              id: order.user.id,
              name: order.user.name,
              phone: order.user.phone,
            }
          : {
              id: null,
              name: order.walkInName,
              phone: order.walkInPhone,
            },
        riderName: rider?.riderName || "Unassigned",
        riderPhone: rider?.riderPhone || null,
      };
    })
    .filter((row) => (onlyOpen ? row.needsAttention : true))
    .filter((row) => (podMissingOnly ? row.podMissing : true))
    .filter((row) => {
      if (!q) return true;
      return (
        String(row.invoiceNumber || "").toLowerCase().includes(q) ||
        String(row.customer.name || "").toLowerCase().includes(q) ||
        String(row.customer.phone || "").toLowerCase().includes(q) ||
        String(row.riderName || "").toLowerCase().includes(q)
      );
    });

  const riderMap = new Map<
    string,
    { riderName: string; riderPhone: string | null; deliveredOrders: number; pendingCollections: number; pendingBalance: number }
  >();
  for (const row of rows) {
    const key = `${row.riderName}|${row.riderPhone || ""}`;
    const prev = riderMap.get(key) || {
      riderName: row.riderName,
      riderPhone: row.riderPhone,
      deliveredOrders: 0,
      pendingCollections: 0,
      pendingBalance: 0,
    };
    prev.deliveredOrders += 1;
    if (row.hasPendingClaim) {
      prev.pendingCollections += 1;
      prev.pendingBalance += Number(row.claimAmount || 0);
    }
    riderMap.set(key, prev);
  }

  const riders = Array.from(riderMap.values()).sort((a, b) => b.pendingBalance - a.pendingBalance);

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const items = rows.slice(start, start + pageSize);

  return NextResponse.json({
    items,
    total,
    page,
    pageSize,
    summary: {
      deliveredOrders: rows.length,
      pendingCollections: rows.filter((r) => r.hasPendingClaim).length,
      unsettledCollections: rows.filter((r) => r.hasPendingClaim && r.reconciliationState === "UNSETTLED").length,
      podMissing: rows.filter((r) => r.podMissing).length,
      unpostedSettlements: rows.filter((r) => r.reconciliationState === "SETTLED" && r.settlementPostingStatus === "UNPOSTED")
        .length,
      pendingBalance: rows.reduce((sum, r) => sum + (r.hasPendingClaim ? Number(r.claimAmount || 0) : 0), 0),
      avgPendingAgeDays: (() => {
        const pending = rows.filter((r) => r.hasPendingClaim);
        if (!pending.length) return 0;
        return Math.round(pending.reduce((sum, r) => sum + r.ageDays, 0) / pending.length);
      })(),
    },
    riders,
  });
}
