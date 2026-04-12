import type { InventoryPlan } from "@prisma/client";
import { computeInventoryPlanning, type InventoryPlanningPlanInput } from "@/lib/inventory-planning";
import { prisma } from "@/lib/prisma";

export type InventoryPlanningRow = {
  id: string;
  name: string;
  sku?: string | null;
  category?: string | null;
  supplier?: string | null;
  stock: number;
  reserved: number;
  onOrder: number;
  available: number;
  plan: {
    reorderPoint: number;
    fallbackReorderPoint?: number | null;
    safetyStock: number;
    leadTimeDays: number;
    reviewPeriodDays: number;
    minOrderQty: number;
    approvalThresholdQty?: number | null;
    targetStock: number;
  } | null;
  effectivePlan: {
    reorderPoint: number;
    safetyStock: number;
    leadTimeDays: number;
    reviewPeriodDays: number;
    minOrderQty: number;
    approvalThresholdQty?: number | null;
    targetStock: number;
  };
  planSource: "manual" | "auto";
  demand: {
    periodStart: string;
    periodEnd: string;
    capturedAt: string;
    unitsSold: number;
    avgDailyDemand: string;
  } | null;
  suggestion: {
    id: string | null;
    suggestedQty: number;
    reason?: string | null;
    createdAt: string | null;
  } | null;
};

async function getDefaultReorderPoint() {
  const setting = await prisma.appSetting.findUnique({
    where: { key: "inventoryPlanning.defaultReorderPoint" },
    select: { value: true },
  });
  const raw = typeof setting?.value === "number" ? setting.value : Number(setting?.value);
  return Number.isFinite(raw) && raw >= 0 ? Number(raw) : 10;
}

function toPlanSummary(plan: InventoryPlan | null) {
  if (!plan) return null;
  return {
    reorderPoint: plan.reorderPoint,
    fallbackReorderPoint: plan.fallbackReorderPoint ?? null,
    safetyStock: plan.safetyStock,
    leadTimeDays: plan.leadTimeDays,
    reviewPeriodDays: plan.reviewPeriodDays,
    minOrderQty: plan.minOrderQty,
    approvalThresholdQty: plan.approvalThresholdQty ?? null,
    targetStock: plan.targetStock,
  };
}

