"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import { toast } from "sonner";
import Link from "next/link";

type CashAccount = {
  id: string;
  code: string;
  name: string;
};

type BankAccount = {
  id: string;
  name: string;
  bankName: string | null;
  accountNumberMasked: string | null;
};

type CashRecon = {
  id: string;
  countedAt: string;
  expectedAmount: number;
  actualAmount: number;
  variance: number;
  /** Persisted on the record: "ledger" | "operational" | "operational_otc" | "opening_balance" */
  reconcileMode?: string | null;
  isOpeningBalance?: boolean;
  notes: string | null;
  journalEntryId: string | null;
  cashAccount: CashAccount;
  createdBy?: { id: string; name: string | null; email: string | null } | null;
};

type CashReconResponse = {
  asOf: string;
  mode: "ledger" | "operational";
  cashAccount: CashAccount;
  cashAccounts: CashAccount[];
  expectedBalance: number;
  operational?: {
    day: string;
    scope: "all" | "otc";
    cashInPeriod: number;
    cashOutPeriod: number;
    expectedDayNet: number;
    sourceBreakdown: Array<{
      sourceType: string;
      label: string;
      cashIn: number;
      cashOut: number;
      net: number;
    }>;
  };
  reconciliations: CashRecon[];
  history?: {
    range: "today" | "month" | "all";
    from: string | null;
    to: string | null;
    variance: "all" | "nonzero";
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  selectedDay?: {
    day: string;
    reconciled: boolean;
    reconciliationCount: number;
    latestReconciliationId: string | null;
    latestReconciliationAt: string | null;
    latestCreatedAt: string | null;
    latestVariance: number;
    latestBy: string | null;
    records: Array<{
      id: string;
      countedAt: string;
      createdAt: string;
      expectedAmount: number;
      actualAmount: number;
      variance: number;
      reconcileMode: string;
      isOpeningBalance: boolean;
      notes: string | null;
      journalEntryId: string | null;
      createdBy: { id: string; name: string | null; email: string | null } | null;
    }>;
  };
  unreconciledDays?: {
    count: number;
    oldest: string | null;
    newest: string | null;
    sample: string[];
    all: string[];
  };
  ledgerDiagnostics?: {
    isNegative: boolean;
    firstNegativeDay: string | null;
    mostNegativeMoveDay: string | null;
    mostNegativeMoveAmount: number;
  } | null;
};

type SavedHistoryFilter = {
  id: string;
  name: string;
  range: "today" | "month" | "all";
  from: string;
  to: string;
  variance: "all" | "nonzero";
  pageSize: number;
};

function toLocalYmd(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function varianceColorClass(v: number): string {
  if (v < 0) return "text-red-600";
  if (v > 0) return "text-emerald-600";
  return "";
}

export default function CashReconciliationsPage() {
  const queryClient = useQueryClient();
  const [asOf, setAsOf] = useState(() => toLocalYmd(new Date()));
  const [datePreset, setDatePreset] = useState<"today" | "yesterday" | "custom">("today");
  const [mode, setMode] = useState<"ledger" | "operational">("operational");
  const [operationalScope, setOperationalScope] = useState<"all" | "otc">("all");
  const [cashAccountId, setCashAccountId] = useState("");
  const [actualAmount, setActualAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [varianceReason, setVarianceReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositNotes, setDepositNotes] = useState("");
  const [depositBankId, setDepositBankId] = useState("");
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositSaving, setDepositSaving] = useState(false);
  const [catchupOpen, setCatchupOpen] = useState(false);
  const [catchupSaving, setCatchupSaving] = useState(false);
  const [catchupDays, setCatchupDays] = useState<Record<string, boolean>>({});
  const [catchupVerified, setCatchupVerified] = useState(false);
  const [catchupNote, setCatchupNote] = useState("");
  const [historyRange, setHistoryRange] = useState<"today" | "month" | "all">("all");
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");
  const [historyVariance, setHistoryVariance] = useState<"all" | "nonzero">("all");
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(10);
  const [savedHistoryFilters, setSavedHistoryFilters] = useState<SavedHistoryFilter[]>([]);
  const [selectedHistoryFilterId, setSelectedHistoryFilterId] = useState("");
  const [historyFiltersOpen, setHistoryFiltersOpen] = useState(false);
  const [filterNameInput, setFilterNameInput] = useState("");
  const [filterNameOpen, setFilterNameOpen] = useState(false);
  const [allowReopenOverride, setAllowReopenOverride] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [openingTillFloat, setOpeningTillFloat] = useState("");
  const [countedClosingTill, setCountedClosingTill] = useState("");
  const [countChecklist, setCountChecklist] = useState(false);
  const [varianceChecklist, setVarianceChecklist] = useState(false);
  const [noteChecklist, setNoteChecklist] = useState(false);
  // ── Opening balance anchor state ────────────────────────────────────────────
  const [obOpen, setObOpen] = useState(false);
  const [obVerifiedCount, setObVerifiedCount] = useState("");
  const [obDate, setObDate] = useState(() => toLocalYmd(new Date()));
  const [obNotes, setObNotes] = useState("");
  const [obPostGl, setObPostGl] = useState(true);
  const [obSaving, setObSaving] = useState(false);
  const [expandedRecIds, setExpandedRecIds] = useState<Record<string, boolean>>({});
  const [recDayDetails, setRecDayDetails] = useState<
    Record<
      string,
      {
        loading?: boolean;
        error?: string;
        day?: string;
        cashInPeriod?: number;
        cashOutPeriod?: number;
        expectedDayNet?: number;
        sourceBreakdown?: Array<{
          sourceType: string;
          label: string;
          cashIn: number;
          cashOut: number;
          net: number;
        }>;
      }
    >
  >({});

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (asOf) p.set("asOf", asOf);
    if (mode) p.set("mode", mode);
    if (mode === "operational") p.set("operationalScope", operationalScope);
    if (cashAccountId) p.set("cashAccountId", cashAccountId);
    p.set("historyRange", historyRange);
    if (historyFrom) p.set("historyFrom", historyFrom);
    if (historyTo) p.set("historyTo", historyTo);
    p.set("historyVariance", historyVariance);
    p.set("historyPage", String(historyPage));
    p.set("historyPageSize", String(historyPageSize));
    return p.toString();
  }, [
    asOf,
    mode,
    operationalScope,
    cashAccountId,
    historyRange,
    historyFrom,
    historyTo,
    historyVariance,
    historyPage,
    historyPageSize,
  ]);

  const { data, isLoading } = useClientQuery<CashReconResponse>({
    queryKey: ["accounting", "cash-reconciliations", params],
    queryFn: () => fetch(`/api/admin/accounting/cash-reconciliations?${params}`).then((r) => r.json()),
  });
  const { data: bankAccounts } = useClientQuery<BankAccount[]>({
    queryKey: ["accounting", "banks"],
    queryFn: () => fetch("/api/admin/accounting/banks").then((r) => r.json()),
  });

  const expectedBalance = Number(data?.expectedBalance || 0);
  const cashInPeriod = Number(data?.operational?.cashInPeriod || 0);
  const cashOutPeriod = Number(data?.operational?.cashOutPeriod || 0);
  const expectedOperational = Number(data?.operational?.expectedDayNet || 0);
  const sourceBreakdown = data?.operational?.sourceBreakdown || [];
  const expectedForMode = mode === "operational" ? expectedOperational : expectedBalance;
  const selectedDay = data?.selectedDay;
  const unreconciledDays = data?.unreconciledDays;
  const ledgerDiagnostics = data?.ledgerDiagnostics;
  const canDepositForSelectedDay = mode === "operational" && Boolean(selectedDay?.reconciled);

  const tillCalc = useMemo(() => {
    const opening = Number(openingTillFloat);
    const countedClosing = Number(countedClosingTill);
    if (!Number.isFinite(opening) || !Number.isFinite(countedClosing)) return null;
    const countedDayNet = Number((countedClosing - opening).toFixed(2));
    const variance = Number((countedDayNet - expectedOperational).toFixed(2));
    return { countedDayNet, variance };
  }, [openingTillFloat, countedClosingTill, expectedOperational]);

  const reconciliations = data?.reconciliations || [];
  const historyTotal = Number(data?.history?.total || 0);
  const historyTotalPages = Number(data?.history?.totalPages || 1);
  const nonZeroVarianceCount = reconciliations.filter((rec) => Number(rec.variance || 0) !== 0).length;
  const latestVarianceAmount = reconciliations.length ? Number(reconciliations[0].variance || 0) : 0;

  const storageKey = useMemo(
    () => `cash-reconciliation-history-filters-${cashAccountId || data?.cashAccount?.id || "default"}`,
    [cashAccountId, data?.cashAccount?.id],
  );

  const variancePreview = (() => {
    if (!actualAmount.trim()) return null;
    const actual = Number(actualAmount);
    if (!Number.isFinite(actual)) return null;
    return Number((actual - expectedForMode).toFixed(2));
  })();

  const hasVariance = variancePreview !== null && variancePreview !== 0;

  // ── Submit reconciliation ─────────────────────────────────────────────────
  const submitReconciliation = async () => {
    const actual = Number(actualAmount);
    if (!Number.isFinite(actual)) {
      toast.error("Enter the counted cash amount.");
      return;
    }
    if (!asOf) {
      toast.error("Select the count date.");
      return;
    }
    if (!countChecklist || !varianceChecklist || !noteChecklist) {
      toast.error("Complete the checklist before saving reconciliation.");
      return;
    }
    if (hasVariance) {
      if (!varianceReason) {
        toast.error("Select a variance reason before saving.");
        return;
      }
      if (!notes.trim()) {
        toast.error("Add a variance explanation before saving.");
        return;
      }
    }
    if (selectedDay?.reconciled && !allowReopenOverride) {
      toast.error("This day is already reconciled. Enable override and provide a reason to resave.");
      return;
    }
    if (selectedDay?.reconciled && allowReopenOverride && reopenReason.trim().length < 10) {
      toast.error("Override reason must be at least 10 characters.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch("/api/admin/accounting/cash-reconciliations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cashAccountId: cashAccountId || undefined,
          countedAt: asOf,
          mode,
          operationalScope: mode === "operational" ? operationalScope : undefined,
          allowReopenOverride: selectedDay?.reconciled ? allowReopenOverride : undefined,
          reopenReason:
            selectedDay?.reconciled && allowReopenOverride
              ? reopenReason.trim() || undefined
              : undefined,
          varianceReason: varianceReason || undefined,
          actualAmount: actual,
          notes: notes.trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (j?.code === "DAY_ALREADY_RECONCILED") {
          throw new Error(j?.error || "Selected day is already reconciled.");
        }
        throw new Error(j?.error || "Failed to save cash reconciliation.");
      }
      toast.success("Cash reconciliation saved.");
      setActualAmount("");
      setNotes("");
      setVarianceReason("");
      setOpeningTillFloat("");
      setCountedClosingTill("");
      setCountChecklist(false);
      setVarianceChecklist(false);
      setNoteChecklist(false);
      setAllowReopenOverride(false);
      setReopenReason("");
      queryClient.invalidateQueries({ queryKey: ["accounting", "cash-reconciliations"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save cash reconciliation.");
    } finally {
      setSaving(false);
    }
  };

  // ── Submit deposit ────────────────────────────────────────────────────────
  const submitDeposit = async () => {
    if (!canDepositForSelectedDay) {
      if (mode !== "operational") {
        toast.error("Switch to Operational mode to record cash deposits.");
      } else {
        toast.error("Reconcile the selected day first before recording a cash deposit.");
      }
      return;
    }
    const amount = Number(depositAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid deposit amount.");
      return;
    }
    if (!depositBankId) {
      toast.error("Select a bank account for the deposit.");
      return;
    }
    try {
      setDepositSaving(true);
      const res = await fetch("/api/admin/accounting/cash-deposits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount,
          bankAccountId: depositBankId || undefined,
          notes: depositNotes.trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to record cash deposit.");
      toast.success("Cash deposit recorded.");
      setDepositAmount("");
      setDepositNotes("");
      setDepositBankId("");
      setDepositOpen(false);
      queryClient.invalidateQueries({ queryKey: ["accounting", "cash-reconciliations"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to record cash deposit.");
    } finally {
      setDepositSaving(false);
    }
  };

  // ── Submit opening balance anchor ─────────────────────────────────────────
  const submitOpeningBalance = async () => {
    const verified = Number(obVerifiedCount);
    if (!Number.isFinite(verified)) {
      toast.error("Enter the verified physical count.");
      return;
    }
    if (!obDate) {
      toast.error("Select the anchor date.");
      return;
    }
    try {
      setObSaving(true);
      const res = await fetch("/api/admin/accounting/cash-reconciliations/opening-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          verifiedCount: verified,
          cashAccountId: cashAccountId || undefined,
          date: obDate,
          notes: obNotes.trim() || undefined,
          postGlAdjustment: obPostGl,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (j?.code === "OPENING_BALANCE_EXISTS") {
          throw new Error(
            `An opening balance already exists for this account (set on ${j?.existing?.date ?? "unknown date"}). Delete it first or use a regular reconciliation instead.`,
          );
        }
        throw new Error(j?.error || "Failed to set opening balance.");
      }
      const adj: number = j?.glAdjustment ?? 0;
      const posted: boolean = j?.adjustmentPosted ?? false;
      toast.success(
        posted
          ? `Opening balance set. GL adjusted by ${adj >= 0 ? "+" : ""}${formatCurrency(adj)} to match your count.`
          : "Opening balance anchor recorded. No GL adjustment was needed.",
      );
      setObOpen(false);
      setObVerifiedCount("");
      setObNotes("");
      setObDate(toLocalYmd(new Date()));
      setObPostGl(true);
      queryClient.invalidateQueries({ queryKey: ["accounting", "cash-reconciliations"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to set opening balance.");
    } finally {
      setObSaving(false);
    }
  };

  // ── CSV helpers ───────────────────────────────────────────────────────────
  const csvEscape = (value: string | number | null | undefined) => {
    const text = String(value ?? "");
    if (text.includes(",") || text.includes('"') || text.includes("\n")) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const exportReconciliationCsv = () => {
    const rows: string[] = [];
    rows.push("Section,Field,Value");
    rows.push(`Summary,Exported At,${csvEscape(new Date().toISOString())}`);
    rows.push(`Summary,Mode,${csvEscape(mode.toUpperCase())}`);
    rows.push(`Summary,As Of,${csvEscape(asOf)}`);
    rows.push(`Summary,Cash Account,${csvEscape(`${data?.cashAccount?.code || ""} ${data?.cashAccount?.name || ""}`.trim())}`);
    if (mode === "operational") {
      rows.push(`Summary,Cash In (Day),${csvEscape(cashInPeriod)}`);
      rows.push(`Summary,Cash Out (Day),${csvEscape(cashOutPeriod)}`);
      rows.push(`Summary,Expected Day Net,${csvEscape(expectedOperational)}`);
    } else {
      rows.push(`Summary,GL Cash Balance (As-Of),${csvEscape(expectedBalance)}`);
    }
    rows.push(`Summary,Expected For Reconciliation,${csvEscape(expectedForMode)}`);
    rows.push("");
    rows.push("Source Breakdown,Source,In,Out,Net");
    for (const row of sourceBreakdown) {
      rows.push([
        "Source Breakdown",
        csvEscape(row.label),
        csvEscape(row.cashIn),
        csvEscape(row.cashOut),
        csvEscape(row.net),
      ].join(","));
    }
    rows.push("");
    rows.push("Reconciliation Records,ID,Counted At,Expected,Actual,Variance,Journal ID,Created By,Notes");
    for (const record of selectedDay?.records || []) {
      rows.push([
        "Reconciliation Records",
        csvEscape(record.id),
        csvEscape(record.countedAt),
        csvEscape(record.expectedAmount),
        csvEscape(record.actualAmount),
        csvEscape(record.variance),
        csvEscape(record.journalEntryId || ""),
        csvEscape(record.createdBy?.name || record.createdBy?.email || "System"),
        csvEscape(record.notes || ""),
      ].join(","));
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const filename = `cash-reconciliation-${asOf}-${mode}.csv`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "cash-reconciliations",
      format: "CSV",
      fileName: filename,
      rowCount: rows.length - 1,
      columnCount: 9,
      byteSize: blob.size,
      scopeSnapshot: `As-of: ${asOf} | Mode: ${mode}`,
    });
    toast.success("Reconciliation CSV exported.");
  };

  const printReconciliationReport = () => {
    const sourceRows = (sourceBreakdown || [])
      .map(
        (row) =>
          `<tr><td>${row.label}</td><td>${formatCurrency(row.cashIn)}</td><td>${formatCurrency(
            row.cashOut,
          )}</td><td>${formatCurrency(row.net)}</td></tr>`,
      )
      .join("");
    const recRows = (selectedDay?.records || [])
      .map(
        (r) =>
          `<tr><td>${new Date(r.countedAt).toLocaleString()}</td><td>${formatCurrency(
            r.expectedAmount,
          )}</td><td>${formatCurrency(r.actualAmount)}</td><td>${formatCurrency(
            r.variance,
          )}</td><td>${r.journalEntryId || "-"}</td><td>${r.createdBy?.name || r.createdBy?.email || "System"}</td></tr>`,
      )
      .join("");
    const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>Cash Reconciliation Report</title>
<style>
body{font-family:Arial,sans-serif;padding:24px;color:#111} h1{margin:0 0 8px;font-size:20px}
.muted{color:#555;font-size:12px} table{border-collapse:collapse;width:100%;margin-top:10px}
th,td{border:1px solid #ccc;padding:6px 8px;font-size:12px;text-align:left} th{background:#f7f7f7}
.section{margin-top:18px}
</style></head><body>
<h1>Cash Reconciliation Report</h1>
<div class="muted">As of: ${asOf} · Mode: ${mode.toUpperCase()} · Account: ${
      data?.cashAccount?.code || ""
    } ${data?.cashAccount?.name || ""}</div>
<div class="section">
<table><tbody>
<tr><th>Expected</th><td>${formatCurrency(expectedForMode)}</td></tr>
<tr><th>Cash In (Day)</th><td>${formatCurrency(cashInPeriod)}</td></tr>
<tr><th>Cash Out (Day)</th><td>${formatCurrency(cashOutPeriod)}</td></tr>
</tbody></table>
</div>
<div class="section"><h3>Operational Source Breakdown</h3>
<table><thead><tr><th>Source</th><th>In</th><th>Out</th><th>Net</th></tr></thead><tbody>${sourceRows}</tbody></table>
</div>
<div class="section"><h3>Reconciliation Records (Selected Day)</h3>
<table><thead><tr><th>Counted At</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Journal</th><th>By</th></tr></thead><tbody>${recRows}</tbody></table>
</div>
<div class="section muted">Prepared by: ____________________ &nbsp;&nbsp; Reviewed by: ____________________</div>
</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank", "noopener,noreferrer,width=980,height=760");
    if (!w) {
      toast.error("Unable to open print preview.");
      URL.revokeObjectURL(url);
      return;
    }
    w.addEventListener("load", () => {
      w.print();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }, { once: true });
  };

  // ── Date helpers ──────────────────────────────────────────────────────────
  const applyDatePreset = (preset: "today" | "yesterday" | "custom") => {
    setDatePreset(preset);
    if (preset === "custom") return;
    const base = new Date();
    if (preset === "yesterday") {
      base.setDate(base.getDate() - 1);
    }
    setAsOf(toLocalYmd(base));
  };

  const handleAsOfChange = (value: string) => {
    setAsOf(value);
    const today = toLocalYmd(new Date());
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yesterday = toLocalYmd(y);
    if (value === today) setDatePreset("today");
    else if (value === yesterday) setDatePreset("yesterday");
    else setDatePreset("custom");
  };

  // ── History filter effects ─────────────────────────────────────────────────
  useEffect(() => {
    setHistoryPage(1);
  }, [historyRange, historyFrom, historyTo, historyVariance, historyPageSize, cashAccountId]);

  useEffect(() => {
    if (historyPage > historyTotalPages) {
      setHistoryPage(historyTotalPages);
    }
  }, [historyPage, historyTotalPages]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        setSavedHistoryFilters([]);
        setSelectedHistoryFilterId("");
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        setSavedHistoryFilters([]);
        setSelectedHistoryFilterId("");
        return;
      }
      const normalized: SavedHistoryFilter[] = parsed
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          id: String(item.id || ""),
          name: String(item.name || "Untitled"),
          range: item.range === "today" || item.range === "month" ? item.range : "all",
          from: String(item.from || ""),
          to: String(item.to || ""),
          variance: (item.variance === "nonzero" ? "nonzero" : "all") as "all" | "nonzero",
          pageSize: Number(item.pageSize || 10),
        }))
        .filter((item) => item.id);
      setSavedHistoryFilters(normalized);
      setSelectedHistoryFilterId("");
    } catch {
      setSavedHistoryFilters([]);
      setSelectedHistoryFilterId("");
    }
  }, [storageKey]);

  const persistHistoryFilters = (next: SavedHistoryFilter[]) => {
    setSavedHistoryFilters(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    }
  };

  const saveCurrentHistoryFilter = () => {
    const trimmed = filterNameInput.trim();
    if (!trimmed) {
      toast.error("Enter a name for this filter.");
      return;
    }
    const id = `h_${Date.now()}`;
    const next: SavedHistoryFilter[] = [
      ...savedHistoryFilters,
      {
        id,
        name: trimmed,
        range: historyRange,
        from: historyFrom,
        to: historyTo,
        variance: historyVariance,
        pageSize: historyPageSize,
      },
    ];
    persistHistoryFilters(next);
    setSelectedHistoryFilterId(id);
    setFilterNameInput("");
    setFilterNameOpen(false);
    toast.success("History filter saved.");
  };

  const applySavedHistoryFilter = (filterId: string) => {
    setSelectedHistoryFilterId(filterId);
    const found = savedHistoryFilters.find((item) => item.id === filterId);
    if (!found) return;
    setHistoryRange(found.range);
    setHistoryFrom(found.from);
    setHistoryTo(found.to);
    setHistoryVariance(found.variance);
    setHistoryPageSize(found.pageSize);
    setHistoryPage(1);
  };

  const deleteSavedHistoryFilter = () => {
    if (!selectedHistoryFilterId) {
      toast.error("Select a saved history filter first.");
      return;
    }
    const next = savedHistoryFilters.filter((item) => item.id !== selectedHistoryFilterId);
    persistHistoryFilters(next);
    setSelectedHistoryFilterId("");
    toast.success("Saved history filter removed.");
  };

  const applyHistoryPreset = (preset: "today_nonzero" | "month_all" | "all_nonzero") => {
    if (preset === "today_nonzero") {
      setHistoryRange("today");
      setHistoryFrom("");
      setHistoryTo("");
      setHistoryVariance("nonzero");
    } else if (preset === "month_all") {
      setHistoryRange("month");
      setHistoryFrom("");
      setHistoryTo("");
      setHistoryVariance("all");
    } else {
      setHistoryRange("all");
      setHistoryFrom("");
      setHistoryTo("");
      setHistoryVariance("nonzero");
    }
    setHistoryPage(1);
  };

  const exportHistoryCsv = () => {
    const rows: string[] = [];
    rows.push("ID,Counted At,Mode,Cash Account Code,Cash Account Name,Expected,Actual,Variance,Journal ID,Created By,Notes");
    for (const rec of reconciliations) {
      rows.push(
        [
          csvEscape(rec.id),
          csvEscape(rec.countedAt),
          csvEscape((rec.reconcileMode || mode).toUpperCase()),
          csvEscape(rec.cashAccount.code),
          csvEscape(rec.cashAccount.name),
          csvEscape(Number(rec.expectedAmount || 0)),
          csvEscape(Number(rec.actualAmount || 0)),
          csvEscape(Number(rec.variance || 0)),
          csvEscape(rec.journalEntryId || ""),
          csvEscape(rec.createdBy?.name || rec.createdBy?.email || "System"),
          csvEscape(rec.notes || ""),
        ].join(","),
      );
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const filename = `cash-reconciliations-history-${asOf}.csv`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "cash-reconciliations-history",
      format: "CSV",
      fileName: filename,
      rowCount: reconciliations.length,
      columnCount: 11,
      byteSize: blob.size,
      scopeSnapshot: `Range: ${historyRange} | Variance: ${historyVariance} | Account: ${data?.cashAccount?.code || ""}`,
    });
    toast.success(`History CSV exported (${reconciliations.length} of ${historyTotal} rows — current page).`);
  };

  const toggleRecDetails = async (rec: CashRecon) => {
    const isOpen = Boolean(expandedRecIds[rec.id]);
    setExpandedRecIds((prev) => ({ ...prev, [rec.id]: !isOpen }));
    if (isOpen) return;
    if (recDayDetails[rec.id]?.day) return;
    const day = String(rec.countedAt).slice(0, 10);
    try {
      setRecDayDetails((prev) => ({ ...prev, [rec.id]: { loading: true } }));
      const p = new URLSearchParams();
      p.set("asOf", day);
      p.set("mode", "operational");
      p.set("operationalScope", "all");
      p.set("cashAccountId", rec.cashAccount.id);
      const res = await fetch(`/api/admin/accounting/cash-reconciliations?${p.toString()}`);
      const payload = (await res.json().catch(() => ({}))) as CashReconResponse & { error?: string };
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to load day details.");
      }
      setRecDayDetails((prev) => ({
        ...prev,
        [rec.id]: {
          loading: false,
          day: payload?.operational?.day || day,
          cashInPeriod: Number(payload?.operational?.cashInPeriod || 0),
          cashOutPeriod: Number(payload?.operational?.cashOutPeriod || 0),
          expectedDayNet: Number(payload?.operational?.expectedDayNet || 0),
          sourceBreakdown: payload?.operational?.sourceBreakdown || [],
        },
      }));
    } catch (e: unknown) {
      setRecDayDetails((prev) => ({
        ...prev,
        [rec.id]: { loading: false, error: e instanceof Error ? e.message : "Failed to load day details." },
      }));
    }
  };

  const openCatchupDialog = () => {
    const allDays = unreconciledDays?.all || [];
    const selected: Record<string, boolean> = {};
    for (const day of allDays) selected[day] = true;
    setCatchupDays(selected);
    setCatchupVerified(false);
    setCatchupNote("");
    setCatchupOpen(true);
  };

  const submitAutoCatchup = async () => {
    const days = Object.entries(catchupDays)
      .filter(([, selected]) => selected)
      .map(([day]) => day);
    if (!days.length) {
      toast.error("Select at least one day.");
      return;
    }
    if (!catchupVerified) {
      toast.error("Confirm zero-variance verification before continuing.");
      return;
    }
    if (catchupNote.trim().length < 10) {
      toast.error("Verification note must be at least 10 characters.");
      return;
    }
    try {
      setCatchupSaving(true);
      const res = await fetch("/api/admin/accounting/cash-reconciliations/auto-catchup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cashAccountId: cashAccountId || undefined,
          days,
          verifyZeroVariance: true,
          verificationNote: catchupNote.trim(),
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        created?: Array<{ day: string; id: string }>;
        skipped?: Array<{ day: string; reason: string }>;
      };
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to run auto catch-up.");
      }
      const createdCount = Number(payload?.created?.length || 0);
      const skippedCount = Number(payload?.skipped?.length || 0);
      toast.success(`Auto catch-up complete. Created ${createdCount}, skipped ${skippedCount}.`);
      setCatchupOpen(false);
      queryClient.invalidateQueries({ queryKey: ["accounting", "cash-reconciliations"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to run auto catch-up.");
    } finally {
      setCatchupSaving(false);
    }
  };

  const allCatchupDays = unreconciledDays?.all || [];
  const catchupSelectedCount = Object.values(catchupDays).filter(Boolean).length;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <section className="container mx-auto py-8 space-y-4">

      {/* PAGE HEADER */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Cash Reconciliation</h1>
          <p className="text-sm text-muted-foreground">
            Compare counted cash to the ledger balance and post a variance adjustment when needed.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportReconciliationCsv}>
            Export CSV
          </Button>
          <Button variant="outline" size="sm" onClick={printReconciliationReport}>
            Print Report
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDepositOpen(true)}
            disabled={!canDepositForSelectedDay}
            title={
              !canDepositForSelectedDay
                ? mode !== "operational"
                  ? "Switch to Operational mode to record cash deposits"
                  : "Reconcile the selected day first"
                : undefined
            }
          >
            Deposit Cash to Bank
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setObOpen(true)}
            title="Set a one-time verified physical count to anchor the GL starting balance"
          >
            Set Opening Balance
          </Button>
        </div>
      </div>

      {/* STEP 1 — FILTERS */}
      <Card>
        <CardHeader>
          <CardTitle>Step 1 — Select date &amp; mode</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4 text-sm">
          <div className="flex flex-col gap-1">
            <Label htmlFor="recon-mode" className="text-xs text-muted-foreground font-normal">
              Reconciliation mode
            </Label>
            <select
              id="recon-mode"
              className="h-10 w-full sm:w-auto rounded-md border bg-background px-3 text-sm"
              value={mode}
              onChange={(e) => setMode(e.target.value as "ledger" | "operational")}
            >
              <option value="operational">Operational (day cash-up)</option>
              <option value="ledger">Ledger (GL as-of)</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="cash-account" className="text-xs text-muted-foreground font-normal">
              Cash account
            </Label>
            <select
              id="cash-account"
              className="h-10 w-full sm:w-auto rounded-md border bg-background px-3 text-sm"
              value={cashAccountId || data?.cashAccount?.id || ""}
              onChange={(e) => setCashAccountId(e.target.value)}
            >
              {(data?.cashAccounts || []).map((acct) => (
                <option key={acct.id} value={acct.id}>
                  {acct.code} · {acct.name}
                </option>
              ))}
            </select>
          </div>

          {mode === "operational" ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="op-scope" className="text-xs text-muted-foreground font-normal">
                Operational scope
              </Label>
              <select
                id="op-scope"
                className="h-10 w-full sm:w-auto rounded-md border bg-background px-3 text-sm"
                value={operationalScope}
                onChange={(e) => setOperationalScope(e.target.value as "all" | "otc")}
              >
                <option value="all">All cash movements</option>
                <option value="otc">OTC only</option>
              </select>
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <Label htmlFor="as-of-date" className="text-xs text-muted-foreground font-normal">
              As of date
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="as-of-date"
                className="w-full sm:w-auto"
                type="date"
                value={asOf}
                onChange={(e) => handleAsOfChange(e.target.value)}
              />
              <div className="inline-flex rounded-md border">
                <Button
                  type="button"
                  size="sm"
                  variant={datePreset === "today" ? "default" : "ghost"}
                  className="rounded-r-none border-r"
                  onClick={() => applyDatePreset("today")}
                >
                  Today
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={datePreset === "yesterday" ? "default" : "ghost"}
                  className="rounded-none border-r"
                  onClick={() => applyDatePreset("yesterday")}
                >
                  Yesterday
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={datePreset === "custom" ? "default" : "ghost"}
                  className="rounded-l-none"
                  onClick={() => applyDatePreset("custom")}
                >
                  Custom
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        {mode === "operational"
          ? "Operational mode reconciles day net movement (cash in − cash out) for the selected day."
          : "Ledger mode uses cumulative posted GL cash balance as of selected date (end of day)."}
      </p>

      {/* LOADING STATE */}
      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : null}

      {/* ALERT: Negative GL balance */}
      {!isLoading && mode === "ledger" && expectedBalance < 0 ? (
        <Card className="border-red-300 bg-red-50">
          <CardContent className="pt-4 text-xs text-red-900 space-y-2">
            <div className="font-medium">
              GL cash balance is negative ({formatCurrency(expectedBalance)}). Review cash postings before final reconciliation.
            </div>
            <div>
              A negative cash balance usually indicates posting or classification issues in account `1000`.
            </div>
            {ledgerDiagnostics?.firstNegativeDay ? (
              <div>
                First detected negative day: <strong>{ledgerDiagnostics.firstNegativeDay}</strong>
                {ledgerDiagnostics.mostNegativeMoveDay ? (
                  <>
                    {" "}· Largest net cash-out day: <strong>{ledgerDiagnostics.mostNegativeMoveDay}</strong>{" "}
                    ({formatCurrency(ledgerDiagnostics.mostNegativeMoveAmount)})
                  </>
                ) : null}
              </div>
            ) : null}
            {ledgerDiagnostics?.firstNegativeDay ? (
              <Link
                href={`/admin/accounting/journal?account=1000&start=${encodeURIComponent(
                  ledgerDiagnostics.firstNegativeDay,
                )}&end=${encodeURIComponent(asOf)}`}
                className="inline-flex items-center rounded-md border border-red-300 bg-white px-2 py-1 text-xs hover:bg-red-100"
              >
                Investigate issue window (first negative day → as-of)
              </Link>
            ) : null}
            <Link
              href={`/admin/accounting/journal?account=1000&start=${encodeURIComponent(asOf)}&end=${encodeURIComponent(asOf)}`}
              className="inline-flex items-center rounded-md border border-red-300 bg-white px-2 py-1 text-xs hover:bg-red-100"
            >
              Open Cash Journal (1000) for selected day
            </Link>
          </CardContent>
        </Card>
      ) : null}

      {/* ALERT: Unreconciled days (operational) */}
      {!isLoading && mode === "operational" && unreconciledDays && unreconciledDays.count > 0 ? (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="pt-4 text-xs text-amber-900 space-y-1">
            <div className="font-medium">
              {unreconciledDays.count} day(s) with cash movement are not reconciled up to {asOf}.
            </div>
            <div>
              Oldest: {unreconciledDays.oldest || "-"} · Newest: {unreconciledDays.newest || "-"}
            </div>
            {unreconciledDays.oldest ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => handleAsOfChange(unreconciledDays.oldest as string)}
                >
                  Jump to oldest missing day
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={openCatchupDialog}
                >
                  Run auto-catchup (verified zero variance)
                </Button>
              </div>
            ) : null}
            {unreconciledDays.sample?.length ? (
              <div>Sample days: {unreconciledDays.sample.join(", ")}</div>
            ) : null}
            {(unreconciledDays.all || []).length ? (
              <details className="rounded border border-amber-300 bg-white/60 px-2 py-2">
                <summary className="cursor-pointer font-medium">View all missing days</summary>
                <div className="mt-2 space-y-1">
                  {(unreconciledDays.all || []).map((day) => (
                    <div key={day} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                      <span>{day}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => handleAsOfChange(day)}
                      >
                        Open day
                      </Button>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ALERT: Day already reconciled */}
      {!isLoading && selectedDay?.reconciled ? (
        <Card className="border-sky-300 bg-sky-50">
          <CardContent className="pt-4 text-xs text-sky-900 space-y-2">
            <div className="font-medium">
              {selectedDay.day} already has {selectedDay.reconciliationCount} reconciliation record(s).
            </div>
            <div>
              Latest by {selectedDay.latestBy || "System"} · Variance{" "}
              <span className={varianceColorClass(Number(selectedDay.latestVariance || 0))}>
                {formatCurrency(Number(selectedDay.latestVariance || 0))}
              </span>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 accent-sky-700"
                checked={allowReopenOverride}
                onChange={(e) => setAllowReopenOverride(e.target.checked)}
              />
              Allow override (resave reconciled day)
            </label>
            {allowReopenOverride ? (
              <div className="space-y-1">
                <Input
                  value={reopenReason}
                  onChange={(e) => setReopenReason(e.target.value)}
                  placeholder="Reason for reopening this day (min 10 chars)"
                  maxLength={500}
                />
                <p className="text-xs text-sky-700">{reopenReason.length}/500</p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ALERT: Unreconciled days (ledger) */}
      {!isLoading && mode === "ledger" && unreconciledDays && unreconciledDays.count > 0 ? (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="pt-4 text-xs text-amber-900 space-y-1">
            <div className="font-medium">
              {unreconciledDays.count} operational day(s) with cash movement are not reconciled up to {asOf}.
            </div>
            <div>Switch to Operational mode to close missing day reconciliations.</div>
          </CardContent>
        </Card>
      ) : null}

      {/* STEP 2 & 3 — Two-column layout */}
      {!isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">

          {/* LEFT COLUMN: Expected balance + breakdown + till */}
          <div className="space-y-4">

            {/* Summary */}
            <Card>
              <CardHeader>
                <CardTitle>Step 2 — Expected balance</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                {mode === "operational" ? (
                  <>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2">
                      <span className="text-muted-foreground">Cash in (day)</span>
                      <span className="font-semibold">{formatCurrency(cashInPeriod)}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2">
                      <span className="text-muted-foreground">Cash out (day)</span>
                      <span className="font-semibold">{formatCurrency(cashOutPeriod)}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 sm:col-span-2">
                      <span className="text-muted-foreground">Expected day net (in − out)</span>
                      <span className="font-semibold">{formatCurrency(expectedOperational)}</span>
                    </div>
                  </>
                ) : null}
                <div className="flex items-center justify-between rounded-md border px-3 py-2 sm:col-span-2">
                  <span className="text-muted-foreground">
                    {mode === "operational" ? "Expected value for reconciliation" : "GL cash balance (as-of)"}
                  </span>
                  <span className="font-semibold">{formatCurrency(expectedForMode)}</span>
                </div>
              </CardContent>
            </Card>

            {/* Source breakdown (operational only) */}
            {mode === "operational" ? (
              <Card>
                <CardHeader>
                  <CardTitle>Operational source breakdown</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {sourceBreakdown.length === 0 ? (
                    <div className="text-muted-foreground">No cash movements found for this day/scope.</div>
                  ) : (
                    sourceBreakdown.map((row) => (
                      <div key={row.sourceType} className="grid gap-2 rounded-md border px-3 py-2 sm:grid-cols-4">
                        <div className="font-medium">{row.label}</div>
                        <div className="text-xs text-muted-foreground">
                          In: <span className="text-foreground">{formatCurrency(row.cashIn)}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Out: <span className="text-foreground">{formatCurrency(row.cashOut)}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Net:{" "}
                          <span className={`font-medium ${varianceColorClass(row.net)}`}>
                            {formatCurrency(row.net)}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            ) : null}

            {/* Till calculator (operational only) */}
            {mode === "operational" ? (
              <Card>
                <CardHeader>
                  <CardTitle>Till Calculator <span className="text-xs font-normal text-muted-foreground">(optional)</span></CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="opening-till" className="text-xs text-muted-foreground font-normal">
                      Opening till float
                    </Label>
                    <Input
                      id="opening-till"
                      placeholder="0.00"
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={openingTillFloat}
                      onChange={(e) => setOpeningTillFloat(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="closing-till" className="text-xs text-muted-foreground font-normal">
                      Counted closing till
                    </Label>
                    <Input
                      id="closing-till"
                      placeholder="0.00"
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={countedClosingTill}
                      onChange={(e) => setCountedClosingTill(e.target.value)}
                    />
                  </div>
                  <div className="rounded-md border px-3 py-2">
                    <div className="text-xs text-muted-foreground">Counted day net</div>
                    <div className="font-semibold">{tillCalc ? formatCurrency(tillCalc.countedDayNet) : "—"}</div>
                  </div>
                  <div className="rounded-md border px-3 py-2">
                    <div className="text-xs text-muted-foreground">Till-vs-ledger day variance</div>
                    <div className={`font-semibold ${tillCalc ? varianceColorClass(tillCalc.variance) : ""}`}>
                      {tillCalc ? formatCurrency(tillCalc.variance) : "—"}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ) : null}
          </div>

          {/* RIGHT COLUMN: Record cash count */}
          <div>
            <Card className="h-full">
              <CardHeader>
                <CardTitle>Step 3 — Record cash count</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">

                {/* Counted amount */}
                <div className="flex flex-col gap-1">
                  <Label htmlFor="actual-amount">
                    {mode === "operational" ? "Counted day net movement" : "Counted cash amount"}
                    <span className="text-destructive ml-0.5">*</span>
                  </Label>
                  <Input
                    id="actual-amount"
                    placeholder="0.00"
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    data-no-drag-scroll="1"
                    onMouseDown={(e) => e.stopPropagation()}
                    value={actualAmount}
                    onChange={(e) => setActualAmount(e.target.value)}
                  />
                </div>

                {/* Variance preview */}
                {variancePreview !== null ? (
                  <div className="flex items-center justify-between rounded-md border px-3 py-2 bg-muted/20">
                    <span className="text-muted-foreground">Variance preview</span>
                    <span className={`font-semibold ${varianceColorClass(variancePreview)}`}>
                      {formatCurrency(variancePreview)}
                      {variancePreview < 0 ? " (shortage)" : variancePreview > 0 ? " (overage)" : " (balanced)"}
                    </span>
                  </div>
                ) : null}

                {/* Variance reason + notes — only when variance exists */}
                {hasVariance ? (
                  <>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="variance-reason">
                        Variance reason <span className="text-destructive ml-0.5">*</span>
                      </Label>
                      <select
                        id="variance-reason"
                        className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                        value={varianceReason}
                        onChange={(e) => setVarianceReason(e.target.value)}
                      >
                        <option value="">Select a reason…</option>
                        <option value="COUNT_ERROR">Count error</option>
                        <option value="UNRECORDED_PAYOUT">Unrecorded payout</option>
                        <option value="TIMING_DIFFERENCE">Timing difference</option>
                        <option value="SUSPECTED_SHRINKAGE">Suspected shrinkage</option>
                        <option value="OTHER">Other</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="variance-notes">
                        Variance explanation <span className="text-destructive ml-0.5">*</span>
                      </Label>
                      <Input
                        id="variance-notes"
                        placeholder="Describe the variance…"
                        data-no-drag-scroll="1"
                        onMouseDown={(e) => e.stopPropagation()}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        maxLength={500}
                      />
                      <p className="text-xs text-muted-foreground text-right">{notes.length}/500</p>
                    </div>
                  </>
                ) : (
                  /* Notes field shown without required indicator when no variance */
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="count-notes">Notes <span className="text-xs font-normal text-muted-foreground">(optional)</span></Label>
                    <Input
                      id="count-notes"
                      placeholder="Any additional notes…"
                      data-no-drag-scroll="1"
                      onMouseDown={(e) => e.stopPropagation()}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      maxLength={500}
                    />
                    {notes.length > 0 ? (
                      <p className="text-xs text-muted-foreground text-right">{notes.length}/500</p>
                    ) : null}
                  </div>
                )}

                {/* Pre-submission checklist */}
                <div className="rounded-md border bg-muted/20 p-3 space-y-2">
                  <p className="text-xs font-medium">Pre-submission checklist</p>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={countChecklist}
                      onChange={(e) => setCountChecklist(e.target.checked)}
                    />
                    Physical cash count completed.
                  </label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={varianceChecklist}
                      onChange={(e) => setVarianceChecklist(e.target.checked)}
                    />
                    Any discrepancy reviewed and validated.
                  </label>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={noteChecklist}
                      onChange={(e) => setNoteChecklist(e.target.checked)}
                    />
                    Notes/reason captured where required.
                  </label>
                </div>

                <Button
                  className="w-full"
                  onClick={submitReconciliation}
                  disabled={saving || !actualAmount.trim()}
                >
                  {saving ? "Saving…" : "Save cash reconciliation"}
                </Button>

                {!canDepositForSelectedDay ? (
                  <p className="text-xs text-amber-700">
                    {mode !== "operational"
                      ? "Cash deposit is available in Operational mode only."
                      : "Reconcile the selected day first before recording a cash deposit."}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}

      {/* HISTORY — single consolidated card */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>Reconciliation history</CardTitle>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="secondary">{historyTotal} total</Badge>
                <Badge variant={nonZeroVarianceCount > 0 ? "warning" : "secondary"}>
                  {nonZeroVarianceCount} non-zero variance{nonZeroVarianceCount !== 1 ? "s" : ""}
                </Badge>
                {latestVarianceAmount !== 0 ? (
                  <Badge variant={latestVarianceAmount < 0 ? "destructive" : "success"}>
                    Latest: {formatCurrency(latestVarianceAmount)}
                  </Badge>
                ) : null}
                <span className="text-muted-foreground">
                  {historyRange.toUpperCase()} / {historyVariance === "nonzero" ? "NON-ZERO ONLY" : "ALL VARIANCES"}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => applyHistoryPreset("today_nonzero")}>
                Today non-zero
              </Button>
              <Button size="sm" variant="outline" onClick={() => applyHistoryPreset("month_all")}>
                This month
              </Button>
              <Button size="sm" variant="outline" onClick={() => applyHistoryPreset("all_nonzero")}>
                All non-zero
              </Button>
              <Button
                size="sm"
                variant={historyFiltersOpen ? "default" : "outline"}
                onClick={() => setHistoryFiltersOpen((v) => !v)}
              >
                Filters {historyFiltersOpen ? "▲" : "▼"}
              </Button>
              <Button size="sm" variant="outline" onClick={exportHistoryCsv}>
                Export CSV
              </Button>
            </div>
          </div>

          {/* Collapsible filter bar */}
          {historyFiltersOpen ? (
            <div className="mt-3 grid gap-3 rounded-md border bg-muted/20 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor="hist-range" className="text-xs text-muted-foreground font-normal">Range</Label>
                <select
                  id="hist-range"
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={historyRange}
                  onChange={(e) => setHistoryRange(e.target.value as "today" | "month" | "all")}
                >
                  <option value="today">Today</option>
                  <option value="month">This month</option>
                  <option value="all">All</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="hist-from" className="text-xs text-muted-foreground font-normal">From</Label>
                <Input
                  id="hist-from"
                  className="h-8"
                  type="date"
                  value={historyFrom}
                  onChange={(e) => setHistoryFrom(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="hist-to" className="text-xs text-muted-foreground font-normal">To</Label>
                <Input
                  id="hist-to"
                  className="h-8"
                  type="date"
                  value={historyTo}
                  onChange={(e) => setHistoryTo(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="hist-variance" className="text-xs text-muted-foreground font-normal">Variance filter</Label>
                <select
                  id="hist-variance"
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={historyVariance}
                  onChange={(e) => setHistoryVariance(e.target.value as "all" | "nonzero")}
                >
                  <option value="all">All</option>
                  <option value="nonzero">Non-zero only</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="hist-rows" className="text-xs text-muted-foreground font-normal">Rows per page</Label>
                <select
                  id="hist-rows"
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={historyPageSize}
                  onChange={(e) => setHistoryPageSize(Number(e.target.value))}
                >
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                </select>
              </div>

              {/* Saved filters */}
              <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-3">
                <Label className="text-xs text-muted-foreground font-normal">Saved filters</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="h-8 min-w-44 rounded-md border bg-background px-2 text-sm text-foreground"
                    value={selectedHistoryFilterId}
                    onChange={(e) => applySavedHistoryFilter(e.target.value)}
                  >
                    <option value="">— Select saved filter —</option>
                    {savedHistoryFilters.map((filter) => (
                      <option key={filter.id} value={filter.id}>
                        {filter.name}
                      </option>
                    ))}
                  </select>
                  {filterNameOpen ? (
                    <div className="flex items-center gap-1">
                      <Input
                        className="h-8 w-40"
                        placeholder="Filter name…"
                        value={filterNameInput}
                        onChange={(e) => setFilterNameInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveCurrentHistoryFilter();
                          if (e.key === "Escape") { setFilterNameOpen(false); setFilterNameInput(""); }
                        }}
                        autoFocus
                        maxLength={60}
                      />
                      <Button type="button" size="sm" onClick={saveCurrentHistoryFilter}>Save</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => { setFilterNameOpen(false); setFilterNameInput(""); }}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button type="button" size="sm" variant="outline" onClick={() => setFilterNameOpen(true)}>
                      Save current
                    </Button>
                  )}
                  {selectedHistoryFilterId ? (
                    <Button type="button" size="sm" variant="ghost" onClick={deleteSavedHistoryFilter}>
                      Delete filter
                    </Button>
                  ) : null}
                </div>
              </div>

              {/* Clear */}
              <div className="flex items-end">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setHistoryRange("all");
                    setHistoryFrom("");
                    setHistoryTo("");
                    setHistoryVariance("all");
                    setHistoryPage(1);
                  }}
                >
                  Clear filters
                </Button>
              </div>
            </div>
          ) : null}
        </CardHeader>

        <CardContent className="text-sm space-y-2 px-0">
          {isLoading ? (
            <div className="px-6 space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : reconciliations.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date / Account</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead className="text-right">Expected</TableHead>
                  <TableHead className="text-right">Actual</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead>Journal</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reconciliations.map((rec) => {
                  const variance = Number(rec.variance || 0);
                  return (
                    <React.Fragment key={rec.id}>
                      <TableRow>
                        <TableCell>
                          <div className="font-medium">
                            {new Date(rec.countedAt).toLocaleString(undefined, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {rec.cashAccount.code} · {rec.cashAccount.name}
                          </div>
                          {rec.notes ? (
                            <div className="text-xs text-muted-foreground mt-0.5 italic">{rec.notes}</div>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const rm = rec.reconcileMode || "operational";
                            const cfg: Record<string, { label: string; cls: string }> = {
                              ledger:          { label: "LEDGER",        cls: "bg-sky-100 text-sky-800" },
                              operational:     { label: "OPERATIONAL",   cls: "bg-emerald-100 text-emerald-800" },
                              operational_otc: { label: "OTC",           cls: "bg-violet-100 text-violet-800" },
                              opening_balance: { label: "OPENING BAL",   cls: "bg-amber-100 text-amber-800" },
                            };
                            const { label, cls } = cfg[rm] ?? { label: rm.toUpperCase(), cls: "bg-muted text-muted-foreground" };
                            return (
                              <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
                                {label}
                              </span>
                            );
                          })()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(Number(rec.expectedAmount))}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatCurrency(Number(rec.actualAmount))}
                        </TableCell>
                        <TableCell className={`text-right tabular-nums font-medium ${varianceColorClass(variance)}`}>
                          {formatCurrency(variance)}
                          {variance < 0 ? (
                            <span className="ml-1 text-xs font-normal">(short)</span>
                          ) : variance > 0 ? (
                            <span className="ml-1 text-xs font-normal">(over)</span>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          {rec.journalEntryId ? (
                            <Link
                              href={`/admin/accounting/journal?entryId=${encodeURIComponent(rec.journalEntryId)}`}
                              className="text-xs text-blue-600 hover:underline font-mono"
                              title="Open journal entry"
                            >
                              {rec.journalEntryId.slice(0, 8)}…
                            </Link>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {rec.createdBy?.name || rec.createdBy?.email || "System"}
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void toggleRecDetails(rec)}
                          >
                            {expandedRecIds[rec.id] ? "Hide" : "Details"}
                          </Button>
                        </TableCell>
                      </TableRow>
                      {expandedRecIds[rec.id] ? (
                        <TableRow key={`${rec.id}-details`} className="bg-muted/20">
                          <TableCell colSpan={8} className="p-3 whitespace-normal">
                            {recDayDetails[rec.id]?.loading ? (
                              <div className="text-muted-foreground text-xs">Loading day details…</div>
                            ) : recDayDetails[rec.id]?.error ? (
                              <div className="text-red-600 text-xs">{recDayDetails[rec.id]?.error}</div>
                            ) : (
                              <div className="space-y-2 text-xs">
                                <div className="font-medium">
                                  Operational detail for {recDayDetails[rec.id]?.day || String(rec.countedAt).slice(0, 10)}
                                </div>
                                <div className="grid gap-2 sm:grid-cols-3">
                                  <div>Cash in: {formatCurrency(Number(recDayDetails[rec.id]?.cashInPeriod || 0))}</div>
                                  <div>Cash out: {formatCurrency(Number(recDayDetails[rec.id]?.cashOutPeriod || 0))}</div>
                                  <div>Day net: {formatCurrency(Number(recDayDetails[rec.id]?.expectedDayNet || 0))}</div>
                                </div>
                                <div className="space-y-1">
                                  {(recDayDetails[rec.id]?.sourceBreakdown || []).length ? (
                                    (recDayDetails[rec.id]?.sourceBreakdown || []).map((row) => (
                                      <div key={`${rec.id}-${row.sourceType}`} className="grid gap-2 rounded border px-2 py-1 sm:grid-cols-4">
                                        <div className="font-medium">{row.label}</div>
                                        <div>In: {formatCurrency(Number(row.cashIn || 0))}</div>
                                        <div>Out: {formatCurrency(Number(row.cashOut || 0))}</div>
                                        <div className={varianceColorClass(Number(row.net || 0))}>
                                          Net: {formatCurrency(Number(row.net || 0))}
                                        </div>
                                      </div>
                                    ))
                                  ) : (
                                    <div className="text-muted-foreground">No cash movements for this day/account.</div>
                                  )}
                                </div>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="px-6 py-10 text-center text-muted-foreground">
              <div className="text-2xl mb-2">—</div>
              <p>No reconciliations found for this range.</p>
              {historyVariance === "nonzero" || historyRange !== "all" ? (
                <p className="text-xs mt-1">Try clearing the filters to see all records.</p>
              ) : null}
            </div>
          )}

          {/* Pagination */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-6 pt-3 text-xs text-muted-foreground">
            <div>
              Page {historyPage} of {historyTotalPages} · {historyTotal} total record{historyTotal !== 1 ? "s" : ""}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                disabled={historyPage <= 1}
              >
                ← Prev
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setHistoryPage((p) => Math.min(historyTotalPages, p + 1))}
                disabled={historyPage >= historyTotalPages}
              >
                Next →
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* DIALOG: Cash deposit */}
      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record cash deposit</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 text-sm">
            <div className="flex flex-col gap-1">
              <Label htmlFor="deposit-bank">Deposit to bank <span className="text-destructive ml-0.5">*</span></Label>
              <select
                id="deposit-bank"
                className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                value={depositBankId}
                onChange={(e) => setDepositBankId(e.target.value)}
              >
                <option value="">Select bank account…</option>
                {(bankAccounts || []).map((acct) => (
                  <option key={acct.id} value={acct.id}>
                    {acct.name}
                    {acct.bankName ? ` · ${acct.bankName}` : ""}
                    {acct.accountNumberMasked ? ` · ${acct.accountNumberMasked}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="deposit-amount">Amount <span className="text-destructive ml-0.5">*</span></Label>
              <Input
                id="deposit-amount"
                placeholder="0.00"
                type="number"
                step="0.01"
                inputMode="decimal"
                data-no-drag-scroll="1"
                onMouseDown={(e) => e.stopPropagation()}
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="deposit-notes">Notes <span className="text-xs font-normal text-muted-foreground">(optional)</span></Label>
              <Input
                id="deposit-notes"
                placeholder="Any notes about this deposit…"
                data-no-drag-scroll="1"
                onMouseDown={(e) => e.stopPropagation()}
                value={depositNotes}
                onChange={(e) => setDepositNotes(e.target.value)}
                maxLength={300}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDepositOpen(false)} disabled={depositSaving}>
              Cancel
            </Button>
            <Button onClick={submitDeposit} disabled={depositSaving}>
              {depositSaving ? "Saving…" : "Save deposit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DIALOG: Auto-catchup */}
      <Dialog open={catchupOpen} onOpenChange={setCatchupOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Auto-catchup missing days</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-xs text-muted-foreground">
              Select missed days to auto-create reconciliations with zero variance (expected = actual). Use only after physical verification.
            </p>

            {/* Select All / Deselect All */}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const next: Record<string, boolean> = {};
                  for (const day of allCatchupDays) next[day] = true;
                  setCatchupDays(next);
                }}
              >
                Select all
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const next: Record<string, boolean> = {};
                  for (const day of allCatchupDays) next[day] = false;
                  setCatchupDays(next);
                }}
              >
                Deselect all
              </Button>
              <span className="text-xs text-muted-foreground">
                {catchupSelectedCount} of {allCatchupDays.length} selected
              </span>
            </div>

            <div className="max-h-64 space-y-1 overflow-auto rounded border p-2">
              {allCatchupDays.map((day) => (
                <label key={day} className="flex items-center gap-2 rounded border px-2 py-1 cursor-pointer hover:bg-muted/30">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={Boolean(catchupDays[day])}
                    onChange={(e) =>
                      setCatchupDays((prev) => ({ ...prev, [day]: e.target.checked }))
                    }
                  />
                  <span>{day}</span>
                </label>
              ))}
            </div>

            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={catchupVerified}
                onChange={(e) => setCatchupVerified(e.target.checked)}
              />
              I verified each selected day physically and confirmed zero variance.
            </label>

            <div className="flex flex-col gap-1">
              <Label htmlFor="catchup-note" className="text-xs">
                Verification note <span className="text-destructive ml-0.5">*</span>
              </Label>
              <Input
                id="catchup-note"
                value={catchupNote}
                onChange={(e) => setCatchupNote(e.target.value)}
                placeholder="Describe verification performed (min 10 chars)…"
                maxLength={500}
              />
              <p className={`text-xs text-right ${catchupNote.trim().length > 0 && catchupNote.trim().length < 10 ? "text-red-600" : "text-muted-foreground"}`}>
                {catchupNote.length}/500
                {catchupNote.trim().length > 0 && catchupNote.trim().length < 10
                  ? ` · ${10 - catchupNote.trim().length} more character${10 - catchupNote.trim().length !== 1 ? "s" : ""} required`
                  : null}
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setCatchupOpen(false)}
              disabled={catchupSaving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submitAutoCatchup}
              disabled={catchupSaving || catchupSelectedCount === 0 || !catchupVerified || catchupNote.trim().length < 10}
            >
              {catchupSaving ? "Running…" : `Run auto-catchup (${catchupSelectedCount} day${catchupSelectedCount !== 1 ? "s" : ""})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── OPENING BALANCE DIALOG ──────────────────────────────────────────── */}
      <Dialog open={obOpen} onOpenChange={setObOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Set Opening Balance Anchor</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Records a one-time verified physical count as the authoritative starting point for
              this cash account. If the GL balance differs from your count, a journal entry is
              posted to bring the two in sync — eliminating the Operational vs Ledger variance
              going forward.
            </p>

            {/* Current GL balance info */}
            <div className="rounded-md border bg-muted/30 p-3 space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Current GL balance (as of today)</span>
                <span className="font-mono font-medium">{formatCurrency(expectedBalance)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Account</span>
                <span className="font-mono">{data?.cashAccount?.code ?? "—"} · {data?.cashAccount?.name ?? "—"}</span>
              </div>
            </div>

            {/* Verified count input */}
            <div className="flex flex-col gap-1">
              <Label htmlFor="ob-count">
                Verified physical count <span className="text-destructive ml-0.5">*</span>
              </Label>
              <Input
                id="ob-count"
                type="number"
                min="0"
                step="0.01"
                value={obVerifiedCount}
                onChange={(e) => setObVerifiedCount(e.target.value)}
                placeholder="0.00"
              />
            </div>

            {/* Variance preview */}
            {obVerifiedCount.trim() !== "" && Number.isFinite(Number(obVerifiedCount)) && (
              (() => {
                const adj = Number((Number(obVerifiedCount) - expectedBalance).toFixed(2));
                return (
                  <div className={`rounded-md border p-3 text-xs space-y-1 ${adj === 0 ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
                    <p className="font-medium">
                      {adj === 0
                        ? "GL matches your count — no adjustment needed."
                        : `GL adjustment required: ${adj >= 0 ? "+" : ""}${formatCurrency(adj)}`}
                    </p>
                    {adj !== 0 && (
                      <p className="text-muted-foreground">
                        {adj > 0
                          ? "Cash account will be debited and Opening Balance Equity credited."
                          : "Opening Balance Equity will be debited and Cash account credited."}
                      </p>
                    )}
                  </div>
                );
              })()
            )}

            {/* Anchor date */}
            <div className="flex flex-col gap-1">
              <Label htmlFor="ob-date">Anchor date</Label>
              <Input
                id="ob-date"
                type="date"
                value={obDate}
                onChange={(e) => setObDate(e.target.value)}
              />
            </div>

            {/* Post GL adjustment toggle */}
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-primary"
                checked={obPostGl}
                onChange={(e) => setObPostGl(e.target.checked)}
              />
              <span>
                Post a GL adjustment journal entry if the count differs from the current ledger
                balance{" "}
                <span className="text-muted-foreground">(recommended — keeps books in sync)</span>
              </span>
            </label>

            {/* Notes */}
            <div className="flex flex-col gap-1">
              <Label htmlFor="ob-notes">Notes <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                id="ob-notes"
                value={obNotes}
                onChange={(e) => setObNotes(e.target.value)}
                placeholder="e.g. End-of-year physical count by management team"
                maxLength={500}
              />
            </div>

            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              <strong>One-time action:</strong> Only one opening balance anchor is allowed per cash
              account. Contact an administrator to remove an existing anchor if you need to reset it.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setObOpen(false)} disabled={obSaving}>
              Cancel
            </Button>
            <Button
              onClick={submitOpeningBalance}
              disabled={obSaving || !obVerifiedCount.trim() || !Number.isFinite(Number(obVerifiedCount)) || !obDate}
            >
              {obSaving ? "Saving…" : "Set Opening Balance"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
