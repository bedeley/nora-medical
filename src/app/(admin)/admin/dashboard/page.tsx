"use client";

export const dynamic = "force-dynamic";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
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
import { Download, Filter, Table, RefreshCcw } from "lucide-react";
import AddExpenseDialog from "@/app/(admin)/dashboard/components/AddExpenseDialog";
import ProfitSummary from "@/app/(admin)/dashboard/components/ProfitSummary";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip as RechartsTooltip,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import { useQuery } from "@tanstack/react-query";

type DashboardSummary = {
  totalRevenue: number;
  totalCOGS: number;
  totalExpense: number;
  profit: number;
  margin: number;
  expenseBreakdown: { category: string; amount: number }[];
};

type TrendRow = {
  date: string;
  period: string;
  revenue: number;
  expense: number;
  profit: number;
  margin: number;
  cogs?: number;
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
    totalCOGS: 0,
    totalExpense: 0,
    profit: 0,
    margin: 0,
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
      const summaryPayload = data.summary || {};
      setChartData(normalizedTrend);
      setSummary({
        totalRevenue: Number(summaryPayload.totalRevenue || 0),
        totalCOGS: Number(summaryPayload.totalCOGS || 0),
        totalExpense: Number(summaryPayload.totalExpense || 0),
        profit: Number(summaryPayload.profit || 0),
        margin: Number(summaryPayload.margin ?? 0),
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
    <Card className="shadow-md !border-none">
      <CardHeader className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div className="w-full">
          <CardTitle>Sales & Expense Overview</CardTitle>
          <p className="text-sm text-muted-foreground">
            Trends, summaries, and quick export tools
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
          <AddExpenseDialog onAdded={() => fetchChartData()} />
          <Button variant="outline" size="sm" onClick={fetchChartData}>
            <RefreshCcw className="w-4 h-4 mr-1" /> Refresh
          </Button>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                onClick={() => loadRawData()}
              >
                <Table className="w-4 h-4 mr-2" /> View Raw Data
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-5xl max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Raw Data Records</DialogTitle>
              </DialogHeader>
          {rawLoading ? (
                <p className="text-center py-8">Loading records...</p>
              ) : rawData.length === 0 ? (
                <p className="text-center py-8 text-muted-foreground">
                  No records found.
                </p>
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
          >
            <Download className="w-4 h-4 mr-2" />
            {loading ? "Generating..." : "Download CSV"}
          </Button>

          <Button onClick={handleDownloadPDF} size="sm" variant="outline">
            <Download className="w-4 h-4 mr-2" />
            Download PDF
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFilters({ start: "", end: "", customer: "", category: "" });
              setRange(undefined);
              setGroupBy("day");
            }}
            title="Clear all filters"
          >
            Reset Filters
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
            title="Copy current filtered URL"
          >
            Copy Link
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

      <CardContent className="grid gap-4">
        {/* Summary snapshot (revenue, COGS, expenses, profit, margin) */}
        <ProfitSummary summary={summary} />

        {/* At-a-glance insights: top products & customers */}
        {(topProducts && topProducts.length > 0) || (topCustomers && topCustomers.length > 0) ? (
          <div className="grid gap-3 md:grid-cols-2">
            {topProducts && topProducts.length > 0 && (
              <div className="border rounded-md p-3 bg-muted/40">
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
              <div className="border rounded-md p-3 bg-muted/40">
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

        <div className="flex gap-2">
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
        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Expense Trend</CardTitle>
            </CardHeader>
            <CardContent>
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
                  <Bar dataKey="expense" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Revenue Trend</CardTitle>
            </CardHeader>
            <CardContent>
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
                  <Line type="monotone" dataKey="revenue" stroke="#3b82f6" />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>

      </CardContent>
    </Card>
  );
}

export default function AdminDashboardPage() {
  return (
    <Suspense
      fallback={
        <section className="space-y-4">
          <h1 className="text-2xl font-semibold">Sales &amp; Expense Overview</h1>
          <p className="text-sm text-muted-foreground">Loading dashboard…</p>
        </section>
      }
    >
      <AdminDashboardContent />
    </Suspense>
  );
}
