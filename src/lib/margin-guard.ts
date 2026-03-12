export const DEFAULT_MIN_MARGIN_PCT = Number(process.env.DEFAULT_MIN_MARGIN_PCT || 0);

export function toNumber(value: unknown, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function computeMarginPct(price: number, cost: number) {
  if (!Number.isFinite(price) || price <= 0) return 0;
  const pct = ((price - cost) / price) * 100;
  return Number.isFinite(pct) ? pct : 0;
}

export function resolveMinMarginPct(minMarginPct?: number | null) {
  if (typeof minMarginPct === "number" && Number.isFinite(minMarginPct)) {
    return Math.max(0, minMarginPct);
  }
  return Number.isFinite(DEFAULT_MIN_MARGIN_PCT) ? Math.max(0, DEFAULT_MIN_MARGIN_PCT) : 0;
}

export function getMarginGuardError(args: {
  price: number;
  cost: number;
  minMarginPct?: number | null;
}) {
  const price = toNumber(args.price);
  const cost = toNumber(args.cost);
  if (price <= 0 || cost < 0) return null;
  if (price < cost) {
    return "Price cannot be lower than cost.";
  }
  const minPct = resolveMinMarginPct(args.minMarginPct);
  if (minPct <= 0) return null;
  const marginPct = computeMarginPct(price, cost);
  if (marginPct < minPct) {
    return `Price yields ${marginPct.toFixed(1)}% margin, below the ${minPct}% minimum.`;
  }
  return null;
}
