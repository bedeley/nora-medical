import { prisma } from "@/lib/prisma";
import { setFeatureEnabled } from "@/lib/features";
import { postReturnEntry } from "@/lib/accounting-posting";

type ReturnMeta = {
  itemId?: string;
  quantity?: number;
  refundMode?: "cash" | "credit";
  refundAmount?: number;
  appliedToBalance?: number;
};


function parseMeta(meta?: string | null): ReturnMeta | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta);
    return parsed as ReturnMeta;
  } catch {
    return null;
  }
}

async function main() {
  await setFeatureEnabled("accounting_auto_post", true);

  const logs = await prisma.auditLog.findMany({
    where: { action: "ORDER_ITEM_RETURN", meta: { not: null } },
    orderBy: { createdAt: "asc" },
  });

  let posted = 0;
  let skipped = 0;
  let missing = 0;

  for (const log of logs) {
    const meta = parseMeta(log.meta);
    if (!meta?.itemId) {
      missing += 1;
      continue;
    }
    const orderId = log.entityId;
    const quantity = Number(meta.quantity || 0);
    const refundMode = meta.refundMode === "credit" ? "credit" : "cash";
    const refundAmount = Number(meta.refundAmount || 0);
    const appliedToBalance = Number(meta.appliedToBalance || 0);
    const refundTotal = refundAmount + appliedToBalance;
    if (!(refundTotal > 0) || !(quantity > 0)) {
      skipped += 1;
      continue;
    }

    const orderItem = await prisma.orderItem.findUnique({
      where: { id: meta.itemId },
      include: { product: { select: { name: true, cost: true } } },
    });
    if (!orderItem) {
      missing += 1;
      continue;
    }

    const start = new Date(log.createdAt.getTime() - 10 * 60 * 1000);
    const end = new Date(log.createdAt.getTime() + 10 * 60 * 1000);
    const restockMovement = await prisma.inventoryMovement.findFirst({
      where: {
        productId: orderItem.productId,
        reason: "RETURN_PARTIAL",
        delta: quantity,
        createdAt: { gte: start, lte: end },
      },
      select: { id: true },
    });
    const restock = Boolean(restockMovement);

    const existing = await prisma.journalEntry.findFirst({
      where: {
        sourceType: "ORDER",
        sourceId: orderId,
        status: "POSTED",
        memo: { contains: "Return/refund" },
        entryDate: { gte: start, lte: end },
      },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    const unitCost = Number(orderItem.costAtSale ?? orderItem.product?.cost ?? 0);
    const itemLabel = orderItem.product?.name || "Item";

    await postReturnEntry({
      sourceType: "ORDER",
      sourceId: orderId,
      entryDate: log.createdAt,
      orderId,
      itemLabel,
      refundAmount: refundTotal,
      appliedToBalance,
      refundMode,
      restock,
      cogsAmount: restock ? unitCost * quantity : 0,
    });
    posted += 1;
  }

  console.log(`Return journal backfill complete. Posted: ${posted}, Skipped: ${skipped}, Missing: ${missing}`);
}

main()
  .catch((err) => {
    console.error("Backfill return journal error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
