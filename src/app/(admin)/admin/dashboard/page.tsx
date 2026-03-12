"use client";

export const dynamic = "force-dynamic";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateRange } from "react-day-picker";
import { format, startOfDay, endOfDay, subDays, subMonths, startOfMonth, endOfMonth, startOfYear, endOfYear } from "date-fns";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Download, Filter, Table, RefreshCcw, HelpCircle } from "lucide-react";
import AddExpenseDialog from "@/app/(admin)/dashboard/components/AddExpenseDialog";
import ProfitSummary from "@/app/(admin)/dashboard/components/ProfitSummary";
import InventoryAlerts from "@/app/(admin)/dashboard/components/InventoryAlerts";
import MarginRisk from "@/app/(admin)/dashboard/components/MarginRisk";
import MonitoringSummary from "@/app/(admin)/dashboard/components/MonitoringSummary";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import { Tooltip } from "@/components/ui/tooltip";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  ComposedChart,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import { useQuery } from "@tanstack/react-query";

type DashboardSummary = {
  totalRevenue: number;
  totalRefunds: number;
  netRevenue: number;
  totalCOGS: number;
  totalExpense: number;
  profit: number;
  margin: number;
  orderCount: number;
  averageOrderValue: number;
  totalCashIn: number;
  totalCashOut: number;
  netCash: number;
  totalOutstanding: number;
  totalBilled: number;
  totalTaxCollected: number;
  totalDiscounts: number;
  discountedOrders: number;
  totalCollectedOnPeriodSales: number;
  totalOutstandingOnPeriodSales: number;
  reconciliationDelta: number;
  deliveredCount: number;
  partiallyDeliveredCount: number;
  returnedCount: number;
  pendingCount: number;
  expenseBreakdown: { category: string; amount: number }[];
};

type TrendRow = {
  date: string;
  period: string;
  revenue: number;
  refunds?: number;
  netRevenue?: number;
  expense: number;
  payrollExpense?: number;
  profit: number;
  margin: number;
  cogs?: number;
  cashIn?: number;
  cashOut?: number;
  netCash?: number;
  outstanding?: number;
  orderCount?: number;
  averageOrderValue?: number;
  deliveredCount?: number;
  partiallyDeliveredCount?: number;
  returnedCount?: number;
  pendingCount?: number;
  rollingRevenue?: number;
};

type TrendApiRow = Omit<TrendRow, "period"> & { period?: string };

type SummaryResponse = {
  summary?: Partial<DashboardSummary>;
  trend?: TrendApiRow[];
};

type LedgerSummaryResponse = {
  summary?: {
    totalRevenue?: number;
    totalCOGS?: number;
    totalExpense?: number;
    totalCashIn?: number;
    totalCashOut?: number;
    netCash?: number;
    orderCount?: number;
    averageOrderValue?: number;
    profit?: number;
    margin?: number;
    expenseBreakdown?: { category: string; amount: number }[];
  };
  trend?: TrendApiRow[];
};

type RawReportRow = {
  createdAt: string;
  type: string;
  name?: string | null;
  category?: string | null;
  amount: number;
};

type TopProduct = {
  id: string;
  name: string;
  totalSold: number;
  revenue: number;
};

type TopCustomer = {
  userId: string;
  name: string | null;
  email: string | null;
  ordersTotal: number;
  creditAvailable: number;
};

type HealthSummary = {
  paymentMismatches: number;
  orderBalanceMismatches: number;
  stockMismatches: number;
  legacyAutoApply: number;
};

type AccountingPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
};

type VatFilingRun = {
  id: string;
  startDate: string;
  endDate: string;
  createdAt: string;
};

type IntegritySummary = {
  draftEntries: number;
  arDifference: number;
  inventoryDifference: number;
  negativeStockCount: number;
};

