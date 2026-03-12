import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

function roundUpToStep(value: number, step: number) {
  if (step <= 1) return Math.ceil(value);
  return Math.ceil(value / step) * step;
}

async function main() {
  const periodDays = 60;
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - periodDays * 24 * 60 * 60 * 1000);

  const products = await prisma.product.findMany({
    where: { archived: false, deletedAt: null },
    select: {
      id: true,
      name: true,
      stock: true,
      supplier: true,
      supplierId: true,
      supplierRef: { select: { leadTimeDays: true, leadTimeMinDays: true, leadTimeMaxDays: true, name: true, defaultMinOrderQty: true, defaultPackSize: true } },
      supplierLinks: {
        select: {
          supplierId: true,
          isPrimary: true,
          leadTimeDays: true,
          minOrderQty: true,
          packSize: true,
        },
      },
    },
  });
  if (!products.length) {
    console.log("No products found.");
    return;
  }

  const periodOrderItems = await prisma.orderItem.findMany({
    where: {
      createdAt: { gte: periodStart, lte: periodEnd },
      order: { status: { not: "CANCELLED" } },
      productId: { in: products.map((p) => p.id) },
    },
    select: { productId: true, quantity: true },
  });

  const unitsSoldMap = new Map<string, number>();
  for (const item of periodOrderItems) {
    unitsSoldMap.set(item.productId, (unitsSoldMap.get(item.productId) ?? 0) + item.quantity);
  }

  const plans = await prisma.inventoryPlan.findMany({
    where: { productId: { in: products.map((p) => p.id) } },
  });
  const planMap = new Map(plans.map((plan) => [plan.productId, plan]));

  const suppliers = await prisma.supplier.findMany({
    select: { name: true, leadTimeDays: true },
  });
  const supplierLeadTimeByName = new Map(
    suppliers.map((s) => [s.name.toLowerCase(), s.leadTimeDays]),
  );

  const purchases = await prisma.purchase.findMany({
    where: {
      productId: { in: products.map((p) => p.id) },
      deletedAt: null,
      status: { in: ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"] },
    },
    select: { productId: true, quantity: true, orderedQuantity: true, receivedQuantity: true },
  });
  const onOrderMap = new Map<string, number>();
  for (const p of purchases) {
    const ordered = Number(p.orderedQuantity ?? p.quantity);
    const received = Number(p.receivedQuantity ?? 0);
    const remaining = Math.max(0, ordered - received);
    onOrderMap.set(p.productId, (onOrderMap.get(p.productId) ?? 0) + remaining);
  }

  const openOrderItems = await prisma.orderItem.findMany({
    where: {
      productId: { in: products.map((p) => p.id) },
      order: { status: { not: "CANCELLED" }, deletedAt: null },
    },
    select: { productId: true, quantity: true, deliveredQuantity: true, returnedQuantity: true },
  });
  const reservedMap = new Map<string, number>();
  for (const item of openOrderItems) {
    const delivered = Number(item.deliveredQuantity ?? 0);
    const returned = Number(item.returnedQuantity ?? 0);
    const reserved = Math.max(0, item.quantity - delivered - returned);
    if (reserved <= 0) continue;
    reservedMap.set(item.productId, (reservedMap.get(item.productId) ?? 0) + reserved);
  }

  const snapshots: Prisma.DemandSnapshotCreateManyInput[] = [];
  const suggestions: Prisma.RestockSuggestionCreateManyInput[] = [];

  for (const product of products) {
    const unitsSold = unitsSoldMap.get(product.id) ?? 0;
    const avgDaily = unitsSold / periodDays;
    snapshots.push({
      productId: product.id,
      periodStart,
      periodEnd,
      unitsSold,
      avgDailyDemand: new Prisma.Decimal(avgDaily.toFixed(4)),
      source: "orders",
    });

    const plan = planMap.get(product.id);
    const primaryLink =
      product.supplierLinks.find((link) => link.isPrimary) ||
      product.supplierLinks.find((link) => link.supplierId === product.supplierId) ||
      product.supplierLinks[0];
    const nameLeadTime =
      product.supplier && supplierLeadTimeByName.get(product.supplier.toLowerCase());
    const leadTimeDays =
      plan?.leadTimeDays ?? primaryLink?.leadTimeDays ?? product.supplierRef?.leadTimeDays ?? nameLeadTime ?? 14;
    const leadTimeMinDays = product.supplierRef?.leadTimeMinDays ?? null;
    const leadTimeMaxDays = product.supplierRef?.leadTimeMaxDays ?? null;
    const variabilityDays =
      leadTimeMinDays != null && leadTimeMaxDays != null
        ? Math.max(0, (leadTimeMaxDays - leadTimeMinDays) / 2)
        : 0;
    const reviewPeriodDays = plan?.reviewPeriodDays ?? 60;
    const minOrderQty = plan?.minOrderQty ?? primaryLink?.minOrderQty ?? product.supplierRef?.defaultMinOrderQty ?? 1;
    const packSize = primaryLink?.packSize ?? product.supplierRef?.defaultPackSize ?? 1;
    const safetyStock = plan?.safetyStock ?? Math.ceil(avgDaily * leadTimeDays * 0.5 + avgDaily * variabilityDays);
    const reorderPoint = plan?.reorderPoint ?? Math.ceil(avgDaily * leadTimeDays) + safetyStock;
    const targetStock = plan?.targetStock ?? 0;

    const demandDuringLeadTime = avgDaily * leadTimeDays;
    const onOrder = onOrderMap.get(product.id) ?? 0;
    const reserved = reservedMap.get(product.id) ?? 0;
    const available = product.stock - reserved + onOrder;
    const baseSuggested = Math.max(0, safetyStock + demandDuringLeadTime - available);
    const targetSuggested = targetStock > 0 ? Math.max(0, targetStock - available) : 0;
    const rawSuggested = targetStock > 0 ? Math.max(baseSuggested, targetSuggested) : baseSuggested;
    const packRounded = roundUpToStep(rawSuggested, packSize);
    const suggestedQty = Math.max(packRounded, minOrderQty);
    const shouldSuggest = suggestedQty > 0 && available <= reorderPoint;

    if (shouldSuggest) {
      const reason = [
        `Available ${available} below reorder ${reorderPoint}`,
        `Lead time ${leadTimeDays}d demand ${demandDuringLeadTime.toFixed(2)}`,
        `Review window ${reviewPeriodDays}d`,
      ].join(" · ");
      suggestions.push({
        productId: product.id,
        suggestedQty,
        reason,
        status: "open",
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.demandSnapshot.createMany({ data: snapshots });
    await tx.restockSuggestion.deleteMany({
      where: { status: "open", productId: { in: products.map((p) => p.id) } },
    });
    if (suggestions.length) {
      await tx.restockSuggestion.createMany({ data: suggestions });
    }
  });

  console.log(`Recomputed ${snapshots.length} snapshots and ${suggestions.length} suggestions.`);
}

main()
  .catch((err) => {
    console.error("Inventory planning recompute failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
