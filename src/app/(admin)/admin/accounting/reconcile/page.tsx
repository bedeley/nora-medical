"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";

// ── Types ─────────────────────────────────────────────────────────────────────

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
  autoApply: Array<{
    id: string;
    orderId: string | null;
    amount: number;
    createdAt: string;
  }>;
  returns: Array<{
    id: string;
    orderId: string | null;
    amount: number;
    refundDisposition: string | null;
    createdAt: string;
  }>;
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
type DetailTab = "manual" | "autoApply" | "returns";

type ReconcileThresholds = {
  currencyMinorPct: number;
  currencyWarningPct: number;
  marginMinorAbsPct: number;
  marginWarningAbsPct: number;
};

// ── Constants ─────────────────────────────────────────────────────────────────

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

// ── Pure helpers (defined before component) ───────────────────────────────────

function dateToYmdLocal(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toCsvCell(value: unknown) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
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

function deltaColorClass(delta: number, isPercent?: boolean): string {
  const abs = Math.abs(isPercent ? delta : delta);
  if (abs <= 0.01) return "text-muted-foreground";
  return delta < 0 ? "text-red-600 font-medium" : "text-emerald-600 font-medium";
}

function buildDrillLinks(metric: MetricKey, start: string, end: string) {
  const journalParams = new URLSearchParams();
  if (start) journalParams.set("start", start);
  if (end) journalParams.set("end", end);
  const rangeParams = new URLSearchParams();
  if (start) rangeParams.set("start", start);
  if (end) rangeParams.set("end", end);
  const range = rangeParams.toString() ? `?${rangeParams.toString()}` : "";

  if (metric === "totalRevenue") {
    return [
      { label: "Journal (Orders/Payments)", href: `/admin/accounting/journal?${journalParams.toString()}&source=ORDER` },
      { label: "Return Credits", href: `/admin/orders${range}` },
    ];
  }
  if (metric === "totalCOGS") {
    return [
      { label: "Journal (COGS lines)", href: `/admin/accounting/journal?${journalParams.toString()}&accountType=EXPENSE` },
      { label: "Inventory Integrity", href: `/admin/accounting/integrity${range}` },
    ];
  }
  if (metric === "totalExpense") {
    return [
      { label: "Expenses", href: `/admin/expenses${range}` },
      { label: "Journal (Manual)", href: `/admin/accounting/journal?${journalParams.toString()}&source=MANUAL` },
    ];
  }
  if (metric === "profit") {
    return [
      { label: "P&L Report", href: `/admin/accounting/reports/pl${range}` },
      { label: "Reconcile Drivers", href: `/admin/accounting/reconcile${range}` },
    ];
  }
  return [
    { label: "P&L Report", href: `/admin/accounting/reports/pl${range}` },
    { label: "Dashboard", href: `/admin/dashboard${range}` },
  ];
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
): string[] {
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
    notes.push(
      `${input.manualCount} manual journal entr${input.manualCount === 1 ? "y is" : "ies are"} included and may shift ledger-only totals.`,
    );
  }
  if (metric === "totalRevenue" || metric === "profit" || metric === "margin") {
    if (input.returnCount > 0) {
      notes.push(
        `${input.returnCount} return/refund entr${input.returnCount === 1 ? "y was" : "ies were"} found in this range and can reduce net figures.`,
      );
    }
    if (input.autoApplyCount > 0) {
      notes.push(
        `${input.autoApplyCount} store-credit auto-apply entr${input.autoApplyCount === 1 ? "y was" : "ies were"} found and may change payment timing vs order timing.`,
      );
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
  notes.push("Use the drill-down links below to verify source transactions and posted journal lines.");
  return notes;
}

// ── Component ─────────────────────────────────────────────────────────────────

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
  const [activeTab, setActiveTab] = useState<DetailTab>("manual");

  // ── URL sync ───────────────────────────────────────────────────────────────

  const shareablePath = useMemo(() => {
    const sp = new URLSearchParams();
    if (start) sp.set("start", start);
    if (end) sp.set("end", end);
    if (searchText) sp.set("q", searchText);
    if (preset !== "custom") sp.set("preset", preset);
    if (lockActivePeriod) sp.set("lock", "1");
    return `${pathname}${sp.toString() ? `?${sp.toString()}` : ""}`;
  }, [end, lockActivePeriod, pathname, preset, searchText, start]);

  const pushStateToUrl = useCallback(
    (next: { start?: string; end?: string; q?: string; preset?: PresetKey; lock?: boolean }) => {
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
    },
    [end, lockActivePeriod, pathname, preset, router, searchText, start],
  );

  useEffect(() => {
    setStart(searchParams.get("start") || "");
    setEnd(searchParams.get("end") || "");
    setSearchText(searchParams.get("q") || "");
    setPreset((searchParams.get("preset") as PresetKey) || "custom");
    setLockActivePeriod(searchParams.get("lock") === "1");
  }, [searchParams]);

  // ── Data fetching ──────────────────────────────────────────────────────────

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    p.set("groupBy", "day");
    return p.toString();
  }, [start, end]);

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
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.reconcile.thresholds").then((r) => r.json()),
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
        Number.isFinite(warning) && warning >= minor
          ? warning
          : DEFAULT_RECONCILE_THRESHOLDS.currencyWarningPct,
      marginMinorAbsPct:
        Number.isFinite(marginMinor) && marginMinor >= 0
          ? marginMinor
          : DEFAULT_RECONCILE_THRESHOLDS.marginMinorAbsPct,
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
    const currentOpen = open.find(
      (p) => new Date(p.startDate) <= now && new Date(p.endDate) >= now,
    );
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

  // ── Derived state ──────────────────────────────────────────────────────────

  const operationalSummary = useMemo(
    () => operationalQuery.data?.summary || {},
    [operationalQuery.data?.summary],
  );
  const ledgerSummary = useMemo(
    () => ledgerQuery.data?.summary || {},
    [ledgerQuery.data?.summary],
  );
  const reconcile = reconcileQuery.data;
  const isLoading =
    operationalQuery.isLoading || ledgerQuery.isLoading || reconcileQuery.isLoading;
  const hasError =
    operationalQuery.isError ||
    ledgerQuery.isError ||
    reconcileQuery.isError ||
    Boolean(operationalQuery.data?.error || ledgerQuery.data?.error || reconcile?.error);

  const lowerSearch = searchText.trim().toLowerCase();

  const filteredManualEntries = useMemo(() => {
    const rows = reconcile?.manualEntries || [];
    if (!lowerSearch) return rows;
    return rows.filter((entry) => {
      const head = `${entry.id} ${entry.memo || ""} ${entry.entryDate}`.toLowerCase();
      const lineText = entry.lines
        .map((l) => `${l.accountCode} ${l.accountName} ${l.description || ""}`)
        .join(" ")
        .toLowerCase();
      return head.includes(lowerSearch) || lineText.includes(lowerSearch);
    });
  }, [reconcile?.manualEntries, lowerSearch]);

  const filteredAutoApply = useMemo(() => {
    const rows = reconcile?.autoApply || [];
    if (!lowerSearch) return rows;
    return rows.filter((row) =>
      `${row.id} ${row.orderId || ""} ${row.amount} ${row.createdAt}`
        .toLowerCase()
        .includes(lowerSearch),
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

  // Health summary counts
  const healthCounts = useMemo(() => {
    const counts = { ok: 0, minor: 0, warning: 0, critical: 0 };
    for (const row of metrics) {
      const opVal = Number((operationalSummary as Record<string, number>)[row.key] || 0);
      const ldgVal = Number((ledgerSummary as Record<string, number>)[row.key] || 0);
      const delta = ldgVal - opVal;
      const sev = severityForMetric(row.key, delta, opVal, reconcileThresholds);
      counts[sev]++;
    }
    return counts;
  }, [operationalSummary, ledgerSummary, reconcileThresholds]);

  const overallSeverity: Severity = useMemo(() => {
    if (healthCounts.critical > 0) return "critical";
    if (healthCounts.warning > 0) return "warning";
    if (healthCounts.minor > 0) return "minor";
    return "ok";
  }, [healthCounts]);

  // ── Audit ──────────────────────────────────────────────────────────────────

  const postAuditAction = async (
    action:
      | "accounting.reconcile.refresh"
      | "accounting.reconcile.export"
      | "accounting.reconcile.drilldown",
    meta: Record<string, unknown>,
  ) => {
    try {
      await fetch("/api/admin/accounting/reconcile/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, meta: { ...meta, start, end, preset, lockActivePeriod } }),
      });
    } catch {
      // Non-blocking.
    }
  };

  // ── Presets ────────────────────────────────────────────────────────────────

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
    pushStateToUrl({
      start: nextStart,
      end: nextEnd,
      preset: nextPreset,
      lock: nextPreset === "active" ? lockActivePeriod : false,
    });
  };

  // ── Exports ────────────────────────────────────────────────────────────────

  const exportCsv = async () => {
    const lines = ["Metric,Operational,Ledger,Delta,Severity,Notes"];
    for (const metric of metrics) {
      const opVal = Number((operationalSummary as Record<string, number>)[metric.key] || 0);
      const ldgVal = Number((ledgerSummary as Record<string, number>)[metric.key] || 0);
      const delta = ldgVal - opVal;
      const severity = severityForMetric(metric.key, delta, opVal, reconcileThresholds);
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
          metric.isPercent ? `${opVal.toFixed(2)}%` : formatCurrency(opVal),
          metric.isPercent ? `${ldgVal.toFixed(2)}%` : formatCurrency(ldgVal),
          metric.isPercent
            ? `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%`
            : formatCurrency(delta),
          severity.toUpperCase(),
          notes.join(" | "),
        ]
          .map(toCsvCell)
          .join(","),
      );
    }
    lines.push("", "Section,Rows");
    lines.push(["Manual entries", String(filteredManualEntries.length)].map(toCsvCell).join(","));
    lines.push(
      ["Store-credit auto-apply", String(filteredAutoApply.length)].map(toCsvCell).join(","),
    );
    lines.push(
      ["Return credits/refunds", String(filteredReturns.length)].map(toCsvCell).join(","),
    );
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
    toast.success("Reconcile summary CSV exported.");
  };

  const exportDetailsCsv = async () => {
    const lines: string[] = [];
    lines.push("Section,ID,Date,Reference,Amount,Disposition,Notes");
    for (const entry of filteredManualEntries) {
      lines.push(
        ["ManualEntry", entry.id, new Date(entry.entryDate).toISOString(), entry.memo || "", "", "", `${entry.lines.length} line(s)`]
          .map(toCsvCell)
          .join(","),
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
          ]
            .map(toCsvCell)
            .join(","),
        );
      }
    }
    for (const row of filteredAutoApply) {
      lines.push(
        ["StoreCreditAutoApply", row.id, new Date(row.createdAt).toISOString(), row.orderId || "", Number(row.amount || 0).toFixed(2), "", ""]
          .map(toCsvCell)
          .join(","),
      );
    }
    for (const row of filteredReturns) {
      lines.push(
        ["ReturnRefund", row.id, new Date(row.createdAt).toISOString(), row.orderId || "", Number(row.amount || 0).toFixed(2), row.refundDisposition || "", ""]
          .map(toCsvCell)
          .join(","),
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

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <section className="container mx-auto py-8 space-y-4">

      {/* PAGE HEADER */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Operational vs Ledger Reconciliation</h1>
          <p className="text-sm text-muted-foreground">
            Compares business transaction totals{" "}
            <span className="font-medium text-foreground">(Operational)</span> to posted GL
            journal entry totals{" "}
            <span className="font-medium text-foreground">(Ledger)</span>. A positive delta means
            Ledger &gt; Operational; a negative delta means Operational &gt; Ledger.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {activePeriod ? (
              <Badge variant="secondary">
                Active period: {activePeriod.name} (
                {dateToYmdLocal(new Date(activePeriod.startDate))} →{" "}
                {dateToYmdLocal(new Date(activePeriod.endDate))})
                {lockActivePeriod ? " · locked" : ""}
              </Badge>
            ) : (
              <Badge variant="outline">No active accounting period</Badge>
            )}
            <Badge variant="outline" className="text-xs font-normal">
              {lastRefreshedAt
                ? `Refreshed ${lastRefreshedAt.toLocaleTimeString()}`
                : "Not yet refreshed"}
            </Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={exportCsv}>
            Export Summary CSV
          </Button>
          <Button size="sm" variant="outline" onClick={exportDetailsCsv}>
            Export Details CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                const origin = window.location.origin;
                const fullUrl = `${origin}${shareablePath}`;
                await navigator.clipboard.writeText(fullUrl);
                const display =
                  fullUrl.length > 80 ? `${fullUrl.slice(0, 77)}…` : fullUrl;
                toast.success(`Share link copied: ${display}`);
              } catch {
                toast.error("Failed to copy link.");
              }
            }}
          >
            Copy share link
          </Button>
          <Button
            size="sm"
            variant="outline"
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
        </div>
      </div>

      {/* FILTER BAR */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="recon-start" className="text-xs text-muted-foreground font-normal">
                Start date
              </Label>
              <Input
                id="recon-start"
                className="w-full sm:w-auto"
                type="date"
                value={start}
                disabled={lockActivePeriod}
                onChange={(e) => {
                  const value = e.target.value;
                  setStart(value);
                  setPreset("custom");
                  if (lockActivePeriod) setLockActivePeriod(false);
                  pushStateToUrl({ start: value, preset: "custom", lock: false });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="recon-end" className="text-xs text-muted-foreground font-normal">
                End date
              </Label>
              <Input
                id="recon-end"
                className="w-full sm:w-auto"
                type="date"
                value={end}
                disabled={lockActivePeriod}
                onChange={(e) => {
                  const value = e.target.value;
                  setEnd(value);
                  setPreset("custom");
                  if (lockActivePeriod) setLockActivePeriod(false);
                  pushStateToUrl({ end: value, preset: "custom", lock: false });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="recon-search" className="text-xs text-muted-foreground font-normal">
                Search driver details
              </Label>
              <Input
                id="recon-search"
                className="w-full sm:w-[260px]"
                placeholder="Search IDs, memos, accounts…"
                value={searchText}
                onChange={(e) => {
                  const value = e.target.value;
                  setSearchText(value);
                  pushStateToUrl({ q: value });
                }}
              />
            </div>
          </div>

          {/* Quick presets */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Quick presets:</span>
            <Button
              size="sm"
              variant={preset === "today" ? "default" : "outline"}
              onClick={() => applyPreset("today")}
            >
              Today
            </Button>
            <Button
              size="sm"
              variant={preset === "last7" ? "default" : "outline"}
              onClick={() => applyPreset("last7")}
            >
              Last 7 days
            </Button>
            <Button
              size="sm"
              variant={preset === "month" ? "default" : "outline"}
              onClick={() => applyPreset("month")}
            >
              This month
            </Button>
            {activePeriod ? (
              <Button
                size="sm"
                variant={preset === "active" ? "default" : "outline"}
                onClick={() => applyPreset("active")}
              >
                Active period
              </Button>
            ) : (
              <Tooltip content="No active accounting period is configured.">
                <Button size="sm" variant="outline" disabled>
                  Active period
                </Button>
              </Tooltip>
            )}
            {activePeriod ? (
              <Button
                size="sm"
                variant={lockActivePeriod ? "default" : "outline"}
                onClick={() => {
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
              >
                {lockActivePeriod ? "Unlock period" : "Lock to active period"}
              </Button>
            ) : null}
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
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ERROR BANNER */}
      {hasError ? (
        <Card className="border-red-300 bg-red-50">
          <CardContent className="pt-4 space-y-2 text-sm text-red-800">
            <p className="font-medium">
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

      {/* HEALTH SUMMARY BANNER */}
      {!isLoading && !hasError ? (
        <div
          className={`flex flex-wrap items-center gap-3 rounded-md border px-4 py-3 text-sm ${
            overallSeverity === "critical"
              ? "border-red-300 bg-red-50 text-red-900"
              : overallSeverity === "warning"
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : overallSeverity === "minor"
                  ? "border-sky-300 bg-sky-50 text-sky-900"
                  : "border-emerald-300 bg-emerald-50 text-emerald-900"
          }`}
        >
          <span className="font-medium">
            {overallSeverity === "ok"
              ? "All metrics reconciled — no material variance detected."
              : `Variance detected — review highlighted metrics below.`}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {healthCounts.ok > 0 && <Badge variant="success">{healthCounts.ok} OK</Badge>}
            {healthCounts.minor > 0 && (
              <Badge variant="outline">{healthCounts.minor} Minor</Badge>
            )}
            {healthCounts.warning > 0 && (
              <Badge variant="warning">{healthCounts.warning} Warning</Badge>
            )}
            {healthCounts.critical > 0 && (
              <Badge variant="destructive">{healthCounts.critical} Critical</Badge>
            )}
          </div>
        </div>
      ) : null}

      {/* TOTALS VARIANCE TABLE */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <CardTitle>Totals variance</CardTitle>
            <p className="text-xs text-muted-foreground max-w-md">
              Delta = Ledger − Operational. Green = Ledger &gt; Operational; red = Operational &gt;
              Ledger.
              {reconcileThresholds.currencyMinorPct !== DEFAULT_RECONCILE_THRESHOLDS.currencyMinorPct ||
              reconcileThresholds.currencyWarningPct !== DEFAULT_RECONCILE_THRESHOLDS.currencyWarningPct ? (
                <> Thresholds: Minor &lt;{(reconcileThresholds.currencyMinorPct * 100).toFixed(1)}%,
                  Warning &lt;{(reconcileThresholds.currencyWarningPct * 100).toFixed(1)}% (custom).</>
              ) : (
                <> Default thresholds: Minor &lt;1%, Warning &lt;5%.</>
              )}
            </p>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <div className="px-6 space-y-2">
              {metrics.map((m) => (
                <Skeleton key={m.key} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Metric</TableHead>
                  <TableHead className="text-right">Operational</TableHead>
                  <TableHead className="text-right">Ledger</TableHead>
                  <TableHead className="text-right">Delta</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Drill-down</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {metrics.map((row) => {
                  const opVal = Number(
                    (operationalSummary as Record<string, number>)[row.key] || 0,
                  );
                  const ldgVal = Number(
                    (ledgerSummary as Record<string, number>)[row.key] || 0,
                  );
                  const delta = ldgVal - opVal;
                  const severity = severityForMetric(
                    row.key,
                    delta,
                    opVal,
                    reconcileThresholds,
                  );
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
                    <React.Fragment key={row.key}>
                      <TableRow
                        className={
                          severity === "critical"
                            ? "bg-red-50/40"
                            : severity === "warning"
                              ? "bg-amber-50/40"
                              : undefined
                        }
                      >
                        <TableCell className="font-medium">{row.label}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.isPercent ? `${opVal.toFixed(2)}%` : formatCurrency(opVal)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {row.isPercent ? `${ldgVal.toFixed(2)}%` : formatCurrency(ldgVal)}
                        </TableCell>
                        <TableCell
                          className={`text-right tabular-nums ${deltaColorClass(delta, row.isPercent)}`}
                        >
                          {row.isPercent
                            ? `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%`
                            : delta >= 0
                              ? `+${formatCurrency(delta)}`
                              : formatCurrency(delta)}
                        </TableCell>
                        <TableCell>{severityBadge(severity)}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-3 text-xs">
                            {links.map((link) => (
                              <Link
                                key={link.href}
                                href={link.href}
                                className="text-blue-600 hover:underline whitespace-nowrap"
                                onClick={() =>
                                  void postAuditAction("accounting.reconcile.drilldown", {
                                    metric: row.key,
                                    target: link.href,
                                  })
                                }
                              >
                                {link.label}
                              </Link>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setExpandedMetric((curr) =>
                                curr === row.key ? null : row.key,
                              )
                            }
                          >
                            {expandedMetric === row.key ? "Close" : "Why?"}
                          </Button>
                        </TableCell>
                      </TableRow>
                      {expandedMetric === row.key ? (
                        <TableRow key={`${row.key}-why`} className="bg-muted/20">
                          <TableCell
                            colSpan={7}
                            className="p-4 whitespace-normal text-xs space-y-1"
                          >
                            <p className="font-medium text-sm mb-2">Likely drivers — {row.label}</p>
                            {whyNotes.map((note, idx) => (
                              <p key={`${row.key}-n-${idx}`} className="text-muted-foreground">
                                {note}
                              </p>
                            ))}
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* RECONCILIATION DRIVERS — single tabbed card */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Reconciliation drivers</CardTitle>
            <p className="text-xs text-muted-foreground">
              Items below commonly explain gaps between Operational and Ledger totals.
              {searchText.trim()
                ? ` Filtered by "${searchText.trim()}" across all three sections.`
                : ""}
            </p>
          </div>
          {/* Tab bar */}
          <div className="mt-2 flex gap-1 border-b">
            {(
              [
                {
                  key: "manual" as DetailTab,
                  label: "Manual Entries",
                  count: filteredManualEntries.length,
                },
                {
                  key: "autoApply" as DetailTab,
                  label: "Store Credit Auto-Apply",
                  count: filteredAutoApply.length,
                },
                {
                  key: "returns" as DetailTab,
                  label: "Returns & Refunds",
                  count: filteredReturns.length,
                },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.key
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab.label}
                <span
                  className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs ${
                    tab.count > 0
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
        </CardHeader>

        <CardContent className="px-0 text-sm">
          {isLoading ? (
            <div className="px-6 space-y-2 pt-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (
            <>
              {/* Manual entries tab */}
              {activeTab === "manual" ? (
                filteredManualEntries.length === 0 ? (
                  <div className="px-6 py-8 text-center text-muted-foreground">
                    <p>No manual journal entries found in this range.</p>
                    <p className="text-xs mt-1">
                      Manual entries post directly to the ledger without a matching operational
                      transaction, which is the most common source of Operational vs Ledger gaps.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3 px-6 pt-2">
                    {filteredManualEntries.map((entry) => (
                      <div key={entry.id} className="rounded-md border overflow-hidden">
                        <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/20 px-3 py-2">
                          <div className="font-medium text-sm">
                            {new Date(entry.entryDate).toLocaleDateString()} —{" "}
                            {entry.memo || "Manual entry"}
                          </div>
                          <Link
                            href={`/admin/accounting/journal?entryId=${encodeURIComponent(entry.id)}`}
                            className="text-xs text-blue-600 hover:underline font-mono"
                            onClick={() =>
                              void postAuditAction("accounting.reconcile.drilldown", {
                                metric: "manual",
                                target: entry.id,
                              })
                            }
                          >
                            {entry.id.slice(0, 10)}…
                          </Link>
                        </div>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Account</TableHead>
                              <TableHead className="text-right">Debit</TableHead>
                              <TableHead className="text-right">Credit</TableHead>
                              <TableHead>Description</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {entry.lines.map((line) => (
                              <TableRow key={line.id}>
                                <TableCell>
                                  {line.accountCode} · {line.accountName}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {Number(line.debit || 0) > 0
                                    ? formatCurrency(line.debit)
                                    : "—"}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {Number(line.credit || 0) > 0
                                    ? formatCurrency(line.credit)
                                    : "—"}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                  {line.description || "—"}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ))}
                  </div>
                )
              ) : null}

              {/* Store credit auto-apply tab */}
              {activeTab === "autoApply" ? (
                filteredAutoApply.length === 0 ? (
                  <div className="px-6 py-8 text-center text-muted-foreground">
                    <p>No store-credit auto-apply entries found in this range.</p>
                    <p className="text-xs mt-1">
                      Auto-apply entries can shift revenue recognition timing between periods.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>ID</TableHead>
                        <TableHead>Order</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredAutoApply.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            {new Date(row.createdAt).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {row.id.slice(0, 10)}…
                          </TableCell>
                          <TableCell>
                            {row.orderId ? (
                              <Link
                                href={`/admin/orders/${encodeURIComponent(row.orderId)}`}
                                className="text-blue-600 hover:underline text-xs"
                              >
                                {row.orderId.slice(0, 10)}…
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-medium">
                            {formatCurrency(row.amount)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              ) : null}

              {/* Returns tab */}
              {activeTab === "returns" ? (
                filteredReturns.length === 0 ? (
                  <div className="px-6 py-8 text-center text-muted-foreground">
                    <p>No return or refund entries found in this range.</p>
                    <p className="text-xs mt-1">
                      Returns and refunds reduce net revenue and can create timing differences
                      between operational and ledger figures.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>ID</TableHead>
                        <TableHead>Order</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>Disposition</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredReturns.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>
                            {new Date(row.createdAt).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {row.id.slice(0, 10)}…
                          </TableCell>
                          <TableCell>
                            {row.orderId ? (
                              <Link
                                href={`/admin/orders/${encodeURIComponent(row.orderId)}`}
                                className="text-blue-600 hover:underline text-xs"
                              >
                                {row.orderId.slice(0, 10)}…
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-medium">
                            {formatCurrency(row.amount)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {row.refundDisposition ? (
                              <Badge variant="outline">{row.refundDisposition}</Badge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
