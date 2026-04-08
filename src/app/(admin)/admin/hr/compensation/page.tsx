"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import Link from "next/link";

type Employee = {
  id: string;
  firstName: string;
  lastName: string;
};

type Compensation = {
  id: string;
  employeeId: string;
  baseSalary: number | string;
  allowances: number | string;
  deductions: number | string;
  bonus?: number | string;
  currency: string;
  effectiveDate: string;
  status?: "DRAFT" | "PENDING" | "ACTIVE";
};
type CompensationStatusFilter = "ALL" | "DRAFT" | "PENDING" | "ACTIVE";

type PayrollRun = {
  id: string;
  periodStart: string;
  periodEnd: string;
  createdAt?: string;
  updatedAt?: string;
  status: "DRAFT" | "FINALIZED" | "PAID" | "CANCELLED";
  runType?: "REGULAR" | "ADJUSTMENT";
  adjustmentForId?: string | null;
  adjustmentNote?: string | null;
  totalGross: number | string;
  totalNet: number | string;
  payslipCount?: number;
  missingBankDetailsCount?: number;
  firstMissingBankEmployeeId?: string | null;
  expense?: { id: string } | null;
};

type MonthlyStatutorySummary = {
  monthKey: string;
  runCount: number;
  payslipCount: number;
  employeeCount: number;
  totalGross: number;
  totalNet: number;
  payeTax: number;
  ssnitEmployee: number;
  ssnitEmployer: number;
  otherDeductions: number;
  remittance: {
    payeStatus: "PENDING" | "REMITTED";
    ssnitStatus: "PENDING" | "REMITTED";
    payeRemittedAt: string | null;
    ssnitRemittedAt: string | null;
    payeReference: string | null;
    ssnitReference: string | null;
  };
};

type HrSettingsResponse = {
  values?: Record<string, unknown>;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());
const COMP_PAGE_SIZES = [10, 25, 50] as const;

