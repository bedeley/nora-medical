import { prisma } from "@/lib/prisma";
import { PaymentStatus, RefundDestination } from "@/lib/prisma-enums";

type ReturnMeta = {
  itemId?: string;
  quantity?: number;
  refundMode?: "cash" | "credit";
  refundAmount?: number;
  appliedToBalance?: number;
  disposition?: string;
  reason?: string;
  reasonNote?: string;
};

function parseMeta(meta?: string | null): ReturnMeta | null {
  if (!meta) return null;
  try {
    return JSON.parse(meta) as ReturnMeta;
  } catch {
    return null;
  }
}

function parseNote(note?: string | null) {
  if (!note) return null;
  try {
    return JSON.parse(note) as {
      reference?: string;
      balanceAdjustment?: boolean;
      adjustmentAmount?: number;
      appliedToBalance?: number;
    };
  } catch {
    return null;
  }
}

async function main() {
  const logs = await prisma.auditLog.findMany({
    where: { action: "ORDER_ITEM_RETURN", meta: { not: null } },
    orderBy: { createdAt: "asc" },
  });

  let created = 0;
  let skipped = 0;
  let missing = 0;

  for (const log of logs) {
    const meta = parseMeta(log.meta);
    if (!meta?.itemId) {
      missing += 1;
      continue;
    }
    const appliedToBalance = Number(meta.appliedToBalance || 0);
    if (!(appliedToBalance > 0)) {
      skipped += 1;
      continue;
    }

    const orderId = log.entityId;
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true },
    });
    if (!order) {
      missing += 1;
      continue;
    }

    const existing = await prisma.payment.findMany({
      where: {
        orderId,
        amount: 0,
        note: { contains: "\"reference\":\"ITEM_RETURN\"" },
      },
      select: { note: true },
    });
    const alreadyPresent = existing.some((p) => {
      const parsed = parseNote(p.note);
      if (!parsed) return false;
      if (parsed.reference !== "ITEM_RETURN") return false;
      return Boolean(parsed.balanceAdjustment || parsed.adjustmentAmount || parsed.appliedToBalance);
    });
    if (alreadyPresent) {
      skipped += 1;
      continue;
    }

    const refundMode = meta.refundMode === "credit" ? "credit" : "cash";
    const refundDisposition =
      refundMode === "credit" ? RefundDestination.CREDIT : RefundDestination.CASH;

    await prisma.payment.create({
      data: {
        userId: order.userId,
        orderId: order.id,
        amount: 0,
        status: PaymentStatus.NORMAL,
        refundDisposition,
        createdAt: log.createdAt,
        note: JSON.stringify({
          note: `Item return for order ${orderId}`,
          method: refundMode === "cash" ? "cash" : "adjustment",
          reference: "ITEM_RETURN",
          receivedBy: "system",
          location: "backfill/returns",
          status: "refund",
          refundDisposition: refundMode,
          balanceAdjustment: true,
          adjustmentAmount: appliedToBalance,
          appliedToBalance,
          disposition: meta.disposition,
          reason: meta.reason,
          reasonNote: meta.reasonNote,
          orderId,
          item: {
            id: meta.itemId,
            quantity: meta.quantity,
            lineRefund: meta.refundAmount ?? 0,
          },
        }),
      },
    });
    created += 1;
  }

  console.log(
    `Return balance adjustment backfill complete. Created: ${created}, Skipped: ${skipped}, Missing: ${missing}`
  );
}

main()
  .catch((err) => {
    console.error("Backfill return balance adjustments error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
