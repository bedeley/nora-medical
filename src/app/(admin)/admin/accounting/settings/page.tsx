"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AppSettingSnapshot, fetchAppSetting, fetchJsonOrThrow, saveAppSetting } from "@/lib/app-settings-client";
import { toast } from "sonner";

type ThresholdConfig = {
  arDifference: number;
  inventoryDifference: number;
  draftEntries: boolean;
  negativeStock: boolean;
};

type StoreCreditApplyPolicy = "oldest_first" | "current_order_first" | "manual_apply_only";
type ManualEntriesPolicy = {
  periodBasis: "MONTHLY_CALENDAR" | "FISCAL_PERIOD_END";
  periodEndWindowDays: number;
  requireExceptionOutsideWindow: boolean;
  minExceptionNoteLength: number;
};
type ReconcileThresholds = {
  currencyMinorPct: number;
  currencyWarningPct: number;
  marginMinorAbsPct: number;
  marginWarningAbsPct: number;
};
type JournalRuntimePolicy = {
  recentWindowDays: number;
  manualEntryAllowPnl: boolean;
  archiveAfterMonths: number;
  archiveCronDryRun: boolean;
};
type SettingsAuditRow = {
  id: string;
  createdAt: string;
  actor?: { name?: string | null; email?: string | null } | null;
  meta?: Record<string, unknown> | null;
};
type SettingsAuditResponse = {
  items: SettingsAuditRow[];
};

const DEFAULT_THRESHOLDS: ThresholdConfig = {
  arDifference: 0.01,
  inventoryDifference: 0.01,
  draftEntries: true,
  negativeStock: true,
};
const DEFAULT_REPORTING_USE_LEDGER = false;
const DEFAULT_STORE_CREDIT_POLICY: StoreCreditApplyPolicy = "oldest_first";
const DEFAULT_BANK_TXN_EDIT_WINDOW_DAYS = 7;
const DEFAULT_MONTHLY_REOPEN_WINDOW_DAYS = 7;
const DEFAULT_FISCAL_REOPEN_WINDOW_DAYS = 30;
const DEFAULT_ENFORCE_FINALIZED_YEAR_LOCK = false;
const DEFAULT_MANUAL_ENTRIES_POLICY: ManualEntriesPolicy = {
  periodBasis: "MONTHLY_CALENDAR",
  periodEndWindowDays: 5,
  requireExceptionOutsideWindow: true,
  minExceptionNoteLength: 12,
};
const DEFAULT_RECONCILE_THRESHOLDS: ReconcileThresholds = {
  currencyMinorPct: 0.01,
  currencyWarningPct: 0.05,
  marginMinorAbsPct: 0.1,
  marginWarningAbsPct: 0.5,
};
const DEFAULT_JOURNAL_POLICY: JournalRuntimePolicy = {
  recentWindowDays: 90,
  manualEntryAllowPnl: false,
  archiveAfterMonths: 18,
  archiveCronDryRun: false,
};

