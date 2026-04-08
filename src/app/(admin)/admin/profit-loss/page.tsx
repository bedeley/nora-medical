"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import ReportingReconciliationPanel from "@/components/admin/ReportingReconciliationPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import {
  buildReportingReconciliation,
  type ReportingReconciliationSnapshot,
} from "@/lib/reporting-reconciliation";
import { toast } from "sonner";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

type ExpenseBreakdownRow = { category: string; amount: number };
type ReportSource = "operational" | "ledger";
type TrendRow = {
  date: string;
  revenue: number;
  refunds: number;
  netRevenue?: number;
  cogs: number;
  expense: number;
  payrollExpense: number;
  profit: number;
  margin: number;
  cashIn: number;
  cashOut: number;
  netCash: number;
  outstanding: number;
  orderCount: number;
  averageOrderValue: number;
  deliveredCount: number;
  partiallyDeliveredCount: number;
  returnedCount: number;
  pendingCount: number;
};
type SummaryPayload = {
  summary?: {
    totalRevenue: number;
    totalRefunds?: number;
    netRevenue?: number;
    totalCOGS: number;
    totalExpense: number;
    profit: number;
    margin: number;
    totalTaxCollected?: number;
    totalDiscounts?: number;
    discountedOrders?: number;
    expenseBreakdown?: ExpenseBreakdownRow[];
  };
  trend?: TrendRow[];
  groupBy?: string;
};