export async function getInventoryPlanningData() {
  const lastRecomputeSettingPromise = prisma.appSetting.findMany({
    where: {
      key: {
        in: [
          "inventoryPlanning.lastRecomputeAt",
          "inventoryPlanning.lastRecomputeMode",
        ],
      },
    },
    select: { key: true, value: true },
  });

  const products = await prisma.product.findMany({
    where: { archived: false, deletedAt: null },
    select: {
      id: true,
      name: true,
      sku: true,
      stock: true,
      category: true,
      supplier: true,
      supplierId: true,
      supplierRef: {
        select: {
          name: true,
          leadTimeDays: true,
          leadTimeMinDays: true,
          leadTimeMaxDays: true,
          defaultMinOrderQty: true,
          defaultPackSize: true,
          status: true,
        },
      },
      supplierLinks: {
        select: {
          supplierId: true,
          isPrimary: true,
          leadTimeDays: true,
          minOrderQty: true,
          packSize: true,
        },
      },
      inventoryPlan: true,
    },
    orderBy: { name: "asc" },
  });

  const productIds = products.map((product) => product.id);

  const suppliers = await prisma.supplier.findMany({
    select: { name: true, leadTimeDays: true },
  });
  const supplierLeadTimeByName = new Map(
    suppliers.map((supplier) => [supplier.name.toLowerCase(), supplier.leadTimeDays]),
  );

  const purchases = productIds.length
    ? await prisma.purchase.findMany({
        where: {
          productId: { in: productIds },
          deletedAt: null,
          status: { in: ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"] },
        },
        select: {
          id: true,
          productId: true,
          quantity: true,
          orderedQuantity: true,
          receivedQuantity: true,
          status: true,
        },
      })
    : [];
  const onOrderMap = new Map<string, number>();
  for (const purchase of purchases) {
    const ordered = Number(purchase.orderedQuantity ?? purchase.quantity);
    const received = Number(purchase.receivedQuantity ?? 0);
    const remaining = Math.max(0, ordered - received);
    onOrderMap.set(
      purchase.productId,
      (onOrderMap.get(purchase.productId) ?? 0) + remaining,
    );
  }

  const orderItems = productIds.length
    ? await prisma.orderItem.findMany({
        where: {
          productId: { in: productIds },
          order: { status: { not: "CANCELLED" }, deletedAt: null },
        },
        select: {
          productId: true,
          quantity: true,
          deliveredQuantity: true,
          returnedQuantity: true,
        },
      })
    : [];
  const reservedMap = new Map<string, number>();
  for (const item of orderItems) {
    const delivered = Number(item.deliveredQuantity ?? 0);
    const returned = Number(item.returnedQuantity ?? 0);
    const reserved = Math.max(0, item.quantity - delivered - returned);
    if (reserved <= 0) continue;
    reservedMap.set(item.productId, (reservedMap.get(item.productId) ?? 0) + reserved);
  }

  const snapshots = productIds.length
    ? await prisma.demandSnapshot.findMany({
        where: { productId: { in: productIds } },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const latestSnapshot = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    if (!latestSnapshot.has(snapshot.productId)) {
      latestSnapshot.set(snapshot.productId, snapshot);
    }
  }

  const suggestions = productIds.length
    ? await prisma.restockSuggestion.findMany({
        where: { status: "open", productId: { in: productIds } },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const suggestionMap = new Map<string, (typeof suggestions)[number]>();
  for (const suggestion of suggestions) {
    if (!suggestionMap.has(suggestion.productId)) {
      suggestionMap.set(suggestion.productId, suggestion);
    }
  }

  const defaultReorderPoint = await getDefaultReorderPoint();
  const lastRecomputeSettings = await lastRecomputeSettingPromise;
  const lastRecomputeAtSetting = lastRecomputeSettings.find(
    (setting) => setting.key === "inventoryPlanning.lastRecomputeAt",
  );
  const lastRecomputeModeSetting = lastRecomputeSettings.find(
    (setting) => setting.key === "inventoryPlanning.lastRecomputeMode",
  );

  const lastRecomputeAt =
    typeof lastRecomputeAtSetting?.value === "string" &&
    lastRecomputeAtSetting.value.trim()
      ? lastRecomputeAtSetting.value
      : null;
  const lastRecomputeMode =
    typeof lastRecomputeModeSetting?.value === "string" &&
    lastRecomputeModeSetting.value.trim()
      ? lastRecomputeModeSetting.value
      : null;

  const rows: InventoryPlanningRow[] = products.map((product) => {
    const plan = product.inventoryPlan as InventoryPlanningPlanInput | null;
    const snapshot = latestSnapshot.get(product.id);
    const suggestion = suggestionMap.get(product.id);
    const avgDailyDemand = snapshot ? Number(snapshot.avgDailyDemand) : 0;
    const primaryLink =
      product.supplierLinks.find((link) => link.isPrimary) ||
      product.supplierLinks.find((link) => link.supplierId === product.supplierId) ||
      product.supplierLinks[0];
    const nameLeadTime =
      product.supplier && supplierLeadTimeByName.get(product.supplier.toLowerCase());
    const supplierLeadTime =
      primaryLink?.leadTimeDays ?? product.supplierRef?.leadTimeDays ?? nameLeadTime;
    const leadTimeMinDaysRaw = product.supplierRef?.leadTimeMinDays ?? null;
    const leadTimeMaxDaysRaw = product.supplierRef?.leadTimeMaxDays ?? null;
    const autoLeadTime = Number(supplierLeadTime ?? 14);
    const leadTimeMinDays =
      leadTimeMinDaysRaw == null ? null : Number(leadTimeMinDaysRaw);
    const leadTimeMaxDays =
      leadTimeMaxDaysRaw == null ? null : Number(leadTimeMaxDaysRaw);
    const variabilityDays =
      leadTimeMinDays != null && leadTimeMaxDays != null
        ? Math.max(0, (leadTimeMaxDays - leadTimeMinDays) / 2)
        : 0;
    const autoMinOrderQty =
      primaryLink?.minOrderQty ?? product.supplierRef?.defaultMinOrderQty ?? 1;
    const autoPackSize =
      primaryLink?.packSize ?? product.supplierRef?.defaultPackSize ?? 1;
    const onOrder = onOrderMap.get(product.id) ?? 0;
    const reserved = reservedMap.get(product.id) ?? 0;
    const computed = computeInventoryPlanning({
      stock: product.stock,
      reserved,
      onOrder,
      avgDailyDemand,
      defaultReorderPoint,
      supplierLeadTimeDays: autoLeadTime,
      leadTimeVariabilityDays: variabilityDays,
      autoMinOrderQty,
      autoPackSize,
      plan,
    });

    return {
      id: product.id,
      name: product.name,
      sku: product.sku,
      category: product.category,
      supplier: product.supplierRef?.name || product.supplier,
      stock: product.stock,
      reserved,
      onOrder,
      available: computed.available,
      plan: toPlanSummary(product.inventoryPlan),
      effectivePlan: computed.effectivePlan,
      planSource: plan ? "manual" : "auto",
      demand: snapshot
        ? {
            periodStart: snapshot.periodStart.toISOString(),
            periodEnd: snapshot.periodEnd.toISOString(),
            capturedAt: snapshot.createdAt.toISOString(),
            unitsSold: snapshot.unitsSold,
            avgDailyDemand: snapshot.avgDailyDemand.toString(),
          }
        : null,
      suggestion: suggestion
        ? {
            id: suggestion.id,
            suggestedQty: suggestion.suggestedQty,
            reason: suggestion.reason,
            createdAt: suggestion.createdAt.toISOString(),
          }
        : computed.shouldSuggest
          ? {
              id: null,
              suggestedQty: computed.suggestedQty,
              reason: computed.reason,
              createdAt: null,
            }
          : null,
    };
  });

  return {
    rows,
    meta: {
      generatedAt: new Date().toISOString(),
      lastRecomputeAt,
      lastRecomputeMode,
    },
  };
}
