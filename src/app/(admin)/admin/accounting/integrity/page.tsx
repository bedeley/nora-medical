"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useClientQuery } from "@/hooks/use-client-query";
import { formatCurrency } from "@/lib/currency";
import { buildRetryTargets, explainPostingFailure, summarizeAgingBuckets, type RetryTarget } from "@/lib/accounting-integrity";

const formatDisplayCurrency = (value?: number) => formatCurrency(Math.abs(value ?? 0) < 0.01 ? 0 : value ?? 0);
const toCsvCell = (value: unknown) => {
  const raw = String(value ?? "");
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, "\"\"")}"`;
  return raw;
};
const ageDaysSince = (createdAt: string) => {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((Date.now() - created) / 86_400_000));
};

type IntegrityResponse = {
  draftEntries: number;
  arLedger: number;
  customerBalances: number;
  arDifference: number;
  inventoryLedger: number;
  inventoryValuation: number;
  inventoryDifference: number;
  negativeStockCount: number;
  missingPostings?: Record<string, number>;
  missingPostingItems?: {
    orders: Array<{ id: string; invoiceNumber: string | null; total: number; status: string; createdAt: string }>;
    payments: Array<{ id: string; amount: number; status: string | null; createdAt: string; postingFailure?: { action: string; reason?: string; meta?: Record<string, unknown> | null } | null }>;
    expenses: Array<{ id: string; amount: number; createdAt: string }>;
    purchases: Array<{ id: string; quantity: number; unitCost: number; status: string; createdAt: string }>;
    supplierPayments: Array<{ id: string; amount: number; createdAt: string }>;
    creditPayouts: Array<{ id: string; amount: number; createdAt: string }>;
    settlements: Array<{ id: string; totalBalance: number; createdAt: string }>;
  };
  recentPostFailures?: Array<{ id: string; action: string; entityType: string; entityId: string; meta: string | null; createdAt: string }>;
};

type ThresholdConfig = { arDifference: number; inventoryDifference: number; draftEntries: boolean; negativeStock: boolean };
type IntegrityAcknowledgement = { id: string; asOf: string; createdAt: string; actor?: string; warningSignature: string; warningKeys: string[]; note: string };
type PrecheckRow = { ok: boolean; entityType: string; entityId: string; source?: string; reason?: string; periodName?: string };

const sourceMeta: Record<string, { label: string; link: (id: string) => string; type: RetryTarget["entityType"] }> = {
  orders: { label: "Orders", link: (id) => `/admin/orders/${id}`, type: "ORDER" },
  payments: { label: "Payments", link: (id) => `/admin/payments?id=${id}`, type: "PAYMENT" },
  expenses: { label: "Expenses", link: (id) => `/admin/expenses?q=${id}`, type: "EXPENSE" },
  purchases: { label: "Purchases", link: (id) => `/admin/purchases?purchaseId=${id}`, type: "PURCHASE" },
  supplierPayments: { label: "Supplier payments", link: (id) => `/admin/supplier-payments?paymentId=${id}`, type: "SUPPLIER_PAYMENT" },
  creditPayouts: { label: "Store-credit cash payouts", link: (id) => `/admin/payments?id=${id}`, type: "CREDIT_PAYOUT" },
  settlements: { label: "Delivery settlements", link: () => "/admin/delivery/reconciliation/settlements", type: "DELIVERY_SETTLEMENT" },
};

