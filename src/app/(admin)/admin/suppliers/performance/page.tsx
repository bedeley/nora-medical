"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";

type SupplierRow = {
  supplierId: string | null;
  supplierName: string;
  status: string;
  leadTimeDays: number | null;
  purchases: number;
  qtyOrdered: number;
  qtyReceived: number;
  totalSpend: number;
  leadTimeCount: number;
  leadTimeSum: number;
  varianceCount: number;
  varianceSum: number;
  onTimeCount: number;
  onTimeTotal: number;
  lastPurchaseAt: string | null;
};

type SupplierPerformanceResponse = {
  rows: SupplierRow[];
  totals: {
    suppliers: number;
    totalSpend: number;
    totalOrdered: number;
    totalReceived: number;
    leadTimeSum: number;
    leadTimeCount: number;
    onTimeCount: number;
    onTimeTotal: number;
    varianceSum: number;
    varianceCount: number;
  };
};

const statusBadge = (status: string) => {
  if (status === "ACTIVE") return <Badge>Active</Badge>;
  if (status === "ON_HOLD") return <Badge variant="secondary">On hold</Badge>;
  if (status === "INACTIVE") return <Badge variant="outline">Inactive</Badge>;
  return <Badge variant="outline">Unassigned</Badge>;
};

export default function SupplierPerformancePage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const { data: suppliersData } = useClientQuery<{ rows: { id: string; name: string }[] }>({
    queryKey: ["admin", "suppliers"],
    queryFn: () => fetch("/api/admin/suppliers").then((r) => r.json()),
  });
  const suppliers = Array.isArray(suppliersData?.rows) ? suppliersData.rows : [];

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    if (status !== "all") sp.set("status", status);
    if (start) sp.set("start", start);
    if (end) sp.set("end", end);
    return sp.toString();
  }, [q, status, start, end]);

  const { data, error, isLoading } = useClientQuery<SupplierPerformanceResponse>({
    queryKey: ["admin", "suppliers", "performance", q, status, start, end],
    queryFn: () =>
      fetch(`/api/admin/suppliers/performance?${params}`).then(async (r) => {
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error((payload as { error?: string }).error || "Failed to load performance.");
        }
        return payload as SupplierPerformanceResponse;
      }),
  });

  const rows = data?.rows || [];
  const totals = data?.totals || {
    suppliers: 0,
    totalSpend: 0,
    totalOrdered: 0,
    totalReceived: 0,
    leadTimeSum: 0,
    leadTimeCount: 0,
    onTimeCount: 0,
    onTimeTotal: 0,
    varianceSum: 0,
    varianceCount: 0,
  };

  const avgLead =
    totals.leadTimeCount > 0 ? totals.leadTimeSum / totals.leadTimeCount : 0;
  const onTimeRate =
    totals.onTimeTotal > 0 ? (totals.onTimeCount / totals.onTimeTotal) * 100 : 0;
  const avgFillRate =
    totals.totalOrdered > 0 ? (totals.totalReceived / totals.totalOrdered) * 100 : 0;
  const avgVariance =
    totals.varianceCount > 0 ? totals.varianceSum / totals.varianceCount : 0;

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Supplier performance</h1>
        <p className="text-sm text-muted-foreground">
          Monitor lead time reliability, fill rates, and spend by supplier.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
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
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm text-foreground"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="ON_HOLD">On hold</option>
            <option value="INACTIVE">Inactive</option>
            <option value="UNASSIGNED">Unassigned</option>
          </select>
          <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex items-center justify-between">
            <span>Suppliers</span>
            <span>{totals.suppliers}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Total spend</span>
            <span>{formatCurrency(totals.totalSpend)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Avg fill rate</span>
            <span>{avgFillRate.toFixed(1)}%</span>
          </div>
          <div className="flex items-center justify-between">
            <span>On-time rate</span>
            <span>{onTimeRate.toFixed(1)}%</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Avg lead time</span>
            <span>{avgLead.toFixed(1)}d</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Avg variance</span>
            <span>{avgVariance.toFixed(1)}d</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Qty ordered</span>
            <span>{totals.totalOrdered}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Qty received</span>
            <span>{totals.totalReceived}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Supplier breakdown</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {isLoading ? (
            <div className="text-muted-foreground">Loading performance…</div>
          ) : error ? (
            <div className="text-red-600">Failed to load supplier performance.</div>
          ) : rows.length === 0 ? (
            <div className="text-muted-foreground">No supplier data found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 pr-3">Supplier</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3 text-right">Purchases</th>
                    <th className="py-2 pr-3 text-right">Fill rate</th>
                    <th className="py-2 pr-3 text-right">Avg lead</th>
                    <th className="py-2 pr-3 text-right">On-time</th>
                    <th className="py-2 pr-3 text-right">Variance</th>
                    <th className="py-2 pr-3 text-right">Spend</th>
                    <th className="py-2 pr-3 text-right">Last purchase</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const fillRate =
                      row.qtyOrdered > 0 ? (row.qtyReceived / row.qtyOrdered) * 100 : 0;
                    const avgLeadTime =
                      row.leadTimeCount > 0 ? row.leadTimeSum / row.leadTimeCount : 0;
                    const onTimeRateRow =
                      row.onTimeTotal > 0 ? (row.onTimeCount / row.onTimeTotal) * 100 : 0;
                    const variance =
                      row.varianceCount > 0 ? row.varianceSum / row.varianceCount : 0;
                    return (
                      <tr key={`${row.supplierId || row.supplierName}`} className="border-b last:border-0">
                        <td className="py-2 pr-3">
                          <div className="font-medium">
                            {row.supplierId ? (
                              <Link href={`/admin/suppliers?focus=${row.supplierId}`} className="underline">
                                {row.supplierName}
                              </Link>
                            ) : (
                              row.supplierName
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Lead time target: {row.leadTimeDays ?? "—"}d
                          </div>
                        </td>
                        <td className="py-2 pr-3">{statusBadge(row.status)}</td>
                        <td className="py-2 pr-3 text-right">{row.purchases}</td>
                        <td className="py-2 pr-3 text-right">{fillRate.toFixed(1)}%</td>
                        <td className="py-2 pr-3 text-right">{avgLeadTime.toFixed(1)}d</td>
                        <td className="py-2 pr-3 text-right">{onTimeRateRow.toFixed(1)}%</td>
                        <td className="py-2 pr-3 text-right">{variance.toFixed(1)}d</td>
                        <td className="py-2 pr-3 text-right">
                          {formatCurrency(row.totalSpend)}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {row.lastPurchaseAt
                            ? new Date(row.lastPurchaseAt).toLocaleDateString()
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Total suppliers: {rows.length}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQ("");
                setStatus("all");
                setStart("");
                setEnd("");
              }}
            >
              Clear filters
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