export default function AccountingSettingsPage() {
  const { data: session } = useSession();
  const role = String(session?.user?.role || "");
  const isAdmin = role === "ADMIN";

  const { data, refetch, error: thresholdsLoadError } = useClientQuery<AppSettingSnapshot<ThresholdConfig>>({
    queryKey: ["accounting", "integrity-thresholds", "global"],
    queryFn: () => fetchAppSetting<ThresholdConfig>("accounting.integrity.thresholds"),
  });
  const { data: ledgerModeData, refetch: refetchLedgerMode, error: reportingLoadError } = useClientQuery<AppSettingSnapshot<boolean>>({
    queryKey: ["accounting", "reporting", "use-ledger"],
    queryFn: () => fetchAppSetting<boolean>("accounting.reporting.useLedger"),
  });
  const { data: storeCreditPolicyData, refetch: refetchStoreCreditPolicy, error: storeCreditLoadError } = useClientQuery<AppSettingSnapshot<StoreCreditApplyPolicy>>({
    queryKey: ["accounting", "store-credit", "apply-policy"],
    queryFn: () => fetchAppSetting<StoreCreditApplyPolicy>("accounting.storeCredit.applyPolicy"),
  });
  const { data: bankTxnEditWindowData, refetch: refetchBankTxnEditWindow, error: bankEditLoadError } = useClientQuery<AppSettingSnapshot<number | string>>({
    queryKey: ["accounting", "bank-transactions", "edit-window-days"],
    queryFn: () => fetchAppSetting<number | string>("accounting.bankTransactions.editWindowDays"),
  });
  const { data: manualEntriesPolicyData, refetch: refetchManualEntriesPolicy, error: manualPolicyLoadError } = useClientQuery<AppSettingSnapshot<ManualEntriesPolicy>>({
    queryKey: ["accounting", "manual-entries", "policy"],
    queryFn: () => fetchAppSetting<ManualEntriesPolicy>("accounting.manualEntries.policy"),
  });
  const { data: reconcileThresholdsData, refetch: refetchReconcileThresholds, error: reconcileLoadError } = useClientQuery<AppSettingSnapshot<ReconcileThresholds>>({
    queryKey: ["accounting", "reconcile", "thresholds"],
    queryFn: () => fetchAppSetting<ReconcileThresholds>("accounting.reconcile.thresholds"),
  });
  const { data: monthlyReopenWindowData, refetch: refetchMonthlyReopenWindow, error: monthlyReopenLoadError } = useClientQuery<AppSettingSnapshot<number | string>>({
    queryKey: ["accounting", "reopen", "monthly-window-days"],
    queryFn: () => fetchAppSetting<number | string>("accounting.reopen.monthlyWindowDays"),
  });
  const { data: fiscalReopenWindowData, refetch: refetchFiscalReopenWindow, error: fiscalReopenLoadError } = useClientQuery<AppSettingSnapshot<number | string>>({
    queryKey: ["accounting", "reopen", "fiscal-window-days"],
    queryFn: () => fetchAppSetting<number | string>("accounting.reopen.fiscalWindowDays"),
  });
  const { data: enforceFinalizedYearLockData, refetch: refetchEnforceFinalizedYearLock, error: finalizedLockLoadError } = useClientQuery<AppSettingSnapshot<boolean | string>>({
    queryKey: ["accounting", "reopen", "enforce-finalized-year-lock"],
    queryFn: () => fetchAppSetting<boolean | string>("accounting.reopen.enforceFinalizedYearLock"),
  });
  const { data: finalizedFiscalYearsData, refetch: refetchFinalizedFiscalYears, error: finalizedYearsLoadError } = useClientQuery<AppSettingSnapshot<number[]>>({
    queryKey: ["accounting", "reopen", "finalized-fiscal-years"],
    queryFn: () => fetchAppSetting<number[]>("accounting.reopen.finalizedFiscalYears"),
  });
  const { data: journalPolicyData, refetch: refetchJournalPolicy, error: journalPolicyLoadError } = useClientQuery<AppSettingSnapshot<JournalRuntimePolicy>>({
    queryKey: ["accounting", "journal", "policy"],
    queryFn: () => fetchAppSetting<JournalRuntimePolicy>("accounting.journal.policy"),
  });
  const { data: settingsAuditData, refetch: refetchSettingsAudit, error: settingsAuditLoadError } = useClientQuery<SettingsAuditResponse>({
    queryKey: ["accounting", "settings", "audit-latest"],
    queryFn: async () => {
      const res = await fetch("/api/admin/audit?scope=accounting_settings&paginate=1&page=1&pageSize=200");
      return fetchJsonOrThrow<SettingsAuditResponse>(res, "Failed to load settings audit entries.");
    },
  });

  const [arDifference, setArDifference] = useState(String(DEFAULT_THRESHOLDS.arDifference));
  const [inventoryDifference, setInventoryDifference] = useState(String(DEFAULT_THRESHOLDS.inventoryDifference));
  const [draftEntries, setDraftEntries] = useState(DEFAULT_THRESHOLDS.draftEntries);
  const [negativeStock, setNegativeStock] = useState(DEFAULT_THRESHOLDS.negativeStock);
  const [saving, setSaving] = useState(false);

  const [useLedger, setUseLedger] = useState(DEFAULT_REPORTING_USE_LEDGER);
  const [savingLedger, setSavingLedger] = useState(false);

  const [storeCreditPolicy, setStoreCreditPolicy] = useState<StoreCreditApplyPolicy>(DEFAULT_STORE_CREDIT_POLICY);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const [bankTxnEditWindowDays, setBankTxnEditWindowDays] = useState(String(DEFAULT_BANK_TXN_EDIT_WINDOW_DAYS));
  const [savingBankTxnEditWindow, setSavingBankTxnEditWindow] = useState(false);
  const [manualPeriodEndWindowDays, setManualPeriodEndWindowDays] = useState(String(DEFAULT_MANUAL_ENTRIES_POLICY.periodEndWindowDays));
  const [manualPeriodBasis, setManualPeriodBasis] = useState<"MONTHLY_CALENDAR" | "FISCAL_PERIOD_END">(DEFAULT_MANUAL_ENTRIES_POLICY.periodBasis);
  const [manualRequireExceptionOutsideWindow, setManualRequireExceptionOutsideWindow] = useState(DEFAULT_MANUAL_ENTRIES_POLICY.requireExceptionOutsideWindow);
  const [manualMinExceptionNoteLength, setManualMinExceptionNoteLength] = useState(String(DEFAULT_MANUAL_ENTRIES_POLICY.minExceptionNoteLength));
  const [savingManualPolicy, setSavingManualPolicy] = useState(false);
  const [reconcileCurrencyMinorPct, setReconcileCurrencyMinorPct] = useState(String(DEFAULT_RECONCILE_THRESHOLDS.currencyMinorPct));
  const [reconcileCurrencyWarningPct, setReconcileCurrencyWarningPct] = useState(String(DEFAULT_RECONCILE_THRESHOLDS.currencyWarningPct));
  const [reconcileMarginMinorAbsPct, setReconcileMarginMinorAbsPct] = useState(String(DEFAULT_RECONCILE_THRESHOLDS.marginMinorAbsPct));
  const [reconcileMarginWarningAbsPct, setReconcileMarginWarningAbsPct] = useState(String(DEFAULT_RECONCILE_THRESHOLDS.marginWarningAbsPct));
  const [savingReconcileThresholds, setSavingReconcileThresholds] = useState(false);
  const [journalRecentWindowDays, setJournalRecentWindowDays] = useState(String(DEFAULT_JOURNAL_POLICY.recentWindowDays));
  const [journalManualEntryAllowPnl, setJournalManualEntryAllowPnl] = useState(DEFAULT_JOURNAL_POLICY.manualEntryAllowPnl);
  const [journalArchiveAfterMonths, setJournalArchiveAfterMonths] = useState(String(DEFAULT_JOURNAL_POLICY.archiveAfterMonths));
  const [journalArchiveCronDryRun, setJournalArchiveCronDryRun] = useState(DEFAULT_JOURNAL_POLICY.archiveCronDryRun);
  const [savingJournalPolicy, setSavingJournalPolicy] = useState(false);
  const [monthlyReopenWindowDays, setMonthlyReopenWindowDays] = useState(String(DEFAULT_MONTHLY_REOPEN_WINDOW_DAYS));
  const [fiscalReopenWindowDays, setFiscalReopenWindowDays] = useState(String(DEFAULT_FISCAL_REOPEN_WINDOW_DAYS));
  const [enforceFinalizedYearLock, setEnforceFinalizedYearLock] = useState(DEFAULT_ENFORCE_FINALIZED_YEAR_LOCK);
  const [finalizedFiscalYears, setFinalizedFiscalYears] = useState("");
  const [savingReopenPolicy, setSavingReopenPolicy] = useState(false);
  const [saveAllSummary, setSaveAllSummary] = useState<Array<{ section: string; status: "saved" | "failed" | "skipped"; message: string }>>([]);

  const [resetDialog, setResetDialog] = useState<null | "thresholds" | "reporting" | "storeCredit" | "bankEdit" | "manualPolicy" | "reconcileThresholds" | "journalPolicy" | "reopenPolicy">(null);

  const currentThresholds = useMemo(() => {
    const value = data?.value;
    if (!value) return DEFAULT_THRESHOLDS;
    return {
      arDifference: Number(value.arDifference ?? DEFAULT_THRESHOLDS.arDifference),
      inventoryDifference: Number(value.inventoryDifference ?? DEFAULT_THRESHOLDS.inventoryDifference),
      draftEntries: Boolean(value.draftEntries ?? DEFAULT_THRESHOLDS.draftEntries),
      negativeStock: Boolean(value.negativeStock ?? DEFAULT_THRESHOLDS.negativeStock),
    };
  }, [data?.value]);

  const currentLedgerMode = useMemo(() => {
    if (ledgerModeData?.value === null || ledgerModeData?.value === undefined) return DEFAULT_REPORTING_USE_LEDGER;
    return Boolean(ledgerModeData.value);
  }, [ledgerModeData?.value]);

  const currentStoreCreditPolicy = useMemo<StoreCreditApplyPolicy>(() => {
    const value = String(storeCreditPolicyData?.value || "").trim().toLowerCase();
    if (value === "oldest_first" || value === "current_order_first" || value === "manual_apply_only") {
      return value as StoreCreditApplyPolicy;
    }
    return DEFAULT_STORE_CREDIT_POLICY;
  }, [storeCreditPolicyData?.value]);

  const currentBankTxnEditWindowDays = useMemo(() => {
    const raw = bankTxnEditWindowData?.value;
    const next = Number(typeof raw === "number" ? raw : typeof raw === "string" ? raw : DEFAULT_BANK_TXN_EDIT_WINDOW_DAYS);
    if (!Number.isFinite(next)) return DEFAULT_BANK_TXN_EDIT_WINDOW_DAYS;
    return Math.min(365, Math.max(0, Math.floor(next)));
  }, [bankTxnEditWindowData?.value]);
  const currentManualEntriesPolicy = useMemo<ManualEntriesPolicy>(() => {
    const value = manualEntriesPolicyData?.value;
    if (!value) return DEFAULT_MANUAL_ENTRIES_POLICY;
    return {
      periodBasis:
        String(value.periodBasis || "").toUpperCase() === "FISCAL_PERIOD_END"
          ? "FISCAL_PERIOD_END"
          : "MONTHLY_CALENDAR",
      periodEndWindowDays: Math.max(0, Math.min(31, Math.floor(Number(value.periodEndWindowDays ?? DEFAULT_MANUAL_ENTRIES_POLICY.periodEndWindowDays)))),
      requireExceptionOutsideWindow:
        typeof value.requireExceptionOutsideWindow === "boolean"
          ? value.requireExceptionOutsideWindow
          : DEFAULT_MANUAL_ENTRIES_POLICY.requireExceptionOutsideWindow,
      minExceptionNoteLength: Math.max(8, Math.min(200, Math.floor(Number(value.minExceptionNoteLength ?? DEFAULT_MANUAL_ENTRIES_POLICY.minExceptionNoteLength)))),
    };
  }, [manualEntriesPolicyData?.value]);
  const currentReconcileThresholds = useMemo<ReconcileThresholds>(() => {
    const value = reconcileThresholdsData?.value;
    if (!value) return DEFAULT_RECONCILE_THRESHOLDS;
    return {
      currencyMinorPct: Number(value.currencyMinorPct ?? DEFAULT_RECONCILE_THRESHOLDS.currencyMinorPct),
      currencyWarningPct: Number(value.currencyWarningPct ?? DEFAULT_RECONCILE_THRESHOLDS.currencyWarningPct),
      marginMinorAbsPct: Number(value.marginMinorAbsPct ?? DEFAULT_RECONCILE_THRESHOLDS.marginMinorAbsPct),
      marginWarningAbsPct: Number(value.marginWarningAbsPct ?? DEFAULT_RECONCILE_THRESHOLDS.marginWarningAbsPct),
    };
  }, [reconcileThresholdsData?.value]);
  const currentJournalPolicy = useMemo<JournalRuntimePolicy>(() => {
    const value = journalPolicyData?.value;
    if (!value) return DEFAULT_JOURNAL_POLICY;
    const recentWindowDays = Number(value.recentWindowDays ?? DEFAULT_JOURNAL_POLICY.recentWindowDays);
    const archiveAfterMonths = Number(value.archiveAfterMonths ?? DEFAULT_JOURNAL_POLICY.archiveAfterMonths);
    return {
      recentWindowDays: Number.isFinite(recentWindowDays) ? Math.min(3660, Math.max(1, Math.floor(recentWindowDays))) : DEFAULT_JOURNAL_POLICY.recentWindowDays,
      manualEntryAllowPnl: Boolean(value.manualEntryAllowPnl ?? DEFAULT_JOURNAL_POLICY.manualEntryAllowPnl),
      archiveAfterMonths: Number.isFinite(archiveAfterMonths) ? Math.min(120, Math.max(1, Math.floor(archiveAfterMonths))) : DEFAULT_JOURNAL_POLICY.archiveAfterMonths,
      archiveCronDryRun: Boolean(value.archiveCronDryRun ?? DEFAULT_JOURNAL_POLICY.archiveCronDryRun),
    };
  }, [journalPolicyData?.value]);
  const currentMonthlyReopenWindowDays = useMemo(() => {
    const raw = monthlyReopenWindowData?.value;
    const next = Number(typeof raw === "number" ? raw : typeof raw === "string" ? raw : DEFAULT_MONTHLY_REOPEN_WINDOW_DAYS);
    if (!Number.isFinite(next)) return DEFAULT_MONTHLY_REOPEN_WINDOW_DAYS;
    return Math.min(365, Math.max(0, Math.floor(next)));
  }, [monthlyReopenWindowData?.value]);
  const currentFiscalReopenWindowDays = useMemo(() => {
    const raw = fiscalReopenWindowData?.value;
    const next = Number(typeof raw === "number" ? raw : typeof raw === "string" ? raw : DEFAULT_FISCAL_REOPEN_WINDOW_DAYS);
    if (!Number.isFinite(next)) return DEFAULT_FISCAL_REOPEN_WINDOW_DAYS;
    return Math.min(365, Math.max(0, Math.floor(next)));
  }, [fiscalReopenWindowData?.value]);
  const currentEnforceFinalizedYearLock = useMemo(() => {
    const raw = enforceFinalizedYearLockData?.value;
    if (typeof raw === "boolean") return raw;
    const text = String(raw || "").trim().toLowerCase();
    return text === "true" || text === "1" || text === "yes" || text === "on";
  }, [enforceFinalizedYearLockData?.value]);
  const currentFinalizedFiscalYears = useMemo(() => {
    const raw = finalizedFiscalYearsData?.value;
    if (!Array.isArray(raw)) return [] as number[];
    return Array.from(
      new Set(raw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 2000 && n <= 2100)),
    ).sort((a, b) => a - b);
  }, [finalizedFiscalYearsData?.value]);

  useEffect(() => {
    setArDifference(String(currentThresholds.arDifference));
    setInventoryDifference(String(currentThresholds.inventoryDifference));
    setDraftEntries(currentThresholds.draftEntries);
    setNegativeStock(currentThresholds.negativeStock);
  }, [currentThresholds]);

  useEffect(() => {
    setUseLedger(currentLedgerMode);
  }, [currentLedgerMode]);

  useEffect(() => {
    setStoreCreditPolicy(currentStoreCreditPolicy);
  }, [currentStoreCreditPolicy]);

  useEffect(() => {
    setBankTxnEditWindowDays(String(currentBankTxnEditWindowDays));
  }, [currentBankTxnEditWindowDays]);
  useEffect(() => {
    setManualPeriodBasis(currentManualEntriesPolicy.periodBasis);
    setManualPeriodEndWindowDays(String(currentManualEntriesPolicy.periodEndWindowDays));
    setManualRequireExceptionOutsideWindow(currentManualEntriesPolicy.requireExceptionOutsideWindow);
    setManualMinExceptionNoteLength(String(currentManualEntriesPolicy.minExceptionNoteLength));
  }, [currentManualEntriesPolicy]);
  useEffect(() => {
    setReconcileCurrencyMinorPct(String(currentReconcileThresholds.currencyMinorPct));
    setReconcileCurrencyWarningPct(String(currentReconcileThresholds.currencyWarningPct));
    setReconcileMarginMinorAbsPct(String(currentReconcileThresholds.marginMinorAbsPct));
    setReconcileMarginWarningAbsPct(String(currentReconcileThresholds.marginWarningAbsPct));
  }, [currentReconcileThresholds]);
  useEffect(() => {
    setJournalRecentWindowDays(String(currentJournalPolicy.recentWindowDays));
    setJournalManualEntryAllowPnl(currentJournalPolicy.manualEntryAllowPnl);
    setJournalArchiveAfterMonths(String(currentJournalPolicy.archiveAfterMonths));
    setJournalArchiveCronDryRun(currentJournalPolicy.archiveCronDryRun);
  }, [currentJournalPolicy]);
  useEffect(() => {
    setMonthlyReopenWindowDays(String(currentMonthlyReopenWindowDays));
  }, [currentMonthlyReopenWindowDays]);
  useEffect(() => {
    setFiscalReopenWindowDays(String(currentFiscalReopenWindowDays));
  }, [currentFiscalReopenWindowDays]);
  useEffect(() => {
    setEnforceFinalizedYearLock(currentEnforceFinalizedYearLock);
  }, [currentEnforceFinalizedYearLock]);
  useEffect(() => {
    setFinalizedFiscalYears(currentFinalizedFiscalYears.join(", "));
  }, [currentFinalizedFiscalYears]);

  const arVal = Number(arDifference);
  const invVal = Number(inventoryDifference);
  const thresholdsValid = Number.isFinite(arVal) && arVal >= 0 && Number.isFinite(invVal) && invVal >= 0;
  const thresholdDirty =
    arDifference.trim() !== String(currentThresholds.arDifference) ||
    inventoryDifference.trim() !== String(currentThresholds.inventoryDifference) ||
    draftEntries !== currentThresholds.draftEntries ||
    negativeStock !== currentThresholds.negativeStock;

  const reportingDirty = useLedger !== currentLedgerMode;
  const storeCreditDirty = storeCreditPolicy !== currentStoreCreditPolicy;

  const bankEditWindowNumeric = Number(bankTxnEditWindowDays);
  const bankEditWindowValid =
    Number.isFinite(bankEditWindowNumeric) && bankEditWindowNumeric >= 0 && bankEditWindowNumeric <= 365;
  const bankEditDirty = bankTxnEditWindowDays.trim() !== String(currentBankTxnEditWindowDays);
  const manualWindowVal = Number(manualPeriodEndWindowDays);
  const manualMinNoteVal = Number(manualMinExceptionNoteLength);
  const manualPolicyValid =
    Number.isFinite(manualWindowVal) &&
    manualWindowVal >= 0 &&
    manualWindowVal <= 31 &&
    Number.isFinite(manualMinNoteVal) &&
    manualMinNoteVal >= 8 &&
    manualMinNoteVal <= 200;
  const manualPolicyDirty =
    manualPeriodBasis !== currentManualEntriesPolicy.periodBasis ||
    manualPeriodEndWindowDays.trim() !== String(currentManualEntriesPolicy.periodEndWindowDays) ||
    manualRequireExceptionOutsideWindow !== currentManualEntriesPolicy.requireExceptionOutsideWindow ||
    manualMinExceptionNoteLength.trim() !== String(currentManualEntriesPolicy.minExceptionNoteLength);
  const rcMinorVal = Number(reconcileCurrencyMinorPct);
  const rcWarnVal = Number(reconcileCurrencyWarningPct);
  const rmMinorVal = Number(reconcileMarginMinorAbsPct);
  const rmWarnVal = Number(reconcileMarginWarningAbsPct);
  const reconcileThresholdsValid =
    Number.isFinite(rcMinorVal) &&
    Number.isFinite(rcWarnVal) &&
    rcMinorVal >= 0 &&
    rcWarnVal >= rcMinorVal &&
    Number.isFinite(rmMinorVal) &&
    Number.isFinite(rmWarnVal) &&
    rmMinorVal >= 0 &&
    rmWarnVal >= rmMinorVal;
  const reconcileThresholdsDirty =
    reconcileCurrencyMinorPct.trim() !== String(currentReconcileThresholds.currencyMinorPct) ||
    reconcileCurrencyWarningPct.trim() !== String(currentReconcileThresholds.currencyWarningPct) ||
    reconcileMarginMinorAbsPct.trim() !== String(currentReconcileThresholds.marginMinorAbsPct) ||
    reconcileMarginWarningAbsPct.trim() !== String(currentReconcileThresholds.marginWarningAbsPct);
  const journalRecentWindowVal = Number(journalRecentWindowDays);
  const journalArchiveMonthsVal = Number(journalArchiveAfterMonths);
  const journalPolicyValid =
    Number.isFinite(journalRecentWindowVal) &&
    Number.isFinite(journalArchiveMonthsVal) &&
    Number.isInteger(journalRecentWindowVal) &&
    Number.isInteger(journalArchiveMonthsVal) &&
    journalRecentWindowVal >= 1 &&
    journalRecentWindowVal <= 3660 &&
    journalArchiveMonthsVal >= 1 &&
    journalArchiveMonthsVal <= 120;
  const journalPolicyDirty =
    journalRecentWindowDays.trim() !== String(currentJournalPolicy.recentWindowDays) ||
    journalManualEntryAllowPnl !== currentJournalPolicy.manualEntryAllowPnl ||
    journalArchiveAfterMonths.trim() !== String(currentJournalPolicy.archiveAfterMonths) ||
    journalArchiveCronDryRun !== currentJournalPolicy.archiveCronDryRun;
  const monthlyReopenWindowVal = Number(monthlyReopenWindowDays);
  const fiscalReopenWindowVal = Number(fiscalReopenWindowDays);
  const reopenPolicyValid =
    Number.isFinite(monthlyReopenWindowVal) &&
    Number.isFinite(fiscalReopenWindowVal) &&
    monthlyReopenWindowVal >= 0 &&
    monthlyReopenWindowVal <= 365 &&
    fiscalReopenWindowVal >= 0 &&
    fiscalReopenWindowVal <= 365;
  const parsedFinalizedFiscalYears = Array.from(
    new Set(
      finalizedFiscalYears
        .split(/[,\s]+/)
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isInteger(n) && n >= 2000 && n <= 2100),
    ),
  ).sort((a, b) => a - b);
  const reopenPolicyDirty =
    monthlyReopenWindowDays.trim() !== String(currentMonthlyReopenWindowDays) ||
    fiscalReopenWindowDays.trim() !== String(currentFiscalReopenWindowDays) ||
    enforceFinalizedYearLock !== currentEnforceFinalizedYearLock ||
    parsedFinalizedFiscalYears.join(",") !== currentFinalizedFiscalYears.join(",");
  const unsavedSections = [
    thresholdDirty ? "Integrity thresholds" : null,
    reportingDirty ? "Reporting source" : null,
    storeCreditDirty ? "Store credit policy" : null,
    bankEditDirty ? "Bank transaction edit policy" : null,
    manualPolicyDirty ? "Manual journal policy" : null,
    reconcileThresholdsDirty ? "Reconcile thresholds" : null,
    journalPolicyDirty ? "Journal runtime policy" : null,
    reopenPolicyDirty ? "Reopen policy" : null,
  ].filter(Boolean) as string[];
  const hasUnsavedChanges = unsavedSections.length > 0;
  const sectionLatestAudit = useMemo(() => {
    const rows = Array.isArray(settingsAuditData?.items) ? settingsAuditData.items : [];
    const map = new Map<string, SettingsAuditRow>();
    for (const row of rows) {
      const section = String(row?.meta?.section || "").trim();
      if (!section || map.has(section)) continue;
      map.set(section, row);
    }
    return map;
  }, [settingsAuditData?.items]);
  const formatRelativeTime = (iso: string) => {
    const deltaMs = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(deltaMs)) return "";
    const deltaMinutes = Math.round(deltaMs / 60000);
    if (deltaMinutes < 1) return "just now";
    if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
    const deltaHours = Math.round(deltaMinutes / 60);
    if (deltaHours < 24) return `${deltaHours}h ago`;
    const deltaDays = Math.round(deltaHours / 24);
    return `${deltaDays}d ago`;
  };
  const describeLastUpdated = (section: string) => {
    const row = sectionLatestAudit.get(section);
    if (!row) return "No recent audit entry.";
    const actor = row.actor?.name || row.actor?.email || "System";
    return `Last updated ${new Date(row.createdAt).toLocaleString()} (${formatRelativeTime(row.createdAt)}) by ${actor}.`;
  };
  const getSectionAuditLink = (section: string) =>
    `/admin/audit?scope=accounting_settings&sourcePage=admin/accounting/settings&settingSection=${encodeURIComponent(section)}`;
  const sectionLoadErrors = [
    thresholdsLoadError ? "Integrity thresholds" : null,
    reportingLoadError ? "Reporting source" : null,
    storeCreditLoadError ? "Store credit policy" : null,
    bankEditLoadError ? "Bank transaction edit policy" : null,
    manualPolicyLoadError ? "Manual journal policy" : null,
    reconcileLoadError ? "Reconcile thresholds" : null,
    journalPolicyLoadError ? "Journal runtime policy" : null,
    monthlyReopenLoadError || fiscalReopenLoadError || finalizedLockLoadError || finalizedYearsLoadError
      ? "Reopen policy"
      : null,
    settingsAuditLoadError ? "Settings audit feed" : null,
  ].filter(Boolean) as string[];
  const thresholdChangedFields = [
    arDifference.trim() !== String(currentThresholds.arDifference) ? "AR difference threshold" : null,
    inventoryDifference.trim() !== String(currentThresholds.inventoryDifference) ? "Inventory difference threshold" : null,
    draftEntries !== currentThresholds.draftEntries ? "Draft-entry alert toggle" : null,
    negativeStock !== currentThresholds.negativeStock ? "Negative-stock alert toggle" : null,
  ].filter(Boolean) as string[];
  const reportingChangedFields = [reportingDirty ? "Ledger reporting toggle" : null].filter(Boolean) as string[];
  const storeCreditChangedFields = [storeCreditDirty ? "Auto-apply strategy" : null].filter(Boolean) as string[];
  const bankEditChangedFields = [
    bankEditDirty ? "Edit window days" : null,
  ].filter(Boolean) as string[];
  const manualPolicyChangedFields = [
    manualPeriodBasis !== currentManualEntriesPolicy.periodBasis ? "Period basis" : null,
    manualPeriodEndWindowDays.trim() !== String(currentManualEntriesPolicy.periodEndWindowDays) ? "Period-end window days" : null,
    manualRequireExceptionOutsideWindow !== currentManualEntriesPolicy.requireExceptionOutsideWindow ? "Exception note required toggle" : null,
    manualMinExceptionNoteLength.trim() !== String(currentManualEntriesPolicy.minExceptionNoteLength) ? "Minimum exception note length" : null,
  ].filter(Boolean) as string[];
  const reconcileChangedFields = [
    reconcileCurrencyMinorPct.trim() !== String(currentReconcileThresholds.currencyMinorPct) ? "Currency minor threshold" : null,
    reconcileCurrencyWarningPct.trim() !== String(currentReconcileThresholds.currencyWarningPct) ? "Currency warning threshold" : null,
    reconcileMarginMinorAbsPct.trim() !== String(currentReconcileThresholds.marginMinorAbsPct) ? "Margin minor threshold" : null,
    reconcileMarginWarningAbsPct.trim() !== String(currentReconcileThresholds.marginWarningAbsPct) ? "Margin warning threshold" : null,
  ].filter(Boolean) as string[];
  const journalPolicyChangedFields = [
    journalRecentWindowDays.trim() !== String(currentJournalPolicy.recentWindowDays) ? "Recent window days" : null,
    journalManualEntryAllowPnl !== currentJournalPolicy.manualEntryAllowPnl ? "Manual P&L posting toggle" : null,
    journalArchiveAfterMonths.trim() !== String(currentJournalPolicy.archiveAfterMonths) ? "Archive cutoff months" : null,
    journalArchiveCronDryRun !== currentJournalPolicy.archiveCronDryRun ? "Scheduled dry-run toggle" : null,
  ].filter(Boolean) as string[];
  const reopenChangedFields = [
    monthlyReopenWindowDays.trim() !== String(currentMonthlyReopenWindowDays) ? "Monthly reopen window" : null,
    fiscalReopenWindowDays.trim() !== String(currentFiscalReopenWindowDays) ? "Fiscal reopen window" : null,
    enforceFinalizedYearLock !== currentEnforceFinalizedYearLock ? "Finalized-year lock toggle" : null,
    parsedFinalizedFiscalYears.join(",") !== currentFinalizedFiscalYears.join(",") ? "Finalized fiscal years list" : null,
  ].filter(Boolean) as string[];
  const storeCreditPolicyExplanation =
    storeCreditPolicy === "oldest_first"
      ? "Checkout uses oldest open customer balances first."
      : storeCreditPolicy === "current_order_first"
        ? "Checkout applies credit to current order first, then oldest balances."
        : "No automatic checkout application; credit must be applied manually.";
  const canSaveAll =
    (!thresholdDirty || thresholdsValid) &&
    (!bankEditDirty || bankEditWindowValid) &&
    (!manualPolicyDirty || manualPolicyValid) &&
    (!reconcileThresholdsDirty || reconcileThresholdsValid) &&
    (!journalPolicyDirty || journalPolicyValid) &&
    (!reopenPolicyDirty || reopenPolicyValid) &&
    (!reportingDirty || isAdmin) &&
    (!bankEditDirty || isAdmin) &&
    (!manualPolicyDirty || isAdmin) &&
    (!reconcileThresholdsDirty || isAdmin) &&
    (!journalPolicyDirty || isAdmin) &&
    (!reopenPolicyDirty || isAdmin);

  const retryFailedLoads = async () => {
    const tasks: Array<Promise<unknown>> = [];
    if (thresholdsLoadError) tasks.push(refetch());
    if (reportingLoadError) tasks.push(refetchLedgerMode());
    if (storeCreditLoadError) tasks.push(refetchStoreCreditPolicy());
    if (bankEditLoadError) tasks.push(refetchBankTxnEditWindow());
    if (manualPolicyLoadError) tasks.push(refetchManualEntriesPolicy());
    if (reconcileLoadError) tasks.push(refetchReconcileThresholds());
    if (journalPolicyLoadError) tasks.push(refetchJournalPolicy());
    if (monthlyReopenLoadError) tasks.push(refetchMonthlyReopenWindow());
    if (fiscalReopenLoadError) tasks.push(refetchFiscalReopenWindow());
    if (finalizedLockLoadError) tasks.push(refetchEnforceFinalizedYearLock());
    if (finalizedYearsLoadError) tasks.push(refetchFinalizedFiscalYears());
    if (settingsAuditLoadError) tasks.push(refetchSettingsAudit());
    if (!tasks.length) return;
    await Promise.allSettled(tasks);
  };

  const saveAllChangedSections = async () => {
    setSaveAllSummary([]);
    if (!hasUnsavedChanges) return;
    if (!canSaveAll) {
      toast.error("Fix validation or permission issues before saving all sections.");
      return;
    }
    const results: Array<{ section: string; status: "saved" | "failed" | "skipped"; message: string }> = [];
    const pushResult = (section: string, ok: boolean | null, message: string) => {
      if (ok === null) results.push({ section, status: "skipped", message });
      else results.push({ section, status: ok ? "saved" : "failed", message });
    };
    pushResult("Integrity thresholds", thresholdDirty ? await saveSettings({ notify: false }) : null, thresholdDirty ? "Saved changes." : "No changes.");
    pushResult("Reporting source", reportingDirty ? await saveLedgerMode({ notify: false }) : null, reportingDirty ? "Saved changes." : "No changes.");
    pushResult("Store credit policy", storeCreditDirty ? await saveStoreCreditPolicy({ notify: false }) : null, storeCreditDirty ? "Saved changes." : "No changes.");
    pushResult("Bank transaction edit policy", bankEditDirty ? await saveBankTxnEditWindow({ notify: false }) : null, bankEditDirty ? "Saved changes." : "No changes.");
    pushResult("Manual journal policy", manualPolicyDirty ? await saveManualEntriesPolicy({ notify: false }) : null, manualPolicyDirty ? "Saved changes." : "No changes.");
    pushResult("Reconcile thresholds", reconcileThresholdsDirty ? await saveReconcileThresholds({ notify: false }) : null, reconcileThresholdsDirty ? "Saved changes." : "No changes.");
    pushResult("Journal runtime policy", journalPolicyDirty ? await saveJournalPolicy({ notify: false }) : null, journalPolicyDirty ? "Saved changes." : "No changes.");
    pushResult("Reopen policy", reopenPolicyDirty ? await saveReopenPolicy({ notify: false }) : null, reopenPolicyDirty ? "Saved changes." : "No changes.");
    setSaveAllSummary(results);
    const failedCount = results.filter((row) => row.status === "failed").length;
    const savedCount = results.filter((row) => row.status === "saved").length;
    if (failedCount > 0) {
      toast.error(`Save all finished with ${failedCount} failed section(s).`);
    } else {
      toast.success(`Saved ${savedCount} section(s).`);
    }
  };

  const saveSettings = async (opts?: { notify?: boolean }) => {
    const notify = opts?.notify ?? true;
    if (notify) setSaveAllSummary([]);
    if (!thresholdsValid) {
      if (notify) toast.error("Enter valid integrity threshold values.");
      return false;
    }
    try {
      setSaving(true);
      await saveAppSetting(
        {
          key: "accounting.integrity.thresholds",
          value: {
            arDifference: arVal,
            inventoryDifference: invVal,
            draftEntries,
            negativeStock,
          },
          expectedUpdatedAt: data?.updatedAt ?? null,
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "integrity-thresholds",
            operation: "save",
          },
        },
        "Failed to save settings.",
      );
      if (notify) toast.success("Integrity thresholds updated.");
      refetch();
      refetchSettingsAudit();
      return true;
    } catch (e: unknown) {
      if (notify) toast.error(e instanceof Error ? e.message : "Failed to save settings.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveLedgerMode = async (opts?: { notify?: boolean }) => {
    const notify = opts?.notify ?? true;
    if (notify) setSaveAllSummary([]);
    if (!isAdmin) {
      if (notify) toast.error("Only ADMIN can change reporting source.");
      return false;
    }
    try {
      setSavingLedger(true);
      await saveAppSetting(
        {
          key: "accounting.reporting.useLedger",
          value: useLedger,
          expectedUpdatedAt: ledgerModeData?.updatedAt ?? null,
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "reporting-source",
            operation: "save",
          },
        },
        "Failed to save reporting mode.",
      );
      if (notify) toast.success("Reporting source updated.");
      refetchLedgerMode();
      refetchSettingsAudit();
      return true;
    } catch (e: unknown) {
      if (notify) toast.error(e instanceof Error ? e.message : "Failed to save reporting mode.");
      return false;
    } finally {
      setSavingLedger(false);
    }
  };

  const saveStoreCreditPolicy = async (opts?: { notify?: boolean }) => {
    const notify = opts?.notify ?? true;
    if (notify) setSaveAllSummary([]);
    try {
      setSavingPolicy(true);
      await saveAppSetting(
        {
          key: "accounting.storeCredit.applyPolicy",
          value: storeCreditPolicy,
          expectedUpdatedAt: storeCreditPolicyData?.updatedAt ?? null,
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "store-credit-policy",
            operation: "save",
          },
        },
        "Failed to save store-credit policy.",
      );
      if (notify) toast.success("Store-credit policy updated.");
      refetchStoreCreditPolicy();
      refetchSettingsAudit();
      return true;
    } catch (e: unknown) {
      if (notify) toast.error(e instanceof Error ? e.message : "Failed to save store-credit policy.");
      return false;
    } finally {
      setSavingPolicy(false);
    }
  };

  const saveBankTxnEditWindow = async (opts?: { notify?: boolean }) => {
    const notify = opts?.notify ?? true;
    if (notify) setSaveAllSummary([]);
    if (!isAdmin) {
      if (notify) toast.error("Only ADMIN can change transaction edit policy.");
      return false;
    }
    if (!bankEditWindowValid) {
      if (notify) toast.error("Enter a valid edit window in days (0 to 365).");
      return false;
    }
    try {
      setSavingBankTxnEditWindow(true);
      await saveAppSetting(
        {
          key: "accounting.bankTransactions.editWindowDays",
          value: Math.floor(bankEditWindowNumeric),
          expectedUpdatedAt: bankTxnEditWindowData?.updatedAt ?? null,
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "bank-transaction-edit-policy",
            operation: "save",
          },
        },
        "Failed to save transaction edit window.",
      );
      if (notify) toast.success("Bank transaction edit window updated.");
      refetchBankTxnEditWindow();
      refetchSettingsAudit();
      return true;
    } catch (e: unknown) {
      if (notify) toast.error(e instanceof Error ? e.message : "Failed to save transaction edit window.");
      return false;
    } finally {
      setSavingBankTxnEditWindow(false);
    }
  };
  const saveManualEntriesPolicy = async (opts?: { notify?: boolean }) => {
    const notify = opts?.notify ?? true;
    if (notify) setSaveAllSummary([]);
    if (!isAdmin) {
      if (notify) toast.error("Only ADMIN can change manual entry policy.");
      return false;
    }
    if (!manualPolicyValid) {
      if (notify) toast.error("Enter valid manual-entry policy values.");
      return false;
    }
    try {
      setSavingManualPolicy(true);
      await saveAppSetting(
        {
          key: "accounting.manualEntries.policy",
          value: {
            periodBasis: manualPeriodBasis,
            periodEndWindowDays: Math.floor(manualWindowVal),
            requireExceptionOutsideWindow: manualRequireExceptionOutsideWindow,
            minExceptionNoteLength: Math.floor(manualMinNoteVal),
          },
          expectedUpdatedAt: manualEntriesPolicyData?.updatedAt ?? null,
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "manual-entry-policy",
            operation: "save",
          },
        },
        "Failed to save manual entry policy.",
      );
      if (notify) toast.success("Manual entry policy updated.");
      refetchManualEntriesPolicy();
      refetchSettingsAudit();
      return true;
    } catch (e: unknown) {
      if (notify) toast.error(e instanceof Error ? e.message : "Failed to save manual entry policy.");
      return false;
    } finally {
      setSavingManualPolicy(false);
    }
  };
  const saveReconcileThresholds = async (opts?: { notify?: boolean }) => {
    const notify = opts?.notify ?? true;
    if (notify) setSaveAllSummary([]);
    if (!isAdmin) {
      if (notify) toast.error("Only ADMIN can change reconcile thresholds.");
      return false;
    }
    if (!reconcileThresholdsValid) {
      if (notify) toast.error("Enter valid reconcile threshold values.");
      return false;
    }
    try {
      setSavingReconcileThresholds(true);
      await saveAppSetting(
        {
          key: "accounting.reconcile.thresholds",
          value: {
            currencyMinorPct: rcMinorVal,
            currencyWarningPct: rcWarnVal,
            marginMinorAbsPct: rmMinorVal,
            marginWarningAbsPct: rmWarnVal,
          },
          expectedUpdatedAt: reconcileThresholdsData?.updatedAt ?? null,
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "reconcile-thresholds",
            operation: "save",
          },
        },
        "Failed to save reconcile thresholds.",
      );
      if (notify) toast.success("Reconcile thresholds updated.");
      refetchReconcileThresholds();
      refetchSettingsAudit();
      return true;
    } catch (e: unknown) {
      if (notify) toast.error(e instanceof Error ? e.message : "Failed to save reconcile thresholds.");
      return false;
    } finally {
      setSavingReconcileThresholds(false);
    }
  };
  const saveJournalPolicy = async (opts?: { notify?: boolean }) => {
    const notify = opts?.notify ?? true;
    if (notify) setSaveAllSummary([]);
    if (!isAdmin) {
      if (notify) toast.error("Only ADMIN can change journal runtime policy.");
      return false;
    }
    if (!journalPolicyValid) {
      if (notify) toast.error("Enter valid journal policy values.");
      return false;
    }
    try {
      setSavingJournalPolicy(true);
      await saveAppSetting(
        {
          key: "accounting.journal.policy",
          value: {
            recentWindowDays: Math.floor(journalRecentWindowVal),
            manualEntryAllowPnl: journalManualEntryAllowPnl,
            archiveAfterMonths: Math.floor(journalArchiveMonthsVal),
            archiveCronDryRun: journalArchiveCronDryRun,
          },
          expectedUpdatedAt: journalPolicyData?.updatedAt ?? null,
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "journal-policy",
            operation: "save",
          },
        },
        "Failed to save journal policy.",
      );
      if (notify) toast.success("Journal runtime policy updated.");
      refetchJournalPolicy();
      refetchSettingsAudit();
      return true;
    } catch (e: unknown) {
      if (notify) toast.error(e instanceof Error ? e.message : "Failed to save journal policy.");
      return false;
    } finally {
      setSavingJournalPolicy(false);
    }
  };
  const saveReopenPolicy = async (opts?: { notify?: boolean }) => {
    const notify = opts?.notify ?? true;
    if (notify) setSaveAllSummary([]);
    if (!isAdmin) {
      if (notify) toast.error("Only ADMIN can change reopen policy.");
      return false;
    }
    if (!reopenPolicyValid) {
      if (notify) toast.error("Enter valid reopen policy values.");
      return false;
    }
    try {
      setSavingReopenPolicy(true);
      await saveAppSetting(
        {
          updates: [
            {
              key: "accounting.reopen.monthlyWindowDays",
              value: Math.floor(monthlyReopenWindowVal),
              expectedUpdatedAt: monthlyReopenWindowData?.updatedAt ?? null,
            },
            {
              key: "accounting.reopen.fiscalWindowDays",
              value: Math.floor(fiscalReopenWindowVal),
              expectedUpdatedAt: fiscalReopenWindowData?.updatedAt ?? null,
            },
            {
              key: "accounting.reopen.enforceFinalizedYearLock",
              value: enforceFinalizedYearLock,
              expectedUpdatedAt: enforceFinalizedYearLockData?.updatedAt ?? null,
            },
            {
              key: "accounting.reopen.finalizedFiscalYears",
              value: parsedFinalizedFiscalYears,
              expectedUpdatedAt: finalizedFiscalYearsData?.updatedAt ?? null,
            },
          ],
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "reopen-policy",
            operation: "save",
          },
        },
        "Failed to save reopen policy.",
      );
      if (notify) toast.success("Reopen policy updated.");
      refetchMonthlyReopenWindow();
      refetchFiscalReopenWindow();
      refetchEnforceFinalizedYearLock();
      refetchFinalizedFiscalYears();
      refetchSettingsAudit();
      return true;
    } catch (e: unknown) {
      if (notify) toast.error(e instanceof Error ? e.message : "Failed to save reopen policy.");
      return false;
    } finally {
      setSavingReopenPolicy(false);
    }
  };

  const runReset = async (scope: "thresholds" | "reporting" | "storeCredit" | "bankEdit" | "manualPolicy" | "reconcileThresholds" | "journalPolicy" | "reopenPolicy") => {
    try {
      setSaveAllSummary([]);
      if (scope === "thresholds") {
        setSaving(true);
        await saveAppSetting(
          {
            key: "accounting.integrity.thresholds",
            value: DEFAULT_THRESHOLDS,
            expectedUpdatedAt: data?.updatedAt ?? null,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "integrity-thresholds",
              operation: "reset",
            },
          },
          "Failed to reset integrity thresholds.",
        );
        toast.success("Integrity thresholds reset to defaults.");
        refetch();
        refetchSettingsAudit();
      } else if (scope === "reporting") {
        if (!isAdmin) throw new Error("Only ADMIN can reset reporting source.");
        setSavingLedger(true);
        await saveAppSetting(
          {
            key: "accounting.reporting.useLedger",
            value: DEFAULT_REPORTING_USE_LEDGER,
            expectedUpdatedAt: ledgerModeData?.updatedAt ?? null,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "reporting-source",
              operation: "reset",
            },
          },
          "Failed to reset reporting source.",
        );
        toast.success("Reporting source reset to default.");
        refetchLedgerMode();
        refetchSettingsAudit();
      } else if (scope === "storeCredit") {
        setSavingPolicy(true);
        await saveAppSetting(
          {
            key: "accounting.storeCredit.applyPolicy",
            value: DEFAULT_STORE_CREDIT_POLICY,
            expectedUpdatedAt: storeCreditPolicyData?.updatedAt ?? null,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "store-credit-policy",
              operation: "reset",
            },
          },
          "Failed to reset store-credit policy.",
        );
        toast.success("Store-credit policy reset to default.");
        refetchStoreCreditPolicy();
        refetchSettingsAudit();
      } else if (scope === "bankEdit") {
        if (!isAdmin) throw new Error("Only ADMIN can reset transaction edit policy.");
        setSavingBankTxnEditWindow(true);
        await saveAppSetting(
          {
            key: "accounting.bankTransactions.editWindowDays",
            value: DEFAULT_BANK_TXN_EDIT_WINDOW_DAYS,
            expectedUpdatedAt: bankTxnEditWindowData?.updatedAt ?? null,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "bank-transaction-edit-policy",
              operation: "reset",
            },
          },
          "Failed to reset transaction edit policy.",
        );
        toast.success("Transaction edit policy reset to default.");
        refetchBankTxnEditWindow();
        refetchSettingsAudit();
      } else if (scope === "manualPolicy") {
        if (!isAdmin) throw new Error("Only ADMIN can reset manual entry policy.");
        setSavingManualPolicy(true);
        await saveAppSetting(
          {
            key: "accounting.manualEntries.policy",
            value: DEFAULT_MANUAL_ENTRIES_POLICY,
            expectedUpdatedAt: manualEntriesPolicyData?.updatedAt ?? null,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "manual-entry-policy",
              operation: "reset",
            },
          },
          "Failed to reset manual entry policy.",
        );
        toast.success("Manual entry policy reset to default.");
        refetchManualEntriesPolicy();
        refetchSettingsAudit();
      } else if (scope === "reconcileThresholds") {
        if (!isAdmin) throw new Error("Only ADMIN can reset reconcile thresholds.");
        setSavingReconcileThresholds(true);
        await saveAppSetting(
          {
            key: "accounting.reconcile.thresholds",
            value: DEFAULT_RECONCILE_THRESHOLDS,
            expectedUpdatedAt: reconcileThresholdsData?.updatedAt ?? null,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "reconcile-thresholds",
              operation: "reset",
            },
          },
          "Failed to reset reconcile thresholds.",
        );
        toast.success("Reconcile thresholds reset to default.");
        refetchReconcileThresholds();
        refetchSettingsAudit();
      } else if (scope === "journalPolicy") {
        if (!isAdmin) throw new Error("Only ADMIN can reset journal policy.");
        setSavingJournalPolicy(true);
        await saveAppSetting(
          {
            key: "accounting.journal.policy",
            value: DEFAULT_JOURNAL_POLICY,
            expectedUpdatedAt: journalPolicyData?.updatedAt ?? null,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "journal-policy",
              operation: "reset",
            },
          },
          "Failed to reset journal policy.",
        );
        toast.success("Journal runtime policy reset to defaults.");
        refetchJournalPolicy();
        refetchSettingsAudit();
      } else if (scope === "reopenPolicy") {
        if (!isAdmin) throw new Error("Only ADMIN can reset reopen policy.");
        setSavingReopenPolicy(true);
        await saveAppSetting(
          {
            updates: [
              {
                key: "accounting.reopen.monthlyWindowDays",
                value: DEFAULT_MONTHLY_REOPEN_WINDOW_DAYS,
                expectedUpdatedAt: monthlyReopenWindowData?.updatedAt ?? null,
              },
              {
                key: "accounting.reopen.fiscalWindowDays",
                value: DEFAULT_FISCAL_REOPEN_WINDOW_DAYS,
                expectedUpdatedAt: fiscalReopenWindowData?.updatedAt ?? null,
              },
              {
                key: "accounting.reopen.enforceFinalizedYearLock",
                value: DEFAULT_ENFORCE_FINALIZED_YEAR_LOCK,
                expectedUpdatedAt: enforceFinalizedYearLockData?.updatedAt ?? null,
              },
              {
                key: "accounting.reopen.finalizedFiscalYears",
                value: [] as number[],
                expectedUpdatedAt: finalizedFiscalYearsData?.updatedAt ?? null,
              },
            ],
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "reopen-policy",
              operation: "reset",
            },
          },
          "Failed to reset reopen policy.",
        );
        toast.success("Reopen policy reset to defaults.");
        refetchMonthlyReopenWindow();
        refetchFiscalReopenWindow();
        refetchEnforceFinalizedYearLock();
        refetchFinalizedFiscalYears();
        refetchSettingsAudit();
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to reset.");
    } finally {
      setSaving(false);
      setSavingLedger(false);
      setSavingPolicy(false);
      setSavingBankTxnEditWindow(false);
      setSavingManualPolicy(false);
      setSavingReconcileThresholds(false);
      setSavingJournalPolicy(false);
      setSavingReopenPolicy(false);
      setResetDialog(null);
    }
  };

  useEffect(() => {
    const warning = "You have unsaved accounting settings changes. Leave this page and discard them?";
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = warning;
    };
    const onDocumentClick = (event: MouseEvent) => {
      if (!hasUnsavedChanges) return;
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("data-bypass-unsaved-guard")) return;
      const href = anchor.getAttribute("href") || "";
      if (!href || href.startsWith("#")) return;
      const nextUrl = new URL(anchor.href, window.location.href);
      if (nextUrl.origin !== window.location.origin) return;
      const keepEditing = !window.confirm(warning);
      if (!keepEditing) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onDocumentClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onDocumentClick, true);
    };
  }, [hasUnsavedChanges]);

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Accounting Settings</h1>
          <p className="text-sm text-muted-foreground">Configure accounting policy and integrity behavior.</p>
          <p className="text-xs text-muted-foreground mt-1">
            {hasUnsavedChanges
              ? `${unsavedSections.length} section(s) have unsaved changes.`
              : "All settings are saved."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={saveAllChangedSections} disabled={!hasUnsavedChanges || !canSaveAll}>
            Save all changed sections
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/audit?scope=accounting_settings&sourcePage=admin/accounting/settings">Open settings audit trail</Link>
          </Button>
        </div>
      </div>

      {sectionLoadErrors.length > 0 ? (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="pt-6 text-sm">
            <p className="font-medium text-amber-900">
              Some settings failed to load: {sectionLoadErrors.join(", ")}.
            </p>
            <p className="text-amber-800 mt-1">Values shown may be stale defaults until these sections load.</p>
            <Button className="mt-3" size="sm" variant="outline" onClick={retryFailedLoads}>
              Retry failed loads
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {saveAllSummary.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Save all result summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {saveAllSummary.map((row) => (
              <p key={row.section} className={row.status === "failed" ? "text-red-600" : row.status === "saved" ? "text-green-700" : "text-muted-foreground"}>
                {row.section}: {row.status}. {row.message}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground mr-1">Jump to:</span>
            <a className="underline" href="#integrity-thresholds">Integrity thresholds</a>
            <a className="underline" href="#reporting-source">Reporting source</a>
            <a className="underline" href="#store-credit-policy">Store credit policy</a>
            <a className="underline" href="#bank-edit-policy">Bank edit policy</a>
            <a className="underline" href="#manual-policy">Manual journal policy</a>
            <a className="underline" href="#reconcile-thresholds">Reconcile thresholds</a>
            <a className="underline" href="#journal-policy">Journal runtime policy</a>
            <a className="underline" href="#reopen-policy">Reopen policy</a>
          </div>
        </CardContent>
      </Card>

      <Card id="integrity-thresholds">
        <CardHeader>
          <CardTitle>Integrity thresholds</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-2">
          <p className="sm:col-span-2 text-xs text-muted-foreground">
            Controls when integrity checks show warning status for AR/inventory differences and stock/draft conditions.
          </p>
          <p className="sm:col-span-2 text-[11px] text-muted-foreground">
            {describeLastUpdated("integrity-thresholds")}{" "}
            <Link className="underline" href={getSectionAuditLink("integrity-thresholds")}>Open section audit</Link>
          </p>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">AR difference threshold (GHS)</span>
            <Input
              placeholder="Example: 0.01"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={arDifference}
              onChange={(e) => setArDifference(e.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Inventory difference threshold (GHS)</span>
            <Input
              placeholder="Example: 0.01"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={inventoryDifference}
              onChange={(e) => setInventoryDifference(e.target.value)}
            />
          </label>
          {!thresholdsValid ? (
            <p className="sm:col-span-2 text-xs text-red-600">Threshold values must be numeric and &gt;= 0.</p>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draftEntries} onChange={(e) => setDraftEntries(e.target.checked)} />
            Alert on draft journal entries
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={negativeStock} onChange={(e) => setNegativeStock(e.target.checked)} />
            Alert on negative stock
          </label>
          <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
            <Button className="w-full sm:w-auto" onClick={() => void saveSettings()} disabled={saving || !thresholdDirty || !thresholdsValid}>
              {saving ? "Saving..." : "Save integrity thresholds"}
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => setResetDialog("thresholds")}
              disabled={saving}
            >
              Reset defaults
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => {
                setArDifference(String(currentThresholds.arDifference));
                setInventoryDifference(String(currentThresholds.inventoryDifference));
                setDraftEntries(currentThresholds.draftEntries);
                setNegativeStock(currentThresholds.negativeStock);
              }}
              disabled={saving || !thresholdDirty}
            >
              Discard changes
            </Button>
            <span className="text-xs text-muted-foreground">{thresholdDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
          {thresholdChangedFields.length > 0 ? (
            <p className="sm:col-span-2 text-[11px] text-amber-700">Pending changes: {thresholdChangedFields.join(", ")}.</p>
          ) : null}
          <p className="sm:col-span-2 text-[11px] text-muted-foreground">
            Effective now: warning when AR difference &gt; {arDifference || "0"} GHS, inventory difference &gt;{" "}
            {inventoryDifference || "0"} GHS, draft entries {draftEntries ? "included" : "ignored"}, negative stock{" "}
            {negativeStock ? "included" : "ignored"}.
          </p>
        </CardContent>
      </Card>

      <Card id="reporting-source">
        <CardHeader>
          <CardTitle>Reporting source</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Sets whether dashboard/main P&L uses posted journal entries or operational totals.
          </p>
          <p className="text-[11px] text-muted-foreground">
            {describeLastUpdated("reporting-source")}{" "}
            <Link className="underline" href={getSectionAuditLink("reporting-source")}>Open section audit</Link>
          </p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={useLedger} onChange={(e) => setUseLedger(e.target.checked)} disabled={!isAdmin} />
            Use accounting ledger for dashboard and main P&amp;L
          </label>
          {!isAdmin ? <p className="text-xs text-amber-700">Only ADMIN can change this setting.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button className="w-full sm:w-auto" onClick={() => void saveLedgerMode()} disabled={savingLedger || !reportingDirty || !isAdmin}>
              {savingLedger ? "Saving..." : "Save reporting source"}
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => setResetDialog("reporting")}
              disabled={savingLedger || !isAdmin}
            >
              Reset default
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => setUseLedger(currentLedgerMode)}
              disabled={savingLedger || !reportingDirty}
            >
              Discard changes
            </Button>
            <span className="text-xs text-muted-foreground">{reportingDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
          {reportingChangedFields.length > 0 ? (
            <p className="text-[11px] text-amber-700">Pending changes: {reportingChangedFields.join(", ")}.</p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            Effective now: dashboard and main P&amp;L are using {useLedger ? "posted ledger" : "operational totals"}.
          </p>
        </CardContent>
      </Card>

      <Card id="store-credit-policy">
        <CardHeader>
          <CardTitle>Store credit auto-apply policy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Controls checkout consumption order for customer store credit.
          </p>
          <p className="text-[11px] text-muted-foreground">
            {describeLastUpdated("store-credit-policy")}{" "}
            <Link className="underline" href={getSectionAuditLink("store-credit-policy")}>Open section audit</Link>
          </p>
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm w-full sm:w-auto min-w-[320px]"
            value={storeCreditPolicy}
            onChange={(e) => setStoreCreditPolicy(e.target.value as StoreCreditApplyPolicy)}
          >
            <option value="oldest_first">Oldest open balances first (recommended)</option>
            <option value="current_order_first">Current order first, then oldest balances</option>
            <option value="manual_apply_only">Manual apply only (no checkout auto-apply)</option>
          </select>
          <div className="flex flex-wrap items-center gap-2">
            <Button className="w-full sm:w-auto" onClick={() => void saveStoreCreditPolicy()} disabled={savingPolicy || !storeCreditDirty}>
              {savingPolicy ? "Saving..." : "Save store-credit policy"}
            </Button>
            <Button className="w-full sm:w-auto" variant="ghost" onClick={() => setResetDialog("storeCredit")} disabled={savingPolicy}>
              Reset default
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => setStoreCreditPolicy(currentStoreCreditPolicy)}
              disabled={savingPolicy || !storeCreditDirty}
            >
              Discard changes
            </Button>
            <span className="text-xs text-muted-foreground">{storeCreditDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
          {storeCreditChangedFields.length > 0 ? (
            <p className="text-[11px] text-amber-700">Pending changes: {storeCreditChangedFields.join(", ")}.</p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">Effective now: {storeCreditPolicyExplanation}</p>
        </CardContent>
      </Card>

      <Card id="bank-edit-policy">
        <CardHeader>
          <CardTitle>Bank transaction edit policy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Transactions older than this window require ADMIN override reason. Closed-period transactions stay locked.
          </p>
          <p className="text-[11px] text-muted-foreground">
            {describeLastUpdated("bank-transaction-edit-policy")}{" "}
            <Link className="underline" href={getSectionAuditLink("bank-transaction-edit-policy")}>Open section audit</Link>
          </p>
          <Input
            placeholder="Edit window (days)"
            inputMode="numeric"
            min={0}
            max={365}
            step={1}
            value={bankTxnEditWindowDays}
            onChange={(e) => setBankTxnEditWindowDays(e.target.value)}
            disabled={!isAdmin}
          />
          {!bankEditWindowValid ? (
            <p className="text-xs text-red-600">Edit window must be a whole number between 0 and 365.</p>
          ) : null}
          {!isAdmin ? <p className="text-xs text-amber-700">Only ADMIN can change this policy.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="w-full sm:w-auto"
              onClick={() => void saveBankTxnEditWindow()}
              disabled={savingBankTxnEditWindow || !bankEditDirty || !bankEditWindowValid || !isAdmin}
            >
              {savingBankTxnEditWindow ? "Saving..." : "Save edit policy"}
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => setResetDialog("bankEdit")}
              disabled={savingBankTxnEditWindow || !isAdmin}
            >
              Reset default
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => setBankTxnEditWindowDays(String(currentBankTxnEditWindowDays))}
              disabled={savingBankTxnEditWindow || !bankEditDirty}
            >
              Discard changes
            </Button>
            <span className="text-xs text-muted-foreground">{bankEditDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
          {bankEditChangedFields.length > 0 ? (
            <p className="text-[11px] text-amber-700">Pending changes: {bankEditChangedFields.join(", ")}.</p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            Effective now: transactions older than {bankTxnEditWindowDays || "0"} day(s) require admin override reason;
            closed-period rows remain locked.
          </p>
        </CardContent>
      </Card>

      <Card id="manual-policy">
        <CardHeader>
          <CardTitle>Manual journal policy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Restricts manual entries to period-end workflows, with required exception note outside configured window.
          </p>
          <p className="text-[11px] text-muted-foreground">
            {describeLastUpdated("manual-entry-policy")}{" "}
            <Link className="underline" href={getSectionAuditLink("manual-entry-policy")}>Open section audit</Link>
          </p>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Period basis</span>
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm w-full sm:w-auto min-w-[320px]"
              value={manualPeriodBasis}
              onChange={(e) => setManualPeriodBasis(e.target.value as "MONTHLY_CALENDAR" | "FISCAL_PERIOD_END")}
              disabled={!isAdmin}
            >
              <option value="MONTHLY_CALENDAR">Monthly close (recommended)</option>
              <option value="FISCAL_PERIOD_END">Fiscal period end</option>
            </select>
            <span className="text-[11px] text-muted-foreground">
              Monthly close uses each calendar month end; fiscal period uses configured accounting periods.
            </span>
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Period-end window (days)</span>
            <Input
              placeholder="Example: 5"
              inputMode="numeric"
              min={0}
              max={31}
              step={1}
              value={manualPeriodEndWindowDays}
              onChange={(e) => setManualPeriodEndWindowDays(e.target.value)}
              disabled={!isAdmin}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Minimum exception note length</span>
            <Input
              placeholder="Example: 12"
              inputMode="numeric"
              min={8}
              max={200}
              step={1}
              value={manualMinExceptionNoteLength}
              onChange={(e) => setManualMinExceptionNoteLength(e.target.value)}
              disabled={!isAdmin}
            />
          </label>
          <label className="flex items-center gap-2 rounded-md border px-3 py-2">
            <input
              type="checkbox"
              checked={manualRequireExceptionOutsideWindow}
              onChange={(e) => setManualRequireExceptionOutsideWindow(e.target.checked)}
              disabled={!isAdmin}
            />
            <span>Require exception note outside period-end window</span>
          </label>
          {!manualPolicyValid ? <p className="text-xs text-red-600">Enter valid policy values (days 0-31, note length 8-200).</p> : null}
          {!isAdmin ? <p className="text-xs text-amber-700">Only ADMIN can change this policy.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button className="w-full sm:w-auto" onClick={() => void saveManualEntriesPolicy()} disabled={savingManualPolicy || !manualPolicyDirty || !manualPolicyValid || !isAdmin}>
              {savingManualPolicy ? "Saving..." : "Save manual policy"}
            </Button>
            <Button className="w-full sm:w-auto" variant="ghost" onClick={() => setResetDialog("manualPolicy")} disabled={savingManualPolicy || !isAdmin}>
              Reset default
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => {
                setManualPeriodBasis(currentManualEntriesPolicy.periodBasis);
                setManualPeriodEndWindowDays(String(currentManualEntriesPolicy.periodEndWindowDays));
                setManualRequireExceptionOutsideWindow(currentManualEntriesPolicy.requireExceptionOutsideWindow);
                setManualMinExceptionNoteLength(String(currentManualEntriesPolicy.minExceptionNoteLength));
              }}
              disabled={savingManualPolicy || !manualPolicyDirty}
            >
              Discard changes
            </Button>
            <span className="text-xs text-muted-foreground">{manualPolicyDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
          {manualPolicyChangedFields.length > 0 ? (
            <p className="text-[11px] text-amber-700">Pending changes: {manualPolicyChangedFields.join(", ")}.</p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            Effective now: policy uses {manualPeriodBasis === "MONTHLY_CALENDAR" ? "monthly close windows" : "fiscal period-end windows"},
            with {manualPeriodEndWindowDays || "0"} day(s) window and minimum note length {manualMinExceptionNoteLength || "0"}.
            Exception note requirement outside window is {manualRequireExceptionOutsideWindow ? "enabled" : "disabled"}.
          </p>
        </CardContent>
      </Card>

      <Card id="reconcile-thresholds">
        <CardHeader>
          <CardTitle>Reconcile severity thresholds</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Controls severity labels in Operational vs Ledger Reconcile for currency and margin variances.
          </p>
          <p className="text-[11px] text-muted-foreground">
            {describeLastUpdated("reconcile-thresholds")}{" "}
            <Link className="underline" href={getSectionAuditLink("reconcile-thresholds")}>Open section audit</Link>
          </p>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Currency minor threshold (ratio)</span>
            <Input
              placeholder="Example: 0.01"
              inputMode="decimal"
              min={0}
              step="0.001"
              value={reconcileCurrencyMinorPct}
              onChange={(e) => setReconcileCurrencyMinorPct(e.target.value)}
              disabled={!isAdmin}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Currency warning threshold (ratio)</span>
            <Input
              placeholder="Example: 0.05"
              inputMode="decimal"
              min={0}
              step="0.001"
              value={reconcileCurrencyWarningPct}
              onChange={(e) => setReconcileCurrencyWarningPct(e.target.value)}
              disabled={!isAdmin}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Margin minor threshold (absolute % points)</span>
            <Input
              placeholder="Example: 0.1"
              inputMode="decimal"
              min={0}
              step="0.1"
              value={reconcileMarginMinorAbsPct}
              onChange={(e) => setReconcileMarginMinorAbsPct(e.target.value)}
              disabled={!isAdmin}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Margin warning threshold (absolute % points)</span>
            <Input
              placeholder="Example: 0.5"
              inputMode="decimal"
              min={0}
              step="0.1"
              value={reconcileMarginWarningAbsPct}
              onChange={(e) => setReconcileMarginWarningAbsPct(e.target.value)}
              disabled={!isAdmin}
            />
          </label>
          {!reconcileThresholdsValid ? <p className="text-xs text-red-600">Ensure warning thresholds are greater than or equal to minor thresholds.</p> : null}
          {!isAdmin ? <p className="text-xs text-amber-700">Only ADMIN can change this policy.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button className="w-full sm:w-auto" onClick={() => void saveReconcileThresholds()} disabled={savingReconcileThresholds || !reconcileThresholdsDirty || !reconcileThresholdsValid || !isAdmin}>
              {savingReconcileThresholds ? "Saving..." : "Save reconcile thresholds"}
            </Button>
            <Button className="w-full sm:w-auto" variant="ghost" onClick={() => setResetDialog("reconcileThresholds")} disabled={savingReconcileThresholds || !isAdmin}>
              Reset default
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => {
                setReconcileCurrencyMinorPct(String(currentReconcileThresholds.currencyMinorPct));
                setReconcileCurrencyWarningPct(String(currentReconcileThresholds.currencyWarningPct));
                setReconcileMarginMinorAbsPct(String(currentReconcileThresholds.marginMinorAbsPct));
                setReconcileMarginWarningAbsPct(String(currentReconcileThresholds.marginWarningAbsPct));
              }}
              disabled={savingReconcileThresholds || !reconcileThresholdsDirty}
            >
              Discard changes
            </Button>
            <span className="text-xs text-muted-foreground">{reconcileThresholdsDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
          {reconcileChangedFields.length > 0 ? (
            <p className="text-[11px] text-amber-700">Pending changes: {reconcileChangedFields.join(", ")}.</p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            Effective now: currency minor/warning = {(Number(reconcileCurrencyMinorPct || 0) * 100).toFixed(2)}% /{" "}
            {(Number(reconcileCurrencyWarningPct || 0) * 100).toFixed(2)}%, margin minor/warning ={" "}
            {(Number(reconcileMarginMinorAbsPct || 0)).toFixed(2)} / {(Number(reconcileMarginWarningAbsPct || 0)).toFixed(2)} percentage points.
          </p>
        </CardContent>
      </Card>

      <Card id="journal-policy">
        <CardHeader>
          <CardTitle>Journal runtime policy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Controls default journal scope and archive behavior used by the Journal Entries page and archive jobs.
          </p>
          <p className="text-[11px] text-muted-foreground">
            {describeLastUpdated("journal-policy")}{" "}
            <Link className="underline" href={getSectionAuditLink("journal-policy")}>Open section audit</Link>
          </p>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Default recent window (days)</span>
            <Input
              placeholder="Example: 90"
              inputMode="numeric"
              min={1}
              max={3660}
              step={1}
              value={journalRecentWindowDays}
              onChange={(e) => setJournalRecentWindowDays(e.target.value)}
              disabled={!isAdmin}
            />
          </label>
          <label className="flex items-center gap-2 rounded-md border px-3 py-2">
            <input
              type="checkbox"
              checked={journalManualEntryAllowPnl}
              onChange={(e) => setJournalManualEntryAllowPnl(e.target.checked)}
              disabled={!isAdmin}
            />
            <span>Allow manual entries to Income/Expense accounts</span>
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Archive entries older than (months)</span>
            <Input
              placeholder="Example: 18"
              inputMode="numeric"
              min={1}
              max={120}
              step={1}
              value={journalArchiveAfterMonths}
              onChange={(e) => setJournalArchiveAfterMonths(e.target.value)}
              disabled={!isAdmin}
            />
          </label>
          <label className="flex items-center gap-2 rounded-md border px-3 py-2">
            <input
              type="checkbox"
              checked={journalArchiveCronDryRun}
              onChange={(e) => setJournalArchiveCronDryRun(e.target.checked)}
              disabled={!isAdmin}
            />
            <span>Scheduled archive runs in dry-run mode by default</span>
          </label>
          {!journalPolicyValid ? (
            <p className="text-xs text-red-600">Journal recent window must be 1-3660 days and archive months must be 1-120.</p>
          ) : null}
          {!isAdmin ? <p className="text-xs text-amber-700">Only ADMIN can change this policy.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="w-full sm:w-auto"
              onClick={() => void saveJournalPolicy()}
              disabled={savingJournalPolicy || !journalPolicyDirty || !journalPolicyValid || !isAdmin}
            >
              {savingJournalPolicy ? "Saving..." : "Save journal policy"}
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => setResetDialog("journalPolicy")}
              disabled={savingJournalPolicy || !isAdmin}
            >
              Reset default
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => {
                setJournalRecentWindowDays(String(currentJournalPolicy.recentWindowDays));
                setJournalManualEntryAllowPnl(currentJournalPolicy.manualEntryAllowPnl);
                setJournalArchiveAfterMonths(String(currentJournalPolicy.archiveAfterMonths));
                setJournalArchiveCronDryRun(currentJournalPolicy.archiveCronDryRun);
              }}
              disabled={savingJournalPolicy || !journalPolicyDirty}
            >
              Discard changes
            </Button>
            <span className="text-xs text-muted-foreground">{journalPolicyDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
          {journalPolicyChangedFields.length > 0 ? (
            <p className="text-[11px] text-amber-700">Pending changes: {journalPolicyChangedFields.join(", ")}.</p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            Effective now: recent window {journalRecentWindowDays || "0"} day(s), manual income/expense entries{" "}
            {journalManualEntryAllowPnl ? "allowed" : "blocked"}, archive cutoff {journalArchiveAfterMonths || "0"} month(s),
            scheduled mode {journalArchiveCronDryRun ? "dry run" : "live run"}.
          </p>
        </CardContent>
      </Card>

      <Card id="reopen-policy">
        <CardHeader>
          <CardTitle>Reopen policy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Governs when closed months and fiscal periods may be reopened. Outside these windows, reopen is blocked.
          </p>
          <p className="text-[11px] text-muted-foreground">
            {describeLastUpdated("reopen-policy")}{" "}
            <Link className="underline" href={getSectionAuditLink("reopen-policy")}>Open section audit</Link>
          </p>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Monthly reopen window (days after month-end)</span>
            <Input
              placeholder="Example: 7"
              inputMode="numeric"
              min={0}
              max={365}
              step={1}
              value={monthlyReopenWindowDays}
              onChange={(e) => setMonthlyReopenWindowDays(e.target.value)}
              disabled={!isAdmin}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Fiscal reopen window (days after period-end)</span>
            <Input
              placeholder="Example: 30"
              inputMode="numeric"
              min={0}
              max={365}
              step={1}
              value={fiscalReopenWindowDays}
              onChange={(e) => setFiscalReopenWindowDays(e.target.value)}
              disabled={!isAdmin}
            />
          </label>
          <label className="flex items-center gap-2 rounded-md border px-3 py-2">
            <input
              type="checkbox"
              checked={enforceFinalizedYearLock}
              onChange={(e) => setEnforceFinalizedYearLock(e.target.checked)}
              disabled={!isAdmin}
            />
            <span>Hard-lock finalized fiscal years</span>
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Finalized fiscal years (YYYY, comma/space separated)</span>
            <Input
              placeholder="Example: 2024, 2025"
              value={finalizedFiscalYears}
              onChange={(e) => setFinalizedFiscalYears(e.target.value)}
              disabled={!isAdmin}
            />
          </label>
          {!reopenPolicyValid ? (
            <p className="text-xs text-red-600">Reopen windows must be whole numbers between 0 and 365.</p>
          ) : null}
          {!isAdmin ? <p className="text-xs text-amber-700">Only ADMIN can change this policy.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="w-full sm:w-auto"
              onClick={() => void saveReopenPolicy()}
              disabled={savingReopenPolicy || !reopenPolicyDirty || !reopenPolicyValid || !isAdmin}
            >
              {savingReopenPolicy ? "Saving..." : "Save reopen policy"}
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => setResetDialog("reopenPolicy")}
              disabled={savingReopenPolicy || !isAdmin}
            >
              Reset default
            </Button>
            <Button
              className="w-full sm:w-auto"
              variant="ghost"
              onClick={() => {
                setMonthlyReopenWindowDays(String(currentMonthlyReopenWindowDays));
                setFiscalReopenWindowDays(String(currentFiscalReopenWindowDays));
                setEnforceFinalizedYearLock(currentEnforceFinalizedYearLock);
                setFinalizedFiscalYears(currentFinalizedFiscalYears.join(", "));
              }}
              disabled={savingReopenPolicy || !reopenPolicyDirty}
            >
              Discard changes
            </Button>
            <span className="text-xs text-muted-foreground">{reopenPolicyDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
          {reopenChangedFields.length > 0 ? (
            <p className="text-[11px] text-amber-700">Pending changes: {reopenChangedFields.join(", ")}.</p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            Finalized-year lock applies on the Periods page when reopening closed fiscal periods.
          </p>
          <p className="text-[11px] text-muted-foreground">
            Effective now: monthly reopen window {monthlyReopenWindowDays || "0"} day(s), fiscal reopen window{" "}
            {fiscalReopenWindowDays || "0"} day(s), finalized-year hard lock {enforceFinalizedYearLock ? "enabled" : "disabled"}.
          </p>
        </CardContent>
      </Card>

      <Dialog open={resetDialog !== null} onOpenChange={(open) => !open && setResetDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset setting to default?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will overwrite the current value for this settings section with the default policy value.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!resetDialog) return;
                await runReset(resetDialog);
              }}
            >
              Confirm reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
