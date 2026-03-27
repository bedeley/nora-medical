"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  getDefaultGhanaStatutoryConfig,
  normalizeGhanaStatutoryConfig,
  type GhanaPayeBand,
} from "@/lib/hr-ghana-statutory-core";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type HrCadence = "monthly" | "quarterly";
type HrSettingKey =
  | "hr.workweekDays"
  | "hr.reviewCadence"
  | "hr.payroll.ghana.enablePaye"
  | "hr.payroll.ghana.enableSsnitEmployee"
  | "hr.payroll.ghana.enableSsnitEmployer"
  | "hr.payroll.ghana.ssnitEmployeeRate"
  | "hr.payroll.ghana.payeBands"
  | "hr.payroll.ghana.autoStatutoryCalc"
  | "hr.payroll.ghana.ssnitEmployerRate"
  | "hr.payroll.ghana.taxableAllowancePercent"
  | "hr.payroll.remittance.requireReference";

type HrSettingsResponse = {
  values?: Record<string, unknown>;
  meta?: Record<string, { createdAt?: string; updatedAt?: string }>;
};

type AuditHistoryRow = {
  id: string;
  createdAt: string;
  action: string;
  entityId: string;
  actor?: { name?: string | null; email?: string | null; role?: string | null } | null;
  meta?: Record<string, unknown> | null;
};

type SaveConfirmAction = "all" | "workweek" | "cadence" | "ghana";

function toPlainOperationLabel(operation: string) {
  const normalized = operation.trim().toLowerCase();
  if (normalized === "update_review_cadence") return "Updated review cadence";
  if (normalized === "update_workweek_days") return "Updated workweek days";
  if (normalized === "update_ghana_ssnit_rate") return "Updated Ghana SSNIT employee rate";
  if (normalized === "update_ghana_paye_bands") return "Updated Ghana PAYE tax bands";
  if (normalized === "update_ghana_auto_calculation_toggle") return "Updated Ghana auto calculation";
  if (normalized === "update_ghana_enable_paye") return "Updated PAYE policy toggle";
  if (normalized === "update_ghana_enable_ssnit_employee") return "Updated SSNIT employee toggle";
  if (normalized === "update_ghana_enable_ssnit_employer") return "Updated SSNIT employer toggle";
  if (normalized === "update_ghana_employer_ssnit_rate") return "Updated Ghana SSNIT employer rate";
  if (normalized === "update_ghana_taxable_allowance_percent") return "Updated taxable allowance percent";
  if (normalized === "update_remittance_reference_requirement")
    return "Updated remittance reference requirement";
  if (normalized === "reset_review_cadence_default") return "Reset review cadence to default";
  if (normalized === "reset_workweek_days_default") return "Reset workweek days to default";
  return "Updated HR setting";
}

function toPlainSettingLabel(settingKey: string) {
  if (settingKey === "hr.reviewCadence") return "Review cadence";
  if (settingKey === "hr.workweekDays") return "Workweek days";
  if (settingKey === "hr.payroll.ghana.ssnitEmployeeRate") return "Ghana SSNIT employee rate";
  if (settingKey === "hr.payroll.ghana.payeBands") return "Ghana PAYE tax bands";
  if (settingKey === "hr.payroll.ghana.autoStatutoryCalc") return "Ghana auto calculation";
  if (settingKey === "hr.payroll.ghana.enablePaye") return "Enable PAYE";
  if (settingKey === "hr.payroll.ghana.enableSsnitEmployee") return "Enable SSNIT employee deduction";
  if (settingKey === "hr.payroll.ghana.enableSsnitEmployer") return "Enable SSNIT employer contribution";
  if (settingKey === "hr.payroll.ghana.ssnitEmployerRate") return "Ghana SSNIT employer rate";
  if (settingKey === "hr.payroll.ghana.taxableAllowancePercent") return "Taxable allowance percent";
  if (settingKey === "hr.payroll.remittance.requireReference") return "Require remittance reference";
  return settingKey;
}

function resolveWorkweekDays(value: unknown) {
  const num = Number(value);
  if (Number.isFinite(num) && num >= 5 && num <= 7) return Math.floor(num);
  return 5;
}

function resolveReviewCadence(value: unknown): HrCadence {
  return value === "monthly" ? "monthly" : "quarterly";
}

function formatBandsForEditor(bands: GhanaPayeBand[]) {
  return bands
    .map((band) => `${band.limit == null ? "*" : band.limit}, ${band.rate}`)
    .join("\n");
}

function parseBandsFromEditor(text: string): GhanaPayeBand[] | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const parsed: GhanaPayeBand[] = [];
  for (const line of lines) {
    const [limitRaw, rateRaw] = line.split(",").map((part) => part.trim());
    if (!rateRaw) return null;
    const rate = Number(rateRaw);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) return null;
    if (limitRaw === "*" || limitRaw.toLowerCase() === "remaining") {
      parsed.push({ limit: null, rate });
      continue;
    }
    const limit = Number(limitRaw);
    if (!Number.isFinite(limit) || limit <= 0) return null;
    parsed.push({ limit, rate });
  }
  return parsed;
}

