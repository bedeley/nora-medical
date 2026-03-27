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
import { formatCurrency } from "@/lib/currency";
import {
  validateStaffBankInput,
  validateStaffContactInput,
  validateStaffDocumentFile,
} from "@/lib/hr-staff-profile-utils";
import { appendAuditMetaParams, buildAdminAuditHref } from "@/lib/admin-audit-links";

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
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankCode?: string | null;
  bankBranch?: string | null;
  compensations: Compensation[];
  issues?: Issue[];
  onboardingTasks?: OnboardingTask[];
};

type StaffActivityItem = {
  id: string;
  action: string;
  createdAt: string;
  actor?: { name?: string | null; email?: string | null; role?: string | null } | null;
  meta?: { resultSummary?: string; section?: string; operation?: string } | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function StaffProfilePage() {
  const params = useParams();
  const queryClient = useQueryClient();
  const employeeId = useMemo(() => String(params?.id ?? ""), [params]);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: "", dueDate: "" });
  const [contactForm, setContactForm] = useState({ email: "", phone: "" });
  const [contactErrors, setContactErrors] = useState<Record<string, string>>({});
  const [bankForm, setBankForm] = useState({
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
    bankCode: "",
    bankBranch: "",
  });
  const [bankErrors, setBankErrors] = useState<Record<string, string>>({});
  const [docForm, setDocForm] = useState({ title: "", file: null as File | null });
  const [docError, setDocError] = useState("");
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
  const [visibleActivityCount, setVisibleActivityCount] = useState(10);
  const staffSourcePage = useMemo(() => `/admin/hr/staff/${employeeId}`, [employeeId]);

  const { data: employee } = useQuery({
    queryKey: ["admin", "hr", "employee", employeeId],
    queryFn: () => fetcher(`/api/admin/hr/employees/${employeeId}`),
    enabled: Boolean(employeeId),
  });

  const { data: payslipsData } = useQuery({
    queryKey: ["admin", "hr", "employee", employeeId, "payslips"],
    queryFn: () => fetcher(`/api/admin/hr/payslips?employeeId=${employeeId}`),
    enabled: Boolean(employeeId),
  });

  const { data: documentsData } = useQuery({
    queryKey: ["admin", "hr", "documents", employeeId],
    queryFn: () => fetcher(`/api/admin/hr/documents?employeeId=${employeeId}`),
    enabled: Boolean(employeeId),
  });

  const { data: reviewsData } = useQuery({
    queryKey: ["admin", "hr", "reviews", employeeId],
    queryFn: () => fetcher(`/api/admin/hr/reviews?employeeId=${employeeId}`),
    enabled: Boolean(employeeId),
  });

  const { data: leaveData } = useQuery({
    queryKey: ["admin", "hr", "leave", employeeId],
    queryFn: () => fetcher(`/api/admin/hr/leave?employeeId=${employeeId}&page=1&pageSize=200`),
    enabled: Boolean(employeeId),
  });

  const { data: settingsData } = useQuery({
    queryKey: ["admin", "hr", "settings", "workweekDays"],
    queryFn: () => fetcher("/api/admin/hr/settings?keys=hr.workweekDays"),
  });
  const { data: activityData } = useQuery({
    queryKey: ["admin", "hr", "staff", employeeId, "activity"],
    queryFn: () =>
      fetcher(
        `/api/admin/audit?entityType=EMPLOYEE&entityId=${employeeId}&limit=50`,
      ),
    enabled: Boolean(employeeId),
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
    setVisibleActivityCount(10);
  }, [employeeId]);

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

  const isContactDirty = useMemo(
    () => Boolean(profile) && (contactForm.email !== (profile?.email || "") || contactForm.phone !== (profile?.phone || "")),
    [contactForm.email, contactForm.phone, profile],
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
      formData.append("sourcePage", staffSourcePage);
      formData.append("section", "documents");
      formData.append("operation", "upload_document_file");
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
          sourcePage: staffSourcePage,
          section: "documents",
          operation: "create_document",
          resultSummary: "Employee document added from staff profile.",
        }),
      });
      const createBody = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        toast.error(createBody.error || "Failed to save document.");
        return;
      }
      toast.success("Document uploaded.");
      setDocForm({ title: "", file: null });
      refreshProfileAndLeave();
    } catch {
      toast.error("Document upload failed.");
    } finally {
      setUploadingDoc(false);
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

  if (!profile) {
    return (
      <section className="space-y-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold">Staff Profile</h1>
            <p className="text-muted-foreground">Employee details and history.</p>
          </div>
          <Button asChild variant="outline">
            <Link href="/admin/hr/staff">Back to staff</Link>
          </Button>
        </header>
        <p className="text-sm text-muted-foreground">Loading employee profile...</p>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">
            {profile.firstName} {profile.lastName}
          </h1>
          <p className="text-muted-foreground">Employee profile and HR history.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/hr/compensation">Compensation</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/admin/hr/payroll?employeeId=${employeeId}`}>Payroll runs</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/hr/staff">Back to staff</Link>
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Status</div>
            <div className="font-medium">
              {profile.status}
              {activeApprovedLeave ? (
                <span className="ml-2 rounded border px-2 py-0.5 text-xs text-amber-700">
                  Active leave
                </span>
              ) : null}
            </div>
            <div className="text-xs text-muted-foreground">Department</div>
            <div className="font-medium">{profile.department || "Not provided"}</div>
            <div className="text-xs text-muted-foreground">Position</div>
            <div className="font-medium">{profile.position || "Not provided"}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Contact</div>
            <div className="font-medium">{profile.email || "Not provided"}</div>
            <div className="text-xs text-muted-foreground">Phone</div>
            <div className="font-medium">{profile.phone || "Not provided"}</div>
            <div className="text-xs text-muted-foreground">Hire date</div>
            <div className="font-medium">
              {profile.hireDate ? new Date(profile.hireDate).toLocaleDateString() : "Not provided"}
            </div>
            <div className="text-xs text-muted-foreground">Termination date</div>
            <div className="font-medium">
              {profile.terminationDate ? new Date(profile.terminationDate).toLocaleDateString() : "Not provided"}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/hr/reviews?employeeId=${employeeId}`}>Open reviews for employee</Link>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleCopyEmployeeLink}
          >
            Copy employee link
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link
              href={buildAdminAuditHref({
                entityType: "EMPLOYEE",
                entityId: employeeId,
                sourcePage: staffSourcePage,
              })}
            >
              Open employee audit
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Contact Details</CardTitle>
          <Button size="sm" variant="outline" onClick={handleSaveContact} disabled={!isContactDirty || savingContact}>
            {savingContact ? "Saving..." : "Save contact"}
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="grid gap-1">
            <Input
              placeholder="Email address"
              value={contactForm.email}
              onChange={(e) => setContactForm((prev) => ({ ...prev, email: e.target.value }))}
            />
            {contactErrors.email ? <p className="text-xs text-red-600">{contactErrors.email}</p> : null}
          </div>
          <div className="grid gap-1">
            <Input
              placeholder="Phone number"
              value={contactForm.phone}
              onChange={(e) => setContactForm((prev) => ({ ...prev, phone: e.target.value }))}
            />
            {contactErrors.phone ? <p className="text-xs text-red-600">{contactErrors.phone}</p> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Payroll Details</CardTitle>
          <Button size="sm" variant="outline" onClick={handleSaveBank} disabled={!isBankDirty || savingBank}>
            {savingBank ? "Saving..." : "Save bank details"}
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="grid gap-1">
            <Input
              placeholder="Bank name"
              value={bankForm.bankName}
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
              onChange={(e) => setBankForm((prev) => ({ ...prev, bankBranch: e.target.value }))}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Documents</CardTitle>
          <div className="flex gap-2">
            <Input
              placeholder="Document title"
              value={docForm.title}
              onChange={(e) => setDocForm((prev) => ({ ...prev, title: e.target.value }))}
              className="w-48"
            />
            <Input
              type="file"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                setDocForm((prev) => ({ ...prev, file }));
                setDocError("");
              }}
              className="w-56"
            />
            <Button size="sm" variant="outline" onClick={handleUploadDocument} disabled={uploadingDoc}>
              {uploadingDoc ? "Uploading..." : "Upload"}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {docError ? <p className="mb-3 text-xs text-red-600">{docError}</p> : null}
          {docForm.file ? (
            <p className="mb-3 text-xs text-muted-foreground">
              Selected file: {docForm.file.name} ({Math.round(docForm.file.size / 1024)} KB)
            </p>
          ) : null}
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No documents uploaded yet.</p>
          ) : (
            <div className="grid gap-2 text-sm">
              {documents.slice(0, visibleDocumentCount).map((doc) => (
                <div key={doc.id} className="flex flex-wrap items-center justify-between gap-3 rounded border px-3 py-2">
                  <div>
                    <div className="font-medium">{doc.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {doc.fileType || "Document"} -{" "}
                      {doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString() : "Not provided"}
                    </div>
                  </div>
                  <div className="flex gap-2">
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
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setVisibleDocumentCount((prev) => prev + 5)}
                  >
                    Show more documents
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Performance Reviews</CardTitle>
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/hr/reviews?employeeId=${employeeId}`}>Open reviews</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {reviews.length === 0 ? (
            <p className="text-sm text-muted-foreground">No reviews recorded yet.</p>
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
              {reviews.slice(1, 5).map((review) => (
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
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
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

      <Card>
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
              Remove this document from the employee profile?
            </p>
            <div className="text-sm font-medium">{docDeleteDialog?.title || ""}</div>
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
                Delete document
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Card>
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

      <Card>
        <CardHeader>
          <CardTitle>Recent Payslips</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-3 md:hidden">
            {payslips.length === 0 ? (
              <div className="rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">
                No payslips found.
              </div>
            ) : (
              payslips.map((slip) => (
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
                  payslips.map((slip) => (
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Staff Issues</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-3 md:hidden">
            {issues.length === 0 ? (
              <div className="rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">
                No issues recorded.
              </div>
            ) : (
              issues.map((issue) => (
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
                  issues.map((issue) => (
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Profile Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {activityItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent profile activity yet.</p>
          ) : (
            <div className="grid gap-3 text-sm">
              {activityItems.slice(0, visibleActivityCount).map((item) => (
                <div key={item.id} className="rounded border px-3 py-2">
                  <div className="font-medium">{item.action.replaceAll("_", " ")}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()} -{" "}
                    {item.actor?.name || item.actor?.email || "System"}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {(item.meta?.resultSummary as string | undefined) || "Completed."}
                  </div>
                </div>
              ))}
              {activityItems.length > visibleActivityCount ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">
                    Showing {Math.min(visibleActivityCount, activityItems.length)} of {activityItems.length} activity items
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setVisibleActivityCount((prev) => prev + 10)}
                  >
                    Show more activity
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

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
