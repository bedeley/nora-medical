"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import {
  filterAndSortPayrollPayslips,
  getPayrollRunAuditHref,
  normalizePayrollPayslipSort,
  type PayrollPayslipSort,
} from "@/lib/hr-payroll-export-routes";
import { normalizeGhanaStatutoryConfig } from "@/lib/hr-ghana-statutory-core";
import { getMissingBankFieldLabels } from "@/lib/hr-payslip-utils";

type Payslip = {
  id: string;
  employeeId: string;
  grossPay: number | string;
  netPay: number | string;
  lineItems?: Record<string, number> | null;
  employee: {
    firstName: string;
    lastName: string;
    bankName?: string | null;
    bankCode?: string | null;
    bankBranch?: string | null;
    bankAccountName?: string | null;
    bankAccountNumber?: string | null;
  };
};

type Employee = {
  id: string;
  firstName: string;
  lastName: string;
};

type HrSettingsResponse = {
  values?: Record<string, unknown>;
};

type PayrollRun = {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: "DRAFT" | "FINALIZED" | "PAID" | "CANCELLED";
  runType?: "REGULAR" | "ADJUSTMENT";
  adjustmentForId?: string | null;
  adjustmentFor?: {
    id: string;
    periodStart: string;
    periodEnd: string;
    status: "DRAFT" | "FINALIZED" | "PAID" | "CANCELLED";
  } | null;
  adjustments?: Array<{
    id: string;
    periodStart: string;
    periodEnd: string;
    status: "DRAFT" | "FINALIZED" | "PAID" | "CANCELLED";
    adjustmentNote?: string | null;
    totalGross?: number | string;
    totalNet?: number | string;
  }>;
  adjustmentsCount?: number;
  adjustmentNote?: string | null;
  totalGross: number | string;
  totalNet: number | string;
  expense?: { id: string } | null;
  payslips: Payslip[];
  ytdTotals?: Record<
    string,
    { gross: number; net: number; deductions: number; tax: number; pension: number }
  >;
};

type AuditEntry = {
  id: string;
  action: string;
  entityType?: string;
  entityId?: string;
  createdAt: string;
  actor?: {
    id?: string;
    name?: string | null;
    email?: string | null;
    role?: string | null;
  } | null;
  meta?: (Record<string, unknown> & {
    resultSummary?: string;
    section?: string;
    operation?: string;
    status?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  }) | null;
};

type AuditChip = {
  label: string;
  value: string;
  tone?: "default" | "warning";
};

type GeneratePreviewResult = {
  previewRows?: Array<{
    employeeId: string;
    grossPay: number;
    netPay: number;
    lineItems?: Record<string, number>;
  }>;
  skipped?: number;
  previewCreated?: number;
  previewUpdated?: number;
  previewOnly?: boolean;
};

type GenerateFormState = {
  bonus: string;
  autoCalculation: boolean;
  taxMode: "percent" | "amount";
  taxValue: string;
  ssnitMode: "percent" | "amount";
  ssnitValue: string;
};

type PendingRunAction =
  | {
      kind: "FINALIZE";
      title: string;
      confirmLabel: string;
      description: string;
    }
  | {
      kind: "CANCEL";
      title: string;
      confirmLabel: string;
      description: string;
    }
  | {
      kind: "MARK_PAID";
      title: string;
      confirmLabel: string;
      description: string;
    }
  | {
      kind: "CREATE_EXPENSE";
      title: string;
      confirmLabel: string;
      description: string;
    };

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function toPlainAuditLabel(value: string | null | undefined) {
  const normalized = String(value || "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function getPayrollAuditTitle(row: AuditEntry) {
  const action = String(row.action || "").trim().toUpperCase();
  if (action === "PAYROLL_GENERATE") return "Payslips generated";
  if (action === "PAYROLL_STATUS_UPDATE") {
    const operation = String(row.meta?.operation || "").trim().toLowerCase();
    if (operation === "finalize_run") return "Payroll run finalized";
    if (operation === "mark_paid") return "Payroll run marked as paid";
    if (operation === "cancel_run") return "Draft payroll cancelled";
    return "Payroll run updated";
  }
  if (action === "PAYROLL_EXPENSE_CREATE") return "Expense entry created";
  if (action === "PAYROLL_ADJUSTMENT_CREATED") return "Adjustment run created";
  if (action === "PAYSLIP_CREATE") return "Manual payslip created";
  if (action === "REPORT.EXPORT.PAYROLL.CSV") return "Payroll CSV exported";
  if (action === "REPORT.EXPORT.PAYROLL.BANK-CSV") return "Bank CSV exported";
  if (action === "REPORT.EXPORT.PAYROLL.FILTERED.CSV") return "Filtered paystub CSV exported";
  return toPlainAuditLabel(row.meta?.operation) || toPlainAuditLabel(row.action) || "Payroll activity";
}

function getAuditStatusTone(status: string | null | undefined) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "FAILED" || normalized === "ERROR") {
    return "border-red-200 bg-red-50 text-red-700";
  }
  if (normalized === "SUCCESS") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300";
}

function getRunStatusBadgeVariant(status: string | null | undefined) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "PAID") return "success" as const;
  if (normalized === "FINALIZED") return "secondary" as const;
  if (normalized === "CANCELLED") return "destructive" as const;
  return "warning" as const;
}

function getRunTypeLabel(runType: string | null | undefined) {
  return String(runType || "").trim().toUpperCase() === "ADJUSTMENT"
    ? "Adjustment run"
    : "Regular run";
}

function formatAuditMetric(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return String(value);
}

function formatByteSize(bytes: number | null | undefined) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

function getPayrollAuditChips(row: AuditEntry): AuditChip[] {
  const meta = row.meta || {};
  const after =
    meta.after && typeof meta.after === "object" ? (meta.after as Record<string, unknown>) : {};
  const operation = String(meta.operation || "").trim().toLowerCase();
  const chips: AuditChip[] = [];

  const pushChip = (label: string, value: string, tone: AuditChip["tone"] = "default") => {
    if (!value) return;
    chips.push({ label, value, tone });
  };

  if (operation === "generate_payslips") {
    pushChip("Created", formatAuditMetric(Number(meta.created ?? 0)));
    pushChip("Updated", formatAuditMetric(Number(meta.updated ?? 0)));
    pushChip("Skipped", formatAuditMetric(Number(meta.skipped ?? 0)));
    const bonus = Number(meta.bonus ?? 0);
    if (bonus > 0) pushChip("Bonus", formatCurrency(bonus));
  }

  const fileName = String(after.fileName || "").trim();
  if (fileName) pushChip("File", fileName);

  const rowCount = Number(after.rowCount ?? NaN);
  if (Number.isFinite(rowCount) && rowCount >= 0) {
    pushChip("Rows", String(rowCount));
  }

  const byteSize = formatByteSize(Number(after.byteSize ?? NaN));
  if (byteSize) pushChip("Size", byteSize);

  const search = String(after.search || "").trim();
  if (search) pushChip("Filter", search);

  const amount = Number(after.amount ?? NaN);
  if (Number.isFinite(amount) && amount > 0) {
    pushChip("Amount", formatCurrency(amount));
  }

  const missingBankDetailsCount = Number(after.missingBankDetailsCount ?? NaN);
  if (Number.isFinite(missingBankDetailsCount) && missingBankDetailsCount > 0) {
    pushChip(
      "Blocked",
      `${missingBankDetailsCount} missing bank detail(s)`,
      "warning",
    );
  }

  return chips.slice(0, 5);
}

function getDefaultGenerateForm(
  autoCalculation: boolean,
  ssnitEmployeeRate: number,
): GenerateFormState {
  return {
    bonus: "",
    autoCalculation,
    taxMode: "percent",
    taxValue: "",
    ssnitMode: "percent",
    ssnitValue: autoCalculation ? "" : String(ssnitEmployeeRate),
  };
}

