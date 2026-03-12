"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/currency";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";

type AgingRow = {
  supplierId: string | null;
  supplierName: string;
  buckets: {
    "0-30": number;
    "31-60": number;
    "61-90": number;
    "90+": number;
  };
  total: number;
  lastPurchaseAt: string | null;
};

type AgingResponse = {
  type: "ap";
  asOf: string;
  rows: AgingRow[];
  totals: {
    total: number;
    buckets: AgingRow["buckets"];
  };
};

export default function ApAgingPage() {
  const [q, setQ] = useState("");
  const [asOf, setAsOf] = useState("");
  const [sortBy, setSortBy] = useState<"total_desc" | "total_asc" | "supplier_asc">("total_desc");
  const [bucketFilter, setBucketFilter] = useState<"all" | "0-30" | "31-60" | "61-90" | "90+">("all");

  const { data: suppliersData } = useClientQuery<{ rows: { id: string; name: string }[] }>({
    queryKey: ["admin", "suppliers", "aging-filter"],
    queryFn: () => fetch("/api/admin/suppliers").then((r) => r.json()),
  });
  const suppliers = Array.isArray(suppliersData?.rows) ? suppliersData.rows : [];

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("type", "ap");
    if (q.trim()) sp.set("q", q.trim());
    if (asOf) sp.set("asOf", asOf);
    return sp.toString();
  }, [q, asOf]);

  const { data, error, isLoading } = useClientQuery<AgingResponse>({
    queryKey: ["admin", "accounting", "aging", "ap", q, asOf],
    queryFn: () =>
      fetch(`/api/admin/accounting/aging?${params}`).then(async (r) => {
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error((payload as { error?: string }).error || "Failed to load AP aging.");
        }
        return payload as AgingResponse;
      }),
  });

  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data?.rows]);
  const scopedRows = useMemo(() => {
    if (bucketFilter === "all") return rows;
    return rows.filter((row) => Number(row.buckets[bucketFilter] || 0) > 0.01);
  }, [rows, bucketFilter]);
  const sortedRows = useMemo(() => {
    const list = [...scopedRows];
    list.sort((a, b) => {
      if (sortBy === "supplier_asc") return a.supplierName.localeCompare(b.supplierName);
      if (sortBy === "total_asc") return a.total - b.total;
      return b.total - a.total;
    });
    return list;
  }, [scopedRows, sortBy]);
  const topRiskSupplier = useMemo(() => {
    if (!sortedRows.length) return null;
    const scored = sortedRows.map((row) => {
      const b90 = Number(row.buckets["90+"] || 0);
      const b61 = Number(row.buckets["61-90"] || 0);
      const b31 = Number(row.buckets["31-60"] || 0);
      const b0 = Number(row.buckets["0-30"] || 0);
      const riskScore = b90 * 4 + b61 * 3 + b31 * 2 + b0;
      const dominantBucket =
        b90 > 0
          ? "90+"
          : b61 > 0
            ? "61-90"
            : b31 > 0
              ? "31-60"
              : "0-30";
      return { row, riskScore, dominantBucket };
    });
    scored.sort((a, b) => b.riskScore - a.riskScore);
    return scored[0] || null;
  }, [sortedRows]);
  const bucketToAgingFilter = (bucket: "0-30" | "31-60" | "61-90" | "90+") =>
    bucket === "0-30"
      ? "0_30"
      : bucket === "31-60"
        ? "31_60"
        : bucket === "61-90"
          ? "61_90"
          : "90_plus";
  const totals = data?.totals || {
    total: 0,
    buckets: { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 },
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">AP aging</h1>
        <p className="text-sm text-muted-foreground">
          Unpaid supplier balances grouped by age.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Filters</CardTitle>
            <Link href="/admin/accounting/aging" className="text-xs text-muted-foreground underline">
              Back to aging
            </Link>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm text-foreground"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          >
            <option value="">All suppliers</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.name}>
                {supplier.name}
              </option>
            ))}
          </select>
          <Tooltip content="As-of date freezes the aging buckets at that day. Leave empty for today.">
            <Input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </Tooltip>
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm text-foreground"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "total_desc" | "total_asc" | "supplier_asc")}
          >
            <option value="total_desc">Sort by balance (highest first)</option>
            <option value="total_asc">Sort by balance (lowest first)</option>
            <option value="supplier_asc">Sort by supplier (A-Z)</option>
          </select>
          <div className="sm:col-span-2 lg:col-span-3 flex flex-wrap items-center gap-2">
            {(["all", "0-30", "31-60", "61-90", "90+"] as const).map((bucket) => (
              <Button
                key={bucket}
                type="button"
                variant={bucketFilter === bucket ? "default" : "outline"}
                size="sm"
                onClick={() => setBucketFilter(bucket)}
              >
                {bucket === "all" ? "All buckets" : bucket}
              </Button>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const header = ["Supplier", "0-30", "31-60", "61-90", "90+", "Total", "Last purchase"];
                const lines = [header.join(",")];
                for (const row of sortedRows) {
                  lines.push(
                    [
                      JSON.stringify(row.supplierName || ""),
                      row.buckets["0-30"].toFixed(2),
                      row.buckets["31-60"].toFixed(2),
                      row.buckets["61-90"].toFixed(2),
                      row.buckets["90+"].toFixed(2),
                      row.total.toFixed(2),
                      row.lastPurchaseAt ? new Date(row.lastPurchaseAt).toISOString().slice(0, 10) : "",
                    ].join(","),
                  );
                }
                const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                const day = asOf || new Date().toISOString().slice(0, 10);
                const filename = `ap_aging_${day}.csv`;
                link.href = url;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(url);
                void logAdminExportDownload({
                  area: "ap-aging",
                  format: "CSV",
                  fileName: filename,
                  rowCount: sortedRows.length,
                  columnCount: header.length,
                  byteSize: blob.size,
                  scopeSnapshot: `As-of: ${asOf || "today"} | Supplier query: ${q || "-"} | Bucket: ${bucketFilter}`,
                });
              }}
            >
              Export CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const { PDFDocument, StandardFonts } = await import("pdf-lib");
                const pdf = await PDFDocument.create();
                const font = await pdf.embedFont(StandardFonts.Helvetica);
                const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
                const pageRef = pdf.addPage([842, 595]); // A4 landscape
                const margin = 32;
                let y = 560;
                const line = 14;
                const money = (value: number) =>
                  `GHS ${Number(value || 0).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}`;

                pageRef.drawText("AP Aging - Current View", { x: margin, y, size: 16, font: bold });
                y -= 18;
                pageRef.drawText(
                  `Generated: ${new Date().toLocaleString()} | As-of: ${asOf || "Today"} | Supplier: ${
                    q || "All suppliers"
                  } | Bucket: ${bucketFilter === "all" ? "All buckets" : bucketFilter}`,
                  { x: margin, y, size: 9, font },
                );
                y -= 20;

                const rowsData: Array<[string, string]> = [
                  ["Rows", String(sortedRows.length)],
                  ["Total", money(sortedRows.reduce((sum, row) => sum + Number(row.total || 0), 0))],
                  ["0-30", money(sortedRows.reduce((sum, row) => sum + Number(row.buckets["0-30"] || 0), 0))],
                  ["31-60", money(sortedRows.reduce((sum, row) => sum + Number(row.buckets["31-60"] || 0), 0))],
                  ["61-90", money(sortedRows.reduce((sum, row) => sum + Number(row.buckets["61-90"] || 0), 0))],
                  ["90+", money(sortedRows.reduce((sum, row) => sum + Number(row.buckets["90+"] || 0), 0))],
                ];
                for (const [label, value] of rowsData) {
                  pageRef.drawText(label, { x: margin, y, size: 10, font: bold });
                  pageRef.drawText(value, { x: margin + 180, y, size: 10, font });
                  y -= line;
                }

                y -= 8;
                pageRef.drawText("Top suppliers in current view:", { x: margin, y, size: 10, font: bold });
                y -= line;
                const topRows = sortedRows.slice(0, 18);
                for (const row of topRows) {
                  if (y < 36) break;
                  const text = `${row.supplierName || "-"} | Total ${money(row.total)} | 0-30 ${money(
                    row.buckets["0-30"],
                  )} | 31-60 ${money(row.buckets["31-60"])} | 61-90 ${money(row.buckets["61-90"])} | 90+ ${money(
                    row.buckets["90+"],
                  )}`;
                  pageRef.drawText(text, { x: margin, y, size: 8.5, font });
                  y -= 12;
                }

                const bytes = await pdf.save();
                const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                const filename = `ap_aging_${asOf || new Date().toISOString().slice(0, 10)}.pdf`;
                link.href = url;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(url);
                await logAdminExportDownload({
                  area: "ap-aging",
                  format: "PDF",
                  fileName: filename,
                  rowCount: sortedRows.length,
                  columnCount: 2,
                  byteSize: blob.size,
                  scopeSnapshot: `As-of: ${asOf || "today"} | Supplier query: ${q || "-"} | Bucket: ${bucketFilter}`,
                });
              }}
            >
              Export PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQ("");
                setAsOf("");
                setSortBy("total_desc");
                setBucketFilter("all");
              }}
            >
              Clear filters
            </Button>
          </div>
          <div className="sm:col-span-2 lg:col-span-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Journal account drill:</span>
            <Link href="/admin/accounting/journal?account=2000" className="underline">
              2000 AP
            </Link>
            <span>·</span>
            <Link href="/admin/accounting/journal?account=1000" className="underline">
              1000 Cash
            </Link>
            <span>·</span>
            <Link href="/admin/accounting/journal?account=2300" className="underline">
              2300 Accrued Expenses
            </Link>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4 text-xs text-muted-foreground">
          Scope note: AP Aging is a ledger view of received supplier liabilities. Ordered/not-received exposure is tracked in{" "}
          <Link href="/admin/supplier-payments" className="underline">
            Supplier Payments
          </Link>
          .
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {topRiskSupplier ? (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <span className="font-medium">Top risk supplier:</span> {topRiskSupplier.row.supplierName}{" "}
              ({topRiskSupplier.dominantBucket} bucket, {formatCurrency(topRiskSupplier.row.total)} total)
              {" · "}
              <Link
                className="underline"
                href={`/admin/supplier-payments?${
                  topRiskSupplier.row.supplierId
                    ? `supplierId=${encodeURIComponent(topRiskSupplier.row.supplierId)}`
                    : `supplier=${encodeURIComponent(topRiskSupplier.row.supplierName)}`
                }&agingFilter=${bucketToAgingFilter(topRiskSupplier.dominantBucket as "0-30" | "31-60" | "61-90" | "90+")}`}
              >
                Open in Supplier Payments
              </Link>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Total</div>
              <div className="text-lg font-semibold">{formatCurrency(totals.total)}</div>
            </div>
            {(["0-30", "31-60", "61-90", "90+"] as const).map((bucket) => (
              <div key={bucket} className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">{bucket} days</div>
                <div className="text-lg font-semibold">
                  {formatCurrency(totals.buckets[bucket])}
                </div>
                <div className="pt-1 text-xs">
                  <Link className="underline" href={`/admin/supplier-payments?agingFilter=${bucketToAgingFilter(bucket)}`}>
                    Open in Supplier Payments
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Suppliers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {isLoading ? (
            <div className="text-muted-foreground">Loading aging…</div>
          ) : error ? (
            <div className="text-red-600">Failed to load AP aging.</div>
          ) : sortedRows.length === 0 ? (
            <div className="text-muted-foreground">No outstanding supplier balances.</div>
          ) : (
            <>
            <div className="space-y-2 lg:hidden">
              {sortedRows.map((row) => (
                <div key={`${row.supplierId || row.supplierName}`} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium">
                      {row.supplierName ? (
                        <Link
                          href={`/admin/supplier-payments${row.supplierId ? `?supplierId=${encodeURIComponent(row.supplierId)}` : `?supplier=${encodeURIComponent(row.supplierName)}`}`}
                          className="underline"
                        >
                          {row.supplierName}
                        </Link>
                      ) : (
                        row.supplierName
                      )}
                    </div>
                    <div className="text-right">
                      <div className="text-[11px] text-muted-foreground">Total</div>
                      <div className="font-semibold">{formatCurrency(row.total)}</div>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div>0-30: {formatCurrency(row.buckets["0-30"])}</div>
                    <div>31-60: {formatCurrency(row.buckets["31-60"])}</div>
                    <div>61-90: {formatCurrency(row.buckets["61-90"])}</div>
                    <div>90+: {formatCurrency(row.buckets["90+"])}</div>
                    <div className="col-span-2 text-muted-foreground">
                      Last purchase: {row.lastPurchaseAt ? new Date(row.lastPurchaseAt).toLocaleDateString() : "—"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 pr-3">Supplier</th>
                    <th className="py-2 pr-3 text-right">0-30</th>
                    <th className="py-2 pr-3 text-right">31-60</th>
                    <th className="py-2 pr-3 text-right">61-90</th>
                    <th className="py-2 pr-3 text-right">90+</th>
                    <th className="py-2 pr-3 text-right">Total</th>
                    <th className="py-2 pr-3 text-right">Last purchase</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <tr key={`${row.supplierId || row.supplierName}`} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        <div className="font-medium">
                          {row.supplierName ? (
                            <Link
                              href={`/admin/supplier-payments${row.supplierId ? `?supplierId=${encodeURIComponent(row.supplierId)}` : `?supplier=${encodeURIComponent(row.supplierName)}`}`}
                              className="underline"
                            >
                              {row.supplierName}
                            </Link>
                          ) : (
                            row.supplierName
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right">{formatCurrency(row.buckets["0-30"])}</td>
                      <td className="py-2 pr-3 text-right">{formatCurrency(row.buckets["31-60"])}</td>
                      <td className="py-2 pr-3 text-right">{formatCurrency(row.buckets["61-90"])}</td>
                      <td className="py-2 pr-3 text-right">{formatCurrency(row.buckets["90+"])}</td>
                      <td className="py-2 pr-3 text-right">{formatCurrency(row.total)}</td>
                      <td className="py-2 pr-3 text-right">
                        {row.lastPurchaseAt ? new Date(row.lastPurchaseAt).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
