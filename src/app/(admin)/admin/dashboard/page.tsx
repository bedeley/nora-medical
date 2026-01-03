"use client";

export const dynamic = "force-dynamic";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
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
import { format, startOfDay, endOfDay, subDays, startOfMonth, endOfMonth, startOfYear, endOfYear } from "date-fns";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Download, Filter, Table, RefreshCcw, HelpCircle } from "lucide-react";
import AddExpenseDialog from "@/app/(admin)/dashboard/components/AddExpenseDialog";
import ProfitSummary from "@/app/(admin)/dashboard/components/ProfitSummary";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
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
  profit: number;
  margin: number;
  cogs?: number;
  cashIn?: number;
  cashOut?: number;
  netCash?: number;
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
    deliveredCount: 0,
    partiallyDeliveredCount: 0,
    returnedCount: 0,
    pendingCount: 0,
    expenseBreakdown: [],
  });
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month" | "year">("day");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [rawData, setRawData] = useState<RawReportRow[]>([]);
  const [rawLoading, setRawLoading] = useState(false);

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
      if (!res.ok) throw new Error("Failed to fetch chart data");

      const data: SummaryResponse = await res.json();
      const trendRows: TrendApiRow[] = Array.isArray(data.trend) ? data.trend : [];
      const normalizedTrend: TrendRow[] = trendRows.map((row) => ({
        ...row,
        period: row.period || row.date,
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
      setChartData(withRolling);
      setSummary({
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
        deliveredCount: Number(summaryPayload.deliveredCount || 0),
        partiallyDeliveredCount: Number(summaryPayload.partiallyDeliveredCount || 0),
        returnedCount: Number(summaryPayload.returnedCount || 0),
        pendingCount: Number(summaryPayload.pendingCount || 0),
        expenseBreakdown: summaryPayload.expenseBreakdown || [],
      });
    } catch (err) {
      console.error(err);
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
      link.href = URL.createObjectURL(blob);
      link.download = `nora_dashboard_${groupBy}_${Date.now()}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();

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
      if (!res.ok) throw new Error("Failed to generate PDF");

      const blob = await res.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `nora_revenue_${groupBy}_${Date.now()}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success("PDF downloaded successfully!");
    } catch (err) {
      console.error(err);
      toast.error("Error generating PDF");
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
      <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Track revenue, expenses, and cash flow at a glance.
          </p>
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

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4 min-w-0">
          <div className="border rounded-md p-3 bg-muted/40 min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Gross sales</span>
              <Tooltip content="Total sales from orders before refunds, COGS, and expenses.">
                <HelpCircle className="h-3.5 w-3.5" />
              </Tooltip>
            </div>
            <p className="text-lg font-semibold">{formatCurrency(summary.totalRevenue)}</p>
            <p className="text-[11px] text-muted-foreground">Before refunds and expenses.</p>
          </div>
          <div className="border rounded-md p-3 bg-muted/40 min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Net sales</span>
              <Tooltip content="Gross sales minus refunds for the selected period.">
                <HelpCircle className="h-3.5 w-3.5" />
              </Tooltip>
            </div>
            <p className="text-lg font-semibold">{formatCurrency(summary.netRevenue)}</p>
            <p className="text-[11px] text-muted-foreground">After refunds.</p>
          </div>
          <div className="border rounded-md p-3 bg-muted/40 min-w-0">
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
          <div className="border rounded-md p-3 bg-muted/40 min-w-0">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Cash in</span>
              <Tooltip content="Payments received (excluding refunds/voids).">
                <HelpCircle className="h-3.5 w-3.5" />
              </Tooltip>
            </div>
            <p className="text-lg font-semibold text-emerald-700">
              {formatCurrency(summary.totalCashIn)}
            </p>
            <p className="text-[11px] text-muted-foreground">Payments received.</p>
          </div>
          <div className="border rounded-md p-3 bg-muted/40 min-w-0">
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
          <div className="border rounded-md p-3 bg-muted/40 min-w-0">
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

        {/* At-a-glance insights: top products & customers */}
        {(topProducts && topProducts.length > 0) || (topCustomers && topCustomers.length > 0) ? (
          <div className="grid gap-3 md:grid-cols-2 min-w-0">
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
                <LineChart data={chartData}>
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
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                Expense Trend
                <Tooltip content="Operating expenses grouped by the selected period. Use this to spot spikes.">
                  <HelpCircle className="h-4 w-4 text-muted-foreground" />
                </Tooltip>
              </CardTitle>
            </CardHeader>
            <CardContent className="min-w-0">
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
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={chartData}>
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
                <ComposedChart data={chartData}>
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
