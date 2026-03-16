"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";

type SummaryResponse = {
  summary?: {
    totalRevenue: number;
    totalRefunds: number;
    netRevenue: number;
    totalCOGS: number;
    totalExpense: number;
    profit: number;
    margin: number;
  };
  error?: string;
};

type LedgerSummaryResponse = {
  summary?: {
    totalRevenue: number;
    totalCOGS: number;
    totalExpense: number;
    profit: number;
    margin: number;
  };
  error?: string;
};

type ReconcileResponse = {
  manualEntries: Array<{
    id: string;
    entryDate: string;
    memo: string | null;
    lines: Array<{
      id: string;
      accountCode: string;
      accountName: string;
      accountType: string;
      debit: number;
      credit: number;
      description: string | null;
    }>;
  }>;
  autoApply: Array<{ id: string; orderId: string | null; amount: number; createdAt: string }>;
  returns: Array<{ id: string; orderId: string | null; amount: number; refundDisposition: string | null; createdAt: string }>;
  error?: string;
};

type FiscalPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED" | string;
};

type MetricKey = "totalRevenue" | "totalCOGS" | "totalExpense" | "profit" | "margin";
type PresetKey = "custom" | "today" | "last7" | "month" | "active";
type Severity = "ok" | "minor" | "warning" | "critical";
type ReconcileThresholds = {
  currencyMinorPct: number;
  currencyWarningPct: number;
  marginMinorAbsPct: number;
  marginWarningAbsPct: number;
};

const metrics: Array<{ key: MetricKey; label: string; isPercent?: boolean }> = [
  { key: "totalRevenue", label: "Revenue" },
  { key: "totalCOGS", label: "COGS" },
  { key: "totalExpense", label: "Expenses" },
  { key: "profit", label: "Net Profit" },
  { key: "margin", label: "Margin %", isPercent: true },
];
const DEFAULT_RECONCILE_THRESHOLDS: ReconcileThresholds = {
  currencyMinorPct: 0.01,
  currencyWarningPct: 0.05,
  marginMinorAbsPct: 0.1,
  marginWarningAbsPct: 0.5,
};

