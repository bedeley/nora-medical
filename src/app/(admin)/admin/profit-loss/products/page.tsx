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

  const [mode, setMode] = useState<"day" | "week" | "month" | "year" | "custom">("month");
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [q, setQ] = useState<string>("");
  const [qInput, setQInput] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [sortMetric, setSortMetric] = useState<"profit" | "revenue" | "qty" | "margin">("profit");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Initialize from URL once
  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams?.toString() || "");
    const m0 = (sp.get("mode") as "day" | "week" | "month" | "year" | "custom" | null) || "month";
    const s0 = sp.get("start") || "";
    const e0 = sp.get("end") || "";
    const o0 = (sp.get("order") as "asc" | "desc" | null) || "desc";
    const q0 = sp.get("q") || "";
    const sort0 = (sp.get("sort") as "profit" | "revenue" | "qty" | "margin" | null) || "profit";
    const p0 = parseInt(sp.get("page") || "1", 10) || 1;
    const ps0 = parseInt(sp.get("pageSize") || "25", 10) || 25;
    if (["day", "week", "month", "year", "custom"].includes(m0)) setMode(m0);
    if (s0) setStart(s0);
    if (e0) setEnd(e0);
    if (["asc", "desc"].includes(o0)) setOrder(o0);
    if (["profit", "revenue", "qty", "margin"].includes(sort0)) setSortMetric(sort0);
    setQ(q0);
    setQInput(q0);
    setPage(Math.max(1, p0));
    setPageSize(Math.max(1, Math.min(200, ps0)));
    initialized.current = true;
  }, [searchParams]);

  // Reflect current filters to URL without causing a navigation loop
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams(searchParams?.toString() || "");
    if (mode) params.set("mode", mode); else params.delete("mode");
    if (start) params.set("start", start); else params.delete("start");
    if (end) params.set("end", end); else params.delete("end");
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
    <section className="p-6 space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground flex flex-wrap items-center gap-1">
        <Link href="/admin/profit-loss" className="hover:underline whitespace-nowrap">Profit &amp; Loss</Link>
        <span className="mx-1">/</span>
        <span className="text-foreground whitespace-nowrap">Products</span>
      </nav>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-3">
          <Button asChild variant="outline" size="sm" className="w-full sm:w-auto">
            <Link href="/admin/profit-loss">Back</Link>
          </Button>
          <span className="text-xs text-muted-foreground">Shortcut: Alt + Left Arrow to go back</span>
          <h1 className="text-2xl font-semibold">Product Performance (P&amp;L)</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" className="w-full sm:w-auto" onClick={resetToThisWeek}>This Week</Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={resetToToday}>Today</Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={clearFilters}>Clear Filters</Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => exportFile("csv")}>Export CSV</Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => exportFile("pdf")}>Export PDF</Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
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
                setMode(e.target.value as "day" | "week" | "month" | "year" | "custom");
                setPage(1);
              }}
            >
              <option value="day">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="year">This Year</option>
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
          <div>
            <label className="text-sm">Sort</label>
            <div className="flex flex-wrap gap-2">
              <select
                className="border rounded-md h-9 bg-background px-2"
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
            {!mounted ? "\u00A0" : isLoading ? "Loading..." : `${data?.total ?? 0} product(s)`}
          </div>
        </CardContent>
      </Card>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20 text-center">Rank</TableHead>
              <TableHead className="text-center">Product</TableHead>
              <TableHead className="text-center">Qty Sold</TableHead>
              <TableHead className="text-center">Weighted Cost (per item)</TableHead>
              <TableHead className="text-center">Weighted Sold Price (per item)</TableHead>
              <TableHead className="text-center">Total Weighted Cost</TableHead>
              <TableHead className="text-center">Revenue</TableHead>
              <TableHead className="text-center">Margin %</TableHead>
              <TableHead className="text-center">Profit / Loss</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Boolean(error) && (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-6 text-red-600">Failed to load product P&amp;L</TableCell>
              </TableRow>
            )}
            {!error && mounted && isLoading && (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-6 text-muted-foreground">Loading...</TableCell>
              </TableRow>
            )}
            {!error && mounted && !isLoading && (data?.rows?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-6 text-muted-foreground">No data</TableCell>
              </TableRow>
            )}
            {data?.rows?.map((r) => {
              const weightedSoldPrice = r.qty > 0 ? r.revenue / r.qty : 0;
              return (
              <TableRow key={r.productId} className="odd:bg-muted/30">
                <TableCell className="text-center">#{r.rank}</TableCell>
                <TableCell className="text-center">{r.name}</TableCell>
                <TableCell className="text-center">{r.qty}</TableCell>
                <TableCell className="text-center">{formatCurrency(r.weightedCost)}</TableCell>
                <TableCell className="text-center">{formatCurrency(weightedSoldPrice)}</TableCell>
                <TableCell className="text-center">{formatCurrency(r.costTotal)}</TableCell>
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
        <section className="space-y-4">
          <h1 className="text-2xl font-semibold">Product Profit &amp; Loss</h1>
          <p className="text-sm text-muted-foreground">Loading product P&amp;L…</p>
        </section>
      }
    >
      <ProductPLContent />
    </Suspense>
  );
}