export default function AdminHrCompensationPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [payrollDialogOpen, setPayrollDialogOpen] = useState(false);
  const [monthlyDialogOpen, setMonthlyDialogOpen] = useState(false);
  const [checklistOpen, setChecklistOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingComp, setPendingComp] = useState<Compensation | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [pendingCancelRun, setPendingCancelRun] = useState<PayrollRun | null>(null);
  const [statusConfirmOpen, setStatusConfirmOpen] = useState(false);
  const [pendingStatusAction, setPendingStatusAction] = useState<{
    run: PayrollRun;
    status: "FINALIZED" | "PAID";
    createExpense: boolean;
  } | null>(null);
  const checklistStorageKey = "hr-compensation-checklist-open";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(checklistStorageKey);
    if (stored === "false") setChecklistOpen(false);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(checklistStorageKey, String(checklistOpen));
  }, [checklistOpen]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    baseSalary: "",
    allowances: "",
    deductions: "",
    bonus: "",
    effectiveDate: "",
    currency: "GHS",
  });
  const [form, setForm] = useState({
    employeeId: "",
    baseSalary: "",
    allowances: "",
    deductions: "",
    bonus: "",
    currency: "GHS",
    effectiveDate: "",
  });
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [payrollForm, setPayrollForm] = useState({
    periodStart: "",
    periodEnd: "",
  });
  const [monthlyForm, setMonthlyForm] = useState({
    year: new Date().getFullYear().toString(),
    month: (new Date().getMonth() + 1).toString(),
    bonus: "",
  });
  const [previewResult, setPreviewResult] = useState<{
    previewRows?: Array<{ employeeId: string; grossPay: number; netPay: number; lineItems?: Record<string, number> }>;
    skipped?: number;
  } | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);
  const [showDraftsMissingBankOnly, setShowDraftsMissingBankOnly] = useState(false);
  const [selectedPendingCompIds, setSelectedPendingCompIds] = useState<string[]>([]);
  const [compStatusFilter, setCompStatusFilter] = useState<CompensationStatusFilter>("ALL");
  const [compSearch, setCompSearch] = useState("");
  const [compPage, setCompPage] = useState(1);
  const [compPageSize, setCompPageSize] = useState<(typeof COMP_PAGE_SIZES)[number]>(25);
  const [isExportingCompCsv, setIsExportingCompCsv] = useState(false);
  const [remittanceYear, setRemittanceYear] = useState(new Date().getFullYear().toString());
  const [remittanceMonth, setRemittanceMonth] = useState((new Date().getMonth() + 1).toString());
  const remittanceYearNum = Number(remittanceYear);
  const remittanceMonthNum = Number(remittanceMonth);
  const remittanceQueryEnabled =
    Number.isFinite(remittanceYearNum) &&
    remittanceYearNum >= 2000 &&
    remittanceYearNum <= 2100 &&
    Number.isFinite(remittanceMonthNum) &&
    remittanceMonthNum >= 1 &&
    remittanceMonthNum <= 12;

  const employeesQuery = useQuery({
    queryKey: ["admin", "hr", "employees"],
    queryFn: () => fetcher("/api/admin/hr/employees"),
  });
  const compensationQuery = useQuery({
    queryKey: [
      "admin",
      "hr",
      "compensation",
      compStatusFilter,
      compSearch.trim(),
      compPage,
      compPageSize,
    ],
    queryFn: () => {
      const query = new URLSearchParams({
        status: compStatusFilter,
        page: String(compPage),
        pageSize: String(compPageSize),
      });
      const trimmedSearch = compSearch.trim();
      if (trimmedSearch) query.set("search", trimmedSearch);
      return fetcher(`/api/admin/hr/compensation?${query.toString()}`);
    },
  });
  const pendingCompSummaryQuery = useQuery({
    queryKey: ["admin", "hr", "compensation", "summary", "pending"],
    queryFn: () => fetcher("/api/admin/hr/compensation?status=PENDING&page=1&pageSize=1"),
  });
  const payrollQuery = useQuery({
    queryKey: ["admin", "hr", "payroll"],
    queryFn: () => fetcher("/api/admin/hr/payroll"),
  });
  const cronStatusQuery = useQuery({
    queryKey: ["admin", "hr", "cron-status"],
    queryFn: () => fetcher("/api/admin/hr/payroll/cron/status"),
  });
  const payrollSettingsQuery = useQuery<HrSettingsResponse>({
    queryKey: ["admin", "hr", "settings", "payroll-policy-summary"],
    queryFn: () =>
      fetcher(
        "/api/admin/hr/settings?keys=hr.payroll.ghana.autoStatutoryCalc,hr.payroll.ghana.enablePaye,hr.payroll.ghana.enableSsnitEmployee,hr.payroll.ghana.enableSsnitEmployer",
      ),
  });
  const statutorySummaryQuery = useQuery({
    queryKey: ["admin", "hr", "payroll", "statutory-summary", remittanceYear, remittanceMonth],
    queryFn: () =>
      fetcher(
        `/api/admin/hr/payroll/statutory/summary?year=${encodeURIComponent(remittanceYear)}&month=${encodeURIComponent(remittanceMonth)}`,
      ),
    enabled: remittanceQueryEnabled,
  });

  const employeesData = employeesQuery.data;
  const compensationData = compensationQuery.data;
  const payrollData = payrollQuery.data;
  const cronStatus = cronStatusQuery.data;
  const statutorySummary = statutorySummaryQuery.data as MonthlyStatutorySummary | undefined;
  const employees = useMemo(
    () => (Array.isArray(employeesData?.rows) ? (employeesData.rows as Employee[]) : []),
    [employeesData],
  );
  const compensations = useMemo(
    () => (Array.isArray(compensationData?.rows) ? (compensationData.rows as Compensation[]) : []),
    [compensationData],
  );
  const payrollRuns = useMemo(
    () => (Array.isArray(payrollData?.rows) ? (payrollData.rows as PayrollRun[]) : []),
    [payrollData],
  );
  const visibleRuns = payrollRuns.filter((run) => {
    if (!showCancelled && run.status === "CANCELLED") return false;
    if (showDraftsMissingBankOnly) {
      return run.status === "DRAFT" && Number(run.missingBankDetailsCount || 0) > 0;
    }
    return true;
  });
  const pendingCompensations = compensations.filter(
    (comp) => (comp.status || "ACTIVE") === "PENDING",
  );
  const pendingCompensationCount = Number(pendingCompSummaryQuery.data?.total || 0);
  const draftRunCount = payrollRuns.filter((run) => run.status === "DRAFT").length;
  const latestRun = payrollRuns[0] || null;
  const riskyDraftRuns = payrollRuns.filter((run) => {
    if (run.status !== "DRAFT") return false;
    const hasPayslips = Number(run.payslipCount || 0) > 0;
    const hasTotals = Number(run.totalGross || 0) > 0 || Number(run.totalNet || 0) > 0;
    return hasPayslips || hasTotals;
  });
  const cronEnabled = Boolean(cronStatus?.enabled);
  const payrollPolicyValues = payrollSettingsQuery.data?.values || {};
  const policyAutoCalculation = payrollPolicyValues["hr.payroll.ghana.autoStatutoryCalc"] !== false;
  const policyEnablePaye = payrollPolicyValues["hr.payroll.ghana.enablePaye"] !== false;
  const policyEnableSsnitEmployee =
    payrollPolicyValues["hr.payroll.ghana.enableSsnitEmployee"] !== false;
  const policyEnableSsnitEmployer =
    payrollPolicyValues["hr.payroll.ghana.enableSsnitEmployer"] !== false;
  const remittanceAuditHref = `/admin/audit?sourcePage=admin%2Fhr%2Fpayroll%2Fremittance&entityType=HRPayrollRemittance&entityId=${encodeURIComponent(statutorySummary?.monthKey || `${remittanceYear}-${String(remittanceMonth).padStart(2, "0")}`)}`;
  const compensationAuditHref = "/admin/audit?sourcePage=admin%2Fhr%2Fcompensation";

  const lastRefreshedLabel = useMemo(() => {
    const points = [
      employeesQuery.dataUpdatedAt,
      compensationQuery.dataUpdatedAt,
      payrollQuery.dataUpdatedAt,
      cronStatusQuery.dataUpdatedAt,
      statutorySummaryQuery.dataUpdatedAt,
    ].filter((v) => Number(v) > 0) as number[];
    if (points.length === 0) return null;
    return new Date(Math.max(...points)).toLocaleString();
  }, [
    compensationQuery.dataUpdatedAt,
    cronStatusQuery.dataUpdatedAt,
    employeesQuery.dataUpdatedAt,
    payrollQuery.dataUpdatedAt,
    statutorySummaryQuery.dataUpdatedAt,
  ]);

  useEffect(() => {
    setSelectedPendingCompIds((current) =>
      current.filter((id) =>
        compensations.some((comp) => comp.id === id && (comp.status || "ACTIVE") === "PENDING"),
      ),
    );
  }, [compensations]);
  useEffect(() => {
    setCompPage(1);
  }, [compSearch, compStatusFilter, compPageSize]);
  const payrollDateInvalid =
    Boolean(payrollForm.periodStart) &&
    Boolean(payrollForm.periodEnd) &&
    new Date(payrollForm.periodEnd).getTime() < new Date(payrollForm.periodStart).getTime();

  const handleCreateCompensation = async () => {
    try {
      if (!form.employeeId) {
        toast.error("Select an employee before saving compensation.");
        return;
      }
      const baseSalary = Number(form.baseSalary || 0);
      const allowances = Number(form.allowances || 0);
      const deductions = Number(form.deductions || 0);
      const bonus = Number(form.bonus || 0);
      if (baseSalary <= 0) {
        toast.error("Base salary must be greater than 0.");
        return;
      }
      if ([allowances, deductions, bonus].some((value) => value < 0)) {
        toast.error("Allowances, deductions, and bonus cannot be negative.");
        return;
      }
      const payload = {
        employeeId: form.employeeId,
        baseSalary,
        allowances,
        deductions,
        bonus,
        currency: form.currency,
        effectiveDate: form.effectiveDate ? new Date(form.effectiveDate).toISOString() : undefined,
        status: requiresApproval ? "PENDING" : "ACTIVE",
      };
      const res = await fetch("/api/admin/hr/compensation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to add compensation.");
        return;
      }
      toast.success("Compensation saved.");
      setDialogOpen(false);
      setForm({
        employeeId: "",
        baseSalary: "",
        allowances: "",
        deductions: "",
        bonus: "",
        currency: "GHS",
        effectiveDate: "",
      });
      setRequiresApproval(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "compensation"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "compensation", "summary", "pending"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to add compensation.");
    }
  };

  const handleCreatePayroll = async () => {
    try {
      if (!payrollForm.periodStart || !payrollForm.periodEnd) {
        toast.error("Select both period start and period end.");
        return;
      }
      if (payrollDateInvalid) {
        toast.error("Period end cannot be earlier than period start.");
        return;
      }
      const payload = {
        periodStart: payrollForm.periodStart
          ? new Date(payrollForm.periodStart).toISOString()
          : "",
        periodEnd: payrollForm.periodEnd ? new Date(payrollForm.periodEnd).toISOString() : "",
      };
      const res = await fetch("/api/admin/hr/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (res.status === 409 && err?.overlap) {
          const overlapStart = err.overlap.periodStart
            ? new Date(err.overlap.periodStart).toLocaleDateString()
            : "";
          const overlapEnd = err.overlap.periodEnd
            ? new Date(err.overlap.periodEnd).toLocaleDateString()
            : "";
          toast.error(
            `Overlapping payroll period: ${overlapStart} - ${overlapEnd} (${err.overlap.status}).`,
          );
          return;
        }
        toast.error(err.error || "Failed to create payroll run.");
        return;
      }
      toast.success("Payroll run created.");
      setPayrollDialogOpen(false);
      setPayrollForm({
        periodStart: "",
        periodEnd: "",
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to create payroll run.");
    }
  };

  const handleGenerateMonthly = async () => {
    try {
      const payload = {
        year: Number(monthlyForm.year),
        month: Number(monthlyForm.month),
        bonus: Number(monthlyForm.bonus || 0),
      };
      const res = await fetch("/api/admin/hr/payroll/generate-monthly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to generate monthly paystubs.");
        return;
      }
      toast.success(
        `Generated ${body.created ?? 0}, updated ${body.updated ?? 0}, skipped ${body.skipped ?? 0}.`,
      );
      setMonthlyDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to generate monthly paystubs.");
    }
  };

  const startEdit = (comp: Compensation) => {
    setPendingComp(comp);
    setConfirmOpen(true);
  };

  const confirmEdit = () => {
    if (!pendingComp) {
      setConfirmOpen(false);
      return;
    }
    const comp = pendingComp;
    setEditingId(comp.id);
    setEditForm({
      baseSalary: String(comp.baseSalary ?? ""),
      allowances: String(comp.allowances ?? ""),
      deductions: String(comp.deductions ?? ""),
      bonus: String(comp.bonus ?? ""),
      effectiveDate: comp.effectiveDate
        ? new Date(comp.effectiveDate).toISOString().slice(0, 10)
        : "",
      currency: comp.currency || "GHS",
    });
    setConfirmOpen(false);
    setPendingComp(null);
  };

  const handleUpdateCompensation = async () => {
    if (!editingId) return;
    try {
      const baseSalary = Number(editForm.baseSalary || 0);
      const allowances = Number(editForm.allowances || 0);
      const deductions = Number(editForm.deductions || 0);
      const bonus = Number(editForm.bonus || 0);
      if (baseSalary <= 0) {
        toast.error("Base salary must be greater than 0.");
        return;
      }
      if ([allowances, deductions, bonus].some((value) => value < 0)) {
        toast.error("Allowances, deductions, and bonus cannot be negative.");
        return;
      }
      const payload = {
        baseSalary,
        allowances,
        deductions,
        bonus,
        currency: editForm.currency,
        effectiveDate: editForm.effectiveDate
          ? new Date(editForm.effectiveDate).toISOString()
          : "",
      };
      const res = await fetch(`/api/admin/hr/compensation/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update compensation.");
        return;
      }
      toast.success("Compensation updated.");
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "compensation"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "compensation", "summary", "pending"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update compensation.");
    }
  };

  const handleUpdateCompStatus = async (
    compId: string,
    status: "DRAFT" | "PENDING" | "ACTIVE"
  ) => {
    try {
      const res = await fetch(`/api/admin/hr/compensation/${compId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update status.");
        return;
      }
      toast.success("Compensation status updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "compensation"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "compensation", "summary", "pending"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update status.");
    }
  };

  const handleUpdatePayrollStatus = async (
    runId: string,
    status: "FINALIZED" | "PAID" | "CANCELLED",
    createExpense: boolean
  ) => {
    if (!runId) {
      toast.error("Missing payroll run id.");
      return;
    }
    try {
      const res = await fetch(`/api/admin/hr/payroll/${runId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, createExpense }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update payroll status.");
        return;
      }
      toast.success("Payroll updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "payroll"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update payroll status.");
    }
  };

  const handleBulkApprovePending = async () => {
    if (selectedPendingCompIds.length === 0) {
      toast.error("Select at least one pending compensation record.");
      return;
    }
    try {
      const res = await fetch("/api/admin/hr/compensation/bulk-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedPendingCompIds }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to run bulk approval.");
        return;
      }
      if (Number(body.approvedCount || 0) > 0) {
        toast.success(`Approved ${body.approvedCount} compensation record(s).`);
      }
      if (Number(body.skippedCount || 0) > 0) {
        const notFound = Number(body?.skippedBreakdown?.notFoundIds?.length || 0);
        const alreadyActive = Number(body?.skippedBreakdown?.alreadyActiveIds?.length || 0);
        const alreadyDraft = Number(body?.skippedBreakdown?.alreadyDraftIds?.length || 0);
        const reasonParts = [
          notFound > 0 ? `${notFound} not found` : "",
          alreadyActive > 0 ? `${alreadyActive} already active` : "",
          alreadyDraft > 0 ? `${alreadyDraft} draft` : "",
        ].filter(Boolean);
        toast.error(
          reasonParts.length > 0
            ? `Some records were skipped (${reasonParts.join(", ")}).`
            : "Some selected records could not be approved.",
        );
      }
      setSelectedPendingCompIds([]);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "compensation"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "compensation", "summary", "pending"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to run bulk approval.");
    }
  };

  const handleRefreshPageData = async () => {
    try {
      await Promise.all([
        employeesQuery.refetch(),
        compensationQuery.refetch(),
        pendingCompSummaryQuery.refetch(),
        payrollQuery.refetch(),
        cronStatusQuery.refetch(),
        statutorySummaryQuery.refetch(),
      ]);
      toast.success("Page data refreshed.");
    } catch (err) {
      console.error(err);
      toast.error("Failed to refresh page data.");
    }
  };

  const requestPayrollStatusConfirm = (
    run: PayrollRun,
    status: "FINALIZED" | "PAID",
    createExpense: boolean,
  ) => {
    setPendingStatusAction({ run, status, createExpense });
    setStatusConfirmOpen(true);
  };

  const handlePreviewMonthly = async () => {
    try {
      const payload = {
        year: Number(monthlyForm.year),
        month: Number(monthlyForm.month),
        bonus: Number(monthlyForm.bonus || 0),
        previewOnly: true,
      };
      const res = await fetch("/api/admin/hr/payroll/generate-monthly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to preview monthly paystubs.");
        return;
      }
      setPreviewResult(body);
      toast.success(`Preview ready for ${Array.isArray(body.previewRows) ? body.previewRows.length : 0} employee(s).`);
    } catch (err) {
      console.error(err);
      toast.error("Failed to preview monthly paystubs.");
    }
  };

  const handleExportCompensationCsv = async () => {
    try {
      setIsExportingCompCsv(true);
      const query = new URLSearchParams();
      query.set("status", compStatusFilter);
      const trimmedSearch = compSearch.trim();
      if (trimmedSearch) query.set("search", trimmedSearch);
      const res = await fetch(`/api/admin/hr/compensation/export?${query.toString()}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to export compensation CSV.");
        return;
      }
      const blob = await res.blob();
      const contentDisposition = res.headers.get("Content-Disposition") || "";
      const nameMatch = contentDisposition.match(/filename=\"?([^\";]+)\"?/i);
      const filename = nameMatch?.[1] || "compensation-export.csv";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success("Compensation CSV exported.");
    } catch (err) {
      console.error(err);
      toast.error("Failed to export compensation CSV.");
    } finally {
      setIsExportingCompCsv(false);
    }
  };

  const formatPeriod = (run: PayrollRun) =>
    `${new Date(run.periodStart).toLocaleDateString()} - ${new Date(run.periodEnd).toLocaleDateString()}`;

  const getPayrollStatusHint = (run: PayrollRun) => {
    if (run.status === "DRAFT") return "Draft runs can be finalized or cancelled.";
    if (run.status === "FINALIZED") return "Finalized runs can be marked paid.";
    if (run.status === "PAID") return "Paid runs are locked for status changes.";
    return "Cancelled runs are locked.";
  };

  return (
    <section className="space-y-6 pb-20 md:pb-0">
      <Card className="overflow-hidden border-border/70 bg-gradient-to-br from-background via-primary/5 to-background">
        <CardContent className="space-y-6 p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.28em] text-muted-foreground">
                <Badge variant="outline">Staff workspace</Badge>
                <span>Compensation planning</span>
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight">Compensation & Payroll</h1>
                <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
                  Manage salary records, payroll generation, and statutory remittance readiness from one HR operations workspace.
                </p>
                <p className="text-xs text-muted-foreground">
                  {pendingCompensationCount > 0
                    ? `${pendingCompensationCount} compensation change${pendingCompensationCount === 1 ? " is" : "s are"} waiting for approval.`
                    : draftRunCount > 0
                      ? `${draftRunCount} payroll run${draftRunCount === 1 ? " is" : "s are"} still in draft and ready for review.`
                      : cronEnabled
                        ? "Payroll automation is enabled and the current queue is clear."
                        : "Payroll automation is currently disabled in cron status."}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>Cron status: {cronEnabled ? "enabled" : "disabled"}</span>
                  {lastRefreshedLabel ? <span>Last refreshed: {lastRefreshedLabel}</span> : null}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 xl:max-w-2xl xl:justify-end">
              <Button asChild variant="outline">
                <Link href={compensationAuditHref}>View compensation audit</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/admin/hr/payroll/remittance">Open remittance register</Link>
              </Button>
              <Button variant="outline" onClick={handleRefreshPageData}>
                Refresh data
              </Button>
              <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogTrigger asChild>
                  <Button>+ Compensation</Button>
                </DialogTrigger>
                <DialogContent className="max-w-xl">
                  <DialogHeader>
                    <DialogTitle>Add Compensation</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-3">
                    <Select
                      value={form.employeeId}
                      onValueChange={(value) => setForm((prev) => ({ ...prev, employeeId: value }))}
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
                      placeholder="Base salary"
                      value={form.baseSalary}
                      onChange={(e) => setForm((prev) => ({ ...prev, baseSalary: e.target.value }))}
                    />
                    <p className="text-xs text-muted-foreground -mt-1">
                      Use positive numbers. Leave optional fields blank for 0.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Input
                        type="number"
                        placeholder="Allowances"
                        value={form.allowances}
                        onChange={(e) => setForm((prev) => ({ ...prev, allowances: e.target.value }))}
                      />
                      <Input
                        type="number"
                        placeholder="Deductions"
                        value={form.deductions}
                        onChange={(e) => setForm((prev) => ({ ...prev, deductions: e.target.value }))}
                      />
                      <Input
                        type="number"
                        placeholder="Bonus (optional)"
                        value={form.bonus}
                        onChange={(e) => setForm((prev) => ({ ...prev, bonus: e.target.value }))}
                      />
                    </div>
                    <Input
                      placeholder="Currency"
                      value={form.currency}
                      onChange={(e) => setForm((prev) => ({ ...prev, currency: e.target.value }))}
                    />
                    <Input
                      type="date"
                      value={form.effectiveDate}
                      onChange={(e) => setForm((prev) => ({ ...prev, effectiveDate: e.target.value }))}
                    />
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={requiresApproval}
                        onChange={(e) => setRequiresApproval(e.target.checked)}
                      />
                      Require approval before activation
                    </label>
                  </div>
                  <div className="flex justify-end">
                    <Button onClick={handleCreateCompensation}>Save compensation</Button>
                  </div>
                </DialogContent>
              </Dialog>
              <Dialog open={monthlyDialogOpen} onOpenChange={setMonthlyDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="secondary">Generate Monthly Paystubs</Button>
                </DialogTrigger>
                <DialogContent className="max-w-xl">
                  <DialogHeader>
                    <DialogTitle>Generate Monthly Paystubs</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input
                      type="number"
                      placeholder="Year"
                      value={monthlyForm.year}
                      onChange={(e) =>
                        setMonthlyForm((prev) => ({ ...prev, year: e.target.value }))
                      }
                    />
                    <Select
                      value={monthlyForm.month}
                      onValueChange={(value) =>
                        setMonthlyForm((prev) => ({ ...prev, month: value }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Month" />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 12 }, (_, i) => {
                          const month = (i + 1).toString();
                          return (
                            <SelectItem key={month} value={month}>
                              {month}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      placeholder="Bonus (flat)"
                      value={monthlyForm.bonus}
                      onChange={(e) =>
                        setMonthlyForm((prev) => ({ ...prev, bonus: e.target.value }))
                      }
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Tax and SSNIT follow your Ghana payroll policy in HR Settings.
                  </p>
                  <div className="rounded-md border p-3 text-xs text-muted-foreground space-y-1">
                    <div className="font-medium text-foreground">Current policy from HR Settings</div>
                    <div>Auto statutory calculation: {policyAutoCalculation ? "On" : "Off"}</div>
                    <div>Collect PAYE: {policyEnablePaye ? "On" : "Off"}</div>
                    <div>Collect SSNIT (employee): {policyEnableSsnitEmployee ? "On" : "Off"}</div>
                    <div>Track SSNIT (employer): {policyEnableSsnitEmployer ? "On" : "Off"}</div>
                    {!policyAutoCalculation ? (
                      <div className="text-amber-700">
                        Turn on automatic statutory calculation in HR Settings before generating paystubs.
                      </div>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Bonus here is a default add-on. Per-employee bonus in compensation overrides it.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Month is required and must be between 1 and 12.
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={handlePreviewMonthly}>
                      Preview
                    </Button>
                    <Button onClick={handleGenerateMonthly}>Generate</Button>
                  </div>
                  {previewResult ? (
                    <div className="rounded-md border p-3 text-xs text-muted-foreground">
                      Preview employees: {Array.isArray(previewResult.previewRows) ? previewResult.previewRows.length : 0}
                      {" | "}Skipped: {Number(previewResult.skipped || 0)}
                      {Array.isArray(previewResult.previewRows) && previewResult.previewRows.length > 0 ? (
                        <div className="mt-2 space-y-1">
                          {previewResult.previewRows.slice(0, 5).map((row) => (
                            <div key={row.employeeId}>
                              {row.employeeId.slice(0, 8)}... Gross {formatCurrency(Number(row.grossPay || 0))} Net{" "}
                              {formatCurrency(Number(row.netPay || 0))}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </DialogContent>
              </Dialog>
              <Button
                variant="ghost"
                onClick={() => setAdvancedOpen((open) => !open)}
                aria-expanded={advancedOpen}
              >
                {advancedOpen ? "Hide advanced" : "Show advanced"}
                <ChevronDown className={`ml-2 h-4 w-4 ${advancedOpen ? "rotate-180" : ""}`} />
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <Card className="border-border/60 bg-background/80 shadow-none">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Pending Approvals</p>
                <p className="text-2xl font-semibold">{pendingCompensationCount}</p>
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-background/80 shadow-none">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Open Draft Runs</p>
                <p className="text-2xl font-semibold">{draftRunCount}</p>
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-background/80 shadow-none">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Compensation Records</p>
                <p className="text-2xl font-semibold">{Number(compensationData?.total || 0)}</p>
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-background/80 shadow-none">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Payroll Runs</p>
                <p className="text-2xl font-semibold">{payrollRuns.length}</p>
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-background/80 shadow-none">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Risky Drafts</p>
                <p className="text-2xl font-semibold">{riskyDraftRuns.length}</p>
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-background/80 shadow-none">
              <CardContent className="py-4">
                <p className="text-xs text-muted-foreground">Latest Run</p>
                {latestRun ? (
                  <div className="space-y-1">
                    <p className="text-sm font-semibold">{formatPeriod(latestRun)}</p>
                    <p className="text-xs text-muted-foreground">{latestRun.status}</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No payroll runs yet.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm Correction</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            Use Correct to fix mistakes only. For salary changes, add a new record instead.
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmEdit}>Continue</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Draft Payroll Run</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            Cancel this draft payroll run for{" "}
            <strong>{pendingCancelRun ? formatPeriod(pendingCancelRun) : "this period"}</strong>?
            This will delete its payslips.
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCancelOpen(false)}>
              Keep Draft
            </Button>
            <Button
              onClick={() => {
                if (!pendingCancelRun) return;
                handleUpdatePayrollStatus(pendingCancelRun.id, "CANCELLED", false);
                setCancelOpen(false);
                setPendingCancelRun(null);
              }}
            >
              Cancel Draft
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={statusConfirmOpen} onOpenChange={setStatusConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingStatusAction?.status === "FINALIZED" ? "Finalize Payroll Run" : "Mark Payroll Run as Paid"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <div>
              Period:{" "}
              <span className="font-medium text-foreground">
                {pendingStatusAction ? formatPeriod(pendingStatusAction.run) : "-"}
              </span>
            </div>
            <div>
              Total gross / net:{" "}
              <span className="font-medium text-foreground">
                {pendingStatusAction
                  ? `${formatCurrency(Number(pendingStatusAction.run.totalGross || 0))} / ${formatCurrency(Number(pendingStatusAction.run.totalNet || 0))}`
                  : "-"}
              </span>
            </div>
            <div>
              Payslips:{" "}
              <span className="font-medium text-foreground">
                {pendingStatusAction ? Number(pendingStatusAction.run.payslipCount || 0) : 0}
              </span>
            </div>
            {pendingStatusAction?.status === "FINALIZED" ? (
              <div>Finalizing will lock this run and create payroll expense entries when applicable.</div>
            ) : (
              <div>Marking paid confirms payment settlement for this payroll run.</div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setStatusConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!pendingStatusAction) return;
                handleUpdatePayrollStatus(
                  pendingStatusAction.run.id,
                  pendingStatusAction.status,
                  pendingStatusAction.createExpense,
                );
                setStatusConfirmOpen(false);
                setPendingStatusAction(null);
              }}
            >
              Confirm
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {advancedOpen ? (
        <Card>
          <CardHeader>
            <CardTitle>Advanced Payroll Tools</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              Use manual payroll runs for off-cycle payments, corrections, or custom periods.
            </div>
            <Dialog open={payrollDialogOpen} onOpenChange={setPayrollDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">+ Payroll run</Button>
              </DialogTrigger>
              <DialogContent className="max-w-xl">
                <DialogHeader>
                  <DialogTitle>Create Payroll Run</DialogTitle>
                </DialogHeader>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    type="date"
                    value={payrollForm.periodStart}
                    onChange={(e) =>
                      setPayrollForm((prev) => ({ ...prev, periodStart: e.target.value }))
                    }
                  />
                  <Input
                    type="date"
                    value={payrollForm.periodEnd}
                    min={payrollForm.periodStart || undefined}
                    onChange={(e) =>
                      setPayrollForm((prev) => ({ ...prev, periodEnd: e.target.value }))
                    }
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const now = new Date();
                      const start = new Date(now.getFullYear(), now.getMonth(), 1);
                      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                      setPayrollForm((prev) => ({
                        ...prev,
                        periodStart: start.toISOString().slice(0, 10),
                        periodEnd: end.toISOString().slice(0, 10),
                      }));
                    }}
                  >
                    This month
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const now = new Date();
                      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                      const end = new Date(now.getFullYear(), now.getMonth(), 0);
                      setPayrollForm((prev) => ({
                        ...prev,
                        periodStart: start.toISOString().slice(0, 10),
                        periodEnd: end.toISOString().slice(0, 10),
                      }));
                    }}
                  >
                    Last month
                  </Button>
                </div>
                {payrollDateInvalid ? (
                  <p className="text-xs text-red-600">
                    Period end cannot be earlier than period start.
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  New payroll runs are created as Draft. Gross and net totals are computed after payslips are generated.
                </p>
                <div className="flex justify-end">
                  <Button onClick={handleCreatePayroll}>Save payroll run</Button>
                </div>
              </DialogContent>
            </Dialog>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Monthly Statutory Remittance</CardTitle>
            <Button asChild size="sm" variant="outline">
              <Link href={remittanceAuditHref}>View remittance audit</Link>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Track PAYE and SSNIT liabilities for a payroll month and mark each as pending or remitted.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-28"
              type="number"
              min={2000}
              max={2100}
              value={remittanceYear}
              onChange={(e) => setRemittanceYear(e.target.value)}
            />
            <Select value={remittanceMonth} onValueChange={setRemittanceMonth}>
              <SelectTrigger className="h-8 w-40">
                <SelectValue placeholder="Month" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 12 }).map((_, index) => {
                  const month = String(index + 1);
                  return (
                    <SelectItem key={month} value={month}>
                      {new Date(2000, index, 1).toLocaleString(undefined, { month: "long" })}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => statutorySummaryQuery.refetch()}
              disabled={!remittanceQueryEnabled}
            >
              Refresh remittance totals
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded border p-3 text-sm">
              <div className="text-xs text-muted-foreground">Runs / Payslips / Employees</div>
              <div className="font-medium">
                {Number(statutorySummary?.runCount || 0)} / {Number(statutorySummary?.payslipCount || 0)} /{" "}
                {Number(statutorySummary?.employeeCount || 0)}
              </div>
            </div>
            <div className="rounded border p-3 text-sm">
              <div className="text-xs text-muted-foreground">Gross / Net</div>
              <div className="font-medium">
                {formatCurrency(Number(statutorySummary?.totalGross || 0))} /{" "}
                {formatCurrency(Number(statutorySummary?.totalNet || 0))}
              </div>
            </div>
            <div className="rounded border p-3 text-sm">
              <div className="text-xs text-muted-foreground">Other payroll deductions</div>
              <div className="font-medium">{formatCurrency(Number(statutorySummary?.otherDeductions || 0))}</div>
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Liability</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Remitted at</TableHead>
                <TableHead>Reference</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>PAYE tax</TableCell>
                <TableCell>{formatCurrency(Number(statutorySummary?.payeTax || 0))}</TableCell>
                <TableCell>{statutorySummary?.remittance?.payeStatus || "PENDING"}</TableCell>
                <TableCell>
                  {statutorySummary?.remittance?.payeRemittedAt
                    ? new Date(statutorySummary.remittance.payeRemittedAt).toLocaleString()
                    : "-"}
                </TableCell>
                <TableCell>{statutorySummary?.remittance?.payeReference || "-"}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>SSNIT (employee + employer)</TableCell>
                <TableCell>
                  {formatCurrency(
                    Number(statutorySummary?.ssnitEmployee || 0) +
                      Number(statutorySummary?.ssnitEmployer || 0),
                  )}
                </TableCell>
                <TableCell>{statutorySummary?.remittance?.ssnitStatus || "PENDING"}</TableCell>
                <TableCell>
                  {statutorySummary?.remittance?.ssnitRemittedAt
                    ? new Date(statutorySummary.remittance.ssnitRemittedAt).toLocaleString()
                    : "-"}
                </TableCell>
                <TableCell>{statutorySummary?.remittance?.ssnitReference || "-"}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" variant="outline">
              <Link href={remittanceAuditHref}>View remittance audit</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/hr/payroll/remittance">Manage remittance on dedicated page</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>Monthly Payroll Checklist</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChecklistOpen((open) => !open)}
            aria-expanded={checklistOpen}
          >
            {checklistOpen ? "Hide" : "Show"}
            <ChevronDown
              className={`ml-2 h-4 w-4 transition-transform ${checklistOpen ? "rotate-180" : ""}`}
            />
          </Button>
        </CardHeader>
        {checklistOpen ? (
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <div>1) Add or update compensation records for any staff changes.</div>
            <div>2) Confirm Ghana payroll settings in HR Settings (auto/manual mode, PAYE bands, SSNIT, taxable allowances).</div>
            <div>3) Click Generate Monthly Paystubs and enter optional bonus values.</div>
            <div>4) Use Preview first when needed, then review payroll totals and employee statutory breakdown.</div>
            <div>5) Click Finalize Run to lock and create the payroll expense.</div>
            <div>6) After payments are sent, click Mark Paid.</div>
            <div>7) Print or email paystubs for employees as needed.</div>
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader className="space-y-2">
          <CardTitle>Compensation Records</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-muted-foreground">
              Use Correct to fix mistakes. Add a new record for salary changes.
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setSelectedPendingCompIds(pendingCompensations.map((comp) => comp.id))
              }
              disabled={pendingCompensations.length === 0}
            >
              Select all pending
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelectedPendingCompIds([])}
              disabled={selectedPendingCompIds.length === 0}
            >
              Clear selection
            </Button>
            <Button
              size="sm"
              onClick={handleBulkApprovePending}
              disabled={selectedPendingCompIds.length === 0}
            >
              Approve selected ({selectedPendingCompIds.length})
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleExportCompensationCsv}
              disabled={isExportingCompCsv}
            >
              {isExportingCompCsv ? "Exporting..." : "Export CSV"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Filter:</span>
            {(["ALL", "PENDING", "ACTIVE", "DRAFT"] as CompensationStatusFilter[]).map((status) => (
              <Button
                key={status}
                size="sm"
                variant={compStatusFilter === status ? "default" : "outline"}
                onClick={() => setCompStatusFilter(status)}
              >
                {status === "ALL" ? "All" : status}
              </Button>
            ))}
            <Input
              className="h-8 w-56"
              placeholder="Search employee id, name, or email"
              value={compSearch}
              onChange={(e) => setCompSearch(e.target.value)}
            />
            <Select
              value={String(compPageSize)}
              onValueChange={(value) => setCompPageSize(Number(value) as (typeof COMP_PAGE_SIZES)[number])}
            >
              <SelectTrigger className="h-8 w-28">
                <SelectValue placeholder="Rows" />
              </SelectTrigger>
              <SelectContent>
                {COMP_PAGE_SIZES.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} rows
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Select</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>Base</TableHead>
                <TableHead>Allowances</TableHead>
                <TableHead>Deductions</TableHead>
                <TableHead>Bonus</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {compensations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-sm text-muted-foreground">
                    No compensation records for the selected filter.
                  </TableCell>
                </TableRow>
              ) : (
                compensations.map((comp) => {
                  const employee = employees.find((e) => e.id === comp.employeeId);
                  const isEditing = editingId === comp.id;
                  return (
                    <TableRow key={comp.id}>
                      <TableCell>
                        {(comp.status || "ACTIVE") === "PENDING" ? (
                          <input
                            aria-label={`Select pending compensation ${comp.id}`}
                            type="checkbox"
                            checked={selectedPendingCompIds.includes(comp.id)}
                            onChange={(e) => {
                              setSelectedPendingCompIds((current) =>
                                e.target.checked
                                  ? [...new Set([...current, comp.id])]
                                  : current.filter((id) => id !== comp.id),
                              );
                            }}
                          />
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {employee ? `${employee.firstName} ${employee.lastName}` : "-"}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            type="number"
                            value={editForm.baseSalary}
                            onChange={(e) =>
                              setEditForm((prev) => ({ ...prev, baseSalary: e.target.value }))
                            }
                          />
                        ) : (
                          formatCurrency(Number(comp.baseSalary))
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            type="number"
                            value={editForm.allowances}
                            onChange={(e) =>
                              setEditForm((prev) => ({ ...prev, allowances: e.target.value }))
                            }
                          />
                        ) : (
                          formatCurrency(Number(comp.allowances || 0))
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            type="number"
                            value={editForm.deductions}
                            onChange={(e) =>
                              setEditForm((prev) => ({ ...prev, deductions: e.target.value }))
                            }
                          />
                        ) : (
                          formatCurrency(Number(comp.deductions || 0))
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            type="number"
                            value={editForm.bonus}
                            onChange={(e) =>
                              setEditForm((prev) => ({ ...prev, bonus: e.target.value }))
                            }
                          />
                        ) : (
                          formatCurrency(Number(comp.bonus || 0))
                        )}
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <Input
                            type="date"
                            value={editForm.effectiveDate}
                            onChange={(e) =>
                              setEditForm((prev) => ({ ...prev, effectiveDate: e.target.value }))
                            }
                          />
                        ) : comp.effectiveDate ? (
                          new Date(comp.effectiveDate).toLocaleDateString()
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="text-xs font-medium">
                          {comp.status || "ACTIVE"}
                        </span>
                      </TableCell>
                      <TableCell>
                        {isEditing ? (
                          <div className="flex gap-2">
                            <Button size="sm" onClick={handleUpdateCompensation}>
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingId(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" onClick={() => startEdit(comp)}>
                              Correct
                            </Button>
                            {comp.status === "DRAFT" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleUpdateCompStatus(comp.id, "PENDING")}
                              >
                                Submit
                              </Button>
                            ) : null}
                            {comp.status === "PENDING" ? (
                              <Button
                                size="sm"
                                onClick={() => handleUpdateCompStatus(comp.id, "ACTIVE")}
                              >
                                Approve
                              </Button>
                            ) : null}
                            <Button asChild size="sm" variant="secondary">
                              <Link href={`/admin/hr/staff/${comp.employeeId}/paystubs`}>
                                Paystubs
                              </Link>
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <div>
              Page {Number(compensationData?.page || 1)} of {Number(compensationData?.totalPages || 1)} | Total{" "}
              {Number(compensationData?.total || 0)} record(s)
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCompPage((current) => Math.max(1, current - 1))}
                disabled={Number(compensationData?.page || 1) <= 1}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setCompPage((current) =>
                    Math.min(Number(compensationData?.totalPages || 1), current + 1),
                  )
                }
                disabled={Number(compensationData?.page || 1) >= Number(compensationData?.totalPages || 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {riskyDraftRuns.length > 0 ? (
        <Card className="border-amber-400/60">
          <CardHeader className="space-y-1">
            <CardTitle>Draft Runs Requiring Review</CardTitle>
            <p className="text-xs text-muted-foreground">
              These draft payroll runs already have totals or payslips. Review and finalize or cancel them.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {riskyDraftRuns.map((run) => (
              <div key={run.id} className="rounded-md border p-2 text-sm">
                <div className="font-medium">{formatPeriod(run)}</div>
                <div className="text-xs text-muted-foreground">
                  Payslips: {Number(run.payslipCount || 0)} | Gross:{" "}
                  {formatCurrency(Number(run.totalGross || 0))} | Net:{" "}
                  {formatCurrency(Number(run.totalNet || 0))}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Missing bank details: {Number(run.missingBankDetailsCount || 0)} | Statutory mode:{" "}
                  {policyAutoCalculation ? "Auto" : "Auto off"}
                </div>
                {Number(run.missingBankDetailsCount || 0) > 0 && run.firstMissingBankEmployeeId ? (
                  <div className="mt-1">
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/admin/hr/staff/${run.firstMissingBankEmployeeId}`}>
                        Open first affected staff
                      </Link>
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Payroll Runs</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={showDraftsMissingBankOnly ? "default" : "outline"}
              size="sm"
              onClick={() => setShowDraftsMissingBankOnly((prev) => !prev)}
            >
              {showDraftsMissingBankOnly ? "Showing missing-bank drafts" : "Drafts missing bank only"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowCancelled((prev) => !prev)}
            >
              {showCancelled ? "Hide cancelled" : "Show cancelled"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Payslips</TableHead>
                <TableHead>Gross</TableHead>
                <TableHead>Net</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRuns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                    No payroll runs to show.
                  </TableCell>
                </TableRow>
              ) : (
                visibleRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      {new Date(run.periodStart).toLocaleDateString()} -{" "}
                      {new Date(run.periodEnd).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <div className="text-xs font-medium">
                        {run.runType === "ADJUSTMENT" ? "Adjustment" : "Regular"}
                      </div>
                      {run.runType === "ADJUSTMENT" && run.adjustmentForId ? (
                        <Link
                          href={`/admin/hr/payroll/${run.adjustmentForId}`}
                          className="text-xs underline text-muted-foreground"
                        >
                          View original
                        </Link>
                      ) : null}
                    </TableCell>
                    <TableCell>{run.status}</TableCell>
                    <TableCell>{Number(run.payslipCount || 0)}</TableCell>
                    <TableCell>{formatCurrency(Number(run.totalGross || 0))}</TableCell>
                    <TableCell>{formatCurrency(Number(run.totalNet || 0))}</TableCell>
                    <TableCell>
                      <div className="space-y-2">
                        {run.status === "DRAFT" ? (
                          <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
                            Health: Payslips {Number(run.payslipCount || 0)} |{" "}
                            <span title="Current computed net total for the run">Net</span>{" "}
                            {formatCurrency(Number(run.totalNet || 0))} |{" "}
                            <span title="Number of payslips where employee bank details are incomplete">
                              Missing bank
                            </span>{" "}
                            {Number(run.missingBankDetailsCount || 0)} |{" "}
                            <span title="Statutory calculation mode from HR Settings">Statutory</span>{" "}
                            {policyAutoCalculation ? "Auto" : "Auto off"}
                          </div>
                        ) : null}
                        {run.status === "DRAFT" && Number(run.missingBankDetailsCount || 0) > 0 ? (
                          <div className="text-[11px] text-amber-700">
                            Warning: {Number(run.missingBankDetailsCount || 0)} payslip(s) missing bank details.
                            {run.firstMissingBankEmployeeId ? (
                              <>
                                {" "}
                                <Link
                                  href={`/admin/hr/staff/${run.firstMissingBankEmployeeId}`}
                                  className="underline"
                                >
                                  Open first affected staff
                                </Link>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                        {run.status === "DRAFT" ? (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              onClick={() => requestPayrollStatusConfirm(run, "FINALIZED", !run.expense)}
                              disabled={Number(run.payslipCount || 0) <= 0}
                            >
                              Finalize Run
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setPendingCancelRun(run);
                                setCancelOpen(true);
                              }}
                            >
                              Cancel Draft
                            </Button>
                            <Button asChild size="sm" variant="secondary">
                              <Link href={`/admin/hr/payroll/${run.id}`}>View</Link>
                            </Button>
                          </div>
                        ) : null}
                        {run.status === "FINALIZED" ? (
                          <div className="flex flex-wrap gap-2">
                            {!run.expense ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleUpdatePayrollStatus(run.id, "FINALIZED", true)}
                              >
                                Create Expense
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => requestPayrollStatusConfirm(run, "PAID", false)}
                            >
                              Mark Paid
                            </Button>
                            <Button asChild size="sm" variant="secondary">
                              <Link href={`/admin/hr/payroll/${run.id}`}>View</Link>
                            </Button>
                          </div>
                        ) : null}
                        {run.status === "PAID" ? (
                          <div className="flex flex-wrap gap-2">
                            {!run.expense ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleUpdatePayrollStatus(run.id, "PAID", true)}
                              >
                                Create Expense
                              </Button>
                            ) : null}
                            <Button asChild size="sm" variant="secondary">
                              <Link href={`/admin/hr/payroll/${run.id}`}>View</Link>
                            </Button>
                          </div>
                        ) : null}
                        {run.status === "CANCELLED" ? (
                          <div className="flex flex-wrap gap-2">
                            <Button asChild size="sm" variant="secondary">
                              <Link href={`/admin/hr/payroll/${run.id}`}>View</Link>
                            </Button>
                          </div>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                          <Button asChild size="sm" variant="outline">
                            <Link
                              href={`/admin/audit?entityType=PAYROLL_RUN&entityId=${encodeURIComponent(run.id)}&sourcePage=admin%2Fhr%2Fpayroll`}
                            >
                              Open run audit
                            </Link>
                          </Button>
                          <Button asChild size="sm" variant="outline">
                            <Link
                              href={`/admin/accounting/journal?sourceType=PAYROLL&q=${encodeURIComponent(run.id)}`}
                            >
                              Open run journal
                            </Link>
                          </Button>
                        </div>
                        {run.status === "DRAFT" && Number(run.payslipCount || 0) <= 0 ? (
                          <div className="text-[11px] text-amber-700">
                            Finalize blocked: add at least one payslip before finalizing this run.
                          </div>
                        ) : null}
                        {run.status === "DRAFT" && !policyAutoCalculation ? (
                          <div className="text-[11px] text-amber-700">
                            Generation helper: automatic statutory calculation is off in HR Settings.
                          </div>
                        ) : null}
                        <div className="text-[11px] text-muted-foreground">
                          Last action:{" "}
                          {new Date(run.updatedAt || run.createdAt || run.periodEnd).toLocaleString()}
                        </div>
                        <div className="text-xs text-muted-foreground">{getPayrollStatusHint(run)}</div>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}

