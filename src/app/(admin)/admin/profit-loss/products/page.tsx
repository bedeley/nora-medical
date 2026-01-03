"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { formatCurrency } from "@/lib/currency";
import Link from "next/link";

type Row = {
  productId: string;
  name: string;
  qty: number;
  revenue: number;
  costTotal: number;
  weightedCost: number; // per unit
  profit: number;
  margin: number;
  rank: number;
};

type Payload = {
  range: string;
  start: string | null;
  end: string | null;
  total: number;
  page: number;
  pageSize: number;
  rows: Row[];
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function ProductPLContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);

  const [mode, setMode] = useState<"day" | "week" | "month" | "year" | "all" | "custom">("month");
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [q, setQ] = useState<string>("");
  const [qInput, setQInput] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [sortMetric, setSortMetric] = useState<"profit" | "revenue" | "qty" | "margin">("profit");
  const [mounted, setMounted] = useState(false);
  const [lossOnly, setLossOnly] = useState(false);
  const [showWeightedCost, setShowWeightedCost] = useState(true);
  const [showWeightedPrice, setShowWeightedPrice] = useState(true);
  const [showTotalCost, setShowTotalCost] = useState(true);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Initialize from URL once
  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams?.toString() || "");
    const spMode = sp.get("mode");
    let m0 = (spMode as "day" | "week" | "month" | "year" | "all" | "custom" | null) || "month";
    const s0 = sp.get("start") || "";
    const e0 = sp.get("end") || "";
    const o0 = (sp.get("order") as "asc" | "desc" | null) || "desc";
    const q0 = sp.get("q") || "";
    const sort0 = (sp.get("sort") as "profit" | "revenue" | "qty" | "margin" | null) || "profit";
    const p0 = parseInt(sp.get("page") || "1", 10) || 1;
    const ps0 = parseInt(sp.get("pageSize") || "25", 10) || 25;
    if (!spMode && typeof window !== "undefined") {
      const storedMode = window.localStorage.getItem("productPlMode");
      if (storedMode && ["day", "week", "month", "year", "all", "custom"].includes(storedMode)) {
        m0 = storedMode as typeof m0;
      }
    }
    if (["day", "week", "month", "year", "all", "custom"].includes(m0)) setMode(m0);
    if (m0 === "custom") {
      if (s0) setStart(s0);
      if (e0) setEnd(e0);
      if (!spMode && typeof window !== "undefined") {
        const storedStart = window.localStorage.getItem("productPlStart");
        const storedEnd = window.localStorage.getItem("productPlEnd");
        if (storedStart) setStart(storedStart);
        if (storedEnd) setEnd(storedEnd);
      }
    }
    if (["asc", "desc"].includes(o0)) setOrder(o0);
    if (["profit", "revenue", "qty", "margin"].includes(sort0)) setSortMetric(sort0);
    setQ(q0);
    setQInput(q0);
    setPage(Math.max(1, p0));
    setPageSize(Math.max(1, Math.min(200, ps0)));
    initialized.current = true;
  }, [searchParams]);

  useEffect(() => {
    if (!mounted || typeof window === "undefined") return;
    window.localStorage.setItem("productPlMode", mode);
    if (mode === "custom") {
      if (start) window.localStorage.setItem("productPlStart", start);
      if (end) window.localStorage.setItem("productPlEnd", end);
    } else {
      window.localStorage.removeItem("productPlStart");
      window.localStorage.removeItem("productPlEnd");
    }
  }, [mounted, mode, start, end]);

  // Reflect current filters to URL without causing a navigation loop
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams(searchParams?.toString() || "");
    if (mode) params.set("mode", mode); else params.delete("mode");
    if (mode === "custom") {
      if (start) params.set("start", start); else params.delete("start");
      if (end) params.set("end", end); else params.delete("end");
    } else {
      params.delete("start");
      params.delete("end");
    }
    params.set("order", order);
    params.set("sort", sortMetric);
    if (q) params.set("q", q); else params.delete("q");
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    const current = `${pathname}?${searchParams?.toString() || ""}`.replace(/\?$/, "");
    if (next !== current) {
      router.replace(next, { scroll: false });
    }
  }, [mode, start, end, order, sortMetric, q, page, pageSize, pathname, router, searchParams]);

  // Debounce search input (~2s) -> q used for API/URL
  useEffect(() => {
    const id = setTimeout(() => {
      setQ(qInput);
    }, 2000);
    return () => clearTimeout(id);
  }, [qInput]);

  function clearFilters() {
    setMode("month");
    setStart("");
    setEnd("");
    setOrder("desc");
    setSortMetric("profit");
    setQ("");
    setQInput("");
    setPage(1);
    setPageSize(25);
  }

  // Keyboard Shortcut: Alt + Left Arrow to go back to main P&L
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "ArrowLeft" || e.code === "ArrowLeft")) {
        e.preventDefault();
        router.push("/admin/profit-loss");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const apiUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (mode !== "custom") p.set("range", mode);
    if (mode === "custom") {
      if (start) p.set("start", start);
      if (end) p.set("end", end);
    }
    p.set("order", order);
    p.set("sort", sortMetric);
    if (q) p.set("q", q);
    p.set("page", String(page));
    p.set("pageSize", String(pageSize));
    return `/api/admin/product-pl?${p.toString()}`;
  }, [mode, start, end, order, sortMetric, q, page, pageSize]);

  const { data, error, isLoading } = useClientQuery<Payload>({
    queryKey: ["admin", "product-pl", { mode, start, end, order, sort: sortMetric, q, page, pageSize }],
    queryFn: () => fetcher(apiUrl),
    // Data only needs to refresh when filters change, not on a timer.
    refetchInterval: false,
  });
  const filteredRows = useMemo(() => {
    if (!data?.rows) return [];
    if (!lossOnly) return data.rows;
    return data.rows.filter((row) => row.profit < 0);
  }, [data?.rows, lossOnly]);
  const summary = useMemo(() => {
    if (!filteredRows.length) return null;
    const totals = filteredRows.reduce(
      (acc, row) => {
        acc.qty += row.qty;
        acc.revenue += row.revenue;
        acc.costTotal += row.costTotal;
        acc.profit += row.profit;
        return acc;
      },
      { qty: 0, revenue: 0, costTotal: 0, profit: 0 }
    );
    const margin = totals.revenue > 0 ? (totals.profit / totals.revenue) * 100 : 0;
    return { ...totals, margin };
  }, [filteredRows]);
  const tableColSpan = 7
    + (showWeightedCost ? 1 : 0)
    + (showWeightedPrice ? 1 : 0)
    + (showTotalCost ? 1 : 0);

  async function exportFile(kind: "csv" | "pdf") {
    const p = new URLSearchParams();
    if (mode !== "custom") p.set("range", mode);
    if (mode === "custom") {
      if (start) p.set("start", start);
      if (end) p.set("end", end);
    }
    p.set("order", order);
    p.set("sort", sortMetric);
    p.set("format", kind);
    const res = await fetch(`/api/admin/product-pl?${p.toString()}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = kind === "csv" ? `product_pl_${Date.now()}.csv` : `product_pl_${Date.now()}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function resetToToday() {
    setMode("day");
    setStart("");
    setEnd("");
    setPage(1);
  }

  function resetToThisWeek() {
    setMode("week");
    setStart("");
    setEnd("");
    setPage(1);
  }

  return (
    <section className="container mx-auto py-8 space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground flex flex-wrap items-center gap-1">
        <Link href="/admin/profit-loss" className="hover:underline whitespace-nowrap">Profit &amp; Loss</Link>
        <span className="mx-1">/</span>
        <span className="text-foreground whitespace-nowrap">Products</span>
      </nav>
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
              <Link href="/admin/profit-loss">Back</Link>
            </Button>
            <span className="hidden sm:inline text-xs text-muted-foreground">Shortcut: Alt + Left Arrow</span>
          </div>
          <h1 className="text-2xl font-semibold mt-2">Product Performance (P&amp;L)</h1>
          <p className="text-sm text-muted-foreground">
            Rank products by profit, margin, and revenue.
          </p>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Button variant="outline" className="w-full sm:w-auto" onClick={resetToThisWeek}>This Week</Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={resetToToday}>Today</Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={clearFilters}>Clear Filters</Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => exportFile("csv")}>Export CSV</Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => exportFile("pdf")}>Export PDF</Button>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between py-3">
          <CardTitle className="text-base font-semibold">Filters</CardTitle>
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center w-full">
            <div className="w-full sm:w-auto">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full sm:w-auto">Columns</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuCheckboxItem
                    checked={showWeightedCost}
                    onCheckedChange={(value) => setShowWeightedCost(Boolean(value))}
                  >
                    Weighted Cost (per item)
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={showWeightedPrice}
                    onCheckedChange={(value) => setShowWeightedPrice(Boolean(value))}
                  >
                    Weighted Sold Price (per item)
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={showTotalCost}
                    onCheckedChange={(value) => setShowTotalCost(Boolean(value))}
                  >
                    Total Weighted Cost
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="w-full sm:w-auto">
              <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => { setPageSize(10); setSortMetric("profit"); setOrder("desc"); setPage(1); }}>
                Top 10
              </Button>
            </div>
            <div className="w-full sm:w-auto">
              <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => { setPageSize(25); setSortMetric("profit"); setOrder("desc"); setPage(1); }}>
                Top 25
              </Button>
            </div>
            <div className="w-full sm:w-auto">
              <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => { setPageSize(50); setSortMetric("profit"); setOrder("desc"); setPage(1); }}>
                Top 50
              </Button>
            </div>
            <label className="flex w-full items-center gap-2 text-sm border rounded-md px-2 py-1 sm:w-auto">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={lossOnly}
                onChange={(e) => { setLossOnly(e.target.checked); setPage(1); }}
              />
              <span>Loss-makers only</span>
            </label>
          </div>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 md:grid-cols-6 gap-3 items-end">
          <div className="md:col-span-2">
            <label htmlFor="search" className="text-sm">Search products</label>
            <Input
              id="search"
              placeholder="Type name…"
              value={qInput}
              onChange={(e) => { setQInput(e.target.value); setPage(1); }}
            />
          </div>
          <div>
            <label htmlFor="mode" className="text-sm">Range</label>
            <select
              id="mode"
              className="border rounded-md h-9 w-full bg-background"
              value={mode}
              onChange={(e) => {
                const nextMode = e.target.value as "day" | "week" | "month" | "year" | "all" | "custom";
                setMode(nextMode);
                if (nextMode !== "custom") {
                  setStart("");
                  setEnd("");
                }
                setPage(1);
              }}
            >
              <option value="day">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="year">Last 12 months</option>
              <option value="all">All time</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div>
            <label htmlFor="start" className="text-sm">Start</label>
            <Input id="start" type="date" value={start} onChange={(e) => { setStart(e.target.value); setPage(1); }} disabled={mode !== "custom"} />
          </div>
          <div>
            <label htmlFor="end" className="text-sm">End</label>
            <Input id="end" type="date" value={end} onChange={(e) => { setEnd(e.target.value); setPage(1); }} disabled={mode !== "custom"} />
          </div>
            <div className="min-w-0">
              <label className="text-sm">Sort</label>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <select
                className="border rounded-md h-9 bg-background px-2 w-full sm:w-auto max-w-full"
                value={sortMetric}
                onChange={(e) => {
                  setSortMetric(e.target.value as "profit" | "revenue" | "qty" | "margin");
                  setPage(1);
                }}
              >
                <option value="profit">Profit</option>
                <option value="revenue">Revenue</option>
                <option value="qty">Quantity Sold</option>
                <option value="margin">Margin %</option>
              </select>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOrder(order === "desc" ? "asc" : "desc")}
                className="w-full sm:w-auto max-w-full whitespace-normal text-center"
              >
                {order === "desc" ? "Best → Worst" : "Worst → Best"}
              </Button>
            </div>
          </div>
          <div>
            <label htmlFor="rows" className="text-sm">Rows</label>
            <select
              id="rows"
              className="border rounded-md h-9 w-full bg-background"
              value={pageSize}
              onChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(1); }}
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
          <div className="text-sm text-muted-foreground md:col-span-1">
            {!mounted
              ? "\u00A0"
              : isLoading
                ? "Loading..."
                : `${filteredRows.length} of ${data?.total ?? 0} product(s)`}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Products shown</div>
            <div className="text-lg font-semibold">{filteredRows.length}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Total qty sold</div>
            <div className="text-lg font-semibold">{summary ? summary.qty : "-"}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Total revenue</div>
            <div className="text-lg font-semibold">{summary ? formatCurrency(summary.revenue) : "-"}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Total profit</div>
            <div className={`text-lg font-semibold ${summary && summary.profit >= 0 ? "text-green-600" : "text-red-600"}`}>
              {summary ? formatCurrency(summary.profit) : "-"}
            </div>
            <div className="text-xs text-muted-foreground">
              Avg margin {summary ? `${summary.margin.toFixed(1)}%` : "—"}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-semibold">Performance Details</CardTitle>
          <div className="text-sm text-muted-foreground">
            Showing {filteredRows.length} of {data?.total ?? 0} products
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="md:hidden px-4 pb-4 pt-2 space-y-3">
            {filteredRows.map((r) => {
              const weightedSoldPrice = r.qty > 0 ? r.revenue / r.qty : 0;
              return (
                <div key={r.productId} className="rounded-md border p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold truncate">{r.name}</div>
                      <div className="text-xs text-muted-foreground">Rank #{r.rank}</div>
                    </div>
                    <Link
                      className="text-xs text-primary hover:underline"
                      href={`/admin/inventory?q=${encodeURIComponent(r.name)}`}
                    >
                      View
                    </Link>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <div>
                      <div>Qty Sold</div>
                      <div className="text-foreground">{r.qty}</div>
                    </div>
                    <div>
                      <div>Revenue</div>
                      <div className="text-foreground">{formatCurrency(r.revenue)}</div>
                    </div>
                    <div>
                      <div>Margin %</div>
                      <div className="text-foreground">
                        {Number.isFinite(r.margin) ? `${r.margin.toFixed(1)}%` : "—"}
                      </div>
                    </div>
                    <div>
                      <div>Profit / Loss</div>
                      <div className={`font-medium ${r.profit >= 0 ? "text-green-600" : "text-red-600"}`}>
                        {formatCurrency(r.profit)}
                      </div>
                    </div>
                    {showWeightedCost && (
                      <div>
                        <div>Weighted Cost</div>
                        <div className="text-foreground">{formatCurrency(r.weightedCost)}</div>
                      </div>
                    )}
                    {showWeightedPrice && (
                      <div>
                        <div>Weighted Sold Price</div>
                        <div className="text-foreground">{formatCurrency(weightedSoldPrice)}</div>
                      </div>
                    )}
                    {showTotalCost && (
                      <div>
                        <div>Total Weighted Cost</div>
                        <div className="text-foreground">{formatCurrency(r.costTotal)}</div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {Boolean(error) && (
              <div className="rounded-md border p-4 text-center text-sm text-red-600">
                Failed to load product P&amp;L
              </div>
            )}
            {!error && mounted && isLoading && (
              <div className="rounded-md border p-4 text-center text-sm text-muted-foreground">
                Loading...
              </div>
            )}
            {!error && mounted && !isLoading && filteredRows.length === 0 && (
              <div className="rounded-md border p-4 text-center text-sm text-muted-foreground">
                <p>No data for the current filters.</p>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  <Link
                    href="/admin/profit-loss/products"
                    className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                  >
                    Reset filters
                  </Link>
                  <Link
                    href="/admin/products"
                    className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                  >
                    View products
                  </Link>
                </div>
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <Table className="hidden md:table">
              <TableHeader className="sticky top-0 z-10 bg-background shadow-sm">
                <TableRow>
                  <TableHead className="w-20 text-center">Rank</TableHead>
                  <TableHead className="text-center">Product</TableHead>
                  <TableHead className="text-center">View</TableHead>
                  <TableHead className="text-center">Qty Sold</TableHead>
                  {showWeightedCost && (
                    <TableHead
                      className="text-center"
                      title="Average cost per unit, weighted by purchase quantities."
                    >
                      Weighted Cost (per item)
                    </TableHead>
                  )}
                  {showWeightedPrice && (
                    <TableHead
                      className="text-center"
                      title="Average sold price per unit, weighted by quantities sold."
                    >
                      Weighted Sold Price (per item)
                    </TableHead>
                  )}
                  {showTotalCost && (
                    <TableHead
                      className="text-center"
                      title="Total cost of goods sold for this product."
                    >
                      Total Weighted Cost
                    </TableHead>
                  )}
                  <TableHead className="text-center">Revenue</TableHead>
                  <TableHead className="text-center">Margin %</TableHead>
                  <TableHead className="text-center">Profit / Loss</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Boolean(error) && (
                  <TableRow>
                    <TableCell colSpan={tableColSpan} className="text-center py-6 text-red-600">Failed to load product P&amp;L</TableCell>
                  </TableRow>
                )}
                {!error && mounted && isLoading && (
                  <TableRow>
                    <TableCell colSpan={tableColSpan} className="text-center py-6 text-muted-foreground">Loading...</TableCell>
                  </TableRow>
                )}
                {!error && mounted && !isLoading && filteredRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={tableColSpan} className="text-center py-6">
                      <div className="text-sm text-muted-foreground">
                        <p>No data for the current filters.</p>
                        <div className="mt-2 flex flex-wrap justify-center gap-2">
                          <Link
                            href="/admin/profit-loss/products"
                            className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            Reset filters
                          </Link>
                          <Link
                            href="/admin/products"
                            className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            View products
                          </Link>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {filteredRows.map((r) => {
                  const weightedSoldPrice = r.qty > 0 ? r.revenue / r.qty : 0;
                  return (
                  <TableRow key={r.productId} className="odd:bg-muted/30">
                    <TableCell className="text-center">#{r.rank}</TableCell>
                    <TableCell className="text-center">{r.name}</TableCell>
                    <TableCell className="text-center">
                      <Link
                        className="text-primary hover:underline"
                        href={`/admin/inventory?q=${encodeURIComponent(r.name)}`}
                      >
                        View
                      </Link>
                    </TableCell>
                    <TableCell className="text-center">{r.qty}</TableCell>
                    {showWeightedCost && (
                      <TableCell className="text-center">{formatCurrency(r.weightedCost)}</TableCell>
                    )}
                    {showWeightedPrice && (
                      <TableCell className="text-center">{formatCurrency(weightedSoldPrice)}</TableCell>
                    )}
                    {showTotalCost && (
                      <TableCell className="text-center">{formatCurrency(r.costTotal)}</TableCell>
                    )}
                    <TableCell className="text-center">{formatCurrency(r.revenue)}</TableCell>
                    <TableCell className="text-center">
                      {Number.isFinite(r.margin) ? `${r.margin.toFixed(1)}%` : "—"}
                    </TableCell>
                    <TableCell className={`text-center ${r.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(r.profit)}</TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Pagination */}
      {(() => {
        const total = data?.total ?? 0;
        const ps = pageSize;
        const totalPages = Math.max(1, Math.ceil(total / ps));
        const current = Math.min(page, totalPages);
        if (!total || totalPages <= 1) return null;

        // Build simple window around current
        const pages: number[] = [];
        const startP = Math.max(1, current - 2);
        const endP = Math.min(totalPages, current + 2);
        for (let p = startP; p <= endP; p++) pages.push(p);

        return (
          <Pagination className="mt-2">
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious href="#" onClick={(e) => { e.preventDefault(); if (current > 1) setPage(current - 1); }} />
              </PaginationItem>
              {startP > 1 && (
                <>
                  <PaginationItem>
                    <PaginationLink href="#" onClick={(e) => { e.preventDefault(); setPage(1); }}>1</PaginationLink>
                  </PaginationItem>
                </>
              )}
              {startP > 2 && (
                <PaginationItem>
                  <span className="px-2">…</span>
                </PaginationItem>
              )}
              {pages.map((p) => (
                <PaginationItem key={p}>
                  <PaginationLink href="#" isActive={p === current} onClick={(e) => { e.preventDefault(); setPage(p); }}>
                    {p}
                  </PaginationLink>
                </PaginationItem>
              ))}
              {endP < totalPages - 1 && (
                <PaginationItem>
                  <span className="px-2">…</span>
                </PaginationItem>
              )}
              {endP < totalPages && (
                <PaginationItem>
                  <PaginationLink href="#" onClick={(e) => { e.preventDefault(); setPage(totalPages); }}>
                    {totalPages}
                  </PaginationLink>
                </PaginationItem>
              )}
              <PaginationItem>
                <PaginationNext href="#" onClick={(e) => { e.preventDefault(); if (current < totalPages) setPage(current + 1); }} />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        );
      })()}
    </section>
  );
}

export default function ProductPLPage() {
  return (
    <Suspense
      fallback={
        <section className="container mx-auto py-8 space-y-4">
          <h1 className="text-2xl font-semibold">Product Profit &amp; Loss</h1>
          <p className="text-sm text-muted-foreground">Loading product P&amp;L…</p>
        </section>
      }
    >
      <ProductPLContent />
    </Suspense>
  );
}