const axisNumberFormatter = new Intl.NumberFormat("en-GH", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function AdminDashboardContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);
  const [filters, setFilters] = useState({
    start: "",
    end: "",
    customer: "",
    category: "",
  });
  const [range, setRange] = useState<DateRange | undefined>();
  const [loading, setLoading] = useState(false);
  const [chartData, setChartData] = useState<TrendRow[]>([]);
  const [operationalTrend, setOperationalTrend] = useState<TrendRow[]>([]);
  const [ledgerTrend, setLedgerTrend] = useState<TrendRow[]>([]);
  const [operationalSummary, setOperationalSummary] = useState<DashboardSummary | null>(null);
  const [ledgerSummary, setLedgerSummary] = useState<{
    totalRevenue: number;
    totalCOGS: number;
    totalExpense: number;
    totalCashIn: number;
    totalCashOut: number;
    netCash: number;
    orderCount: number;
    averageOrderValue: number;
    profit: number;
    margin: number;
    expenseBreakdown: { category: string; amount: number }[];
  } | null>(null);
  const [summary, setSummary] = useState<DashboardSummary>({
    totalRevenue: 0,
    totalRefunds: 0,
    netRevenue: 0,
    totalCOGS: 0,
    totalExpense: 0,
    profit: 0,
    margin: 0,
    orderCount: 0,
    averageOrderValue: 0,
    totalCashIn: 0,
    totalCashOut: 0,
    netCash: 0,
    totalOutstanding: 0,
    totalBilled: 0,
    totalTaxCollected: 0,
    totalDiscounts: 0,
    discountedOrders: 0,
    totalCollectedOnPeriodSales: 0,
    totalOutstandingOnPeriodSales: 0,
    reconciliationDelta: 0,
    deliveredCount: 0,
    partiallyDeliveredCount: 0,
    returnedCount: 0,
    pendingCount: 0,
    expenseBreakdown: [],
  });
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month" | "year">("day");
  const [showMoreMetrics, setShowMoreMetrics] = useState(false);
  const [showComparison, setShowComparison] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [rawData, setRawData] = useState<RawReportRow[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const payrollExpense = useMemo(() => {
    const breakdown = summary.expenseBreakdown || [];
    const payrollItems = breakdown.filter((item) => /payroll/i.test(item.category || ""));
    return payrollItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  }, [summary.expenseBreakdown]);
  const expenseChips = useMemo(() => {
    const breakdown = summary.expenseBreakdown || [];
    const total = Number(summary.totalExpense || 0);
    const payrollTotal = breakdown
      .filter((item) => /payroll/i.test(item.category || ""))
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const others = breakdown.filter((item) => !/payroll/i.test(item.category || ""));
    return [
      { category: "Payroll", amount: payrollTotal, percent: total > 0 ? (payrollTotal / total) * 100 : 0 },
      ...others.map((item) => ({
        ...item,
        percent: total > 0 ? (Number(item.amount || 0) / total) * 100 : 0,
      })),
    ].slice(0, 6);
  }, [summary.expenseBreakdown, summary.totalExpense]);
  const payrollMoM = useMemo(() => {
    if (groupBy !== "month") return null;
    const series = chartData
      .filter((row) => typeof row.payrollExpense === "number")
      .slice()
      .sort((a, b) => a.period.localeCompare(b.period));
    if (series.length < 2) return null;
    const current = Number(series[series.length - 1]?.payrollExpense || 0);
    const previous = Number(series[series.length - 2]?.payrollExpense || 0);
    const delta = current - previous;
    const percent = previous > 0 ? (delta / previous) * 100 : null;
    return { current, previous, delta, percent };
  }, [chartData, groupBy]);
  const previousBucketDelta = useMemo(() => {
    const rows = chartData
      .slice()
      .sort((a, b) => String(a.period || "").localeCompare(String(b.period || "")));
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
      cashIn: buildDelta(Number(current.cashIn || 0), Number(previous.cashIn || 0)),
      outstanding: buildDelta(Number(current.outstanding || 0), Number(previous.outstanding || 0)),
    };
  }, [chartData]);

  const formatDeltaLabel = (value: { delta: number; percent: number | null }) => {
    const sign = value.delta >= 0 ? "+" : "-";
    const absDelta = formatCurrency(Math.abs(value.delta));
    if (value.percent === null) return `${sign}${absDelta} vs previous ${groupBy}`;
    return `${sign}${absDelta} (${sign}${Math.abs(value.percent).toFixed(1)}%) vs previous ${groupBy}`;
  };
  const outstandingRatio = useMemo(() => {
    const billed = Number(summary.totalBilled || 0);
    if (billed <= 0) return 0;
    return Number(summary.totalOutstandingOnPeriodSales || 0) / billed;
  }, [summary.totalBilled, summary.totalOutstandingOnPeriodSales]);
  const anomalyChips = useMemo(
    () => [
      {
        key: "high-outstanding",
        show: outstandingRatio > 0.25,
        label: `High outstanding ratio (${(outstandingRatio * 100).toFixed(1)}%)`,
        tone: "text-amber-700",
      },
      {
        key: "negative-net-cash",
        show: Number(summary.netCash || 0) < 0,
        label: "Negative net cash in selected period",
        tone: "text-red-700",
      },
      {
        key: "recon-delta",
        show: Math.abs(Number(summary.reconciliationDelta || 0)) > 0.01,
        label: `Reconciliation delta not zero (${formatCurrency(summary.reconciliationDelta || 0)})`,
        tone: "text-red-700",
      },
    ].filter((chip) => chip.show),
    [outstandingRatio, summary.netCash, summary.reconciliationDelta],
  );
  const activePeriodLabel = useMemo(() => {
    const start = filters.start?.trim();
    const end = filters.end?.trim();
    if (start && end) return `${start} to ${end}`;
    if (start) return `From ${start}`;
    if (end) return `Up to ${end}`;
    return "All time";
  }, [filters.start, filters.end]);
  const appendActivePeriod = useCallback(
    (path: string) => {
      const params = new URLSearchParams();
      if (filters.start) params.set("start", filters.start);
      if (filters.end) params.set("end", filters.end);
      if (!params.toString()) return path;
      return `${path}${path.includes("?") ? "&" : "?"}${params.toString()}`;
    },
    [filters.start, filters.end],
  );

  const { data: periods } = useQuery<AccountingPeriod[]>({
    queryKey: ["accounting", "periods"],
    queryFn: () => fetch("/api/admin/accounting/periods").then((r) => r.json()),
    staleTime: 60_000,
  });
  const { data: vatRuns } = useQuery<VatFilingRun[]>({
    queryKey: ["accounting", "vat-filings"],
    queryFn: () => fetch("/api/admin/accounting/vat-filings").then((r) => r.json()),
    staleTime: 60_000,
  });
  const { data: integrity } = useQuery<IntegritySummary>({
    queryKey: ["accounting", "integrity"],
    queryFn: () => fetch("/api/admin/accounting/integrity").then((r) => r.json()),
    staleTime: 60_000,
  });
  const { data: reportingMode } = useQuery<{ value: boolean | null }>({
    queryKey: ["accounting", "reporting", "use-ledger"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.reporting.useLedger").then((r) => r.json()),
    staleTime: 60_000,
  });
  const [useLedgerToggle, setUseLedgerToggle] = useState(false);
  const [savingLedgerToggle, setSavingLedgerToggle] = useState(false);
  const useLedger = useLedgerToggle;

  useEffect(() => {
    setUseLedgerToggle(Boolean(reportingMode?.value));
  }, [reportingMode?.value]);

  const primaryTrend = useMemo(
    () => (useLedger ? ledgerTrend : operationalTrend),
    [useLedger, ledgerTrend, operationalTrend],
  );
  const currentOpenPeriod = (periods || []).find((period) => period.status === "OPEN");
  const latestVatRun = (vatRuns || [])[0];

  const { data: topProducts } = useQuery<TopProduct[]>({
    queryKey: ["admin", "top-products"],
    queryFn: async () => {
      const res = await fetch("/api/admin/top-products?mode=quantity");
      if (!res.ok) throw new Error("Failed to load top products");
      return res.json();
    },
    staleTime: 60_000,
  });

  const { data: topCustomers } = useQuery<TopCustomer[]>({
    queryKey: ["admin", "top-customers"],
    queryFn: async () => {
      const res = await fetch("/api/admin/top-customers");
      if (!res.ok) throw new Error("Failed to load top customers");
      return res.json();
    },
    staleTime: 60_000,
  });

  const { data: healthSummary } = useQuery<HealthSummary>({
    queryKey: ["admin", "health-summary"],
    queryFn: async () => {
      const res = await fetch("/api/admin/health/summary");
      if (!res.ok) throw new Error("Failed to load health summary");
      return res.json();
    },
    staleTime: 30_000,
  });
  const healthIssuesCount =
    (healthSummary?.paymentMismatches || 0) +
    (healthSummary?.orderBalanceMismatches || 0) +
    (healthSummary?.stockMismatches || 0) +
    (healthSummary?.legacyAutoApply || 0);

  // Initialize filters from URL
  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams.toString());
    const start = sp.get("start") || "";
    const end = sp.get("end") || "";
    const customer = sp.get("customer") || "";
    const category = sp.get("category") || "";
    const gb = (sp.get("groupBy") as "day" | "week" | "month" | "year" | null) || null;

    setFilters({ start, end, customer, category });
    if (start || end) {
      try {
        setRange({
          from: start ? new Date(start) : undefined,
          to: end ? new Date(end) : undefined,
        });
      } catch {}
    }
    if (gb === "day" || gb === "week" || gb === "month" || gb === "year") setGroupBy(gb);
    initialized.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect filters to URL (avoid using searchParams as a dependency to prevent loops)
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams();
    if (filters.start) params.set("start", filters.start); else params.delete("start");
    if (filters.end) params.set("end", filters.end); else params.delete("end");
    if (filters.customer) params.set("customer", filters.customer); else params.delete("customer");
    if (filters.category) params.set("category", filters.category); else params.delete("category");
    params.set("groupBy", groupBy);
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [filters, groupBy, pathname, router]);

  // Fetch dashboard summary/trend
  const fetchChartData = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.customer) params.append("customer", filters.customer);
      if (filters.category) params.append("category", filters.category);
      params.append("groupBy", groupBy);

      const res = await fetch(`/api/admin/summary?${params.toString()}`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Failed to fetch chart data (${res.status}): ${body || "unknown error"}`);
      }

      const data: SummaryResponse = await res.json();
      const trendRows: TrendApiRow[] = Array.isArray(data.trend) ? data.trend : [];
      const normalizedTrend: TrendRow[] = trendRows.map((row) => ({
        ...row,
        period: row.period || row.date,
        payrollExpense: Number((row as TrendRow).payrollExpense || 0),
      }));
      const withRolling = normalizedTrend.map((row, idx, arr) => {
        const start = Math.max(0, idx - 6);
        const window = arr.slice(start, idx + 1);
        const avg =
          window.reduce((sum, item) => sum + Number(item.revenue || 0), 0) /
          Math.max(1, window.length);
        return { ...row, rollingRevenue: avg };
      });
      const summaryPayload = data.summary || {};
      setOperationalTrend(withRolling);
      const nextOperationalSummary: DashboardSummary = {
        totalRevenue: Number(summaryPayload.totalRevenue || 0),
        totalRefunds: Number(summaryPayload.totalRefunds || 0),
        netRevenue: Number(summaryPayload.netRevenue || 0),
        totalCOGS: Number(summaryPayload.totalCOGS || 0),
        totalExpense: Number(summaryPayload.totalExpense || 0),
        profit: Number(summaryPayload.profit || 0),
        margin: Number(summaryPayload.margin ?? 0),
        orderCount: Number(summaryPayload.orderCount || 0),
        averageOrderValue: Number(summaryPayload.averageOrderValue || 0),
        totalCashIn: Number(summaryPayload.totalCashIn || 0),
        totalCashOut: Number(summaryPayload.totalCashOut || 0),
        netCash: Number(summaryPayload.netCash || 0),
        totalOutstanding: Number(summaryPayload.totalOutstanding || 0),
        totalBilled: Number(summaryPayload.totalBilled || 0),
        totalTaxCollected: Number(summaryPayload.totalTaxCollected || 0),
        totalDiscounts: Number(summaryPayload.totalDiscounts || 0),
        discountedOrders: Number(summaryPayload.discountedOrders || 0),
        totalCollectedOnPeriodSales: Number(summaryPayload.totalCollectedOnPeriodSales || 0),
        totalOutstandingOnPeriodSales: Number(summaryPayload.totalOutstandingOnPeriodSales || 0),
        reconciliationDelta: Number(summaryPayload.reconciliationDelta || 0),
        deliveredCount: Number(summaryPayload.deliveredCount || 0),
        partiallyDeliveredCount: Number(summaryPayload.partiallyDeliveredCount || 0),
        returnedCount: Number(summaryPayload.returnedCount || 0),
        pendingCount: Number(summaryPayload.pendingCount || 0),
        expenseBreakdown: summaryPayload.expenseBreakdown || [],
      };
      setOperationalSummary(nextOperationalSummary);
      setSummary(nextOperationalSummary);

      let nextChartData = withRolling;
      if (useLedger) {
        const ledgerRes = await fetch(
          `/api/admin/accounting/reports/ledger-summary?${params.toString()}`,
        );
        if (ledgerRes.ok) {
          const ledger: LedgerSummaryResponse = await ledgerRes.json();
          const ledgerSummary = ledger.summary || {};
          const nextLedgerSummary = {
            totalRevenue: Number(ledgerSummary.totalRevenue || 0),
            totalCOGS: Number(ledgerSummary.totalCOGS || 0),
            totalExpense: Number(ledgerSummary.totalExpense || 0),
            totalCashIn: Number(ledgerSummary.totalCashIn || 0),
            totalCashOut: Number(ledgerSummary.totalCashOut || 0),
            netCash: Number(ledgerSummary.netCash || 0),
            orderCount: Number(ledgerSummary.orderCount || 0),
            averageOrderValue: Number(ledgerSummary.averageOrderValue || 0),
            profit: Number(ledgerSummary.profit || 0),
            margin: Number(ledgerSummary.margin ?? 0),
            expenseBreakdown: ledgerSummary.expenseBreakdown || [],
          };
          setLedgerSummary(nextLedgerSummary);

          const ledgerTrendRows: TrendApiRow[] = Array.isArray(ledger.trend) ? ledger.trend : [];
          const normalizedLedgerTrend: TrendRow[] = ledgerTrendRows.map((row) => ({
            ...row,
            period: row.period || row.date,
            payrollExpense: Number((row as TrendRow).payrollExpense || 0),
          }));
          const ledgerWithRolling = normalizedLedgerTrend.map((row, idx, arr) => {
            const start = Math.max(0, idx - 6);
            const window = arr.slice(start, idx + 1);
            const avg =
              window.reduce((sum, item) => sum + Number(item.revenue || 0), 0) /
              Math.max(1, window.length);
            return { ...row, rollingRevenue: avg };
          });
          setLedgerTrend(ledgerWithRolling);
          nextChartData = ledgerWithRolling;

          setSummary((prev) => ({
            ...prev,
            totalRevenue: nextLedgerSummary.totalRevenue,
            totalCOGS: nextLedgerSummary.totalCOGS,
            totalExpense: nextLedgerSummary.totalExpense,
            profit: nextLedgerSummary.profit,
            margin: nextLedgerSummary.margin,
            netRevenue:
              nextLedgerSummary.totalRevenue - Number(prev.totalRefunds || 0),
            totalCashIn: nextLedgerSummary.totalCashIn,
            totalCashOut: nextLedgerSummary.totalCashOut,
            netCash: nextLedgerSummary.netCash,
            orderCount: nextLedgerSummary.orderCount,
            averageOrderValue: nextLedgerSummary.averageOrderValue,
            expenseBreakdown:
              nextLedgerSummary.expenseBreakdown.length > 0
                ? nextLedgerSummary.expenseBreakdown
                : prev.expenseBreakdown,
          }));
        }
      }

      if (!useLedger) {
        setLedgerSummary(null);
        setLedgerTrend([]);
      }

      setChartData(nextChartData);
      setLastUpdatedAt(new Date());
    } catch (err) {
      console.error(err);
      toast.error("Error loading dashboard data");
    }
  }, [filters, groupBy, useLedger]);

  useEffect(() => {
    fetchChartData();
  }, [fetchChartData]);

  // CSV export
  const handleDownloadCSV = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.customer) params.append("customer", filters.customer);
      if (filters.category) params.append("category", filters.category);
      params.append("groupBy", groupBy);
      params.append("format", "csv");

      const res = await fetch(`/api/admin/summary?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to generate CSV");

      const blob = await res.blob();
      const link = document.createElement("a");
      const filename = `nora_dashboard_${groupBy}_${Date.now()}.csv`;
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      void logAdminExportDownload({
        area: "dashboard-summary",
        format: "CSV",
        fileName: filename,
        byteSize: blob.size,
        scopeSnapshot: `GroupBy: ${groupBy} | Start: ${filters.start || "-"} | End: ${filters.end || "-"}`,
      });

      toast.success("Report downloaded successfully!");
    } catch (err) {
      console.error(err);
      toast.error("Error generating CSV report");
    } finally {
      setLoading(false);
    }
  };

  // PDF export
  const handleDownloadPDF = async () => {
    try {
      const params = new URLSearchParams();
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      params.append("groupBy", groupBy);
      params.append("format", "pdf");

      const res = await fetch(`/api/admin/summary?${params.toString()}`);
      if (!res.ok) {
        let detail = "";
        try {
          const body = await res.json();
          detail = String(body?.detail || body?.error || "");
        } catch {
          detail = await res.text().catch(() => "");
        }
        throw new Error(detail || `Failed to generate PDF (${res.status})`);
      }

      const blob = await res.blob();
      const link = document.createElement("a");
      const filename = `nora_revenue_${groupBy}_${Date.now()}.pdf`;
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      await logAdminExportDownload({
        area: "dashboard-summary",
        format: "PDF",
        fileName: filename,
        byteSize: blob.size,
        scopeSnapshot: `GroupBy: ${groupBy} | Start: ${filters.start || "-"} | End: ${filters.end || "-"}`,
      });
      toast.success("PDF downloaded successfully!");
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Error generating PDF");
    }
  };

  async function loadRawData() {
    try {
      setRawLoading(true);
      const res = await fetch(`/api/admin/full-report`);
      if (!res.ok) throw new Error("Failed to fetch raw data");
      const data: { rows?: RawReportRow[] } = await res.json();
      setRawData(Array.isArray(data.rows) ? data.rows : []);
    } catch (err) {
      console.error(err);
      toast.error("Error loading raw data");
    } finally {
      setRawLoading(false);
      setIsDialogOpen(true);
    }
  }

  return (
    <section className="container mx-auto py-8 space-y-6 min-w-0">
      <header className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Track revenue, expenses, and cash flow at a glance.
          </p>
          {useLedger ? (
            <p className="text-xs text-muted-foreground">
              Ledger mode enabled: revenue/COGS/expense/profit KPIs use journal entries.
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={useLedgerToggle}
              onChange={async (e) => {
                const next = e.target.checked;
                setUseLedgerToggle(next);
                try {
                  setSavingLedgerToggle(true);
                  const res = await fetch("/api/admin/settings/app", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      key: "accounting.reporting.useLedger",
                      value: next,
                    }),
                  });
                  const j = await res.json().catch(() => ({}));
                  if (!res.ok) {
                    throw new Error(j?.error || "Failed to save reporting mode.");
                  }
                  toast.success("Reporting mode updated.");
                } catch (err) {
                  const message =
                    err instanceof Error ? err.message : "Failed to save reporting mode.";
                  toast.error(message);
                  setUseLedgerToggle(Boolean(reportingMode?.value));
                } finally {
                  setSavingLedgerToggle(false);
                }
              }}
              disabled={savingLedgerToggle}
            />
            Use ledger data
          </label>
          {savingLedgerToggle ? <span>Saving…</span> : null}
        </div>
      </header>
      {healthIssuesCount > 0 ? (
        <Card className="border-l-4 border-amber-500 bg-amber-50/60 dark:bg-amber-950/30">
          <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <p className="font-semibold text-amber-900 dark:text-amber-100">
                Health check issues detected
              </p>
              <p className="text-amber-900/80 dark:text-amber-100/80">
                {healthSummary?.stockMismatches ? `${healthSummary.stockMismatches} stock` : null}
                {healthSummary?.stockMismatches && (healthSummary?.orderBalanceMismatches || healthSummary?.paymentMismatches || healthSummary?.legacyAutoApply) ? " · " : null}
                {healthSummary?.orderBalanceMismatches ? `${healthSummary.orderBalanceMismatches} balances` : null}
                {healthSummary?.orderBalanceMismatches && (healthSummary?.paymentMismatches || healthSummary?.legacyAutoApply) ? " · " : null}
                {healthSummary?.paymentMismatches ? `${healthSummary.paymentMismatches} payments` : null}
                {healthSummary?.paymentMismatches && healthSummary?.legacyAutoApply ? " · " : null}
                {healthSummary?.legacyAutoApply ? `${healthSummary.legacyAutoApply} legacy` : null}
              </p>
            </div>
            <Link
              href="/admin/health"
              className="text-amber-900 dark:text-amber-100 font-semibold underline underline-offset-4"
            >
              Review health check
            </Link>
          </CardContent>
        </Card>
      ) : null}
      {useLedger && operationalSummary && ledgerSummary ? (
        <Card className="border border-muted-foreground/20">
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              Operational vs Ledger (Revenue KPIs)
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            <div className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
              <span>Metric</span>
              <span>Operational</span>
              <span>Ledger</span>
              <span className="text-right">Delta</span>
            </div>
            {[
                {
                  label: "Net Revenue (ex-VAT)",
                  operational: operationalSummary.netRevenue,
                  ledger: ledgerSummary.totalRevenue,
                  type: "currency",
                },
              {
                label: "COGS",
                operational: operationalSummary.totalCOGS,
                ledger: ledgerSummary.totalCOGS,
                type: "currency",
              },
              {
                label: "Expenses",
                operational: operationalSummary.totalExpense,
                ledger: ledgerSummary.totalExpense,
                type: "currency",
              },
              {
                label: "Net Profit",
                operational: operationalSummary.profit,
                ledger: ledgerSummary.profit,
                type: "currency",
              },
              {
                label: "Margin %",
                operational: operationalSummary.margin,
                ledger: ledgerSummary.margin,
                type: "percent",
              },
            ].map((row) => {
              const delta = row.ledger - row.operational;
              const formattedDelta =
                row.type === "percent"
                  ? `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%`
                  : formatCurrency(delta);
              return (
                <div key={row.label} className="grid grid-cols-4 gap-2 items-center border-t py-2">
                  <span className="font-medium text-foreground">{row.label}</span>
                  <span>
                    {row.type === "percent"
                      ? `${row.operational.toFixed(2)}%`
                      : formatCurrency(row.operational)}
                  </span>
                  <span>
                    {row.type === "percent"
                      ? `${row.ledger.toFixed(2)}%`
                      : formatCurrency(row.ledger)}
                  </span>
                  <span className="text-right text-muted-foreground">{formattedDelta}</span>
                </div>
              );
            })}
              <p className="text-xs text-muted-foreground">
                Ledger values use posted journal entries; operational values use orders and expenses.
                Revenue is net of returns and excludes VAT.
              </p>
          </CardContent>
        </Card>
      ) : null}
    <Card className="shadow-md !border-none min-w-0">
      <CardHeader className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div className="w-full">
          <CardTitle className="text-base font-semibold">Sales & Expense Overview</CardTitle>
          <p className="text-sm text-muted-foreground">
            Trends, summaries, and quick export tools
          </p>
        </div>

        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2 w-full lg:w-auto">
          <AddExpenseDialog
            onAdded={() => fetchChartData()}
            buttonClassName="w-full sm:w-auto"
          />
          <Button variant="outline" size="sm" onClick={fetchChartData} className="w-full sm:w-auto">
            <RefreshCcw className="w-4 h-4 mr-1" />
            <span>Refresh</span>
          </Button>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                onClick={() => loadRawData()}
                className="w-full sm:w-auto"
              >
                <Table className="w-4 h-4 mr-2" /> View Raw Data
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-5xl max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="text-base font-semibold">Raw Data Records</DialogTitle>
              </DialogHeader>
          {rawLoading ? (
                <p className="text-center py-8">Loading records...</p>
              ) : rawData.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <p>No records found.</p>
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    <Button size="sm" variant="outline" onClick={loadRawData}>
                      Reload
                    </Button>
                    <Button size="sm" variant="ghost" onClick={fetchChartData}>
                      Refresh summary
                    </Button>
                  </div>
                </div>
              ) : (
                <table className="w-full text-sm border-collapse border border-gray-200 dark:border-gray-800">
                  <thead className="bg-muted text-left">
                    <tr>
                      <th className="p-2 border">Date</th>
                      <th className="p-2 border">Type</th>
                      <th className="p-2 border">Name / Category</th>
                      <th className="p-2 border text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rawData.map((r, idx) => (
                      <tr key={idx} className="odd:bg-white even:bg-muted/40">
                        <td className="p-2 border">
                          {format(new Date(r.createdAt), "yyyy-MM-dd")}
                        </td>
                        <td className="p-2 border font-medium capitalize">
                          {r.type}
                        </td>
                        <td className="p-2 border">
                          {r.name || r.category || "-"}
                        </td>
                        <td
                          className={`p-2 border text-right ${
                            r.type === "expense"
                              ? "text-red-600"
                              : "text-green-600"
                          }`}
                        >
                          ${r.amount.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DialogContent>
          </Dialog>

          <Button
            onClick={handleDownloadCSV}
            disabled={loading}
            size="sm"
            variant="secondary"
            className="w-full sm:w-auto"
          >
            <Download className="w-4 h-4 mr-2" />
            <span className="sm:hidden">{loading ? "CSV..." : "CSV"}</span>
            <span className="hidden sm:inline">{loading ? "Generating..." : "Download CSV"}</span>
          </Button>

          <Button onClick={handleDownloadPDF} size="sm" variant="outline" className="w-full sm:w-auto">
            <Download className="w-4 h-4 mr-2" />
            <span className="sm:hidden">PDF</span>
            <span className="hidden sm:inline">Download PDF</span>
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => {
              setFilters({ start: "", end: "", customer: "", category: "" });
              setRange(undefined);
              setGroupBy("day");
            }}
            title="Clear all filters"
          >
            <span className="sm:hidden">Reset</span>
            <span className="hidden sm:inline">Reset Filters</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                toast.success("Link copied");
              } catch (e) {
                console.error(e);
                toast.error("Could not copy link");
              }
            }}
            title="Copy current filtered URL"
          >
            <span className="sm:hidden">Copy</span>
            <span className="hidden sm:inline">Copy Link</span>
          </Button>
          {/* Active filters count */}
          {(() => {
            const count = [
              filters.start ? 1 : 0,
              filters.end ? 1 : 0,
              filters.customer ? 1 : 0,
              filters.category ? 1 : 0,
              groupBy !== "day" ? 1 : 0,
            ].reduce((a, b) => a + b, 0);
            return count > 0 ? <Badge variant="secondary">{count} active</Badge> : null;
          })()}
        </div>
      </CardHeader>

      <CardContent className="grid gap-4 min-w-0">
        {/* Summary snapshot (revenue, COGS, expenses, profit, margin) */}
        <ProfitSummary summary={summary} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 min-w-0">
          <div className="border rounded-md p-3 bg-muted/40 min-w-0">
            <div className="text-xs text-muted-foreground">Open period</div>
            <p className="text-sm font-semibold">
              {currentOpenPeriod ? currentOpenPeriod.name : "None"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {currentOpenPeriod
                ? `${new Date(currentOpenPeriod.startDate).toLocaleDateString()} - ${new Date(
                    currentOpenPeriod.endDate,
                  ).toLocaleDateString()}`
                : "Create a period in Accounting."}
            </p>
            <Link href="/admin/accounting/periods" className="text-xs text-muted-foreground underline">
              Manage periods
            </Link>
          </div>
          <div className="border rounded-md p-3 bg-muted/40 min-w-0">
            <div className="text-xs text-muted-foreground">Latest VAT filing</div>
            <p className="text-sm font-semibold">
              {latestVatRun
                ? `${new Date(latestVatRun.startDate).toLocaleDateString()} - ${new Date(
                    latestVatRun.endDate,
                  ).toLocaleDateString()}`
                : "None"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {latestVatRun ? `Saved ${new Date(latestVatRun.createdAt).toLocaleDateString()}` : "Save a VAT filing run."}
            </p>
            <Link href="/admin/accounting/vat-filings" className="text-xs text-muted-foreground underline">
              View filings
            </Link>
          </div>
          <div className="border rounded-md p-3 bg-muted/40 min-w-0">
            <div className="text-xs text-muted-foreground">Integrity status</div>
            <p className="text-sm font-semibold">
              {integrity
                ? integrity.draftEntries > 0 ||
                  Math.abs(integrity.arDifference || 0) > 0.01 ||
                  Math.abs(integrity.inventoryDifference || 0) > 0.01 ||
                  integrity.negativeStockCount > 0
                  ? "Attention needed"
                  : "All clear"
                : "Loading"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {integrity
                ? `${integrity.draftEntries} drafts · ${integrity.negativeStockCount} negative stock`
                : "Run integrity checks."}
            </p>
            <Link href="/admin/accounting/integrity" className="text-xs text-muted-foreground underline">
              Review checks
            </Link>
          </div>
        </div>
        <InventoryAlerts />
        <MarginRisk />
        <MonitoringSummary />
        <div className="border rounded-md p-3 bg-muted/30 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Expense breakdown</span>
              <Tooltip content="Payroll expenses are auto-created from HR payroll runs.">
                <HelpCircle className="h-3.5 w-3.5" />
              </Tooltip>
            </div>
            <Link href="/admin/expenses" className="text-xs text-muted-foreground underline">
              View expenses
            </Link>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {expenseChips.length ? (
              expenseChips.map((item) => (
                <Badge key={item.category} variant="outline" className="gap-1">
                  <span>{item.category}</span>
                  <span className="text-foreground">{formatCurrency(item.amount)}</span>
                  {summary.totalExpense > 0 ? (
                    <span className="text-[11px] text-muted-foreground">
                      ({item.percent.toFixed(1)}%)
                    </span>
                  ) : null}
                </Badge>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">No expenses logged for the selected period.</span>
            )}
          </div>
        </div>

        <div className="space-y-3 min-w-0">
          <div className="flex flex-wrap gap-2 text-[11px]">
            <Badge variant="outline">Order-date: sales, tax, outstanding, reconciliation</Badge>
            <Badge variant="outline">Payment-date: cash in/out, net cash</Badge>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Link href={appendActivePeriod("/admin/balances")} className="border rounded-md px-3 py-2 text-xs bg-muted/30 hover:bg-muted/50">
              Review Outstanding
            </Link>
            <Link href={appendActivePeriod("/admin/momo-payments")} className="border rounded-md px-3 py-2 text-xs bg-muted/30 hover:bg-muted/50">
              Review Pending MoMo
            </Link>
            <Link href={appendActivePeriod("/admin/accounting/integrity")} className="border rounded-md px-3 py-2 text-xs bg-muted/30 hover:bg-muted/50">
              Open Integrity
            </Link>
            <Link href={appendActivePeriod("/admin/health")} className="border rounded-md px-3 py-2 text-xs bg-muted/30 hover:bg-muted/50">
              Open Health
            </Link>
          </div>
          <details className="border rounded-md bg-muted/20 px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-foreground">
              Metric definitions
            </summary>
            <div className="mt-2 space-y-1 text-muted-foreground">
              <p><span className="font-medium text-foreground">Gross sales (pre-tax):</span> Order subtotal before tax and refunds.</p>
              <p><span className="font-medium text-foreground">Billed total (incl. tax):</span> Invoice total including tax on period orders.</p>
              <p><span className="font-medium text-foreground">Discounts:</span> Reduction from gross billed to invoice total on discounted orders.</p>
              <p><span className="font-medium text-foreground">Cash in:</span> Payments recorded in the selected period (pending MoMo excluded).</p>
              <p><span className="font-medium text-foreground">Outstanding:</span> Unpaid balance as-of-now on orders created in the selected period.</p>
            </div>
          </details>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Sales (order-date basis)
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 min-w-0">
            <div className="border rounded-md p-2.5 sm:p-3 bg-muted/40 min-w-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Gross sales (pre-tax)</span>
                <Tooltip content="Order-date basis: order subtotals before tax, refunds, COGS, and expenses.">
                  <HelpCircle className="h-3.5 w-3.5" />
                </Tooltip>
              </div>
              <p className="text-lg font-semibold">{formatCurrency(summary.totalRevenue)}</p>
              {previousBucketDelta && showComparison ? (
                <p className={`text-[11px] ${previousBucketDelta.revenue.delta >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                  {formatDeltaLabel(previousBucketDelta.revenue)}
                </p>
              ) : null}
              <p className="text-[11px] text-muted-foreground">Pre-tax sales value.</p>
              <Link href={appendActivePeriod("/admin/orders")} className="text-[11px] underline text-muted-foreground">
                View orders
              </Link>
            </div>
            <div className="border rounded-md p-2.5 sm:p-3 bg-muted/40 min-w-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Tax collected</span>
                <Tooltip content="Order-date basis: billed tax amount in the selected period.">
                  <HelpCircle className="h-3.5 w-3.5" />
                </Tooltip>
              </div>
              <p className="text-lg font-semibold">{formatCurrency(summary.totalTaxCollected)}</p>
              <p className="text-[11px] text-muted-foreground">Billed tax component.</p>
            </div>
            <div className="border rounded-md p-2.5 sm:p-3 bg-muted/40 min-w-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Discounts</span>
                <Tooltip content="Order-date basis: total discount amount applied to orders in the selected period.">
                  <HelpCircle className="h-3.5 w-3.5" />
                </Tooltip>
              </div>
              <p className="text-lg font-semibold text-amber-700">{formatCurrency(summary.totalDiscounts)}</p>
              <p className="text-[11px] text-muted-foreground">
                {summary.discountedOrders} discounted order{summary.discountedOrders === 1 ? "" : "s"}.
              </p>
              <Link href={appendActivePeriod("/admin/accounting/reports/order-discounts")} className="text-[11px] underline text-muted-foreground">
                View discounts report
              </Link>
            </div>
            <div className="border rounded-md p-2.5 sm:p-3 bg-muted/40 min-w-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Net sales</span>
                <Tooltip content="Gross sales minus refunds for the selected period.">
                  <HelpCircle className="h-3.5 w-3.5" />
                </Tooltip>
              </div>
              <p className="text-lg font-semibold">{formatCurrency(summary.netRevenue)}</p>
              <p className="text-[11px] text-muted-foreground">After refunds.</p>
            </div>
            <div className="border rounded-md p-2.5 sm:p-3 bg-muted/40 min-w-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Refunds</span>
                <Tooltip content="Total refunded payments in this period.">
                  <HelpCircle className="h-3.5 w-3.5" />
                </Tooltip>
              </div>
              <p className="text-lg font-semibold text-red-600">
                {formatCurrency(summary.totalRefunds)}
              </p>
              <p className="text-[11px] text-muted-foreground">Total refunded in period.</p>
            </div>
            <div className="border rounded-md p-2.5 sm:p-3 bg-muted/40 min-w-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Outstanding (period orders)</span>
                <Tooltip content="Order-date basis: as-of-now unpaid amount on orders created in the selected period.">
                  <HelpCircle className="h-3.5 w-3.5" />
                </Tooltip>
              </div>
              <p className="text-lg font-semibold text-amber-700">
                {formatCurrency(summary.totalOutstanding)}
              </p>
              {previousBucketDelta && showComparison ? (
                <p className={`text-[11px] ${previousBucketDelta.outstanding.delta <= 0 ? "text-emerald-700" : "text-amber-700"}`}>
                  {formatDeltaLabel(previousBucketDelta.outstanding)}
                </p>
              ) : null}
              <p className="text-[11px] text-muted-foreground">As-of-now for this period&apos;s orders.</p>
              <Link href={appendActivePeriod("/admin/balances")} className="text-[11px] underline text-muted-foreground">
                View customer balances
              </Link>
            </div>
          </div>
        </div>
        <div className="space-y-3 min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Cash (payment-date basis)
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 min-w-0">
            <div className="border rounded-md p-2.5 sm:p-3 bg-muted/40 min-w-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Cash in</span>
                <Tooltip content="Payment-date basis: payments received in the selected period (pending MoMo excluded).">
                  <HelpCircle className="h-3.5 w-3.5" />
                </Tooltip>
              </div>
              <p className="text-lg font-semibold text-emerald-700">
                {formatCurrency(summary.totalCashIn)}
              </p>
              {previousBucketDelta && showComparison ? (
                <p className={`text-[11px] ${previousBucketDelta.cashIn.delta >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                  {formatDeltaLabel(previousBucketDelta.cashIn)}
                </p>
              ) : null}
              <p className="text-[11px] text-muted-foreground">Payments received.</p>
              <Link
                href={appendActivePeriod("/admin/accounting/journal?source=PAYMENT")}
                className="text-[11px] underline text-muted-foreground"
              >
                View payment journal
              </Link>
            </div>
            <div className="border rounded-md p-2.5 sm:p-3 bg-muted/40 min-w-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Cash out</span>
                <Tooltip content="Refunds and reversals paid out.">
                  <HelpCircle className="h-3.5 w-3.5" />
                </Tooltip>
              </div>
              <p className="text-lg font-semibold text-red-600">
                {formatCurrency(summary.totalCashOut)}
              </p>
              <p className="text-[11px] text-muted-foreground">Refunds and reversals.</p>
            </div>
            <div className="border rounded-md p-2.5 sm:p-3 bg-muted/40 min-w-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Net cash</span>
                <Tooltip content="Cash in minus cash out for the selected period.">
                  <HelpCircle className="h-3.5 w-3.5" />
                </Tooltip>
              </div>
              <p className="text-lg font-semibold">
                {formatCurrency(summary.netCash)}
              </p>
              <p className="text-[11px] text-muted-foreground">Cash in minus cash out.</p>
            </div>
          </div>
        </div>
        <div className="flex sm:hidden">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowMoreMetrics((v) => !v)}
          >
            {showMoreMetrics ? "Hide more metrics" : "Show more metrics"}
          </Button>
        </div>
        <div className={`${showMoreMetrics ? "grid" : "hidden"} gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-4 min-w-0`}>
          <div className="border rounded-md p-3 bg-muted/40 min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Payroll expense</span>
              <Tooltip content="Auto-created from HR payroll runs in this period.">
                <HelpCircle className="h-3.5 w-3.5" />
              </Tooltip>
            </div>
            <p className="text-lg font-semibold">{formatCurrency(payrollExpense)}</p>
            <p className="text-[11px] text-muted-foreground">
              {summary.totalExpense > 0
                ? `${((payrollExpense / summary.totalExpense) * 100).toFixed(1)}% of total expenses`
                : "Captured from HR payroll."}
            </p>
          </div>
          <div className="border rounded-md p-3 bg-muted/40 min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Orders</span>
              <Tooltip content="Number of orders created in the selected period.">
                <HelpCircle className="h-3.5 w-3.5" />
              </Tooltip>
            </div>
            <p className="text-lg font-semibold tabular-nums">
              {summary.orderCount.toLocaleString()}
            </p>
            <p className="text-[11px] text-muted-foreground">
              AOV {formatCurrency(summary.averageOrderValue)}
            </p>
          </div>
          <div className="border rounded-md p-3 bg-muted/40">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Fulfillment</span>
              <Tooltip content="Delivery status split for orders in this period.">
                <HelpCircle className="h-3.5 w-3.5" />
              </Tooltip>
            </div>
            <p className="text-sm font-medium">
              Delivered: {summary.deliveredCount}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Pending {summary.pendingCount} · Partial {summary.partiallyDeliveredCount} · Returned {summary.returnedCount}
            </p>
          </div>
        </div>
        <div className="border rounded-md p-3 bg-muted/30 min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Period sales reconciliation</span>
            <Tooltip content="Order-date basis. This equation ties out for orders created in the selected period: billed amount equals collected amount plus current outstanding.">
              <HelpCircle className="h-3.5 w-3.5" />
            </Tooltip>
          </div>
          {anomalyChips.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {anomalyChips.map((chip) => (
                <Badge key={chip.key} variant="outline" className={chip.tone}>
                  {chip.label}
                </Badge>
              ))}
            </div>
          ) : (
            <div className="mt-2">
              <Badge variant="outline" className="text-emerald-700">No active finance anomalies</Badge>
            </div>
          )}
          <p className="mt-1 text-sm font-semibold">
            {formatCurrency(summary.totalBilled)} = {formatCurrency(summary.totalCollectedOnPeriodSales)} + {formatCurrency(summary.totalOutstandingOnPeriodSales)}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">
            Billed order total (incl. tax) = Collected on period sales + Outstanding on period sales.
          </p>
          <p className="text-[11px] text-muted-foreground">
            Billed order total = Gross sales (pre-tax) + Tax collected - Discounts.
          </p>
          <p className="text-[11px] text-muted-foreground">
            Tax collected in period: <span className="font-medium text-foreground">{formatCurrency(summary.totalTaxCollected)}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            Discounts in period: <span className="font-medium text-foreground">{formatCurrency(summary.totalDiscounts)}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            Reconciliation delta:{" "}
            <span className={Math.abs(summary.reconciliationDelta) <= 0.01 ? "text-emerald-700 font-medium" : "text-amber-700 font-medium"}>
              {formatCurrency(summary.reconciliationDelta)}
            </span>
          </p>
        </div>

        {/* At-a-glance insights: top products & customers */}
        {(topProducts && topProducts.length > 0) || (topCustomers && topCustomers.length > 0) ? (
          <div className="grid gap-3 sm:grid-cols-2 min-w-0">
            {topProducts && topProducts.length > 0 && (
              <div className="border rounded-md p-3 bg-muted/40 min-w-0">
                <h3 className="text-sm font-semibold mb-2">Top products (by quantity)</h3>
                <ul className="space-y-1 text-xs">
                  {topProducts.slice(0, 5).map((p) => (
                    <li key={p.id} className="flex justify-between gap-2">
                      <span className="truncate" title={p.name}>{p.name}</span>
                      <span className="tabular-nums">{p.totalSold} pcs</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Based on all recorded order items. Use this to check which items drive most sales.
                </p>
              </div>
            )}
            {topCustomers && topCustomers.length > 0 && (
              <div className="border rounded-md p-3 bg-muted/40 min-w-0">
                <h3 className="text-sm font-semibold mb-2">Top customers</h3>
                <ul className="space-y-1 text-xs">
                  {topCustomers.slice(0, 5).map((c) => (
                    <li key={c.userId} className="flex flex-col gap-0.5">
                      <div className="flex justify-between gap-2">
                        <span className="truncate" title={c.email || c.name || ""}>
                          {c.name || c.email || "Unknown customer"}
                        </span>
                        <span className="tabular-nums font-medium">
                          GH₵ {c.ordersTotal.toFixed(2)}
                        </span>
                      </div>
                      {c.creditAvailable > 0 && (
                        <span className="text-[11px] text-emerald-700">
                          Credit: GH₵ {c.creditAvailable.toFixed(2)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Ranked by total order value. Use this when following up with key accounts.
                </p>
              </div>
            )}
          </div>
        ) : null}

        {/* Filters */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Filters and period grouping</span>
            <span>
              Last refreshed:{" "}
              <span className="font-medium text-foreground">
                {lastUpdatedAt ? lastUpdatedAt.toLocaleString() : "—"}
              </span>
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              Active period:{" "}
              <span className="font-medium text-foreground">{activePeriodLabel}</span>{" "}
              <span className="text-muted-foreground">({groupBy})</span>
            </span>
            <Button
              size="sm"
              variant={showComparison ? "default" : "outline"}
              onClick={() => setShowComparison((v) => !v)}
              className="h-7 px-2.5 text-[11px]"
            >
              {showComparison ? "Comparison On" : "Comparison Off"}
            </Button>
          </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="justify-start">
                <Filter className="w-4 h-4 mr-2" />
                {range?.from ? (
                  range.to ? (
                    <>
                      {format(range.from, "MMM d, yyyy")} -{" "}
                      {format(range.to, "MMM d, yyyy")}
                    </>
                  ) : (
                    format(range.from, "MMM d, yyyy")
                  )
                ) : (
                  "Pick date range"
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="p-2">
              <Calendar
                mode="range"
                selected={range}
                onSelect={(r) => {
                  setRange(r);
                  setFilters((f) => ({
                    ...f,
                    start: r?.from ? format(r.from, "yyyy-MM-dd") : "",
                    end: r?.to ? format(r.to, "yyyy-MM-dd") : "",
                  }));
                }}
              />
              <div className="flex flex-wrap gap-2 mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const from = startOfDay(new Date());
                    const to = endOfDay(new Date());
                    setRange({ from, to });
                    setFilters((f) => ({
                      ...f,
                      start: format(from, "yyyy-MM-dd"),
                      end: format(to, "yyyy-MM-dd"),
                    }));
                  }}
                  title="Set date range to today"
                >
                  Today
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const to = endOfDay(new Date());
                    const from = startOfDay(subDays(to, 6));
                    setRange({ from, to });
                    setFilters((f) => ({
                      ...f,
                      start: format(from, "yyyy-MM-dd"),
                      end: format(to, "yyyy-MM-dd"),
                    }));
                  }}
                  title="Set date range to last 7 days"
                >
                  Last 7 days
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const now = new Date();
                    const from = startOfMonth(now);
                    const to = endOfMonth(now);
                    setRange({ from, to });
                    setFilters((f) => ({
                      ...f,
                      start: format(from, "yyyy-MM-dd"),
                      end: format(to, "yyyy-MM-dd"),
                    }));
                  }}
                  title="Set date range to current month"
                >
                  This month
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const to = endOfDay(new Date());
                    const from = startOfDay(subDays(to, 29));
                    setRange({ from, to });
                    setFilters((f) => ({
                      ...f,
                      start: format(from, "yyyy-MM-dd"),
                      end: format(to, "yyyy-MM-dd"),
                    }));
                  }}
                  title="Set date range to last 30 days"
                >
                  Last 30 days
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const now = new Date();
                    const from = startOfMonth(subMonths(now, 11));
                    const to = endOfMonth(now);
                    setRange({ from, to });
                    setFilters((f) => ({
                      ...f,
                      start: format(from, "yyyy-MM-dd"),
                      end: format(to, "yyyy-MM-dd"),
                    }));
                    setGroupBy("month");
                  }}
                  title="Set date range to the last 12 months"
                >
                  Last 12 months
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const now = new Date();
                    const from = startOfYear(now);
                    const to = endOfYear(now);
                    setRange({ from, to });
                    setFilters((f) => ({
                      ...f,
                      start: format(from, "yyyy-MM-dd"),
                      end: format(to, "yyyy-MM-dd"),
                    }));
                  }}
                  title="Set date range to current year"
                >
                  This year
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <Input
            placeholder="Customer name"
            value={filters.customer}
            onChange={(e) =>
              setFilters((f) => ({ ...f, customer: e.target.value }))
            }
          />
          <Input
            placeholder="Category"
            value={filters.category}
            onChange={(e) =>
              setFilters((f) => ({ ...f, category: e.target.value }))
            }
          />

        <div className="flex flex-wrap gap-2 w-full">
          <Button
            variant={groupBy === "day" ? "default" : "outline"}
            onClick={() => setGroupBy("day")}
          >
            Day
          </Button>
          <Button
            variant={groupBy === "week" ? "default" : "outline"}
            onClick={() => setGroupBy("week")}
          >
            Week
          </Button>
          <Button
            variant={groupBy === "month" ? "default" : "outline"}
            onClick={() => setGroupBy("month")}
          >
            Month
          </Button>
          <Button
            variant={groupBy === "year" ? "default" : "outline"}
            onClick={() => setGroupBy("year")}
          >
            Year
          </Button>
        </div>
        </div>

        {/* Charts */}
        <div className="grid gap-4 min-w-0">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                Sales Trend (Gross vs Net)
                <Tooltip content="Gross sales from orders vs net sales after refunds, plus a rolling average to smooth volatility.">
                  <HelpCircle className="h-4 w-4 text-muted-foreground" />
                </Tooltip>
              </CardTitle>
            </CardHeader>
            <CardContent className="min-w-0">
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={primaryTrend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="period" />
                  <YAxis tickFormatter={(value) => axisNumberFormatter.format(Number(value || 0))} />
                  <RechartsTooltip
                    formatter={(value: number, name) => {
                      if (name === "rollingRevenue") return formatCurrency(Number(value));
                      return formatCurrency(Number(value));
                    }}
                    labelFormatter={(label) => `Period: ${label}`}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="revenue" stroke="#3b82f6" name="Gross sales" />
                  <Line type="monotone" dataKey="netRevenue" stroke="#16a34a" name="Net sales" />
                  <Line
                    type="monotone"
                    dataKey="rollingRevenue"
                    stroke="#94a3b8"
                    strokeDasharray="6 4"
                    name="7-period avg"
                  />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base font-semibold flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="flex items-center gap-2">
                  Expense Trend
                  <Tooltip content="Operating expenses grouped by the selected period. Use this to spot spikes.">
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </Tooltip>
                </span>
                {groupBy !== "month" ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    Switch to Month to see payroll MoM.
                  </span>
                ) : payrollMoM ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    Payroll MoM: {payrollMoM.percent === null
                      ? `${formatCurrency(payrollMoM.delta)} vs last month`
                      : `${payrollMoM.percent >= 0 ? "+" : ""}${payrollMoM.percent.toFixed(1)}% (${formatCurrency(payrollMoM.delta)})`}
                  </span>
                ) : (
                  <span className="text-xs font-normal text-muted-foreground">
                    Not enough payroll history yet.
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="min-w-0">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={primaryTrend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="period" />
                  <YAxis tickFormatter={(value) => axisNumberFormatter.format(Number(value || 0))} />
                  <RechartsTooltip
                    formatter={(value: number) => formatCurrency(Number(value))}
                    labelFormatter={(label) => `Period: ${label}`}
                  />
                  <Legend />
                  <Bar dataKey="expense" fill="#ef4444" name="Expenses" />
                  <Bar dataKey="payrollExpense" fill="#2563eb" name="Payroll" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                Cash Flow
                <Tooltip content="Cash in from payments vs cash out from refunds/reversals; net cash is the difference.">
                  <HelpCircle className="h-4 w-4 text-muted-foreground" />
                </Tooltip>
              </CardTitle>
            </CardHeader>
            <CardContent className="min-w-0">
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={primaryTrend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="period" />
                  <YAxis tickFormatter={(value) => axisNumberFormatter.format(Number(value || 0))} />
                  <RechartsTooltip
                    formatter={(value: number) => formatCurrency(Number(value))}
                    labelFormatter={(label) => `Period: ${label}`}
                  />
                  <Legend />
                  <Bar dataKey="cashIn" fill="#22c55e" name="Cash in" />
                  <Bar dataKey="cashOut" fill="#ef4444" name="Cash out" />
                  <Line type="monotone" dataKey="netCash" stroke="#2563eb" name="Net cash" />
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                Orders &amp; AOV
                <Tooltip content="Order count and average order value (AOV) per period.">
                  <HelpCircle className="h-4 w-4 text-muted-foreground" />
                </Tooltip>
              </CardTitle>
            </CardHeader>
            <CardContent className="min-w-0">
              {useLedger ? (
                <p className="mb-3 text-xs text-muted-foreground">
                  Ledger mode: orders are counted from ORDER journal entries, and AOV uses sales
                  revenue lines.
                </p>
              ) : null}
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={primaryTrend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="period" />
                  <YAxis
                    yAxisId="left"
                    tickFormatter={(value) => axisNumberFormatter.format(Number(value || 0))}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tickFormatter={(value) => axisNumberFormatter.format(Number(value || 0))}
                  />
                  <RechartsTooltip
                    formatter={(value: number, name) => {
                      if (name === "averageOrderValue") return formatCurrency(Number(value));
                      return Number(value || 0).toLocaleString();
                    }}
                    labelFormatter={(label) => `Period: ${label}`}
                  />
                  <Legend />
                  <Bar yAxisId="left" dataKey="orderCount" fill="#8b5cf6" name="Orders" />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="averageOrderValue"
                    stroke="#f59e0b"
                    name="AOV"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                Margin Trend
                <Tooltip content="Margin % (profit ÷ revenue) with net profit in currency on the right axis.">
                  <HelpCircle className="h-4 w-4 text-muted-foreground" />
                </Tooltip>
              </CardTitle>
            </CardHeader>
            <CardContent className="min-w-0">
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={primaryTrend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="period" />
                  <YAxis
                    yAxisId="left"
                    tickFormatter={(value) =>
                      `${axisNumberFormatter.format(Number(value || 0))}%`
                    }
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tickFormatter={(value) =>
                      axisNumberFormatter.format(Number(value || 0))
                    }
                  />
                  <RechartsTooltip
                    formatter={(value: number, name) => {
                      if (name === "margin") {
                        return `${Number(value || 0).toFixed(2)}%`;
                      }
                      return formatCurrency(Number(value || 0));
                    }}
                    labelFormatter={(label) => `Period: ${label}`}
                  />
                  <Legend />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="margin"
                    stroke="#0f766e"
                    name="Margin %"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="profit"
                    stroke="#2563eb"
                    name="Net profit"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
        </div>

      </CardContent>
    </Card>
    </section>
  );
}

export default function AdminDashboardPage() {
  return (
    <Suspense
      fallback={
        <section className="container mx-auto py-8 space-y-4">
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Loading dashboard…</p>
        </section>
      }
    >
      <AdminDashboardContent />
    </Suspense>
  );
}
