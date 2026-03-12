"use client";

import { useMemo, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";

type Row = {
  productId: string;
  name: string;
  sku: string;
  supplier: string;
  stock: number;
  reorderPoint: number;
  leadTimeDays: number | null;
  daysOut: number;
  lostRevenueSinceStockout: number;
  avgDaily: number;
  periodDays: number;
  atRiskUnits: number;
  impactValue: number;
  state: "out" | "low" | "ok";
};

type Payload = {
  rows: Row[];
  total: number;
  generatedAt: string;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function StockoutImpactPage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "out" | "low">("all");
  const [sort, setSort] = useState<"impact" | "units" | "stock">("impact");

  const apiUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (status !== "all") p.set("status", status);
    if (sort) p.set("sort", sort);
    return `/api/admin/stockout-impact?${p.toString()}`;
  }, [q, status, sort]);

  const { data, isLoading, error } = useClientQuery<Payload>({
    queryKey: ["admin", "stockout-impact", { q, status, sort }],
    queryFn: () => fetcher(apiUrl),
    refetchInterval: false,
  });

  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data]);

  const summary = useMemo(() => {
    if (!rows.length) return null;
    const totals = rows.reduce(
      (acc, row) => {
        acc.atRiskUnits += row.atRiskUnits;
        acc.impactValue += row.impactValue;
        return acc;
      },
      { atRiskUnits: 0, impactValue: 0 },
    );
    return totals;
  }, [rows]);

  const exportCsv = async () => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (status !== "all") p.set("status", status);
    if (sort) p.set("sort", sort);
    p.set("format", "csv");
    const res = await fetch(`/api/admin/stockout-impact?${p.toString()}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const link = document.createElement("a");
    const filename = `stockout-impact_${Date.now()}.csv`;
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    void logAdminExportDownload({
      area: "stockout-impact",
      format: "CSV",
      fileName: filename,
      byteSize: blob.size,
      scopeSnapshot: `Status: ${status} | Sort: ${sort} | Query: ${q || "-"}`,
    });
  };

  const exportPdf = async () => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (status !== "all") p.set("status", status);
    if (sort) p.set("sort", sort);
    p.set("format", "pdf");
    const res = await fetch(`/api/admin/stockout-impact?${p.toString()}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const link = document.createElement("a");
    const filename = `stockout-impact_${Date.now()}.pdf`;
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    await logAdminExportDownload({
      area: "stockout-impact",
      format: "PDF",
      fileName: filename,
      byteSize: blob.size,
      scopeSnapshot: `Status: ${status} | Sort: ${sort} | Query: ${q || "-"}`,
    });
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Stockout impact</h1>
        <p className="text-sm text-muted-foreground">
          Estimate at-risk revenue for items that are out of stock or below reorder point,
          based on the latest demand snapshot.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <CardTitle>Filters</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search product or SKU"
              className="h-8 w-48"
            />
            <select
              className="border rounded-md h-8 bg-background px-2"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="all">All alerts</option>
              <option value="out">Out of stock</option>
              <option value="low">Below reorder</option>
            </select>
            <select
              className="border rounded-md h-8 bg-background px-2"
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
            >
              <option value="impact">Sort by impact</option>
              <option value="units">Sort by units</option>
              <option value="stock">Sort by stock</option>
            </select>
            <Button size="sm" variant="outline" onClick={exportCsv}>
              Export CSV
            </Button>
            <Button size="sm" variant="outline" onClick={exportPdf}>
              Export PDF
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {summary ? (
            <div className="flex flex-wrap gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">At-risk units</div>
                <div className="font-semibold">{summary.atRiskUnits.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Estimated impact</div>
                <div className="font-semibold">{formatCurrency(summary.impactValue)}</div>
              </div>
            </div>
          ) : null}

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading report…</p>
          ) : error ? (
            <p className="text-sm text-red-600">Failed to load stockout impact.</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No stockout risks for the current filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Stock</TableHead>
                    <TableHead>Reorder</TableHead>
                    <TableHead>Lead time</TableHead>
                    <TableHead>Days out</TableHead>
                    <TableHead>Lost revenue</TableHead>
                    <TableHead>Avg daily demand</TableHead>
                    <TableHead>At-risk units</TableHead>
                    <TableHead>Impact</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const statusLabel = row.state === "out" ? "Out of stock" : "Low stock";
                    const statusClass =
                      row.state === "out" ? "text-red-600" : "text-amber-600";
                    return (
                      <TableRow key={row.productId}>
                        <TableCell>
                          <div className="font-medium">{row.name}</div>
                          <div className="text-xs text-muted-foreground">SKU: {row.sku || "—"}</div>
                        </TableCell>
                        <TableCell>{row.supplier || "—"}</TableCell>
                        <TableCell>{row.stock}</TableCell>
                        <TableCell>{row.reorderPoint}</TableCell>
                        <TableCell>{row.leadTimeDays != null ? `${row.leadTimeDays}d` : "—"}</TableCell>
                        <TableCell>{row.daysOut ? row.daysOut : "—"}</TableCell>
                        <TableCell>
                          {row.lostRevenueSinceStockout > 0
                            ? formatCurrency(row.lostRevenueSinceStockout)
                            : "—"}
                        </TableCell>
                        <TableCell>{row.avgDaily.toFixed(2)}</TableCell>
                        <TableCell>{row.atRiskUnits.toFixed(2)}</TableCell>
                        <TableCell>{formatCurrency(row.impactValue)}</TableCell>
                        <TableCell className={statusClass}>{statusLabel}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
