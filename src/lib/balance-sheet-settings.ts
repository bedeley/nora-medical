export const DEFAULT_BALANCE_TOLERANCE = 0.01;
export const MAX_BALANCE_TOLERANCE = 1000;
export const DEFAULT_DELTA_WARNING_THRESHOLD_PCT = 20;
export const MAX_DELTA_WARNING_THRESHOLD_PCT = 1000;

export function parseBalanceTolerance(value: unknown) {
  if (value === null || value === undefined) return DEFAULT_BALANCE_TOLERANCE;
  if (typeof value === "string" && !value.trim()) return DEFAULT_BALANCE_TOLERANCE;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_BALANCE_TOLERANCE;
  return Math.min(n, MAX_BALANCE_TOLERANCE);
}

export function isBalancedWithinTolerance(balanceDifference: number, tolerance: number) {
  const safeTolerance = parseBalanceTolerance(tolerance);
  return Math.abs(balanceDifference) <= safeTolerance;
}

export function parseDeltaWarningThresholdPct(value: unknown) {
  if (value === null || value === undefined) return DEFAULT_DELTA_WARNING_THRESHOLD_PCT;
  if (typeof value === "string" && !value.trim()) return DEFAULT_DELTA_WARNING_THRESHOLD_PCT;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DELTA_WARNING_THRESHOLD_PCT;
  return Math.min(n, MAX_DELTA_WARNING_THRESHOLD_PCT);
}
