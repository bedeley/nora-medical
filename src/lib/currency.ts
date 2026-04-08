/**
 * Round a currency value to exactly 2 decimal places using "round half away from zero"
 * (standard accounting rounding). Use this for all financial calculations to prevent
 * floating-point drift across order totals, payments, inventory valuation, and payroll.
 *
 * @example roundCurrency(1.005) → 1.01   roundCurrency(-2.555) → -2.56
 */
export function roundCurrency(value: number): number {
  // "Round half away from zero" — standard accounting rounding.
  // Math.round ties round toward +∞, so we use abs/sign to make negatives symmetric.
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(value) + Number.EPSILON) * 100)) / 100;
}

export function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency: "GHS",
    currencyDisplay: "symbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatDateTimeGH(date: Date | string | number) {
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-GH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "Africa/Accra",
  }).format(d);
}

export function formatDateGH(date: Date | string | number) {
  const d = typeof date === "string" || typeof date === "number" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-GH", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "Africa/Accra",
  }).format(d);
}