export default function PayrollRunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const runId = useMemo(() => String(params?.id ?? ""), [params]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [showAllMissingBankRows, setShowAllMissingBankRows] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [payslipSearch, setPayslipSearch] = useState(() => searchParams.get("q") || "");
  const [payslipSort, setPayslipSort] = useState<PayrollPayslipSort>(() =>
    normalizePayrollPayslipSort(searchParams.get("sort")),
  );
  const [payslipPage, setPayslipPage] = useState(() => {
    const raw = Number(searchParams.get("page"));
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  });
  const [payslipPageSize, setPayslipPageSize] = useState(() => {
    const raw = Number(searchParams.get("pageSize"));
    if (raw === 25 || raw === 50) return raw;
    return 10;
  });
  const [netOverride, setNetOverride] = useState(false);
  const [form, setForm] = useState({
    employeeId: "",
    grossPay: "",
    netPay: "",
    tax: "",
    pension: "",
    bonus: "",
    allowances: "",
    otherEarnings: "",
    otherDeductions: "",
  });
  const [generateForm, setGenerateForm] = useState(() => getDefaultGenerateForm(true, 5.5));
  const [generatePreview, setGeneratePreview] = useState<GeneratePreviewResult | null>(null);
  const [adjustmentNote, setAdjustmentNote] = useState("");
  const [pendingRunAction, setPendingRunAction] = useState<PendingRunAction | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "hr", "payroll", runId],
    queryFn: () => fetcher(`/api/admin/hr/payroll/${runId}`),
    enabled: Boolean(runId),
  });

  const { data: employeesData } = useQuery({
    queryKey: ["admin", "hr", "employees"],
    queryFn: () => fetcher("/api/admin/hr/employees"),
  });
  const { data: settingsData } = useQuery<HrSettingsResponse>({
    queryKey: ["admin", "hr", "settings", "payroll-detail-policy"],
    queryFn: () =>
      fetcher(
        "/api/admin/hr/settings?keys=hr.payroll.ghana.autoStatutoryCalc,hr.payroll.ghana.enablePaye,hr.payroll.ghana.enableSsnitEmployee,hr.payroll.ghana.enableSsnitEmployer,hr.payroll.ghana.ssnitEmployeeRate,hr.payroll.ghana.ssnitEmployerRate,hr.payroll.ghana.taxableAllowancePercent,hr.payroll.ghana.payeBands",
      ),
  });
  const { data: auditData, isLoading: isAuditLoading } = useQuery({
    queryKey: ["admin", "audit", "payroll-run-activity", runId],
    queryFn: () =>
      fetcher(
        `/api/admin/audit?sourcePage=${encodeURIComponent("admin/hr/payroll/[id]")}&payrollRunId=${encodeURIComponent(runId)}&limit=8`,
      ),
    enabled: Boolean(runId),
  });

  const employees = useMemo(
    () => (Array.isArray(employeesData?.rows) ? (employeesData.rows as Employee[]) : []),
    [employeesData?.rows],
  );
  const employeeNameById = useMemo(
    () =>
      new Map(
        employees.map((employee) => [
          employee.id,
          `${employee.firstName} ${employee.lastName}`.trim() || employee.id,
        ]),
      ),
    [employees],
  );
  const run = data as PayrollRun | undefined;
  const auditRows = Array.isArray(auditData) ? (auditData as AuditEntry[]) : [];
  const payrollPolicy = normalizeGhanaStatutoryConfig({
    autoStatutoryCalc: settingsData?.values?.["hr.payroll.ghana.autoStatutoryCalc"],
    enablePaye: settingsData?.values?.["hr.payroll.ghana.enablePaye"],
    enableSsnitEmployee: settingsData?.values?.["hr.payroll.ghana.enableSsnitEmployee"],
    enableSsnitEmployer: settingsData?.values?.["hr.payroll.ghana.enableSsnitEmployer"],
    ssnitEmployeeRate: settingsData?.values?.["hr.payroll.ghana.ssnitEmployeeRate"],
    ssnitEmployerRate: settingsData?.values?.["hr.payroll.ghana.ssnitEmployerRate"],
    taxableAllowancePercent: settingsData?.values?.["hr.payroll.ghana.taxableAllowancePercent"],
    payeBands: settingsData?.values?.["hr.payroll.ghana.payeBands"],
  });
  const effectiveAutoCalculation = payrollPolicy.autoStatutoryCalc
    ? generateForm.autoCalculation
    : false;
  const previewRows = Array.isArray(generatePreview?.previewRows) ? generatePreview.previewRows : [];
  const previewGrossTotal = previewRows.reduce((sum, row) => sum + Number(row.grossPay || 0), 0);
  const previewNetTotal = previewRows.reduce((sum, row) => sum + Number(row.netPay || 0), 0);
  const allPayslips = useMemo(
    () => (Array.isArray(run?.payslips) ? run.payslips : []),
    [run?.payslips],
  );
  const normalizedPayslipSearch = payslipSearch.trim().toLowerCase();

  const filteredAndSortedPayslips = useMemo(
    () => filterAndSortPayrollPayslips(allPayslips, normalizedPayslipSearch, payslipSort),
    [allPayslips, normalizedPayslipSearch, payslipSort],
  );

  const payslipTotalPages = Math.max(1, Math.ceil(filteredAndSortedPayslips.length / payslipPageSize));
  const safePayslipPage = Math.min(payslipPage, payslipTotalPages);
  const payslipPageRows = filteredAndSortedPayslips.slice(
    (safePayslipPage - 1) * payslipPageSize,
    safePayslipPage * payslipPageSize,
  );
  const payslipGrossTotal = allPayslips.reduce((sum, slip) => sum + Number(slip.grossPay || 0), 0);
  const payslipNetTotal = allPayslips.reduce((sum, slip) => sum + Number(slip.netPay || 0), 0);
  const payslipEmployerSsnitTotal = allPayslips.reduce(
    (sum, slip) => sum + Number((slip.lineItems?.employerSsnit as number | undefined) || 0),
    0,
  );
  const runGross = Number(run?.totalGross || 0);
  const runNet = Number(run?.totalNet || 0);
  const grossDelta = Number((runGross - payslipGrossTotal).toFixed(2));
  const netDelta = Number((runNet - payslipNetTotal).toFixed(2));
  const hasIntegrityMismatch = Math.abs(grossDelta) > 0.009 || Math.abs(netDelta) > 0.009;
  const missingBankPayslips = useMemo(
    () =>
      allPayslips
        .map((slip) => ({
          ...slip,
          missingFields: getMissingBankFieldLabels(slip.employee),
        }))
        .filter((slip) => slip.missingFields.length > 0),
    [allPayslips],
  );
  const missingBankFieldsByPayslipId = useMemo(
    () =>
      new Map(
        missingBankPayslips.map((slip) => [slip.id, slip.missingFields] as const),
      ),
    [missingBankPayslips],
  );
  const missingBankDetailCount = missingBankPayslips.length;
  const missingBankVisibleLimit = 6;
  const visibleMissingBankPayslips = showAllMissingBankRows
    ? missingBankPayslips
    : missingBankPayslips.slice(0, missingBankVisibleLimit);
  const hasBusyAction = Boolean(activeAction);
  const canFinalizeRun =
    run?.status === "DRAFT" && allPayslips.length > 0 && !hasIntegrityMismatch;
  const canBankExport = run?.status === "FINALIZED" || run?.status === "PAID";
  const canMarkPaid = run?.status === "FINALIZED";
  const runLocked = run?.status === "PAID" || run?.status === "CANCELLED";
  const periodLabel = run
    ? `${new Date(run.periodStart).toLocaleDateString()} - ${new Date(run.periodEnd).toLocaleDateString()}`
    : "";
  const runStatusLabel = toPlainAuditLabel(run?.status);
  const runTypeLabel = getRunTypeLabel(run?.runType);
  const hasRelatedAdjustments =
    run?.runType !== "ADJUSTMENT" &&
    ((run?.adjustments?.length || 0) > 0 || (run?.adjustmentsCount || 0) > 0);
  const hasFilteredPayslipView =
    normalizedPayslipSearch.length > 0 || payslipSort !== "employee_asc" || payslipPageSize !== 10;
  const runHeadlineSummary = [
    `${allPayslips.length} payslip${allPayslips.length === 1 ? "" : "s"}`,
    missingBankDetailCount > 0
      ? `${missingBankDetailCount} bank blocker${missingBankDetailCount === 1 ? "" : "s"}`
      : "Bank export ready",
    run?.expense ? "Expense entry created" : "Expense entry pending",
  ].join(" | ");
  const actionWarnings = [
    !canFinalizeRun && !hasIntegrityMismatch
      ? "Finalize is unavailable because this draft run has no payslips yet."
      : null,
    hasIntegrityMismatch
      ? "Finalize is unavailable until run totals match summed payslips."
      : null,
    !canBankExport
      ? "Bank export is unavailable until this run is finalized or marked as paid."
      : null,
    !canMarkPaid && run?.status !== "PAID"
      ? "Mark as paid is only available when status is finalized."
      : null,
    runLocked ? "This run is locked. No further status transitions are allowed." : null,
  ].filter(Boolean) as string[];

  useEffect(() => {
    const next = new URLSearchParams(searchParams.toString());
    if (payslipSearch.trim()) next.set("q", payslipSearch.trim());
    else next.delete("q");
    next.set("sort", payslipSort);
    next.set("page", String(safePayslipPage));
    next.set("pageSize", String(payslipPageSize));
    const currentText = searchParams.toString();
    const nextText = next.toString();
    if (nextText !== currentText) {
      router.replace(nextText ? `${pathname}?${nextText}` : pathname);
    }
  }, [pathname, payslipPageSize, payslipSearch, payslipSort, router, safePayslipPage, searchParams]);

  useEffect(() => {
    if (missingBankPayslips.length <= missingBankVisibleLimit && showAllMissingBankRows) {
      setShowAllMissingBankRows(false);
    }
  }, [missingBankPayslips.length, missingBankVisibleLimit, showAllMissingBankRows]);

  useEffect(() => {
    if (!generateOpen) {
      setGeneratePreview(null);
      return;
    }
    setGenerateForm((current) => {
      const nextAutoCalculation = payrollPolicy.autoStatutoryCalc ? current.autoCalculation : false;
      const nextSsnitValue =
        !nextAutoCalculation && !current.ssnitValue
          ? String(payrollPolicy.ssnitEmployeeRate)
          : current.ssnitValue;
      if (
        current.autoCalculation === nextAutoCalculation &&
        current.ssnitValue === nextSsnitValue
      ) {
        return current;
      }
      return {
        ...current,
        autoCalculation: nextAutoCalculation,
        ssnitValue: nextSsnitValue,
      };
    });
  }, [generateOpen, payrollPolicy.autoStatutoryCalc, payrollPolicy.ssnitEmployeeRate]);

  useEffect(() => {
    setGeneratePreview(null);
  }, [
    generateForm.autoCalculation,
    generateForm.bonus,
    generateForm.ssnitMode,
    generateForm.ssnitValue,
    generateForm.taxMode,
    generateForm.taxValue,
  ]);

  const beginAction = (action: string) => {
    if (activeAction) return false;
    setActiveAction(action);
    return true;
  };

  const endAction = () => setActiveAction(null);

  const updateStatus = async (status: "FINALIZED" | "PAID" | "CANCELLED", createExpense: boolean) => {
    if (!runId) return;
    if (!beginAction(`status_${status.toLowerCase()}`)) return;
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, createExpense }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update payroll.");
        return;
      }
      toast.success("Payroll updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll", runId] });
      queryClient.invalidateQueries({ queryKey: ["admin", "audit", "payroll-run-activity", runId] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update payroll.");
    } finally {
      endAction();
    }
  };

  const handleCreateExpenseEntry = async () => {
    if (!runId) return;
    if (!beginAction("create_expense_entry")) return;
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ createExpense: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to create expense entry.");
        return;
      }
      toast.success("Expense entry created.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll", runId] });
      queryClient.invalidateQueries({ queryKey: ["admin", "audit", "payroll-run-activity", runId] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to create expense entry.");
    } finally {
      endAction();
    }
  };

  const openRunActionConfirm = (kind: PendingRunAction["kind"]) => {
    if (!run) return;
    if (kind === "FINALIZE") {
      setPendingRunAction({
        kind,
        title: "Finalize Payroll Run",
        confirmLabel: "Finalize run",
        description:
          "Finalizing locks this run for review and can create the linked payroll expense entry when one is missing.",
      });
      return;
    }
    if (kind === "CANCEL") {
      setPendingRunAction({
        kind,
        title: "Cancel Draft Payroll Run",
        confirmLabel: "Cancel draft",
        description:
          "Cancelling removes every payslip in this draft run and resets the run totals back to zero.",
      });
      return;
    }
    if (kind === "MARK_PAID") {
      setPendingRunAction({
        kind,
        title: "Mark Payroll Run as Paid",
        confirmLabel: "Mark as paid",
        description:
          "Marking this run as paid confirms settlement for the payroll run and locks any further status changes.",
      });
      return;
    }
    setPendingRunAction({
      kind,
      title: "Create Expense Entry",
      confirmLabel: "Create expense entry",
      description:
        "This posts a linked payroll expense entry for the run using the finalized payroll totals.",
    });
  };

  const confirmPendingRunAction = async () => {
    if (!pendingRunAction) return;
    const action = pendingRunAction;
    setPendingRunAction(null);
    if (action.kind === "FINALIZE") {
      await updateStatus("FINALIZED", !run?.expense);
      return;
    }
    if (action.kind === "CANCEL") {
      await updateStatus("CANCELLED", false);
      return;
    }
    if (action.kind === "MARK_PAID") {
      await updateStatus("PAID", false);
      return;
    }
    await handleCreateExpenseEntry();
  };

  const handleCreatePayslip = async () => {
    if (!beginAction("create_payslip")) return;
    if (!form.employeeId) {
      toast.error("Select an employee.");
      endAction();
      return;
    }
    const gross = Number(form.grossPay || 0);
    const lineItems = {
      tax: Number(form.tax || 0),
      pension: Number(form.pension || 0),
      bonus: Number(form.bonus || 0),
      allowances: Number(form.allowances || 0),
      otherEarnings: Number(form.otherEarnings || 0),
      otherDeductions: Number(form.otherDeductions || 0),
    };
    const deductions = Number(lineItems.tax || 0) + Number(lineItems.pension || 0) + Number(lineItems.otherDeductions || 0);
    const additions = Number(lineItems.bonus || 0) + Number(lineItems.allowances || 0) + Number(lineItems.otherEarnings || 0);
    const computedNet = gross + additions - deductions;
    const netValue = netOverride ? Number(form.netPay || 0) : computedNet;
    if (gross < 0 || netValue < 0) {
      toast.error("Gross and net pay cannot be negative.");
      endAction();
      return;
    }
    if (Object.values(lineItems).some((value) => Number(value) < 0)) {
      toast.error("Line items cannot be negative.");
      endAction();
      return;
    }
    if (netValue > gross + additions) {
      toast.error("Net pay cannot exceed gross plus additions.");
      endAction();
      return;
    }
    const hasLineItems = Object.values(lineItems).some((value) => value !== 0);
    try {
      const payload = {
        payrollRunId: runId,
        employeeId: form.employeeId,
        grossPay: gross,
        netPay: netValue,
        lineItems: hasLineItems ? lineItems : undefined,
      };
      const res = await fetch("/api/admin/hr/payslips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to create payslip.");
        return;
      }
      toast.success("Payslip created.");
      setDialogOpen(false);
      setNetOverride(false);
      setForm({
        employeeId: "",
        grossPay: "",
        netPay: "",
        tax: "",
        pension: "",
        bonus: "",
        allowances: "",
        otherEarnings: "",
        otherDeductions: "",
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll", runId] });
      queryClient.invalidateQueries({ queryKey: ["admin", "audit", "payroll-run-activity", runId] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to create payslip.");
    } finally {
      endAction();
    }
  };

  const handleExportCsv = async () => {
    if (!runId) return;
    if (!beginAction("export_csv")) return;
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}/export`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to export payroll.");
        return;
      }
      const blob = await res.blob();
      const contentDisposition = res.headers.get("Content-Disposition") || "";
      const nameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      const filename = nameMatch?.[1] || `payroll-${runId}.csv`;
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success(`Export complete: ${filename} (${run?.payslips?.length ?? 0} row(s)).`);
      queryClient.invalidateQueries({ queryKey: ["admin", "audit", "payroll-run-activity", runId] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to export payroll.");
    } finally {
      endAction();
    }
  };

  const handleBankExport = async () => {
    if (!runId) return;
    if (!beginAction("export_bank_csv")) return;
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}/bank-export`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err?.missing?.length) {
          toast.error("Some employees are missing export-ready bank details.");
        } else {
          toast.error(err.error || "Failed to export bank file.");
        }
        return;
      }
      const blob = await res.blob();
      const contentDisposition = res.headers.get("Content-Disposition") || "";
      const nameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      const filename = nameMatch?.[1] || `payroll-bank-${runId}.csv`;
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success(`Bank export complete: ${filename}.`);
      queryClient.invalidateQueries({ queryKey: ["admin", "audit", "payroll-run-activity", runId] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to export bank file.");
    } finally {
      endAction();
    }
  };

  const resetGenerateDialog = () => {
    setGeneratePreview(null);
    setGenerateForm(
      getDefaultGenerateForm(
        payrollPolicy.autoStatutoryCalc,
        payrollPolicy.ssnitEmployeeRate,
      ),
    );
  };

  const validateGenerateInputs = () => {
    if (effectiveAutoCalculation) return true;
    if (!generateForm.taxValue.trim()) {
      toast.error("Enter a manual tax percent or amount.");
      return false;
    }
    if (!generateForm.ssnitValue.trim()) {
      toast.error("Enter a manual SSNIT percent or amount.");
      return false;
    }
    return true;
  };

  const buildGeneratePayload = (previewOnly: boolean) => ({
    bonus: Number(generateForm.bonus || 0),
    autoCalculation: effectiveAutoCalculation,
    taxMode: generateForm.taxMode,
    taxValue: generateForm.taxValue.trim() ? Number(generateForm.taxValue) : undefined,
    ssnitMode: generateForm.ssnitMode,
    ssnitValue: generateForm.ssnitValue.trim() ? Number(generateForm.ssnitValue) : undefined,
    previewOnly,
  });

  const handlePreviewPayslips = async () => {
    if (!runId) return;
    if (!validateGenerateInputs()) return;
    if (!beginAction("preview_generate_payslips")) return;
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeneratePayload(true)),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to preview payslips.");
        return;
      }
      setGeneratePreview(body as GeneratePreviewResult);
      toast.success(
        `Preview ready for ${Array.isArray(body.previewRows) ? body.previewRows.length : 0} employee(s).`,
      );
    } catch (err) {
      console.error(err);
      toast.error("Failed to preview payslips.");
    } finally {
      endAction();
    }
  };

  const handleGeneratePayslips = async () => {
    if (!runId) return;
    if (!validateGenerateInputs()) return;
    if (!beginAction("generate_payslips")) return;
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGeneratePayload(false)),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to generate payslips.");
        return;
      }
      toast.success(
        `Generated ${body.created ?? 0}, updated ${body.updated ?? 0}, skipped ${body.skipped ?? 0}.`,
      );
      setGenerateOpen(false);
      resetGenerateDialog();
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll", runId] });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "audit", "payroll-run-activity", runId] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to generate payslips.");
    } finally {
      endAction();
    }
  };

  const getLineItem = (slip: Payslip, key: string) => {
    if (!slip.lineItems || typeof slip.lineItems !== "object") return 0;
    const value = slip.lineItems[key];
    return Number(value || 0);
  };

  const computedNet = () => {
    const gross = Number(form.grossPay || 0);
    const deductions =
      Number(form.tax || 0) +
      Number(form.pension || 0) +
      Number(form.otherDeductions || 0);
    const additions =
      Number(form.bonus || 0) +
      Number(form.allowances || 0) +
      Number(form.otherEarnings || 0);
    return gross + additions - deductions;
  };

  const handleCreateAdjustment = async () => {
    if (!runId) return;
    if (!beginAction("create_adjustment")) return;
    if (adjustmentNote.trim().length > 0 && adjustmentNote.trim().length < 8) {
      toast.error("Adjustment note should be at least 8 characters.");
      endAction();
      return;
    }
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}/adjustment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: adjustmentNote.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to create adjustment run.");
        return;
      }
      toast.success("Adjustment run created.");
      setAdjustmentOpen(false);
      setAdjustmentNote("");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
      router.push(`/admin/hr/payroll/${body.id}`);
    } catch (err) {
      console.error(err);
      toast.error("Failed to create adjustment run.");
    } finally {
      endAction();
    }
  };

  const handleCopyRunLink = async () => {
    if (!beginAction("copy_run_link")) return;
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success("Run link copied.");
    } catch {
      toast.error("Could not copy run link.");
    } finally {
      endAction();
    }
  };

  const handleCopyExportFiltersLink = async () => {
    if (!beginAction("copy_export_filters_link")) return;
    try {
      const params = new URLSearchParams();
      if (payslipSearch.trim()) params.set("q", payslipSearch.trim());
      params.set("sort", payslipSort);
      params.set("page", String(safePayslipPage));
      params.set("pageSize", String(payslipPageSize));
      const target = `${window.location.origin}${pathname}?${params.toString()}`;
      await navigator.clipboard.writeText(target);
      toast.success("Export filter link copied.");
    } catch {
      toast.error("Could not copy export filter link.");
    } finally {
      endAction();
    }
  };

  const handleExportFilteredPayslipsCsv = async () => {
    if (!runId) return;
    if (!beginAction("export_filtered_csv")) return;
    try {
      const params = new URLSearchParams();
      if (payslipSearch.trim()) params.set("q", payslipSearch.trim());
      params.set("sort", payslipSort);
      const res = await fetch(`/api/admin/hr/payroll/${runId}/export-filtered?${params.toString()}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to export filtered paystubs.");
        return;
      }
      const blob = await res.blob();
      const contentDisposition = res.headers.get("Content-Disposition") || "";
      const nameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      const filename = nameMatch?.[1] || `payroll-filtered-${runId}.csv`;
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success(`Filtered paystubs exported (${filteredAndSortedPayslips.length} row(s)).`);
      queryClient.invalidateQueries({ queryKey: ["admin", "audit", "payroll-run-activity", runId] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to export filtered paystubs.");
    } finally {
      endAction();
    }
  };

  const clearPaystubFilters = () => {
    setPayslipSearch("");
    setPayslipSort("employee_asc");
    setPayslipPage(1);
    setPayslipPageSize(10);
  };

  return (
    <section className="space-y-6">
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading payroll run...</p>
      ) : !run ? (
        <p className="text-sm text-muted-foreground">Payroll run not found.</p>
      ) : (
        <>
          <Card className="overflow-hidden border-slate-200 bg-gradient-to-br from-white via-sky-50 to-emerald-50 shadow-sm dark:border-slate-800 dark:from-slate-950 dark:via-slate-900 dark:to-emerald-950/70">
            <CardContent className="grid gap-5 px-5 py-5 lg:grid-cols-[minmax(0,1.6fr)_18rem]">
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={getRunStatusBadgeVariant(run.status)}>{runStatusLabel}</Badge>
                  <Badge
                    variant="outline"
                    className="border-slate-300 bg-white/80 text-slate-700 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-200"
                  >
                    {runTypeLabel}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={
                      hasIntegrityMismatch
                        ? "border-amber-300 bg-amber-50 text-amber-700"
                        : "border-emerald-300 bg-emerald-50 text-emerald-700"
                    }
                  >
                    {hasIntegrityMismatch ? "Needs review" : "Balanced totals"}
                  </Badge>
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500 dark:text-slate-400">
                    Payroll control
                  </p>
                  <div className="space-y-1">
                    <h1 className="text-3xl font-semibold tracking-tight dark:text-slate-50 sm:text-4xl">
                      {periodLabel}
                    </h1>
                    <p className="max-w-2xl text-sm text-slate-600 dark:text-slate-300">
                      Review the run, resolve blockers, and complete payroll actions from one
                      workspace.
                    </p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{runHeadlineSummary}</p>
                  </div>
                  {run.runType === "ADJUSTMENT" && run.adjustmentFor ? (
                    <div className="rounded-lg border border-slate-200 bg-white/70 px-4 py-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-300">
                      This adjustment run belongs to{" "}
                      <Link
                        href={`/admin/hr/payroll/${run.adjustmentFor.id}`}
                        className="font-medium text-slate-900 underline underline-offset-4 dark:text-slate-100"
                      >
                        {new Date(run.adjustmentFor.periodStart).toLocaleDateString()} -{" "}
                        {new Date(run.adjustmentFor.periodEnd).toLocaleDateString()}
                      </Link>
                      .
                    </div>
                  ) : null}
                  {run.adjustmentNote ? (
                    <div className="rounded-lg border border-slate-200 bg-white/70 px-4 py-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-300">
                      Adjustment note: {run.adjustmentNote}
                    </div>
                  ) : null}
                </div>
                <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-xl border border-slate-200 bg-white/75 px-4 py-2.5 shadow-sm dark:border-slate-800 dark:bg-slate-900/80">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Current gross</div>
                    <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-50">
                      {formatCurrency(Number(run.totalGross || 0))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white/75 px-4 py-2.5 shadow-sm dark:border-slate-800 dark:bg-slate-900/80">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Current net</div>
                    <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-50">
                      {formatCurrency(Number(run.totalNet || 0))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white/75 px-4 py-2.5 shadow-sm dark:border-slate-800 dark:bg-slate-900/80">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Payslips</div>
                    <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-50">
                      {allPayslips.length}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white/75 px-4 py-2.5 shadow-sm dark:border-slate-800 dark:bg-slate-900/80">
                    <div className="text-xs text-slate-500 dark:text-slate-400">Integrity</div>
                    <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-50">
                      {hasIntegrityMismatch ? "Review needed" : "Ready"}
                    </div>
                  </div>
                </div>
              </div>
              <div className="grid gap-2 self-start sm:grid-cols-2 lg:grid-cols-1">
                <Button
                  variant="outline"
                  onClick={handleExportCsv}
                  disabled={hasBusyAction}
                  className="justify-start border-slate-200 bg-white/80 text-slate-700 shadow-sm hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-50"
                >
                  {activeAction === "export_csv" ? "Exporting..." : "Export CSV"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleBankExport}
                  disabled={hasBusyAction || !canBankExport}
                  className="justify-start border-slate-200 bg-white/80 text-slate-700 shadow-sm hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-50"
                >
                  {activeAction === "export_bank_csv" ? "Exporting..." : "Export Bank CSV"}
                </Button>
                <Button
                  asChild
                  variant="outline"
                  className="justify-start border-slate-200 bg-white/80 text-slate-700 shadow-sm hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-50"
                >
                  <Link href="/admin/hr/payroll">Back to payroll</Link>
                </Button>
                <Button
                  variant="outline"
                  onClick={handleCopyRunLink}
                  disabled={hasBusyAction}
                  className="justify-start border-slate-200 bg-white/80 text-slate-700 shadow-sm hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-50"
                >
                  {activeAction === "copy_run_link" ? "Copying..." : "Copy Run Link"}
                </Button>
                <Button
                  asChild
                  variant="outline"
                  className="justify-start border-slate-200 bg-white/80 text-slate-700 shadow-sm hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-50"
                >
                  <Link href={getPayrollRunAuditHref(runId)}>View Full Audit Log</Link>
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_22rem] xl:items-start">
            <div className="min-w-0 space-y-6">

          <Card>
            <CardHeader>
              <CardTitle>Run Actions</CardTitle>
              <CardDescription>
                Prepare payslips, close the run, and handle corrections in the right order.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {run.runType === "ADJUSTMENT" ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
                  Adjustment runs start at zero. Add manual payslips to record the correction and
                  update gross and net totals.
                </div>
              ) : null}
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-border bg-muted/40 p-4">
                  <div className="space-y-1">
                    <div className="font-medium">1. Prepare payslips</div>
                    <p className="text-xs text-muted-foreground">
                      Build the run first, then review totals before finalizing.
                    </p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                {run.runType !== "ADJUSTMENT" && run.status === "DRAFT" ? (
                  <Dialog
                    open={generateOpen}
                    onOpenChange={(open) => {
                      setGenerateOpen(open);
                      if (!open) resetGenerateDialog();
                    }}
                  >
                    <DialogTrigger asChild>
                      <Button variant="outline">Generate Payslips</Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-2xl">
                      <DialogHeader>
                        <DialogTitle>Generate Payslips</DialogTitle>
                        <DialogDescription>
                          Review the payroll policy, choose run inputs, and preview the result
                          before saving payslips.
                        </DialogDescription>
                      </DialogHeader>
                      <div className="grid gap-3">
                        <div className="rounded-lg border border-border bg-muted/40 p-4 text-xs text-muted-foreground">
                          <div className="font-medium text-foreground">Payroll policy</div>
                          <div className="mt-1">
                            This run follows the current Ghana payroll settings from HR Settings.
                          </div>
                          <div className="mt-2 grid gap-1 sm:grid-cols-2">
                            <div>
                              Automatic statutory calculation:{" "}
                              {payrollPolicy.autoStatutoryCalc ? "On" : "Off"}
                            </div>
                            <div>Collect PAYE: {payrollPolicy.enablePaye ? "On" : "Off"}</div>
                            <div>
                              Collect employee SSNIT:{" "}
                              {payrollPolicy.enableSsnitEmployee ? "On" : "Off"}
                            </div>
                            <div>
                              Track employer SSNIT:{" "}
                              {payrollPolicy.enableSsnitEmployer ? "On" : "Off"}
                            </div>
                          </div>
                          <div className="mt-2">
                            Default employee SSNIT rate: {payrollPolicy.ssnitEmployeeRate}%
                          </div>
                          {!payrollPolicy.autoStatutoryCalc ? (
                            <div className="mt-2 text-amber-700">
                              Automatic calculation is off. Enter manual tax and SSNIT values for
                              this run or turn it back on in{" "}
                              <Link href="/admin/hr/settings" className="underline">
                                HR Settings
                              </Link>
                              .
                            </div>
                          ) : null}
                        </div>
                        <div className="rounded-lg border p-4 text-sm">
                          <div className="font-medium">Run input</div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Add any flat bonus and choose whether this run uses automatic or manual
                            statutory values.
                          </p>
                          <div className="mt-3 grid gap-3">
                            <Input
                              type="number"
                              placeholder="Bonus (flat amount per employee)"
                              value={generateForm.bonus}
                              onChange={(e) =>
                                setGenerateForm((prev) => ({ ...prev, bonus: e.target.value }))
                              }
                            />
                            <label className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={effectiveAutoCalculation}
                                disabled={!payrollPolicy.autoStatutoryCalc}
                                onChange={(event) =>
                                  setGenerateForm((prev) => ({
                                    ...prev,
                                    autoCalculation: event.target.checked,
                                    ssnitValue:
                                      !event.target.checked && !prev.ssnitValue
                                        ? String(payrollPolicy.ssnitEmployeeRate)
                                        : prev.ssnitValue,
                                  }))
                                }
                              />
                              Use automatic Ghana PAYE and SSNIT calculation
                            </label>
                            {!effectiveAutoCalculation ? (
                              <div className="grid gap-3 sm:grid-cols-2">
                                <Select
                                  value={generateForm.taxMode}
                                  onValueChange={(value) =>
                                    setGenerateForm((prev) => ({
                                      ...prev,
                                      taxMode: value as "percent" | "amount",
                                    }))
                                  }
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="Tax mode" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="percent">Tax by percent</SelectItem>
                                    <SelectItem value="amount">Tax by amount</SelectItem>
                                  </SelectContent>
                                </Select>
                                <Input
                                  type="number"
                                  placeholder={
                                    generateForm.taxMode === "percent"
                                      ? "Tax %"
                                      : "Tax amount"
                                  }
                                  value={generateForm.taxValue}
                                  onChange={(e) =>
                                    setGenerateForm((prev) => ({
                                      ...prev,
                                      taxValue: e.target.value,
                                    }))
                                  }
                                />
                                <Select
                                  value={generateForm.ssnitMode}
                                  onValueChange={(value) =>
                                    setGenerateForm((prev) => ({
                                      ...prev,
                                      ssnitMode: value as "percent" | "amount",
                                    }))
                                  }
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="SSNIT mode" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="percent">SSNIT by percent</SelectItem>
                                    <SelectItem value="amount">SSNIT by amount</SelectItem>
                                  </SelectContent>
                                </Select>
                                <Input
                                  type="number"
                                  placeholder={
                                    generateForm.ssnitMode === "percent"
                                      ? "SSNIT %"
                                      : "SSNIT amount"
                                  }
                                  value={generateForm.ssnitValue}
                                  onChange={(e) =>
                                    setGenerateForm((prev) => ({
                                      ...prev,
                                      ssnitValue: e.target.value,
                                    }))
                                  }
                                />
                              </div>
                            ) : null}
                          </div>
                        </div>
                        <div className="rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
                          {effectiveAutoCalculation
                            ? "Ghana PAYE and SSNIT deductions are calculated automatically from HR settings."
                            : "Manual mode is active. Tax and SSNIT values come from the inputs above for this run only."}
                          <div className="mt-1">
                            Active employees only. New hires and terminations are prorated by days
                            worked.
                          </div>
                        </div>
                        {generatePreview ? (
                          <div className="rounded-lg border border-border bg-muted/40 p-4 text-xs text-muted-foreground">
                            <div className="font-medium text-foreground">Preview result</div>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <div>Employees in preview: {previewRows.length}</div>
                              <div>
                                New payslips: {Number(generatePreview.previewCreated || 0)}
                              </div>
                              <div>
                                Updated payslips: {Number(generatePreview.previewUpdated || 0)}
                              </div>
                              <div>Skipped: {Number(generatePreview.skipped || 0)}</div>
                              <div>Gross total: {formatCurrency(previewGrossTotal)}</div>
                              <div>Net total: {formatCurrency(previewNetTotal)}</div>
                            </div>
                            <div className="mt-2">Preview only. No payslips were saved.</div>
                            {previewRows.length > 0 ? (
                              <div className="mt-3 space-y-1">
                                {previewRows.slice(0, 6).map((row) => (
                                  <div
                                    key={row.employeeId}
                                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-2 py-1"
                                  >
                                    <div>{employeeNameById.get(row.employeeId) || row.employeeId}</div>
                                    <div className="text-right">
                                      Gross {formatCurrency(Number(row.grossPay || 0))} | Net{" "}
                                      {formatCurrency(Number(row.netPay || 0))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="mt-2">
                                No payslips would be created or updated with the current settings.
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          variant="outline"
                          onClick={handlePreviewPayslips}
                          disabled={hasBusyAction}
                        >
                          {activeAction === "preview_generate_payslips"
                            ? "Previewing..."
                            : "Preview"}
                        </Button>
                        <Button onClick={handleGeneratePayslips} disabled={hasBusyAction}>
                          {activeAction === "generate_payslips" ? "Generating..." : "Generate"}
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                ) : run.runType === "ADJUSTMENT" ? (
                  <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                    Adjustment runs use manual payslips only.
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                    Payslip generation is available only while this run is in draft.
                  </div>
                )}
                {run.status === "DRAFT" ? (
                  <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                    <DialogTrigger asChild>
                      <Button variant="secondary">Add Manual Payslip</Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-xl">
                      <DialogHeader>
                        <DialogTitle>Add Payslip</DialogTitle>
                        <DialogDescription>
                          Enter the employee, base pay, deductions, and extra earnings for this
                          manual payroll line.
                        </DialogDescription>
                      </DialogHeader>
                      <div className="grid gap-3">
                        <div className="rounded-lg border p-4">
                          <div className="font-medium">Employee and base pay</div>
                          <div className="mt-3 grid gap-3">
                            <Select
                              value={form.employeeId}
                              onValueChange={(value) =>
                                setForm((prev) => ({ ...prev, employeeId: value }))
                              }
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Select employee" />
                              </SelectTrigger>
                              <SelectContent>
                                {employees.map((employee) => (
                                  <SelectItem key={employee.id} value={employee.id}>
                                    {employee.firstName} {employee.lastName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Input
                              type="number"
                              placeholder="Gross pay"
                              value={form.grossPay}
                              onChange={(e) =>
                                setForm((prev) => ({ ...prev, grossPay: e.target.value }))
                              }
                            />
                            <Input
                              type="number"
                              placeholder="Net pay"
                              value={netOverride ? form.netPay : computedNet().toFixed(2)}
                              readOnly={!netOverride}
                              onChange={(e) =>
                                setForm((prev) => ({ ...prev, netPay: e.target.value }))
                              }
                            />
                            <div className="text-[11px] text-muted-foreground">
                              Net = Gross + bonuses, allowances, and other earnings - tax,
                              pension, and other deductions.
                            </div>
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <input
                                type="checkbox"
                                checked={netOverride}
                                onChange={(e) => setNetOverride(e.target.checked)}
                              />
                              Override net manually
                            </label>
                          </div>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="rounded-lg border p-4">
                            <div className="font-medium">Deductions</div>
                            <div className="mt-3 grid gap-3">
                              <Input
                                type="number"
                                placeholder="Tax"
                                value={form.tax}
                                onChange={(e) =>
                                  setForm((prev) => ({ ...prev, tax: e.target.value }))
                                }
                              />
                              <Input
                                type="number"
                                placeholder="Pension"
                                value={form.pension}
                                onChange={(e) =>
                                  setForm((prev) => ({ ...prev, pension: e.target.value }))
                                }
                              />
                              <Input
                                type="number"
                                placeholder="Other deductions"
                                value={form.otherDeductions}
                                onChange={(e) =>
                                  setForm((prev) => ({
                                    ...prev,
                                    otherDeductions: e.target.value,
                                  }))
                                }
                              />
                            </div>
                          </div>
                          <div className="rounded-lg border p-4">
                            <div className="font-medium">Extra earnings</div>
                            <div className="mt-3 grid gap-3">
                              <Input
                                type="number"
                                placeholder="Bonus"
                                value={form.bonus}
                                onChange={(e) =>
                                  setForm((prev) => ({ ...prev, bonus: e.target.value }))
                                }
                              />
                              <Input
                                type="number"
                                placeholder="Allowances"
                                value={form.allowances}
                                onChange={(e) =>
                                  setForm((prev) => ({ ...prev, allowances: e.target.value }))
                                }
                              />
                              <Input
                                type="number"
                                placeholder="Other earnings"
                                value={form.otherEarnings}
                                onChange={(e) =>
                                  setForm((prev) => ({
                                    ...prev,
                                    otherEarnings: e.target.value,
                                  }))
                                }
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="flex justify-end">
                        <Button onClick={handleCreatePayslip} disabled={hasBusyAction}>
                          {activeAction === "create_payslip" ? "Saving..." : "Save payslip"}
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>
                ) : (
                  <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                    Manual payslips can only be added while the run is in draft.
                  </div>
                )}
                  </div>
                </div>
                <div className="rounded-xl border p-4">
                  <div className="space-y-1">
                    <div className="font-medium">2. Close or settle the run</div>
                    <p className="text-xs text-muted-foreground">
                      Only close the run after totals match and blockers are cleared.
                    </p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {run.status === "DRAFT" ? (
                      <Button
                        onClick={() => openRunActionConfirm("FINALIZE")}
                        disabled={!canFinalizeRun || hasBusyAction}
                      >
                        {activeAction === "status_finalized" ? "Finalizing..." : "Finalize Run"}
                      </Button>
                    ) : null}
                    {run.status === "DRAFT" ? (
                      <Button
                        variant="outline"
                        onClick={() => openRunActionConfirm("CANCEL")}
                        disabled={hasBusyAction}
                      >
                        {activeAction === "status_cancelled" ? "Cancelling..." : "Cancel Draft"}
                      </Button>
                    ) : null}
                    {(run.status === "FINALIZED" || run.status === "PAID") && !run.expense ? (
                      <Button
                        variant="outline"
                        onClick={() => openRunActionConfirm("CREATE_EXPENSE")}
                        disabled={hasBusyAction}
                      >
                        {activeAction === "create_expense_entry"
                          ? "Creating..."
                          : "Create Expense Entry"}
                      </Button>
                    ) : null}
                    {run.status === "FINALIZED" ? (
                      <Button
                        variant="outline"
                        onClick={() => openRunActionConfirm("MARK_PAID")}
                        disabled={!canMarkPaid || hasBusyAction}
                      >
                        {activeAction === "status_paid" ? "Saving..." : "Mark Run Paid"}
                      </Button>
                    ) : null}
                    {(run.status === "FINALIZED" || run.status === "PAID") &&
                    run.runType !== "ADJUSTMENT" ? (
                      <Dialog open={adjustmentOpen} onOpenChange={setAdjustmentOpen}>
                        <DialogTrigger asChild>
                          <Button variant="secondary">Create Adjustment Run</Button>
                        </DialogTrigger>
                        <DialogContent className="max-w-lg">
                          <DialogHeader>
                            <DialogTitle>Create Adjustment Run</DialogTitle>
                          </DialogHeader>
                          <div className="grid gap-3 text-sm">
                            <p className="text-muted-foreground">
                              This keeps the finalized payroll intact and opens a new draft run for
                              corrections. Add notes for the audit trail.
                            </p>
                            <Textarea
                              placeholder="Reason for adjustment (optional)"
                              value={adjustmentNote}
                              onChange={(e) => setAdjustmentNote(e.target.value)}
                            />
                          </div>
                          <div className="flex justify-end">
                            <Button onClick={handleCreateAdjustment} disabled={hasBusyAction}>
                              {activeAction === "create_adjustment"
                                ? "Creating..."
                                : "Create adjustment"}
                            </Button>
                          </div>
                        </DialogContent>
                      </Dialog>
                    ) : (
                      <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                        Adjustment runs become available after a regular run is finalized.
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {actionWarnings.length ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {actionWarnings.map((message) => (
                    <div
                      key={message}
                      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"
                    >
                      {message}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-700">
                  This run has no action blockers right now.
                </div>
              )}
            </CardContent>
          </Card>

          <Dialog
            open={Boolean(pendingRunAction)}
            onOpenChange={(open) => {
              if (!open) setPendingRunAction(null);
            }}
          >
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{pendingRunAction?.title || "Confirm payroll action"}</DialogTitle>
                <DialogDescription>
                  {pendingRunAction?.description || "Review this payroll action before continuing."}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 text-sm text-muted-foreground">
                <div>
                  Period: <span className="font-medium text-foreground">{periodLabel}</span>
                </div>
                <div>
                  Payslips:{" "}
                  <span className="font-medium text-foreground">{allPayslips.length}</span>
                </div>
                <div>
                  Gross / Net:{" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(runGross)} / {formatCurrency(runNet)}
                  </span>
                </div>
                {pendingRunAction?.kind === "CANCEL" ? (
                  <div>This will remove all payslips currently attached to this draft run.</div>
                ) : null}
                {pendingRunAction?.kind === "FINALIZE" && !run.expense ? (
                  <div>A linked payroll expense entry will also be created during finalize.</div>
                ) : null}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setPendingRunAction(null)}>
                  Back
                </Button>
                <Button onClick={confirmPendingRunAction} disabled={hasBusyAction}>
                  {pendingRunAction?.confirmLabel || "Confirm"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>

          <Card>
            <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <CardTitle>Employee Paystub Breakdown</CardTitle>
                <CardDescription>
                  Current period with YTD totals per employee.
                </CardDescription>
              </div>
              <div className="self-start rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                {filteredAndSortedPayslips.length} matching payslip(s)
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="sticky top-3 z-10 rounded-xl border border-border bg-background/95 p-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/85">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="h-8 w-full sm:w-56"
                    placeholder="Search employee name or id"
                    value={payslipSearch}
                    onChange={(e) => {
                      setPayslipSearch(e.target.value);
                      setPayslipPage(1);
                    }}
                  />
                  <Select
                    value={payslipSort}
                    onValueChange={(value) => {
                      setPayslipSort(value as PayrollPayslipSort);
                      setPayslipPage(1);
                    }}
                  >
                    <SelectTrigger className="h-8 w-full sm:w-44">
                      <SelectValue placeholder="Sort" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="employee_asc">Name (A-Z)</SelectItem>
                      <SelectItem value="employee_desc">Name (Z-A)</SelectItem>
                      <SelectItem value="gross_desc">Gross (high-low)</SelectItem>
                      <SelectItem value="gross_asc">Gross (low-high)</SelectItem>
                      <SelectItem value="net_desc">Net (high-low)</SelectItem>
                      <SelectItem value="net_asc">Net (low-high)</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={String(payslipPageSize)}
                    onValueChange={(value) => {
                      setPayslipPageSize(Number(value));
                      setPayslipPage(1);
                    }}
                  >
                    <SelectTrigger className="h-8 w-full sm:w-28">
                      <SelectValue placeholder="Rows" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10 rows</SelectItem>
                      <SelectItem value="25">25 rows</SelectItem>
                      <SelectItem value="50">50 rows</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={handleExportFilteredPayslipsCsv}
                    disabled={hasBusyAction}
                    className="w-full sm:w-auto"
                  >
                    {activeAction === "export_filtered_csv" ? "Exporting..." : "Export Filtered CSV"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={clearPaystubFilters}
                    disabled={hasBusyAction}
                    className="w-full sm:w-auto"
                  >
                    Clear Filters
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCopyExportFiltersLink}
                    disabled={hasBusyAction}
                    className="w-full sm:w-auto"
                  >
                    {activeAction === "copy_export_filters_link"
                      ? "Copying..."
                      : "Copy Export Filters Link"}
                  </Button>
                </div>
              </div>
              <div className="space-y-3 md:hidden">
                {filteredAndSortedPayslips.length ? (
                  payslipPageRows.map((slip) => (
                    <div key={slip.id} className="rounded-lg border p-3 text-sm">
                      {(() => {
                        const missingFields = missingBankFieldsByPayslipId.get(slip.id) || [];
                        return (
                          <>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="font-medium">
                            {slip.employee.firstName} {slip.employee.lastName}
                          </div>
                          <div className="break-all text-xs text-muted-foreground">{slip.employeeId}</div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Badge variant={missingFields.length ? "warning" : "outline"}>
                              {missingFields.length ? "Bank details missing" : "Bank ready"}
                            </Badge>
                          </div>
                        </div>
                        <div className="flex w-full flex-col gap-2 sm:w-auto">
                          <Button asChild size="sm" variant="secondary" className="w-full sm:w-auto">
                            <Link href={`/admin/hr/paystubs/${slip.id}`}>Open paystub</Link>
                          </Button>
                          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
                            <Link href={`/admin/hr/staff/${slip.employeeId}`}>Open staff profile</Link>
                          </Button>
                        </div>
                      </div>
                      {missingFields.length ? (
                        <div className="mt-3 break-words rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                          Missing bank details: {missingFields.join(", ")}
                        </div>
                      ) : null}
                      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                        <div>
                          Current gross:{" "}
                          <span className="font-medium">
                            {formatCurrency(Number(slip.grossPay || 0))}
                          </span>
                        </div>
                        <div>
                          Current net:{" "}
                          <span className="font-medium">
                            {formatCurrency(Number(slip.netPay || 0))}
                          </span>
                        </div>
                        <div>
                          Current tax:{" "}
                          <span className="font-medium">
                            {formatCurrency(getLineItem(slip, "tax"))}
                          </span>
                        </div>
                        <div>
                          Current pension:{" "}
                          <span className="font-medium">
                            {formatCurrency(getLineItem(slip, "pension"))}
                          </span>
                        </div>
                        <div>
                          YTD gross:{" "}
                          <span className="font-medium">
                            {formatCurrency(Number(run.ytdTotals?.[slip.employeeId]?.gross || 0))}
                          </span>
                        </div>
                        <div>
                          YTD net:{" "}
                          <span className="font-medium">
                            {formatCurrency(Number(run.ytdTotals?.[slip.employeeId]?.net || 0))}
                          </span>
                        </div>
                        <div>
                          YTD tax:{" "}
                          <span className="font-medium">
                            {formatCurrency(Number(run.ytdTotals?.[slip.employeeId]?.tax || 0))}
                          </span>
                        </div>
                        <div>
                          YTD pension:{" "}
                          <span className="font-medium">
                            {formatCurrency(Number(run.ytdTotals?.[slip.employeeId]?.pension || 0))}
                          </span>
                        </div>
                      </div>
                          </>
                        );
                      })()}
                    </div>
                  ))
                ) : (
                  <div className="rounded-lg border px-3 py-6 text-center text-sm">
                    <div className="font-medium text-foreground">
                      No payslips match this filter.
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      Try clearing the search or switching back to the default sort.
                    </div>
                    {hasFilteredPayslipView ? (
                      <div className="mt-3">
                        <Button size="sm" variant="outline" onClick={clearPaystubFilters}>
                          Clear Filters
                        </Button>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead>Bank Export</TableHead>
                      <TableHead>Current Gross</TableHead>
                      <TableHead>Current Net</TableHead>
                      <TableHead>Current Tax</TableHead>
                      <TableHead>Current Pension</TableHead>
                      <TableHead>YTD Gross</TableHead>
                      <TableHead>YTD Net</TableHead>
                      <TableHead>YTD Tax</TableHead>
                      <TableHead>YTD Pension</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAndSortedPayslips.length ? (
                      payslipPageRows.map((slip) => {
                        const missingFields = missingBankFieldsByPayslipId.get(slip.id) || [];
                        return (
                        <TableRow key={slip.id}>
                          <TableCell>
                            <div className="space-y-1">
                              <div>
                                {slip.employee.firstName} {slip.employee.lastName}
                              </div>
                              <div className="text-xs text-muted-foreground">{slip.employeeId}</div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              <Badge variant={missingFields.length ? "warning" : "outline"}>
                                {missingFields.length ? "Bank details missing" : "Bank ready"}
                              </Badge>
                              {missingFields.length ? (
                                <div className="max-w-56 text-xs text-muted-foreground">
                                  {missingFields.join(", ")}
                                </div>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell>{formatCurrency(Number(slip.grossPay || 0))}</TableCell>
                          <TableCell>{formatCurrency(Number(slip.netPay || 0))}</TableCell>
                          <TableCell>{formatCurrency(getLineItem(slip, "tax"))}</TableCell>
                          <TableCell>{formatCurrency(getLineItem(slip, "pension"))}</TableCell>
                          <TableCell>
                            {formatCurrency(Number(run.ytdTotals?.[slip.employeeId]?.gross || 0))}
                          </TableCell>
                          <TableCell>
                            {formatCurrency(Number(run.ytdTotals?.[slip.employeeId]?.net || 0))}
                          </TableCell>
                          <TableCell>
                            {formatCurrency(Number(run.ytdTotals?.[slip.employeeId]?.tax || 0))}
                          </TableCell>
                          <TableCell>
                            {formatCurrency(Number(run.ytdTotals?.[slip.employeeId]?.pension || 0))}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-2">
                              <Button asChild size="sm" variant="secondary">
                                <Link href={`/admin/hr/paystubs/${slip.id}`}>Open paystub</Link>
                              </Button>
                              <Button asChild size="sm" variant="outline">
                                <Link href={`/admin/hr/staff/${slip.employeeId}`}>Open staff profile</Link>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        );
                      })
                    ) : (
                      <TableRow>
                        <TableCell colSpan={11} className="py-6 text-center text-sm">
                          <div className="font-medium text-foreground">
                            No payslips match this filter.
                          </div>
                          <div className="mt-1 text-muted-foreground">
                            Try clearing the search or changing the sort to see more payslips.
                          </div>
                          {hasFilteredPayslipView ? (
                            <div className="mt-3">
                              <Button size="sm" variant="outline" onClick={clearPaystubFilters}>
                                Clear Filters
                              </Button>
                            </div>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <div className="break-words">
                  Page {safePayslipPage} of {payslipTotalPages} | {filteredAndSortedPayslips.length} match(es)
                </div>
                <div className="flex w-full gap-2 sm:w-auto">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPayslipPage((current) => Math.max(1, current - 1))}
                    disabled={safePayslipPage <= 1}
                    className="flex-1 sm:flex-none"
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setPayslipPage((current) => Math.min(payslipTotalPages, current + 1))
                    }
                    disabled={safePayslipPage >= payslipTotalPages}
                    className="flex-1 sm:flex-none"
                  >
                    Next
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Missing Bank Details</CardTitle>
              <CardDescription>
                Resolve export blockers before sending the bank file.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {missingBankPayslips.length === 0 ? (
                <div className="space-y-2">
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs text-emerald-700">
                    All employees in this run have the bank details needed for export.
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/admin/hr/staff">Go to Staff Directory</Link>
                  </Button>
                </div>
              ) : (
                <>
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-700">
                    {missingBankPayslips.length} employee(s) need bank name, bank code, bank
                    branch, account name, and account number before bank export can succeed.
                  </div>
                  <div className="space-y-2">
                    {visibleMissingBankPayslips.map((slip) => (
                      <div
                        key={slip.id}
                        className="rounded-lg border px-3 py-3"
                      >
                        <div className="space-y-2">
                          <div>
                            <div className="font-medium">
                              {slip.employee.firstName} {slip.employee.lastName}
                            </div>
                            <div className="break-words text-xs text-muted-foreground">
                              Missing: {slip.missingFields.join(", ")}
                            </div>
                          </div>
                          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
                            <Link href={`/admin/hr/staff/${slip.employeeId}`}>
                              Update staff bank details
                            </Link>
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {missingBankPayslips.length > missingBankVisibleLimit ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShowAllMissingBankRows((current) => !current)}
                    >
                      {showAllMissingBankRows ? "Show fewer employees" : "Show all missing employees"}
                    </Button>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>

            </div>

            <div className="min-w-0 space-y-6">

          <Card>
            <CardHeader>
              <CardTitle>Run Health</CardTitle>
              <CardDescription>
                Check totals, export readiness, and settlement status before closing the run.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div
                className={`rounded-lg border px-4 py-3 ${
                  hasIntegrityMismatch
                    ? "border-amber-200 bg-amber-50 text-amber-700"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700"
                }`}
              >
                <div className="font-medium">
                  {hasIntegrityMismatch ? "Totals need attention" : "Run totals are aligned"}
                </div>
                <div className="mt-1 text-xs">
                  {hasIntegrityMismatch
                    ? `Mismatch detected. Gross delta ${formatCurrency(grossDelta)}, net delta ${formatCurrency(netDelta)}.`
                    : "Run totals match the summed payslips."}
                </div>
              </div>
              <div className="grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-1">
                <div className="rounded-lg border px-3 py-3">
                  <div className="text-muted-foreground">Payslip gross total</div>
                  <div className="mt-1 font-medium text-foreground">
                    {formatCurrency(payslipGrossTotal)}
                  </div>
                </div>
                <div className="rounded-lg border px-3 py-3">
                  <div className="text-muted-foreground">Run gross total</div>
                  <div className="mt-1 font-medium text-foreground">
                    {formatCurrency(runGross)}
                  </div>
                </div>
                <div className="rounded-lg border px-3 py-3">
                  <div className="text-muted-foreground">Payslip net total</div>
                  <div className="mt-1 font-medium text-foreground">
                    {formatCurrency(payslipNetTotal)}
                  </div>
                </div>
                <div className="rounded-lg border px-3 py-3">
                  <div className="text-muted-foreground">Run net total</div>
                  <div className="mt-1 font-medium text-foreground">
                    {formatCurrency(runNet)}
                  </div>
                </div>
                <div className="rounded-lg border px-3 py-3">
                  <div className="text-muted-foreground">Employer SSNIT total</div>
                  <div className="mt-1 font-medium text-foreground">
                    {formatCurrency(payslipEmployerSsnitTotal)}
                  </div>
                </div>
                <div className="rounded-lg border px-3 py-3">
                  <div className="text-muted-foreground">Expense entry</div>
                  <div className="mt-1 font-medium text-foreground">
                    {run.expense ? "Created" : "Not created yet"}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {hasRelatedAdjustments ? (
            <Card>
              <CardHeader>
                <CardTitle>Related Adjustment Runs</CardTitle>
                <CardDescription>
                  Review correction runs linked to this payroll period.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {(run.adjustments?.length || 0) > 0 ? (
                  run.adjustments?.map((adjustment) => (
                    <div
                      key={adjustment.id}
                      className="rounded-lg border bg-slate-50 px-3 py-3"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 space-y-1">
                          <div className="font-medium">
                            {new Date(adjustment.periodStart).toLocaleDateString()} -{" "}
                            {new Date(adjustment.periodEnd).toLocaleDateString()}
                          </div>
                          <div className="break-words text-xs text-muted-foreground">
                            {toPlainAuditLabel(adjustment.status)} | Gross{" "}
                            {formatCurrency(Number(adjustment.totalGross || 0))} | Net{" "}
                            {formatCurrency(Number(adjustment.totalNet || 0))}
                          </div>
                          {adjustment.adjustmentNote ? (
                            <div className="break-words text-xs text-muted-foreground">
                              Note: {adjustment.adjustmentNote}
                            </div>
                          ) : null}
                        </div>
                        <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
                          <Link href={`/admin/hr/payroll/${adjustment.id}`}>Open adjustment</Link>
                        </Button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-xs text-muted-foreground">
                    {run.adjustmentsCount} adjustment run(s) exist for this payroll period.
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Recent Payroll Activity</CardTitle>
              <CardDescription>
                The latest run actions and exports for this payroll record.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {isAuditLoading ? (
                <div className="text-xs text-muted-foreground">Loading recent payroll activity...</div>
              ) : auditRows.length === 0 ? (
                <div className="text-xs text-muted-foreground">
                  No audit entries found for this payroll run yet.
                </div>
                  ) : (
                    <div className="space-y-2">
                      {auditRows.map((row) => {
                        const auditChips = getPayrollAuditChips(row);
                        return (
                          <div key={row.id} className="rounded-lg border px-3 py-3">
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <div className="break-words font-medium">{getPayrollAuditTitle(row)}</div>
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                {row.meta?.status ? (
                                  <span
                                    className={`rounded-full border px-2 py-0.5 font-medium ${getAuditStatusTone(row.meta.status)}`}
                                  >
                                    {row.meta.status}
                                  </span>
                                ) : null}
                                <span className="text-muted-foreground">
                                  {new Date(row.createdAt).toLocaleString()}
                                </span>
                              </div>
                            </div>
                            <div className="mt-1 break-words text-xs text-muted-foreground">
                              Actor: {row.actor?.name || row.actor?.email || row.actor?.id || "System"}
                              {row.actor?.role ? ` (${row.actor.role})` : ""}
                            </div>
                            {row.meta?.section || row.meta?.operation ? (
                              <div className="mt-1 break-words text-xs text-muted-foreground">
                                {row.meta?.section ? `Section: ${toPlainAuditLabel(row.meta.section)}` : ""}
                                {row.meta?.section && row.meta?.operation ? " | " : ""}
                                {row.meta?.operation ? `Operation: ${toPlainAuditLabel(row.meta.operation)}` : ""}
                              </div>
                            ) : null}
                            {auditChips.length ? (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {auditChips.map((chip) => (
                                  <span
                                    key={`${row.id}-${chip.label}-${chip.value}`}
                                    className={`max-w-full break-all rounded-full border px-2 py-1 text-[11px] ${
                                      chip.tone === "warning"
                                        ? "border-amber-200 bg-amber-50 text-amber-700"
                                        : "border-slate-200 bg-slate-50 text-slate-700"
                                    }`}
                                  >
                                    <span className="font-medium">{chip.label}:</span> {chip.value}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            <div className="mt-2 break-words text-xs text-muted-foreground">
                              {row.meta?.resultSummary || "No summary recorded."}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
          </Card>

          </div>
          </div>
        </>
      )}
    </section>
  );
}

