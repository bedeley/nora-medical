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

type TrendRow = { date: string; revenue: number; cogs: number; expense: number; profit: number; margin: number };
type SummaryPayload = {
  summary: { totalRevenue: number; totalCOGS: number; totalExpense: number; profit: number; margin: number };
  trend: TrendRow[];
  groupBy: string;
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

  // Initialize from URL once
  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams?.toString() || "");
    const s0 = sp.get("start") || "";
    const e0 = sp.get("end") || "";
    const g0 = (sp.get("groupBy") as "day" | "week" | "month" | "year" | null) || "day";
    const c0 = sp.get("customer") || "";
    const cat0 = sp.get("category") || "";
    if (s0) setStart(s0);
    if (e0) setEnd(e0);
    if (["day", "week", "month", "year"].includes(g0)) setGroupBy(g0);
    if (c0) setCustomer(c0);
    if (cat0) setCategory(cat0);
    initialized.current = true;
  }, [searchParams]);

  // Reflect to URL
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams(searchParams?.toString() || "");
    if (start) params.set("start", start); else params.delete("start");
    if (end) params.set("end", end); else params.delete("end");
    if (groupBy) params.set("groupBy", groupBy); else params.delete("groupBy");
    if (customer) params.set("customer", customer); else params.delete("customer");
    if (category) params.set("category", category); else params.delete("category");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [start, end, groupBy, customer, category, pathname, router, searchParams]);

  // Build API URL
  const apiUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    if (groupBy) p.set("groupBy", groupBy);
    if (customer) p.set("customer", customer);
    if (category) p.set("category", category);
    return `/api/admin/summary?${p.toString()}`;
  }, [start, end, groupBy, customer, category]);

  const { data, error, isLoading } = useClientQuery<SummaryPayload>({
    queryKey: ["admin","summary", { start, end, groupBy, customer, category }],
    queryFn: () => fetcher(apiUrl),
    refetchInterval: 4000,
  });

  async function exportFile(kind: "csv" | "pdf") {
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
  const trend = data?.trend || [];

  return (
    <section className="p-6 space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h1 className="text-2xl font-semibold">Profit & Loss</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/admin/profit-loss/products">View Product Performance</Link>
          </Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => exportFile("csv")}>Export CSV</Button>
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => exportFile("pdf")}>Export PDF</Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 md:grid-cols-6 gap-3 items-end">
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
          <div className="text-sm text-muted-foreground">
            {isLoading ? "Loading..." : `${trend.length} period(s)`}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Totals</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 md:grid-cols-5 gap-3">
          <Stat
            label="Revenue"
            value={summary ? formatCurrency(summary.totalRevenue) : "-"}
          />
          <Stat
            label="COGS"
            value={summary ? formatCurrency(summary.totalCOGS) : "-"}
            accent="text-amber-600"
          />
          <Stat
            label="Expenses"
            value={summary ? formatCurrency(summary.totalExpense) : "-"}
            accent="text-red-600"
          />
          <Stat
            label="Net Profit"
            value={summary ? formatCurrency(summary.profit) : "-"}
            accent={
              summary ? (summary.profit >= 0 ? "text-green-600" : "text-red-600") : ""
            }
          />
          <Stat
            label="Margin"
            value={summary ? `${summary.margin.toFixed(2)}%` : "-"}
            accent={
              summary ? (summary.margin >= 0 ? "text-green-600" : "text-red-600") : ""
            }
          />
        </CardContent>
      </Card>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">COGS</TableHead>
              <TableHead className="text-right">Expenses</TableHead>
              <TableHead className="text-right">Net Profit</TableHead>
              <TableHead className="text-right">Margin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Boolean(error) && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-6 text-red-600">Failed to load P&L</TableCell>
              </TableRow>
            )}
            {!error && isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">Loading...</TableCell>
              </TableRow>
            )}
            {!error && !isLoading && trend.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">No data</TableCell>
              </TableRow>
            )}
            {trend.map((t) => (
              <TableRow
                key={t.date}
                className="odd:bg-background even:bg-muted/40 hover:bg-accent/60"
              >
                <TableCell>{t.date}</TableCell>
                <TableCell className="text-right">{formatCurrency(t.revenue)}</TableCell>
                <TableCell className="text-right">{formatCurrency(t.cogs ?? 0)}</TableCell>
                <TableCell className="text-right">{formatCurrency(t.expense)}</TableCell>
                <TableCell className={`text-right ${t.profit >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(t.profit)}</TableCell>
                <TableCell className="text-right">{t.margin.toFixed(2)}%</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export default function ProfitLossPage() {
  return (
    <Suspense
      fallback={
        <section className="space-y-4">
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
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="p-3 rounded-md bg-background shadow-sm">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${accent ?? ""}`}>{value}</div>
    </div>
  );
}
