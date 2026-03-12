import { prisma } from "@/lib/prisma";

type DeliveryMeta = {
  status?: string;
  recipientName?: string;
  recipientPhone?: string;
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

export async function getPodComplianceSnapshot(params?: {
  from?: Date;
  to?: Date;
  thresholdPct?: number;
  minDelivered?: number;
}) {
  const from = params?.from;
  const to = params?.to;
  const thresholdPct = Number(params?.thresholdPct ?? 15);
  const minDelivered = Number(params?.minDelivered ?? 20);

  const deliveredOrders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      status: { not: "CANCELLED" },
      deliveryStatus: "DELIVERED",
      deliveredAt: {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      },
    },
    select: { id: true },
    take: 3000,
  });

  const orderIds = deliveredOrders.map((o) => o.id);
  const deliveryLogs = orderIds.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "ORDER",
          entityId: { in: orderIds },
          action: "ORDER_DELIVERY_STATUS_UPDATE",
        },
        select: { entityId: true, meta: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const latestDeliveredByOrder = new Map<
    string,
    { recipientName?: string; recipientPhone?: string; proofImageUrl?: string }
  >();
  for (const row of deliveryLogs) {
    if (latestDeliveredByOrder.has(row.entityId)) continue;
    const meta = parseMeta(row.meta) as DeliveryMeta | null;
    if (String(meta?.status || "").toUpperCase() !== "DELIVERED") continue;
    latestDeliveredByOrder.set(row.entityId, {
      recipientName: String(meta?.recipientName || "").trim() || undefined,
      recipientPhone: String(meta?.recipientPhone || "").trim() || undefined,
      proofImageUrl: String(meta?.proofImageUrl || "").trim() || undefined,
    });
  }

  let podCaptured = 0;
  for (const order of deliveredOrders) {
    const pod = latestDeliveredByOrder.get(order.id);
    const captured =
      !!String(pod?.recipientName || "").trim() ||
      !!String(pod?.recipientPhone || "").trim() ||
      !!String(pod?.proofImageUrl || "").trim();
    if (captured) podCaptured += 1;
  }

  const delivered = deliveredOrders.length;
  const podMissing = Math.max(0, delivered - podCaptured);
  const podMissingRatePct = delivered > 0 ? Number(((podMissing / delivered) * 100).toFixed(1)) : 0;
  const alert = delivered >= minDelivered && podMissingRatePct >= thresholdPct;

  return {
    delivered,
    podCaptured,
    podMissing,
    podMissingRatePct,
    thresholdPct,
    minDelivered,
    alert,
  };
}

