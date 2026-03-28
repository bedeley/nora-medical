"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/currency";
import {
  validateStaffBankInput,
  validateStaffContactInput,
  validateStaffDocumentFile,
} from "@/lib/hr-staff-profile-utils";
import { appendAuditMetaParams, buildAdminAuditEmployeeHref } from "@/lib/admin-audit-links";

type Compensation = {
  id: string;
  baseSalary: number | string;
  allowances: number | string;
  deductions: number | string;
  bonus?: number | string;
  currency: string;
  effectiveDate: string;
  note?: string | null;
};

type Issue = {
  id: string;
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
  createdAt: string;
  closedAt?: string | null;
};

type Payslip = {
  id: string;
  grossPay: number | string;
  netPay: number | string;
  createdAt: string;
  payrollRun?: { id: string; periodEnd?: string };
};

type OnboardingTask = {
  id: string;
  title: string;
  status: "PENDING" | "COMPLETE";
  dueDate?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
};

type EmployeeDocument = {
  id: string;
  title: string;
  fileUrl: string;
  fileType?: string | null;
  employeeVisible?: boolean;
  uploadedAt?: string;
};

type PerformanceReview = {
  id: string;
  rating: "EXCEEDS" | "MEETS" | "NEEDS_IMPROVEMENT" | "UNSATISFACTORY";
  periodStart: string;
  periodEnd: string;
  summary?: string | null;
  strengths?: string | null;
  improvements?: string | null;
  goals?: string | null;
};

type LeaveRequest = {
  id: string;
  type: "ANNUAL" | "SICK" | "UNPAID" | "OTHER";
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";
  startDate: string;
  endDate: string;
  cancelledAt?: string | null;
  updatedAt?: string;
};

type EmployeeProfile = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  department?: string | null;
  position?: string | null;
  status: "ACTIVE" | "ON_LEAVE" | "SUSPENDED" | "TERMINATED";
  updatedAt: string;
  hireDate?: string | null;
  terminationDate?: string | null;
  managerId?: string | null;
  notes?: string | null;
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankCode?: string | null;
  bankBranch?: string | null;
  compensations: Compensation[];
  issues?: Issue[];
  onboardingTasks?: OnboardingTask[];
};

type ManagerOption = {
  id: string;
  firstName: string;
  lastName: string;
  status: "ACTIVE" | "ON_LEAVE" | "SUSPENDED" | "TERMINATED";
  department?: string | null;
  position?: string | null;
};

type StaffActivityItem = {
  id: string;
  action: string;
  createdAt: string;
  actor?: { name?: string | null; email?: string | null; role?: string | null } | null;
  meta?: { resultSummary?: string; section?: string; operation?: string } | null;
};

type QueryError = Error & { status?: number };

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(
      typeof body?.error === "string" ? body.error : "Request failed.",
    ) as QueryError;
    error.status = res.status;
    throw error;
  }
  return body as T;
}

function formatOptionalDate(value?: string | null) {
  return value ? new Date(value).toLocaleDateString() : "Not provided";
}

