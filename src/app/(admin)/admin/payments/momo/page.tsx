"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDateTimeGH } from "@/lib/currency";

type MomoPayment = {
  id: string;
  amount: number | string;
  createdAt: string | Date;
  status?: string;
  provider?: string;
  user?: { id?: string; name?: string | null; email?: string | null } | null;
  order?: { id: string | null } | null;
};

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export default function AdminMomoPaymentsPage() {
  const { data, error, isLoading, refetch } = useClientQuery<{ items: MomoPayment[] }>({
    queryKey: ["admin","payments","momo","pending"],
    queryFn: () => fetcher("/api/admin/payments/momo/pending"),
    refetchInterval: 10000,
  });
  const items: MomoPayment[] = useMemo(
    () => (data?.items || []) as MomoPayment[],
    [data],
  );
  const pendingCount = useMemo(
    () =>
      items.filter((p) => {
        const s = String(p.status || "pending").toUpperCase();
        const normalized = s === "SUCCESSFUL" ? "SUCCESS" : s;
        return normalized === "PENDING";
      }).length,
    [items]
  );
  const hasError = Boolean(error);

  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [rangeFilter, setRangeFilter] = useState<string>("ALL");

  const filteredItems = useMemo(() => {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;

    return items.filter((p) => {
      const created = new Date(p.createdAt);
      if (Number.isNaN(created.getTime())) return false;

      // Time range filter
      if (rangeFilter !== "ALL") {
        const diffMs = now.getTime() - created.getTime();
        let maxMs = Infinity;
        if (rangeFilter === "DAY") maxMs = dayMs;
        else if (rangeFilter === "WEEK") maxMs = 7 * dayMs;
        else if (rangeFilter === "MONTH") maxMs = 30 * dayMs;
        else if (rangeFilter === "YEAR") maxMs = 365 * dayMs;
        if (diffMs > maxMs) return false;
      }

      // Status filter
      if (statusFilter !== "ALL") {
        const raw = String(p.status || "pending").toUpperCase();
        const normalized =
          raw === "SUCCESSFUL"
            ? "SUCCESS"
            : raw === "DENIED"
            ? "DENIED"
            : raw;
        if (normalized !== statusFilter) return false;
      }

      return true;
    });
  }, [items, rangeFilter, statusFilter]);

  // Avoid hydration mismatches by only showing loading/error text after mount
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="container mx-auto py-6 grid gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">Mobile Money Payments</h1>
        <Button variant="default" className="w-full sm:w-auto" onClick={() => refetch()}>
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Recent MoMo Payments</CardTitle>
          <div className="flex flex-col gap-1 text-sm text-muted-foreground sm:items-end">
            <div className="flex gap-2">
              <label className="flex items-center gap-1">
                <span className="hidden sm:inline">Range</span>
                <select
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  value={rangeFilter}
                  onChange={(e) => setRangeFilter(e.target.value)}
                >
                  <option value="ALL">All</option>
                  <option value="DAY">Day</option>
                  <option value="WEEK">Week</option>
                  <option value="MONTH">Month</option>
                  <option value="YEAR">Year</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                <span className="hidden sm:inline">Status</span>
                <select
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  <option value="ALL">All</option>
                  <option value="PENDING">Pending</option>
                  <option value="SUCCESS">Success</option>
                  <option value="FAILED">Failed</option>
                  <option value="DENIED">Denied</option>
                </select>
              </label>
            </div>
            <div>
              Pending items: <span className="font-semibold text-foreground">{pendingCount}</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <div className="text-sm mb-2 min-h-[1.25rem]">
            {mounted &&
              (hasError ? (
                <span className="text-red-600">Failed to load.</span>
              ) : isLoading ? (
                <span className="text-muted-foreground">Loading…</span>
              ) : null)}
          </div>
          <>
              <table className="hidden md:table w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="px-4 py-2 text-center">Created</th>
                    <th className="px-4 py-2 text-center">Customer</th>
                    <th className="px-4 py-2 text-center">Order</th>
                    <th className="px-4 py-2 text-center">Amount</th>
                    <th className="px-4 py-2 text-center">Provider</th>
                    <th className="px-4 py-2 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="px-4 py-2 text-center whitespace-nowrap">
                        {formatDateTimeGH(p.createdAt)}
                      </td>
                      <td className="px-4 py-2 text-center break-all">
                        {p.user?.name || p.user?.email || p.user?.id}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {p.order?.id ? p.order.id.slice(0, 8) : "—"}
                      </td>
                      <td className="px-4 py-2 text-center whitespace-nowrap">
                        {formatCurrency(Number(p.amount || 0))}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {String(p.provider || "mtn").toUpperCase()}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {(() => {
                          const s = String(p.status || "pending").toUpperCase();
                          const cls =
                            s === "SUCCESS" || s === "SUCCESSFUL"
                              ? "bg-green-100 text-green-700"
                              : s === "FAILED"
                              ? "bg-red-100 text-red-700"
                              : "bg-yellow-100 text-yellow-800";
                          return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{s}</span>;
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="md:hidden space-y-3">
                {filteredItems.map((p) => (
                  <div key={p.id} className="rounded-lg border p-3 space-y-2 text-sm">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{formatDateTimeGH(p.createdAt)}</span>
                      <span>{String(p.provider || "mtn").toUpperCase()}</span>
                    </div>
                    <p className="font-semibold break-all">{p.user?.name || p.user?.email || p.user?.id}</p>
                    <div className="flex items-center justify-between text-sm">
                      <span>Order: {p.order?.id ? p.order.id.slice(0, 8) : "—"}</span>
                      <span className="font-mono font-semibold">{formatCurrency(Number(p.amount || 0))}</span>
                    </div>
                    <div>
                      {(() => {
                        const s = String(p.status || "pending").toUpperCase();
                        const cls =
                          s === "SUCCESS" || s === "SUCCESSFUL"
                            ? "bg-green-100 text-green-700"
                            : s === "FAILED"
                            ? "bg-red-100 text-red-700"
                            : "bg-yellow-100 text-yellow-800";
                        return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{s}</span>;
                      })()}
                    </div>
                  </div>
                ))}
              </div>
            </>
        </CardContent>
      </Card>
    </div>
  );
}
