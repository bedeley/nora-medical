"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

type TrendRow = { date: string; revenue: number; cogs: number; expense: number; profit: number; margin: number };
type SummaryPayload = {
  summary?: {
    totalRevenue: number;
    totalCOGS: number;
    totalExpense: number;
    profit: number;
    margin: number;
    totalDiscounts?: number;
    discountedOrders?: number;
  };
  trend?: TrendRow[];
  groupBy?: string;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function ProfitLossContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);

  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month" | "year">("day");
  const [customer, setCustomer] = useState<string>("");
  const [category, setCategory] = useState<string>("");
  const [excludeZero, setExcludeZero] = useState(true);
  const [sparkWindow, setSparkWindow] = useState<30 | 90>(30);
  const [updatedAtText, setUpdatedAtText] = useState<string>("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data: reportingMode } = useClientQuery<{ value: boolean | null }>({
    queryKey: ["accounting", "reporting", "use-ledger"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.reporting.useLedger").then((r) => r.json()),
  });
  const useLedger = Boolean(reportingMode?.value);

  // Initialize from URL once
  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams?.toString() || "");
    const s0 = sp.get("start") || "";
    const e0 = sp.get("end") || "";
    const g0 = (sp.get("groupBy") as "day" | "week" | "month" | "year" | null) || "day";
    const c0 = sp.get("customer") || "";
    const cat0 = sp.get("category") || "";
    const p0 = Number(sp.get("page") || 1);
    const ps0 = Number(sp.get("pageSize") || 25);
    if (s0) setStart(s0);
    if (e0) setEnd(e0);
    if (["day", "week", "month", "year"].includes(g0)) setGroupBy(g0);
    if (c0) setCustomer(c0);
    if (cat0) setCategory(cat0);
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
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [start, end, groupBy, customer, category, page, pageSize, pathname, router]);

  // Build API URL
  const apiUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    if (groupBy) p.set("groupBy", groupBy);
    if (customer) p.set("customer", customer);
    if (category) p.set("category", category);
    return useLedger
      ? `/api/admin/accounting/reports/ledger-summary?${p.toString()}`
      : `/api/admin/summary?${p.toString()}`;
  }, [start, end, groupBy, customer, category, useLedger]);

  const { data, error, isLoading } = useClientQuery<SummaryPayload>({
    queryKey: ["admin","summary", { start, end, groupBy, customer, category }],
    queryFn: () => fetcher(apiUrl),
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  async function exportFile(kind: "csv" | "pdf") {
    if (useLedger) {
      toast.error("Export is available from Accounting reports in ledger mode.");
      return;
    }
    const p = new URLSearchParams();
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    p.set("groupBy", groupBy);
    if (customer) p.set("customer", customer);
    if (category) p.set("category", category);
    p.set("format", kind);
    const res = await fetch(`/api/admin/summary?${p.toString()}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = kind === "csv" ? `pl_${Date.now()}.csv` : `pl_${Date.now()}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  const summary = data?.summary;
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
    setPage(1);
  }, [start, end, groupBy, customer, category, excludeZero]);

  const totalPages = Math.max(1, Math.ceil(filteredTrend.length / pageSize));
  const paginatedTrend = useMemo(() => {
    const startIdx = (page - 1) * pageSize;
    return filteredTrend.slice(startIdx, startIdx + pageSize);
  }, [filteredTrend, page, pageSize]);

  useEffect(() => {
    if (trend.length === 0) return;
    setUpdatedAtText(new Date().toLocaleString());
  }, [trend.length]);

  const grossProfit = summary ? summary.totalRevenue - summary.totalCOGS : null;
  const totalDiscounts = Number(summary?.totalDiscounts || 0);
  const discountedOrders = Number(summary?.discountedOrders || 0);
  const netSalesAfterDiscounts = summary ? Math.max(0, summary.totalRevenue - totalDiscounts) : null;
  const grossMargin = summary && summary.totalRevenue > 0
    ? (grossProfit! / summary.totalRevenue) * 100
    : null;
  const operatingMargin = summary && summary.totalRevenue > 0
    ? (summary.profit / summary.totalRevenue) * 100
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
    const currentCogs = sum(currSlice, (item) => item.cogs);
    const previousCogs = sum(prevSlice, (item) => item.cogs);
    const currentExpense = sum(currSlice, (item) => item.expense);
    const previousExpense = sum(prevSlice, (item) => item.expense);
    const currentProfit = sum(currSlice, (item) => item.profit);
    const previousProfit = sum(prevSlice, (item) => item.profit);
    const currentGrossProfit = currentRevenue - currentCogs;
    const previousGrossProfit = previousRevenue - previousCogs;
    const currentGrossMargin = currentRevenue > 0 ? (currentGrossProfit / currentRevenue) * 100 : null;
    const previousGrossMargin = previousRevenue > 0 ? (previousGrossProfit / previousRevenue) * 100 : null;
    const currentOperatingMargin = currentRevenue > 0 ? (currentProfit / currentRevenue) * 100 : null;
    const previousOperatingMargin = previousRevenue > 0 ? (previousProfit / previousRevenue) * 100 : null;
    return {
      size,
      currentRevenue,
      previousRevenue,
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
  const formatPeriodLabel = (value: string) => {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString(undefined, {
      month: "short",
      day: "2-digit",
      weekday: "short",
    });
  };
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
            Operational view. For official financials, use Accounting → Reports.
          </p>
          {useLedger ? (
            <p className="text-xs text-muted-foreground">
              Ledger mode enabled: this report uses journal entries.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/admin/profit-loss/products">View Product Performance</Link>
          </Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => exportFile("csv")}>Export CSV</Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => exportFile("pdf")}>Export PDF</Button>
        </div>
      </div>

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
            <select
              id="group"
              className="border rounded-md h-9 w-full bg-background"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as "day" | "week" | "month" | "year")}
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
            </select>
          </div>
          <div>
            <label htmlFor="customer" className="text-sm">Customer</label>
            <Input
              id="customer"
              placeholder="Name contains..."
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              title="Filters P&L to orders for customers whose name matches this value."
            />
          </div>
          <div>
            <label htmlFor="category" className="text-sm">Expense Category</label>
            <Input
              id="category"
              placeholder="Expense category contains..."
              value={category}
              onChange={(e) => setCategory(e.target.value)}
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
            {isLoading ? "Loading..." : `${filteredTrend.length} period(s)`}
          </div>
          <div
            className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-7"
            title="Coverage includes non-cancelled orders (accrual revenue/COGS), discounts, expenses by category, and refunds from payments. The timestamp shows when the data was last refreshed."
          >
            Coverage: Non-cancelled orders (accrual revenue/COGS), discounts, expenses by category, and refunds from payments.
            {updatedAtText ? ` · Last refreshed ${updatedAtText}` : ""}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Totals</CardTitle>
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
            value={summary ? formatCurrency(totalDiscounts) : "-"}
            accent={summary ? "text-amber-700" : ""}
            tooltip="Contra-revenue discounts applied in the selected period."
            subtext={`${discountedOrders} discounted order${discountedOrders === 1 ? "" : "s"}`}
          />
          <Stat
            label="Net Sales (after discounts)"
            value={netSalesAfterDiscounts != null ? formatCurrency(netSalesAfterDiscounts) : "-"}
            tooltip="Revenue minus discounts (before refunds)."
          />
          <Stat
            label="Gross Profit"
            value={grossProfit != null ? formatCurrency(grossProfit) : "-"}
            accent={grossProfit != null ? (grossProfit >= 0 ? "text-green-600" : "text-red-600") : ""}
            trend={sparkSlice(filteredTrend.map((t) => t.revenue - t.cogs))}
            tooltip="Gross Profit = Revenue − COGS."
            delta={formatDelta(rollingWindow?.currentGrossProfit ?? null, rollingWindow?.previousGrossProfit ?? null)}
            deltaLabel={deltaLabel}
            deltaTitle={deltaTitle}
          />
          <Stat
            label="COGS"
            value={summary ? formatCurrency(summary.totalCOGS) : "-"}
            accent="text-amber-600"
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
            tooltip="Net Profit = Revenue − COGS − Expenses."
            delta={formatDelta(rollingWindow?.currentProfit ?? null, rollingWindow?.previousProfit ?? null)}
            deltaLabel={deltaLabel}
            deltaTitle={deltaTitle}
          />
          <Stat
            label="Gross Margin"
            value={grossMargin != null ? `${grossMargin.toFixed(2)}%` : "-"}
            accent={
              grossMargin != null ? (grossMargin >= 0 ? "text-green-600" : "text-red-600") : ""
            }
            trend={sparkSlice(filteredTrend.map((t) => t.revenue > 0 ? ((t.revenue - t.cogs) / t.revenue) * 100 : 0))}
            tooltip="Gross Margin = (Revenue − COGS) ÷ Revenue."
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
            trend={sparkSlice(filteredTrend.map((t) => t.revenue > 0 ? (t.profit / t.revenue) * 100 : 0))}
            tooltip="Operating Margin = Net Profit ÷ Revenue."
            delta={formatDelta(rollingWindow?.currentOperatingMargin ?? null, rollingWindow?.previousOperatingMargin ?? null)}
            deltaLabel={deltaLabel}
            deltaTitle={deltaTitle}
          />
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
              const grossProfit = Number(t.revenue || 0) - Number(t.cogs || 0);
              const grossMargin = Number(t.revenue || 0) > 0 ? (grossProfit / Number(t.revenue || 0)) * 100 : 0;
              return (
                <div key={t.date} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Period</span>
                    <span className="font-medium">{t.date}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <div>
                      <div>Revenue</div>
                      <div className="text-foreground">{formatCurrency(t.revenue)}</div>
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
                    <TableCell colSpan={8} className="text-center py-6 text-red-600">Failed to load P&L</TableCell>
                  </TableRow>
                )}
                {!error && isLoading && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-6 text-muted-foreground">Loading...</TableCell>
                  </TableRow>
                )}
                {!error && !isLoading && filteredTrend.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-6">
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
                  const grossProfit = Number(t.revenue || 0) - Number(t.cogs || 0);
                  const grossMargin = Number(t.revenue || 0) > 0 ? (grossProfit / Number(t.revenue || 0)) * 100 : 0;
                  return (
                    <TableRow
                      key={t.date}
                      className="odd:bg-background even:bg-muted/40 hover:bg-accent/60"
                    >
                      <TableCell>{t.date}</TableCell>
                      <TableCell className="text-right">{formatCurrency(t.revenue)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(t.cogs ?? 0)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(grossProfit)}</TableCell>
                      <TableCell className="text-right">{grossMargin.toFixed(2)}%</TableCell>
                      <TableCell className="text-right">{formatCurrency(t.expense)}</TableCell>
                      <TableCell className={`text-right ${t.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(t.profit)}</TableCell>
                      <TableCell className="text-right">{t.margin.toFixed(2)}%</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {filteredTrend.length > 0 && (
            <div className="flex flex-col gap-3 border-t px-4 py-3 text-sm lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Rows per page</span>
                <select
                  className="border rounded-md h-8 bg-background px-2"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(parseInt(e.target.value, 10));
                    setPage(1);
                  }}
                >
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
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
  return (
    <div className="p-3 rounded-md bg-background shadow-sm" title={tooltip}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${accent ?? ""}`}>{value}</div>
      {subtext ? <div className="text-[11px] text-muted-foreground">{subtext}</div> : null}
      {delta ? (
        <div
          className={`text-xs ${delta.startsWith("-") ? "text-red-600" : "text-green-600"}`}
          title={deltaTitle}
        >
          {delta} {deltaLabel ?? "vs prior window"}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground" title={deltaTitle}>
          {deltaLabel ?? "vs prior window"}
        </div>
      )}
      {points ? (
        <svg viewBox="0 0 120 24" className="mt-2 h-6 w-full text-muted-foreground">
          <polyline
            fill="none"
            stroke="currentColor"
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