function formatStatusLabel(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function getManagerRoleSummary(manager?: Pick<ManagerOption, "position" | "department"> | null) {
  if (!manager) return "Role and department not provided";
  const values = [manager.position, manager.department].filter(
    (value): value is string => Boolean(value && value.trim()),
  );
  return values.length > 0 ? values.join(" - ") : "Role and department not provided";
}

export default function StaffProfilePage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const employeeId = useMemo(() => String(params?.id ?? ""), [params]);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: "", dueDate: "" });
  const [employmentForm, setEmploymentForm] = useState({
    firstName: "",
    lastName: "",
    department: "",
    position: "",
    status: "ACTIVE" as EmployeeProfile["status"],
    hireDate: "",
    terminationDate: "",
    managerId: "",
    notes: "",
  });
  const [employmentErrors, setEmploymentErrors] = useState<Record<string, string>>({});
  const [editingEmployment, setEditingEmployment] = useState(false);
  const [contactForm, setContactForm] = useState({ email: "", phone: "" });
  const [contactErrors, setContactErrors] = useState<Record<string, string>>({});
  const [editingContact, setEditingContact] = useState(false);
  const [bankForm, setBankForm] = useState({
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
    bankCode: "",
    bankBranch: "",
  });
  const [bankErrors, setBankErrors] = useState<Record<string, string>>({});
  const [editingBank, setEditingBank] = useState(false);
  const [docForm, setDocForm] = useState({ title: "", file: null as File | null, employeeVisible: false });
  const [docError, setDocError] = useState("");
  const [documentDialogOpen, setDocumentDialogOpen] = useState(false);
  const [savingEmployment, setSavingEmployment] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  const [savingBank, setSavingBank] = useState(false);
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [taskDeleteDialog, setTaskDeleteDialog] = useState<OnboardingTask | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [editTaskDialog, setEditTaskDialog] = useState<{
    open: boolean;
    id: string;
    title: string;
    dueDate: string;
    updatedAt: string;
  }>({
    open: false,
    id: "",
    title: "",
    dueDate: "",
    updatedAt: "",
  });
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [docDeleteDialog, setDocDeleteDialog] = useState<EmployeeDocument | null>(null);
  const [employmentConfirmOpen, setEmploymentConfirmOpen] = useState(false);
  const [leaveDecision, setLeaveDecision] = useState<{
    open: boolean;
    leave: LeaveRequest | null;
    status: "REJECTED" | "CANCELLED" | null;
    note: string;
  }>({
    open: false,
    leave: null,
    status: null,
    note: "",
  });
  const [updatingLeaveId, setUpdatingLeaveId] = useState<string | null>(null);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [visibleDocumentCount, setVisibleDocumentCount] = useState(5);
  const [visibleReviewCount, setVisibleReviewCount] = useState(4);
  const [visiblePayslipCount, setVisiblePayslipCount] = useState(4);
  const [visibleIssueCount, setVisibleIssueCount] = useState(4);
  const [visibleActivityCount, setVisibleActivityCount] = useState(4);
  const staffSourcePage = useMemo(() => `/admin/hr/staff/${employeeId}`, [employeeId]);
  const staffAuditHref = useMemo(
    () => buildAdminAuditEmployeeHref({ employeeId, sourcePage: staffSourcePage }),
    [employeeId, staffSourcePage],
  );

  const {
    data: employee,
    error: employeeError,
    isLoading: employeeLoading,
    refetch: refetchEmployee,
  } = useQuery<EmployeeProfile, QueryError>({
    queryKey: ["admin", "hr", "employee", employeeId],
    queryFn: () => fetcher<EmployeeProfile>(`/api/admin/hr/employees/${employeeId}`),
    enabled: Boolean(employeeId),
  });
  const employeeRelatedEnabled = Boolean(employeeId) && !employeeLoading && !employeeError;

  const { data: managerOptionsData } = useQuery<{ rows: ManagerOption[] }, QueryError>({
    queryKey: ["admin", "hr", "employees", "manager-options"],
    queryFn: () =>
      fetcher<{ rows: ManagerOption[] }>(
        "/api/admin/hr/employees?page=1&pageSize=100&sort=name_asc",
      ),
    enabled: employeeRelatedEnabled,
  });

  const { data: payslipsData } = useQuery<{ rows: Payslip[] }, QueryError>({
    queryKey: ["admin", "hr", "employee", employeeId, "payslips"],
    queryFn: () => fetcher<{ rows: Payslip[] }>(`/api/admin/hr/payslips?employeeId=${employeeId}`),
    enabled: employeeRelatedEnabled,
  });

  const { data: documentsData } = useQuery<{ rows: EmployeeDocument[] }, QueryError>({
    queryKey: ["admin", "hr", "documents", employeeId],
    queryFn: () =>
      fetcher<{ rows: EmployeeDocument[] }>(`/api/admin/hr/documents?employeeId=${employeeId}`),
    enabled: employeeRelatedEnabled,
  });

  const { data: reviewsData } = useQuery<{ rows: PerformanceReview[] }, QueryError>({
    queryKey: ["admin", "hr", "reviews", employeeId],
    queryFn: () => fetcher<{ rows: PerformanceReview[] }>(`/api/admin/hr/reviews?employeeId=${employeeId}`),
    enabled: employeeRelatedEnabled,
  });

  const { data: leaveData } = useQuery<{ rows: LeaveRequest[] }, QueryError>({
    queryKey: ["admin", "hr", "leave", employeeId],
    queryFn: () =>
      fetcher<{ rows: LeaveRequest[] }>(
        `/api/admin/hr/leave?employeeId=${employeeId}&page=1&pageSize=200`,
      ),
    enabled: employeeRelatedEnabled,
  });

  const { data: settingsData } = useQuery<
    { values?: Record<string, string | number | null | undefined> },
    QueryError
  >({
    queryKey: ["admin", "hr", "settings", "workweekDays"],
    queryFn: () =>
      fetcher<{ values?: Record<string, string | number | null | undefined> }>(
        "/api/admin/hr/settings?keys=hr.workweekDays",
      ),
  });
  const { data: activityData } = useQuery<StaffActivityItem[], QueryError>({
    queryKey: ["admin", "hr", "staff", employeeId, "activity"],
    queryFn: () =>
      fetcher<StaffActivityItem[]>(
        `/api/admin/audit?employeeId=${employeeId}&sourcePage=${encodeURIComponent(staffSourcePage)}&limit=50`,
      ),
    enabled: employeeRelatedEnabled,
  });

  const profile = employee as EmployeeProfile | undefined;
  const payslips = Array.isArray(payslipsData?.rows)
    ? ([...payslipsData.rows] as Payslip[]).sort((a, b) => {
        const aPeriod = a.payrollRun?.periodEnd
          ? new Date(a.payrollRun.periodEnd).getTime()
          : 0;
        const bPeriod = b.payrollRun?.periodEnd
          ? new Date(b.payrollRun.periodEnd).getTime()
          : 0;
        if (aPeriod !== bPeriod) return bPeriod - aPeriod;
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (aTime !== bTime) return bTime - aTime;
        return a.id.localeCompare(b.id);
      })
    : [];
  const issues = profile?.issues ?? [];
  const onboardingTasks = profile?.onboardingTasks ?? [];
  const documents = Array.isArray(documentsData?.rows)
    ? (documentsData.rows as EmployeeDocument[])
    : [];
  const reviews = Array.isArray(reviewsData?.rows)
    ? (reviewsData.rows as PerformanceReview[])
    : [];
  const managerOptions = useMemo(
    () =>
      Array.isArray(managerOptionsData?.rows)
        ? managerOptionsData.rows.filter((row) => row.id !== employeeId)
        : [],
    [employeeId, managerOptionsData],
  );
  const currentManager = useMemo(
    () => managerOptions.find((row) => row.id === (profile?.managerId || "")) || null,
    [managerOptions, profile?.managerId],
  );
  const selectedManager = useMemo(
    () => managerOptions.find((row) => row.id === employmentForm.managerId) || null,
    [employmentForm.managerId, managerOptions],
  );
  const leaveRequests = useMemo(
    () => (Array.isArray(leaveData?.rows) ? (leaveData.rows as LeaveRequest[]) : []),
    [leaveData],
  );
  const activityItems = useMemo(
    () => (Array.isArray(activityData) ? (activityData as StaffActivityItem[]) : []),
    [activityData],
  );
  const workweekDays = useMemo(() => {
    const raw = settingsData?.values?.["hr.workweekDays"];
    const num = Number(raw);
    if (Number.isFinite(num) && num >= 5 && num <= 7) return Math.floor(num);
    return 5;
  }, [settingsData]);

  useEffect(() => {
    if (!profile) return;
    setEmploymentForm({
      firstName: profile.firstName || "",
      lastName: profile.lastName || "",
      department: profile.department || "",
      position: profile.position || "",
      status: profile.status,
      hireDate: profile.hireDate ? new Date(profile.hireDate).toISOString().slice(0, 10) : "",
      terminationDate: profile.terminationDate
        ? new Date(profile.terminationDate).toISOString().slice(0, 10)
        : "",
      managerId: profile.managerId || "",
      notes: profile.notes || "",
    });
    setContactForm({
      email: profile.email || "",
      phone: profile.phone || "",
    });
    setBankForm({
      bankName: profile.bankName || "",
      bankAccountName: profile.bankAccountName || "",
      bankAccountNumber: profile.bankAccountNumber || "",
      bankCode: profile.bankCode || "",
      bankBranch: profile.bankBranch || "",
    });
  }, [profile]);

  useEffect(() => {
    setVisibleDocumentCount(5);
    setVisibleActivityCount(4);
  }, [employeeId]);

  const resetEmploymentForm = () => {
    if (!profile) return;
    setEmploymentForm({
      firstName: profile.firstName || "",
      lastName: profile.lastName || "",
      department: profile.department || "",
      position: profile.position || "",
      status: profile.status,
      hireDate: profile.hireDate ? new Date(profile.hireDate).toISOString().slice(0, 10) : "",
      terminationDate: profile.terminationDate
        ? new Date(profile.terminationDate).toISOString().slice(0, 10)
        : "",
      managerId: profile.managerId || "",
      notes: profile.notes || "",
    });
    setEmploymentErrors({});
  };

  const resetContactForm = () => {
    if (!profile) return;
    setContactForm({
      email: profile.email || "",
      phone: profile.phone || "",
    });
    setContactErrors({});
  };

  const resetBankForm = () => {
    if (!profile) return;
    setBankForm({
      bankName: profile.bankName || "",
      bankAccountName: profile.bankAccountName || "",
      bankAccountNumber: profile.bankAccountNumber || "",
      bankCode: profile.bankCode || "",
      bankBranch: profile.bankBranch || "",
    });
    setBankErrors({});
  };

  const copyTextToClipboard = async (text: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    if (typeof document === "undefined") {
      throw new Error("Clipboard is not available.");
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    if (!ok) {
      throw new Error("Failed to copy text.");
    }
  };

  const handleCopyEmployeeLink = async () => {
    const link = `${window.location.origin}${staffSourcePage}`;
    try {
      await copyTextToClipboard(link);
      toast.success("Employee profile link copied.");
    } catch {
      toast.error("Could not copy link.", {
        action: {
          label: "Retry",
          onClick: () => {
            void handleCopyEmployeeLink();
          },
        },
      });
    }
  };

  const leaveSummary = useMemo(() => {
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const yearEnd = new Date(new Date().getFullYear(), 11, 31, 23, 59, 59, 999);
    const approvedTotals: Record<string, number> = {
      ANNUAL: 0,
      SICK: 0,
      UNPAID: 0,
      OTHER: 0,
    };
    const usedTotals: Record<string, number> = {
      ANNUAL: 0,
      SICK: 0,
      UNPAID: 0,
      OTHER: 0,
    };
    let pending = 0;

    const countWorkingDays = (start: Date, end: Date) => {
      const days: number[] = [];
      if (workweekDays >= 7) {
        days.push(0, 1, 2, 3, 4, 5, 6);
      } else if (workweekDays === 6) {
        days.push(1, 2, 3, 4, 5, 6);
      } else {
        days.push(1, 2, 3, 4, 5);
      }
      const s = new Date(start);
      const e = new Date(end);
      s.setHours(0, 0, 0, 0);
      e.setHours(0, 0, 0, 0);
      if (e < s) return 0;
      let count = 0;
      const current = new Date(s);
      while (current <= e) {
        if (days.includes(current.getDay())) count += 1;
        current.setDate(current.getDate() + 1);
      }
      return count;
    };

    const computeUsedDays = (leave: LeaveRequest) => {
      if (leave.status !== "APPROVED" && leave.status !== "CANCELLED") return 0;
      const start = new Date(leave.startDate);
      const end = new Date(leave.endDate);
      const today = new Date();
      const endLimit =
        leave.status === "CANCELLED" && leave.cancelledAt
          ? new Date(leave.cancelledAt)
          : today;
      const cappedEnd = endLimit < end ? endLimit : end;
      if (cappedEnd < start) return 0;
      const approved = countWorkingDays(start, end);
      const used = countWorkingDays(start, cappedEnd);
      return Math.min(approved, used);
    };

    leaveRequests.forEach((leave) => {
      if (leave.status === "REQUESTED") pending += 1;
      if (leave.status !== "APPROVED" && leave.status !== "CANCELLED") return;
      const start = new Date(leave.startDate);
      const end = new Date(leave.endDate);
      if (end < yearStart || start > yearEnd) return;
      const overlapStart = start < yearStart ? yearStart : start;
      const overlapEnd = end > yearEnd ? yearEnd : end;
      const days = countWorkingDays(overlapStart, overlapEnd);
      approvedTotals[leave.type] = (approvedTotals[leave.type] || 0) + days;
      usedTotals[leave.type] = (usedTotals[leave.type] || 0) + computeUsedDays(leave);
    });

    return { approvedTotals, usedTotals, pending };
  }, [leaveRequests, workweekDays]);

  const activeApprovedLeave = useMemo(
    () =>
      leaveRequests.find((leave) => {
        if (leave.status !== "APPROVED") return false;
        const today = new Date();
        const start = new Date(leave.startDate);
        const end = new Date(leave.endDate);
        return today >= start && today <= end;
      }) || null,
    [leaveRequests],
  );
  const latestCompensation = profile?.compensations?.[0] ?? null;
  const latestPayslip = payslips[0] ?? null;
  const pendingOnboardingCount = onboardingTasks.filter((task) => task.status === "PENDING").length;
  const openIssuesCount = issues.filter(
    (issue) => issue.status === "OPEN" || issue.status === "IN_PROGRESS",
  ).length;
  const bankMissingFields = [
    profile?.bankName ? null : "bank name",
    profile?.bankCode ? null : "bank code",
    profile?.bankBranch ? null : "bank branch",
    profile?.bankAccountName ? null : "account name",
    profile?.bankAccountNumber ? null : "account number",
  ].filter((value): value is string => Boolean(value));
  const bankReady = bankMissingFields.length === 0;

  const isContactDirty = useMemo(
    () => Boolean(profile) && (contactForm.email !== (profile?.email || "") || contactForm.phone !== (profile?.phone || "")),
    [contactForm.email, contactForm.phone, profile],
  );
  const isEmploymentDirty = useMemo(
    () => {
      if (!profile) return false;
      return (
        employmentForm.firstName !== profile.firstName ||
        employmentForm.lastName !== profile.lastName ||
        employmentForm.department !== (profile.department || "") ||
        employmentForm.position !== (profile.position || "") ||
        employmentForm.status !== profile.status ||
        employmentForm.hireDate !==
          (profile.hireDate ? new Date(profile.hireDate).toISOString().slice(0, 10) : "") ||
        employmentForm.terminationDate !==
          (profile.terminationDate
            ? new Date(profile.terminationDate).toISOString().slice(0, 10)
            : "") ||
        employmentForm.managerId !== (profile.managerId || "") ||
        employmentForm.notes !== (profile.notes || "")
      );
    },
    [employmentForm, profile],
  );

  const isBankDirty = useMemo(
    () =>
      Boolean(profile) &&
      (bankForm.bankName !== (profile?.bankName || "") ||
        bankForm.bankAccountName !== (profile?.bankAccountName || "") ||
        bankForm.bankAccountNumber !== (profile?.bankAccountNumber || "") ||
        bankForm.bankCode !== (profile?.bankCode || "") ||
        bankForm.bankBranch !== (profile?.bankBranch || "")),
    [bankForm.bankAccountName, bankForm.bankAccountNumber, bankForm.bankBranch, bankForm.bankCode, bankForm.bankName, profile],
  );

  const refreshProfileAndLeave = () => {
    queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employee", employeeId] });
    queryClient.invalidateQueries({ queryKey: ["admin", "hr", "leave", employeeId] });
    queryClient.invalidateQueries({ queryKey: ["admin", "hr", "staff", employeeId, "activity"] });
  };

  const patchOnboardingTaskInCache = (
    taskId: string,
    updates: Partial<Pick<OnboardingTask, "title" | "dueDate" | "status" | "completedAt">>,
  ) => {
    queryClient.setQueryData(["admin", "hr", "employee", employeeId], (current: unknown) => {
      if (!current || typeof current !== "object") return current;
      const employeeData = current as EmployeeProfile;
      const currentTasks = Array.isArray(employeeData.onboardingTasks)
        ? employeeData.onboardingTasks
        : [];
      return {
        ...employeeData,
        onboardingTasks: currentTasks.map((task) =>
          task.id === taskId ? { ...task, ...updates } : task,
        ),
      };
    });
  };

  const removeOnboardingTaskFromCache = (taskId: string) => {
    queryClient.setQueryData(["admin", "hr", "employee", employeeId], (current: unknown) => {
      if (!current || typeof current !== "object") return current;
      const employeeData = current as EmployeeProfile;
      const currentTasks = Array.isArray(employeeData.onboardingTasks)
        ? employeeData.onboardingTasks
        : [];
      return {
        ...employeeData,
        onboardingTasks: currentTasks.filter((task) => task.id !== taskId),
      };
    });
  };

  const handleToggleTask = async (task: OnboardingTask, status: "PENDING" | "COMPLETE") => {
    setSavingTaskId(task.id);
    const optimisticCompletedAt = status === "COMPLETE" ? new Date().toISOString() : null;
    patchOnboardingTaskInCache(task.id, {
      status,
      completedAt: optimisticCompletedAt,
    });
    try {
      const res = await fetch(`/api/admin/hr/onboarding/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          expectedUpdatedAt: task.updatedAt || "",
          sourcePage: staffSourcePage,
          section: "onboarding-checklist",
          operation: status === "COMPLETE" ? "complete_onboarding_task" : "reopen_onboarding_task",
          resultSummary:
            status === "COMPLETE"
              ? "Onboarding task marked complete."
              : "Onboarding task moved back to pending.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        patchOnboardingTaskInCache(task.id, {
          status: task.status,
          completedAt: task.completedAt || null,
        });
        toast.error(body.error || "Failed to update onboarding task.");
        return;
      }
      toast.success("Onboarding task updated.");
      refreshProfileAndLeave();
    } catch {
      toast.error("Failed to update onboarding task.");
    } finally {
      setSavingTaskId(null);
    }
  };

  const handleCreateTask = async () => {
    if (!taskForm.title.trim()) {
      toast.error("Task title is required.");
      return;
    }
    setCreatingTask(true);
    try {
      const res = await fetch("/api/admin/hr/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId,
          title: taskForm.title,
          dueDate: taskForm.dueDate ? new Date(taskForm.dueDate).toISOString() : "",
          sourcePage: staffSourcePage,
          section: "onboarding-checklist",
          operation: "create_onboarding_task",
          resultSummary: "Onboarding task created from staff profile.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to create onboarding task.");
        return;
      }
      toast.success("Onboarding task created.");
      setTaskForm({ title: "", dueDate: "" });
      setTaskDialogOpen(false);
      refreshProfileAndLeave();
    } catch {
      toast.error("Failed to create onboarding task.");
    } finally {
      setCreatingTask(false);
    }
  };

  const handleSaveTaskEdit = async () => {
    if (!editTaskDialog.id || !editTaskDialog.title.trim()) {
      toast.error("Task title is required.");
      return;
    }
    setSavingTaskId(editTaskDialog.id);
    try {
      const dueDateIso = editTaskDialog.dueDate ? new Date(editTaskDialog.dueDate).toISOString() : "";
      const res = await fetch(`/api/admin/hr/onboarding/${editTaskDialog.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTaskDialog.title,
          dueDate: dueDateIso,
          expectedUpdatedAt: editTaskDialog.updatedAt,
          sourcePage: staffSourcePage,
          section: "onboarding-checklist",
          operation: "edit_onboarding_task",
          resultSummary: "Onboarding task updated from staff profile.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update onboarding task.");
        return;
      }
      patchOnboardingTaskInCache(editTaskDialog.id, {
        title: editTaskDialog.title.trim(),
        dueDate: dueDateIso || null,
      });
      toast.success("Onboarding task updated.");
      setEditTaskDialog({
        open: false,
        id: "",
        title: "",
        dueDate: "",
        updatedAt: "",
      });
      refreshProfileAndLeave();
    } catch {
      toast.error("Failed to update onboarding task.");
    } finally {
      setSavingTaskId(null);
    }
  };

  const handleDeleteTask = async (task: OnboardingTask) => {
    setDeletingTaskId(task.id);
    try {
      const res = await fetch(`/api/admin/hr/onboarding/${task.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedUpdatedAt: task.updatedAt || "",
          sourcePage: staffSourcePage,
          section: "onboarding-checklist",
          operation: "delete_onboarding_task",
          resultSummary: "Onboarding task removed from staff profile.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to delete onboarding task.");
        return;
      }
      removeOnboardingTaskFromCache(task.id);
      toast.success("Onboarding task removed.");
      refreshProfileAndLeave();
    } catch {
      toast.error("Failed to delete onboarding task.");
    } finally {
      setDeletingTaskId(null);
    }
  };

  const submitEmploymentUpdate = async () => {
    if (!profile || !isEmploymentDirty) return;
    const nextErrors: Record<string, string> = {};
    if (!employmentForm.firstName.trim()) nextErrors.firstName = "First name is required.";
    if (!employmentForm.lastName.trim()) nextErrors.lastName = "Last name is required.";
    if (
      employmentForm.status === "TERMINATED" &&
      !employmentForm.terminationDate.trim()
    ) {
      nextErrors.terminationDate = "Termination date is required when status is terminated.";
    }
    setEmploymentErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.error("Fix the employment details and try again.");
      return;
    }

    setSavingEmployment(true);
    try {
      const statusChanged = employmentForm.status !== profile.status;
      const res = await fetch(`/api/admin/hr/employees/${employeeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: employmentForm.firstName.trim(),
          lastName: employmentForm.lastName.trim(),
          department: employmentForm.department,
          position: employmentForm.position,
          status: employmentForm.status,
          hireDate: employmentForm.hireDate,
          terminationDate:
            employmentForm.status === "TERMINATED" ? employmentForm.terminationDate : "",
          managerId: employmentForm.managerId,
          notes: employmentForm.notes,
          expectedUpdatedAt: profile.updatedAt,
          sourcePage: staffSourcePage,
          section: "employment-details",
          operation: statusChanged ? "update_employment_status" : "update_employment_details",
          resultSummary: statusChanged
            ? `Employee status updated to ${formatStatusLabel(employmentForm.status)}.`
            : "Employee employment details updated successfully.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update employment details.");
        return;
      }
      toast.success(
        statusChanged ? "Employment status updated." : "Employment details updated.",
      );
      setEmploymentErrors({});
      setEditingEmployment(false);
      setEmploymentConfirmOpen(false);
      refreshProfileAndLeave();
    } catch {
      toast.error("Failed to update employment details.");
    } finally {
      setSavingEmployment(false);
    }
  };

  const handleSaveEmployment = async () => {
    if (!profile || !isEmploymentDirty) return;
    const statusChanged = employmentForm.status !== profile.status;
    if (statusChanged) {
      setEmploymentConfirmOpen(true);
      return;
    }
    await submitEmploymentUpdate();
  };

  const handleSaveContact = async () => {
    const { email, phone, errors } = validateStaffContactInput(contactForm);
    setContactErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error("Fix the contact details and try again.");
      return;
    }
    if (!profile || !isContactDirty) return;
    setSavingContact(true);
    try {
      const res = await fetch(`/api/admin/hr/employees/${employeeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          phone,
          expectedUpdatedAt: profile.updatedAt,
          sourcePage: staffSourcePage,
          section: "contact-details",
          operation: "update_contact_details",
          resultSummary: "Employee contact details updated successfully.",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update contact details.");
        return;
      }
      toast.success("Contact details updated.");
      setContactErrors({});
      setEditingContact(false);
      refreshProfileAndLeave();
    } catch {
      toast.error("Failed to update contact details.");
    } finally {
      setSavingContact(false);
    }
  };

  const handleSaveBank = async () => {
    const { normalized, errors } = validateStaffBankInput(bankForm);
    setBankErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error("Fill the required bank details.");
      return;
    }
    if (!profile || !isBankDirty) return;
    setSavingBank(true);
    try {
      const res = await fetch(`/api/admin/hr/employees/${employeeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...normalized,
          expectedUpdatedAt: profile.updatedAt,
          sourcePage: staffSourcePage,
          section: "payroll-details",
          operation: "update_bank_details",
          resultSummary: "Employee bank details updated successfully.",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update bank details.");
        return;
      }
      toast.success("Bank details updated.");
      setBankErrors({});
      setEditingBank(false);
      refreshProfileAndLeave();
    } catch {
      toast.error("Failed to update bank details.");
    } finally {
      setSavingBank(false);
    }
  };

  const handleUploadDocument = async () => {
    if (!docForm.file || !docForm.title.trim()) {
      toast.error("Add a title and select a file.");
      return;
    }
    const fileCheck = validateStaffDocumentFile(docForm.file);
    if (!fileCheck.ok) {
      setDocError(fileCheck.error);
      toast.error(fileCheck.error);
      return;
    }
    setDocError("");
    setUploadingDoc(true);
    try {
      const formData = new FormData();
      formData.append("file", docForm.file);
      formData.append("employeeId", employeeId);
      formData.append("sourcePage", staffSourcePage);
      formData.append("section", "documents");
      formData.append("operation", "upload_document_file");
      formData.append("resultSummary", "Employee document file uploaded from staff profile.");
      const uploadRes = await fetch("/api/admin/hr/documents/upload", {
        method: "POST",
        body: formData,
      });
      const uploadBody = await uploadRes.json().catch(() => ({}));
      if (!uploadRes.ok) {
        toast.error(uploadBody.error || "Document upload failed.");
        return;
      }
      if (!uploadBody?.key) {
        toast.error("Upload response missing document reference.");
        return;
      }

      const createRes = await fetch("/api/admin/hr/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId,
          title: docForm.title,
          fileUrl: uploadBody.key,
          fileType: docForm.file.type,
          employeeVisible: docForm.employeeVisible,
          sourcePage: staffSourcePage,
          section: "documents",
          operation: "create_document",
          resultSummary: docForm.employeeVisible
            ? "Employee document added and made visible in the employee portal."
            : "Employee document added and kept hidden from the employee portal.",
        }),
      });
      const createBody = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        toast.error(createBody.error || "Failed to save document.");
        return;
      }
      toast.success("Document uploaded.");
      setDocForm({ title: "", file: null, employeeVisible: false });
      setDocumentDialogOpen(false);
      refreshProfileAndLeave();
    } catch {
      toast.error("Document upload failed.");
    } finally {
      setUploadingDoc(false);
    }
  };

  const handleDocumentVisibility = async (doc: EmployeeDocument, employeeVisible: boolean) => {
    try {
      const res = await fetch(`/api/admin/hr/documents/${doc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeVisible,
          sourcePage: staffSourcePage,
          section: "documents",
          operation: "update_employee_document_visibility",
          resultSummary: employeeVisible
            ? "Document is now visible in the employee portal."
            : "Document is now hidden from the employee portal.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update document visibility.");
        return;
      }
      toast.success(employeeVisible ? "Document is now visible in the portal." : "Document hidden from the portal.");
      refreshProfileAndLeave();
    } catch {
      toast.error("Failed to update document visibility.");
    }
  };

  const handleDeleteDocument = async (doc: EmployeeDocument) => {
    setDeletingDocId(doc.id);
    try {
      const res = await fetch(`/api/admin/hr/documents/${doc.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePage: staffSourcePage,
          section: "documents",
          operation: "delete_document",
          resultSummary: "Employee document removed from staff profile.",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to delete document.");
        return;
      }
      toast.success("Document deleted.");
      refreshProfileAndLeave();
    } catch {
      toast.error("Failed to delete document.");
    } finally {
      setDeletingDocId(null);
    }
  };

  const handleLeaveStatusUpdate = async (
    leave: LeaveRequest,
    nextStatus: LeaveRequest["status"],
    decisionNote = "",
  ) => {
    const operation =
      nextStatus === "APPROVED"
        ? "approve_leave_request"
        : nextStatus === "REJECTED"
          ? "reject_leave_request"
          : nextStatus === "CANCELLED"
            ? "cancel_leave_request"
            : "update_leave_request";
    setUpdatingLeaveId(leave.id);
    try {
      const res = await fetch(`/api/admin/hr/leave/${leave.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: nextStatus,
          expectedUpdatedAt: leave.updatedAt || "",
          decisionNote,
          sourcePage: staffSourcePage,
          section: "leave-summary",
          operation,
          resultSummary:
            decisionNote.trim().length > 0
              ? `Leave request updated from staff profile. Note: ${decisionNote.trim()}`
              : "Leave request updated from staff profile.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update leave request.");
        return;
      }
      toast.success("Leave request updated.");
      refreshProfileAndLeave();
    } catch {
      toast.error("Failed to update leave request.");
    } finally {
      setUpdatingLeaveId(null);
    }
  };

  if (employeeLoading) {
    return (
      <section className="space-y-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold">Staff Profile</h1>
            <p className="text-muted-foreground">Employee workspace, payroll context, and HR history.</p>
          </div>
          <Button asChild variant="outline">
            <Link href="/admin/hr/staff">Back to staff</Link>
          </Button>
        </header>
        <Card>
          <CardContent className="py-10">
            <p className="text-sm text-muted-foreground">Loading employee profile...</p>
          </CardContent>
        </Card>
      </section>
    );
  }

  if (employeeError?.status === 404) {
    return (
      <section className="space-y-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold">Staff Profile</h1>
            <p className="text-muted-foreground">Employee workspace, payroll context, and HR history.</p>
          </div>
          <Button asChild variant="outline">
            <Link href="/admin/hr/staff">Back to staff</Link>
          </Button>
        </header>
        <Card>
          <CardContent className="grid gap-4 py-10">
            <div className="text-lg font-semibold">Employee not found.</div>
            <p className="text-sm text-muted-foreground">
              The requested staff record could not be found. It may have been removed or the link may be outdated.
            </p>
            <div>
              <Button asChild variant="outline">
                <Link href="/admin/hr/staff">Return to staff list</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    );
  }

  if (employeeError || !profile) {
    return (
      <section className="space-y-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold">Staff Profile</h1>
            <p className="text-muted-foreground">Employee workspace, payroll context, and HR history.</p>
          </div>
          <Button asChild variant="outline">
            <Link href="/admin/hr/staff">Back to staff</Link>
          </Button>
        </header>
        <Card>
          <CardContent className="grid gap-4 py-10">
            <div className="text-lg font-semibold">Could not load employee profile.</div>
            <p className="text-sm text-muted-foreground">
              {employeeError?.message || "An unexpected error stopped this staff record from loading."}
            </p>
            <div>
              <Button variant="outline" onClick={() => void refetchEmployee()}>
                Retry
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className="min-w-0 space-y-6">
      <Card className="overflow-hidden border-slate-200 bg-gradient-to-br from-white via-slate-50 to-teal-50 dark:border-slate-800 dark:from-slate-950 dark:via-slate-900 dark:to-teal-950/70">
        <CardContent className="grid gap-6 p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                  Staff Workspace
                </span>
                <span className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-medium text-teal-700">
                  {formatStatusLabel(profile.status)}
                </span>
                {activeApprovedLeave ? (
                  <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/60 dark:text-amber-200">
                    On approved leave
                  </span>
                ) : null}
              </div>
              <div className="min-w-0">
                <h1 className="break-words text-3xl font-bold text-slate-950 dark:text-slate-50">
                  {profile.firstName} {profile.lastName}
                </h1>
                <p className="mt-2 max-w-3xl text-sm text-slate-600 dark:text-slate-300 sm:text-base">
                  Review staff readiness, update the live profile, and move between payroll, leave,
                  documents, and performance history from one place.
                </p>
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600 dark:text-slate-300">
                <span className="break-words">{profile.department || "Department not set"}</span>
                <span className="break-words">{profile.position || "Position not set"}</span>
                <span>Hire date: {formatOptionalDate(profile.hireDate)}</span>
                <span className="break-all">Employee ID: {employeeId}</span>
              </div>
              <div className="text-sm text-slate-600 dark:text-slate-300">
                {bankReady
                  ? "Payroll bank details are ready."
                  : `Payroll is blocked until ${bankMissingFields.join(", ")} ${bankMissingFields.length === 1 ? "is" : "are"} added.`}
              </div>
            </div>
            <div className="grid w-full gap-2 sm:grid-cols-2 xl:w-[23rem]">
              <Button asChild variant="outline" className="h-auto whitespace-normal justify-start bg-white/80 px-3 py-2 text-left dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800">
                <Link href={`/admin/hr/compensation?employeeId=${employeeId}`}>Open compensation history</Link>
              </Button>
              <Button asChild variant="outline" className="h-auto whitespace-normal justify-start bg-white/80 px-3 py-2 text-left dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800">
                <Link href={`/admin/hr/staff/${employeeId}/paystubs`}>Open all payslips</Link>
              </Button>
              <Button asChild variant="outline" className="h-auto whitespace-normal justify-start bg-white/80 px-3 py-2 text-left dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800">
                <Link href={`/admin/hr/payroll?employeeId=${employeeId}`}>Open payroll runs</Link>
              </Button>
              <Button asChild variant="outline" className="h-auto whitespace-normal justify-start bg-white/80 px-3 py-2 text-left dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800">
                <Link href={`/admin/hr/leave?employeeId=${employeeId}`}>Open leave history</Link>
              </Button>
              <Button asChild variant="outline" className="h-auto whitespace-normal justify-start bg-white/80 px-3 py-2 text-left dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800">
                <Link href={`/admin/hr/reviews?employeeId=${employeeId}`}>Open performance reviews</Link>
              </Button>
              <Button
                variant="outline"
                className="h-auto whitespace-normal justify-start bg-white/80 px-3 py-2 text-left dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800"
                onClick={handleCopyEmployeeLink}
              >
                Copy employee link
              </Button>
              <Button asChild variant="outline" className="h-auto whitespace-normal justify-start bg-white/80 px-3 py-2 text-left dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800 sm:col-span-2">
                <Link href={staffAuditHref}>Open employee audit</Link>
              </Button>
              <Button asChild variant="outline" className="h-auto whitespace-normal justify-start bg-white/80 px-3 py-2 text-left dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-100 dark:hover:bg-slate-800 sm:col-span-2">
                <Link href="/admin/hr/staff">Back to staff</Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white/85 p-4 dark:border-slate-800 dark:bg-slate-900/85">
              <div className="text-xs text-slate-500 dark:text-slate-400">Current compensation</div>
              <div className="mt-1 text-2xl font-semibold text-slate-950 dark:text-slate-50">
                {latestCompensation
                  ? formatCurrency(Number(latestCompensation.baseSalary || 0))
                  : "Not set"}
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {latestCompensation
                  ? `Effective ${new Date(latestCompensation.effectiveDate).toLocaleDateString()}`
                  : "No compensation record yet"}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white/85 p-4 dark:border-slate-800 dark:bg-slate-900/85">
              <div className="text-xs text-slate-500 dark:text-slate-400">Latest payslip</div>
              <div className="mt-1 text-2xl font-semibold text-slate-950 dark:text-slate-50">
                {latestPayslip ? formatCurrency(Number(latestPayslip.netPay || 0)) : "Not yet"}
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {latestPayslip
                  ? `Net pay from ${new Date(latestPayslip.createdAt).toLocaleDateString()}`
                  : "No payslip has been issued yet"}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white/85 p-4 dark:border-slate-800 dark:bg-slate-900/85">
              <div className="text-xs text-slate-500 dark:text-slate-400">Open issues</div>
              <div className="mt-1 text-2xl font-semibold text-slate-950 dark:text-slate-50">{openIssuesCount}</div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {issues.length > 0 ? `${issues.length} recent issue records` : "No issues recorded"}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white/85 p-4 dark:border-slate-800 dark:bg-slate-900/85">
              <div className="text-xs text-slate-500 dark:text-slate-400">Pending onboarding</div>
              <div className="mt-1 text-2xl font-semibold text-slate-950 dark:text-slate-50">{pendingOnboardingCount}</div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {onboardingTasks.length > 0 ? `${onboardingTasks.length} total onboarding tasks` : "No onboarding tasks yet"}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white/85 p-4 dark:border-slate-800 dark:bg-slate-900/85">
              <div className="text-xs text-slate-500 dark:text-slate-400">Pending leave requests</div>
              <div className="mt-1 text-2xl font-semibold text-slate-950 dark:text-slate-50">{leaveSummary.pending}</div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {activeApprovedLeave
                  ? `Active leave ends ${new Date(activeApprovedLeave.endDate).toLocaleDateString()}`
                  : "No active approved leave today"}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white/85 p-4 dark:border-slate-800 dark:bg-slate-900/85">
              <div className="text-xs text-slate-500 dark:text-slate-400">Bank details</div>
              <div className="mt-1 text-2xl font-semibold text-slate-950 dark:text-slate-50">
                {bankReady ? "Ready" : `${bankMissingFields.length} missing`}
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {bankReady ? "Ready for payroll exports" : bankMissingFields.join(", ")}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-12">
      <Card className="xl:col-span-7">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Employment Details</CardTitle>
            <p className="text-sm text-muted-foreground">
              Update the live staff record here, including status, manager, and employment notes.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {editingEmployment ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    resetEmploymentForm();
                    setEditingEmployment(false);
                  }}
                  disabled={savingEmployment}
                >
                  Cancel
                </Button>
                <Button size="sm" variant="outline" onClick={handleSaveEmployment} disabled={!isEmploymentDirty || savingEmployment}>
                  {savingEmployment ? "Saving..." : "Save employment details"}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setEditingEmployment(true)}>
                Edit
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm md:grid-cols-2">
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground">First name</label>
            <Input
              value={employmentForm.firstName}
              disabled={!editingEmployment}
              onChange={(e) => {
                const value = e.target.value;
                setEmploymentForm((prev) => ({ ...prev, firstName: value }));
                if (employmentErrors.firstName && value.trim()) {
                  setEmploymentErrors((prev) => {
                    const next = { ...prev };
                    delete next.firstName;
                    return next;
                  });
                }
              }}
            />
            {employmentErrors.firstName ? <p className="text-xs text-red-600">{employmentErrors.firstName}</p> : null}
          </div>
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground">Last name</label>
            <Input
              value={employmentForm.lastName}
              disabled={!editingEmployment}
              onChange={(e) => {
                const value = e.target.value;
                setEmploymentForm((prev) => ({ ...prev, lastName: value }));
                if (employmentErrors.lastName && value.trim()) {
                  setEmploymentErrors((prev) => {
                    const next = { ...prev };
                    delete next.lastName;
                    return next;
                  });
                }
              }}
            />
            {employmentErrors.lastName ? <p className="text-xs text-red-600">{employmentErrors.lastName}</p> : null}
          </div>
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground">Department</label>
            <Input
              value={employmentForm.department}
              disabled={!editingEmployment}
              onChange={(e) => setEmploymentForm((prev) => ({ ...prev, department: e.target.value }))}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground">Position</label>
            <Input
              value={employmentForm.position}
              disabled={!editingEmployment}
              onChange={(e) => setEmploymentForm((prev) => ({ ...prev, position: e.target.value }))}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground">Status</label>
            <select
              value={employmentForm.status}
              disabled={!editingEmployment}
              onChange={(e) =>
                setEmploymentForm((prev) => ({
                  ...prev,
                  status: e.target.value as EmployeeProfile["status"],
                  terminationDate:
                    e.target.value === "TERMINATED"
                      ? prev.terminationDate
                      : "",
                }))
              }
              className="border-input bg-background ring-offset-background focus-visible:ring-ring/50 flex h-10 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]"
            >
              <option value="ACTIVE">Active</option>
              <option value="ON_LEAVE">On leave</option>
              <option value="SUSPENDED">Suspended</option>
              <option value="TERMINATED">Terminated</option>
            </select>
          </div>
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground">Manager</label>
            <select
              value={employmentForm.managerId}
              disabled={!editingEmployment}
              onChange={(e) => setEmploymentForm((prev) => ({ ...prev, managerId: e.target.value }))}
              className="border-input bg-background ring-offset-background focus-visible:ring-ring/50 flex h-10 w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-[3px]"
            >
              <option value="">No manager assigned</option>
              {managerOptions.map((manager) => (
                <option key={manager.id} value={manager.id}>
                  {manager.firstName} {manager.lastName}
                </option>
              ))}
            </select>
            {selectedManager ? (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">
                  {selectedManager.firstName} {selectedManager.lastName}
                </div>
                <div className="mt-1">{getManagerRoleSummary(selectedManager)}</div>
                <div className="mt-1">Status: {formatStatusLabel(selectedManager.status)}</div>
                <Button asChild size="sm" variant="link" className="mt-2 h-auto justify-start px-0">
                  <Link href={`/admin/hr/staff/${selectedManager.id}`}>Open manager profile</Link>
                </Button>
              </div>
            ) : null}
          </div>
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground">Hire date</label>
            <Input
              type="date"
              value={employmentForm.hireDate}
              disabled={!editingEmployment}
              onChange={(e) => setEmploymentForm((prev) => ({ ...prev, hireDate: e.target.value }))}
            />
          </div>
          <div className="grid gap-1">
            <label className="text-xs text-muted-foreground">Termination date</label>
            <Input
              type="date"
              value={employmentForm.terminationDate}
              disabled={!editingEmployment || employmentForm.status !== "TERMINATED"}
              onChange={(e) => {
                const value = e.target.value;
                setEmploymentForm((prev) => ({ ...prev, terminationDate: value }));
                if (employmentErrors.terminationDate && value.trim()) {
                  setEmploymentErrors((prev) => {
                    const next = { ...prev };
                    delete next.terminationDate;
                    return next;
                  });
                }
              }}
            />
            {employmentErrors.terminationDate ? (
              <p className="text-xs text-red-600">{employmentErrors.terminationDate}</p>
            ) : null}
          </div>
          <div className="grid gap-1 md:col-span-2">
            <label className="text-xs text-muted-foreground">Notes</label>
            <Textarea
              rows={4}
              value={employmentForm.notes}
              disabled={!editingEmployment}
              onChange={(e) => setEmploymentForm((prev) => ({ ...prev, notes: e.target.value }))}
              placeholder="Add internal employment notes for this staff record."
            />
          </div>
        </CardContent>
      </Card>
      <Card className="xl:col-span-5">
        <CardHeader>
          <CardTitle>Profile Overview</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div className="text-xs text-muted-foreground">Status</div>
            <div className="mt-1 font-medium">
              {formatStatusLabel(profile.status)}
              {activeApprovedLeave ? (
                <span className="ml-2 rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:border-amber-900/80 dark:bg-amber-950/60 dark:text-amber-200">
                  Active leave
                </span>
              ) : null}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div className="text-xs text-muted-foreground">Department</div>
            <div className="mt-1 font-medium break-words">{profile.department || "Not provided"}</div>
          </div>
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div className="text-xs text-muted-foreground">Position</div>
            <div className="mt-1 font-medium break-words">{profile.position || "Not provided"}</div>
          </div>
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div className="text-xs text-muted-foreground">Contact</div>
            <div className="mt-1 font-medium break-all">{profile.email || "Not provided"}</div>
          </div>
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div className="text-xs text-muted-foreground">Phone</div>
            <div className="mt-1 font-medium break-words">{profile.phone || "Not provided"}</div>
          </div>
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div className="text-xs text-muted-foreground">Hire date</div>
            <div className="mt-1 font-medium">{formatOptionalDate(profile.hireDate)}</div>
          </div>
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div className="text-xs text-muted-foreground">Manager</div>
            <div className="mt-1 font-medium">
              {currentManager ? `${currentManager.firstName} ${currentManager.lastName}` : "Not assigned"}
            </div>
            {currentManager ? (
              <>
                <div className="mt-1 text-xs text-muted-foreground">
                  {getManagerRoleSummary(currentManager)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Status: {formatStatusLabel(currentManager.status)}
                </div>
                <Button asChild size="sm" variant="link" className="mt-2 h-auto p-0">
                  <Link href={`/admin/hr/staff/${currentManager.id}`}>Open manager profile</Link>
                </Button>
              </>
            ) : null}
          </div>
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 sm:col-span-2">
            <div className="text-xs text-muted-foreground">Termination date</div>
            <div className="mt-1 font-medium">{formatOptionalDate(profile.terminationDate)}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="xl:col-span-6">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Contact Details</CardTitle>
          <div className="flex flex-wrap gap-2">
            {editingContact ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    resetContactForm();
                    setEditingContact(false);
                  }}
                  disabled={savingContact}
                >
                  Cancel
                </Button>
                <Button size="sm" variant="outline" onClick={handleSaveContact} disabled={!isContactDirty || savingContact}>
                  {savingContact ? "Saving..." : "Save contact"}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setEditingContact(true)}>
                Edit
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="grid gap-1">
            <Input
              placeholder="Email address"
              value={contactForm.email}
              disabled={!editingContact}
              onChange={(e) => setContactForm((prev) => ({ ...prev, email: e.target.value }))}
            />
            {contactErrors.email ? <p className="text-xs text-red-600">{contactErrors.email}</p> : null}
          </div>
          <div className="grid gap-1">
            <Input
              placeholder="Phone number"
              value={contactForm.phone}
              disabled={!editingContact}
              onChange={(e) => setContactForm((prev) => ({ ...prev, phone: e.target.value }))}
            />
            {contactErrors.phone ? <p className="text-xs text-red-600">{contactErrors.phone}</p> : null}
          </div>
        </CardContent>
      </Card>

      <Card className="xl:col-span-6">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Payroll Details</CardTitle>
          <div className="flex flex-wrap gap-2">
            {editingBank ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    resetBankForm();
                    setEditingBank(false);
                  }}
                  disabled={savingBank}
                >
                  Cancel
                </Button>
                <Button size="sm" variant="outline" onClick={handleSaveBank} disabled={!isBankDirty || savingBank}>
                  {savingBank ? "Saving..." : "Save bank details"}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setEditingBank(true)}>
                Edit
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="grid gap-1">
            <Input
              placeholder="Bank name"
              value={bankForm.bankName}
              disabled={!editingBank}
              onChange={(e) => {
                const value = e.target.value;
                setBankForm((prev) => ({ ...prev, bankName: value }));
                if (bankErrors.bankName && value.trim()) {
                  setBankErrors((prev) => {
                    const next = { ...prev };
                    delete next.bankName;
                    return next;
                  });
                }
              }}
            />
            {bankErrors.bankName ? (
              <p className="text-xs text-red-600">{bankErrors.bankName}</p>
            ) : null}
          </div>
          <div className="grid gap-1">
            <Input
              placeholder="Bank code"
              value={bankForm.bankCode}
              disabled={!editingBank}
              onChange={(e) => setBankForm((prev) => ({ ...prev, bankCode: e.target.value }))}
            />
            {bankErrors.bankCode ? (
              <p className="text-xs text-red-600">{bankErrors.bankCode}</p>
            ) : null}
          </div>
          <div className="grid gap-1">
            <Input
              placeholder="Account name"
              value={bankForm.bankAccountName}
              disabled={!editingBank}
              onChange={(e) => {
                const value = e.target.value;
                setBankForm((prev) => ({ ...prev, bankAccountName: value }));
                if (bankErrors.bankAccountName && value.trim()) {
                  setBankErrors((prev) => {
                    const next = { ...prev };
                    delete next.bankAccountName;
                    return next;
                  });
                }
              }}
            />
            {bankErrors.bankAccountName ? (
              <p className="text-xs text-red-600">{bankErrors.bankAccountName}</p>
            ) : null}
          </div>
          <div className="grid gap-1">
            <Input
              placeholder="Account number"
              value={bankForm.bankAccountNumber}
              disabled={!editingBank}
              onChange={(e) => {
                const value = e.target.value;
                setBankForm((prev) => ({ ...prev, bankAccountNumber: value }));
                if (bankErrors.bankAccountNumber && value.trim()) {
                  setBankErrors((prev) => {
                    const next = { ...prev };
                    delete next.bankAccountNumber;
                    return next;
                  });
                }
              }}
            />
            {bankErrors.bankAccountNumber ? (
              <p className="text-xs text-red-600">{bankErrors.bankAccountNumber}</p>
            ) : null}
          </div>
          <div className="grid gap-1">
                <Input
                  placeholder="Branch"
                  value={bankForm.bankBranch}
                  disabled={!editingBank}
                  onChange={(e) => setBankForm((prev) => ({ ...prev, bankBranch: e.target.value }))}
                />
          </div>
        </CardContent>
      </Card>

      <Card className="xl:col-span-7">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Documents</CardTitle>
            <p className="text-sm text-muted-foreground">
              Recent employee documents. Add new files through the upload dialog to avoid accidental partial input on the page.
            </p>
          </div>
          <Dialog open={documentDialogOpen} onOpenChange={setDocumentDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">Add document</Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Add employee document</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3">
                <Input
                  placeholder="Document title"
                  value={docForm.title}
                  onChange={(e) => setDocForm((prev) => ({ ...prev, title: e.target.value }))}
                />
                <Input
                  type="file"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setDocForm((prev) => ({ ...prev, file }));
                    setDocError("");
                  }}
                />
                {docError ? <p className="text-xs text-red-600">{docError}</p> : null}
                {docForm.file ? (
                  <p className="break-all text-xs text-muted-foreground">
                    Selected file: {docForm.file.name} ({Math.round(docForm.file.size / 1024)} KB)
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Upload a PDF, Word document, or image up to 10 MB.
                  </p>
                )}
                <label className="flex items-start gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={docForm.employeeVisible}
                    onChange={(e) =>
                      setDocForm((prev) => ({ ...prev, employeeVisible: e.target.checked }))
                    }
                  />
                  <span>
                    <span className="font-medium text-foreground">Visible in employee portal</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Only enable this when the employee should be allowed to download the document from self-service.
                    </span>
                  </span>
                </label>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setDocumentDialogOpen(false);
                      setDocError("");
                      setDocForm({ title: "", file: null, employeeVisible: false });
                    }}
                    disabled={uploadingDoc}
                  >
                    Cancel
                  </Button>
                  <Button type="button" onClick={handleUploadDocument} disabled={uploadingDoc}>
                    {uploadingDoc ? "Uploading..." : "Save document"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {documents.length === 0 ? (
            <div className="grid gap-3 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
              <p>No documents uploaded yet.</p>
              <p>Add contracts, IDs, or compliance files with the <span className="font-medium text-foreground">Add document</span> action above.</p>
            </div>
          ) : (
            <div className="grid gap-2 text-sm">
              {documents.slice(0, visibleDocumentCount).map((doc) => (
                <div key={doc.id} className="flex flex-col gap-3 rounded border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="font-medium break-words">{doc.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {doc.fileType || "Document"} -{" "}
                      {doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString() : "Not provided"}
                    </div>
                    <div className="mt-1 text-xs">
                      {doc.employeeVisible ? (
                        <span className="font-medium text-emerald-700 dark:text-emerald-400">
                          Visible in employee portal
                        </span>
                      ) : (
                        <span className="font-medium text-amber-700 dark:text-amber-400">
                          Hidden from employee portal
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:justify-end">
                    <Button asChild size="sm" variant="secondary">
                      <a
                        href={appendAuditMetaParams(`/api/admin/hr/documents/${doc.id}/download`, {
                          sourcePage: staffSourcePage,
                          section: "documents",
                          operation: "download_document",
                          resultSummary: "Employee document download started from staff profile.",
                        })}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View
                      </a>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleDocumentVisibility(doc, !doc.employeeVisible)}
                    >
                      {doc.employeeVisible ? "Hide from portal" : "Show in portal"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDocDeleteDialog(doc)}
                      disabled={deletingDocId === doc.id}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
              {documents.length > visibleDocumentCount ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    Showing {Math.min(visibleDocumentCount, documents.length)} of {documents.length} documents
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setVisibleDocumentCount((prev) => prev + 5)}
                    >
                      Show more documents
                    </Button>
                    {visibleDocumentCount > 5 ? (
                      <Button size="sm" variant="ghost" onClick={() => setVisibleDocumentCount(5)}>
                        Show fewer documents
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : visibleDocumentCount > 5 && documents.length > 5 ? (
                <Button size="sm" variant="ghost" onClick={() => setVisibleDocumentCount(5)}>
                  Show fewer documents
                </Button>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="xl:col-span-5">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Performance Reviews</CardTitle>
            <p className="text-sm text-muted-foreground">Latest review first, with direct access to the full employee review history.</p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/hr/reviews?employeeId=${employeeId}`}>Open reviews</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {reviews.length === 0 ? (
            <div className="grid gap-3 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
              <p>No reviews recorded yet.</p>
              <p>Use <span className="font-medium text-foreground">Open reviews</span> to add the first performance review for this employee.</p>
            </div>
          ) : (
            <div className="grid gap-3 text-sm">
              <div className="rounded border px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">
                      {new Date(reviews[0].periodStart).toLocaleDateString()} -{" "}
                      {new Date(reviews[0].periodEnd).toLocaleDateString()}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Latest review - {reviews[0].rating.replace("_", " ")}
                    </div>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-muted-foreground">
                  <div>
                    <span className="font-semibold text-foreground">Summary:</span>{" "}
                    {reviews[0].summary || "Not provided"}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Strengths:</span>{" "}
                    {reviews[0].strengths || "Not provided"}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Improvements:</span>{" "}
                    {reviews[0].improvements || "Not provided"}
                  </div>
                  <div>
                    <span className="font-semibold text-foreground">Goals:</span>{" "}
                    {reviews[0].goals || "Not provided"}
                  </div>
                </div>
              </div>
              {reviews.slice(1, visibleReviewCount).map((review) => (
                <div key={review.id} className="flex flex-wrap items-center justify-between gap-3 rounded border px-3 py-2">
                  <div>
                    <div className="font-medium">
                      {new Date(review.periodStart).toLocaleDateString()} -{" "}
                      {new Date(review.periodEnd).toLocaleDateString()}
                    </div>
                    <div className="text-xs text-muted-foreground">{review.summary || "No summary"}</div>
                  </div>
                  <div className="text-xs font-semibold">{review.rating.replace("_", " ")}</div>
                </div>
              ))}
              {reviews.length > visibleReviewCount ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    Showing {visibleReviewCount} of {reviews.length} reviews
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setVisibleReviewCount((prev) => prev + 3)}>
                      Show more reviews
                    </Button>
                    {visibleReviewCount > 4 ? (
                      <Button size="sm" variant="ghost" onClick={() => setVisibleReviewCount(4)}>
                        Show fewer reviews
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : visibleReviewCount > 4 && reviews.length > 4 ? (
                <Button size="sm" variant="ghost" onClick={() => setVisibleReviewCount(4)}>
                  Show fewer reviews
                </Button>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="xl:col-span-5">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Leave Summary (YTD)</CardTitle>
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/hr/leave?employeeId=${employeeId}`}>Open leave for employee</Link>
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded border px-3 py-2 sm:col-span-2">
            <div className="text-xs text-muted-foreground">Current leave state</div>
            <div className="font-medium">
              {activeApprovedLeave
                ? `On approved leave through ${new Date(activeApprovedLeave.endDate).toLocaleDateString()}`
                : "No active approved leave today"}
            </div>
          </div>
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Annual leave approved/used</div>
            <div className="font-medium">
              {leaveSummary.approvedTotals.ANNUAL}/{leaveSummary.usedTotals.ANNUAL} days
            </div>
          </div>
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Sick leave approved/used</div>
            <div className="font-medium">
              {leaveSummary.approvedTotals.SICK}/{leaveSummary.usedTotals.SICK} days
            </div>
          </div>
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Unpaid leave approved/used</div>
            <div className="font-medium">
              {leaveSummary.approvedTotals.UNPAID}/{leaveSummary.usedTotals.UNPAID} days
            </div>
          </div>
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Other leave approved/used</div>
            <div className="font-medium">
              {leaveSummary.approvedTotals.OTHER}/{leaveSummary.usedTotals.OTHER} days
            </div>
          </div>
          <div className="rounded border px-3 py-2 sm:col-span-2">
            <div className="text-xs text-muted-foreground">Pending requests</div>
            <div className="font-medium">{leaveSummary.pending}</div>
          </div>
          {leaveRequests.filter((row) => row.status === "REQUESTED").slice(0, 3).map((row) => (
            <div key={row.id} className="rounded border px-3 py-2 sm:col-span-2">
              <div className="text-xs text-muted-foreground">
                Request: {new Date(row.startDate).toLocaleDateString()} - {new Date(row.endDate).toLocaleDateString()}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={updatingLeaveId === row.id}
                  onClick={() => handleLeaveStatusUpdate(row, "APPROVED")}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={updatingLeaveId === row.id}
                  onClick={() =>
                    setLeaveDecision({
                      open: true,
                      leave: row,
                      status: "REJECTED",
                      note: "",
                    })
                  }
                >
                  Reject
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={updatingLeaveId === row.id}
                  onClick={() =>
                    setLeaveDecision({
                      open: true,
                      leave: row,
                      status: "CANCELLED",
                      note: "",
                    })
                  }
                >
                  Cancel
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="xl:col-span-7">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Onboarding Checklist</CardTitle>
          <Dialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">Add Task</Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Add Onboarding Task</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3">
                <Input
                  placeholder="Task title"
                  value={taskForm.title}
                  onChange={(e) => setTaskForm((prev) => ({ ...prev, title: e.target.value }))}
                />
                <Input
                  type="date"
                  value={taskForm.dueDate}
                  onChange={(e) => setTaskForm((prev) => ({ ...prev, dueDate: e.target.value }))}
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={handleCreateTask} disabled={creatingTask}>
                  {creatingTask ? "Saving..." : "Save task"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {onboardingTasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No onboarding tasks yet.</p>
          ) : (
            <div className="grid gap-2 text-sm">
              {onboardingTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex flex-col gap-3 rounded border px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <input
                      type="checkbox"
                      checked={task.status === "COMPLETE"}
                      disabled={savingTaskId === task.id}
                      onChange={(e) =>
                        handleToggleTask(task, e.target.checked ? "COMPLETE" : "PENDING")
                      }
                      className="mt-0.5 shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="font-medium break-words">{task.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {task.dueDate ? `Due ${new Date(task.dueDate).toLocaleDateString()}` : "No due date"}
                      </div>
                    </div>
                  </div>
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                    <div className="text-xs text-muted-foreground">
                      {task.status === "COMPLETE" ? "Completed" : "Pending"}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setEditTaskDialog({
                          open: true,
                          id: task.id,
                          title: task.title,
                          dueDate: task.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : "",
                          updatedAt: task.updatedAt || "",
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={deletingTaskId === task.id}
                      onClick={() => setTaskDeleteDialog(task)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      </div>

      <Dialog open={employmentConfirmOpen} onOpenChange={setEmploymentConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm employment status change</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <p className="text-muted-foreground">
              You are changing this employee from {formatStatusLabel(profile.status)} to{" "}
              {formatStatusLabel(employmentForm.status)}.
            </p>
            <div className="rounded border px-3 py-3 text-xs text-muted-foreground">
              <div>Employee: {profile.firstName} {profile.lastName}</div>
              <div>Current status: {formatStatusLabel(profile.status)}</div>
              <div>New status: {formatStatusLabel(employmentForm.status)}</div>
              <div>
                Termination date: {employmentForm.terminationDate || "Not set"}
              </div>
            </div>
            <p className="text-muted-foreground">
              Continue only if this status update is correct. The change will be audit-logged from this staff page.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setEmploymentConfirmOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void submitEmploymentUpdate()} disabled={savingEmployment}>
                {savingEmployment ? "Saving..." : "Confirm change"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editTaskDialog.open}
        onOpenChange={(open) =>
          setEditTaskDialog((prev) => ({
            ...prev,
            open,
            ...(open ? {} : { id: "", title: "", dueDate: "", updatedAt: "" }),
          }))
        }
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Onboarding Task</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <Input
              placeholder="Task title"
              value={editTaskDialog.title}
              onChange={(e) => setEditTaskDialog((prev) => ({ ...prev, title: e.target.value }))}
            />
            <Input
              type="date"
              value={editTaskDialog.dueDate}
              onChange={(e) => setEditTaskDialog((prev) => ({ ...prev, dueDate: e.target.value }))}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setEditTaskDialog({
                    open: false,
                    id: "",
                    title: "",
                    dueDate: "",
                    updatedAt: "",
                  })
                }
              >
                Cancel
              </Button>
              <Button type="button" onClick={handleSaveTaskEdit} disabled={!editTaskDialog.id || savingTaskId === editTaskDialog.id}>
                {savingTaskId === editTaskDialog.id ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(taskDeleteDialog)}
        onOpenChange={(open) => {
          if (!open) setTaskDeleteDialog(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete onboarding task</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Remove this onboarding task from the employee profile?
            </p>
            <div className="text-sm font-medium">{taskDeleteDialog?.title || ""}</div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setTaskDeleteDialog(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={!taskDeleteDialog || deletingTaskId === taskDeleteDialog.id}
                onClick={async () => {
                  if (!taskDeleteDialog) return;
                  const target = taskDeleteDialog;
                  setTaskDeleteDialog(null);
                  await handleDeleteTask(target);
                }}
              >
                Delete task
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(docDeleteDialog)}
        onOpenChange={(open) => {
          if (!open) setDocDeleteDialog(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete document</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              This removes the document record from the employee profile and should only be used when the file was added by mistake or is no longer valid.
            </p>
            <div className="rounded border border-border bg-muted/40 px-3 py-3 text-xs text-muted-foreground">
              <div className="font-medium text-foreground">{docDeleteDialog?.title || ""}</div>
              <div className="mt-1">Type: {docDeleteDialog?.fileType || "Document"}</div>
              <div className="mt-1">
                Uploaded: {docDeleteDialog?.uploadedAt ? new Date(docDeleteDialog.uploadedAt).toLocaleDateString() : "Not provided"}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setDocDeleteDialog(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={!docDeleteDialog || deletingDocId === docDeleteDialog.id}
                onClick={async () => {
                  if (!docDeleteDialog) return;
                  const target = docDeleteDialog;
                  setDocDeleteDialog(null);
                  await handleDeleteDocument(target);
                }}
              >
                Delete document permanently
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="grid gap-6 xl:grid-cols-12">
      <Card className="xl:col-span-6">
        <CardHeader>
          <CardTitle>Compensation History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-3 md:hidden">
            {profile.compensations.length === 0 ? (
              <div className="rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">
                No compensation records yet.
              </div>
            ) : (
              profile.compensations.map((comp) => (
                <div key={comp.id} className="rounded-lg border p-3 text-sm">
                  <div className="font-medium">
                    Effective {new Date(comp.effectiveDate).toLocaleDateString()}
                  </div>
                  <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div>
                      Base: <span className="font-medium">{formatCurrency(Number(comp.baseSalary || 0))}</span>
                    </div>
                    <div>
                      Allowances: <span className="font-medium">{formatCurrency(Number(comp.allowances || 0))}</span>
                    </div>
                    <div>
                      Deductions: <span className="font-medium">{formatCurrency(Number(comp.deductions || 0))}</span>
                    </div>
                    <div>
                      Bonus: <span className="font-medium">{formatCurrency(Number(comp.bonus || 0))}</span>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Note: {comp.note || "Not provided"}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Effective</TableHead>
                  <TableHead>Base</TableHead>
                  <TableHead>Allowances</TableHead>
                  <TableHead>Deductions</TableHead>
                  <TableHead>Bonus</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {profile.compensations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                      No compensation records yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  profile.compensations.map((comp) => (
                    <TableRow key={comp.id}>
                      <TableCell>{new Date(comp.effectiveDate).toLocaleDateString()}</TableCell>
                      <TableCell>{formatCurrency(Number(comp.baseSalary || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(comp.allowances || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(comp.deductions || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(comp.bonus || 0))}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {comp.note || "Not provided"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="xl:col-span-6">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Recent Payslips</CardTitle>
            <p className="text-sm text-muted-foreground">Showing the latest issued payslips for this employee.</p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/hr/staff/${employeeId}/paystubs`}>Open all payslips</Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-3 md:hidden">
            {payslips.length === 0 ? (
              <div className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                No payslips found.
              </div>
            ) : (
              payslips.slice(0, visiblePayslipCount).map((slip) => (
                <div key={slip.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">
                        Run {slip.payrollRun?.id ? slip.payrollRun.id.slice(0, 8) : "Not set"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Created {new Date(slip.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="text-right text-xs">
                      <div>
                        Gross: <span className="font-medium">{formatCurrency(Number(slip.grossPay || 0))}</span>
                      </div>
                      <div>
                        Net: <span className="font-medium">{formatCurrency(Number(slip.netPay || 0))}</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button asChild size="sm" variant="secondary">
                      <Link href={`/admin/hr/paystubs/${slip.id}`}>View</Link>
                    </Button>
                    {slip.payrollRun?.id ? (
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/admin/hr/payroll/${slip.payrollRun.id}`}>Run</Link>
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Gross</TableHead>
                  <TableHead>Net</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payslips.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                      No payslips found.
                    </TableCell>
                  </TableRow>
                ) : (
                  payslips.slice(0, visiblePayslipCount).map((slip) => (
                    <TableRow key={slip.id}>
                      <TableCell className="text-xs text-muted-foreground">
                        {slip.payrollRun?.id ? slip.payrollRun.id.slice(0, 8) : "Not set"}
                      </TableCell>
                      <TableCell>{formatCurrency(Number(slip.grossPay || 0))}</TableCell>
                      <TableCell>{formatCurrency(Number(slip.netPay || 0))}</TableCell>
                      <TableCell>{new Date(slip.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell className="flex flex-wrap gap-2">
                        <Button asChild size="sm" variant="secondary">
                          <Link href={`/admin/hr/paystubs/${slip.id}`}>View</Link>
                        </Button>
                        {slip.payrollRun?.id ? (
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/admin/hr/payroll/${slip.payrollRun.id}`}>Run</Link>
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {payslips.length > visiblePayslipCount ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Showing {Math.min(visiblePayslipCount, payslips.length)} of {payslips.length} payslips
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => setVisiblePayslipCount((prev) => prev + 4)}>
                  Show more payslips
                </Button>
                {visiblePayslipCount > 4 ? (
                  <Button size="sm" variant="ghost" onClick={() => setVisiblePayslipCount(4)}>
                    Show fewer payslips
                  </Button>
                ) : null}
              </div>
            </div>
          ) : visiblePayslipCount > 4 && payslips.length > 4 ? (
            <Button size="sm" variant="ghost" onClick={() => setVisiblePayslipCount(4)}>
              Show fewer payslips
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card className="xl:col-span-6">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Staff Issues</CardTitle>
            <p className="text-sm text-muted-foreground">Latest issue records for this employee.</p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/hr/issues?employeeId=${employeeId}`}>Open employee issues</Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-3 md:hidden">
            {issues.length === 0 ? (
              <div className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                <p>No issues recorded.</p>
                <p className="mt-2">Use <span className="font-medium text-foreground">Open employee issues</span> if you need to log the first issue.</p>
              </div>
            ) : (
              issues.slice(0, visibleIssueCount).map((issue) => (
                <div key={issue.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{issue.type}</div>
                      <div className="text-xs text-muted-foreground">
                        Logged {new Date(issue.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="text-right text-xs">
                      <div>
                        Severity: <span className="font-medium">{issue.severity}</span>
                      </div>
                      <div>
                        Status: <span className="font-medium">{issue.status}</span>
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Closed: {issue.closedAt ? new Date(issue.closedAt).toLocaleDateString() : "Not set"}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Logged</TableHead>
                  <TableHead>Closed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {issues.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                      No issues recorded.
                    </TableCell>
                  </TableRow>
                ) : (
                  issues.slice(0, visibleIssueCount).map((issue) => (
                    <TableRow key={issue.id}>
                      <TableCell>{issue.type}</TableCell>
                      <TableCell>{issue.severity}</TableCell>
                      <TableCell>{issue.status}</TableCell>
                      <TableCell>{new Date(issue.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        {issue.closedAt ? new Date(issue.closedAt).toLocaleDateString() : "Not set"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {issues.length > visibleIssueCount ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Showing {Math.min(visibleIssueCount, issues.length)} of {issues.length} issues
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => setVisibleIssueCount((prev) => prev + 4)}>
                  Show more issues
                </Button>
                {visibleIssueCount > 4 ? (
                  <Button size="sm" variant="ghost" onClick={() => setVisibleIssueCount(4)}>
                    Show fewer issues
                  </Button>
                ) : null}
              </div>
            </div>
          ) : visibleIssueCount > 4 && issues.length > 4 ? (
            <Button size="sm" variant="ghost" onClick={() => setVisibleIssueCount(4)}>
              Show fewer issues
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card className="xl:col-span-6">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Recent Profile Activity</CardTitle>
            <p className="text-sm text-muted-foreground">Employee updates, document actions, and leave decisions tied to this staff record.</p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={staffAuditHref}>View full audit log</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {activityItems.length === 0 ? (
            <div className="grid gap-3 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
              <p>No recent profile activity yet.</p>
              <p>Profile edits, leave decisions, and document actions for this employee will appear here.</p>
            </div>
          ) : (
            <div className="grid gap-3 text-sm">
              {activityItems.slice(0, visibleActivityCount).map((item) => (
                <div key={item.id} className="rounded border px-3 py-2">
                  <div className="font-medium">{item.action.replaceAll("_", " ")}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()} -{" "}
                    {item.actor?.name || item.actor?.email || "System"}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                    {item.meta?.section ? (
                      <span className="rounded-full border px-2 py-0.5 text-muted-foreground">
                        {String(item.meta.section).replaceAll("-", " ")}
                      </span>
                    ) : null}
                    {item.meta?.operation ? (
                      <span className="rounded-full border px-2 py-0.5 text-muted-foreground">
                        {String(item.meta.operation).replaceAll("_", " ")}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 break-words text-xs text-muted-foreground">
                    {(item.meta?.resultSummary as string | undefined) || "Completed."}
                  </div>
                </div>
              ))}
              {activityItems.length > visibleActivityCount ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    Showing {Math.min(visibleActivityCount, activityItems.length)} of {activityItems.length} activity items
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setVisibleActivityCount((prev) => prev + 4)}
                    >
                      Show more activity
                    </Button>
                    {visibleActivityCount > 4 ? (
                      <Button size="sm" variant="ghost" onClick={() => setVisibleActivityCount(4)}>
                        Show fewer activity items
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : visibleActivityCount > 4 && activityItems.length > 4 ? (
                <Button size="sm" variant="ghost" onClick={() => setVisibleActivityCount(4)}>
                  Show fewer activity items
                </Button>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
      </div>

      <Dialog
        open={leaveDecision.open}
        onOpenChange={(open) =>
          setLeaveDecision((prev) => ({
            ...prev,
            open,
            ...(open ? {} : { leave: null, status: null, note: "" }),
          }))
        }
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {leaveDecision.status === "REJECTED" ? "Reject leave request" : "Cancel leave request"}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Add a short decision note for audit (minimum 3 characters).
            </p>
            <Input
              placeholder="Decision note"
              value={leaveDecision.note}
              onChange={(e) => setLeaveDecision((prev) => ({ ...prev, note: e.target.value }))}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setLeaveDecision({
                    open: false,
                    leave: null,
                    status: null,
                    note: "",
                  })
                }
              >
                Close
              </Button>
              <Button
                type="button"
                onClick={async () => {
                  if (!leaveDecision.leave || !leaveDecision.status) return;
                  const note = leaveDecision.note.trim();
                  if (note.length < 3) {
                    toast.error("A short note is required.");
                    return;
                  }
                  const leave = leaveDecision.leave;
                  const status = leaveDecision.status;
                  setLeaveDecision({
                    open: false,
                    leave: null,
                    status: null,
                    note: "",
                  });
                  await handleLeaveStatusUpdate(leave, status, note);
                }}
              >
                Confirm
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
