"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  reconcileMode?: "ledger" | "operational" | null;
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

function toLocalYmd(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
  const [allowReopenOverride, setAllowReopenOverride] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [openingTillFloat, setOpeningTillFloat] = useState("");
  const [countedClosingTill, setCountedClosingTill] = useState("");
  const [countChecklist, setCountChecklist] = useState(false);
  const [varianceChecklist, setVarianceChecklist] = useState(false);
  const [noteChecklist, setNoteChecklist] = useState(false);
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

  const { data } = useClientQuery<CashReconResponse>({
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
  const variancePreview = (() => {
    if (!actualAmount.trim()) return null;
    const actual = Number(actualAmount);
    if (!Number.isFinite(actual)) return null;
    return Number((actual - expectedForMode).toFixed(2));
  })();

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
    if (variancePreview !== null && variancePreview !== 0) {
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
    const w = window.open("", "_blank", "noopener,noreferrer,width=980,height=760");
    if (!w) {
      toast.error("Unable to open print preview.");
      return;
    }
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
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  };

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

  useEffect(() => {
    setHistoryPage(1);
  }, [historyRange, historyFrom, historyTo, historyVariance, historyPageSize, cashAccountId]);

  useEffect(() => {
    if (historyPage > historyTotalPages) {
      setHistoryPage(historyTotalPages);
    }
  }, [historyPage, historyTotalPages]);

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

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Cash Reconciliation</h1>
        <p className="text-sm text-muted-foreground">
          Compare counted cash to the ledger balance and post a variance adjustment when needed.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Reconciliation mode</span>
            <select
              className="h-10 w-full sm:w-auto rounded-md border bg-background px-3 text-sm"
              value={mode}
              onChange={(e) => setMode(e.target.value as "ledger" | "operational")}
            >
              <option value="operational">Operational (day cash-up)</option>
              <option value="ledger">Ledger (GL as-of)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Cash account</span>
            <select
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
          </label>
          {mode === "operational" ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Operational scope</span>
              <select
                className="h-10 w-full sm:w-auto rounded-md border bg-background px-3 text-sm"
                value={operationalScope}
                onChange={(e) => setOperationalScope(e.target.value as "all" | "otc")}
              >
                <option value="all">All cash movements</option>
                <option value="otc">OTC only</option>
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">As of date</span>
            <div className="flex flex-wrap items-center gap-2">
              <Input className="w-full sm:w-auto" type="date" value={asOf} onChange={(e) => handleAsOfChange(e.target.value)} />
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
          </label>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        {mode === "operational"
          ? "Operational mode reconciles day net movement (cash in - cash out) for the selected day."
          : "Ledger mode uses cumulative posted GL cash balance as of selected date (end of day)."}
      </p>
      {mode === "ledger" && expectedBalance < 0 ? (
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
      {mode === "operational" && unreconciledDays && unreconciledDays.count > 0 ? (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="pt-4 text-xs text-amber-900 space-y-1">
              <div className="font-medium">
                {unreconciledDays.count} day(s) with cash movement are not reconciled up to {asOf}.
              </div>
              <div>
                Oldest: {unreconciledDays.oldest || "-"} · Newest: {unreconciledDays.newest || "-"}
              </div>
              {unreconciledDays.oldest ? (
                <div className="flex flex-wrap items-center gap-2">
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
      {selectedDay?.reconciled ? (
        <Card className="border-sky-300 bg-sky-50">
          <CardContent className="pt-4 text-xs text-sky-900 space-y-2">
            <div className="font-medium">
              {selectedDay.day} already has {selectedDay.reconciliationCount} reconciliation record(s).
            </div>
            <div>
              Latest by {selectedDay.latestBy || "System"} · Variance {formatCurrency(Number(selectedDay.latestVariance || 0))}
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={allowReopenOverride}
                onChange={(e) => setAllowReopenOverride(e.target.checked)}
              />
              Allow override (resave reconciled day)
            </label>
            {allowReopenOverride ? (
              <Input
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                placeholder="Reason for reopening this day (min 10 chars)"
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {mode === "ledger" && unreconciledDays && unreconciledDays.count > 0 ? (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="pt-4 text-xs text-amber-900 space-y-1">
            <div className="font-medium">
              {unreconciledDays.count} operational day(s) with cash movement are not reconciled up to {asOf}.
            </div>
            <div>
              Switch to Operational mode to close missing day reconciliations.
            </div>
          </CardContent>
        </Card>
      ) : null}
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
                    Net: <span className="text-foreground">{formatCurrency(row.net)}</span>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
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
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-muted-foreground">Expected day net (in - out)</span>
                <span className="font-semibold">{formatCurrency(expectedOperational)}</span>
              </div>
            </>
          ) : null}
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <span className="text-muted-foreground">
              {mode === "operational" ? "Expected value for reconciliation" : "GL cash balance (as-of)"}
            </span>
            <span className="font-semibold">{formatCurrency(expectedForMode)}</span>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <span className="text-muted-foreground">
              {mode === "operational" ? "Counted day net movement" : "Counted cash"}
            </span>
            <span className="font-semibold">
              {variancePreview === null ? "—" : formatCurrency(Number(actualAmount))}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <span className="text-muted-foreground">Variance</span>
            <span className={`font-semibold ${variancePreview && variancePreview !== 0 ? "text-amber-700" : ""}`}>
              {variancePreview === null ? "—" : formatCurrency(variancePreview)}
            </span>
          </div>
        </CardContent>
      </Card>
      {mode === "operational" ? (
        <Card>
          <CardHeader>
            <CardTitle>Till Calculator (optional)</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Input
              placeholder="Opening till float"
              type="number"
              step="0.01"
              inputMode="decimal"
              value={openingTillFloat}
              onChange={(e) => setOpeningTillFloat(e.target.value)}
            />
            <Input
              placeholder="Counted closing till"
              type="number"
              step="0.01"
              inputMode="decimal"
              value={countedClosingTill}
              onChange={(e) => setCountedClosingTill(e.target.value)}
            />
            <div className="rounded-md border px-3 py-2">
              <div className="text-xs text-muted-foreground">Counted day net</div>
              <div className="font-semibold">{tillCalc ? formatCurrency(tillCalc.countedDayNet) : "—"}</div>
            </div>
            <div className="rounded-md border px-3 py-2">
              <div className="text-xs text-muted-foreground">Till-vs-ledger day variance</div>
              <div className={`font-semibold ${tillCalc && tillCalc.variance !== 0 ? "text-amber-700" : ""}`}>
                {tillCalc ? formatCurrency(tillCalc.variance) : "—"}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Record cash count</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={exportReconciliationCsv}
              >
                Export CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={printReconciliationReport}
              >
                Print Report
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setDepositOpen(true)}
                disabled={!canDepositForSelectedDay}
              >
                Deposit cash to bank
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Input
            placeholder={mode === "operational" ? "Counted day net movement" : "Counted cash amount"}
            type="number"
            step="0.01"
            inputMode="decimal"
            data-no-drag-scroll="1"
            onMouseDown={(e) => e.stopPropagation()}
            value={actualAmount}
            onChange={(e) => setActualAmount(e.target.value)}
          />
          <select
            className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
            value={varianceReason}
            onChange={(e) => setVarianceReason(e.target.value)}
          >
            <option value="">Variance reason (required if non-zero)</option>
            <option value="COUNT_ERROR">Count error</option>
            <option value="UNRECORDED_PAYOUT">Unrecorded payout</option>
            <option value="TIMING_DIFFERENCE">Timing difference</option>
            <option value="SUSPECTED_SHRINKAGE">Suspected shrinkage</option>
            <option value="OTHER">Other</option>
          </select>
          <Input
            placeholder={variancePreview !== null && variancePreview !== 0 ? "Variance explanation (required)" : "Notes (optional)"}
            data-no-drag-scroll="1"
            onMouseDown={(e) => e.stopPropagation()}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <div className="mb-2 rounded-md border bg-muted/20 p-2 text-xs">
              <div className="mb-1 font-medium">Open day checklist</div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={countChecklist}
                  onChange={(e) => setCountChecklist(e.target.checked)}
                />
                Physical cash count completed.
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={varianceChecklist}
                  onChange={(e) => setVarianceChecklist(e.target.checked)}
                />
                Any discrepancy reviewed and validated.
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={noteChecklist}
                  onChange={(e) => setNoteChecklist(e.target.checked)}
                />
                Notes/reason captured where required.
              </label>
            </div>
            <Button className="w-full sm:w-auto" onClick={submitReconciliation} disabled={saving}>
              {saving ? "Saving..." : "Save cash reconciliation"}
            </Button>
            {!canDepositForSelectedDay ? (
              <p className="mt-2 text-xs text-amber-700">
                {mode !== "operational"
                  ? "Cash deposit is available in Operational mode only."
                  : "Reconcile the selected day first before recording a cash deposit."}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record cash deposit</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Deposit to bank
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm text-foreground"
                value={depositBankId}
                onChange={(e) => setDepositBankId(e.target.value)}
              >
                <option value="">Select bank</option>
                {(bankAccounts || []).map((acct) => (
                  <option key={acct.id} value={acct.id}>
                    {acct.name}
                    {acct.bankName ? ` · ${acct.bankName}` : ""}
                    {acct.accountNumberMasked ? ` · ${acct.accountNumberMasked}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <Input
              placeholder="Deposit amount"
              type="number"
              step="0.01"
              inputMode="decimal"
              data-no-drag-scroll="1"
              onMouseDown={(e) => e.stopPropagation()}
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
            />
            <Input
              placeholder="Notes (optional)"
              data-no-drag-scroll="1"
              onMouseDown={(e) => e.stopPropagation()}
              value={depositNotes}
              onChange={(e) => setDepositNotes(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button className="w-full sm:w-auto" variant="outline" onClick={() => setDepositOpen(false)} disabled={depositSaving}>
              Cancel
            </Button>
            <Button className="w-full sm:w-auto" onClick={submitDeposit} disabled={depositSaving}>
              {depositSaving ? "Saving..." : "Save deposit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={catchupOpen} onOpenChange={setCatchupOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Auto-catchup missing days</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              Select missed days to auto-create reconciliations with zero variance (expected = actual). Use only after physical verification.
            </p>
            <div className="max-h-64 space-y-1 overflow-auto rounded border p-2">
              {(unreconciledDays?.all || []).map((day) => (
                <label key={day} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                  <span>{day}</span>
                  <input
                    type="checkbox"
                    checked={Boolean(catchupDays[day])}
                    onChange={(e) =>
                      setCatchupDays((prev) => ({ ...prev, [day]: e.target.checked }))
                    }
                  />
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={catchupVerified}
                onChange={(e) => setCatchupVerified(e.target.checked)}
              />
              I verified each selected day physically and confirmed zero variance.
            </label>
            <Input
              value={catchupNote}
              onChange={(e) => setCatchupNote(e.target.value)}
              placeholder="Verification note (required, min 10 chars)"
            />
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
            <Button type="button" onClick={submitAutoCatchup} disabled={catchupSaving}>
              {catchupSaving ? "Running..." : "Run auto-catchup"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Recent reconciliations</CardTitle>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <label className="flex items-center gap-2">
                History range
                <select
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={historyRange}
                  onChange={(e) => setHistoryRange(e.target.value as "today" | "month" | "all")}
                >
                  <option value="today">Today</option>
                  <option value="month">This month</option>
                  <option value="all">All</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                From
                <Input
                  className="h-8 w-auto"
                  type="date"
                  value={historyFrom}
                  onChange={(e) => setHistoryFrom(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-2">
                To
                <Input
                  className="h-8 w-auto"
                  type="date"
                  value={historyTo}
                  onChange={(e) => setHistoryTo(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-2">
                Variance
                <select
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={historyVariance}
                  onChange={(e) => setHistoryVariance(e.target.value as "all" | "nonzero")}
                >
                  <option value="all">All</option>
                  <option value="nonzero">Non-zero only</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                Rows
                <select
                  className="h-8 rounded-md border bg-background px-2 text-sm text-foreground"
                  value={historyPageSize}
                  onChange={(e) => setHistoryPageSize(Number(e.target.value))}
                >
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                </select>
              </label>
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
                Clear
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          {reconciliations.length ? (
            reconciliations.map((rec) => (
              <div key={rec.id} className="border rounded-md px-3 py-2 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">
                    {new Date(rec.countedAt).toLocaleDateString()} · {rec.cashAccount.code} {rec.cashAccount.name}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span
                      className={`inline-flex rounded px-2 py-0.5 ${
                        rec.reconcileMode === "ledger"
                          ? "bg-sky-100 text-sky-800"
                          : "bg-emerald-100 text-emerald-800"
                      }`}
                    >
                      {rec.reconcileMode === "ledger" ? "LEDGER" : "OPERATIONAL"}
                    </span>
                    <span>{rec.createdBy?.name || rec.createdBy?.email || "System"}</span>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 text-xs">
                  <div>Expected: {formatCurrency(Number(rec.expectedAmount))}</div>
                  <div>Actual: {formatCurrency(Number(rec.actualAmount))}</div>
                  <div>Variance: {formatCurrency(Number(rec.variance))}</div>
                  <div>
                    {rec.journalEntryId ? `Journal: ${rec.journalEntryId}` : "No journal entry"}
                  </div>
                </div>
                {rec.notes ? <div className="text-xs text-muted-foreground">Notes: {rec.notes}</div> : null}
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void toggleRecDetails(rec)}
                  >
                    {expandedRecIds[rec.id] ? "Hide day details" : "View day details"}
                  </Button>
                </div>
                {expandedRecIds[rec.id] ? (
                  <div className="rounded-md border bg-muted/20 p-3 text-xs space-y-2">
                    {recDayDetails[rec.id]?.loading ? (
                      <div className="text-muted-foreground">Loading day details...</div>
                    ) : recDayDetails[rec.id]?.error ? (
                      <div className="text-red-600">{recDayDetails[rec.id]?.error}</div>
                    ) : (
                      <>
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
                                <div>Net: {formatCurrency(Number(row.net || 0))}</div>
                              </div>
                            ))
                          ) : (
                            <div className="text-muted-foreground">No cash movements for this day/account.</div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <div className="text-muted-foreground">No reconciliations in this range.</div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
            <div>
              Page {historyPage} of {historyTotalPages} ({historyTotal} total)
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                disabled={historyPage <= 1}
              >
                Prev
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setHistoryPage((p) => Math.min(historyTotalPages, p + 1))}
                disabled={historyPage >= historyTotalPages}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