export default function HrSettingsPage() {
  const ghanaDefaults = getDefaultGhanaStatutoryConfig();
  const { data: session } = useSession();
  const currentRole = String((session?.user as { role?: string } | undefined)?.role || "");
  const canEdit = currentRole === "ADMIN";
  const [workweekDays, setWorkweekDays] = useState(5);
  const [reviewCadence, setReviewCadence] = useState<HrCadence>("quarterly");
  const [savedWorkweekDays, setSavedWorkweekDays] = useState(5);
  const [savedReviewCadence, setSavedReviewCadence] = useState<HrCadence>("quarterly");
  const [ghanaSsnitRate, setGhanaSsnitRate] = useState(ghanaDefaults.ssnitEmployeeRate);
  const [savedGhanaSsnitRate, setSavedGhanaSsnitRate] = useState(ghanaDefaults.ssnitEmployeeRate);
  const [ghanaEmployerSsnitRate, setGhanaEmployerSsnitRate] = useState(ghanaDefaults.ssnitEmployerRate);
  const [savedGhanaEmployerSsnitRate, setSavedGhanaEmployerSsnitRate] = useState(
    ghanaDefaults.ssnitEmployerRate,
  );
  const [ghanaTaxableAllowancePercent, setGhanaTaxableAllowancePercent] = useState(
    ghanaDefaults.taxableAllowancePercent,
  );
  const [savedGhanaTaxableAllowancePercent, setSavedGhanaTaxableAllowancePercent] = useState(
    ghanaDefaults.taxableAllowancePercent,
  );
  const [ghanaAutoCalculation, setGhanaAutoCalculation] = useState(ghanaDefaults.autoStatutoryCalc);
  const [savedGhanaAutoCalculation, setSavedGhanaAutoCalculation] = useState(
    ghanaDefaults.autoStatutoryCalc,
  );
  const [ghanaEnablePaye, setGhanaEnablePaye] = useState(ghanaDefaults.enablePaye);
  const [savedGhanaEnablePaye, setSavedGhanaEnablePaye] = useState(ghanaDefaults.enablePaye);
  const [ghanaEnableSsnitEmployee, setGhanaEnableSsnitEmployee] = useState(
    ghanaDefaults.enableSsnitEmployee,
  );
  const [savedGhanaEnableSsnitEmployee, setSavedGhanaEnableSsnitEmployee] = useState(
    ghanaDefaults.enableSsnitEmployee,
  );
  const [ghanaEnableSsnitEmployer, setGhanaEnableSsnitEmployer] = useState(
    ghanaDefaults.enableSsnitEmployer,
  );
  const [savedGhanaEnableSsnitEmployer, setSavedGhanaEnableSsnitEmployer] = useState(
    ghanaDefaults.enableSsnitEmployer,
  );
  const [ghanaPayeBandsText, setGhanaPayeBandsText] = useState(
    formatBandsForEditor(ghanaDefaults.payeBands),
  );
  const [savedGhanaPayeBandsText, setSavedGhanaPayeBandsText] = useState(
    formatBandsForEditor(ghanaDefaults.payeBands),
  );
  const [requireRemittanceReference, setRequireRemittanceReference] = useState(false);
  const [savedRequireRemittanceReference, setSavedRequireRemittanceReference] = useState(false);
  const [savingGhanaStatutory, setSavingGhanaStatutory] = useState(false);
  const [savingWorkweek, setSavingWorkweek] = useState(false);
  const [savingCadence, setSavingCadence] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [saveDialog, setSaveDialog] = useState<{ open: boolean; action: SaveConfirmAction | null }>({
    open: false,
    action: null,
  });
  const [resetDialog, setResetDialog] = useState<{ open: boolean; key: HrSettingKey | null }>({
    open: false,
    key: null,
  });

  const { data: settingsData, isLoading, refetch } = useQuery<HrSettingsResponse>({
    queryKey: ["admin", "hr", "settings", "page"],
    queryFn: () =>
      fetcher(
        "/api/admin/hr/settings?keys=hr.workweekDays,hr.reviewCadence,hr.payroll.ghana.autoStatutoryCalc,hr.payroll.ghana.enablePaye,hr.payroll.ghana.enableSsnitEmployee,hr.payroll.ghana.enableSsnitEmployer,hr.payroll.ghana.ssnitEmployeeRate,hr.payroll.ghana.ssnitEmployerRate,hr.payroll.ghana.taxableAllowancePercent,hr.payroll.ghana.payeBands,hr.payroll.remittance.requireReference",
      ),
  });
  const { data: historyData, isLoading: historyLoading, refetch: refetchHistory } = useQuery<{
    items?: AuditHistoryRow[];
  }>({
    queryKey: ["admin", "hr", "settings", "audit-history"],
    queryFn: () =>
      fetcher(
        "/api/admin/audit?action=HR_SETTING_UPDATE&entityType=APPSETTING&sourcePage=admin/hr/settings&paginate=1&page=1&pageSize=8",
      ),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const remoteWorkweek = resolveWorkweekDays(settingsData?.values?.["hr.workweekDays"]);
    const remoteCadence = resolveReviewCadence(settingsData?.values?.["hr.reviewCadence"]);
    const ghanaConfig = normalizeGhanaStatutoryConfig({
      autoStatutoryCalc: settingsData?.values?.["hr.payroll.ghana.autoStatutoryCalc"],
      enablePaye: settingsData?.values?.["hr.payroll.ghana.enablePaye"],
      enableSsnitEmployee: settingsData?.values?.["hr.payroll.ghana.enableSsnitEmployee"],
      enableSsnitEmployer: settingsData?.values?.["hr.payroll.ghana.enableSsnitEmployer"],
      ssnitEmployeeRate: settingsData?.values?.["hr.payroll.ghana.ssnitEmployeeRate"],
      ssnitEmployerRate: settingsData?.values?.["hr.payroll.ghana.ssnitEmployerRate"],
      taxableAllowancePercent: settingsData?.values?.["hr.payroll.ghana.taxableAllowancePercent"],
      payeBands: settingsData?.values?.["hr.payroll.ghana.payeBands"],
    });
    const normalizedEnablePaye = ghanaConfig.autoStatutoryCalc ? ghanaConfig.enablePaye : false;
    const normalizedEnableSsnitEmployee = ghanaConfig.autoStatutoryCalc
      ? ghanaConfig.enableSsnitEmployee
      : false;
    const normalizedEnableSsnitEmployer = ghanaConfig.autoStatutoryCalc
      ? ghanaConfig.enableSsnitEmployer
      : false;
    setWorkweekDays(remoteWorkweek);
    setSavedWorkweekDays(remoteWorkweek);
    setReviewCadence(remoteCadence);
    setSavedReviewCadence(remoteCadence);
    setGhanaSsnitRate(ghanaConfig.ssnitEmployeeRate);
    setSavedGhanaSsnitRate(ghanaConfig.ssnitEmployeeRate);
    setGhanaEmployerSsnitRate(ghanaConfig.ssnitEmployerRate);
    setSavedGhanaEmployerSsnitRate(ghanaConfig.ssnitEmployerRate);
    setGhanaTaxableAllowancePercent(ghanaConfig.taxableAllowancePercent);
    setSavedGhanaTaxableAllowancePercent(ghanaConfig.taxableAllowancePercent);
    setGhanaAutoCalculation(ghanaConfig.autoStatutoryCalc);
    setSavedGhanaAutoCalculation(ghanaConfig.autoStatutoryCalc);
    setGhanaEnablePaye(normalizedEnablePaye);
    setSavedGhanaEnablePaye(normalizedEnablePaye);
    setGhanaEnableSsnitEmployee(normalizedEnableSsnitEmployee);
    setSavedGhanaEnableSsnitEmployee(normalizedEnableSsnitEmployee);
    setGhanaEnableSsnitEmployer(normalizedEnableSsnitEmployer);
    setSavedGhanaEnableSsnitEmployer(normalizedEnableSsnitEmployer);
    const bandText = formatBandsForEditor(ghanaConfig.payeBands);
    setGhanaPayeBandsText(bandText);
    setSavedGhanaPayeBandsText(bandText);
    const requireReference = settingsData?.values?.["hr.payroll.remittance.requireReference"] === true;
    setRequireRemittanceReference(requireReference);
    setSavedRequireRemittanceReference(requireReference);
  }, [settingsData]);

  const workweekDirty = workweekDays !== savedWorkweekDays;
  const cadenceDirty = reviewCadence !== savedReviewCadence;
  const ghanaRateDirty = ghanaSsnitRate !== savedGhanaSsnitRate;
  const ghanaEmployerRateDirty = ghanaEmployerSsnitRate !== savedGhanaEmployerSsnitRate;
  const ghanaTaxableAllowanceDirty =
    ghanaTaxableAllowancePercent !== savedGhanaTaxableAllowancePercent;
  const ghanaAutoCalcDirty = ghanaAutoCalculation !== savedGhanaAutoCalculation;
  const ghanaEnablePayeDirty = ghanaEnablePaye !== savedGhanaEnablePaye;
  const ghanaEnableSsnitEmployeeDirty =
    ghanaEnableSsnitEmployee !== savedGhanaEnableSsnitEmployee;
  const ghanaEnableSsnitEmployerDirty =
    ghanaEnableSsnitEmployer !== savedGhanaEnableSsnitEmployer;
  const ghanaBandsDirty = ghanaPayeBandsText.trim() !== savedGhanaPayeBandsText.trim();
  const remittanceReferenceDirty =
    requireRemittanceReference !== savedRequireRemittanceReference;

  const workweekLabel = useMemo(() => {
    if (workweekDays >= 7) return "All days count as workdays.";
    if (workweekDays === 6) return "Monday to Saturday count as workdays.";
    return "Monday to Friday count as workdays.";
  }, [workweekDays]);

  const cadenceLabel =
    reviewCadence === "monthly"
      ? "Review reminders and next-due dates repeat every month."
      : "Review reminders and next-due dates repeat every quarter.";
  const settingsMeta = settingsData?.meta || {};
  const historyRows = Array.isArray(historyData?.items) ? historyData.items : [];
  const hasChanges =
    workweekDirty ||
    cadenceDirty ||
    ghanaRateDirty ||
    ghanaEmployerRateDirty ||
    ghanaTaxableAllowanceDirty ||
    ghanaAutoCalcDirty ||
    ghanaEnablePayeDirty ||
    ghanaEnableSsnitEmployeeDirty ||
    ghanaEnableSsnitEmployerDirty ||
    ghanaBandsDirty ||
    remittanceReferenceDirty;
  const todayIso = new Date().toISOString().slice(0, 10);

  const saveSetting = async (input: {
    key: HrSettingKey;
    value: unknown;
    section: string;
    operation: string;
    resultSummary: string;
    successMessage: string;
    showSuccessToast?: boolean;
  }) => {
    const expectedUpdatedAt = settingsMeta[input.key]?.updatedAt;
    try {
      const res = await fetch("/api/admin/hr/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: input.key,
          value: input.value,
          expectedUpdatedAt,
          sourcePage: "admin/hr/settings",
          section: input.section,
          operation: input.operation,
          resultSummary: input.resultSummary,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          toast.error("Settings were updated elsewhere. Refreshed latest values.");
          await refetch();
          return false;
        }
        toast.error(body.error || "Failed to save setting.");
        return false;
      }
      if (Boolean(body?.unchanged)) {
        if (input.showSuccessToast !== false) {
          toast.message("No changes to save for this setting.");
        }
        return true;
      }
      await refetch();
      await refetchHistory();
      if (input.showSuccessToast !== false) toast.success(input.successMessage);
      return true;
    } catch {
      toast.error("Failed to save setting.");
      return false;
    }
  };

  const saveWorkweek = async () => {
    if (workweekDays < 5 || workweekDays > 7) {
      toast.error("Workweek days must be between 5 and 7.");
      return;
    }
    setSavingWorkweek(true);
    const ok = await saveSetting({
      key: "hr.workweekDays",
      value: workweekDays,
      section: "leave-policy",
      operation: "update_workweek_days",
      resultSummary: "HR workweek days setting updated successfully.",
      successMessage: "Workweek days saved.",
    });
    if (ok) setSavedWorkweekDays(workweekDays);
    setSavingWorkweek(false);
  };

  const saveCadence = async () => {
    if (reviewCadence !== "monthly" && reviewCadence !== "quarterly") {
      toast.error("Review cadence must be monthly or quarterly.");
      return;
    }
    setSavingCadence(true);
    const ok = await saveSetting({
      key: "hr.reviewCadence",
      value: reviewCadence,
      section: "review-policy",
      operation: "update_review_cadence",
      resultSummary: "HR review cadence setting updated successfully.",
      successMessage: "Review cadence saved.",
    });
    if (ok) setSavedReviewCadence(reviewCadence);
    setSavingCadence(false);
  };

  const saveAll = async () => {
    if (!workweekDirty && !cadenceDirty) {
      toast.message("No settings changes to save.");
      return;
    }
    setSavingAll(true);
    let successCount = 0;
    let failedCount = 0;
    if (workweekDirty) {
      const ok = await saveSetting({
        key: "hr.workweekDays",
        value: workweekDays,
        section: "leave-policy",
        operation: "update_workweek_days",
        resultSummary: "HR workweek days setting updated successfully.",
        successMessage: "Workweek days saved.",
        showSuccessToast: false,
      });
      if (ok) {
        setSavedWorkweekDays(workweekDays);
        successCount += 1;
      } else {
        failedCount += 1;
      }
    }
    if (cadenceDirty) {
      const ok = await saveSetting({
        key: "hr.reviewCadence",
        value: reviewCadence,
        section: "review-policy",
        operation: "update_review_cadence",
        resultSummary: "HR review cadence setting updated successfully.",
        successMessage: "Review cadence saved.",
        showSuccessToast: false,
      });
      if (ok) {
        setSavedReviewCadence(reviewCadence);
        successCount += 1;
      } else {
        failedCount += 1;
      }
    }
    if (
      ghanaRateDirty ||
      ghanaEmployerRateDirty ||
      ghanaTaxableAllowanceDirty ||
      ghanaAutoCalcDirty ||
      ghanaEnablePayeDirty ||
      ghanaEnableSsnitEmployeeDirty ||
      ghanaEnableSsnitEmployerDirty ||
      ghanaBandsDirty ||
      remittanceReferenceDirty
    ) {
      const effectiveEnablePaye = ghanaAutoCalculation ? ghanaEnablePaye : false;
      const effectiveEnableSsnitEmployee = ghanaAutoCalculation ? ghanaEnableSsnitEmployee : false;
      const effectiveEnableSsnitEmployer = ghanaAutoCalculation ? ghanaEnableSsnitEmployer : false;
      const parsedBands = parseBandsFromEditor(ghanaPayeBandsText);
      if (!parsedBands) {
        toast.error("PAYE bands format is invalid. Use 'limit, rate' per line and '*' for final band.");
        setSavingAll(false);
        return;
      }
      const autoOk = await saveSetting({
        key: "hr.payroll.ghana.autoStatutoryCalc",
        value: ghanaAutoCalculation,
        section: "payroll-policy",
        operation: "update_ghana_auto_calculation_toggle",
        resultSummary: "Ghana payroll auto calculation setting updated successfully.",
        successMessage: "Ghana payroll auto calculation saved.",
        showSuccessToast: false,
      });
      const employeeRateOk = await saveSetting({
        key: "hr.payroll.ghana.ssnitEmployeeRate",
        value: ghanaSsnitRate,
        section: "payroll-policy",
        operation: "update_ghana_ssnit_rate",
        resultSummary: "Ghana SSNIT employee rate updated successfully.",
        successMessage: "Ghana SSNIT employee rate saved.",
        showSuccessToast: false,
      });
      const enablePayeOk = await saveSetting({
        key: "hr.payroll.ghana.enablePaye",
        value: effectiveEnablePaye,
        section: "payroll-policy",
        operation: "update_ghana_enable_paye",
        resultSummary: "Ghana PAYE enabled setting updated successfully.",
        successMessage: "Ghana PAYE policy saved.",
        showSuccessToast: false,
      });
      const enableSsnitEmployeeOk = await saveSetting({
        key: "hr.payroll.ghana.enableSsnitEmployee",
        value: effectiveEnableSsnitEmployee,
        section: "payroll-policy",
        operation: "update_ghana_enable_ssnit_employee",
        resultSummary: "Ghana SSNIT employee deduction enabled setting updated successfully.",
        successMessage: "Ghana SSNIT employee policy saved.",
        showSuccessToast: false,
      });
      const enableSsnitEmployerOk = await saveSetting({
        key: "hr.payroll.ghana.enableSsnitEmployer",
        value: effectiveEnableSsnitEmployer,
        section: "payroll-policy",
        operation: "update_ghana_enable_ssnit_employer",
        resultSummary: "Ghana SSNIT employer contribution enabled setting updated successfully.",
        successMessage: "Ghana SSNIT employer policy saved.",
        showSuccessToast: false,
      });
      const employerRateOk = await saveSetting({
        key: "hr.payroll.ghana.ssnitEmployerRate",
        value: ghanaEmployerSsnitRate,
        section: "payroll-policy",
        operation: "update_ghana_employer_ssnit_rate",
        resultSummary: "Ghana SSNIT employer rate updated successfully.",
        successMessage: "Ghana SSNIT employer rate saved.",
        showSuccessToast: false,
      });
      const taxableAllowanceOk = await saveSetting({
        key: "hr.payroll.ghana.taxableAllowancePercent",
        value: ghanaTaxableAllowancePercent,
        section: "payroll-policy",
        operation: "update_ghana_taxable_allowance_percent",
        resultSummary: "Ghana taxable allowance percent updated successfully.",
        successMessage: "Taxable allowance percent saved.",
        showSuccessToast: false,
      });
      const bandsOk = await saveSetting({
        key: "hr.payroll.ghana.payeBands",
        value: parsedBands,
        section: "payroll-policy",
        operation: "update_ghana_paye_bands",
        resultSummary: "Ghana PAYE tax bands updated successfully.",
        successMessage: "Ghana PAYE tax bands saved.",
        showSuccessToast: false,
      });
      const remittanceReferenceOk = await saveSetting({
        key: "hr.payroll.remittance.requireReference",
        value: requireRemittanceReference,
        section: "payroll-policy",
        operation: "update_remittance_reference_requirement",
        resultSummary: "Payroll remittance reference requirement updated successfully.",
        successMessage: "Remittance reference requirement saved.",
        showSuccessToast: false,
      });
      if (
        autoOk &&
        employeeRateOk &&
        enablePayeOk &&
        enableSsnitEmployeeOk &&
        enableSsnitEmployerOk &&
        employerRateOk &&
        taxableAllowanceOk &&
        bandsOk &&
        remittanceReferenceOk
      ) {
        setSavedGhanaAutoCalculation(ghanaAutoCalculation);
        setSavedGhanaSsnitRate(ghanaSsnitRate);
        setSavedGhanaEnablePaye(effectiveEnablePaye);
        setSavedGhanaEnableSsnitEmployee(effectiveEnableSsnitEmployee);
        setSavedGhanaEnableSsnitEmployer(effectiveEnableSsnitEmployer);
        setGhanaEnablePaye(effectiveEnablePaye);
        setGhanaEnableSsnitEmployee(effectiveEnableSsnitEmployee);
        setGhanaEnableSsnitEmployer(effectiveEnableSsnitEmployer);
        setSavedGhanaEmployerSsnitRate(ghanaEmployerSsnitRate);
        setSavedGhanaTaxableAllowancePercent(ghanaTaxableAllowancePercent);
        setSavedGhanaPayeBandsText(ghanaPayeBandsText.trim());
        setSavedRequireRemittanceReference(requireRemittanceReference);
        successCount += 5;
      } else {
        failedCount += 1;
      }
    }
    if (failedCount === 0) {
      toast.success(`Saved ${successCount} setting${successCount === 1 ? "" : "s"}.`);
    } else {
      toast.error(`Saved ${successCount}, failed ${failedCount}.`);
    }
    setSavingAll(false);
  };

  const saveGhanaStatutory = async () => {
    const effectiveEnablePaye = ghanaAutoCalculation ? ghanaEnablePaye : false;
    const effectiveEnableSsnitEmployee = ghanaAutoCalculation ? ghanaEnableSsnitEmployee : false;
    const effectiveEnableSsnitEmployer = ghanaAutoCalculation ? ghanaEnableSsnitEmployer : false;
    const parsedBands = parseBandsFromEditor(ghanaPayeBandsText);
    if (!parsedBands) {
      toast.error("PAYE bands format is invalid. Use 'limit, rate' per line and '*' for final band.");
      return;
    }
    if (!(ghanaSsnitRate >= 0 && ghanaSsnitRate <= 100)) {
      toast.error("SSNIT employee rate must be between 0 and 100.");
      return;
    }
    if (!(ghanaEmployerSsnitRate >= 0 && ghanaEmployerSsnitRate <= 100)) {
      toast.error("SSNIT employer rate must be between 0 and 100.");
      return;
    }
    if (!(ghanaTaxableAllowancePercent >= 0 && ghanaTaxableAllowancePercent <= 100)) {
      toast.error("Taxable allowance percent must be between 0 and 100.");
      return;
    }
    setSavingGhanaStatutory(true);
    const autoOk = await saveSetting({
      key: "hr.payroll.ghana.autoStatutoryCalc",
      value: ghanaAutoCalculation,
      section: "payroll-policy",
      operation: "update_ghana_auto_calculation_toggle",
      resultSummary: "Ghana payroll auto calculation setting updated successfully.",
      successMessage: "Ghana payroll auto calculation saved.",
      showSuccessToast: false,
    });
    const rateOk = await saveSetting({
      key: "hr.payroll.ghana.ssnitEmployeeRate",
      value: ghanaSsnitRate,
      section: "payroll-policy",
      operation: "update_ghana_ssnit_rate",
      resultSummary: "Ghana SSNIT employee rate updated successfully.",
      successMessage: "Ghana SSNIT employee rate saved.",
      showSuccessToast: false,
    });
    const enablePayeOk = await saveSetting({
      key: "hr.payroll.ghana.enablePaye",
      value: effectiveEnablePaye,
      section: "payroll-policy",
      operation: "update_ghana_enable_paye",
      resultSummary: "Ghana PAYE enabled setting updated successfully.",
      successMessage: "Ghana PAYE policy saved.",
      showSuccessToast: false,
    });
    const enableSsnitEmployeeOk = await saveSetting({
      key: "hr.payroll.ghana.enableSsnitEmployee",
      value: effectiveEnableSsnitEmployee,
      section: "payroll-policy",
      operation: "update_ghana_enable_ssnit_employee",
      resultSummary: "Ghana SSNIT employee deduction enabled setting updated successfully.",
      successMessage: "Ghana SSNIT employee policy saved.",
      showSuccessToast: false,
    });
    const enableSsnitEmployerOk = await saveSetting({
      key: "hr.payroll.ghana.enableSsnitEmployer",
      value: effectiveEnableSsnitEmployer,
      section: "payroll-policy",
      operation: "update_ghana_enable_ssnit_employer",
      resultSummary: "Ghana SSNIT employer contribution enabled setting updated successfully.",
      successMessage: "Ghana SSNIT employer policy saved.",
      showSuccessToast: false,
    });
    const employerRateOk = await saveSetting({
      key: "hr.payroll.ghana.ssnitEmployerRate",
      value: ghanaEmployerSsnitRate,
      section: "payroll-policy",
      operation: "update_ghana_employer_ssnit_rate",
      resultSummary: "Ghana SSNIT employer rate updated successfully.",
      successMessage: "Ghana SSNIT employer rate saved.",
      showSuccessToast: false,
    });
    const taxableAllowanceOk = await saveSetting({
      key: "hr.payroll.ghana.taxableAllowancePercent",
      value: ghanaTaxableAllowancePercent,
      section: "payroll-policy",
      operation: "update_ghana_taxable_allowance_percent",
      resultSummary: "Ghana taxable allowance percent updated successfully.",
      successMessage: "Taxable allowance percent saved.",
      showSuccessToast: false,
    });
    const bandsOk = await saveSetting({
      key: "hr.payroll.ghana.payeBands",
      value: parsedBands,
      section: "payroll-policy",
      operation: "update_ghana_paye_bands",
      resultSummary: "Ghana PAYE tax bands updated successfully.",
      successMessage: "Ghana PAYE tax bands saved.",
      showSuccessToast: false,
    });
    const remittanceReferenceOk = await saveSetting({
      key: "hr.payroll.remittance.requireReference",
      value: requireRemittanceReference,
      section: "payroll-policy",
      operation: "update_remittance_reference_requirement",
      resultSummary: "Payroll remittance reference requirement updated successfully.",
      successMessage: "Remittance reference requirement saved.",
      showSuccessToast: false,
    });
    if (
      autoOk &&
      rateOk &&
      enablePayeOk &&
      enableSsnitEmployeeOk &&
      enableSsnitEmployerOk &&
      employerRateOk &&
      taxableAllowanceOk &&
      bandsOk &&
      remittanceReferenceOk
    ) {
      setSavedGhanaAutoCalculation(ghanaAutoCalculation);
      setSavedGhanaSsnitRate(ghanaSsnitRate);
      setSavedGhanaEnablePaye(effectiveEnablePaye);
      setSavedGhanaEnableSsnitEmployee(effectiveEnableSsnitEmployee);
      setSavedGhanaEnableSsnitEmployer(effectiveEnableSsnitEmployer);
      setGhanaEnablePaye(effectiveEnablePaye);
      setGhanaEnableSsnitEmployee(effectiveEnableSsnitEmployee);
      setGhanaEnableSsnitEmployer(effectiveEnableSsnitEmployer);
      setSavedGhanaEmployerSsnitRate(ghanaEmployerSsnitRate);
      setSavedGhanaTaxableAllowancePercent(ghanaTaxableAllowancePercent);
      setSavedGhanaPayeBandsText(ghanaPayeBandsText.trim());
      setSavedRequireRemittanceReference(requireRemittanceReference);
      toast.success("Ghana payroll statutory settings saved.");
    } else {
      toast.error("Some Ghana statutory settings failed to save.");
    }
    setSavingGhanaStatutory(false);
  };

  const openResetDialog = (key: HrSettingKey) => {
    setResetDialog({ open: true, key });
  };

  const openSaveDialog = (action: SaveConfirmAction) => {
    setSaveDialog({ open: true, action });
  };

  const confirmSaveChanges = async () => {
    if (!saveDialog.action) return;
    if (saveDialog.action === "all") {
      await saveAll();
    } else if (saveDialog.action === "workweek") {
      await saveWorkweek();
    } else if (saveDialog.action === "cadence") {
      await saveCadence();
    } else if (saveDialog.action === "ghana") {
      await saveGhanaStatutory();
    }
    setSaveDialog({ open: false, action: null });
  };

  const saveDialogLabel =
    saveDialog.action === "all"
      ? "all changed HR settings"
      : saveDialog.action === "workweek"
        ? "workweek setting"
        : saveDialog.action === "cadence"
          ? "review cadence setting"
          : "Ghana payroll settings";

  const confirmResetDefault = async () => {
    if (!resetDialog.key) return;
    if (resetDialog.key === "hr.workweekDays") {
      setWorkweekDays(5);
      setSavingWorkweek(true);
      const ok = await saveSetting({
        key: "hr.workweekDays",
        value: 5,
        section: "leave-policy",
        operation: "reset_workweek_days_default",
        resultSummary: "HR workweek days reset to default.",
        successMessage: "Workweek days reset to default.",
      });
      if (ok) setSavedWorkweekDays(5);
      setSavingWorkweek(false);
    }
    if (resetDialog.key === "hr.reviewCadence") {
      setReviewCadence("quarterly");
      setSavingCadence(true);
      const ok = await saveSetting({
        key: "hr.reviewCadence",
        value: "quarterly",
        section: "review-policy",
        operation: "reset_review_cadence_default",
        resultSummary: "HR review cadence reset to default.",
        successMessage: "Review cadence reset to default.",
      });
      if (ok) setSavedReviewCadence("quarterly");
      setSavingCadence(false);
    }
    if (resetDialog.key === "hr.payroll.ghana.ssnitEmployeeRate") {
      const defaults = getDefaultGhanaStatutoryConfig();
      setGhanaAutoCalculation(defaults.autoStatutoryCalc);
      setGhanaEnablePaye(defaults.enablePaye);
      setGhanaEnableSsnitEmployee(defaults.enableSsnitEmployee);
      setGhanaEnableSsnitEmployer(defaults.enableSsnitEmployer);
      setGhanaSsnitRate(defaults.ssnitEmployeeRate);
      setGhanaEmployerSsnitRate(defaults.ssnitEmployerRate);
      setGhanaTaxableAllowancePercent(defaults.taxableAllowancePercent);
      setGhanaPayeBandsText(formatBandsForEditor(defaults.payeBands));
      setRequireRemittanceReference(false);
      setSavingGhanaStatutory(true);
      const autoOk = await saveSetting({
        key: "hr.payroll.ghana.autoStatutoryCalc",
        value: defaults.autoStatutoryCalc,
        section: "payroll-policy",
        operation: "update_ghana_auto_calculation_toggle",
        resultSummary: "Ghana payroll auto calculation setting reset to default.",
        successMessage: "Ghana payroll auto calculation reset.",
        showSuccessToast: false,
      });
      const rateOk = await saveSetting({
        key: "hr.payroll.ghana.ssnitEmployeeRate",
        value: defaults.ssnitEmployeeRate,
        section: "payroll-policy",
        operation: "update_ghana_ssnit_rate",
        resultSummary: "Ghana SSNIT employee rate reset to default.",
        successMessage: "Ghana SSNIT employee rate reset.",
        showSuccessToast: false,
      });
      const enablePayeOk = await saveSetting({
        key: "hr.payroll.ghana.enablePaye",
        value: defaults.enablePaye,
        section: "payroll-policy",
        operation: "update_ghana_enable_paye",
        resultSummary: "Ghana PAYE enabled setting reset to default.",
        successMessage: "Ghana PAYE policy reset.",
        showSuccessToast: false,
      });
      const enableSsnitEmployeeOk = await saveSetting({
        key: "hr.payroll.ghana.enableSsnitEmployee",
        value: defaults.enableSsnitEmployee,
        section: "payroll-policy",
        operation: "update_ghana_enable_ssnit_employee",
        resultSummary: "Ghana SSNIT employee deduction enabled setting reset to default.",
        successMessage: "Ghana SSNIT employee policy reset.",
        showSuccessToast: false,
      });
      const enableSsnitEmployerOk = await saveSetting({
        key: "hr.payroll.ghana.enableSsnitEmployer",
        value: defaults.enableSsnitEmployer,
        section: "payroll-policy",
        operation: "update_ghana_enable_ssnit_employer",
        resultSummary: "Ghana SSNIT employer contribution enabled setting reset to default.",
        successMessage: "Ghana SSNIT employer policy reset.",
        showSuccessToast: false,
      });
      const employerRateOk = await saveSetting({
        key: "hr.payroll.ghana.ssnitEmployerRate",
        value: defaults.ssnitEmployerRate,
        section: "payroll-policy",
        operation: "update_ghana_employer_ssnit_rate",
        resultSummary: "Ghana SSNIT employer rate reset to default.",
        successMessage: "Ghana SSNIT employer rate reset.",
        showSuccessToast: false,
      });
      const taxableAllowanceOk = await saveSetting({
        key: "hr.payroll.ghana.taxableAllowancePercent",
        value: defaults.taxableAllowancePercent,
        section: "payroll-policy",
        operation: "update_ghana_taxable_allowance_percent",
        resultSummary: "Ghana taxable allowance percent reset to default.",
        successMessage: "Taxable allowance percent reset.",
        showSuccessToast: false,
      });
      const bandsOk = await saveSetting({
        key: "hr.payroll.ghana.payeBands",
        value: defaults.payeBands,
        section: "payroll-policy",
        operation: "update_ghana_paye_bands",
        resultSummary: "Ghana PAYE tax bands reset to default.",
        successMessage: "Ghana PAYE tax bands reset.",
        showSuccessToast: false,
      });
      const remittanceReferenceOk = await saveSetting({
        key: "hr.payroll.remittance.requireReference",
        value: false,
        section: "payroll-policy",
        operation: "update_remittance_reference_requirement",
        resultSummary: "Payroll remittance reference requirement reset to default.",
        successMessage: "Remittance reference requirement reset.",
        showSuccessToast: false,
      });
      if (
        autoOk &&
        rateOk &&
        enablePayeOk &&
        enableSsnitEmployeeOk &&
        enableSsnitEmployerOk &&
        employerRateOk &&
        taxableAllowanceOk &&
        bandsOk &&
        remittanceReferenceOk
      ) {
        const text = formatBandsForEditor(defaults.payeBands);
        setSavedGhanaAutoCalculation(defaults.autoStatutoryCalc);
        setSavedGhanaSsnitRate(defaults.ssnitEmployeeRate);
        setSavedGhanaEnablePaye(defaults.enablePaye);
        setSavedGhanaEnableSsnitEmployee(defaults.enableSsnitEmployee);
        setSavedGhanaEnableSsnitEmployer(defaults.enableSsnitEmployer);
        setSavedGhanaEmployerSsnitRate(defaults.ssnitEmployerRate);
        setSavedGhanaTaxableAllowancePercent(defaults.taxableAllowancePercent);
        setSavedGhanaPayeBandsText(text);
        setSavedRequireRemittanceReference(false);
        toast.success("Ghana payroll statutory settings reset to default.");
      }
      setSavingGhanaStatutory(false);
    }
    setResetDialog({ open: false, key: null });
  };

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold">HR Settings</h1>
          <p className="text-muted-foreground">
            Manage shared HR policy defaults used across leave and reviews.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="default"
            onClick={() => openSaveDialog("all")}
            disabled={
              !canEdit ||
              !hasChanges ||
              isLoading ||
              savingAll ||
              savingWorkweek ||
              savingCadence ||
              savingGhanaStatutory
            }
          >
            {savingAll ? "Saving all..." : "Save all changed settings"}
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/hr">Back to HR</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/audit?action=HR_SETTING_UPDATE&entityType=APPSETTING&sourcePage=admin/hr/settings">
              Open HR settings audit log
            </Link>
          </Button>
        </div>
      </header>
      {!canEdit ? (
        <Card className="border-amber-300">
          <CardContent className="pt-6 text-sm text-muted-foreground">
            You can view HR settings, but only admins can change them.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Leave Policy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Workweek days</p>
              <Select
                value={String(workweekDays)}
                onValueChange={(value) => setWorkweekDays(Number(value))}
                disabled={!canEdit}
              >
                <SelectTrigger className="w-full sm:w-[220px]">
                  <SelectValue placeholder="Select workweek days" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">5-day week (Mon-Fri)</SelectItem>
                  <SelectItem value="6">6-day week (Mon-Sat)</SelectItem>
                  <SelectItem value="7">7-day week</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{workweekLabel}</p>
              <p className="text-xs text-muted-foreground">
                Affects leave-duration calculations on leave and staff profile pages.
              </p>
              {settingsMeta["hr.workweekDays"]?.updatedAt ? (
                <p className="text-xs text-muted-foreground">
                  Last updated: {new Date(settingsMeta["hr.workweekDays"].updatedAt || "").toLocaleString()}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => openSaveDialog("workweek")}
                disabled={!canEdit || !workweekDirty || savingWorkweek || isLoading}
              >
                {savingWorkweek ? "Saving..." : "Save workweek setting"}
              </Button>
              {workweekDirty ? (
                <Button
                  variant="outline"
                  onClick={() => setWorkweekDays(savedWorkweekDays)}
                  disabled={!canEdit || savingWorkweek}
                >
                  Discard
                </Button>
              ) : null}
              <Button
                variant="outline"
                onClick={() => openResetDialog("hr.workweekDays")}
                disabled={!canEdit || savingWorkweek}
              >
                Reset to default
              </Button>
              <Button asChild variant="outline">
                <Link href="/admin/audit?action=HR_SETTING_UPDATE&entityType=APPSETTING&entityId=hr.workweekDays&sourcePage=admin/hr/settings">
                  View setting audit
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Review Policy</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium">Default review cadence</p>
              <Select
                value={reviewCadence}
                onValueChange={(value) => setReviewCadence(value as HrCadence)}
                disabled={!canEdit}
              >
                <SelectTrigger className="w-full sm:w-[220px]">
                  <SelectValue placeholder="Select cadence" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{cadenceLabel}</p>
              <p className="text-xs text-muted-foreground">
                Controls reminder due windows and quick period defaults on the reviews page.
              </p>
              {settingsMeta["hr.reviewCadence"]?.updatedAt ? (
                <p className="text-xs text-muted-foreground">
                  Last updated: {new Date(settingsMeta["hr.reviewCadence"].updatedAt || "").toLocaleString()}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => openSaveDialog("cadence")}
                disabled={!canEdit || !cadenceDirty || savingCadence || isLoading}
              >
                {savingCadence ? "Saving..." : "Save review cadence"}
              </Button>
              {cadenceDirty ? (
                <Button
                  variant="outline"
                  onClick={() => setReviewCadence(savedReviewCadence)}
                  disabled={!canEdit || savingCadence}
                >
                  Discard
                </Button>
              ) : null}
              <Button
                variant="outline"
                onClick={() => openResetDialog("hr.reviewCadence")}
                disabled={!canEdit || savingCadence}
              >
                Reset to default
              </Button>
              <Button asChild variant="outline">
                <Link href="/admin/audit?action=HR_SETTING_UPDATE&entityType=APPSETTING&entityId=hr.reviewCadence&sourcePage=admin/hr/settings">
                  View setting audit
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Ghana Payroll Statutory Defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">Automatic Ghana statutory calculation</p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ghanaAutoCalculation}
                disabled={!canEdit}
                onChange={(event) => {
                  const nextChecked = event.target.checked;
                  setGhanaAutoCalculation(nextChecked);
                  if (!nextChecked) {
                    setGhanaEnablePaye(false);
                    setGhanaEnableSsnitEmployee(false);
                    setGhanaEnableSsnitEmployer(false);
                  }
                }}
              />
              Enable automatic PAYE and SSNIT calculation by default
            </label>
            <p className="text-xs text-muted-foreground">
              When disabled, payroll generation forms will request manual tax and SSNIT inputs.
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Statutory deduction and contribution policy</p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ghanaEnablePaye}
                disabled={!canEdit || !ghanaAutoCalculation}
                onChange={(event) => setGhanaEnablePaye(event.target.checked)}
              />
              Enable PAYE withholding
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ghanaEnableSsnitEmployee}
                disabled={!canEdit || !ghanaAutoCalculation}
                onChange={(event) => setGhanaEnableSsnitEmployee(event.target.checked)}
              />
              Enable SSNIT employee deduction
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ghanaEnableSsnitEmployer}
                disabled={!canEdit || !ghanaAutoCalculation}
                onChange={(event) => setGhanaEnableSsnitEmployer(event.target.checked)}
              />
              Enable SSNIT employer contribution tracking
            </label>
            <p className="text-xs text-muted-foreground">
              Disable any item only if your payroll policy does not require that statutory component.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={requireRemittanceReference}
                disabled={!canEdit}
                onChange={(event) => setRequireRemittanceReference(event.target.checked)}
              />
              Require payment reference before marking remittance as remitted
            </label>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">SSNIT employee rate (%)</p>
            <input
              type="number"
              className="h-10 w-full rounded-md border border-input px-3 text-sm sm:w-[220px]"
              value={String(ghanaSsnitRate)}
              min={0}
              max={100}
              step="0.01"
              disabled={!canEdit}
              onChange={(event) => setGhanaSsnitRate(Number(event.target.value || 0))}
            />
            <p className="text-xs text-muted-foreground">
              Applied automatically when generating payslips for Ghana payroll.
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">SSNIT employer rate (%)</p>
            <input
              type="number"
              className="h-10 w-full rounded-md border border-input px-3 text-sm sm:w-[220px]"
              value={String(ghanaEmployerSsnitRate)}
              min={0}
              max={100}
              step="0.01"
              disabled={!canEdit}
              onChange={(event) => setGhanaEmployerSsnitRate(Number(event.target.value || 0))}
            />
            <p className="text-xs text-muted-foreground">
              Used for employer-cost tracking and reporting (not deducted from employee net pay).
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Taxable allowance percent (%)</p>
            <input
              type="number"
              className="h-10 w-full rounded-md border border-input px-3 text-sm sm:w-[220px]"
              value={String(ghanaTaxableAllowancePercent)}
              min={0}
              max={100}
              step="0.01"
              disabled={!canEdit}
              onChange={(event) => setGhanaTaxableAllowancePercent(Number(event.target.value || 0))}
            />
            <p className="text-xs text-muted-foreground">
              Controls what portion of allowances is treated as taxable for PAYE.
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">PAYE monthly bands</p>
            <Textarea
              value={ghanaPayeBandsText}
              onChange={(event) => setGhanaPayeBandsText(event.target.value)}
              disabled={!canEdit}
              rows={7}
            />
            <p className="text-xs text-muted-foreground">
              Use one band per line in <span className="font-medium text-foreground">limit, rate</span> format.
              Use <span className="font-medium text-foreground">*</span> for the final unlimited band.
            </p>
            <p className="text-xs text-muted-foreground">Example: 490, 0 then 110, 5 ... then *, 35</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => openSaveDialog("ghana")}
              disabled={
                !canEdit ||
                (!ghanaRateDirty &&
                  !ghanaEmployerRateDirty &&
                  !ghanaTaxableAllowanceDirty &&
                  !ghanaAutoCalcDirty &&
                  !ghanaEnablePayeDirty &&
                  !ghanaEnableSsnitEmployeeDirty &&
                  !ghanaEnableSsnitEmployerDirty &&
                  !ghanaBandsDirty &&
                  !remittanceReferenceDirty) ||
                savingGhanaStatutory ||
                isLoading
              }
            >
              {savingGhanaStatutory ? "Saving..." : "Save Ghana payroll settings"}
            </Button>
            {(ghanaRateDirty ||
              ghanaEmployerRateDirty ||
              ghanaTaxableAllowanceDirty ||
              ghanaAutoCalcDirty ||
              ghanaEnablePayeDirty ||
              ghanaEnableSsnitEmployeeDirty ||
              ghanaEnableSsnitEmployerDirty ||
              ghanaBandsDirty ||
              remittanceReferenceDirty) ? (
              <Button
                variant="outline"
                onClick={() => {
                  setGhanaAutoCalculation(savedGhanaAutoCalculation);
                  setGhanaSsnitRate(savedGhanaSsnitRate);
                  setGhanaEmployerSsnitRate(savedGhanaEmployerSsnitRate);
                  setGhanaTaxableAllowancePercent(savedGhanaTaxableAllowancePercent);
                  setGhanaEnablePaye(savedGhanaEnablePaye);
                  setGhanaEnableSsnitEmployee(savedGhanaEnableSsnitEmployee);
                  setGhanaEnableSsnitEmployer(savedGhanaEnableSsnitEmployer);
                  setGhanaPayeBandsText(savedGhanaPayeBandsText);
                  setRequireRemittanceReference(savedRequireRemittanceReference);
                }}
                disabled={!canEdit || savingGhanaStatutory}
              >
                Discard
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => openResetDialog("hr.payroll.ghana.ssnitEmployeeRate")}
              disabled={!canEdit || savingGhanaStatutory}
            >
              Reset to default
            </Button>
            <Button asChild variant="outline">
              <Link href="/admin/audit?action=HR_SETTING_UPDATE&entityType=APPSETTING&sourcePage=admin/hr/settings&section=payroll-policy">
                View payroll settings audit
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Where These Settings Apply</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Workweek days</span>: used by leave pages to calculate and
            display leave duration.
          </p>
          <p>
            <span className="font-medium text-foreground">Review cadence</span>: used by reviews page reminder due
            dates and period shortcuts.
          </p>
          <p>
            <span className="font-medium text-foreground">Ghana statutory payroll defaults</span>: used by
            compensation page monthly paystub generation and payroll run auto-generation.
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/hr/leave">Open Leave</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/hr/reviews">Open Reviews</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/hr/compensation">Open Compensation</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Refresh settings
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Recent Settings History</CardTitle>
          <Button variant="outline" size="sm" onClick={() => refetchHistory()}>
            Refresh history
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {historyLoading ? (
            <p className="text-muted-foreground">Loading settings history...</p>
          ) : historyRows.length === 0 ? (
            <div className="space-y-2">
              <p className="text-muted-foreground">No settings changes yet today.</p>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href="/admin/audit?action=HR_SETTING_UPDATE&entityType=APPSETTING&sourcePage=admin/hr/settings">
                    Open all HR settings audit
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/admin/audit?sourcePage=admin/hr/settings&start=${todayIso}&end=${todayIso}`}>
                    Open today only
                  </Link>
                </Button>
              </div>
            </div>
          ) : (
            historyRows.map((row) => {
              const meta = (row.meta || {}) as Record<string, unknown>;
              const actorName = row.actor?.name || row.actor?.email || "Unknown";
              const operation = String(meta.operation || "update_hr_setting");
              const resultSummary = String(meta.resultSummary || "HR setting updated.");
              const operationLabel = toPlainOperationLabel(operation);
              const settingLabel = toPlainSettingLabel(row.entityId);
              return (
                <div key={row.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">{settingLabel}</div>
                    <div className="text-xs text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    By {actorName} - {operationLabel}
                  </div>
                  <div className="mt-1 text-xs">{resultSummary}</div>
                  <div className="mt-2">
                    <Button asChild size="sm" variant="outline">
                      <Link
                        href={`/admin/audit?logId=${encodeURIComponent(row.id)}&sourcePage=admin/hr/settings`}
                      >
                        Open in audit
                      </Link>
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Dialog open={saveDialog.open} onOpenChange={(open) => setSaveDialog((prev) => ({ ...prev, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm settings changes?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will save <span className="font-medium text-foreground">{saveDialogLabel}</span> and write audit
            entries for each updated setting.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveDialog({ open: false, action: null })}>
              Cancel
            </Button>
            <Button
              onClick={confirmSaveChanges}
              disabled={!canEdit || savingAll || savingWorkweek || savingCadence || savingGhanaStatutory}
            >
              Confirm save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetDialog.open} onOpenChange={(open) => setResetDialog((prev) => ({ ...prev, open }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset setting to default?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will reset{" "}
            <span className="font-medium text-foreground">
              {resetDialog.key === "hr.workweekDays"
                ? "Workweek days"
                : resetDialog.key === "hr.reviewCadence"
                  ? "Review cadence"
                  : "Ghana payroll statutory defaults"}
            </span>{" "}
            and write an audit entry.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetDialog({ open: false, key: null })}>
              Cancel
            </Button>
            <Button
              onClick={confirmResetDefault}
              disabled={!canEdit || savingWorkweek || savingCadence || savingGhanaStatutory}
            >
              Confirm reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