function dateToYmdLocal(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toCsvCell(value: unknown) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

function severityForMetric(
  metric: MetricKey,
  delta: number,
  operationalValue: number,
  thresholds: ReconcileThresholds,
): Severity {
  const absDelta = Math.abs(delta);
  if (metric === "margin") {
    if (absDelta <= thresholds.marginMinorAbsPct) return "ok";
    if (absDelta <= thresholds.marginWarningAbsPct) return "minor";
    if (absDelta <= thresholds.marginWarningAbsPct * 3) return "warning";
    return "critical";
  }
  if (absDelta <= 0.01) return "ok";
  const base = Math.max(Math.abs(operationalValue), 1);
  const pct = absDelta / base;
  if (pct <= thresholds.currencyMinorPct) return "minor";
  if (pct <= thresholds.currencyWarningPct) return "warning";
  return "critical";
}

function severityBadge(severity: Severity) {
  if (severity === "ok") return <Badge variant="success">OK</Badge>;
  if (severity === "minor") return <Badge variant="outline">Minor</Badge>;
  if (severity === "warning") return <Badge variant="warning">Warning</Badge>;
  return <Badge variant="destructive">Critical</Badge>;
}

function buildDrillLinks(metric: MetricKey, start: string, end: string) {
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  const range = params.toString() ? `?${params.toString()}` : "";
  const journalParams = new URLSearchParams();
  if (start) journalParams.set("start", start);
  if (end) journalParams.set("end", end);

  if (metric === "totalRevenue") {
    return [
      { label: "Open Journal (Orders/Payments)", href: `/admin/accounting/journal?${journalParams.toString()}&source=ORDER` },
      { label: "Open Return Credits", href: `/admin/orders${range}` },
    ];
  }
  if (metric === "totalCOGS") {
    return [
      { label: "Open Journal (COGS lines)", href: `/admin/accounting/journal?${journalParams.toString()}&accountType=EXPENSE` },
      { label: "Open Inventory Integrity", href: `/admin/accounting/integrity${range}` },
    ];
  }
  if (metric === "totalExpense") {
    return [
      { label: "Open Expenses", href: `/admin/expenses${range}` },
      { label: "Open Journal (Manual)", href: `/admin/accounting/journal?${journalParams.toString()}&source=MANUAL` },
    ];
  }
  if (metric === "profit") {
    return [
      { label: "Open P&L Report", href: `/admin/accounting/reports/pl${range}` },
      { label: "Open Reconcile Drivers", href: `/admin/accounting/reconcile${range}` },
    ];
  }
  return [
    { label: "Open P&L Report", href: `/admin/accounting/reports/pl${range}` },
    { label: "Open Dashboard", href: `/admin/dashboard${range}` },
  ];
}

export default function AccountingReconcilePage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [start, setStart] = useState(searchParams.get("start") || "");
  const [end, setEnd] = useState(searchParams.get("end") || "");
  const [searchText, setSearchText] = useState(searchParams.get("q") || "");
  const [preset, setPreset] = useState<PresetKey>((searchParams.get("preset") as PresetKey) || "custom");
  const [lockActivePeriod, setLockActivePeriod] = useState(searchParams.get("lock") === "1");
  const [expandedMetric, setExpandedMetric] = useState<MetricKey | null>(null);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    p.set("groupBy", "day");
    return p.toString();
  }, [start, end]);

  const shareablePath = useMemo(() => {
    const sp = new URLSearchParams();
    if (start) sp.set("start", start);
    if (end) sp.set("end", end);
    if (searchText) sp.set("q", searchText);
    if (preset !== "custom") sp.set("preset", preset);
    if (lockActivePeriod) sp.set("lock", "1");
    return `${pathname}${sp.toString() ? `?${sp.toString()}` : ""}`;
  }, [end, lockActivePeriod, pathname, preset, searchText, start]);

  const pushStateToUrl = useCallback((
    next: {
      start?: string;
      end?: string;
      q?: string;
      preset?: PresetKey;
      lock?: boolean;
    },
  ) => {
    const sp = new URLSearchParams();
    const nextStart = next.start ?? start;
    const nextEnd = next.end ?? end;
    const nextQ = next.q ?? searchText;
    const nextPreset = next.preset ?? preset;
    const nextLock = next.lock ?? lockActivePeriod;

    if (nextStart) sp.set("start", nextStart);
    if (nextEnd) sp.set("end", nextEnd);
    if (nextQ) sp.set("q", nextQ);
    if (nextPreset !== "custom") sp.set("preset", nextPreset);
    if (nextLock) sp.set("lock", "1");
    router.replace(sp.toString() ? `${pathname}?${sp.toString()}` : pathname, { scroll: false });
  }, [end, lockActivePeriod, pathname, preset, router, searchText, start]);

  useEffect(() => {
    setStart(searchParams.get("start") || "");
    setEnd(searchParams.get("end") || "");
    setSearchText(searchParams.get("q") || "");
    setPreset((searchParams.get("preset") as PresetKey) || "custom");
    setLockActivePeriod(searchParams.get("lock") === "1");
  }, [searchParams]);

  const operationalQuery = useClientQuery<SummaryResponse>({
    queryKey: ["accounting", "reconcile", "operational", queryString],
    queryFn: () => fetch(`/api/admin/summary?${queryString}`).then((r) => r.json()),
  });
  const ledgerQuery = useClientQuery<LedgerSummaryResponse>({
    queryKey: ["accounting", "reconcile", "ledger", queryString],
    queryFn: () => fetch(`/api/admin/accounting/reports/ledger-summary?${queryString}`).then((r) => r.json()),
  });
  const reconcileQuery = useClientQuery<ReconcileResponse>({
    queryKey: ["accounting", "reconcile", "details", queryString],
    queryFn: () => fetch(`/api/admin/accounting/reconcile?${queryString}`).then((r) => r.json()),
  });
  const periodsQuery = useClientQuery<FiscalPeriod[]>({
    queryKey: ["accounting", "periods"],
    queryFn: () => fetch("/api/admin/accounting/periods").then((r) => r.json()),
  });
  const reconcileThresholdsQuery = useClientQuery<{ value: ReconcileThresholds | null }>({
    queryKey: ["accounting", "reconcile-thresholds"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.reconcile.thresholds").then((r) => r.json()),
  });
  const reconcileThresholds = useMemo<ReconcileThresholds>(() => {
    const value = reconcileThresholdsQuery.data?.value;
    if (!value) return DEFAULT_RECONCILE_THRESHOLDS;
    const minor = Number(value.currencyMinorPct ?? DEFAULT_RECONCILE_THRESHOLDS.currencyMinorPct);
    const warning = Number(value.currencyWarningPct ?? DEFAULT_RECONCILE_THRESHOLDS.currencyWarningPct);
    const marginMinor = Number(value.marginMinorAbsPct ?? DEFAULT_RECONCILE_THRESHOLDS.marginMinorAbsPct);
    const marginWarning = Number(value.marginWarningAbsPct ?? DEFAULT_RECONCILE_THRESHOLDS.marginWarningAbsPct);
    return {
      currencyMinorPct: Number.isFinite(minor) && minor >= 0 ? minor : DEFAULT_RECONCILE_THRESHOLDS.currencyMinorPct,
      currencyWarningPct:
        Number.isFinite(warning) && warning >= minor ? warning : DEFAULT_RECONCILE_THRESHOLDS.currencyWarningPct,
      marginMinorAbsPct:
        Number.isFinite(marginMinor) && marginMinor >= 0 ? marginMinor : DEFAULT_RECONCILE_THRESHOLDS.marginMinorAbsPct,
      marginWarningAbsPct:
        Number.isFinite(marginWarning) && marginWarning >= marginMinor
          ? marginWarning
          : DEFAULT_RECONCILE_THRESHOLDS.marginWarningAbsPct,
    };
  }, [reconcileThresholdsQuery.data?.value]);
  const lastRefreshedAt = useMemo(() => {
    const latest = Math.max(
      operationalQuery.dataUpdatedAt || 0,
      ledgerQuery.dataUpdatedAt || 0,
      reconcileQuery.dataUpdatedAt || 0,
    );
    return latest > 0 ? new Date(latest) : null;
  }, [ledgerQuery.dataUpdatedAt, operationalQuery.dataUpdatedAt, reconcileQuery.dataUpdatedAt]);

  const activePeriod = useMemo(() => {
    const periods = Array.isArray(periodsQuery.data) ? periodsQuery.data : [];
    if (periods.length === 0) return null;
    const now = new Date();
    const open = periods.filter((p) => p.status === "OPEN");
    const currentOpen = open.find((p) => new Date(p.startDate) <= now && new Date(p.endDate) >= now);
    return currentOpen || open[0] || periods[0];
  }, [periodsQuery.data]);

  useEffect(() => {
    if (!lockActivePeriod || !activePeriod) return;
    const periodStart = dateToYmdLocal(new Date(activePeriod.startDate));
    const periodEnd = dateToYmdLocal(new Date(activePeriod.endDate));
    if (start !== periodStart || end !== periodEnd) {
      setStart(periodStart);
      setEnd(periodEnd);
      setPreset("active");
      pushStateToUrl({ start: periodStart, end: periodEnd, preset: "active", lock: true });
    }
  }, [activePeriod, lockActivePeriod, start, end, pushStateToUrl]);

  const operationalSummary = operationalQuery.data?.summary || {};
  const ledgerSummary = ledgerQuery.data?.summary || {};
  const reconcile = reconcileQuery.data;

  const lowerSearch = searchText.trim().toLowerCase();
  const filteredManualEntries = useMemo(() => {
    const rows = reconcile?.manualEntries || [];
    if (!lowerSearch) return rows;
    return rows.filter((entry) => {
      const head = `${entry.id} ${entry.memo || ""} ${entry.entryDate}`.toLowerCase();
      const lineText = entry.lines
        .map((line) => `${line.accountCode} ${line.accountName} ${line.description || ""}`)
        .join(" ")
        .toLowerCase();
      return head.includes(lowerSearch) || lineText.includes(lowerSearch);
    });
  }, [reconcile?.manualEntries, lowerSearch]);

  const filteredAutoApply = useMemo(() => {
    const rows = reconcile?.autoApply || [];
    if (!lowerSearch) return rows;
    return rows.filter((row) =>
      `${row.id} ${row.orderId || ""} ${row.amount} ${row.createdAt}`.toLowerCase().includes(lowerSearch),
    );
  }, [reconcile?.autoApply, lowerSearch]);

  const filteredReturns = useMemo(() => {
    const rows = reconcile?.returns || [];
    if (!lowerSearch) return rows;
    return rows.filter((row) =>
      `${row.id} ${row.orderId || ""} ${row.amount} ${row.refundDisposition || ""} ${row.createdAt}`
        .toLowerCase()
        .includes(lowerSearch),
    );
  }, [reconcile?.returns, lowerSearch]);

  const postAuditAction = async (action: "accounting.reconcile.refresh" | "accounting.reconcile.export" | "accounting.reconcile.drilldown", meta: Record<string, unknown>) => {
    try {
      await fetch("/api/admin/accounting/reconcile/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, meta: { ...meta, start, end, preset, lockActivePeriod } }),
      });
    } catch {
      // Non-blocking audit call.
    }
  };

  const applyPreset = (nextPreset: PresetKey) => {
    const now = new Date();
    let nextStart = "";
    let nextEnd = "";
    if (nextPreset === "today") {
      nextStart = dateToYmdLocal(now);
      nextEnd = dateToYmdLocal(now);
    } else if (nextPreset === "last7") {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      nextStart = dateToYmdLocal(d);
      nextEnd = dateToYmdLocal(now);
    } else if (nextPreset === "month") {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      nextStart = dateToYmdLocal(d);
      nextEnd = dateToYmdLocal(now);
    } else if (nextPreset === "active" && activePeriod) {
      nextStart = dateToYmdLocal(new Date(activePeriod.startDate));
      nextEnd = dateToYmdLocal(new Date(activePeriod.endDate));
    }
    setPreset(nextPreset);
    setStart(nextStart);
    setEnd(nextEnd);
    if (nextPreset !== "active" && lockActivePeriod) setLockActivePeriod(false);
    pushStateToUrl({ start: nextStart, end: nextEnd, preset: nextPreset, lock: nextPreset === "active" ? lockActivePeriod : false });
  };

  const exportCsv = async () => {
    const lines = [
      "Metric,Operational,Ledger,Delta,Severity,Notes",
    ];
    for (const metric of metrics) {
      const operationalValue = Number((operationalSummary as Record<string, number>)[metric.key] || 0);
      const ledgerValue = Number((ledgerSummary as Record<string, number>)[metric.key] || 0);
      const delta = ledgerValue - operationalValue;
      const severity = severityForMetric(metric.key, delta, operationalValue, reconcileThresholds);
      const notes = buildWhyNotes(metric.key, {
        delta,
        severity,
        isPercent: Boolean(metric.isPercent),
        manualCount: reconcile?.manualEntries?.length || 0,
        autoApplyCount: reconcile?.autoApply?.length || 0,
        returnCount: reconcile?.returns?.length || 0,
      });
      lines.push(
        [
          metric.label,
          metric.isPercent ? `${operationalValue.toFixed(2)}%` : formatCurrency(operationalValue),
          metric.isPercent ? `${ledgerValue.toFixed(2)}%` : formatCurrency(ledgerValue),
          metric.isPercent ? `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%` : formatCurrency(delta),
          severity.toUpperCase(),
          notes.join(" | "),
        ].map(toCsvCell).join(","),
      );
    }
    lines.push("");
    lines.push("Section,Rows");
    lines.push(["Manual entries", String(filteredManualEntries.length)].map(toCsvCell).join(","));
    lines.push(["Store-credit auto-apply", String(filteredAutoApply.length)].map(toCsvCell).join(","));
    lines.push(["Return credits/refunds", String(filteredReturns.length)].map(toCsvCell).join(","));

    const blob = new Blob(["\uFEFF", lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `accounting-reconcile-${start || "all"}-${end || "all"}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    await postAuditAction("accounting.reconcile.export", {
      filterSearch: searchText.trim() || null,
      exportedRows: {
        manualEntries: filteredManualEntries.length,
        autoApply: filteredAutoApply.length,
        returns: filteredReturns.length,
      },
    });
    toast.success("Reconcile CSV exported.");
  };

  const exportDetailsCsv = async () => {
    const lines: string[] = [];
    lines.push("Section,ID,Date,Reference,Amount,Disposition,Notes");
    for (const entry of filteredManualEntries) {
      lines.push(
        [
          "ManualEntry",
          entry.id,
          new Date(entry.entryDate).toISOString(),
          entry.memo || "",
          "",
          "",
          `${entry.lines.length} line(s)`,
        ].map(toCsvCell).join(","),
      );
      for (const line of entry.lines) {
        lines.push(
          [
            "ManualEntryLine",
            line.id,
            new Date(entry.entryDate).toISOString(),
            `${line.accountCode} ${line.accountName}`,
            "",
            "",
            `Dr ${Number(line.debit || 0).toFixed(2)} | Cr ${Number(line.credit || 0).toFixed(2)} | ${line.description || ""}`.trim(),
          ].map(toCsvCell).join(","),
        );
      }
    }
    for (const row of filteredAutoApply) {
      lines.push(
        [
          "StoreCreditAutoApply",
          row.id,
          new Date(row.createdAt).toISOString(),
          row.orderId || "",
          Number(row.amount || 0).toFixed(2),
          "",
          "",
        ].map(toCsvCell).join(","),
      );
    }
    for (const row of filteredReturns) {
      lines.push(
        [
          "ReturnRefund",
          row.id,
          new Date(row.createdAt).toISOString(),
          row.orderId || "",
          Number(row.amount || 0).toFixed(2),
          row.refundDisposition || "",
          "",
        ].map(toCsvCell).join(","),
      );
    }

    const blob = new Blob(["\uFEFF", lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `accounting-reconcile-details-${start || "all"}-${end || "all"}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    await postAuditAction("accounting.reconcile.export", {
      exportType: "details",
      filterSearch: searchText.trim() || null,
      exportedRows: {
        manualEntries: filteredManualEntries.length,
        autoApply: filteredAutoApply.length,
        returns: filteredReturns.length,
      },
    });
    toast.success("Reconcile details CSV exported.");
  };

  const hasError =
    operationalQuery.isError ||
    ledgerQuery.isError ||
    reconcileQuery.isError ||
    Boolean(operationalQuery.data?.error || ledgerQuery.data?.error || reconcile?.error);
  const isLoading =
    operationalQuery.isLoading ||
    ledgerQuery.isLoading ||
    reconcileQuery.isLoading;

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Operational vs Ledger Reconcile</h1>
        <p className="text-sm text-muted-foreground">
          Compare operational totals to ledger totals, check variance severity, and drill into likely drivers.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Start date</span>
              <Input
                className="w-full sm:w-auto"
                type="date"
                value={start}
                onChange={(e) => {
                  const value = e.target.value;
                  setStart(value);
                  setPreset("custom");
                  if (lockActivePeriod) setLockActivePeriod(false);
                  pushStateToUrl({ start: value, preset: "custom", lock: false });
                }}
                disabled={lockActivePeriod}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">End date</span>
              <Input
                className="w-full sm:w-auto"
                type="date"
                value={end}
                onChange={(e) => {
                  const value = e.target.value;
                  setEnd(value);
                  setPreset("custom");
                  if (lockActivePeriod) setLockActivePeriod(false);
                  pushStateToUrl({ end: value, preset: "custom", lock: false });
                }}
                disabled={lockActivePeriod}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Search details</span>
              <Input
                className="w-full sm:w-[260px]"
                placeholder="Search IDs, memos, accounts..."
                value={searchText}
                onChange={(e) => {
                  const value = e.target.value;
                  setSearchText(value);
                  pushStateToUrl({ q: value });
                }}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={async () => {
                await Promise.all([
                  operationalQuery.refetch(),
                  ledgerQuery.refetch(),
                  reconcileQuery.refetch(),
                ]);
                await postAuditAction("accounting.reconcile.refresh", {
                  filterSearch: searchText.trim() || null,
                });
                toast.success("Reconcile data refreshed.");
              }}
            >
              Refresh
            </Button>
            <Button size="sm" className="w-full sm:w-auto" onClick={exportCsv}>
              Export reconcile CSV
            </Button>
            <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={exportDetailsCsv}>
              Export details CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={async () => {
                try {
                  const origin = window.location.origin;
                  await navigator.clipboard.writeText(`${origin}${shareablePath}`);
                  toast.success("Share link copied.");
                } catch {
                  toast.error("Failed to copy link.");
                }
              }}
            >
              Copy share link
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Quick presets:</span>
            <Button size="sm" variant={preset === "today" ? "default" : "outline"} onClick={() => applyPreset("today")}>Today</Button>
            <Button size="sm" variant={preset === "last7" ? "default" : "outline"} onClick={() => applyPreset("last7")}>Last 7 days</Button>
            <Button size="sm" variant={preset === "month" ? "default" : "outline"} onClick={() => applyPreset("month")}>This month</Button>
            <Button
              size="sm"
              variant={preset === "active" ? "default" : "outline"}
              onClick={() => applyPreset("active")}
              disabled={!activePeriod}
            >
              Active period
            </Button>
            <Button
              size="sm"
              variant={lockActivePeriod ? "default" : "outline"}
              onClick={() => {
                if (!activePeriod) return;
                const next = !lockActivePeriod;
                setLockActivePeriod(next);
                if (next) {
                  const s = dateToYmdLocal(new Date(activePeriod.startDate));
                  const e = dateToYmdLocal(new Date(activePeriod.endDate));
                  setStart(s);
                  setEnd(e);
                  setPreset("active");
                  pushStateToUrl({ start: s, end: e, preset: "active", lock: true });
                } else {
                  pushStateToUrl({ lock: false });
                }
              }}
              disabled={!activePeriod}
            >
              {lockActivePeriod ? "Unlock period" : "Lock to active period"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setStart("");
                setEnd("");
                setSearchText("");
                setPreset("custom");
                setLockActivePeriod(false);
                pushStateToUrl({ start: "", end: "", q: "", preset: "custom", lock: false });
              }}
            >
              Clear filters
            </Button>
          </div>
          {activePeriod ? (
            <p className="text-xs text-muted-foreground">
              Active period: {activePeriod.name} ({dateToYmdLocal(new Date(activePeriod.startDate))} to {dateToYmdLocal(new Date(activePeriod.endDate))})
              {lockActivePeriod ? " - locked" : ""}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">No active accounting period found.</p>
          )}
          <p className="text-xs text-muted-foreground">
            Last refreshed: {lastRefreshedAt ? lastRefreshedAt.toLocaleString() : "Not refreshed yet"}
          </p>
        </CardContent>
      </Card>

      {hasError ? (
        <Card>
          <CardHeader>
            <CardTitle>Reconcile load issue</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-red-700">
              Failed to load one or more reconcile sections. Retry after confirming your date range.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                operationalQuery.refetch();
                ledgerQuery.refetch();
                reconcileQuery.refetch();
              }}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Totals variance</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading reconcile totals...</div>
          ) : (
            <div className="grid gap-2 text-sm">
              <div className="hidden rounded-md border bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground lg:grid lg:grid-cols-6">
                <div>Metric</div>
                <div>Operational</div>
                <div>Ledger</div>
                <div>Delta</div>
                <div>Status</div>
                <div>Actions</div>
              </div>
              {metrics.map((row) => {
                const operationalValue = Number((operationalSummary as Record<string, number>)[row.key] || 0);
                const ledgerValue = Number((ledgerSummary as Record<string, number>)[row.key] || 0);
                const delta = ledgerValue - operationalValue;
                const severity = severityForMetric(row.key, delta, operationalValue, reconcileThresholds);
                const links = buildDrillLinks(row.key, start, end);
                const whyNotes = buildWhyNotes(row.key, {
                  delta,
                  severity,
                  isPercent: Boolean(row.isPercent),
                  manualCount: reconcile?.manualEntries?.length || 0,
                  autoApplyCount: reconcile?.autoApply?.length || 0,
                  returnCount: reconcile?.returns?.length || 0,
                });

                return (
                  <div key={row.key} className="rounded-md border p-3">
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6 items-center">
                      <div className="font-medium">{row.label}</div>
                      <div>{row.isPercent ? `${operationalValue.toFixed(2)}%` : formatCurrency(operationalValue)}</div>
                      <div>{row.isPercent ? `${ledgerValue.toFixed(2)}%` : formatCurrency(ledgerValue)}</div>
                      <div className="text-muted-foreground">
                        {row.isPercent
                          ? `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%`
                          : formatCurrency(delta)}
                      </div>
                      <div>{severityBadge(severity)}</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setExpandedMetric((curr) => (curr === row.key ? null : row.key))}
                        >
                          Why different?
                        </Button>
                        <Link
                          href={links[0].href}
                          className="text-xs underline"
                          onClick={() => {
                            void postAuditAction("accounting.reconcile.drilldown", {
                              metric: row.key,
                              target: links[0].href,
                            });
                          }}
                        >
                          {links[0].label}
                        </Link>
                      </div>
                    </div>
                    {expandedMetric === row.key ? (
                      <div className="mt-3 space-y-2 rounded-md bg-muted/30 p-3 text-xs">
                        <div className="font-medium">Likely drivers</div>
                        {whyNotes.map((note, idx) => (
                          <div key={`${row.key}-note-${idx}`}>{note}</div>
                        ))}
                        <div className="flex flex-wrap gap-3 pt-1">
                          {links.map((link) => (
                            <Link
                              key={`${row.key}-${link.href}`}
                              href={link.href}
                              className="underline"
                              onClick={() => {
                                void postAuditAction("accounting.reconcile.drilldown", {
                                  metric: row.key,
                                  target: link.href,
                                });
                              }}
                            >
                              {link.label}
                            </Link>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Manual journal entries in range ({filteredManualEntries.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {isLoading ? (
            <div className="text-muted-foreground">Loading manual entries...</div>
          ) : filteredManualEntries.length ? (
            filteredManualEntries.map((entry) => (
              <div key={entry.id} className="border rounded-md p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">
                    {new Date(entry.entryDate).toLocaleDateString()} - {entry.memo || "Manual entry"}
                  </div>
                  <div className="text-xs text-muted-foreground">ID: {entry.id}</div>
                </div>
                <div className="grid gap-2 text-xs">
                  {entry.lines.map((line) => (
                    <div key={line.id} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      <div>{line.accountCode} - {line.accountName}</div>
                      <div>Dr {formatCurrency(line.debit || 0)}</div>
                      <div>Cr {formatCurrency(line.credit || 0)}</div>
                      <div className="text-muted-foreground">{line.description || "-"}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="text-muted-foreground">
              {searchText.trim() ? "No manual entries match your search." : "No manual journal entries found."}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Store credit auto-apply entries ({filteredAutoApply.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {isLoading ? (
            <div className="text-muted-foreground">Loading auto-apply entries...</div>
          ) : filteredAutoApply.length ? (
            filteredAutoApply.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 border rounded-md px-3 py-2">
                <span>
                  {new Date(row.createdAt).toLocaleDateString()} - {formatCurrency(row.amount)}
                </span>
                <span className="text-xs text-muted-foreground">Order: {row.orderId || "-"}</span>
              </div>
            ))
          ) : (
            <div className="text-muted-foreground">
              {searchText.trim() ? "No auto-apply entries match your search." : "No auto-apply entries found."}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Return credits/refunds ({filteredReturns.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {isLoading ? (
            <div className="text-muted-foreground">Loading return entries...</div>
          ) : filteredReturns.length ? (
            filteredReturns.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 border rounded-md px-3 py-2">
                <span>
                  {new Date(row.createdAt).toLocaleDateString()} - {formatCurrency(row.amount)} - {row.refundDisposition || "-"}
                </span>
                <span className="text-xs text-muted-foreground">Order: {row.orderId || "-"}</span>
              </div>
            ))
          ) : (
            <div className="text-muted-foreground">
              {searchText.trim() ? "No return entries match your search." : "No return entries found."}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function buildWhyNotes(
  metric: MetricKey,
  input: {
    delta: number;
    severity: Severity;
    isPercent: boolean;
    manualCount: number;
    autoApplyCount: number;
    returnCount: number;
  },
) {
  const notes: string[] = [];
  if (input.severity === "ok") {
    notes.push(
      input.isPercent
        ? "No material variance detected for this metric in the selected range."
        : `No material variance detected (${formatCurrency(input.delta)}).`,
    );
  } else {
    notes.push(
      input.isPercent
        ? `Variance detected (${input.delta >= 0 ? "+" : ""}${input.delta.toFixed(2)}%).`
        : `Variance detected (${formatCurrency(input.delta)}).`,
    );
  }
  if (input.manualCount > 0) {
    notes.push(`${input.manualCount} manual journal entr${input.manualCount === 1 ? "y is" : "ies are"} included and may shift ledger-only totals.`);
  }
  if (metric === "totalRevenue" || metric === "profit" || metric === "margin") {
    if (input.returnCount > 0) {
      notes.push(`${input.returnCount} return/refund entr${input.returnCount === 1 ? "y was" : "ies were"} found in this range and can reduce net figures.`);
    }
    if (input.autoApplyCount > 0) {
      notes.push(`${input.autoApplyCount} store-credit auto-apply entr${input.autoApplyCount === 1 ? "y was" : "ies were"} found and may change payment timing vs order timing.`);
    }
  }
  if (metric === "totalCOGS") {
    notes.push("Inventory valuation timing, late receipts, or adjustments can move COGS between periods.");
  }
  if (metric === "totalExpense") {
    notes.push("Accrual vs cash timing and manual expense journals commonly explain expense deltas.");
  }
  if (notes.length === 0) {
    notes.push("No major explanatory signals were detected in this sample.");
  }
  notes.push("Use drill-down links to verify source transactions and posted journal lines for this date range.");
  return notes;
}
