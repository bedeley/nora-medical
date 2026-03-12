"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { formatCurrency, formatDateTimeGH } from "@/lib/currency";
import { chipToneClass, paymentStatusTone } from "@/lib/status-chips";

type MomoPayment = {
  id: string;
  amount: number | string;
  createdAt: string | Date;
  status?: string;
  settlement?: "PENDING" | "SETTLED" | "FAILED";
  posted?: boolean;
  provider?: string;
  providerRef?: string;
  source?: "MANUAL" | "PROVIDER";
  canCancel?: boolean;
  canResolveLate?: boolean;
  canSimulateLate?: boolean;
  canPostNow?: boolean;
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
    () => items.filter((p) => (p.settlement || "PENDING") === "PENDING").length,
    [items]
  );
  const hasError = Boolean(error);

  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [rangeFilter, setRangeFilter] = useState<string>("ALL");
  const [providerFilter, setProviderFilter] = useState<string>("ALL");
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [simulatingId, setSimulatingId] = useState<string | null>(null);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [bulkPosting, setBulkPosting] = useState(false);
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);

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
        const settlement = p.settlement || "PENDING";
        if (statusFilter === "NEEDS_POSTING") {
          if (!(settlement === "SETTLED" && !p.posted)) return false;
        } else if (settlement !== statusFilter) {
          return false;
        }
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
        const settlement = p.settlement || "PENDING";
        acc[settlement] = (acc[settlement] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
    return { sum, counts, total: filteredItems.length };
  }, [filteredItems]);
  const unpostedSettled = useMemo(
    () => filteredItems.filter((p) => (p.settlement || "PENDING") === "SETTLED" && !p.posted).length,
    [filteredItems]
  );
  const hasActions = useMemo(
    () =>
      filteredItems.some((p) =>
        Boolean(
          (p.providerRef && (p.settlement || "PENDING") === "PENDING") ||
            p.canCancel ||
            p.canResolveLate ||
            p.canSimulateLate ||
            p.canPostNow,
        ),
      ),
    [filteredItems],
  );
  const needsPostingRetryCount = useMemo(
    () => filteredItems.filter((p) => (p.settlement || "PENDING") === "SETTLED" && !p.posted).length,
    [filteredItems],
  );

  const postNow = async (paymentId: string) => {
    try {
      setPostingId(paymentId);
      const res = await fetch(`/api/admin/payments/momo/${paymentId}/post-now`, {
        method: "POST",
      });
      const payload = await res.json().catch(() => ({} as { error?: string; alreadyPosted?: boolean }));
      if (!res.ok) {
        toast.error(payload?.error || "Failed to post payment now.");
        return;
      }
      if (payload?.alreadyPosted) {
        toast.message("Payment is already posted.");
      } else {
        toast.success("MoMo payment posted to journal.");
      }
      await refetch();
    } finally {
      setPostingId(null);
    }
  };

  const postAllSettledUnposted = async () => {
    try {
      setBulkPosting(true);
      const res = await fetch("/api/admin/payments/momo/post-all-settled-unposted", {
        method: "POST",
      });
      const payload = await res.json().catch(
        () =>
          ({} as {
            error?: string;
            attempted?: number;
            posted?: number;
            skipped?: number;
            failedCount?: number;
          }),
      );
      if (!res.ok) {
        toast.error(payload?.error || "Bulk posting failed.");
        return;
      }
      const attempted = Number(payload?.attempted || 0);
      const posted = Number(payload?.posted || 0);
      const skipped = Number(payload?.skipped || 0);
      const failedCount = Number(payload?.failedCount || 0);
      if (attempted === 0) {
        toast.message("No settled-unposted MoMo rows found.");
      } else if (failedCount > 0) {
        toast.warning(
          `Bulk post: attempted ${attempted}, posted ${posted}, skipped ${skipped}, failed ${failedCount}.`,
        );
      } else {
        toast.success(`Bulk post: attempted ${attempted}, posted ${posted}, skipped ${skipped}, failed 0.`);
      }
      await refetch();
    } finally {
      setBulkPosting(false);
      setShowBulkConfirm(false);
    }
  };

  const cancelPending = async (paymentId: string) => {
    try {
      setCancelingId(paymentId);
      const res = await fetch(`/api/admin/payments/momo/${paymentId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Canceled by staff/admin from MoMo monitor" }),
      });
      const payload = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        toast.error(payload?.error || "Failed to cancel pending MoMo request.");
        return;
      }
      toast.success("Pending MoMo request canceled.");
      await refetch();
    } finally {
      setCancelingId(null);
    }
  };

  const resolveLateToCredit = async (paymentId: string) => {
    try {
      setResolvingId(paymentId);
      const res = await fetch(`/api/admin/payments/momo/${paymentId}/resolve-late`, {
        method: "POST",
      });
      const payload = await res.json().catch(() => ({} as { error?: string; posted?: boolean; postingError?: string }));
      if (!res.ok) {
        toast.error(payload?.error || "Failed to resolve late MoMo payment.");
        return;
      }
      if (payload?.postingError) {
        toast.warning("Resolved to credit, but accounting post needs review.");
      } else {
        toast.success("Late MoMo resolved to store credit.");
      }
      await refetch();
    } finally {
      setResolvingId(null);
    }
  };

  const simulateLateSuccess = async (paymentId: string) => {
    try {
      setSimulatingId(paymentId);
      const res = await fetch(`/api/admin/payments/momo/${paymentId}/simulate-late-success`, {
        method: "POST",
      });
      const payload = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        toast.error(payload?.error || "Failed to simulate late success.");
        return;
      }
      toast.success("Late success simulated. You can now resolve to credit.");
      await refetch();
    } finally {
      setSimulatingId(null);
    }
  };

  const checkProviderStatus = async (paymentId: string) => {
    try {
      setCheckingId(paymentId);
      const res = await fetch(`/api/payments/momo/status/${paymentId}`);
      const payload = await res.json().catch(() => ({} as { error?: string; status?: string }));
      if (!res.ok) {
        toast.error(payload?.error || "Failed to check MoMo status.");
        return;
      }
      const normalized = String(payload?.status || "").toUpperCase();
      if (normalized === "SUCCESSFUL" || normalized === "SUCCESS") {
        toast.success("MoMo payment confirmed and applied.");
      } else if (normalized === "PENDING" || normalized === "PENDING_FORCED_TEST") {
        toast.message("MoMo payment is still pending.");
      } else if (normalized) {
        toast.warning(`MoMo status: ${normalized}`);
      } else {
        toast.message("Status checked.");
      }
      await refetch();
    } finally {
      setCheckingId(null);
    }
  };

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
                  <option value="SETTLED">Settled</option>
                  <option value="FAILED">Failed</option>
                  <option value="NEEDS_POSTING">Needs posting retry</option>
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
            <div className="flex items-center gap-2">
              <span>
                Pending items: <span className="font-semibold text-foreground">{pendingCount}</span>
              </span>
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 border border-amber-200">
                Settled-unposted: {needsPostingRetryCount}
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <div className="mb-3 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Legend:</span>{" "}
            <span className="font-medium">Status</span> is provider/request state (pending, successful, failed).{" "}
            <span className="font-medium">Ledger</span> is accounting posting state (posted or unposted).
          </div>
          <div className="flex flex-col gap-2 text-sm mb-2 min-h-[1.25rem] sm:flex-row sm:items-center sm:justify-between">
            {mounted &&
              (hasError ? (
                <span className="text-red-600">Failed to load.</span>
              ) : isLoading ? (
                <span className="text-muted-foreground">Loading…</span>
              ) : null)}
            <div className="text-xs text-muted-foreground">
              Total {totals.total.toLocaleString()} • Amount {formatCurrency(totals.sum)}
              {totals.counts.SETTLED ? ` • Settled ${totals.counts.SETTLED}` : ""}
              {totals.counts.PENDING ? ` • Pending ${totals.counts.PENDING}` : ""}
              {totals.counts.FAILED ? ` • Failed ${totals.counts.FAILED}` : ""}
            </div>
          </div>
          <div className="grid gap-3 mb-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Total</div>
              <div className="text-lg font-semibold">{formatCurrency(totals.sum)}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Settled</div>
              <div className="text-lg font-semibold">{totals.counts.SETTLED || 0}</div>
              {unpostedSettled ? (
                <div className="text-xs text-muted-foreground">
                  {unpostedSettled} unposted
                </div>
              ) : null}
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Pending</div>
              <div className="text-lg font-semibold">{totals.counts.PENDING || 0}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Failed</div>
              <div className="text-lg font-semibold">{totals.counts.FAILED || 0}</div>
            </div>
          </div>
          {needsPostingRetryCount > 0 ? (
            <div className="mb-3 flex items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
              <span className="text-amber-800">
                {needsPostingRetryCount} settled MoMo payment(s) need posting retry.
              </span>
              <Button size="sm" variant="outline" disabled={bulkPosting} onClick={() => setShowBulkConfirm(true)}>
                {bulkPosting ? "Posting..." : "Post all settled-unposted"}
              </Button>
            </div>
          ) : null}
          <Dialog open={showBulkConfirm} onOpenChange={setShowBulkConfirm}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Post all settled-unposted MoMo payments?</DialogTitle>
              </DialogHeader>
              <p className="text-sm text-muted-foreground">
                This will try posting all settled but unposted MoMo rows to the journal now.
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowBulkConfirm(false)} disabled={bulkPosting}>
                  Cancel
                </Button>
                <Button onClick={() => void postAllSettledUnposted()} disabled={bulkPosting}>
                  {bulkPosting ? "Posting..." : "Confirm"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <>
              <table className="hidden lg:table w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="px-4 py-2 text-center">Created</th>
                    <th className="px-4 py-2 text-center">Customer</th>
                    <th className="px-4 py-2 text-center">Order</th>
                    <th className="px-4 py-2 text-center">Amount</th>
                    <th className="px-4 py-2 text-center">Provider</th>
                    <th className="px-4 py-2 text-center">Source</th>
                    <th className="px-4 py-2 text-center">Reference</th>
                    <th className="px-4 py-2 text-center">Ledger</th>
                    <th className="px-4 py-2 text-center">Status</th>
                    <th className={hasActions ? "px-4 py-2 text-center" : "hidden"}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="px-4 py-2 text-center whitespace-nowrap">
                        {formatDateTimeGH(p.createdAt)}
                      </td>
                      <td className="px-4 py-2 text-center whitespace-normal break-words">
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
                      <td className="px-4 py-2 text-center">
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full ${
                            p.source === "MANUAL"
                              ? "bg-slate-100 text-slate-700"
                              : "bg-indigo-50 text-indigo-700"
                          }`}
                        >
                          {p.source === "MANUAL" ? "Manual" : "Provider"}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-center text-xs text-muted-foreground break-all">
                        {p.providerRef ? p.providerRef : "—"}
                      </td>
                      <td className="px-4 py-2 text-center">
                        {p.posted ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                            Posted
                          </span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">
                            Unposted
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-center">
                          {(() => {
                            const settlement = p.settlement || "PENDING";
                            const raw = String(p.status || settlement).toUpperCase();
                            const cls = chipToneClass(paymentStatusTone(settlement));
                            return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{raw}</span>;
                          })()}
                          {(p.settlement || "PENDING") === "SETTLED" && !p.posted ? (
                            <div className="text-[11px] text-amber-700 mt-1">Needs posting retry</div>
                          ) : null}
                        </td>
                      <td className={hasActions ? "px-4 py-2 text-center" : "hidden"}>
                        <div className="flex flex-wrap justify-center gap-2">
                          {p.providerRef && (p.settlement || "PENDING") === "PENDING" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={checkingId === p.id}
                              onClick={() => void checkProviderStatus(p.id)}
                            >
                              {checkingId === p.id ? "Checking..." : "Check status"}
                            </Button>
                          ) : null}
                          {p.canCancel ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={cancelingId === p.id}
                              onClick={() => void cancelPending(p.id)}
                            >
                              {cancelingId === p.id ? "Canceling..." : "Cancel pending"}
                            </Button>
                          ) : null}
                          {p.canResolveLate ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={resolvingId === p.id}
                              onClick={() => void resolveLateToCredit(p.id)}
                            >
                              {resolvingId === p.id ? "Resolving..." : "Resolve to Credit"}
                            </Button>
                          ) : null}
                          {p.canSimulateLate ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={simulatingId === p.id}
                              onClick={() => void simulateLateSuccess(p.id)}
                            >
                              {simulatingId === p.id ? "Simulating..." : "Simulate Late Success"}
                            </Button>
                          ) : null}
                          {p.canPostNow ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={postingId === p.id}
                              onClick={() => void postNow(p.id)}
                            >
                              {postingId === p.id ? "Posting..." : "Post now"}
                            </Button>
                          ) : null}
                          {!p.canCancel &&
                          !(p.providerRef && (p.settlement || "PENDING") === "PENDING") &&
                          !p.canResolveLate &&
                          !p.canSimulateLate &&
                          !p.canPostNow
                            ? <span className="text-xs text-muted-foreground">No action for current state</span>
                            : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="lg:hidden space-y-3">
                {filteredItems.map((p) => (
                  <div key={p.id} className="rounded-lg border p-3 space-y-2 text-sm">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{formatDateTimeGH(p.createdAt)}</span>
                      <span>
                        {String(p.provider || "mtn").toUpperCase()} ·{" "}
                        {p.source === "MANUAL" ? "Manual" : "Provider"}
                      </span>
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
                    <div className="text-xs">
                      {p.posted ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">
                          Posted
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">
                          Unposted
                        </span>
                      )}
                    </div>
                    <div>
                      {(() => {
                        const settlement = p.settlement || "PENDING";
                        const raw = String(p.status || settlement).toUpperCase();
                        const cls = chipToneClass(paymentStatusTone(settlement));
                        return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{raw}</span>;
                      })()}
                      {(p.settlement || "PENDING") === "SETTLED" && !p.posted ? (
                        <div className="text-[11px] text-amber-700 mt-1">Needs posting retry</div>
                      ) : null}
                    </div>
                    {p.providerRef && (p.settlement || "PENDING") === "PENDING" ? (
                      <div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={checkingId === p.id}
                          onClick={() => void checkProviderStatus(p.id)}
                        >
                          {checkingId === p.id ? "Checking..." : "Check status"}
                        </Button>
                      </div>
                    ) : null}
                    {p.canCancel ? (
                      <div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={cancelingId === p.id}
                          onClick={() => void cancelPending(p.id)}
                        >
                          {cancelingId === p.id ? "Canceling..." : "Cancel pending"}
                        </Button>
                      </div>
                    ) : null}
                    {p.canResolveLate ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={resolvingId === p.id}
                          onClick={() => void resolveLateToCredit(p.id)}
                        >
                          {resolvingId === p.id ? "Resolving..." : "Resolve to Credit"}
                        </Button>
                        {p.user?.id ? (
                          <Link
                            href={`/admin/customers?focus=${encodeURIComponent(p.user.id)}`}
                            className="text-xs underline self-center"
                          >
                            Open customer
                          </Link>
                        ) : null}
                      </div>
                    ) : null}
                    {p.canSimulateLate ? (
                      <div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={simulatingId === p.id}
                          onClick={() => void simulateLateSuccess(p.id)}
                        >
                          {simulatingId === p.id ? "Simulating..." : "Simulate Late Success"}
                        </Button>
                      </div>
                    ) : null}
                    {p.canPostNow ? (
                      <div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={postingId === p.id}
                          onClick={() => void postNow(p.id)}
                        >
                          {postingId === p.id ? "Posting..." : "Post now"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
        </CardContent>
      </Card>
    </div>
  );
}
