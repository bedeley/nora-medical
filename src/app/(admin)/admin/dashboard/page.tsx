"use client";

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
import {
  format,
  startOfDay,
  endOfDay,
  subDays,
  subMonths,
  startOfMonth,
  endOfMonth,
  startOfYear,
  endOfYear,
} from "date-fns";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Download, Filter, Table, RefreshCcw, HelpCircle, AlertTriangle } from "lucide-react";
import AddExpenseDialog from "@/app/(admin)/dashboard/components/AddExpenseDialog";
import ProfitSummary from "@/app/(admin)/dashboard/components/ProfitSummary";
import InventoryAlerts from "@/app/(admin)/dashboard/components/InventoryAlerts";
import MarginRisk from "@/app/(admin)/dashboard/components/MarginRisk";
import MonitoringSummary from "@/app/(admin)/dashboard/components/MonitoringSummary";
import ReportingReconciliationPanel from "@/components/admin/ReportingReconciliationPanel";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  appendDashboardPeriodParams,
  buildDashboardPreviousBucketDelta,
  countDashboardActiveFilters,
  DashboardDeltaValue,
  DashboardFilters,
  DashboardGroupBy,
  formatDashboardActivePeriodLabel,
  formatDashboardDeltaLabel,
  normalizeDashboardTrendRows,
} from "@/lib/admin-dashboard";
import { formatCurrency } from "@/lib/currency";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import {
  buildReportingReconciliation,
  type ReportingReconciliationReport,
  type ReportingReconciliationSnapshot,
} from "@/lib/reporting-reconciliation";
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
    totalRefunds?: number;
    netRevenue?: number;
    totalCOGS?: number;
    totalExpense?: number;
    totalCashIn?: number;
    totalCashOut?: number;
    netCash?: number;
    orderCount?: number;
    averageOrderValue?: number;
    totalTaxCollected?: number;
    totalDiscounts?: number;
    discountedOrders?: number;
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
  ledgerMismatches: number;
  missingPostings: {
    orders: number;
    payments: number;
    expenses: number;
    purchases: number;
    supplierPayments: number;
    creditPayouts: number;
    settlements: number;
  };
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

  const [filters, setFilters] = useState<DashboardFilters>({ start: "", end: "", customer: "", category: "" });
  const [range, setRange] = useState<DateRange | undefined>();
  const [loading, setLoading] = useState(false);
  const [chartData, setChartData] = useState<TrendRow[]>([]);
  const [summary, setSummary] = useState<DashboardSummary>({
    totalRevenue: 0, totalRefunds: 0, netRevenue: 0, totalCOGS: 0, totalExpense: 0,
    profit: 0, margin: 0, orderCount: 0, averageOrderValue: 0,
    totalCashIn: 0, totalCashOut: 0, netCash: 0, totalOutstanding: 0, totalBilled: 0,
    totalTaxCollected: 0, totalDiscounts: 0, discountedOrders: 0,
    totalCollectedOnPeriodSales: 0, totalOutstandingOnPeriodSales: 0, reconciliationDelta: 0,
    deliveredCount: 0, partiallyDeliveredCount: 0, returnedCount: 0, pendingCount: 0,
    expenseBreakdown: [],
  });
  const [groupBy, setGroupBy] = useState<DashboardGroupBy>("day");
  const [showMoreMetrics, setShowMoreMetrics] = useState(false);
  const [showComparison, setShowComparison] = useState(true);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [rawData, setRawData] = useState<RawReportRow[]>([]);
  const [rawLoading, setRawLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  // GL vs operational revenue gap — shown as passive anomaly chip
  const [glRevenueDelta, setGlRevenueDelta] = useState<number | null>(null);
  const [reconciliationReport, setReconciliationReport] = useState<ReportingReconciliationReport | null>(null);

  const payrollExpense = useMemo(() => {
    const breakdown = summary.expenseBreakdown || [];
    return breakdown
      .filter((item) => /payroll/i.test(item.category || ""))
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
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
    return buildDashboardPreviousBucketDelta(
      chartData
        .slice()
        .sort((a, b) => String(a.period || "").localeCompare(String(b.period || ""))),
    );
  }, [chartData]);

  const formatDeltaLabel = (value: DashboardDeltaValue) => {
    return formatDashboardDeltaLabel(value, groupBy, formatCurrency);
  };

  const outstandingRatio = useMemo(() => {
    const billed = Number(summary.totalBilled || 0);
    if (billed <= 0) return 0;
    return Number(summary.totalOutstandingOnPeriodSales || 0) / billed;
  }, [summary.totalBilled, summary.totalOutstandingOnPeriodSales]);

  const anomalyChips = useMemo(
    () =>
      [
        {
          key: "high-outstanding",
          show: outstandingRatio > 0.25,
          label: `High outstanding ratio (${(outstandingRatio * 100).toFixed(1)}%)`,
          tone: "text-amber-700 bg-amber-50 border-amber-200",
        },
        {
          key: "negative-net-cash",
          show: Number(summary.netCash || 0) < 0,
          label: "Negative net cash in selected period",
          tone: "text-red-700 bg-red-50 border-red-200",
        },
        {
          key: "ledger-alignment",
          show: Boolean(reconciliationReport && reconciliationReport.reviewCount > 0),
          label: `GL vs operational revenue gap: ${formatCurrency(glRevenueDelta || 0)} — check unposted entries`,
          tone: "text-amber-700 bg-amber-50 border-amber-200",
        },
      ].filter((chip) => chip.show),
    [outstandingRatio, summary.netCash, glRevenueDelta, reconciliationReport],
  );

  const activePeriodLabel = useMemo(() => {
    return formatDashboardActivePeriodLabel(filters.start, filters.end);
  }, [filters.start, filters.end]);

  const appendActivePeriod = useCallback(
    (path: string) => {
      return appendDashboardPeriodParams(path, filters.start, filters.end);
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
  const currentOpenPeriod = (periods || []).find((period) => period.status === "OPEN");
  const latestVatRun = (vatRuns || [])[0];

  const { data: topProducts } = useQuery<TopProduct[]>({
    queryKey: ["admin", "top-products", filters.start, filters.end],
    queryFn: async () => {
      const params = new URLSearchParams({ mode: "quantity" });
      if (filters.start) params.set("start", filters.start);
      if (filters.end) params.set("end", filters.end);
      const res = await fetch(`/api/admin/top-products?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load top products");
      return res.json();
    },
    staleTime: 60_000,
  });

  const { data: topCustomers } = useQuery<TopCustomer[]>({
    queryKey: ["admin", "top-customers", filters.start, filters.end],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.start) params.set("start", filters.start);
      if (filters.end) params.set("end", filters.end);
      const res = await fetch(`/api/admin/top-customers?${params.toString()}`);
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
  const totalMissingPostings = healthSummary?.missingPostings
    ? Object.values(healthSummary.missingPostings).reduce((sum, v) => sum + (v || 0), 0)
    : 0;
  const healthIssuesCount =
    (healthSummary?.paymentMismatches || 0) +
    (healthSummary?.orderBalanceMismatches || 0) +
    (healthSummary?.stockMismatches || 0) +
    (healthSummary?.legacyAutoApply || 0) +
    (healthSummary?.ledgerMismatches || 0) +
    totalMissingPostings;

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

  // Sync filters to URL
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

  // Fetch dashboard data — always GL-authoritative for financials, operational for AR/fulfillment
  const fetchChartData = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.customer) params.append("customer", filters.customer);
      if (filters.category) params.append("category", filters.category);
      params.append("groupBy", groupBy);

      const [operationalRes, glRes] = await Promise.all([
        fetch(`/api/admin/summary?${params.toString()}`),
        fetch(`/api/admin/accounting/reports/ledger-summary?${params.toString()}`),
      ]);

      if (!operationalRes.ok) {
        const body = await operationalRes.text().catch(() => "");
        throw new Error(`Failed to fetch dashboard data (${operationalRes.status}): ${body || "unknown error"}`);
      }

      const operational: SummaryResponse = await operationalRes.json();
      const sp = operational.summary || {};
      const operationalSummary: DashboardSummary = {
        totalRevenue: Number(sp.totalRevenue || 0),
        totalRefunds: Number(sp.totalRefunds || 0),
        netRevenue: Number(sp.netRevenue || 0),
        totalCOGS: Number(sp.totalCOGS || 0),
        totalExpense: Number(sp.totalExpense || 0),
        profit: Number(sp.profit || 0),
        margin: Number(sp.margin ?? 0),
        orderCount: Number(sp.orderCount || 0),
        averageOrderValue: Number(sp.averageOrderValue || 0),
        totalCashIn: Number(sp.totalCashIn || 0),
        totalCashOut: Number(sp.totalCashOut || 0),
        netCash: Number(sp.netCash || 0),
        totalOutstanding: Number(sp.totalOutstanding || 0),
        totalBilled: Number(sp.totalBilled || 0),
        totalTaxCollected: Number(sp.totalTaxCollected || 0),
        totalDiscounts: Number(sp.totalDiscounts || 0),
        discountedOrders: Number(sp.discountedOrders || 0),
        totalCollectedOnPeriodSales: Number(sp.totalCollectedOnPeriodSales || 0),
        totalOutstandingOnPeriodSales: Number(sp.totalOutstandingOnPeriodSales || 0),
        reconciliationDelta: Number(sp.reconciliationDelta || 0),
        deliveredCount: Number(sp.deliveredCount || 0),
        partiallyDeliveredCount: Number(sp.partiallyDeliveredCount || 0),
        returnedCount: Number(sp.returnedCount || 0),
        pendingCount: Number(sp.pendingCount || 0),
        expenseBreakdown: sp.expenseBreakdown || [],
      };
      const operationalSnapshot: ReportingReconciliationSnapshot = {
        totalRevenue: operationalSummary.totalRevenue,
        totalDiscounts: operationalSummary.totalDiscounts,
        totalRefunds: operationalSummary.totalRefunds,
        netRevenue: operationalSummary.netRevenue,
        totalTaxCollected: operationalSummary.totalTaxCollected,
        totalCOGS: operationalSummary.totalCOGS,
        totalExpense: operationalSummary.totalExpense,
        profit: operationalSummary.profit,
        totalCashIn: operationalSummary.totalCashIn,
        totalCashOut: operationalSummary.totalCashOut,
        netCash: operationalSummary.netCash,
      };

      const operationalTrend = normalizeDashboardTrendRows(
        Array.isArray(operational.trend) ? operational.trend : [],
      );

      // Start with operational data, then overlay GL for financial KPIs
      let merged = operationalSummary;
      let trendToUse = operationalTrend;

      if (glRes.ok) {
        const gl: LedgerSummaryResponse = await glRes.json();
        const gs = gl.summary || {};
        const glRevenue = Number(gs.totalRevenue || 0);
        const glRefunds = typeof gs.totalRefunds === "number"
          ? Number(gs.totalRefunds)
          : operationalSummary.totalRefunds;
        const glDiscounts = typeof gs.totalDiscounts === "number"
          ? Number(gs.totalDiscounts)
          : operationalSummary.totalDiscounts;
        const glNetRevenue = typeof gs.netRevenue === "number"
          ? Number(gs.netRevenue)
          : glRevenue - glDiscounts - glRefunds;
        const glCOGS = Number(gs.totalCOGS || 0);
        const glExpense = Number(gs.totalExpense || 0);
        const glProfit = Number(gs.profit || 0);
        const glMargin = Number(gs.margin ?? 0);
        const glCashIn = Number(gs.totalCashIn || 0);
        const glCashOut = Number(gs.totalCashOut || 0);
        const glOrderCount = Number(gs.orderCount || 0);
        const glAOV = Number(gs.averageOrderValue || 0);
        const glTaxCollected = typeof gs.totalTaxCollected === "number"
          ? Number(gs.totalTaxCollected)
          : operationalSummary.totalTaxCollected;
        const glDiscountedOrders = typeof gs.discountedOrders === "number"
          ? Number(gs.discountedOrders)
          : operationalSummary.discountedOrders;
        const glBreakdown = gs.expenseBreakdown || [];
        const ledgerSnapshot: ReportingReconciliationSnapshot = {
          totalRevenue: glRevenue,
          totalDiscounts: glDiscounts,
          totalRefunds: glRefunds,
          netRevenue: glNetRevenue,
          totalTaxCollected: glTaxCollected,
          totalCOGS: glCOGS,
          totalExpense: glExpense,
          profit: glProfit,
          totalCashIn: glCashIn,
          totalCashOut: glCashOut,
          netCash: glCashIn - glCashOut,
        };

        // Passive health signal: absolute gap between GL net revenue and operational net revenue
        setGlRevenueDelta(Math.abs(glNetRevenue - operationalSummary.netRevenue));
        setReconciliationReport(
          buildReportingReconciliation({
            operational: operationalSnapshot,
            ledger: ledgerSnapshot,
          }),
        );

        merged = {
          ...operationalSummary,          // keep AR/fulfillment from operational
          totalRevenue: glRevenue,         // GL overrides financials
          totalRefunds: glRefunds,
          totalDiscounts: glDiscounts,
          discountedOrders: glDiscountedOrders,
          netRevenue: glNetRevenue,
          totalCOGS: glCOGS,
          totalExpense: glExpense,
          profit: glProfit,
          margin: glMargin,
          totalTaxCollected: glTaxCollected,
          totalCashIn: glCashIn,
          totalCashOut: glCashOut,
          netCash: glCashIn - glCashOut,
          orderCount: glOrderCount > 0 ? glOrderCount : operationalSummary.orderCount,
          averageOrderValue: glAOV > 0 ? glAOV : operationalSummary.averageOrderValue,
          expenseBreakdown: glBreakdown.length > 0 ? glBreakdown : operationalSummary.expenseBreakdown,
        };

        const glTrend = normalizeDashboardTrendRows(
          Array.isArray(gl.trend) ? gl.trend : [],
        );
        if (glTrend.length > 0) trendToUse = glTrend;
      } else {
        setGlRevenueDelta(null);
        setReconciliationReport(null);
      }

      setSummary(merged);
      setChartData(trendToUse);
      setLastUpdatedAt(new Date());
    } catch (err) {
      console.error(err);
      setReconciliationReport(null);
      toast.error("Error loading dashboard data");
    }
  }, [filters, groupBy]);

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
      setIsDialogOpen(true);
    } catch (err) {
      console.error(err);
      toast.error("Error loading raw data");
    } finally {
      setRawLoading(false);
    }
  }

  const activeFilterCount = countDashboardActiveFilters(filters, groupBy);

  return (
    <section className="container mx-auto py-8 space-y-4 min-w-0">

      {/* ── Page header ── */}
      <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Track revenue, expenses, and cash flow at a glance.
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Financial reporting is ledger-backed when posted entries are available. Collections,
            outstanding balances, and fulfillment remain operational.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <AddExpenseDialog onAdded={() => fetchChartData()} />
          <Button variant="outline" size="sm" onClick={fetchChartData}>
            <RefreshCcw className="w-4 h-4 mr-1" />
            Refresh
          </Button>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" onClick={() => loadRawData()}>
                <Table className="w-4 h-4 mr-2" />
                Raw Data
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
                    <Button size="sm" variant="outline" onClick={loadRawData}>Reload</Button>
                    <Button size="sm" variant="ghost" onClick={fetchChartData}>Refresh summary</Button>
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
                        <td className="p-2 border">{format(new Date(r.createdAt), "yyyy-MM-dd")}</td>
                        <td className="p-2 border font-medium capitalize">{r.type}</td>
                        <td className="p-2 border">{r.name || r.category || "-"}</td>
                        <td className={`p-2 border text-right ${r.type === "expense" ? "text-red-600" : "text-green-600"}`}>
                          {formatCurrency(r.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DialogContent>
          </Dialog>
          <Button onClick={handleDownloadCSV} disabled={loading} size="sm" variant="secondary">
            <Download className="w-4 h-4 mr-2" />
            {loading ? "Generating..." : "CSV"}
          </Button>
          <Button onClick={handleDownloadPDF} size="sm" variant="outline">
            <Download className="w-4 h-4 mr-2" />
            PDF
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                toast.success("Link copied");
              } catch (e) {
                console.error(e);
                toast.error("Could not copy link");
              }
            }}
          >
            Copy Link
          </Button>
        </div>
      </header>

      {/* ── Health check alert ── */}
      {healthIssuesCount > 0 && (
        <Card className="border-l-4 border-amber-500 bg-amber-50/60 dark:bg-amber-950/30">
          <CardContent className="py-4 flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <p className="font-semibold text-amber-900 dark:text-amber-100">
                Health check issues detected
              </p>
              <p className="text-amber-900/80 dark:text-amber-100/80">
                {[
                  healthSummary?.stockMismatches ? `${healthSummary.stockMismatches} stock` : null,
                  healthSummary?.orderBalanceMismatches ? `${healthSummary.orderBalanceMismatches} balances` : null,
                  healthSummary?.paymentMismatches ? `${healthSummary.paymentMismatches} payments` : null,
                  healthSummary?.legacyAutoApply ? `${healthSummary.legacyAutoApply} legacy` : null,
                  healthSummary?.ledgerMismatches ? `${healthSummary.ledgerMismatches} ledger drift` : null,
                  totalMissingPostings > 0 ? `${totalMissingPostings} unposted` : null,
                ].filter(Boolean).join(" · ")}
              </p>
            </div>
            <Link href="/admin/health" className="text-amber-900 dark:text-amber-100 font-semibold underline underline-offset-4">
              Review health check
            </Link>
          </CardContent>
        </Card>
      )}

      {/* ── Anomaly chips ── */}
      {anomalyChips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {anomalyChips.map((chip) => (
            <div key={chip.key} className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium ${chip.tone}`}>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {chip.label}
            </div>
          ))}
        </div>
      )}

      {/* ── Filters ── */}
      <Card className="shadow-sm">
        <CardContent className="pt-4 pb-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-3">
              <span>
                Period: <span className="font-medium text-foreground">{activePeriodLabel}</span>{" "}
                <span className="text-muted-foreground">({groupBy})</span>
              </span>
              {lastUpdatedAt && (
                <span>
                  Refreshed: <span className="font-medium text-foreground">{lastUpdatedAt.toLocaleTimeString()}</span>
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={showComparison ? "default" : "outline"}
                onClick={() => setShowComparison((v) => !v)}
                className="h-7 px-2.5 text-[11px]"
              >
                {showComparison ? "Comparison On" : "Comparison Off"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2.5 text-[11px]"
                onClick={() => {
                  setFilters({ start: "", end: "", customer: "", category: "" });
                  setRange(undefined);
                  setGroupBy("day");
                }}
              >
                Reset
              </Button>
              {activeFilterCount > 0 && (
                <Badge variant="secondary">{activeFilterCount} active</Badge>
              )}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            {/* Date picker */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="justify-start w-full">
                  <Filter className="w-4 h-4 mr-2 shrink-0" />
                  <span className="truncate">
                    {range?.from
                      ? range.to
                        ? `${format(range.from, "MMM d, yyyy")} – ${format(range.to, "MMM d, yyyy")}`
                        : format(range.from, "MMM d, yyyy")
                      : "Pick date range"}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="p-2 w-auto">
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
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {[
                    {
                      label: "Today",
                      apply: () => {
                        const from = startOfDay(new Date());
                        const to = endOfDay(new Date());
                        return { from, to, groupBy: undefined as typeof groupBy | undefined };
                      },
                    },
                    {
                      label: "Last 7 days",
                      apply: () => {
                        const to = endOfDay(new Date());
                        const from = startOfDay(subDays(to, 6));
                        return { from, to, groupBy: undefined as typeof groupBy | undefined };
                      },
                    },
                    {
                      label: "This month",
                      apply: () => {
                        const now = new Date();
                        return { from: startOfMonth(now), to: endOfMonth(now), groupBy: undefined as typeof groupBy | undefined };
                      },
                    },
                    {
                      label: "Last 30 days",
                      apply: () => {
                        const to = endOfDay(new Date());
                        const from = startOfDay(subDays(to, 29));
                        return { from, to, groupBy: undefined as typeof groupBy | undefined };
                      },
                    },
                    {
                      label: "This quarter",
                      apply: () => {
                        const now = new Date();
                        const q = Math.floor(now.getMonth() / 3);
                        const from = new Date(now.getFullYear(), q * 3, 1);
                        const to = new Date(now.getFullYear(), q * 3 + 3, 0);
                        return { from, to, groupBy: "month" as typeof groupBy };
                      },
                    },
                    {
                      label: "Last quarter",
                      apply: () => {
                        const now = new Date();
                        const q = Math.floor(now.getMonth() / 3);
                        const lastQEnd = new Date(now.getFullYear(), q * 3, 0);
                        const lastQ = Math.floor(lastQEnd.getMonth() / 3);
                        const from = new Date(lastQEnd.getFullYear(), lastQ * 3, 1);
                        return { from, to: lastQEnd, groupBy: "month" as typeof groupBy };
                      },
                    },
                    {
                      label: "Last 12 months",
                      apply: () => {
                        const now = new Date();
                        const from = startOfMonth(subMonths(now, 11));
                        const to = endOfMonth(now);
                        return { from, to, groupBy: "month" as typeof groupBy };
                      },
                    },
                    {
                      label: "This year",
                      apply: () => {
                        const now = new Date();
                        return { from: startOfYear(now), to: endOfYear(now), groupBy: undefined as typeof groupBy | undefined };
                      },
                    },
                  ].map(({ label, apply }) => (
                    <Button
                      key={label}
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs px-2"
                      onClick={() => {
                        const result = apply();
                        setRange({ from: result.from, to: result.to });
                        setFilters((f) => ({
                          ...f,
                          start: format(result.from, "yyyy-MM-dd"),
                          end: format(result.to, "yyyy-MM-dd"),
                        }));
                        if (result.groupBy) setGroupBy(result.groupBy);
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            <Input
              placeholder="Filter by customer name"
              value={filters.customer}
              onChange={(e) => setFilters((f) => ({ ...f, customer: e.target.value }))}
            />
            <Input
              placeholder="Filter by category"
              value={filters.category}
              onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}
            />

            {/* GroupBy */}
            <div className="flex flex-wrap gap-1.5">
              {(["day", "week", "month", "year"] as const).map((g) => (
                <Button
                  key={g}
                  variant={groupBy === g ? "default" : "outline"}
                  size="sm"
                  className="capitalize"
                  onClick={() => setGroupBy(g)}
                >
                  {g}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Main data card ── */}
      <Card className="shadow-md !border-none min-w-0">
        <CardContent className="grid gap-6 pt-6 min-w-0">

          {/* KPI snapshot */}
          <ProfitSummary summary={summary} />

          {/* Accounting status row */}
          <div className="grid gap-3 sm:grid-cols-3 min-w-0">
            <div className="border rounded-md p-3 bg-muted/40 min-w-0">
              <div className="text-xs text-muted-foreground">Open period</div>
              <p className="text-sm font-semibold">
                {currentOpenPeriod ? currentOpenPeriod.name : "None"}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {currentOpenPeriod
                  ? `${new Date(currentOpenPeriod.startDate).toLocaleDateString()} – ${new Date(currentOpenPeriod.endDate).toLocaleDateString()}`
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
                  ? `${new Date(latestVatRun.startDate).toLocaleDateString()} – ${new Date(latestVatRun.endDate).toLocaleDateString()}`
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

          {/* Contextual alerts */}
          <InventoryAlerts />
          <MarginRisk />
          <MonitoringSummary />

          {/* Expense breakdown */}
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
                    {summary.totalExpense > 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        ({item.percent.toFixed(1)}%)
                      </span>
                    )}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">No expenses logged for the selected period.</span>
              )}
            </div>
          </div>

          {/* Quick links + context badges */}
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
              <summary className="cursor-pointer font-medium text-foreground">Metric definitions</summary>
              <div className="mt-2 space-y-1 text-muted-foreground">
                <p><span className="font-medium text-foreground">Financial reporting:</span> Revenue, refunds, discounts, tax, expenses, profit, and cash are taken from posted ledger entries when available.</p>
                <p><span className="font-medium text-foreground">Operational context:</span> Outstanding balances, collections on period sales, orders, and fulfillment come from live order and payment activity.</p>
                <p><span className="font-medium text-foreground">Ledger alignment:</span> Compares operational and posted-ledger values for the same filters and flags drift above GH₵1.</p>
                <p><span className="font-medium text-foreground">Gross sales (pre-tax):</span> Order subtotal before tax and refunds.</p>
                <p><span className="font-medium text-foreground">Billed total (incl. tax):</span> Invoice total including tax on period orders.</p>
                <p><span className="font-medium text-foreground">Discounts:</span> Reduction from gross billed to invoice total on discounted orders.</p>
                <p><span className="font-medium text-foreground">Cash in:</span> Payments recorded in the selected period (pending MoMo excluded).</p>
                <p><span className="font-medium text-foreground">Outstanding:</span> Unpaid balance as-of-now on orders created in the selected period.</p>
                <p><span className="font-medium text-foreground">GL delta chip:</span> Difference between GL-posted revenue and operational net revenue. Appears when &gt; GH₵1 — usually means recent entries are not yet posted.</p>
              </div>
            </details>
          </div>

          {/* Sales metrics — order-date basis */}
          <ReportingReconciliationPanel report={reconciliationReport} />

          <div className="space-y-3 min-w-0">
            <div className="space-y-1">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Financial reporting
              </div>
              <p className="text-xs text-muted-foreground">
                Ledger-backed revenue, discount, refund, tax, expense, and cash metrics for the selected period.
              </p>
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
                {previousBucketDelta && showComparison && (
                  <p className={`text-[11px] ${previousBucketDelta.revenue.delta >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                    {formatDeltaLabel(previousBucketDelta.revenue)}
                  </p>
                )}
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
                  <Tooltip content="Order-date basis: total discount amount applied in the selected period.">
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
                {previousBucketDelta && showComparison && (
                  <p className={`text-[11px] ${previousBucketDelta.netRevenue.delta >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                    {formatDeltaLabel(previousBucketDelta.netRevenue)}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">After refunds.</p>
              </div>
              <div className="border rounded-md p-2.5 sm:p-3 bg-muted/40 min-w-0">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Refunds</span>
                  <Tooltip content="Total refunded payments in this period.">
                    <HelpCircle className="h-3.5 w-3.5" />
                  </Tooltip>
                </div>
                <p className="text-lg font-semibold text-red-600">{formatCurrency(summary.totalRefunds)}</p>
                {previousBucketDelta && showComparison && (
                  <p className={`text-[11px] ${previousBucketDelta.refunds.delta <= 0 ? "text-emerald-700" : "text-red-600"}`}>
                    {formatDeltaLabel(previousBucketDelta.refunds)}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">Total refunded in period.</p>
              </div>
            </div>
          </div>

          {/* Cash flow — payment-date basis */}
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
                <p className="text-lg font-semibold text-emerald-700">{formatCurrency(summary.totalCashIn)}</p>
                {previousBucketDelta && showComparison && (
                  <p className={`text-[11px] ${previousBucketDelta.cashIn.delta >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                    {formatDeltaLabel(previousBucketDelta.cashIn)}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">Payments received.</p>
                <Link href={appendActivePeriod("/admin/accounting/journal?source=PAYMENT")} className="text-[11px] underline text-muted-foreground">
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
                <p className="text-lg font-semibold text-red-600">{formatCurrency(summary.totalCashOut)}</p>
                {previousBucketDelta && showComparison && (
                  <p className={`text-[11px] ${previousBucketDelta.cashOut.delta <= 0 ? "text-emerald-700" : "text-red-600"}`}>
                    {formatDeltaLabel(previousBucketDelta.cashOut)}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">Refunds and reversals.</p>
              </div>
              <div className="border rounded-md p-2.5 sm:p-3 bg-muted/40 min-w-0">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Net cash</span>
                  <Tooltip content="Cash in minus cash out for the selected period.">
                    <HelpCircle className="h-3.5 w-3.5" />
                  </Tooltip>
                </div>
                <p className="text-lg font-semibold">{formatCurrency(summary.netCash)}</p>
                {previousBucketDelta && showComparison && (
                  <p className={`text-[11px] ${previousBucketDelta.netCash.delta >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                    {formatDeltaLabel(previousBucketDelta.netCash)}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">Cash in minus cash out.</p>
              </div>
            </div>
          </div>

          {/* Payroll detail */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 min-w-0">
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
              {groupBy === "month" && payrollMoM && (
                <p className="text-[11px] text-muted-foreground">
                  MoM:{" "}
                  {payrollMoM.percent === null
                    ? `${formatCurrency(payrollMoM.delta)} vs last month`
                    : `${payrollMoM.percent >= 0 ? "+" : ""}${payrollMoM.percent.toFixed(1)}% (${formatCurrency(payrollMoM.delta)})`}
                </p>
              )}
            </div>
          </div>

          {/* Operational context */}
          <div className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Operational context
            </div>
            <p className="text-xs text-muted-foreground">
              Live order, collection, outstanding, and fulfillment metrics used to explain workflow and AR status.
            </p>
          </div>

          {/* Period reconciliation */}
          <div className="border rounded-md p-3 bg-muted/30 min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Period sales reconciliation</span>
              <Tooltip content="Order-date basis: billed amount equals collected amount plus current outstanding on orders created in the selected period.">
                <HelpCircle className="h-3.5 w-3.5" />
              </Tooltip>
            </div>
            {anomalyChips.filter((c) => c.key === "high-outstanding" || c.key === "negative-net-cash").length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {anomalyChips.filter((c) => c.key === "high-outstanding" || c.key === "negative-net-cash").map((chip) => (
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
            <p className="mt-1 text-sm font-semibold break-words">
              {formatCurrency(summary.totalBilled)}{" "}
              <span className="sm:whitespace-nowrap">= {formatCurrency(summary.totalCollectedOnPeriodSales)}</span>{" "}
              <span className="sm:whitespace-nowrap">+ {formatCurrency(summary.totalOutstandingOnPeriodSales)}</span>
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">
              Billed order total (incl. tax) = Collected on period sales + Outstanding on period sales.
            </p>
            <p className="text-[11px] text-muted-foreground">
              Tax collected in period:{" "}
              <span className="font-medium text-foreground">{formatCurrency(summary.totalTaxCollected)}</span>
              {" · "}
              Discounts:{" "}
              <span className="font-medium text-foreground">{formatCurrency(summary.totalDiscounts)}</span>
            </p>
          </div>

          {/* Operational metrics (mobile-collapsible) */}
          <div className="flex sm:hidden">
            <Button size="sm" variant="outline" onClick={() => setShowMoreMetrics((v) => !v)}>
              {showMoreMetrics ? "Hide operational context" : "Show operational context"}
            </Button>
          </div>
          <div className={`${showMoreMetrics ? "grid" : "hidden"} gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-4 min-w-0`}>
            <div className="border rounded-md p-3 bg-muted/40 min-w-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Outstanding (period orders)</span>
                <Tooltip content="Order-date basis: as-of-now unpaid amount on orders created in the selected period.">
                  <HelpCircle className="h-3.5 w-3.5" />
                </Tooltip>
              </div>
              <p className="text-lg font-semibold text-amber-700">{formatCurrency(summary.totalOutstanding)}</p>
              {previousBucketDelta && showComparison && (
                <p className={`text-[11px] ${previousBucketDelta.outstanding.delta <= 0 ? "text-emerald-700" : "text-amber-700"}`}>
                  {formatDeltaLabel(previousBucketDelta.outstanding)}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">Current unpaid on orders from this period.</p>
              <Link href={appendActivePeriod("/admin/balances")} className="text-[11px] underline text-muted-foreground">
                View customer balances
              </Link>
            </div>
            <div className="border rounded-md p-3 bg-muted/40 min-w-0">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Orders</span>
                <Tooltip content="Number of orders created in the selected period.">
                  <HelpCircle className="h-3.5 w-3.5" />
                </Tooltip>
              </div>
              <p className="text-lg font-semibold tabular-nums">{summary.orderCount.toLocaleString()}</p>
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
              <p className="text-sm font-medium">Delivered: {summary.deliveredCount}</p>
              <p className="text-[11px] text-muted-foreground">
                Pending {summary.pendingCount} · Partial {summary.partiallyDeliveredCount} · Returned {summary.returnedCount}
              </p>
            </div>
          </div>

          {/* Top products + customers */}
          {((topProducts && topProducts.length > 0) || (topCustomers && topCustomers.length > 0)) && (
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
                    Filtered to the selected date range. Use this to check which items drive most sales.
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
                            {formatCurrency(c.ordersTotal)}
                          </span>
                        </div>
                        {c.creditAvailable > 0 && (
                          <span className="text-[11px] text-emerald-700">
                            Credit: {formatCurrency(c.creditAvailable)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Ranked by order value in the selected period. Use this when following up with key accounts.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── Charts ── */}
          <div className="grid gap-4 min-w-0">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  Sales Trend (Gross vs Net)
                  <Tooltip content="GL-posted gross sales vs net sales after refunds, plus a 7-period rolling average.">
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </Tooltip>
                </CardTitle>
              </CardHeader>
              <CardContent className="min-w-0">
                <div className="w-full overflow-x-hidden">
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="period" />
                      <YAxis tickFormatter={(value) => axisNumberFormatter.format(Number(value || 0))} />
                      <RechartsTooltip
                        formatter={(value: number) => formatCurrency(Number(value))}
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
                </div>
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
                      Payroll MoM:{" "}
                      {payrollMoM.percent === null
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
                <div className="w-full overflow-x-hidden">
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={chartData}>
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
                </div>
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
                <div className="w-full overflow-x-hidden">
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={chartData}>
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
                </div>
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  Orders &amp; AOV
                  <Tooltip content="Order count and average order value (AOV) per period. Sourced from GL-posted entries.">
                    <HelpCircle className="h-4 w-4 text-muted-foreground" />
                  </Tooltip>
                </CardTitle>
              </CardHeader>
              <CardContent className="min-w-0">
                <div className="w-full overflow-x-hidden">
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="period" />
                      <YAxis yAxisId="left" tickFormatter={(value) => axisNumberFormatter.format(Number(value || 0))} />
                      <YAxis yAxisId="right" orientation="right" tickFormatter={(value) => axisNumberFormatter.format(Number(value || 0))} />
                      <RechartsTooltip
                        formatter={(value: number, name) => {
                          if (name === "averageOrderValue") return formatCurrency(Number(value));
                          return Number(value || 0).toLocaleString();
                        }}
                        labelFormatter={(label) => `Period: ${label}`}
                      />
                      <Legend />
                      <Bar yAxisId="left" dataKey="orderCount" fill="#8b5cf6" name="Orders" />
                      <Line yAxisId="right" type="monotone" dataKey="averageOrderValue" stroke="#f59e0b" name="AOV" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
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
                <div className="w-full overflow-x-hidden">
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="period" />
                      <YAxis yAxisId="left" tickFormatter={(value) => `${axisNumberFormatter.format(Number(value || 0))}%`} />
                      <YAxis yAxisId="right" orientation="right" tickFormatter={(value) => axisNumberFormatter.format(Number(value || 0))} />
                      <RechartsTooltip
                        formatter={(value: number, name) => {
                          if (name === "margin") return `${Number(value || 0).toFixed(2)}%`;
                          return formatCurrency(Number(value || 0));
                        }}
                        labelFormatter={(label) => `Period: ${label}`}
                      />
                      <Legend />
                      <Line yAxisId="left" type="monotone" dataKey="margin" stroke="#0f766e" name="Margin %" />
                      <Line yAxisId="right" type="monotone" dataKey="profit" stroke="#2563eb" name="Net profit" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
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
