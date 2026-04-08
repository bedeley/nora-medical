export type DashboardGroupBy = "day" | "week" | "month" | "year";

export type DashboardFilters = {
  start: string;
  end: string;
  customer: string;
  category: string;
};

export type DashboardTrendLike = {
  date: string;
  period?: string;
  revenue?: number;
  refunds?: number;
  netRevenue?: number;
  payrollExpense?: number;
  cashIn?: number;
  cashOut?: number;
  netCash?: number;
  outstanding?: number;
};

export type DashboardDeltaValue = {
  current: number;
  previous: number;
  delta: number;
  percent: number | null;
};

export type DashboardPreviousBucketDelta = {
  revenue: DashboardDeltaValue;
  refunds: DashboardDeltaValue;
  netRevenue: DashboardDeltaValue;
  cashIn: DashboardDeltaValue;
  cashOut: DashboardDeltaValue;
  netCash: DashboardDeltaValue;
  outstanding: DashboardDeltaValue;
};

export function normalizeDashboardTrendRows<T extends DashboardTrendLike>(
  rows: T[],
): Array<T & { period: string; payrollExpense: number; rollingRevenue: number }> {
  const normalized = rows.map((row) => ({
    ...row,
    period: row.period || row.date,
    payrollExpense: Number(row.payrollExpense || 0),
  }));

  return normalized.map((row, idx, arr) => {
    const start = Math.max(0, idx - 6);
    const window = arr.slice(start, idx + 1);
    const avg =
      window.reduce((sum, item) => sum + Number(item.revenue || 0), 0) /
      Math.max(1, window.length);

    return {
      ...row,
      rollingRevenue: avg,
    };
  });
}

export function buildDashboardPreviousBucketDelta(
  rows: Array<
    Pick<
      DashboardTrendLike,
      "date" | "revenue" | "refunds" | "netRevenue" | "cashIn" | "cashOut" | "netCash" | "outstanding"
    >
  >,
): DashboardPreviousBucketDelta | null {
  if (rows.length < 2) return null;

  const current = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  const buildDelta = (curr: number, prev: number) => {
    const delta = curr - prev;
    const percent = prev !== 0 ? (delta / prev) * 100 : null;
    return { current: curr, previous: prev, delta, percent };
  };

  return {
    revenue: buildDelta(Number(current.revenue || 0), Number(previous.revenue || 0)),
    refunds: buildDelta(Number(current.refunds || 0), Number(previous.refunds || 0)),
    netRevenue: buildDelta(Number(current.netRevenue || 0), Number(previous.netRevenue || 0)),
    cashIn: buildDelta(Number(current.cashIn || 0), Number(previous.cashIn || 0)),
    cashOut: buildDelta(Number(current.cashOut || 0), Number(previous.cashOut || 0)),
    netCash: buildDelta(Number(current.netCash || 0), Number(previous.netCash || 0)),
    outstanding: buildDelta(Number(current.outstanding || 0), Number(previous.outstanding || 0)),
  };
}

export function formatDashboardDeltaLabel(
  value: DashboardDeltaValue,
  groupBy: DashboardGroupBy,
  formatCurrency: (value: number) => string,
) {
  const sign = value.delta >= 0 ? "+" : "-";
  const absDelta = formatCurrency(Math.abs(value.delta));
  if (value.percent === null) return `${sign}${absDelta} vs previous ${groupBy}`;
  return `${sign}${absDelta} (${sign}${Math.abs(value.percent).toFixed(1)}%) vs previous ${groupBy}`;
}

export function formatDashboardActivePeriodLabel(start: string, end: string) {
  const normalizedStart = start.trim();
  const normalizedEnd = end.trim();

  if (normalizedStart && normalizedEnd) return `${normalizedStart} to ${normalizedEnd}`;
  if (normalizedStart) return `From ${normalizedStart}`;
  if (normalizedEnd) return `Up to ${normalizedEnd}`;
  return "All time";
}

export function appendDashboardPeriodParams(path: string, start: string, end: string) {
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  if (!params.toString()) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${params.toString()}`;
}

export function countDashboardActiveFilters(
  filters: DashboardFilters,
  groupBy: DashboardGroupBy,
) {
  return [
    filters.start ? 1 : 0,
    filters.end ? 1 : 0,
    filters.customer ? 1 : 0,
    filters.category ? 1 : 0,
    groupBy !== "day" ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
}

export function buildDashboardAnomalyChips({
  outstandingRatio,
  netCash,
  glRevenueDelta,
  formatCurrency,
}: {
  outstandingRatio: number;
  netCash: number;
  glRevenueDelta: number | null;
  formatCurrency: (value: number) => string;
}) {
  return [
    {
      key: "high-outstanding",
      show: outstandingRatio > 0.25,
      label: `High outstanding ratio (${(outstandingRatio * 100).toFixed(1)}%)`,
      tone: "text-amber-700 bg-amber-50 border-amber-200",
    },
    {
      key: "negative-net-cash",
      show: netCash < 0,
      label: "Negative net cash in selected period",
      tone: "text-red-700 bg-red-50 border-red-200",
    },
    {
      key: "gl-delta",
      show: glRevenueDelta !== null && glRevenueDelta > 1,
      label: `GL vs operational revenue gap: ${formatCurrency(glRevenueDelta || 0)} - check unposted entries`,
      tone: "text-amber-700 bg-amber-50 border-amber-200",
    },
  ].filter((chip) => chip.show);
}
