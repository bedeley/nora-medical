"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

export default function AccountingSettingsPage() {
  const { data: session } = useSession();
  const role = String(session?.user?.role || "");
  const isAdmin = role === "ADMIN";

  const { data, refetch } = useClientQuery<{ value: ThresholdConfig | null }>({
    queryKey: ["accounting", "integrity-thresholds", "global"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.integrity.thresholds").then((r) => r.json()),
  });
  const { data: ledgerModeData, refetch: refetchLedgerMode } = useClientQuery<{ value: boolean | null }>({
    queryKey: ["accounting", "reporting", "use-ledger"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.reporting.useLedger").then((r) => r.json()),
  });
  const { data: storeCreditPolicyData, refetch: refetchStoreCreditPolicy } = useClientQuery<{ value: StoreCreditApplyPolicy | null }>({
    queryKey: ["accounting", "store-credit", "apply-policy"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.storeCredit.applyPolicy").then((r) => r.json()),
  });
  const { data: bankTxnEditWindowData, refetch: refetchBankTxnEditWindow } = useClientQuery<{ value: number | string | null }>({
    queryKey: ["accounting", "bank-transactions", "edit-window-days"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.bankTransactions.editWindowDays").then((r) => r.json()),
  });
  const { data: manualEntriesPolicyData, refetch: refetchManualEntriesPolicy } = useClientQuery<{ value: ManualEntriesPolicy | null }>({
    queryKey: ["accounting", "manual-entries", "policy"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.manualEntries.policy").then((r) => r.json()),
  });
  const { data: reconcileThresholdsData, refetch: refetchReconcileThresholds } = useClientQuery<{ value: ReconcileThresholds | null }>({
    queryKey: ["accounting", "reconcile", "thresholds"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.reconcile.thresholds").then((r) => r.json()),
  });
  const { data: monthlyReopenWindowData, refetch: refetchMonthlyReopenWindow } = useClientQuery<{ value: number | string | null }>({
    queryKey: ["accounting", "reopen", "monthly-window-days"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.reopen.monthlyWindowDays").then((r) => r.json()),
  });
  const { data: fiscalReopenWindowData, refetch: refetchFiscalReopenWindow } = useClientQuery<{ value: number | string | null }>({
    queryKey: ["accounting", "reopen", "fiscal-window-days"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.reopen.fiscalWindowDays").then((r) => r.json()),
  });
  const { data: enforceFinalizedYearLockData, refetch: refetchEnforceFinalizedYearLock } = useClientQuery<{ value: boolean | string | null }>({
    queryKey: ["accounting", "reopen", "enforce-finalized-year-lock"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.reopen.enforceFinalizedYearLock").then((r) => r.json()),
  });
  const { data: finalizedFiscalYearsData, refetch: refetchFinalizedFiscalYears } = useClientQuery<{ value: number[] | null }>({
    queryKey: ["accounting", "reopen", "finalized-fiscal-years"],
    queryFn: () => fetch("/api/admin/settings/app?key=accounting.reopen.finalizedFiscalYears").then((r) => r.json()),
  });
  const { data: settingsAuditData, refetch: refetchSettingsAudit } = useClientQuery<SettingsAuditResponse>({
    queryKey: ["accounting", "settings", "audit-latest"],
    queryFn: () =>
      fetch("/api/admin/audit?scope=accounting_settings&paginate=1&page=1&pageSize=200").then((r) => r.json()),
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
  const [monthlyReopenWindowDays, setMonthlyReopenWindowDays] = useState(String(DEFAULT_MONTHLY_REOPEN_WINDOW_DAYS));
  const [fiscalReopenWindowDays, setFiscalReopenWindowDays] = useState(String(DEFAULT_FISCAL_REOPEN_WINDOW_DAYS));
  const [enforceFinalizedYearLock, setEnforceFinalizedYearLock] = useState(DEFAULT_ENFORCE_FINALIZED_YEAR_LOCK);
  const [finalizedFiscalYears, setFinalizedFiscalYears] = useState("");
  const [savingReopenPolicy, setSavingReopenPolicy] = useState(false);

  const [resetDialog, setResetDialog] = useState<null | "thresholds" | "reporting" | "storeCredit" | "bankEdit" | "manualPolicy" | "reconcileThresholds" | "reopenPolicy">(null);

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
  const describeLastUpdated = (section: string) => {
    const row = sectionLatestAudit.get(section);
    if (!row) return "No recent audit entry.";
    const actor = row.actor?.name || row.actor?.email || "System";
    return `Last updated ${new Date(row.createdAt).toLocaleString()} by ${actor}.`;
  };
  const storeCreditPolicyExplanation =
    storeCreditPolicy === "oldest_first"
      ? "Checkout uses oldest open customer balances first."
      : storeCreditPolicy === "current_order_first"
        ? "Checkout applies credit to current order first, then oldest balances."
        : "No automatic checkout application; credit must be applied manually.";

  const saveSettings = async () => {
    if (!thresholdsValid) {
      toast.error("Enter valid integrity threshold values.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.integrity.thresholds",
          value: {
            arDifference: arVal,
            inventoryDifference: invVal,
            draftEntries,
            negativeStock,
          },
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "integrity-thresholds",
            operation: "save",
          },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save settings.");
      toast.success("Integrity thresholds updated.");
      refetch();
      refetchSettingsAudit();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  const saveLedgerMode = async () => {
    if (!isAdmin) {
      toast.error("Only ADMIN can change reporting source.");
      return;
    }
    try {
      setSavingLedger(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.reporting.useLedger",
          value: useLedger,
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "reporting-source",
            operation: "save",
          },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save reporting mode.");
      toast.success("Reporting source updated.");
      refetchLedgerMode();
      refetchSettingsAudit();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save reporting mode.");
    } finally {
      setSavingLedger(false);
    }
  };

  const saveStoreCreditPolicy = async () => {
    try {
      setSavingPolicy(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.storeCredit.applyPolicy",
          value: storeCreditPolicy,
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "store-credit-policy",
            operation: "save",
          },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save store-credit policy.");
      toast.success("Store-credit policy updated.");
      refetchStoreCreditPolicy();
      refetchSettingsAudit();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save store-credit policy.");
    } finally {
      setSavingPolicy(false);
    }
  };

  const saveBankTxnEditWindow = async () => {
    if (!isAdmin) {
      toast.error("Only ADMIN can change transaction edit policy.");
      return;
    }
    if (!bankEditWindowValid) {
      toast.error("Enter a valid edit window in days (0 to 365).");
      return;
    }
    try {
      setSavingBankTxnEditWindow(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.bankTransactions.editWindowDays",
          value: Math.floor(bankEditWindowNumeric),
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "bank-transaction-edit-policy",
            operation: "save",
          },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save transaction edit window.");
      toast.success("Bank transaction edit window updated.");
      refetchBankTxnEditWindow();
      refetchSettingsAudit();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save transaction edit window.");
    } finally {
      setSavingBankTxnEditWindow(false);
    }
  };
  const saveManualEntriesPolicy = async () => {
    if (!isAdmin) {
      toast.error("Only ADMIN can change manual entry policy.");
      return;
    }
    if (!manualPolicyValid) {
      toast.error("Enter valid manual-entry policy values.");
      return;
    }
    try {
      setSavingManualPolicy(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.manualEntries.policy",
          value: {
            periodBasis: manualPeriodBasis,
            periodEndWindowDays: Math.floor(manualWindowVal),
            requireExceptionOutsideWindow: manualRequireExceptionOutsideWindow,
            minExceptionNoteLength: Math.floor(manualMinNoteVal),
          },
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "manual-entry-policy",
            operation: "save",
          },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save manual entry policy.");
      toast.success("Manual entry policy updated.");
      refetchManualEntriesPolicy();
      refetchSettingsAudit();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save manual entry policy.");
    } finally {
      setSavingManualPolicy(false);
    }
  };
  const saveReconcileThresholds = async () => {
    if (!isAdmin) {
      toast.error("Only ADMIN can change reconcile thresholds.");
      return;
    }
    if (!reconcileThresholdsValid) {
      toast.error("Enter valid reconcile threshold values.");
      return;
    }
    try {
      setSavingReconcileThresholds(true);
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.reconcile.thresholds",
          value: {
            currencyMinorPct: rcMinorVal,
            currencyWarningPct: rcWarnVal,
            marginMinorAbsPct: rmMinorVal,
            marginWarningAbsPct: rmWarnVal,
          },
          audit: {
            sourcePage: "admin/accounting/settings",
            section: "reconcile-thresholds",
            operation: "save",
          },
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save reconcile thresholds.");
      toast.success("Reconcile thresholds updated.");
      refetchReconcileThresholds();
      refetchSettingsAudit();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save reconcile thresholds.");
    } finally {
      setSavingReconcileThresholds(false);
    }
  };
  const saveReopenPolicy = async () => {
    if (!isAdmin) {
      toast.error("Only ADMIN can change reopen policy.");
      return;
    }
    if (!reopenPolicyValid) {
      toast.error("Enter valid reopen policy values.");
      return;
    }
    try {
      setSavingReopenPolicy(true);
      const payloads = [
        { key: "accounting.reopen.monthlyWindowDays", value: Math.floor(monthlyReopenWindowVal) },
        { key: "accounting.reopen.fiscalWindowDays", value: Math.floor(fiscalReopenWindowVal) },
        { key: "accounting.reopen.enforceFinalizedYearLock", value: enforceFinalizedYearLock },
        { key: "accounting.reopen.finalizedFiscalYears", value: parsedFinalizedFiscalYears },
      ];
      for (const payload of payloads) {
        const res = await fetch("/api/admin/settings/app", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...payload,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "reopen-policy",
              operation: "save",
            },
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || "Failed to save reopen policy.");
      }
      toast.success("Reopen policy updated.");
      refetchMonthlyReopenWindow();
      refetchFiscalReopenWindow();
      refetchEnforceFinalizedYearLock();
      refetchFinalizedFiscalYears();
      refetchSettingsAudit();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save reopen policy.");
    } finally {
      setSavingReopenPolicy(false);
    }
  };

  const runReset = async (scope: "thresholds" | "reporting" | "storeCredit" | "bankEdit" | "manualPolicy" | "reconcileThresholds" | "reopenPolicy") => {
    try {
      if (scope === "thresholds") {
        setSaving(true);
        const res = await fetch("/api/admin/settings/app", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "accounting.integrity.thresholds",
            value: DEFAULT_THRESHOLDS,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "integrity-thresholds",
              operation: "reset",
            },
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || "Failed to reset integrity thresholds.");
        toast.success("Integrity thresholds reset to defaults.");
        refetch();
        refetchSettingsAudit();
      } else if (scope === "reporting") {
        if (!isAdmin) throw new Error("Only ADMIN can reset reporting source.");
        setSavingLedger(true);
        const res = await fetch("/api/admin/settings/app", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "accounting.reporting.useLedger",
            value: DEFAULT_REPORTING_USE_LEDGER,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "reporting-source",
              operation: "reset",
            },
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || "Failed to reset reporting source.");
        toast.success("Reporting source reset to default.");
        refetchLedgerMode();
        refetchSettingsAudit();
      } else if (scope === "storeCredit") {
        setSavingPolicy(true);
        const res = await fetch("/api/admin/settings/app", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "accounting.storeCredit.applyPolicy",
            value: DEFAULT_STORE_CREDIT_POLICY,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "store-credit-policy",
              operation: "reset",
            },
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || "Failed to reset store-credit policy.");
        toast.success("Store-credit policy reset to default.");
        refetchStoreCreditPolicy();
        refetchSettingsAudit();
      } else if (scope === "bankEdit") {
        if (!isAdmin) throw new Error("Only ADMIN can reset transaction edit policy.");
        setSavingBankTxnEditWindow(true);
        const res = await fetch("/api/admin/settings/app", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "accounting.bankTransactions.editWindowDays",
            value: DEFAULT_BANK_TXN_EDIT_WINDOW_DAYS,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "bank-transaction-edit-policy",
              operation: "reset",
            },
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || "Failed to reset transaction edit policy.");
        toast.success("Transaction edit policy reset to default.");
        refetchBankTxnEditWindow();
        refetchSettingsAudit();
      } else if (scope === "manualPolicy") {
        if (!isAdmin) throw new Error("Only ADMIN can reset manual entry policy.");
        setSavingManualPolicy(true);
        const res = await fetch("/api/admin/settings/app", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "accounting.manualEntries.policy",
            value: DEFAULT_MANUAL_ENTRIES_POLICY,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "manual-entry-policy",
              operation: "reset",
            },
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || "Failed to reset manual entry policy.");
        toast.success("Manual entry policy reset to default.");
        refetchManualEntriesPolicy();
        refetchSettingsAudit();
      } else if (scope === "reconcileThresholds") {
        if (!isAdmin) throw new Error("Only ADMIN can reset reconcile thresholds.");
        setSavingReconcileThresholds(true);
        const res = await fetch("/api/admin/settings/app", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: "accounting.reconcile.thresholds",
            value: DEFAULT_RECONCILE_THRESHOLDS,
            audit: {
              sourcePage: "admin/accounting/settings",
              section: "reconcile-thresholds",
              operation: "reset",
            },
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error || "Failed to reset reconcile thresholds.");
        toast.success("Reconcile thresholds reset to default.");
        refetchReconcileThresholds();
        refetchSettingsAudit();
      } else if (scope === "reopenPolicy") {
        if (!isAdmin) throw new Error("Only ADMIN can reset reopen policy.");
        setSavingReopenPolicy(true);
        const defaults = [
          { key: "accounting.reopen.monthlyWindowDays", value: DEFAULT_MONTHLY_REOPEN_WINDOW_DAYS },
          { key: "accounting.reopen.fiscalWindowDays", value: DEFAULT_FISCAL_REOPEN_WINDOW_DAYS },
          { key: "accounting.reopen.enforceFinalizedYearLock", value: DEFAULT_ENFORCE_FINALIZED_YEAR_LOCK },
          { key: "accounting.reopen.finalizedFiscalYears", value: [] as number[] },
        ];
        for (const payload of defaults) {
          const res = await fetch("/api/admin/settings/app", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...payload,
              audit: {
                sourcePage: "admin/accounting/settings",
                section: "reopen-policy",
                operation: "reset",
              },
            }),
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(j?.error || "Failed to reset reopen policy.");
        }
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
      setSavingReopenPolicy(false);
      setResetDialog(null);
    }
  };

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
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
        <Button asChild size="sm" variant="outline">
          <Link href="/admin/audit?scope=accounting_settings">Open settings audit trail</Link>
        </Button>
      </div>

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
          <p className="sm:col-span-2 text-[11px] text-muted-foreground">{describeLastUpdated("integrity-thresholds")}</p>
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
            <Button className="w-full sm:w-auto" onClick={saveSettings} disabled={saving || !thresholdDirty || !thresholdsValid}>
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
            <span className="text-xs text-muted-foreground">{thresholdDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
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
          <p className="text-[11px] text-muted-foreground">{describeLastUpdated("reporting-source")}</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={useLedger} onChange={(e) => setUseLedger(e.target.checked)} disabled={!isAdmin} />
            Use accounting ledger for dashboard and main P&amp;L
          </label>
          {!isAdmin ? <p className="text-xs text-amber-700">Only ADMIN can change this setting.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button className="w-full sm:w-auto" onClick={saveLedgerMode} disabled={savingLedger || !reportingDirty || !isAdmin}>
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
            <span className="text-xs text-muted-foreground">{reportingDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
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
          <p className="text-[11px] text-muted-foreground">{describeLastUpdated("store-credit-policy")}</p>
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
            <Button className="w-full sm:w-auto" onClick={saveStoreCreditPolicy} disabled={savingPolicy || !storeCreditDirty}>
              {savingPolicy ? "Saving..." : "Save store-credit policy"}
            </Button>
            <Button className="w-full sm:w-auto" variant="ghost" onClick={() => setResetDialog("storeCredit")} disabled={savingPolicy}>
              Reset default
            </Button>
            <span className="text-xs text-muted-foreground">{storeCreditDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
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
          <p className="text-[11px] text-muted-foreground">{describeLastUpdated("bank-transaction-edit-policy")}</p>
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
              onClick={saveBankTxnEditWindow}
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
            <span className="text-xs text-muted-foreground">{bankEditDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
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
          <p className="text-[11px] text-muted-foreground">{describeLastUpdated("manual-entry-policy")}</p>
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
            <Button className="w-full sm:w-auto" onClick={saveManualEntriesPolicy} disabled={savingManualPolicy || !manualPolicyDirty || !manualPolicyValid || !isAdmin}>
              {savingManualPolicy ? "Saving..." : "Save manual policy"}
            </Button>
            <Button className="w-full sm:w-auto" variant="ghost" onClick={() => setResetDialog("manualPolicy")} disabled={savingManualPolicy || !isAdmin}>
              Reset default
            </Button>
            <span className="text-xs text-muted-foreground">{manualPolicyDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
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
          <p className="text-[11px] text-muted-foreground">{describeLastUpdated("reconcile-thresholds")}</p>
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
            <Button className="w-full sm:w-auto" onClick={saveReconcileThresholds} disabled={savingReconcileThresholds || !reconcileThresholdsDirty || !reconcileThresholdsValid || !isAdmin}>
              {savingReconcileThresholds ? "Saving..." : "Save reconcile thresholds"}
            </Button>
            <Button className="w-full sm:w-auto" variant="ghost" onClick={() => setResetDialog("reconcileThresholds")} disabled={savingReconcileThresholds || !isAdmin}>
              Reset default
            </Button>
            <span className="text-xs text-muted-foreground">{reconcileThresholdsDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Effective now: currency minor/warning = {(Number(reconcileCurrencyMinorPct || 0) * 100).toFixed(2)}% /{" "}
            {(Number(reconcileCurrencyWarningPct || 0) * 100).toFixed(2)}%, margin minor/warning ={" "}
            {(Number(reconcileMarginMinorAbsPct || 0)).toFixed(2)} / {(Number(reconcileMarginWarningAbsPct || 0)).toFixed(2)} percentage points.
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
          <p className="text-[11px] text-muted-foreground">{describeLastUpdated("reopen-policy")}</p>
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
              onClick={saveReopenPolicy}
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
            <span className="text-xs text-muted-foreground">{reopenPolicyDirty ? "Unsaved changes" : "No changes"}</span>
          </div>
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
