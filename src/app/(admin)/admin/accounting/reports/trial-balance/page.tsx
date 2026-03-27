"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";

type AccountRow = {
  accountId: string;
  code: string;
  name: string;
  openingDebit: number;
  openingCredit: number;
  movementDebit: number;
  movementCredit: number;
  closingDebit: number;
  closingCredit: number;
  unusualBalance: boolean;
  patternSeverity?: "FLAG" | "INFO" | "NONE";
  patternNote?: string | null;
  type: string;
};

type TrialBalanceResponse = {
  totals: AccountRow[];
  summary: {
    openingDebit: number;
    openingCredit: number;
    movementDebit: number;
    movementCredit: number;
    closingDebit: number;
    closingCredit: number;
  };
};

type FiscalPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
};

async function fetchJsonOrThrow<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(typeof payload?.error === "string" && payload.error.trim() ? payload.error : "Request failed.");
  }
  return payload;
}

function randomCorrelationId() {
  if (typeof window !== "undefined" && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `tb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseFilenameFromContentDisposition(value: string | null, fallback: string) {
  if (!value) return fallback;
  const match = /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(value);
  if (!match?.[1]) return fallback;
  const cleaned = match[1].replace(/"/g, "").trim();
  try {
    return decodeURIComponent(cleaned);
  } catch {
    return cleaned || fallback;
  }
}

function getPreviousRange(start: string, end: string) {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  if (endDate.getTime() < startDate.getTime()) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  const spanDays = Math.floor((endDate.getTime() - startDate.getTime()) / dayMs) + 1;
  const prevEnd = new Date(startDate.getTime() - dayMs);
  const prevStart = new Date(prevEnd.getTime() - (spanDays - 1) * dayMs);
  return { start: prevStart.toISOString().slice(0, 10), end: prevEnd.toISOString().slice(0, 10) };
}

export default function TrialBalancePage() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [includeZero, setIncludeZero] = useState(false);
  const [showFlaggedOnly, setShowFlaggedOnly] = useState(false);
  const [selectedPatternRow, setSelectedPatternRow] = useState<AccountRow | null>(null);
  const hasUserEdited = useRef(false);

  const { data: periodsData } = useClientQuery<FiscalPeriod[]>({
    queryKey: ["accounting", "periods"],
    queryFn: () => fetchJsonOrThrow<FiscalPeriod[]>("/api/admin/accounting/periods"),
  });
  const periods = useMemo(() => (Array.isArray(periodsData) ? periodsData : []), [periodsData]);
  const currentOpenPeriod = useMemo(() => {
    const today = new Date();
    return periods.find((period) => {
      if (period.status !== "OPEN") return false;
      const startDate = new Date(period.startDate);
      const endDate = new Date(period.endDate);
      return today >= startDate && today <= endDate;
    });
  }, [periods]);

  useEffect(() => {
    if (hasUserEdited.current) return;
    if (!currentOpenPeriod) return;
    setStart(currentOpenPeriod.startDate.slice(0, 10));
    setEnd(currentOpenPeriod.endDate.slice(0, 10));
  }, [currentOpenPeriod]);

  const {
    data,
    isLoading,
    isError,
    error,
    dataUpdatedAt,
  } = useClientQuery<TrialBalanceResponse>({
    queryKey: ["accounting", "reports", "trial-balance", { start, end, includeZero }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      if (includeZero) params.set("includeZero", "1");
      return fetchJsonOrThrow<TrialBalanceResponse>(`/api/admin/accounting/reports/trial-balance?${params.toString()}`);
    },
  });

  const previousRange = useMemo(() => {
    if (!start || !end) return null;
    return getPreviousRange(start, end);
  }, [start, end]);
  const { data: previousData } = useClientQuery<TrialBalanceResponse>({
    queryKey: [
      "accounting",
      "reports",
      "trial-balance",
      "previous",
      previousRange?.start || "",
      previousRange?.end || "",
      includeZero ? "z1" : "z0",
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (previousRange?.start) params.set("start", previousRange.start);
      if (previousRange?.end) params.set("end", previousRange.end);
      if (includeZero) params.set("includeZero", "1");
      return fetchJsonOrThrow<TrialBalanceResponse>(`/api/admin/accounting/reports/trial-balance?${params.toString()}`);
    },
    enabled: Boolean(previousRange?.start && previousRange?.end),
  });

  const isClosedRange = useMemo(() => {
    if (!start || !end) return false;
    const startDate = new Date(`${start}T00:00:00`);
    const endDate = new Date(`${end}T23:59:59`);
    return periods.some((period) => {
      if (period.status !== "CLOSED") return false;
      const periodStart = new Date(period.startDate);
      const periodEnd = new Date(period.endDate);
      return startDate >= periodStart && endDate <= periodEnd;
    });
  }, [periods, start, end]);

  const query = new URLSearchParams(
    start ? { start, ...(end ? { end } : {}) } : end ? { end } : {},
  ).toString();
  const exportAuditLink =
    "/admin/audit?scope=accounting_reports&entityType=AccountingReport&sourcePage=admin/accounting/reports/trial-balance";
  const currentDebit = data?.summary?.closingDebit || 0;
  const priorDebit = previousData?.summary?.closingDebit || 0;
  const debitDelta = currentDebit - priorDebit;
  const outOfPatternCount = (data?.totals || []).filter((row) => row.patternSeverity === "FLAG").length;
  const infoPatternCount = (data?.totals || []).filter((row) => row.patternSeverity === "INFO").length;
  const displayRows = useMemo(() => {
    const rows = data?.totals || [];
    if (!showFlaggedOnly) return rows;
    return rows.filter((row) => row.patternSeverity === "FLAG");
  }, [data?.totals, showFlaggedOnly]);
  const closingGap = (data?.summary?.closingDebit || 0) - (data?.summary?.closingCredit || 0);
  const hasClosingImbalance = Math.abs(closingGap) > 0.005;
  const selectedQuery = new URLSearchParams({
    account: selectedPatternRow?.code || "",
    status: "POSTED",
    entryDir:
      selectedPatternRow && (selectedPatternRow.type === "ASSET" || selectedPatternRow.type === "EXPENSE")
        ? "credit"
        : "debit",
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  }).toString();
  const applyDatePreset = useCallback((preset: "THIS_MONTH" | "LAST_MONTH" | "CURRENT_FISCAL_PERIOD") => {
    hasUserEdited.current = true;
    const now = new Date();
    if (preset === "THIS_MONTH") {
      const year = now.getFullYear();
      const month = now.getMonth();
      setStart(new Date(year, month, 1).toISOString().slice(0, 10));
      setEnd(new Date(year, month + 1, 0).toISOString().slice(0, 10));
      return;
    }
    if (preset === "LAST_MONTH") {
      const year = now.getFullYear();
      const month = now.getMonth();
      setStart(new Date(year, month - 1, 1).toISOString().slice(0, 10));
      setEnd(new Date(year, month, 0).toISOString().slice(0, 10));
      return;
    }
    if (currentOpenPeriod) {
      setStart(currentOpenPeriod.startDate.slice(0, 10));
      setEnd(currentOpenPeriod.endDate.slice(0, 10));
    }
  }, [currentOpenPeriod]);
  const lastRefreshedLabel = useMemo(() => {
    if (!dataUpdatedAt) return null;
    return new Date(dataUpdatedAt).toLocaleString();
  }, [dataUpdatedAt]);
  const handleExportCsv = useCallback(async () => {
    const params = new URLSearchParams();
    if (start) params.set("start", start);
    if (end) params.set("end", end);
    if (includeZero) params.set("includeZero", "1");
    const correlationId = randomCorrelationId();
    params.set("correlationId", correlationId);

    const response = await fetch(`/api/admin/accounting/reports/trial-balance/export?${params.toString()}`);
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error || "Failed to export trial balance.");
    }

    const blob = await response.blob();
    const defaultName = `trial-balance-${start || "start"}-${end || "end"}.csv`;
    const filename = parseFilenameFromContentDisposition(response.headers.get("Content-Disposition"), defaultName);
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);

    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(correlationId);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (copied) {
      toast.success(`CSV export complete. Correlation ID copied: ${correlationId}`);
    } else {
      toast.success(`CSV export complete. Correlation ID: ${correlationId}`);
    }
  }, [end, includeZero, start]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      if (event.key === "1") {
        event.preventDefault();
        applyDatePreset("THIS_MONTH");
      } else if (event.key === "2") {
        event.preventDefault();
        applyDatePreset("LAST_MONTH");
      } else if (event.key === "3") {
        event.preventDefault();
        applyDatePreset("CURRENT_FISCAL_PERIOD");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyDatePreset]);
  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Trial Balance</h1>
        <p className="text-sm text-muted-foreground">Debits and credits by account.</p>
        <p className="text-xs text-muted-foreground mt-1">
          {currentOpenPeriod ? `Current period: ${currentOpenPeriod.name}` : "No open fiscal period."}
        </p>
        {!isClosedRange ? (
          <p className="text-xs text-amber-700 mt-1">
            Period not closed. Results can still change as entries are posted/edited.
          </p>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Input
            className="w-full sm:w-auto"
            type="date"
            value={start}
            max={end || undefined}
            onChange={(e) => {
              hasUserEdited.current = true;
              const nextStart = e.target.value;
              setStart(nextStart);
              if (end && nextStart && end < nextStart) {
                setEnd(nextStart);
              }
            }}
          />
          <Input
            className="w-full sm:w-auto"
            type="date"
            value={end}
            min={start || undefined}
            onChange={(e) => {
              hasUserEdited.current = true;
              const nextEnd = e.target.value;
              if (start && nextEnd && nextEnd < start) {
                setEnd(start);
                return;
              }
              setEnd(nextEnd);
            }}
          />
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} />
            Include zero-balance accounts
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showFlaggedOnly}
              onChange={(e) => setShowFlaggedOnly(e.target.checked)}
            />
            Only flagged accounts
          </label>
          <Button
            size="sm"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => applyDatePreset("THIS_MONTH")}
          >
            This month
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => applyDatePreset("LAST_MONTH")}
          >
            Last month
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => applyDatePreset("CURRENT_FISCAL_PERIOD")}
            disabled={!currentOpenPeriod}
          >
            Current fiscal period
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => {
              void handleExportCsv().catch((err) =>
                toast.error(err instanceof Error ? err.message : "Failed to export trial balance."),
              );
            }}
          >
            Export CSV
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <a href={`/api/admin/accounting/reports/pack/export?${query}${query ? "&" : ""}source=trial-balance`}>Export reporting pack</a>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <Link href="/admin/accounting/periods">Open Fiscal Periods</Link>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <Link href={exportAuditLink}>View export audit logs</Link>
          </Button>
          <p className="text-xs text-muted-foreground w-full">
            Shortcuts: Alt+1 This month, Alt+2 Last month, Alt+3 Current fiscal period.
            {lastRefreshedLabel ? ` Last refreshed: ${lastRefreshedLabel}.` : ""}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Comparison</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Current closing debits</div>
            <div className="font-semibold">{formatCurrency(currentDebit)}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Prior closing debits</div>
            <div className="font-semibold">{formatCurrency(priorDebit)}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Delta</div>
            <div className="font-semibold">{debitDelta >= 0 ? "+" : ""}{formatCurrency(debitDelta)}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Out-of-pattern balances</div>
            <div className="font-semibold">{outOfPatternCount}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Expected exceptions</div>
            <div className="font-semibold">{infoPatternCount}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {isError ? (
            <p className="text-sm text-red-700">
              {error instanceof Error ? error.message : "Could not load trial balance. Please retry."}
            </p>
          ) : isLoading ? (
            <p className="text-sm text-muted-foreground">Loading trial balance...</p>
          ) : (
            <div className="overflow-x-auto overflow-y-visible">
              <table className="w-full min-w-[1200px] text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="sticky top-0 z-20 bg-background h-10 px-2 text-left align-middle font-medium">Code</th>
                    <th className="sticky top-0 z-20 bg-background h-10 px-2 text-left align-middle font-medium">Account</th>
                    <th className="sticky top-0 z-20 bg-background h-10 px-2 text-left align-middle font-medium">Type</th>
                    <th className="sticky top-0 z-20 bg-background h-10 px-2 text-left align-middle font-medium">Pattern</th>
                    <th className="sticky top-0 z-20 bg-background h-10 px-2 text-right align-middle font-medium">Opening Debit</th>
                    <th className="sticky top-0 z-20 bg-background h-10 px-2 text-right align-middle font-medium">Opening Credit</th>
                    <th className="sticky top-0 z-20 bg-background h-10 px-2 text-right align-middle font-medium">Movement Debit</th>
                    <th className="sticky top-0 z-20 bg-background h-10 px-2 text-right align-middle font-medium">Movement Credit</th>
                    <th className="sticky top-0 z-20 bg-background h-10 px-2 text-right align-middle font-medium">Closing Debit</th>
                    <th className="sticky top-0 z-20 bg-background h-10 px-2 text-right align-middle font-medium">Closing Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {displayRows.map((row) => (
                    <tr
                      key={row.accountId}
                      className={`border-b transition-colors ${
                        row.patternSeverity === "FLAG"
                          ? "bg-amber-50"
                          : row.patternSeverity === "INFO"
                            ? "bg-blue-50"
                            : "hover:bg-muted/50"
                      }`}
                    >
                      <td className="p-2 font-mono">{row.code}</td>
                      <td className="p-2">
                        <Link
                          className="underline underline-offset-2"
                          href={`/admin/accounting/journal?account=${encodeURIComponent(row.code)}${start ? `&start=${encodeURIComponent(start)}` : ""}${end ? `&end=${encodeURIComponent(end)}` : ""}`}
                        >
                          {row.name}
                        </Link>
                      </td>
                      <td className="p-2">{row.type}</td>
                      <td className="p-2">
                        {row.patternSeverity === "FLAG" ? (
                          <button
                            type="button"
                            className="text-amber-800 font-medium underline underline-offset-2"
                            onClick={() => setSelectedPatternRow(row)}
                          >
                            Flag
                          </button>
                        ) : row.patternSeverity === "INFO" ? (
                          <button
                            type="button"
                            className="text-blue-800 underline underline-offset-2"
                            onClick={() => setSelectedPatternRow(row)}
                          >
                            Info
                          </button>
                        ) : (
                          <span className="text-muted-foreground">Normal</span>
                        )}
                      </td>
                      <td className="p-2 text-right">{formatCurrency(row.openingDebit)}</td>
                      <td className="p-2 text-right">{formatCurrency(row.openingCredit)}</td>
                      <td className="p-2 text-right">{formatCurrency(row.movementDebit)}</td>
                      <td className="p-2 text-right">{formatCurrency(row.movementCredit)}</td>
                      <td className="p-2 text-right">{formatCurrency(row.closingDebit)}</td>
                      <td className="p-2 text-right">{formatCurrency(row.closingCredit)}</td>
                    </tr>
                  ))}
                  {displayRows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="text-center text-sm text-muted-foreground py-8">
                        {showFlaggedOnly
                          ? "No flagged accounts found for this date range."
                          : "No accounts found for this date range."}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm font-semibold sm:grid-cols-2 lg:grid-cols-4">
          <span>Opening totals (Debit/Credit)</span>
          <span>
            {formatCurrency(data?.summary?.openingDebit || 0)} / {formatCurrency(data?.summary?.openingCredit || 0)}
          </span>
          <span>Movement totals (Debit/Credit)</span>
          <span>
            {formatCurrency(data?.summary?.movementDebit || 0)} / {formatCurrency(data?.summary?.movementCredit || 0)}
          </span>
          <span>Closing totals (Debit/Credit)</span>
          <span>
            {formatCurrency(data?.summary?.closingDebit || 0)} / {formatCurrency(data?.summary?.closingCredit || 0)}
          </span>
          {hasClosingImbalance ? (
            <>
              <span className="text-amber-700">Out-of-balance difference</span>
              <span className="text-amber-700 font-semibold">{formatCurrency(closingGap)}</span>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedPatternRow)} onOpenChange={(open) => (!open ? setSelectedPatternRow(null) : null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Pattern details</DialogTitle>
          </DialogHeader>
          {selectedPatternRow ? (
            <div className="space-y-3 text-sm">
              <div>
                <div className="font-medium">
                  {selectedPatternRow.code} · {selectedPatternRow.name}
                </div>
                <div className="text-muted-foreground">Type: {selectedPatternRow.type}</div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs uppercase text-muted-foreground mb-1">Classification</div>
                <div className="font-medium">
                  {selectedPatternRow.patternSeverity === "FLAG" ? "Flag (needs review)" : "Info (expected exception)"}
                </div>
                <div className="text-muted-foreground mt-1">{selectedPatternRow.patternNote || "No additional note."}</div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs uppercase text-muted-foreground mb-1">Recommended checks</div>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Review latest journal lines for this account in selected range.</li>
                  <li>Confirm posting rules and source documents are correct.</li>
                  <li>Confirm reconciliation status where applicable.</li>
                </ul>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/admin/accounting/journal?${selectedQuery}`}>Open Journal (filtered)</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/admin/accounting/reconciliations">Open Reconciliations</Link>
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

