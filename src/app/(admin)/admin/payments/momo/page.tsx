"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDateTimeGH } from "@/lib/currency";
import { chipToneClass, paymentStatusTone } from "@/lib/status-chips";

type MomoPayment = {
  id: string;
  amount: number | string;
  createdAt: string | Date;
  status?: string;
  provider?: string;
  providerRef?: string;
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
  const [providerFilter, setProviderFilter] = useState<string>("ALL");
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

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

      if (providerFilter !== "ALL") {
        const provider = String(p.provider || "mtn").toUpperCase();
        if (provider !== providerFilter) return false;
      }

      return true;
    });
  }, [items, rangeFilter, statusFilter, providerFilter]);

  const providerOptions = useMemo(() => {
    const providers = new Set(
      items.map((p) => String(p.provider || "mtn").toUpperCase())
    );
    return Array.from(providers).sort();
  }, [items]);

  const totals = useMemo(() => {
    const sum = filteredItems.reduce((acc, p) => acc + Number(p.amount || 0), 0);
    const counts = filteredItems.reduce(
      (acc, p) => {
        const raw = String(p.status || "pending").toUpperCase();
        const normalized =
          raw === "SUCCESSFUL"
            ? "SUCCESS"
            : raw === "DENIED"
            ? "DENIED"
            : raw;
        acc[normalized] = (acc[normalized] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
    return { sum, counts, total: filteredItems.length };
  }, [filteredItems]);

  // Avoid hydration mismatches by only showing loading/error text after mount
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    if (!mounted) return;
    setLastRefreshed(new Date());
  }, [data, mounted]);

  return (
    <div className="container mx-auto py-8 grid gap-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Mobile Money Payments</h1>
          <p className="text-sm text-muted-foreground">
            Monitor recent MoMo transactions and pending approvals.
          </p>
          <p className="text-xs text-muted-foreground">
            {lastRefreshed ? `Last refreshed: ${lastRefreshed.toLocaleString()}` : "Last refreshed: --"}
          </p>
        </div>
        <Button
          variant="default"
          className="w-full sm:w-auto"
          onClick={() => refetch()}
        >
          Refresh
        </Button>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between py-3">
          <CardTitle className="text-base font-semibold">Recent MoMo Payments</CardTitle>
          <div className="flex flex-col gap-1 text-sm text-muted-foreground sm:items-end">
            <div className="flex flex-wrap gap-2">
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
              <label className="flex items-center gap-1">
                <span className="hidden sm:inline">Provider</span>
                <select
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  value={providerFilter}
                  onChange={(e) => setProviderFilter(e.target.value)}
                >
                  <option value="ALL">All</option>
                  {providerOptions.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div>
              Pending items: <span className="font-semibold text-foreground">{pendingCount}</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <div className="flex flex-col gap-2 text-sm mb-2 min-h-[1.25rem] sm:flex-row sm:items-center sm:justify-between">
            {mounted &&
              (hasError ? (
                <span className="text-red-600">Failed to load.</span>
              ) : isLoading ? (
                <span className="text-muted-foreground">Loading…</span>
              ) : null)}
            <div className="text-xs text-muted-foreground">
              Total {totals.total.toLocaleString()} • Amount {formatCurrency(totals.sum)}
              {totals.counts.SUCCESS ? ` • Success ${totals.counts.SUCCESS}` : ""}
              {totals.counts.PENDING ? ` • Pending ${totals.counts.PENDING}` : ""}
              {totals.counts.FAILED ? ` • Failed ${totals.counts.FAILED}` : ""}
              {totals.counts.DENIED ? ` • Denied ${totals.counts.DENIED}` : ""}
            </div>
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
                    <th className="px-4 py-2 text-center">Reference</th>
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
                        {p.order?.id ? (
                          <Link
                            href={`/admin/orders/${p.order.id}`}
                            className="text-primary underline"
                          >
                            {p.order.id.slice(0, 8)}
                          </Link>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-2 text-center whitespace-nowrap">
                        {formatCurrency(Number(p.amount || 0))}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {String(p.provider || "mtn").toUpperCase()}
                      </td>
                      <td className="px-4 py-2 text-center text-xs text-muted-foreground break-all">
                        {p.providerRef ? p.providerRef : "—"}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {(() => {
                          const s = String(p.status || "pending").toUpperCase();
                          const cls = chipToneClass(paymentStatusTone(s));
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
                      <span>
                        Order:{" "}
                        {p.order?.id ? (
                          <Link
                            href={`/admin/orders/${p.order.id}`}
                            className="text-primary underline"
                          >
                            {p.order.id.slice(0, 8)}
                          </Link>
                        ) : "—"}
                      </span>
                      <span className="font-mono font-semibold">{formatCurrency(Number(p.amount || 0))}</span>
                    </div>
                    {p.providerRef ? (
                      <div className="text-xs text-muted-foreground break-all">
                        Reference: {p.providerRef}
                      </div>
                    ) : null}
                    <div>
                      {(() => {
                        const s = String(p.status || "pending").toUpperCase();
                        const cls = chipToneClass(paymentStatusTone(s));
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
