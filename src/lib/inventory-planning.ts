export type InventoryPlanningPlanInput = {
  reorderPoint: number;
  fallbackReorderPoint?: number | null;
  safetyStock: number;
  leadTimeDays: number;
  reviewPeriodDays: number;
  minOrderQty: number;
  approvalThresholdQty?: number | null;
  targetStock: number;
};

type ComputeInventoryPlanningArgs = {
  stock: number;
  reserved: number;
  onOrder: number;
  avgDailyDemand: number;
  defaultReorderPoint: number;
  supplierLeadTimeDays?: number | null;
  leadTimeVariabilityDays?: number | null;
  autoMinOrderQty?: number | null;
  autoPackSize?: number | null;
  plan?: InventoryPlanningPlanInput | null;
};

export type InventoryPlanningComputed = {
  available: number;
  effectivePlan: {
    reorderPoint: number;
    safetyStock: number;
    leadTimeDays: number;
    reviewPeriodDays: number;
    minOrderQty: number;
    approvalThresholdQty: number | null;
    targetStock: number;
  };
  autoPlan: {
    reorderPoint: number;
    safetyStock: number;
    leadTimeDays: number;
    reviewPeriodDays: number;
    minOrderQty: number;
    approvalThresholdQty: null;
    targetStock: number;
  };
  suggestedQty: number;
  shouldSuggest: boolean;
  daysOfCover: number | null;
  reason: string | null;
};

export function roundUpToStep(value: number, step: number) {
  if (step <= 1) return Math.ceil(value);
  return Math.ceil(value / step) * step;
}

function normalizePositiveInteger(value: number | null | undefined, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.max(1, Math.round(numeric));
}

export function buildInventorySuggestionReason(args: {
  available: number;
  reorderPoint: number;
  leadTimeDays: number;
  demandDuringLeadTime: number;
  reviewPeriodDays: number;
}) {
  return [
    `Available ${args.available} below reorder ${args.reorderPoint}`,
    `Lead time ${args.leadTimeDays}d demand ${args.demandDuringLeadTime.toFixed(2)}`,
    `Review window ${args.reviewPeriodDays}d`,
  ].join(" / ");
}

export function computeInventoryPlanning(args: ComputeInventoryPlanningArgs): InventoryPlanningComputed {
  const available = Number(args.stock) - Number(args.reserved) + Number(args.onOrder);
  const avgDailyDemand = Number.isFinite(args.avgDailyDemand) ? Math.max(0, args.avgDailyDemand) : 0;
  const leadTimeDays = normalizePositiveInteger(args.supplierLeadTimeDays, 14);
  const leadTimeVariabilityDays =
    args.leadTimeVariabilityDays == null || !Number.isFinite(args.leadTimeVariabilityDays)
      ? 0
      : Math.max(0, Number(args.leadTimeVariabilityDays));
  const fallbackReorderPoint = Math.max(0, Number(args.defaultReorderPoint) || 0);
  const autoSafetyStock =
    avgDailyDemand > 0
      ? Math.ceil(avgDailyDemand * leadTimeDays * 0.5 + avgDailyDemand * leadTimeVariabilityDays)
      : 0;
  const autoReorderPoint =
    avgDailyDemand > 0 ? Math.ceil(avgDailyDemand * leadTimeDays) + autoSafetyStock : fallbackReorderPoint;
  const autoMinOrderQty = normalizePositiveInteger(args.autoMinOrderQty, 1);
  const autoPackSize = normalizePositiveInteger(args.autoPackSize, 1);

  const autoPlan = {
    reorderPoint: autoReorderPoint,
    safetyStock: autoSafetyStock,
    leadTimeDays,
    reviewPeriodDays: 60,
    minOrderQty: autoMinOrderQty,
    approvalThresholdQty: null,
    targetStock: 0,
  };

  const manualPlan = args.plan;
  const effectivePlan = manualPlan
    ? {
        reorderPoint:
          avgDailyDemand <= 0 && manualPlan.fallbackReorderPoint != null
            ? manualPlan.fallbackReorderPoint
            : manualPlan.reorderPoint,
        safetyStock: manualPlan.safetyStock,
        leadTimeDays: normalizePositiveInteger(manualPlan.leadTimeDays, 14),
        reviewPeriodDays: normalizePositiveInteger(manualPlan.reviewPeriodDays, 60),
        minOrderQty: normalizePositiveInteger(manualPlan.minOrderQty, 1),
        approvalThresholdQty: manualPlan.approvalThresholdQty ?? null,
        targetStock: Math.max(0, Number(manualPlan.targetStock) || 0),
      }
    : autoPlan;

  const demandDuringLeadTime = avgDailyDemand * effectivePlan.leadTimeDays;
  const baseSuggested =
    avgDailyDemand > 0
      ? Math.max(0, effectivePlan.safetyStock + demandDuringLeadTime - available)
      : Math.max(0, effectivePlan.reorderPoint - available);
  const targetSuggested =
    effectivePlan.targetStock > 0 ? Math.max(0, effectivePlan.targetStock - available) : 0;
  const rawSuggested =
    effectivePlan.targetStock > 0 ? Math.max(baseSuggested, targetSuggested) : baseSuggested;
  const packRounded = roundUpToStep(rawSuggested, autoPackSize);
  const suggestedQty = rawSuggested > 0 ? Math.max(packRounded, effectivePlan.minOrderQty) : 0;
  const shouldSuggest = suggestedQty > 0 && available <= effectivePlan.reorderPoint;
  const daysOfCover =
    avgDailyDemand > 0 ? Math.max(0, available) / avgDailyDemand : null;

  return {
    available,
    effectivePlan,
    autoPlan,
    suggestedQty,
    shouldSuggest,
    daysOfCover,
    reason: shouldSuggest
      ? buildInventorySuggestionReason({
          available,
          reorderPoint: effectivePlan.reorderPoint,
          leadTimeDays: effectivePlan.leadTimeDays,
          demandDuringLeadTime,
          reviewPeriodDays: effectivePlan.reviewPeriodDays,
        })
      : null,
  };
}
