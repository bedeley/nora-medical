export type ReportingReconciliationSnapshot = {
  totalRevenue?: number | null;
  totalDiscounts?: number | null;
  totalRefunds?: number | null;
  netRevenue?: number | null;
  totalTaxCollected?: number | null;
  totalCOGS?: number | null;
  totalExpense?: number | null;
  profit?: number | null;
  totalCashIn?: number | null;
  totalCashOut?: number | null;
  netCash?: number | null;
};

export type ReportingReconciliationStatus = "aligned" | "within_tolerance" | "review";

export type ReportingReconciliationRow = {
  key: keyof ReportingReconciliationSnapshot;
  label: string;
  operational: number;
  ledger: number;
  delta: number;
  absoluteDelta: number;
  percentDelta: number | null;
  status: ReportingReconciliationStatus;
  tolerance: number;
};

export type ReportingReconciliationReport = {
  rows: ReportingReconciliationRow[];
  alignedCount: number;
  withinToleranceCount: number;
  reviewCount: number;
  maxAbsoluteDelta: number;
};

const DEFAULT_TOLERANCE = 1;
const EXACT_MATCH_EPSILON = 0.01;

const METRIC_DEFINITIONS: Array<{
  key: keyof ReportingReconciliationSnapshot;
  label: string;
  tolerance?: number;
}> = [
  { key: "totalRevenue", label: "Revenue" },
  { key: "totalDiscounts", label: "Discounts" },
  { key: "totalRefunds", label: "Refunds" },
  { key: "netRevenue", label: "Net Revenue" },
  { key: "totalTaxCollected", label: "Tax Collected" },
  { key: "totalCOGS", label: "COGS" },
  { key: "totalExpense", label: "Expenses" },
  { key: "profit", label: "Net Profit" },
  { key: "totalCashIn", label: "Cash In" },
  { key: "totalCashOut", label: "Cash Out" },
  { key: "netCash", label: "Net Cash" },
];

function toNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildReportingReconciliation(input: {
  operational?: ReportingReconciliationSnapshot | null;
  ledger?: ReportingReconciliationSnapshot | null;
}): ReportingReconciliationReport | null {
  if (!input.operational || !input.ledger) return null;

  const rows = METRIC_DEFINITIONS.flatMap((metric) => {
    const operational = toNumber(input.operational?.[metric.key]);
    const ledger = toNumber(input.ledger?.[metric.key]);
    if (operational == null || ledger == null) return [];

    const delta = ledger - operational;
    const absoluteDelta = Math.abs(delta);
    const tolerance = metric.tolerance ?? DEFAULT_TOLERANCE;
    const percentDelta =
      Math.abs(operational) > EXACT_MATCH_EPSILON ? (delta / operational) * 100 : null;
    const status: ReportingReconciliationStatus =
      absoluteDelta <= EXACT_MATCH_EPSILON
        ? "aligned"
        : absoluteDelta <= tolerance
          ? "within_tolerance"
          : "review";

    return [{
      key: metric.key,
      label: metric.label,
      operational,
      ledger,
      delta,
      absoluteDelta,
      percentDelta,
      status,
      tolerance,
    }];
  });

  if (rows.length === 0) return null;

  return {
    rows,
    alignedCount: rows.filter((row) => row.status === "aligned").length,
    withinToleranceCount: rows.filter((row) => row.status === "within_tolerance").length,
    reviewCount: rows.filter((row) => row.status === "review").length,
    maxAbsoluteDelta: rows.reduce((max, row) => Math.max(max, row.absoluteDelta), 0),
  };
}
