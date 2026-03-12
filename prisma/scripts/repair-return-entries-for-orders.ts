import { prisma } from "@/lib/prisma";
import { setFeatureEnabled } from "@/lib/features";
import { postReturnEntry } from "@/lib/accounting-posting";

type ReturnMeta = {
  itemId?: string;
  quantity?: number;
  refundMode?: "cash" | "credit";
  refundAmount?: number;
  appliedToBalance?: number;
  restockToStock?: boolean;
};

function parseMeta(meta?: string | null): ReturnMeta | null {
  if (!meta) return null;
  try {
    return JSON.parse(meta) as ReturnMeta;
  } catch {
    return null;
  }
}

async function main() {
  const orderIds = process.argv.slice(2).filter(Boolean);
  if (!orderIds.length) {
    console.log("Usage: pnpm db:repair-return-entries <orderId> [orderId...]");
    return;
  }

  await setFeatureEnabled("accounting_auto_post", true);

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, invoiceNumber: true },
  });
  const orderIdSet = new Set(orders.map((o) => o.id));

  const logs = await prisma.auditLog.findMany({
    where: { action: "ORDER_ITEM_RETURN", entityId: { in: Array.from(orderIdSet) } },
    orderBy: { createdAt: "asc" },
  });

  const existingEntries = await prisma.journalEntry.findMany({
    where: {
      status: "POSTED",
      sourceType: "ORDER",
      sourceId: { in: Array.from(orderIdSet) },
      memo: { contains: "Return/refund" },
    },
    select: { id: true },
  });

  if (existingEntries.length) {
    await prisma.journalEntry.updateMany({
      where: { id: { in: existingEntries.map((e) => e.id) } },
      data: { status: "VOID" },
    });
    console.log(`Voided ${existingEntries.length} existing return entries.`);
  }

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
        reason: { in: ["RETURN_PARTIAL", "RETURN_FULL", "RETURN", "RETURN_RESTOCK", "RETURN_ITEM"] },
        delta: quantity,
        createdAt: { gte: start, lte: end },
      },
      select: { id: true },
    });
    const restock = Boolean(meta.restockToStock) || Boolean(restockMovement);

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

  console.log(`Return entry rebuild complete. Posted: ${posted}, Skipped: ${skipped}, Missing: ${missing}`);
}

main()
  .catch((err) => {
    console.error("Repair return entries error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