const fetcher = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load profit/loss data (${response.status})`);
  }
  return response.json();
};

function formatPeriodLabel(value: string) {
  if (!value) return "";
  if (/^\d{4}$/.test(value)) return value;
  if (/^\d{4}-W\d{2}$/.test(value)) {
    const [year, week] = value.split("-W");
    return `Week ${week}, ${year}`;
  }
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    const parsed = new Date(year, month - 1, 1);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
      });
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString(undefined, {
        month: "short",
        day: "2-digit",
        weekday: "short",
      });
    }
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "2-digit",
    weekday: "short",
  });
}

function ProfitLossContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);

  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month" | "year">("day");
  const [customer, setCustomer] = useState<string>("");
  const [customerInput, setCustomerInput] = useState<string>("");
  const [category, setCategory] = useState<string>("");
  const [categoryInput, setCategoryInput] = useState<string>("");
  const [excludeZero, setExcludeZero] = useState(true);
  const [sparkWindow, setSparkWindow] = useState<30 | 90>(30);
  const [updatedAtText, setUpdatedAtText] = useState<string>("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sourceOverride, setSourceOverride] = useState<ReportSource | "">("");
  const [exportingCsv, setExportingCsv] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const { data: reportingMode, error: reportingModeError } = useClientQuery<{ value: boolean | null }>({
    queryKey: ["accounting", "reporting", "use-ledger"],
    queryFn: async () => {
      const response = await fetch("/api/admin/settings/app?key=accounting.reporting.useLedger");
      if (!response.ok) {
        throw new Error(`Failed to load reporting mode (${response.status})`);
      }
      return response.json();
    },
  });
  const defaultSource: ReportSource | null =
    reportingMode?.value === true
      ? "ledger"
      : reportingMode?.value === false || reportingMode?.value === null
        ? "operational"
        : null;
  const activeSource = sourceOverride || defaultSource;
  const useLedger = activeSource === "ledger";
  const isSourceOverridden = Boolean(sourceOverride);
  const activeSourceLabel = useLedger ? "Posted Ledger View" : "Operational View";
  const defaultSourceLabel = defaultSource === "ledger" ? "Posted Ledger View" : "Operational View";

  const selectSource = (value: ReportSource | "default") => {
    if (value === "default") {
      setSourceOverride("");
      return;
    }
    if (defaultSource && value === defaultSource) {
      setSourceOverride("");
      return;
    }
    setSourceOverride(value);
  };

  // Initialize from URL once
  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams?.toString() || "");
    const s0 = sp.get("start") || "";
    const e0 = sp.get("end") || "";
    const g0 = (sp.get("groupBy") as "day" | "week" | "month" | "year" | null) || "day";
    const c0 = sp.get("customer") || "";
    const cat0 = sp.get("category") || "";
    const source0 = sp.get("source");
    const p0 = Number(sp.get("page") || 1);
    const ps0 = Number(sp.get("pageSize") || 25);
    if (s0) setStart(s0);
    if (e0) setEnd(e0);
    if (["day", "week", "month", "year"].includes(g0)) setGroupBy(g0);
    if (c0) { setCustomer(c0); setCustomerInput(c0); }
    if (cat0) { setCategory(cat0); setCategoryInput(cat0); }
    if (source0 === "ledger" || source0 === "operational") setSourceOverride(source0);
    if (!Number.isNaN(p0) && p0 > 0) setPage(p0);
    if (!Number.isNaN(ps0) && ps0 > 0) setPageSize(ps0);
    initialized.current = true;
  }, [searchParams]);

  // Reflect to URL (avoid using searchParams as a dependency to prevent loops)
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams();
    if (start) params.set("start", start); else params.delete("start");
    if (end) params.set("end", end); else params.delete("end");
    if (groupBy) params.set("groupBy", groupBy); else params.delete("groupBy");
    if (customer) params.set("customer", customer); else params.delete("customer");
    if (category) params.set("category", category); else params.delete("category");
    if (sourceOverride) params.set("source", sourceOverride); else params.delete("source");
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [start, end, groupBy, customer, category, sourceOverride, page, pageSize, pathname, router]);

  const requestParams = useMemo(() => {
    const p = new URLSearchParams();
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    if (groupBy) p.set("groupBy", groupBy);
    if (customer) p.set("customer", customer);
    if (category) p.set("category", category);
    return p.toString();
  }, [start, end, groupBy, customer, category]);
  const operationalApiUrl = useMemo(
    () => `/api/admin/summary?${requestParams}`,
    [requestParams],
  );
  const ledgerApiUrl = useMemo(
    () => `/api/admin/accounting/reports/ledger-summary?${requestParams}`,
    [requestParams],
  );
  const apiUrl = !activeSource ? null : useLedger ? ledgerApiUrl : operationalApiUrl;
  const comparisonApiUrl = !activeSource ? null : useLedger ? operationalApiUrl : ledgerApiUrl;

  const { data, error, isLoading } = useClientQuery<SummaryPayload>({
    queryKey: ["admin","summary", { start, end, groupBy, customer, category, activeSource }],
    queryFn: () => fetcher(apiUrl || ""),
    enabled: Boolean(apiUrl),
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { data: comparisonData, isLoading: isComparisonLoading } = useClientQuery<SummaryPayload>({
    queryKey: ["admin", "summary-comparison", { start, end, groupBy, customer, category, activeSource }],
    queryFn: () => fetcher(comparisonApiUrl || ""),
    enabled: Boolean(comparisonApiUrl),
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  async function exportFile(kind: "csv" | "pdf") {
    if (useLedger) {
      toast.error("Export is available from Accounting Reports in Posted Ledger View.");
      return;
    }
    const setter = kind === "csv" ? setExportingCsv : setExportingPdf;
    setter(true);
    try {
      const p = new URLSearchParams();
      if (start) p.set("start", start);
      if (end) p.set("end", end);
      p.set("groupBy", groupBy);
      if (customer) p.set("customer", customer);
      if (category) p.set("category", category);
      p.set("format", kind);
      const res = await fetch(`/api/admin/summary?${p.toString()}`);
      if (!res.ok) {
        toast.error(`Failed to export ${kind.toUpperCase()}.`);
        return;
      }
      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = kind === "csv" ? `pl_${Date.now()}.csv` : `pl_${Date.now()}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(link.href);
    } finally {
      setter(false);
    }
  }

  const summary = data?.summary;
  const totalDiscountsRaw = summary?.totalDiscounts;
  const totalRefundsRaw = summary?.totalRefunds;
  const netRevenueRaw = summary?.netRevenue;
  const totalTaxCollectedRaw = summary?.totalTaxCollected;
  const trend = useMemo(() => data?.trend || [], [data]);
  const filteredTrend = useMemo(() => {
    if (!excludeZero) return trend;
    return trend.filter((t) => {
      const revenue = Number(t.revenue || 0);
      const cogs = Number(t.cogs || 0);
      const expense = Number(t.expense || 0);
      const profit = Number(t.profit || 0);
      return revenue !== 0 || cogs !== 0 || expense !== 0 || profit !== 0;
    });
  }, [trend, excludeZero]);

  useEffect(() => {
    const id = setTimeout(() => setCustomer(customerInput), 300);
    return () => clearTimeout(id);
  }, [customerInput]);

  useEffect(() => {
    const id = setTimeout(() => setCategory(categoryInput), 300);
    return () => clearTimeout(id);
  }, [categoryInput]);

  useEffect(() => {
    setPage(1);
  }, [start, end, groupBy, customer, category, excludeZero]);

  const totalPages = Math.max(1, Math.ceil(filteredTrend.length / pageSize));
  const paginatedTrend = useMemo(() => {
    const startIdx = (page - 1) * pageSize;
    return filteredTrend.slice(startIdx, startIdx + pageSize);
  }, [filteredTrend, page, pageSize]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  useEffect(() => {
    if (trend.length === 0) return;
    setUpdatedAtText(new Date().toLocaleString());
  }, [trend.length]);

  const totalRefunds = Number(totalRefundsRaw || 0);
  const totalDiscounts = Number(totalDiscountsRaw || 0);
  const netRevenue = Number(netRevenueRaw || 0);
  const totalTaxCollected = Number(totalTaxCollectedRaw || 0);
  const operationalComparisonSummary = (useLedger ? comparisonData?.summary : data?.summary) || null;
  const ledgerComparisonSummary = (useLedger ? data?.summary : comparisonData?.summary) || null;
  const reconciliationReport = useMemo(() => {
    const operationalSnapshot: ReportingReconciliationSnapshot | null = operationalComparisonSummary
      ? {
          totalRevenue: operationalComparisonSummary.totalRevenue,
          totalDiscounts: operationalComparisonSummary.totalDiscounts,
          totalRefunds: operationalComparisonSummary.totalRefunds,
          netRevenue: operationalComparisonSummary.netRevenue,
          totalTaxCollected: operationalComparisonSummary.totalTaxCollected,
          totalCOGS: operationalComparisonSummary.totalCOGS,
          totalExpense: operationalComparisonSummary.totalExpense,
          profit: operationalComparisonSummary.profit,
          totalCashIn: undefined,
          totalCashOut: undefined,
          netCash: undefined,
        }
      : null;
    const ledgerSnapshot: ReportingReconciliationSnapshot | null = ledgerComparisonSummary
      ? {
          totalRevenue: ledgerComparisonSummary.totalRevenue,
          totalDiscounts: ledgerComparisonSummary.totalDiscounts,
          totalRefunds: ledgerComparisonSummary.totalRefunds,
          netRevenue: ledgerComparisonSummary.netRevenue,
          totalTaxCollected: ledgerComparisonSummary.totalTaxCollected,
          totalCOGS: ledgerComparisonSummary.totalCOGS,
          totalExpense: ledgerComparisonSummary.totalExpense,
          profit: ledgerComparisonSummary.profit,
          totalCashIn: undefined,
          totalCashOut: undefined,
          netCash: undefined,
        }
      : null;
    return buildReportingReconciliation({
      operational: operationalSnapshot,
      ledger: ledgerSnapshot,
    });
  }, [ledgerComparisonSummary, operationalComparisonSummary]);
  const hasDiscountMetrics = typeof totalDiscountsRaw === "number";
  const hasRefundMetrics = typeof totalRefundsRaw === "number" && typeof netRevenueRaw === "number";
  const hasTaxMetric = typeof totalTaxCollectedRaw === "number";
  const expenseBreakdown = summary?.expenseBreakdown || [];
  const discountedOrders = Number(summary?.discountedOrders || 0);
  const netSalesAfterDiscounts = summary && hasDiscountMetrics ? Math.max(0, summary.totalRevenue - totalDiscounts) : null;
  const effectiveNetRevenue = summary ? (hasRefundMetrics ? netRevenue : summary.totalRevenue) : 0;
  const grossProfit = summary ? effectiveNetRevenue - summary.totalCOGS : null;
  const grossMargin = summary && effectiveNetRevenue > 0
    ? (grossProfit! / effectiveNetRevenue) * 100
    : null;
  const operatingMargin = summary && effectiveNetRevenue > 0
    ? (summary.profit / effectiveNetRevenue) * 100
    : null;
  const rollingWindow = useMemo(() => {
    if (filteredTrend.length < 2) return null;
    const size = Math.min(sparkWindow, Math.floor(filteredTrend.length / 2));
    if (size < 1 || filteredTrend.length < size * 2) return null;
    const prevSlice = filteredTrend.slice(filteredTrend.length - size * 2, filteredTrend.length - size);
    const currSlice = filteredTrend.slice(filteredTrend.length - size);
    const sum = (items: TrendRow[], pick: (item: TrendRow) => number) =>
      items.reduce((acc, item) => acc + Number(pick(item) || 0), 0);
    const currentRevenue = sum(currSlice, (item) => item.revenue);
    const previousRevenue = sum(prevSlice, (item) => item.revenue);
    const currentRefunds = sum(currSlice, (item) => item.refunds ?? 0);
    const previousRefunds = sum(prevSlice, (item) => item.refunds ?? 0);
    const currentNetRevenue = sum(currSlice, (item) => item.netRevenue ?? (item.revenue - (item.refunds ?? 0)));
    const previousNetRevenue = sum(prevSlice, (item) => item.netRevenue ?? (item.revenue - (item.refunds ?? 0)));
    const currentCogs = sum(currSlice, (item) => item.cogs);
    const previousCogs = sum(prevSlice, (item) => item.cogs);
    const currentExpense = sum(currSlice, (item) => item.expense);
    const previousExpense = sum(prevSlice, (item) => item.expense);
    const currentProfit = sum(currSlice, (item) => item.profit);
    const previousProfit = sum(prevSlice, (item) => item.profit);
    const currentGrossProfit = currentNetRevenue - currentCogs;
    const previousGrossProfit = previousNetRevenue - previousCogs;
    const currentGrossMargin = currentNetRevenue > 0 ? (currentGrossProfit / currentNetRevenue) * 100 : null;
    const previousGrossMargin = previousNetRevenue > 0 ? (previousGrossProfit / previousNetRevenue) * 100 : null;
    const currentOperatingMargin = currentNetRevenue > 0 ? (currentProfit / currentNetRevenue) * 100 : null;
    const previousOperatingMargin = previousNetRevenue > 0 ? (previousProfit / previousNetRevenue) * 100 : null;
    return {
      size,
      currentRevenue,
      previousRevenue,
      currentRefunds,
      previousRefunds,
      currentNetRevenue,
      previousNetRevenue,
      currentCogs,
      previousCogs,
      currentExpense,
      previousExpense,
      currentProfit,
      previousProfit,
      currentGrossProfit,
      previousGrossProfit,
      currentGrossMargin,
      previousGrossMargin,
      currentOperatingMargin,
      previousOperatingMargin,
    };
  }, [filteredTrend, sparkWindow]);
  const trendTotals = useMemo(() => {
    if (filteredTrend.length === 0) return null;
    const totals = filteredTrend.reduce(
      (acc, row) => {
        acc.revenue += Number(row.revenue || 0);
        acc.refunds += Number(row.refunds || 0);
        acc.netRevenue += Number(row.netRevenue || (row.revenue - (row.refunds || 0)));
        acc.cogs += Number(row.cogs || 0);
        acc.expense += Number(row.expense || 0);
        acc.profit += Number(row.profit || 0);
        return acc;
      },
      { revenue: 0, refunds: 0, netRevenue: 0, cogs: 0, expense: 0, profit: 0 },
    );
    const grossProfitTotal = totals.netRevenue - totals.cogs;
    return {
      ...totals,
      grossProfit: grossProfitTotal,
      grossMargin: totals.netRevenue > 0 ? (grossProfitTotal / totals.netRevenue) * 100 : 0,
      operatingMargin: totals.netRevenue > 0 ? (totals.profit / totals.netRevenue) * 100 : 0,
    };
  }, [filteredTrend]);
  const operationalTotals = useMemo(() => {
    if (filteredTrend.length === 0) return null;
    const totals = filteredTrend.reduce(
      (acc, row) => {
        acc.orderCount += Number(row.orderCount || 0);
        acc.revenue += Number(row.revenue || 0);
        acc.deliveredCount += Number(row.deliveredCount || 0);
        acc.partiallyDeliveredCount += Number(row.partiallyDeliveredCount || 0);
        acc.returnedCount += Number(row.returnedCount || 0);
        acc.pendingCount += Number(row.pendingCount || 0);
        return acc;
      },
      {
        orderCount: 0,
        revenue: 0,
        deliveredCount: 0,
        partiallyDeliveredCount: 0,
        returnedCount: 0,
        pendingCount: 0,
      },
    );
    return {
      ...totals,
      averageOrderValue: totals.orderCount > 0 ? totals.revenue / totals.orderCount : 0,
    };
  }, [filteredTrend]);
  const formatDelta = (current: number | null, previous: number | null) => {
    if (current == null || previous == null) return null;
    if (previous === 0) return null;
    const delta = ((current - previous) / Math.abs(previous)) * 100;
    const sign = delta > 0 ? "+" : "";
    return `${sign}${delta.toFixed(1)}%`;
  };
  const windowUnit = groupBy === "day"
    ? "day"
    : groupBy === "week"
      ? "week"
      : groupBy === "month"
        ? "month"
        : "year";
  const deltaLabel = rollingWindow
    ? `vs prior ${rollingWindow.size} ${rollingWindow.size === 1 ? windowUnit : `${windowUnit}s`}`
    : "vs prior window";
  const deltaTitle = rollingWindow
    ? `Compares the last ${rollingWindow.size} ${rollingWindow.size === 1 ? windowUnit : `${windowUnit}s`} to the previous ${rollingWindow.size} ${rollingWindow.size === 1 ? windowUnit : `${windowUnit}s`}.`
    : "Compares the most recent window to the previous window.";

  const sparkSlice = (values: number[]) => values.slice(Math.max(0, values.length - sparkWindow));
  const formatAxisValue = (value: number) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "GHS",
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
    } catch {
      return `GH₵${value.toFixed(1)}`;
    }
  };
  const chartSeries = useMemo(() => ([
    { key: "revenue", label: "Revenue", color: "#0f766e", values: filteredTrend.map((t) => t.revenue) },
    { key: "cogs", label: "COGS", color: "#f59e0b", values: filteredTrend.map((t) => t.cogs) },
    { key: "expense", label: "Expenses", color: "#dc2626", values: filteredTrend.map((t) => t.expense) },
    { key: "profit", label: "Net Profit", color: "#16a34a", values: filteredTrend.map((t) => t.profit) },
  ]), [filteredTrend]);
  const chartPoints = useMemo(() => {
    if (filteredTrend.length < 2) return null;
    const allValues = chartSeries.flatMap((series) => series.values);
    const min = Math.min(...allValues);
    const max = Math.max(...allValues);
    const range = max - min || 1;
    const chartWidth = 640;
    const leftGutter = 44;
    const rightGutter = 56;
    const width = chartWidth + leftGutter + rightGutter;
    const height = 220;
    const padding = 24;
    const chartLeft = leftGutter + padding;
    const chartRight = leftGutter + chartWidth - padding;
    const innerWidth = chartRight - chartLeft;
    const innerHeight = height - padding * 2;
    const yTicks = 4;
    const tickValues = Array.from({ length: yTicks + 1 }, (_, i) => min + (range * (yTicks - i)) / yTicks);
    const gridLines = tickValues.map((value) => {
      const y = padding + innerHeight - ((value - min) / range) * innerHeight;
      return { value, y };
    });
    const xTicks = (() => {
      const count = Math.min(4, filteredTrend.length);
      return Array.from({ length: count }, (_, i) => {
        const index = Math.round((filteredTrend.length - 1) * (i / Math.max(1, count - 1)));
        const x = chartLeft + (index / (filteredTrend.length - 1)) * innerWidth;
        return { index, x, label: formatPeriodLabel(filteredTrend[index]?.date ?? "") };
      });
    })();
    const pointsByKey: Record<string, string> = {};
    chartSeries.forEach((series) => {
      pointsByKey[series.key] = series.values
        .map((value, index) => {
          const x = chartLeft + (index / (series.values.length - 1)) * innerWidth;
          const y = padding + innerHeight - ((value - min) / range) * innerHeight;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
    });
    const chartMid = chartLeft + innerWidth / 2;
    return { width, height, padding, min, max, pointsByKey, gridLines, xTicks, chartLeft, chartRight, chartMid };
  }, [chartSeries, filteredTrend]);

  const downloadChart = () => {
    if (!chartPoints) return;
    const { width, height, pointsByKey } = chartPoints;
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="white"/>
  ${chartPoints.gridLines.map((line) => (
    `<line x1="${chartPoints.chartLeft}" x2="${chartPoints.chartRight}" y1="${line.y}" y2="${line.y}" stroke="#e5e7eb" stroke-width="1" />`
  )).join("")}
  ${chartPoints.xTicks.map((tick) => (
    `<line x1="${tick.x}" x2="${tick.x}" y1="${chartPoints.padding}" y2="${height - chartPoints.padding}" stroke="#f1f5f9" stroke-width="1" />`
  )).join("")}
  ${chartPoints.xTicks.map((tick) => (
    `<text x="${tick.x}" y="${height - 12}" text-anchor="middle" font-size="10" fill="#6b7280">${tick.label}</text>`
  )).join("")}
  ${chartPoints.gridLines.map((line) => (
    `<text x="${chartPoints.chartLeft - 6}" y="${line.y + 4}" text-anchor="end" font-size="10" fill="#6b7280">${formatAxisValue(line.value)}</text>`
  )).join("")}
  <text x="12" y="16" font-size="11" fill="#6b7280">Amount</text>
  <text x="${chartPoints.chartMid}" y="${height - 2}" text-anchor="middle" font-size="11" fill="#6b7280">Period</text>
  ${chartSeries.map((series) => (
    `<polyline fill="none" stroke="${series.color}" stroke-width="3" points="${pointsByKey[series.key] || ""}" />`
  )).join("")}
</svg>`;
    const blob = new Blob([svg.trim()], { type: "image/svg+xml" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `profit-loss-trend-${Date.now()}.svg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  };

  return (
    <section className="container mx-auto py-8 space-y-6">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Profit &amp; Loss</h1>
          <p className="text-sm text-muted-foreground">
            Review revenue, costs, and margins over time.
          </p>
          <p className="text-xs text-muted-foreground">
            Switch between Operational View for trading activity and Posted Ledger View for posted financials.
          </p>
          {activeSource ? (
            <p className="text-xs text-muted-foreground">
              Current source: {activeSourceLabel}
              {isSourceOverridden ? " (page override)." : " (default from Accounting Settings)."}
            </p>
          ) : null}
          {reportingModeError ? (
            <p className="text-xs text-red-600">
              Failed to load the default reporting source. Choose a view below to continue.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/admin/profit-loss/products">View Product Performance</Link>
          </Button>
          {activeSource === "ledger" ? (
            <Button asChild variant="outline" className="w-full sm:w-auto">
              <Link href="/admin/accounting/reports">Open Accounting Reports</Link>
            </Button>
          ) : activeSource === "operational" ? (
            <>
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => exportFile("csv")} disabled={exportingCsv}>
                {exportingCsv ? "Exporting…" : "Export CSV"}
              </Button>
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => exportFile("pdf")} disabled={exportingPdf}>
                {exportingPdf ? "Exporting…" : "Export PDF"}
              </Button>
            </>
          ) : (
            <Button variant="outline" className="w-full sm:w-auto" disabled>Loading source...</Button>
          )}
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="py-3">
          <CardTitle className="text-base font-semibold">Report View</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant={activeSource === "operational" ? "default" : "outline"}
              className="w-full sm:w-auto"
              onClick={() => selectSource("operational")}
            >
              Operational View
            </Button>
            <Button
              type="button"
              variant={activeSource === "ledger" ? "default" : "outline"}
              className="w-full sm:w-auto"
              onClick={() => selectSource("ledger")}
            >
              Posted Ledger View
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full sm:w-auto"
              onClick={() => selectSource("default")}
              disabled={!isSourceOverridden || !defaultSource}
            >
              Use Default
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            {defaultSource
              ? `Default source from Accounting Settings: ${defaultSourceLabel}.`
              : "Default source is unavailable until reporting settings finish loading."}
            {activeSource === "ledger"
              ? " Posted Ledger View uses posted journal entries for financial reporting."
              : activeSource === "operational"
                ? " Operational View uses order, return, and fulfillment activity for commercial context."
                : " Select a source to load the report."}
          </div>
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="py-3">
          <CardTitle className="text-base font-semibold">Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 lg:grid-cols-7 gap-3 items-end">
          <div>
            <label htmlFor="start" className="text-sm">Start</label>
            <Input id="start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label htmlFor="end" className="text-sm">End</label>
            <Input id="end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <div>
            <label htmlFor="group" className="text-sm">Group by</label>
            <Select
              value={groupBy}
              onValueChange={(value) => setGroupBy(value as "day" | "week" | "month" | "year")}
            >
              <SelectTrigger id="group" className="w-full">
                <SelectValue placeholder="Select grouping" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Day</SelectItem>
                <SelectItem value="week">Week</SelectItem>
                <SelectItem value="month">Month</SelectItem>
                <SelectItem value="year">Year</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label htmlFor="customer" className="text-sm">Customer</label>
            <Input
              id="customer"
              placeholder="Name contains..."
              value={customerInput}
              onChange={(e) => setCustomerInput(e.target.value)}
              title="Filters P&L to orders for customers whose name matches this value."
            />
          </div>
          <div>
            <label htmlFor="category" className="text-sm">Expense Category</label>
            <Input
              id="category"
              placeholder="Expense category contains..."
              value={categoryInput}
              onChange={(e) => setCategoryInput(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={excludeZero}
              onChange={(e) => setExcludeZero(e.target.checked)}
            />
            <span title="Hide periods where revenue, COGS, expenses, and profit are all zero (applies to table and KPI trends).">
              Exclude zero periods
            </span>
          </label>
          <div className="text-sm text-muted-foreground">
            {!activeSource && !reportingModeError
              ? "Loading source..."
              : isLoading
                ? "Loading..."
                : `${filteredTrend.length} period(s)`}
          </div>
          <div
            className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-7"
            title={
              useLedger
                ? "Coverage includes posted journal entries for revenue, discounts, refunds, tax, COGS, expenses, and cash movement. The timestamp shows when the data was last refreshed."
                : "Coverage includes non-cancelled orders (accrual revenue/COGS), discounts, expenses by category, refunds from payments, and return adjustments. The timestamp shows when the data was last refreshed."
            }
          >
            Coverage: {useLedger
              ? "Posted journal entries for revenue, discounts, refunds, tax, COGS, expenses, and cash movement."
              : "Non-cancelled orders (accrual revenue/COGS), discounts, expenses by category, refunds from payments, and return adjustments."}
            {updatedAtText ? ` · Last refreshed ${updatedAtText}` : ""}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Financial KPIs</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <Stat
            label="Revenue"
            value={summary ? formatCurrency(summary.totalRevenue) : "-"}
            trend={sparkSlice(filteredTrend.map((t) => t.revenue))}
            tooltip="Total revenue from non-cancelled orders (accrual basis)."
            delta={formatDelta(rollingWindow?.currentRevenue ?? null, rollingWindow?.previousRevenue ?? null)}
            deltaLabel={deltaLabel}
            deltaTitle={deltaTitle}
          />
          <Stat
            label="Discounts"
            value={summary && hasDiscountMetrics ? formatCurrency(totalDiscounts) : "-"}
            accent={summary ? "text-amber-700" : ""}
            tooltip={
              hasDiscountMetrics
                ? "Contra-revenue discounts applied in the selected period."
                : "Discount detail is not available from the ledger summary route."
            }
            subtext={
              hasDiscountMetrics
                ? `${discountedOrders} discounted order${discountedOrders === 1 ? "" : "s"}`
                : useLedger
                  ? "Unavailable in Posted Ledger View"
                  : undefined
            }
          />
          <Stat
            label="Net Sales (after discounts, before refunds)"
            value={netSalesAfterDiscounts != null ? formatCurrency(netSalesAfterDiscounts) : "-"}
            tooltip={
              hasDiscountMetrics
                ? "Revenue minus discounts (before refunds)."
                : "Discount detail is not available from the ledger summary route."
            }
            subtext={hasDiscountMetrics ? undefined : useLedger ? "Unavailable in Posted Ledger View" : undefined}
          />
          <Stat
            label="Refunds"
            value={summary && hasRefundMetrics ? formatCurrency(totalRefunds) : "-"}
            accent={summary ? "text-red-600" : ""}
            positiveIsGood={false}
            trend={hasRefundMetrics ? sparkSlice(filteredTrend.map((t) => t.refunds ?? 0)) : undefined}
            tooltip={
              hasRefundMetrics
                ? "Refunds and return value adjustments recognized in the selected period."
                : "Refund detail is not available from the ledger summary route."
            }
            delta={hasRefundMetrics ? formatDelta(rollingWindow?.currentRefunds ?? null, rollingWindow?.previousRefunds ?? null) : null}
            deltaLabel={hasRefundMetrics ? deltaLabel : undefined}
            deltaTitle={hasRefundMetrics ? deltaTitle : undefined}
            subtext={hasRefundMetrics ? undefined : useLedger ? "Unavailable in Posted Ledger View" : undefined}
          />
          <Stat
            label="Net Revenue"
            value={summary && hasRefundMetrics ? formatCurrency(netRevenue) : summary ? formatCurrency(summary.totalRevenue) : "-"}
            trend={sparkSlice(filteredTrend.map((t) => t.netRevenue ?? (t.revenue - (t.refunds ?? 0))))}
            tooltip={
              hasRefundMetrics
                ? "Net Revenue = Revenue - Refunds."
                : "Ledger mode uses journal-derived revenue and does not provide a separate refunds deduction tile."
            }
            delta={formatDelta(rollingWindow?.currentNetRevenue ?? null, rollingWindow?.previousNetRevenue ?? null)}
            deltaLabel={deltaLabel}
            deltaTitle={deltaTitle}
            subtext={hasRefundMetrics ? undefined : useLedger ? "Posted ledger revenue basis" : undefined}
          />
          <Stat
            label="Gross Profit"
            value={grossProfit != null ? formatCurrency(grossProfit) : "-"}
            accent={grossProfit != null ? (grossProfit >= 0 ? "text-green-600" : "text-red-600") : ""}
            trend={sparkSlice(filteredTrend.map((t) => (t.netRevenue ?? (t.revenue - (t.refunds ?? 0))) - t.cogs))}
            tooltip="Gross Profit = Net Revenue - COGS."
            delta={formatDelta(rollingWindow?.currentGrossProfit ?? null, rollingWindow?.previousGrossProfit ?? null)}
            deltaLabel={deltaLabel}
            deltaTitle={deltaTitle}
          />
          <Stat
            label="COGS"
            value={summary ? formatCurrency(summary.totalCOGS) : "-"}
            accent="text-amber-600"
            positiveIsGood={false}
            trend={sparkSlice(filteredTrend.map((t) => t.cogs))}
            tooltip="Cost of Goods Sold (inventory cost tied to sold items)."
            delta={formatDelta(rollingWindow?.currentCogs ?? null, rollingWindow?.previousCogs ?? null)}
            deltaLabel={deltaLabel}
            deltaTitle={deltaTitle}
          />
          <Stat
            label="Expenses"
            value={summary ? formatCurrency(summary.totalExpense) : "-"}
            accent="text-red-600"
            positiveIsGood={false}
            trend={sparkSlice(filteredTrend.map((t) => t.expense))}
            tooltip="Operating expenses in the selected period."
            delta={formatDelta(rollingWindow?.currentExpense ?? null, rollingWindow?.previousExpense ?? null)}
            deltaLabel={deltaLabel}
            deltaTitle={deltaTitle}
          />
          <Stat
            label="Net Profit"
            value={summary ? formatCurrency(summary.profit) : "-"}
            accent={
              summary ? (summary.profit >= 0 ? "text-green-600" : "text-red-600") : ""
            }
            trend={sparkSlice(filteredTrend.map((t) => t.profit))}
            tooltip="Net Profit = Revenue - Refunds - COGS - Expenses."
            delta={formatDelta(rollingWindow?.currentProfit ?? null, rollingWindow?.previousProfit ?? null)}
            deltaLabel={deltaLabel}
            deltaTitle={deltaTitle}
          />
          <Stat
            label="Tax Collected"
            value={summary && hasTaxMetric ? formatCurrency(totalTaxCollected) : "-"}
            accent={summary ? "text-sky-700" : ""}
            tooltip={
              hasTaxMetric
                ? "Sales tax recognized on orders in the selected period."
                : "Tax detail is not available from the ledger summary route."
            }
            subtext={hasTaxMetric ? undefined : useLedger ? "Unavailable in Posted Ledger View" : undefined}
          />
          <Stat
            label="Gross Margin"
            value={grossMargin != null ? `${grossMargin.toFixed(2)}%` : "-"}
            accent={
              grossMargin != null ? (grossMargin >= 0 ? "text-green-600" : "text-red-600") : ""
            }
            trend={sparkSlice(filteredTrend.map((t) => {
              const rowNetRevenue = t.netRevenue ?? (t.revenue - (t.refunds ?? 0));
              return rowNetRevenue > 0 ? ((rowNetRevenue - t.cogs) / rowNetRevenue) * 100 : 0;
            }))}
            tooltip="Gross Margin = (Net Revenue - COGS) / Net Revenue."
            delta={formatDelta(rollingWindow?.currentGrossMargin ?? null, rollingWindow?.previousGrossMargin ?? null)}
            deltaLabel={deltaLabel}
            deltaTitle={deltaTitle}
          />
          <Stat
            label="Operating Margin"
            value={operatingMargin != null ? `${operatingMargin.toFixed(2)}%` : "-"}
            accent={
              operatingMargin != null ? (operatingMargin >= 0 ? "text-green-600" : "text-red-600") : ""
            }
            trend={sparkSlice(filteredTrend.map((t) => {
              const rowNetRevenue = t.netRevenue ?? (t.revenue - (t.refunds ?? 0));
              return rowNetRevenue > 0 ? (t.profit / rowNetRevenue) * 100 : 0;
            }))}
            tooltip="Operating Margin = Net Profit / Net Revenue."
            delta={formatDelta(rollingWindow?.currentOperatingMargin ?? null, rollingWindow?.previousOperatingMargin ?? null)}
            deltaLabel={deltaLabel}
            deltaTitle={deltaTitle}
          />
        </CardContent>
        {useLedger && (!hasDiscountMetrics || !hasRefundMetrics || !hasTaxMetric) ? (
          <CardContent className="pt-0 text-xs text-muted-foreground">
            Posted Ledger View omits some operational-only metrics such as discounts, refunds, and tax breakout.
          </CardContent>
        ) : null}
        <CardContent className="pt-0 text-xs text-muted-foreground">
          {useLedger
            ? "These KPIs are sourced from posted journal entries."
            : "These KPIs are sourced from operational order, return, payment, and expense activity."}
        </CardContent>
        <CardContent className="pt-0">
          <div
            className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
            title="Sparklines in the KPI cards use this window size to show recent performance."
          >
            <span>Trend window</span>
            <button
              type="button"
              className={`px-2 py-1 rounded border ${sparkWindow === 30 ? "bg-muted" : ""}`}
              onClick={() => setSparkWindow(30)}
            >
              Last 30 periods
            </button>
            <button
              type="button"
              className={`px-2 py-1 rounded border ${sparkWindow === 90 ? "bg-muted" : ""}`}
              onClick={() => setSparkWindow(90)}
            >
              Last 90 periods
            </button>
          </div>
        </CardContent>
      </Card>

      <ReportingReconciliationPanel
        report={reconciliationReport}
        loading={Boolean(activeSource && isComparisonLoading)}
        title="Ledger Alignment"
        description="Compares operational and posted-ledger financial metrics for the same filters and highlights any drift before Operational View is retired."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Expense Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {expenseBreakdown.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {expenseBreakdown.map((row) => (
                <div key={row.category} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="text-muted-foreground">{row.category}</span>
                  <span className="font-medium">{formatCurrency(row.amount)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No expenses recorded for the current filters.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Operational Context</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Workflow metrics come from order, return, and fulfillment activity rather than posted-ledger financials.
          </p>
          {activeSource === "operational" && operationalTotals ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Orders</div>
                <div className="text-lg font-semibold">{operationalTotals.orderCount}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Avg Order Value</div>
                <div className="text-lg font-semibold">{formatCurrency(operationalTotals.averageOrderValue)}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Delivered</div>
                <div className="text-lg font-semibold text-green-600">{operationalTotals.deliveredCount}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Partial</div>
                <div className="text-lg font-semibold text-amber-600">{operationalTotals.partiallyDeliveredCount}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Returned</div>
                <div className="text-lg font-semibold text-red-600">{operationalTotals.returnedCount}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Pending</div>
                <div className="text-lg font-semibold">{operationalTotals.pendingCount}</div>
              </div>
            </div>
          ) : activeSource === "ledger" ? (
            <div className="rounded-md border p-4 text-sm text-muted-foreground">
              Posted Ledger View focuses on financial reporting. Switch to Operational View or use the dashboard for order and fulfillment workflow metrics.
            </div>
          ) : (
            <div className="rounded-md border p-4 text-sm text-muted-foreground">
              Load a report source to view operational context.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-semibold">Trend Overview</CardTitle>
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            onClick={downloadChart}
            disabled={!chartPoints}
          >
            Download chart
          </Button>
        </CardHeader>
        <CardContent>
          {chartPoints ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                {chartSeries.map((series) => (
                  <div key={series.key} className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: series.color }} />
                    <span>{series.label}</span>
                  </div>
                ))}
              </div>
              <div className="w-full overflow-x-auto">
                <svg
                  viewBox={`0 0 ${chartPoints.width} ${chartPoints.height}`}
                  className="h-64 w-full min-w-[520px]"
                >
                  {chartPoints.gridLines.map((line) => (
                    <g key={`grid-${line.value}`}>
                      <line
                        x1={chartPoints.chartLeft}
                        x2={chartPoints.chartRight}
                        y1={line.y}
                        y2={line.y}
                        stroke="#e5e7eb"
                        strokeWidth="1"
                      />
                      <text
                        x={chartPoints.chartLeft - 6}
                        y={line.y + 4}
                        textAnchor="end"
                        fontSize="10"
                        fill="#6b7280"
                      >
                        {formatAxisValue(line.value)}
                      </text>
                    </g>
                  ))}
                  {chartPoints.xTicks.map((tick) => (
                    <line
                      key={`grid-x-${tick.index}`}
                      x1={tick.x}
                      x2={tick.x}
                      y1={chartPoints.padding}
                      y2={chartPoints.height - chartPoints.padding}
                      stroke="#f1f5f9"
                      strokeWidth="1"
                    />
                  ))}
                  {chartSeries.map((series) => (
                    <polyline
                      key={series.key}
                      fill="none"
                      stroke={series.color}
                      strokeWidth="3"
                      points={chartPoints.pointsByKey[series.key]}
                    />
                  ))}
                  {chartPoints.xTicks.map((tick) => (
                    <text
                      key={`xtick-${tick.index}`}
                      x={tick.x}
                      y={chartPoints.height - 12}
                      textAnchor="middle"
                      fontSize="10"
                      fill="#6b7280"
                    >
                      {tick.label}
                    </text>
                  ))}
                  <text
                    x={12}
                    y={16}
                    fontSize="11"
                    fill="#6b7280"
                  >
                    Amount
                  </text>
                  <text
                    x={chartPoints.chartMid}
                    y={chartPoints.height - 2}
                    textAnchor="middle"
                    fontSize="11"
                    fill="#6b7280"
                  >
                    Period
                  </text>
                </svg>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              Not enough data to render a trend chart yet.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Details</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="lg:hidden px-4 pb-4 pt-2 space-y-3">
            {paginatedTrend.map((t) => {
              const rowNetRevenue = Number(t.netRevenue ?? (t.revenue - (t.refunds ?? 0)));
              const grossProfit = rowNetRevenue - Number(t.cogs || 0);
              const grossMargin = rowNetRevenue > 0 ? (grossProfit / rowNetRevenue) * 100 : 0;
              return (
                <div key={t.date} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Period</span>
                    <span className="font-medium">{formatPeriodLabel(t.date)}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <div>
                      <div>Revenue</div>
                      <div className="text-foreground">{formatCurrency(t.revenue)}</div>
                    </div>
                    <div>
                      <div>Refunds</div>
                      <div className="text-foreground">{formatCurrency(t.refunds ?? 0)}</div>
                    </div>
                    <div>
                      <div>Net Revenue</div>
                      <div className="text-foreground">{formatCurrency(rowNetRevenue)}</div>
                    </div>
                    <div>
                      <div>COGS</div>
                      <div className="text-foreground">{formatCurrency(t.cogs ?? 0)}</div>
                    </div>
                    <div>
                      <div>Gross Profit</div>
                      <div className="text-foreground">{formatCurrency(grossProfit)}</div>
                    </div>
                    <div>
                      <div>Gross Margin</div>
                      <div className="text-foreground">{grossMargin.toFixed(2)}%</div>
                    </div>
                    <div>
                      <div>Expenses</div>
                      <div className="text-foreground">{formatCurrency(t.expense)}</div>
                    </div>
                    <div>
                      <div>Net Profit</div>
                      <div className={`${t.profit >= 0 ? "text-green-600" : "text-red-600"} font-medium`}>
                        {formatCurrency(t.profit)}
                      </div>
                    </div>
                    <div>
                      <div>Operating Margin</div>
                      <div className="text-foreground">{t.margin.toFixed(2)}%</div>
                    </div>
                  </div>
                </div>
              );
            })}
            {trendTotals ? (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                <div className="font-medium" title="Sum of all filtered periods, not just the current page.">
                  Total ({filteredTrend.length} periods)
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <div>
                    <div>Revenue</div>
                    <div className="text-foreground">{formatCurrency(trendTotals.revenue)}</div>
                  </div>
                  <div>
                    <div>Refunds</div>
                    <div className="text-foreground">{formatCurrency(trendTotals.refunds)}</div>
                  </div>
                  <div>
                    <div>Net Revenue</div>
                    <div className="text-foreground">{formatCurrency(trendTotals.netRevenue)}</div>
                  </div>
                  <div>
                    <div>COGS</div>
                    <div className="text-foreground">{formatCurrency(trendTotals.cogs)}</div>
                  </div>
                  <div>
                    <div>Gross Profit</div>
                    <div className="text-foreground">{formatCurrency(trendTotals.grossProfit)}</div>
                  </div>
                  <div>
                    <div>Expenses</div>
                    <div className="text-foreground">{formatCurrency(trendTotals.expense)}</div>
                  </div>
                  <div>
                    <div>Net Profit</div>
                    <div className={`${trendTotals.profit >= 0 ? "text-green-600" : "text-red-600"} font-medium`}>
                      {formatCurrency(trendTotals.profit)}
                    </div>
                  </div>
                  <div>
                    <div>Operating Margin</div>
                    <div className="text-foreground">{trendTotals.operatingMargin.toFixed(2)}%</div>
                  </div>
                </div>
              </div>
            ) : null}
            {Boolean(error) && (
              <div className="rounded-md border p-4 text-center text-sm text-red-600">
                Failed to load P&amp;L
              </div>
            )}
            {!error && isLoading && (
              <div className="rounded-md border p-4 text-center text-sm text-muted-foreground">
                Loading...
              </div>
            )}
            {!error && !isLoading && filteredTrend.length === 0 && (
              <div className="rounded-md border p-4 text-center text-sm text-muted-foreground">
                <p>No data for the current filters.</p>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  <Link
                    href="/admin/profit-loss"
                    className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                  >
                    Reset filters
                  </Link>
                  <Link
                    href="/admin/orders"
                    className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                  >
                    View orders
                  </Link>
                </div>
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <Table className="hidden lg:table">
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Refunds</TableHead>
                  <TableHead className="text-right">Net Revenue</TableHead>
                  <TableHead className="text-right">COGS</TableHead>
                  <TableHead className="text-right">Gross Profit</TableHead>
                  <TableHead className="text-right">Gross Margin</TableHead>
                  <TableHead className="text-right">Expenses</TableHead>
                  <TableHead className="text-right">Net Profit</TableHead>
                  <TableHead className="text-right">Operating Margin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Boolean(error) && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-6 text-red-600">Failed to load P&L</TableCell>
                  </TableRow>
                )}
                {!error && isLoading && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-6 text-muted-foreground">Loading...</TableCell>
                  </TableRow>
                )}
                {!error && !isLoading && filteredTrend.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-6">
                      <div className="text-sm text-muted-foreground">
                        <p>No data for the current filters.</p>
                        <div className="mt-2 flex flex-wrap justify-center gap-2">
                          <Link
                            href="/admin/profit-loss"
                            className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            Reset filters
                          </Link>
                          <Link
                            href="/admin/orders"
                            className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            View orders
                          </Link>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {paginatedTrend.map((t) => {
                  const rowNetRevenue = Number(t.netRevenue ?? (t.revenue - (t.refunds ?? 0)));
                  const grossProfit = rowNetRevenue - Number(t.cogs || 0);
                  const grossMargin = rowNetRevenue > 0 ? (grossProfit / rowNetRevenue) * 100 : 0;
                  return (
                    <TableRow
                      key={t.date}
                      className="odd:bg-background even:bg-muted/40 hover:bg-accent/60"
                    >
                      <TableCell>{formatPeriodLabel(t.date)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(t.revenue)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(t.refunds ?? 0)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(rowNetRevenue)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(t.cogs ?? 0)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(grossProfit)}</TableCell>
                      <TableCell className="text-right">{grossMargin.toFixed(2)}%</TableCell>
                      <TableCell className="text-right">{formatCurrency(t.expense)}</TableCell>
                      <TableCell className={`text-right ${t.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(t.profit)}</TableCell>
                      <TableCell className="text-right">{t.margin.toFixed(2)}%</TableCell>
                    </TableRow>
                  );
                })}
                {trendTotals ? (
                  <TableRow className="bg-muted/60 font-medium">
                    <TableCell title="Sum of all filtered periods, not just the current page.">
                      Total ({filteredTrend.length} periods)
                    </TableCell>
                    <TableCell className="text-right">{formatCurrency(trendTotals.revenue)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(trendTotals.refunds)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(trendTotals.netRevenue)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(trendTotals.cogs)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(trendTotals.grossProfit)}</TableCell>
                    <TableCell className="text-right">{trendTotals.grossMargin.toFixed(2)}%</TableCell>
                    <TableCell className="text-right">{formatCurrency(trendTotals.expense)}</TableCell>
                    <TableCell className={`text-right ${trendTotals.profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {formatCurrency(trendTotals.profit)}
                    </TableCell>
                    <TableCell className="text-right">{trendTotals.operatingMargin.toFixed(2)}%</TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
          {filteredTrend.length > 0 && (
            <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Rows per page</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(value) => {
                    setPageSize(parseInt(value, 10));
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="h-8 w-[110px]" size="sm">
                    <SelectValue placeholder="Rows" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10</SelectItem>
                    <SelectItem value="25">25</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        if (page > 1) setPage(page - 1);
                      }}
                    />
                  </PaginationItem>
                  {Array.from({ length: totalPages }, (_, idx) => idx + 1)
                    .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
                    .map((p, idx, arr) => {
                      const prev = arr[idx - 1];
                      const showEllipsis = prev && p - prev > 1;
                      return (
                        <span key={`pl-page-${p}`} className="contents">
                          {showEllipsis ? (
                            <PaginationItem>
                              <span className="px-2">…</span>
                            </PaginationItem>
                          ) : null}
                          <PaginationItem>
                            <PaginationLink
                              href="#"
                              isActive={page === p}
                              onClick={(e) => {
                                e.preventDefault();
                                setPage(p);
                              }}
                            >
                              {p}
                            </PaginationLink>
                          </PaginationItem>
                        </span>
                      );
                    })}
                  <PaginationItem>
                    <PaginationNext
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        if (page < totalPages) setPage(page + 1);
                      }}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export default function ProfitLossPage() {
  return (
    <Suspense
      fallback={
        <section className="container mx-auto py-8 space-y-4">
          <h1 className="text-2xl font-semibold">Profit &amp; Loss</h1>
          <p className="text-sm text-muted-foreground">Loading P&amp;L…</p>
        </section>
      }
    >
      <ProfitLossContent />
    </Suspense>
  );
}

function Stat({
  label,
  value,
  accent,
  trend,
  tooltip,
  subtext,
  delta,
  deltaLabel,
  deltaTitle,
  // When true, higher is better (default). When false, lower is better (e.g. COGS, Expenses, Refunds).
  positiveIsGood = true,
}: {
  label: string;
  value: string;
  accent?: string;
  trend?: number[];
  tooltip?: string;
  subtext?: string;
  delta?: string | null;
  deltaLabel?: string;
  deltaTitle?: string;
  positiveIsGood?: boolean;
}) {
  const points = useMemo(() => {
    if (!trend || trend.length < 2) return "";
    const min = Math.min(...trend);
    const max = Math.max(...trend);
    const range = max - min || 1;
    const width = 120;
    const height = 24;
    return trend
      .map((v, i) => {
        const x = (i / (trend.length - 1)) * width;
        const y = height - ((v - min) / range) * height;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }, [trend]);

  // Colour the sparkline based on the latest value's sign vs the metric direction.
  const sparkColor = useMemo(() => {
    if (!trend || trend.length === 0) return "currentColor";
    const last = trend[trend.length - 1];
    if (last === 0) return "#6b7280"; // neutral grey
    const isPositive = last > 0;
    const isGood = positiveIsGood ? isPositive : !isPositive;
    return isGood ? "#16a34a" : "#dc2626";
  }, [trend, positiveIsGood]);

  return (
    <div className="p-3 rounded-md bg-background shadow-sm" title={tooltip}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${accent ?? ""}`}>{value}</div>
      {subtext ? <div className="text-[11px] text-muted-foreground">{subtext}</div> : null}
      {delta ? (
        <div
          className={`text-xs ${(positiveIsGood ? !delta.startsWith("-") : delta.startsWith("-")) ? "text-green-600" : "text-red-600"}`}
          title={deltaTitle}
        >
          {delta} {deltaLabel ?? "vs prior window"}
        </div>
      ) : deltaLabel ? (
        <div className="text-xs text-muted-foreground" title={deltaTitle}>
          {deltaLabel}
        </div>
      ) : null}
      {points ? (
        <svg viewBox="0 0 120 24" className="mt-2 h-6 w-full">
          <polyline
            fill="none"
            stroke={sparkColor}
            strokeWidth="2"
            points={points}
          />
        </svg>
      ) : (
        <div className="mt-2 h-6" />
      )}
    </div>
  );
}