export default function AccountingIntegrityPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: sessionData } = useSession();
  const role = String((sessionData?.user as { role?: string } | undefined)?.role || "");
  const canPostNow = role === "ADMIN" || role === "ACCOUNTANT";
  const canHighImpact = role === "ADMIN";

  const [asOf, setAsOf] = useState(searchParams.get("asOf") || new Date().toISOString().slice(0, 10));
  const [onlyProblems, setOnlyProblems] = useState(searchParams.get("problems") === "1");
  const [itemSearch, setItemSearch] = useState(searchParams.get("q") || "");
  const [pinnedSource, setPinnedSource] = useState(searchParams.get("source") || "all");
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showBlockedOnly, setShowBlockedOnly] = useState(false);
  const [ackDialogOpen, setAckDialogOpen] = useState(false);
  const [ackNote, setAckNote] = useState("Reviewed and triaged");
  const [ackBusy, setAckBusy] = useState(false);
  const [precheckBusy, setPrecheckBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [retryingKey, setRetryingKey] = useState("");
  const [precheckResult, setPrecheckResult] = useState<{ total: number; ready: number; blocked: number; rows: PrecheckRow[] } | null>(null);
  const [bulkResult, setBulkResult] = useState<{ total: number; posted: number; skipped: number; rows: Array<{ source?: string; entityType: string; entityId: string; posted: boolean; skipped: boolean; reason?: string }> } | null>(null);

  useEffect(() => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("asOf", asOf);
    if (onlyProblems) sp.set("problems", "1"); else sp.delete("problems");
    if (itemSearch.trim()) sp.set("q", itemSearch.trim()); else sp.delete("q");
    if (pinnedSource !== "all") sp.set("source", pinnedSource); else sp.delete("source");
    const next = sp.toString();
    if (next !== searchParams.toString()) router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
  }, [asOf, onlyProblems, itemSearch, pinnedSource, searchParams, pathname, router]);

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set("asOf", asOf);
    return sp.toString();
  }, [asOf]);
  const todayYmd = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const asOfIsStale = Boolean(asOf && asOf < todayYmd);

  const { data: prefData } = useClientQuery<{ value: ThresholdConfig | null }>({
    queryKey: ["accounting", "integrity-thresholds", "global"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.integrity.thresholds").then((r) => r.json()),
  });
  const thresholds: ThresholdConfig = useMemo(
    () => ({
      arDifference: prefData?.value?.arDifference ?? 0.01,
      inventoryDifference: prefData?.value?.inventoryDifference ?? 0.01,
      draftEntries: prefData?.value?.draftEntries ?? true,
      negativeStock: prefData?.value?.negativeStock ?? true,
    }),
    [prefData?.value],
  );

  const { data, isLoading, isFetching, isError, error, refetch } = useClientQuery<IntegrityResponse>({
    queryKey: ["accounting", "integrity", "asOf", asOf],
    queryFn: async () => {
      const res = await fetch(`/api/admin/accounting/integrity?${params}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "Failed to load integrity checks.");
      return payload as IntegrityResponse;
    },
  });
  const { data: ackData, refetch: refetchAck } = useClientQuery<{ value: IntegrityAcknowledgement[] | null }>({
    queryKey: ["accounting", "integrity-acknowledgements"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.integrity.acknowledgements").then((r) => r.json()),
  });
  const { data: lastSyncData, refetch: refetchLastSync } = useClientQuery<{ value: { at?: string; by?: string } | null }>({
    queryKey: ["accounting", "integrity-last-sync"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.integrity.lastSync").then((r) => r.json()),
  });

  const acknowledgements = useMemo(() => (Array.isArray(ackData?.value) ? ackData.value : []), [ackData?.value]);
  const missingPostingTotal = useMemo(() => Object.values(data?.missingPostings || {}).reduce((sum, n) => sum + Number(n || 0), 0), [data?.missingPostings]);
  const searchNeedle = itemSearch.trim().toLowerCase();
  const filteredRecentFailures = useMemo(() => {
    const rows = data?.recentPostFailures || [];
    if (!searchNeedle) return rows;
    return rows.filter((row) => [row.entityType, row.entityId, row.action, row.meta].some((value) => String(value || "").toLowerCase().includes(searchNeedle)));
  }, [data?.recentPostFailures, searchNeedle]);

  const filteredMissingItems = useMemo(() => {
    const items = data?.missingPostingItems;
    if (!items) return null;
    if (!searchNeedle) return items;
    const includes = (value: unknown) => String(value ?? "").toLowerCase().includes(searchNeedle);
    return {
      orders: items.orders.filter((row) => [row.id, row.invoiceNumber, row.status].some(includes)),
      payments: items.payments.filter((row) => [row.id, row.status, row.postingFailure?.reason].some(includes)),
      expenses: items.expenses.filter((row) => [row.id].some(includes)),
      purchases: items.purchases.filter((row) => [row.id, row.status].some(includes)),
      supplierPayments: items.supplierPayments.filter((row) => [row.id].some(includes)),
      creditPayouts: items.creditPayouts.filter((row) => [row.id].some(includes)),
      settlements: items.settlements.filter((row) => [row.id].some(includes)),
    };
  }, [data?.missingPostingItems, searchNeedle]);

  const visibleRetryTargets = useMemo(() => buildRetryTargets(filteredMissingItems, pinnedSource), [filteredMissingItems, pinnedSource]);
  const agingRows = useMemo(() => {
    if (!filteredMissingItems) return [] as Array<{ createdAt: string }>;
    const sources = pinnedSource === "all" ? Object.keys(sourceMeta) : [pinnedSource];
    return sources.flatMap((source) => (filteredMissingItems as Record<string, Array<{ createdAt: string }>>)[source] || []);
  }, [filteredMissingItems, pinnedSource]);
  const agingSummary = useMemo(() => summarizeAgingBuckets(agingRows), [agingRows]);

  const warningRows = useMemo(() => ([
    { key: "draft_entries", label: "Draft entries", value: Number(data?.draftEntries || 0), warn: thresholds.draftEntries && Number(data?.draftEntries || 0) > 0, href: "/admin/accounting/journal?status=DRAFT" },
    { key: "ar_difference", label: "AR difference", value: Number(data?.arDifference || 0), warn: Math.abs(Number(data?.arDifference || 0)) > thresholds.arDifference, href: "/admin/orders" },
    { key: "inventory_difference", label: "Inventory difference", value: Number(data?.inventoryDifference || 0), warn: Math.abs(Number(data?.inventoryDifference || 0)) > thresholds.inventoryDifference, href: "/admin/accounting/inventory-valuation" },
    { key: "negative_stock", label: "Negative stock", value: Number(data?.negativeStockCount || 0), warn: thresholds.negativeStock && Number(data?.negativeStockCount || 0) > 0, href: "/admin/products" },
    { key: "missing_postings", label: "Missing postings", value: missingPostingTotal, warn: missingPostingTotal > 0, href: "/admin/accounting/integrity?source=all" },
    { key: "recent_failures", label: "Recent posting failures", value: Number(filteredRecentFailures.length || 0), warn: Number(filteredRecentFailures.length || 0) > 0, href: "/admin/accounting/integrity?source=failures" },
  ]), [data, thresholds, missingPostingTotal, filteredRecentFailures.length]);
  const activeWarningKeys = useMemo(() => warningRows.filter((row) => row.warn).map((row) => `${row.key}:${row.value}`).sort(), [warningRows]);
  const warningSignature = useMemo(() => activeWarningKeys.join("|"), [activeWarningKeys]);
  const latestAck = acknowledgements[0] || null;
  const isCurrentWarningAcknowledged = Boolean(latestAck && latestAck.warningSignature === warningSignature && latestAck.asOf === asOf);

  const callActions = async (body: unknown) => {
    const res = await fetch("/api/admin/accounting/integrity/actions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "Action failed.");
    return payload as Record<string, unknown>;
  };

  const runSync = async () => {
    if (!canHighImpact) return toast.error("Only ADMIN can run ledger sync.");
    setSyncing(true);
    try {
      const res = await fetch("/api/admin/accounting/sync", { method: "POST" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || "Failed to sync accounting.");
      await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.integrity.lastSync",
          value: { at: new Date().toISOString(), by: role || "UNKNOWN" },
        }),
      });
      await refetchLastSync();
      toast.success("Accounting sync complete.");
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to sync accounting.");
    } finally {
      setSyncing(false);
    }
  };

  const runPrecheckVisible = async () => {
    if (!visibleRetryTargets.length) return toast.error("No visible retry targets."), null;
    setPrecheckBusy(true);
    try {
      const payload = await callActions({ action: "precheck", targets: visibleRetryTargets });
      const result = {
        total: Number((payload.summary as { total?: number } | undefined)?.total || 0),
        ready: Number((payload.summary as { ready?: number } | undefined)?.ready || 0),
        blocked: Number((payload.summary as { blocked?: number } | undefined)?.blocked || 0),
        rows: Array.isArray(payload.rows) ? (payload.rows as PrecheckRow[]) : [],
      };
      setPrecheckResult(result);
      if (result.blocked > 0) setShowBlockedOnly(true);
      return result;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Precheck failed.");
      return null;
    } finally {
      setPrecheckBusy(false);
    }
  };

  const postAllVisible = async () => {
    if (!canHighImpact) return toast.error("Only ADMIN can run bulk retry.");
    if (showBlockedOnly) return toast.error("Turn off 'Show blocked only' before posting ready rows.");
    if (!visibleRetryTargets.length) return toast.error("No visible retry targets.");
    setBulkBusy(true);
    try {
      const precheck = await runPrecheckVisible();
      if (!precheck) return;
      if (precheck.blocked > 0) return toast.error(`Bulk retry blocked: ${precheck.blocked} row(s) failed safeguards.`);
      const readySet = new Set(precheck.rows.filter((row) => row.ok).map((row) => `${row.entityType}:${row.entityId}`));
      const readyTargets = visibleRetryTargets.filter((target) => readySet.has(`${target.entityType}:${target.entityId}`));
      const payload = await callActions({ action: "bulkRetry", targets: readyTargets });
      const result = {
        total: Number((payload.summary as { total?: number } | undefined)?.total || 0),
        posted: Number((payload.summary as { posted?: number } | undefined)?.posted || 0),
        skipped: Number((payload.summary as { skipped?: number } | undefined)?.skipped || 0),
        rows: Array.isArray(payload.rows) ? (payload.rows as Array<{ source?: string; entityType: string; entityId: string; posted: boolean; skipped: boolean; reason?: string }>) : [],
      };
      setBulkResult(result);
      toast.success(`Bulk retry finished. Posted ${result.posted}, skipped ${result.skipped}.`);
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bulk retry failed.");
    } finally {
      setBulkBusy(false);
    }
  };

  const retryPostNow = async (target: RetryTarget) => {
    if (!canPostNow) return toast.error("You do not have permission to post.");
    const key = `${target.entityType}:${target.entityId}`;
    setRetryingKey(key);
    try {
      await callActions({ action: "retryPost", entityType: target.entityType, entityId: target.entityId, source: target.source });
      toast.success("Posting retry complete.");
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Retry failed.");
    } finally {
      setRetryingKey("");
    }
  };

  const acknowledge = async () => {
    if (!activeWarningKeys.length) return toast.error("No active warnings to acknowledge.");
    if (!ackNote.trim()) return toast.error("Acknowledgement note is required.");
    setAckBusy(true);
    try {
      await callActions({ action: "acknowledgeWarnings", asOf, warningKeys: activeWarningKeys, note: ackNote.trim() });
      await refetchAck();
      toast.success("Warnings acknowledged.");
      setAckDialogOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to acknowledge warnings.");
    } finally {
      setAckBusy(false);
    }
  };

  const clearAck = async () => {
    setAckBusy(true);
    try {
      await callActions({ action: "clearAcknowledgement", asOf });
      await refetchAck();
      toast.success("Acknowledgement cleared.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to clear acknowledgement.");
    } finally {
      setAckBusy(false);
    }
  };

  const exportFailuresCsv = () => {
    if (!filteredRecentFailures.length) return toast.error("No posting failures to export.");
    const lines = [["createdAt", "entityType", "entityId", "action", "reason", "hint"].join(",")];
    for (const row of filteredRecentFailures) {
      const details = explainPostingFailure({ action: row.action, reason: row.meta, meta: row.meta });
      lines.push([new Date(row.createdAt).toISOString(), row.entityType, row.entityId, row.action, details.reason, details.hint].map(toCsvCell).join(","));
    }
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `integrity-failures-${asOf}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportMissingSampleCsv = () => {
    if (!filteredMissingItems) return toast.error("No missing postings sample to export.");
    const lines = [["source", "entityType", "entityId", "createdAt"].join(",")];
    for (const [source, cfg] of Object.entries(sourceMeta)) {
      for (const row of (filteredMissingItems as Record<string, Array<{ id: string; createdAt: string }>>)[source] || []) {
        lines.push([source, cfg.type, row.id, row.createdAt].map(toCsvCell).join(","));
      }
    }
    if (lines.length <= 1) return toast.error("No missing postings sample rows to export.");
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `integrity-missing-sample-${asOf}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportPrecheckCsv = () => {
    const rows = showBlockedOnly ? (precheckResult?.rows || []).filter((row) => !row.ok) : precheckResult?.rows || [];
    if (!rows.length) return toast.error("No precheck rows to export.");
    const lines = [["source", "entityType", "entityId", "ok", "reason", "periodName"].join(",")];
    for (const row of rows) lines.push([row.source || "", row.entityType, row.entityId, row.ok ? "yes" : "no", row.reason || "", row.periodName || ""].map(toCsvCell).join(","));
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `integrity-precheck-${asOf}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportRetryCsv = () => {
    if (!bulkResult?.rows?.length) return toast.error("No retry rows to export.");
    const lines = [["source", "entityType", "entityId", "posted", "skipped", "reason"].join(",")];
    for (const row of bulkResult.rows) lines.push([row.source || "", row.entityType, row.entityId, row.posted ? "yes" : "no", row.skipped ? "yes" : "no", row.reason || ""].map(toCsvCell).join(","));
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `integrity-retry-${asOf}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const renderAgeBadge = (createdAt: string) => {
    const days = ageDaysSince(createdAt);
    if (days >= 8) return <Badge variant="destructive">{days}d overdue</Badge>;
    if (days >= 3) return <Badge variant="warning">{days}d aging</Badge>;
    return <Badge variant="success">{days}d</Badge>;
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Data Integrity</h1>
        <p className="text-sm text-muted-foreground">Quick checks to spot accounting inconsistencies.</p>
      </div>
      <Card>
        <CardHeader><CardTitle>Checks</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid gap-2 md:grid-cols-4">
            <label className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">As of date</span><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
            <label className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Search issue IDs, refs, notes...</span><Input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="Search..." /></label>
            <label className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Pinned source</span><select className="h-10 rounded-md border bg-background px-2 text-sm" value={pinnedSource} onChange={(e) => setPinnedSource(e.target.value)}><option value="all">all</option><option value="orders">orders</option><option value="payments">payments</option><option value="expenses">expenses</option><option value="purchases">purchases</option><option value="supplierPayments">supplier payments</option><option value="creditPayouts">credit payouts</option><option value="settlements">settlements</option><option value="failures">posting failures</option></select></label>
            <label className="flex items-end gap-2"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /><span>Show problems only</span></label>
          </div>
          <div className="flex flex-wrap gap-2">
            {asOfIsStale ? (
              <Button size="sm" variant="secondary" onClick={() => setAsOf(todayYmd)} title="Reset As of date to today.">
                Use today
              </Button>
            ) : null}
            <Button asChild size="sm" variant="outline"><a href={`/admin/accounting/inventory-valuation?asOf=${encodeURIComponent(asOf)}`} title="Open inventory valuation page to post an adjustment entry for this date.">Post inventory adjustment</a></Button>
            <Button size="sm" variant="outline" onClick={() => setSyncOpen(true)} disabled={syncing || !canHighImpact} title="Run full accounting sync and backfill missing ledger postings.">{syncing ? "Syncing..." : "Sync ledger"}</Button>
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching} title="Refresh integrity checks using current filters.">{isFetching ? "Refreshing..." : "Recalculate"}</Button>
            <Button asChild size="sm" variant="outline"><a href={`/api/admin/accounting/integrity/export?${params}`} title="Download full integrity report for the selected As of date.">Export CSV</a></Button>
            <Button
              size="sm"
              variant="outline"
              onClick={exportMissingSampleCsv}
              title="Download visible missing-posting sample rows for this filtered view."
            >
              Export missing sample CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={exportFailuresCsv}
              disabled={!filteredRecentFailures.length}
              title="Download visible posting-failure rows with normalized reason and next-step hint."
            >
              Export failures CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={runPrecheckVisible}
              disabled={precheckBusy || !visibleRetryTargets.length}
              title="Run safeguards on visible retry rows before any posting attempt."
            >
              {precheckBusy ? "Running precheck..." : `Run retry precheck (${visibleRetryTargets.length})`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={postAllVisible}
              disabled={bulkBusy || !visibleRetryTargets.length || !canHighImpact}
              title="Bulk retry post visible rows. Blocks when safeguards find any blocked rows."
            >
              {bulkBusy ? "Posting..." : `Post all visible (${visibleRetryTargets.length})`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={exportPrecheckCsv}
              disabled={!precheckResult?.rows?.length}
              title="Download the latest precheck results (ready/blocked + reason)."
            >
              Export precheck CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={exportRetryCsv}
              disabled={!bulkResult?.rows?.length}
              title="Download the latest bulk retry results (posted/skipped + reason)."
            >
              Export retry CSV
            </Button>
            <Button
              size="sm"
              variant={isCurrentWarningAcknowledged ? "secondary" : "outline"}
              onClick={() => setAckDialogOpen(true)}
              disabled={ackBusy || !activeWarningKeys.length}
              title="Record that the current warning set was reviewed with an operator note."
            >
              {ackBusy ? "Saving..." : isCurrentWarningAcknowledged ? "Warnings acknowledged" : "Acknowledge warnings"}
            </Button>
            <Button size="sm" variant="ghost" onClick={clearAck} disabled={ackBusy} title="Remove acknowledgement for the current As of date warning set.">Clear acknowledgement</Button>
          </div>
          <div className="text-xs text-muted-foreground">
            Last successful sync: {lastSyncData?.value?.at ? `${new Date(lastSyncData.value.at).toLocaleString()} (${lastSyncData?.value?.by || "unknown"})` : "not recorded yet"}.
            {!canHighImpact ? " Sync ledger and bulk retry are ADMIN-only actions." : ""}
          </div>
          {asOfIsStale ? (
            <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
              This view is filtered as of {asOf}. Newer transactions and posting gaps after this date are hidden.
            </div>
          ) : null}
          {latestAck ? (
            <div className="rounded border bg-muted/20 p-2 text-xs text-muted-foreground">
              Latest acknowledgement: {new Date(String(latestAck.createdAt || "")).toLocaleString()} by {String(latestAck.actor || "Unknown")}.
              {latestAck.note ? ` Note: ${latestAck.note}` : ""}
            </div>
          ) : null}
          {isError ? <div className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">{error instanceof Error ? error.message : "Failed to load integrity checks."}</div> : null}
          {precheckResult ? (
            <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              Safeguards precheck: total {precheckResult.total}, ready {precheckResult.ready}, blocked {precheckResult.blocked}.
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Button size="sm" variant={showBlockedOnly ? "default" : "outline"} className="h-7" onClick={() => setShowBlockedOnly((prev) => !prev)} title="Toggle filter to show only blocked precheck rows and reasons.">
                  {showBlockedOnly ? "Showing blocked only" : "Show blocked only"}
                </Button>
                {showBlockedOnly ? (
                  <span className="text-amber-900/80">
                    Blocked rows are filtered into retry/export actions.
                  </span>
                ) : null}
              </div>
              {(showBlockedOnly ? precheckResult.rows.filter((row) => !row.ok) : precheckResult.rows)
                .slice(0, 8)
                .map((row) => (
                  <div key={`${row.entityType}:${row.entityId}`} className="mt-1">
                    {row.source || "source"} - {row.entityType} {row.entityId}: {row.ok ? "ready" : row.reason || "blocked"}
                    {row.periodName ? ` (${row.periodName})` : ""}
                  </div>
                ))}
            </div>
          ) : null}
          {bulkResult ? <div className="rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900">Bulk retry result: total {bulkResult.total}, posted {bulkResult.posted}, skipped {bulkResult.skipped}.</div> : null}
          {isLoading ? <p className="text-muted-foreground">Loading checks...</p> : null}
          {!isLoading && !isError ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-md border px-3 py-2"><div className="text-xs text-muted-foreground">Warnings triggered</div><div className="text-lg font-semibold">{activeWarningKeys.length}</div></div>
                <div className="rounded-md border px-3 py-2"><div className="text-xs text-muted-foreground">Missing postings</div><div className="text-lg font-semibold">{missingPostingTotal}</div></div>
                <div className="rounded-md border px-3 py-2"><div className="text-xs text-muted-foreground">Recent post failures</div><div className="text-lg font-semibold">{filteredRecentFailures.length}</div></div>
                <div className="rounded-md border px-3 py-2"><div className="text-xs text-muted-foreground">Focused mode</div><div className="text-lg font-semibold">{onlyProblems ? "Problems only" : "All checks"}</div></div>
              </div>
              <div className="rounded-md border px-3 py-2"><div className="mb-2 text-xs font-semibold text-muted-foreground">Severity by signal</div><div className="grid gap-2 sm:grid-cols-2">{warningRows.filter((row) => !onlyProblems || row.warn).map((row) => <div key={row.key} className="flex items-center justify-between rounded border p-2 text-xs"><div><div className="font-medium">{row.label}</div><div className="text-muted-foreground">{row.value}</div></div><div className="flex items-center gap-2">{row.warn ? <Badge variant="warning">Warning</Badge> : <Badge variant="success">OK</Badge>}<a href={row.href} className="underline">Open source</a></div></div>)}</div></div>
              <div className="space-y-1">
                <div className="flex justify-between"><span>Draft journal entries</span><span>{data?.draftEntries ?? 0}</span></div>
                <div className="flex justify-between"><span>AR ledger balance</span><span>{formatDisplayCurrency(data?.arLedger)}</span></div>
                <div className="flex justify-between"><span>Customer balances total</span><span>{formatDisplayCurrency(data?.customerBalances)}</span></div>
                <div className="flex justify-between"><span>AR difference</span><span>{formatDisplayCurrency(data?.arDifference)}</span></div>
                <div className="flex justify-between"><span>Inventory ledger balance</span><span>{formatDisplayCurrency(data?.inventoryLedger)}</span></div>
                <div className="flex justify-between"><span>Inventory valuation (stock x cost)</span><span>{formatDisplayCurrency(data?.inventoryValuation)}</span></div>
                <div className="flex justify-between"><span>Inventory difference</span><span>{formatDisplayCurrency(data?.inventoryDifference)}</span></div>
                <div className="flex justify-between"><span>Products with negative stock</span><span>{data?.negativeStockCount ?? 0}</span></div>
              </div>
              <div className="rounded border px-3 py-2 text-xs">
                <div className="mb-2 font-semibold text-muted-foreground">Ledger readiness</div>
                <div className="grid gap-1 sm:grid-cols-2">
                  <div className="flex justify-between"><span>Orders missing postings</span><span>{Number(data?.missingPostings?.orders || 0)}</span></div>
                  <div className="flex justify-between"><span>Payments missing postings</span><span>{Number(data?.missingPostings?.payments || 0)}</span></div>
                  <div className="flex justify-between"><span>Expenses missing postings</span><span>{Number(data?.missingPostings?.expenses || 0)}</span></div>
                  <div className="flex justify-between"><span>Purchases missing postings</span><span>{Number(data?.missingPostings?.purchases || 0)}</span></div>
                  <div className="flex justify-between"><span>Supplier payments missing postings</span><span>{Number(data?.missingPostings?.supplierPayments || 0)}</span></div>
                  <div className="flex justify-between"><span>Credit payouts missing postings</span><span>{Number(data?.missingPostings?.creditPayouts || 0)}</span></div>
                  <div className="flex justify-between"><span>Settlements missing postings</span><span>{Number(data?.missingPostings?.settlements || 0)}</span></div>
                </div>
              </div>
              <div className="rounded border bg-muted/20 p-2 text-xs text-muted-foreground">Aging SLA: {agingSummary.fresh} fresh, {agingSummary.warning} warning, {agingSummary.overdue} overdue.</div>
              {data?.missingPostingItems ? <div className="mt-3 border-t pt-3"><div className="text-xs font-semibold text-muted-foreground mb-2">Missing postings (sample)</div><div className="space-y-3 text-xs">{Object.entries(sourceMeta).filter(([source]) => pinnedSource === "all" || pinnedSource === source).map(([source, cfg]) => { const rows = (filteredMissingItems as Record<string, Array<{ id: string; createdAt: string }>> | null)?.[source] || []; if (!rows.length) return null; return <div key={source}><div className="font-medium mb-1">{cfg.label}</div><div className="space-y-1">{rows.map((row) => { const retryKey = `${cfg.type}:${row.id}`; const details = source === "payments" ? explainPostingFailure({ action: (filteredMissingItems as NonNullable<IntegrityResponse["missingPostingItems"]>).payments.find((x) => x.id === row.id)?.postingFailure?.action, reason: (filteredMissingItems as NonNullable<IntegrityResponse["missingPostingItems"]>).payments.find((x) => x.id === row.id)?.postingFailure?.reason, meta: null }) : null; return <div key={row.id} className="flex flex-wrap items-center gap-2">{renderAgeBadge(row.createdAt)}<a href={cfg.link(row.id)} className="underline">{row.id}</a>{details ? <span className="text-muted-foreground">{details.reason}: {details.hint}</span> : null}<Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => retryPostNow({ entityType: cfg.type, entityId: row.id, source })} disabled={retryingKey === retryKey || !canPostNow} title="Retry posting for this specific source row only.">{retryingKey === retryKey ? "Posting..." : "Post now"}</Button></div>; })}</div></div>; })}{!visibleRetryTargets.length ? <div className="text-muted-foreground">No missing postings found.</div> : null}</div></div> : null}
              {filteredRecentFailures.length ? <div className="mt-3 border-t pt-3"><div className="text-xs font-semibold text-muted-foreground mb-2">Recent posting failures</div><div className="space-y-2 text-xs">{filteredRecentFailures.map((row) => { const details = explainPostingFailure({ action: row.action, reason: row.meta, meta: row.meta }); return <div key={row.id} className="flex flex-wrap items-center gap-2">{renderAgeBadge(row.createdAt)}<span>{row.entityType} {row.entityId}</span><span className="text-muted-foreground">{details.reason}: {details.hint}</span></div>; })}</div></div> : null}
            </>
          ) : null}
        </CardContent>
      </Card>
      <Dialog open={syncOpen} onOpenChange={setSyncOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-base font-semibold">Sync ledger</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">This will backfill missing journal entries and post inventory valuation adjustment when needed.</p>
          <div className="flex justify-end gap-2 pt-4"><Button variant="secondary" onClick={() => setSyncOpen(false)} title="Close this dialog without running sync.">Cancel</Button><Button onClick={async () => { await runSync(); setSyncOpen(false); }} disabled={!canHighImpact} title="Confirm and run the full ledger sync now.">Run sync</Button></div>
        </DialogContent>
      </Dialog>
      <Dialog open={ackDialogOpen} onOpenChange={setAckDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Acknowledge warnings</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Add a short note describing what you checked and next action.
            </p>
            <Input
              value={ackNote}
              onChange={(e) => setAckNote(e.target.value)}
              placeholder="Reviewed and assigned to finance"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setAckDialogOpen(false)} disabled={ackBusy} title="Close without saving acknowledgement.">
              Cancel
            </Button>
            <Button onClick={acknowledge} disabled={ackBusy || !ackNote.trim()} title="Save acknowledgement with this note for current warnings.">
              {ackBusy ? "Saving..." : "Save acknowledgement"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
