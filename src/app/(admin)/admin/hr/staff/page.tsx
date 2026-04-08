"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MoreHorizontal, UserRoundPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type EmployeeStatus = "ACTIVE" | "ON_LEAVE" | "SUSPENDED" | "TERMINATED";
type UserRole = "ADMIN" | "STAFF" | "ACCOUNTANT" | "DISPATCHER";
type LinkedUserRole = "STAFF" | "ACCOUNTANT" | "ADMIN" | "DISPATCHER";
type CompletenessFilter = "all" | "complete" | "missing";
type AccountLinkFilter = "all" | "linked" | "unlinked";
type SortOrder = "recent" | "name_asc" | "name_desc";
type BulkScope = "selected" | "all_filtered";
type MobileDensity = "comfortable" | "compact";

type Employee = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  department?: string | null;
  position?: string | null;
  status: EmployeeStatus;
  hireDate?: string | null;
  terminationDate?: string | null;
  updatedAt?: string | null;
  onboarding?: {
    status: "pending" | "complete";
    summary: string;
    missingFields: string[];
    hasPendingMarker: boolean;
  };
  user?: { id?: string | null; role?: UserRole | null } | null;
};

type SavedView = {
  id: string;
  name: string;
  filters: {
    q: string;
    status: string;
    department: string;
    role: string;
    accountLink: AccountLinkFilter;
    completeness: CompletenessFilter;
    onboarding: OnboardingFilter;
    sort: SortOrder;
    pageSize: number;
  };
};

type StaffListResponse = {
  rows: Employee[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  departmentOptions: string[];
  summary: {
    total: number;
    active: number;
    onLeave: number;
    suspended: number;
    terminated: number;
    missingProfile: number;
    missingBankDetails: number;
    pendingOnboarding: number;
    linkedAccount: number;
    unlinkedAccount: number;
  };
};

type OnboardingFilter = "all" | "pending" | "complete";

type StaffActivityItem = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  actor: {
    id: string;
    name: string | null;
    email: string | null;
    role: string;
  } | null;
  meta: string | null;
};

const STAFF_SOURCE_PAGE = "admin/hr/staff";

const statusTone: Record<EmployeeStatus, "default" | "secondary" | "destructive"> = {
  ACTIVE: "default",
  ON_LEAVE: "secondary",
  SUSPENDED: "destructive",
  TERMINATED: "secondary",
};

const fetcher = async <T,>(url: string) => {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || "Request failed.");
  return body as T;
};

function normalizePageSize(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 10) return 25;
  return Math.min(100, Math.trunc(parsed));
}

function getMissingProfileFields(row: Employee) {
  const missing: string[] = [];
  if (!row.email) missing.push("Email");
  if (!row.phone) missing.push("Phone");
  if (!row.department) missing.push("Department");
  if (!row.position) missing.push("Position");
  if (!row.hireDate) missing.push("Hire date");
  return missing;
}

function getOnboardingWorkflowSummary(row: Employee) {
  if (!row.onboarding) return "Onboarding status unavailable.";
  if (row.onboarding.status === "complete") return "Onboarding complete.";
  if (row.onboarding.hasPendingMarker) return "From hiring pipeline. Resume HR completion.";
  return "Resume onboarding to finish required HR details.";
}

function formatEmployeeStatusLabel(status: EmployeeStatus) {
  return status.replace("_", " ");
}

function getAccountLinkLabel(row: Employee) {
  return row.user?.id ? "Linked account" : "No linked account";
}

function getAccessRoleBadgeClass(role?: UserRole | null) {
  if (role === "ADMIN") return "border-0 bg-rose-100 text-rose-700 hover:bg-rose-100";
  if (role === "ACCOUNTANT") return "border-0 bg-amber-100 text-amber-800 hover:bg-amber-100";
  if (role === "DISPATCHER") return "border-0 bg-sky-100 text-sky-700 hover:bg-sky-100";
  if (role === "STAFF") return "border-0 bg-emerald-100 text-emerald-700 hover:bg-emerald-100";
  return "border-0 bg-slate-100 text-slate-700 hover:bg-slate-100";
}

function getStatusChangePrompt(nextStatus: EmployeeStatus) {
  if (nextStatus === "TERMINATED") {
    return "This will mark the employee as terminated and set a termination date if one is not already provided.";
  }
  if (nextStatus === "SUSPENDED") {
    return "This will mark the employee as suspended from active work. Add a short note so the reason is clear in audit history.";
  }
  if (nextStatus === "ON_LEAVE") {
    return "This will move the employee into on-leave status from the staff directory.";
  }
  return "This will return the employee to active status from the staff directory.";
}

function getCompletenessFilterLabel(value: CompletenessFilter) {
  if (value === "missing") return "Missing key fields";
  if (value === "complete") return "Complete profiles";
  return "All profiles";
}

function getSortLabel(value: SortOrder) {
  if (value === "name_asc") return "Name A-Z";
  if (value === "name_desc") return "Name Z-A";
  return "Most recent hire";
}

function toPlainEnglishLabel(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

function parseAuditMeta(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function formatActivityTitle(action: string) {
  return toPlainEnglishLabel(action);
}

function formatActivitySummary(meta: Record<string, unknown> | null) {
  if (!meta) return "No additional summary available.";
  const resultSummary = typeof meta.resultSummary === "string" ? meta.resultSummary.trim() : "";
  if (resultSummary) return resultSummary;
  const operation = typeof meta.operation === "string" ? meta.operation.trim() : "";
  if (operation) return toPlainEnglishLabel(operation);
  return "No additional summary available.";
}


export default function AdminHrStaffPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const employeesCardRef = useRef<HTMLDivElement | null>(null);

  const initialQ = searchParams.get("q") || "";
  const initialStatus = searchParams.get("status") || "all";
  const initialDepartment = searchParams.get("department") || "all";
  const initialRole = searchParams.get("role") || "all";
  const initialAccountLink = (searchParams.get("accountLink") || "all") as AccountLinkFilter;
  const initialCompleteness = (searchParams.get("completeness") || "all") as CompletenessFilter;
  const initialOnboarding = (searchParams.get("onboarding") || "all") as OnboardingFilter;
  const initialSort = (searchParams.get("sort") || "recent") as SortOrder;
  const initialPage = Math.max(1, Number(searchParams.get("page") || "1") || 1);
  const initialPageSize = normalizePageSize(searchParams.get("pageSize"));

  const [search, setSearch] = useState(initialQ);
  const [searchDebounced, setSearchDebounced] = useState(initialQ);
  const [status, setStatus] = useState(initialStatus);
  const [department, setDepartment] = useState(initialDepartment);
  const [role, setRole] = useState(initialRole);
  const [accountLink, setAccountLink] = useState<AccountLinkFilter>(
    ["all", "linked", "unlinked"].includes(initialAccountLink) ? initialAccountLink : "all",
  );
  const [completeness, setCompleteness] = useState<CompletenessFilter>(
    ["all", "complete", "missing"].includes(initialCompleteness) ? initialCompleteness : "all",
  );
  const [onboarding, setOnboarding] = useState<OnboardingFilter>(
    ["all", "pending", "complete"].includes(initialOnboarding) ? initialOnboarding : "all",
  );
  const [sort, setSort] = useState<SortOrder>(["recent", "name_asc", "name_desc"].includes(initialSort) ? initialSort : "recent");
  const [page, setPage] = useState(initialPage);
  const [pageSize, setPageSize] = useState(initialPageSize);

  const [importOpen, setImportOpen] = useState(false);
  const [importRows, setImportRows] = useState<Record<string, string>[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importPreviewSummary, setImportPreviewSummary] = useState("");
  const [savingViewName, setSavingViewName] = useState("");
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savingViewBusy, setSavingViewBusy] = useState(false);
  const [savedViewsLoading, setSavedViewsLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<EmployeeStatus>("ACTIVE");
  const [bulkScope, setBulkScope] = useState<BulkScope>("selected");
  const [mobileDensity, setMobileDensity] = useState<MobileDensity>("comfortable");
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [pendingStatusChange, setPendingStatusChange] = useState<{
    employee: Employee;
    nextStatus: EmployeeStatus;
  } | null>(null);
  const [statusChangeReason, setStatusChangeReason] = useState("");
  const [statusChangeSaving, setStatusChangeSaving] = useState(false);
  const [linkedUserDialogOpen, setLinkedUserDialogOpen] = useState(false);
  const [linkedUserEmployee, setLinkedUserEmployee] = useState<Employee | null>(null);
  const [linkedUserSubmitting, setLinkedUserSubmitting] = useState(false);
  const [linkedUserForm, setLinkedUserForm] = useState({
    name: "",
    email: "",
    phone: "",
    role: "STAFF" as LinkedUserRole,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchDebounced(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (searchDebounced.trim()) params.set("q", searchDebounced.trim());
    if (status !== "all") params.set("status", status);
    if (department !== "all") params.set("department", department);
    if (role !== "all") params.set("role", role);
    if (accountLink !== "all") params.set("accountLink", accountLink);
    if (completeness !== "all") params.set("completeness", completeness);
    if (onboarding !== "all") params.set("onboarding", onboarding);
    if (sort !== "recent") params.set("sort", sort);
    if (page !== 1) params.set("page", String(page));
    if (pageSize !== 25) params.set("pageSize", String(pageSize));
    const next = params.toString();
    const current = searchParams.toString();
    if (next !== current) {
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    }
  }, [searchDebounced, status, department, role, accountLink, completeness, onboarding, sort, page, pageSize, pathname, router, searchParams]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        setSavedViewsLoading(true);
        const viewsRes = await fetch("/api/admin/hr/employees/views");
        const viewsPayload = await viewsRes.json().catch(() => ({}));
        if (!cancelled) {
          setSavedViews(Array.isArray(viewsPayload?.items) ? viewsPayload.items : []);
        }
      } catch {
        if (!cancelled) {
          setSavedViews([]);
        }
      } finally {
        if (!cancelled) setSavedViewsLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (searchDebounced.trim()) params.set("q", searchDebounced.trim());
    if (status !== "all") params.set("status", status);
    if (department !== "all") params.set("department", department);
    if (role !== "all") params.set("role", role);
    if (accountLink !== "all") params.set("accountLink", accountLink);
    if (completeness !== "all") params.set("completeness", completeness);
    if (onboarding !== "all") params.set("onboarding", onboarding);
    if (sort !== "recent") params.set("sort", sort);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    return `/api/admin/hr/employees?${params.toString()}`;
  }, [searchDebounced, status, department, role, accountLink, completeness, onboarding, sort, page, pageSize]);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["admin", "hr", "employees", searchDebounced, status, department, role, accountLink, completeness, onboarding, sort, page, pageSize],
    queryFn: () => fetcher<StaffListResponse>(query),
  });

  const recentActivityQuery = useQuery({
    queryKey: ["admin", "hr", "staff", "activity"],
    queryFn: () =>
      fetcher<{ rows: StaffActivityItem[] }>(
        `/api/admin/audit?sourcePage=${encodeURIComponent(STAFF_SOURCE_PAGE)}&limit=2`,
      ),
  });

  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data?.rows]);
  const pagedRows = rows;
  const totalRows = data?.total || 0;
  const totalPages = data?.totalPages || 1;
  const safePage = data?.page || 1;
  const departmentOptions = data?.departmentOptions || [];
  const selectedCount = selectedIds.size;
  const allVisibleSelected = pagedRows.length > 0 && pagedRows.every((row) => selectedIds.has(row.id));
  const recentStaffActivity = Array.isArray(recentActivityQuery.data?.rows) ? recentActivityQuery.data.rows : [];

  const stats = useMemo(() => {
    return (
      data?.summary || {
        total: 0,
        active: 0,
        onLeave: 0,
        suspended: 0,
        terminated: 0,
        missingProfile: 0,
        missingBankDetails: 0,
        pendingOnboarding: 0,
        linkedAccount: 0,
        unlinkedAccount: 0,
      }
    );
  }, [data?.summary]);

  const statusChangeRequiresReason =
    pendingStatusChange?.nextStatus === "SUSPENDED" || pendingStatusChange?.nextStatus === "TERMINATED";
  const statusChangeErrorMessage =
    error instanceof Error ? error.message : "Staff data could not be loaded.";

  const importPreviewStats = useMemo(() => {
    const total = importRows.length;
    const previewRows = importRows.slice(0, 5).map((row, index) => {
      const missingCore: string[] = [];
      if (!row.email?.trim()) missingCore.push("Email");
      if (!row.phone?.trim()) missingCore.push("Phone");
      if (!row.department?.trim()) missingCore.push("Department");
      if (!row.position?.trim()) missingCore.push("Position");
      if (!row.hiredate?.trim()) missingCore.push("Hire date");
      const missingBankFields = [
        !row.bankname?.trim() ? "Bank name" : null,
        !row.bankaccountname?.trim() ? "Account name" : null,
        !row.bankaccountnumber?.trim() ? "Account number" : null,
        !row.bankcode?.trim() ? "Bank code" : null,
        !row.bankbranch?.trim() ? "Branch" : null,
      ].filter((value): value is string => Boolean(value));
      return {
        rowNumber: index + 2,
        row,
        missingCore,
        missingBankFields,
      };
    });

    const totals = importRows.reduce(
      (acc, row) => {
        if (row.email?.trim() && row.phone?.trim()) acc.portalReady += 1;
        if (!row.email?.trim()) acc.missingEmail += 1;
        if (!row.phone?.trim()) acc.missingPhone += 1;
        if (!row.department?.trim()) acc.missingDepartment += 1;
        if (!row.position?.trim()) acc.missingPosition += 1;
        if (!row.hiredate?.trim()) acc.missingHireDate += 1;
        if (
          !row.bankname?.trim() ||
          !row.bankaccountname?.trim() ||
          !row.bankaccountnumber?.trim() ||
          !row.bankcode?.trim() ||
          !row.bankbranch?.trim()
        ) {
          acc.missingBankDetails += 1;
        }
        return acc;
      },
      {
        portalReady: 0,
        missingEmail: 0,
        missingPhone: 0,
        missingDepartment: 0,
        missingPosition: 0,
        missingHireDate: 0,
        missingBankDetails: 0,
      },
    );

    return {
      total,
      previewRows,
      ...totals,
    };
  }, [importRows]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const scrollToEmployeesTable = () => {
    window.setTimeout(() => {
      employeesCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 40);
  };

  const applyDirectoryShortcut = ({
    nextStatus = "all",
    nextAccountLink = "all",
    nextCompleteness = "all",
    nextOnboarding = "all",
  }: {
    nextStatus?: string;
    nextAccountLink?: AccountLinkFilter;
    nextCompleteness?: CompletenessFilter;
    nextOnboarding?: OnboardingFilter;
  }) => {
    setStatus(nextStatus);
    setAccountLink(nextAccountLink);
    setCompleteness(nextCompleteness);
    setOnboarding(nextOnboarding);
    setPage(1);
    scrollToEmployeesTable();
  };

  const refreshDirectoryData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employees"] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "staff", "activity"] }),
    ]);
  };

  const parseCsv = (text: string) => {
    const parsedRows: string[][] = [];
    let current = "";
    let inQuotes = false;
    let row: string[] = [];
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];
      if (char === "\"") {
        if (inQuotes && next === "\"") {
          current += "\"";
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (char === "," && !inQuotes) {
        row.push(current.trim());
        current = "";
        continue;
      }
      if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && next === "\n") i += 1;
        row.push(current.trim());
        if (row.some((cell) => cell.length > 0)) parsedRows.push(row);
        row = [];
        current = "";
        continue;
      }
      current += char;
    }
    if (current.length > 0 || row.length > 0) {
      row.push(current.trim());
      if (row.some((cell) => cell.length > 0)) parsedRows.push(row);
    }
    return parsedRows;
  };

  const handleImportFile = async (file?: File | null) => {
    if (!file) return;
    const text = await file.text();
    const parsedRows = parseCsv(text);
    const [headerRow, ...dataRows] = parsedRows;
    if (!headerRow) {
      setImportErrors(["CSV has no header row."]);
      setImportRows([]);
      return;
    }
    const headers = headerRow.map((h) => h.trim().toLowerCase());
    const mappedRows: Record<string, string>[] = [];
    const errors: string[] = [];
    dataRows.forEach((item, index) => {
      const entry: Record<string, string> = {};
      headers.forEach((key, idx) => {
        entry[key] = item[idx] ?? "";
      });
      if (!entry.firstname || !entry.lastname) {
        errors.push(`Row ${index + 2}: firstName and lastName are required.`);
      }
      mappedRows.push(entry);
    });
    setImportRows(mappedRows);
    setImportErrors(errors);
    setImportPreviewSummary("");
  };

  const handleImportSubmit = async (dryRun = false) => {
    if (importRows.length === 0) {
      toast.error("No rows to import.");
      return;
    }
    if (importErrors.length > 0) {
      toast.error("Fix CSV errors before importing.");
      return;
    }
    setImporting(true);
    try {
      const res = await fetch("/api/admin/hr/employees/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: importRows, dryRun }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to import employees.");
        return;
      }
        if (dryRun) {
          setImportPreviewSummary(body.resultSummary || "Preview complete.");
          toast.success(body.resultSummary || "Import preview completed.");
          await queryClient.invalidateQueries({ queryKey: ["admin", "hr", "staff", "activity"] });
          return;
        }
        toast.success(`Imported ${body.created} employee(s).`);
        setImportOpen(false);
        setImportRows([]);
        setImportErrors([]);
        setImportPreviewSummary("");
        await refreshDirectoryData();
    } catch {
      toast.error("Failed to import employees.");
    } finally {
      setImporting(false);
    }
  };

  const downloadTemplate = () => {
    const header = "firstName,lastName,email,phone,department,position,status,hireDate,bankName,bankAccountName,bankAccountNumber,bankCode,bankBranch";
    const sample = "Jane,Doe,jane.doe@example.com,0240000000,Finance,Accountant,ACTIVE,2025-01-10,Example Bank,Jane Doe,1234567890,EXB,Main";
    const csv = `${header}\n${sample}\n`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "employee-import-template.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  const downloadImportErrors = () => {
    if (importErrors.length === 0) return;
    const blob = new Blob([importErrors.join("\n")], { type: "text/plain;charset=utf-8;" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "employee-import-errors.txt";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  const handleExport = async () => {
    try {
      setExportNotice("");
      const params = new URLSearchParams();
      if (searchDebounced.trim()) params.set("q", searchDebounced.trim());
      if (status !== "all") params.set("status", status);
      if (department !== "all") params.set("department", department);
      if (role !== "all") params.set("role", role);
      if (accountLink !== "all") params.set("accountLink", accountLink);
      if (completeness !== "all") params.set("completeness", completeness);
      const res = await fetch(`/api/admin/hr/employees/export?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || "Failed to export CSV.");
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="(.+)"/i);
      const fileName = match?.[1] || `hr-staff-${Date.now()}.csv`;
      const truncated = res.headers.get("X-Export-Truncated") === "1";
      const totalMatches = Number(res.headers.get("X-Export-Total-Matches") || "0");
      const maxRows = Number(res.headers.get("X-Export-Max-Rows") || "0");
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success("Staff CSV exported.");
      if (truncated) {
        setExportNotice(
          `Export truncated to ${maxRows.toLocaleString()} rows (matched ${totalMatches.toLocaleString()}). Narrow filters for full export.`,
        );
      }
    } catch {
      toast.error("Failed to export CSV.");
    }
  };

  const openLinkedUserDialog = (employee: Employee) => {
    if (employee.user?.id) {
      toast.error("This employee already has a linked user account.");
      return;
    }
    setLinkedUserEmployee(employee);
    setLinkedUserForm({
      name: `${employee.firstName} ${employee.lastName}`.trim(),
      email: employee.email || "",
      phone: employee.phone || "",
      role: "STAFF",
    });
    setLinkedUserDialogOpen(true);
  };

  const closeLinkedUserDialog = () => {
    setLinkedUserDialogOpen(false);
    setLinkedUserEmployee(null);
    setLinkedUserForm({ name: "", email: "", phone: "", role: "STAFF" });
  };

  const handleCreateLinkedUser = async () => {
    if (!linkedUserEmployee) return;
    if (!linkedUserForm.email.trim() || !linkedUserForm.phone.trim()) {
      toast.error("Email and phone are required to create a linked user account.");
      return;
    }
    setLinkedUserSubmitting(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: linkedUserForm.name.trim(),
          email: linkedUserForm.email.trim(),
          phone: linkedUserForm.phone.trim(),
          role: linkedUserForm.role,
          employeeId: linkedUserEmployee.id,
          sourcePage: STAFF_SOURCE_PAGE,
          section: "account-link",
          operation: "create_linked_user",
          resultSummary: "Linked user account created from the staff directory.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to create a linked user account.");
        return;
      }
        toast.success("Linked user created and invite sent.");
        closeLinkedUserDialog();
        await refreshDirectoryData();
    } catch {
      toast.error("Failed to create a linked user account.");
    } finally {
      setLinkedUserSubmitting(false);
    }
  };

  const openStatusChangeDialog = (employee: Employee, nextStatus: EmployeeStatus) => {
    if (employee.status === nextStatus) return;
    setPendingStatusChange({ employee, nextStatus });
    setStatusChangeReason("");
  };

  const closeStatusChangeDialog = () => {
    if (statusChangeSaving) return;
    setPendingStatusChange(null);
    setStatusChangeReason("");
  };

  const handleStatusUpdate = async (employee: Employee, nextStatus: EmployeeStatus, reason?: string) => {
    try {
      const payload = {
        status: nextStatus,
        statusReason: reason?.trim() || "",
        expectedUpdatedAt: employee.updatedAt || "",
        sourcePage: STAFF_SOURCE_PAGE,
        section: "staff-status",
        operation: "update_employee_status",
        resultSummary: `Employee status changed to ${formatEmployeeStatusLabel(nextStatus).toLowerCase()} from staff directory.`,
      };
      const res = await fetch(`/api/admin/hr/employees/${employee.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update status.");
        return;
      }
        toast.success("Status updated.");
        closeStatusChangeDialog();
        await refreshDirectoryData();
    } catch {
      toast.error("Failed to update status.");
    }
  };

  const confirmStatusChange = async () => {
    if (!pendingStatusChange) return;
    if (statusChangeRequiresReason && !statusChangeReason.trim()) {
      toast.error(`Add a short note before marking an employee ${formatEmployeeStatusLabel(pendingStatusChange.nextStatus).toLowerCase()}.`);
      return;
    }
    setStatusChangeSaving(true);
    try {
      await handleStatusUpdate(pendingStatusChange.employee, pendingStatusChange.nextStatus, statusChangeReason);
    } finally {
      setStatusChangeSaving(false);
    }
  };

  const saveCurrentView = () => {
    const name = savingViewName.trim();
    if (!name) {
      toast.error("Enter a view name.");
      return;
    }
    const run = async () => {
      setSavingViewBusy(true);
      try {
        const res = await fetch("/api/admin/hr/employees/views", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            filters: {
              q: searchDebounced.trim(),
              status,
              department,
              role,
              accountLink,
              completeness,
              onboarding,
              sort,
              pageSize,
            },
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(body.error || "Failed to save view.");
          return;
        }
        setSavedViews(Array.isArray(body.items) ? body.items : []);
        setSavingViewName("");
        toast.success("View saved.");
      } catch {
        toast.error("Failed to save view.");
      } finally {
        setSavingViewBusy(false);
      }
    };
    void run();
  };

  const applySavedView = (viewId: string) => {
    const view = savedViews.find((item) => item.id === viewId);
    if (!view) return;
    setSearch(view.filters.q);
    setSearchDebounced(view.filters.q);
    setStatus(view.filters.status);
    setDepartment(view.filters.department);
    setRole(view.filters.role);
    setAccountLink(view.filters.accountLink || "all");
    setCompleteness(view.filters.completeness);
    setOnboarding(view.filters.onboarding || "all");
    setSort(view.filters.sort);
    setPageSize(view.filters.pageSize);
    setPage(1);
    toast.success(`Applied view: ${view.name}`);
  };

  const removeSavedView = (viewId: string) => {
    const run = async () => {
      setSavingViewBusy(true);
      try {
        const res = await fetch("/api/admin/hr/employees/views", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: viewId }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(body.error || "Failed to delete view.");
          return;
        }
        setSavedViews(Array.isArray(body.items) ? body.items : []);
      } catch {
        toast.error("Failed to delete view.");
      } finally {
        setSavingViewBusy(false);
      }
    };
    void run();
  };

  const activeChips = [
    searchDebounced.trim() ? { key: "q", label: `Search: ${searchDebounced.trim()}` } : null,
    status !== "all" ? { key: "status", label: `Status: ${status.replace("_", " ")}` } : null,
    department !== "all"
      ? { key: "department", label: `Department: ${department === "__MISSING__" ? "No department" : department}` }
      : null,
    role !== "all" ? { key: "role", label: `Role: ${role}` } : null,
    accountLink !== "all" ? { key: "accountLink", label: `Account: ${accountLink === "linked" ? "Linked" : "Unlinked"}` } : null,
    completeness !== "all" ? { key: "completeness", label: `Profile: ${getCompletenessFilterLabel(completeness)}` } : null,
    onboarding !== "all" ? { key: "onboarding", label: `Onboarding: ${onboarding === "pending" ? "Needs onboarding" : "Complete"}` } : null,
    sort !== "recent" ? { key: "sort", label: `Sort: ${getSortLabel(sort)}` } : null,
  ].filter((chip): chip is { key: string; label: string } => Boolean(chip));

  const removeFilterChip = (key: string) => {
    if (key === "q") {
      setSearch("");
      setSearchDebounced("");
    }
    if (key === "status") setStatus("all");
    if (key === "department") setDepartment("all");
    if (key === "role") setRole("all");
    if (key === "accountLink") setAccountLink("all");
    if (key === "completeness") setCompleteness("all");
    if (key === "onboarding") setOnboarding("all");
    if (key === "sort") setSort("recent");
    setPage(1);
  };

  const toggleVisibleSelection = (checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) {
      pagedRows.forEach((row) => next.add(row.id));
    } else {
      pagedRows.forEach((row) => next.delete(row.id));
    }
    setSelectedIds(next);
  };

  const handleBulkUpdate = async () => {
    const targets = rows.filter((row) => selectedIds.has(row.id));
    if (bulkScope === "selected" && targets.length === 0) {
      toast.error("Select at least one employee.");
      return;
    }
    setBulkSaving(true);
    try {
      const res = await fetch("/api/admin/hr/employees/bulk-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: bulkStatus,
          scope: bulkScope,
          ids: bulkScope === "selected" ? targets.map((row) => row.id) : [],
          expected:
            bulkScope === "selected"
              ? targets.map((row) => ({
                  id: row.id,
                  expectedUpdatedAt: row.updatedAt || "",
                  beforeStatus: row.status,
                }))
              : [],
          q: searchDebounced,
          statusFilter: status,
          department,
          role,
          accountLink,
          completeness,
          sourcePage: STAFF_SOURCE_PAGE,
          section: "bulk-status",
          operation: "bulk_update_employee_status",
          resultSummary: "Employee statuses updated in bulk from staff directory.",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Bulk update failed.");
        return;
      }
        if (body.successCount > 0) toast.success(`Updated ${body.successCount} employee(s).`);
        if (body.conflictCount > 0) toast.error(`${body.conflictCount} employee(s) changed by another admin and were skipped.`);
        if (body.failedCount > 0) toast.error(`${body.failedCount} employee(s) failed to update.`);
        setBulkDialogOpen(false);
        setSelectedIds(new Set());
        await refreshDirectoryData();
    } catch {
      toast.error("Bulk update failed.");
    } finally {
      setBulkSaving(false);
    }
  };

  return (
    <section className="space-y-6 pb-20 md:pb-0">
      <Card className="overflow-hidden border-border/70 bg-gradient-to-br from-background via-primary/5 to-background">
        <CardContent className="space-y-6 p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.28em] text-muted-foreground">
                <Badge variant="outline">Staff workspace</Badge>
                <span>People operations</span>
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight">Staff Directory</h1>
                <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
                  Manage employee records, account-link readiness, payroll profile quality, and staff-status changes from one directory.
                </p>
                <p className="text-xs text-muted-foreground">
                  {stats.unlinkedAccount > 0
                    ? `${stats.unlinkedAccount} employee profile${stats.unlinkedAccount === 1 ? "" : "s"} still need a linked user account for the employee portal.`
                    : "All visible employee profiles in this view are linked or ready for portal access."}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 xl:max-w-md xl:justify-end">
              <Button asChild>
                <Link href="/admin/hr/onboarding?source=staff">
                  <UserRoundPlus className="mr-2 h-4 w-4" />
                  Start onboarding
                </Link>
              </Button>
              <Dialog open={importOpen} onOpenChange={setImportOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline">Import CSV</Button>
                </DialogTrigger>
                <DialogContent className="max-w-xl">
                  <DialogHeader>
                    <DialogTitle>Import Employees</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-3 text-sm">
                    <p className="text-muted-foreground">
                      Upload a CSV with columns: firstName, lastName, email, phone, department, position, status, hireDate (YYYY-MM-DD), bankName, bankAccountName, bankAccountNumber, bankCode, bankBranch.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="secondary" onClick={downloadTemplate}>Download template</Button>
                      <Input type="file" accept=".csv,text/csv" onChange={(e) => handleImportFile(e.target.files?.[0])} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Rows ready: {importRows.length}. Errors: {importErrors.length}.
                    </div>
                    {importErrors.length > 0 ? (
                      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                        {importErrors.slice(0, 5).map((err) => (
                          <div key={err}>{err}</div>
                        ))}
                        {importErrors.length > 5 ? <div>...</div> : null}
                        <div className="mt-2">
                          <Button type="button" variant="outline" size="sm" onClick={downloadImportErrors}>
                            Download error list
                          </Button>
                        </div>
                      </div>
                    ) : null}
                      {importPreviewSummary ? (
                        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-700">
                          {importPreviewSummary}
                        </div>
                      ) : null}
                      {importRows.length > 0 ? (
                        <div className="space-y-3 rounded-md border border-border/70 p-3">
                          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                            <div className="rounded-md bg-muted/50 px-3 py-2">
                              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Portal-ready rows</div>
                              <div className="text-sm font-semibold text-foreground">{importPreviewStats.portalReady} / {importPreviewStats.total}</div>
                            </div>
                            <div className="rounded-md bg-muted/50 px-3 py-2">
                              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Missing contact</div>
                              <div className="text-sm font-semibold text-foreground">{importPreviewStats.missingEmail + importPreviewStats.missingPhone} field gap(s)</div>
                            </div>
                            <div className="rounded-md bg-muted/50 px-3 py-2">
                              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Missing bank detail rows</div>
                              <div className="text-sm font-semibold text-foreground">{importPreviewStats.missingBankDetails}</div>
                            </div>
                          </div>
                          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
                            <div>Missing email: {importPreviewStats.missingEmail}</div>
                            <div>Missing phone: {importPreviewStats.missingPhone}</div>
                            <div>Missing department: {importPreviewStats.missingDepartment}</div>
                            <div>Missing position: {importPreviewStats.missingPosition}</div>
                            <div>Missing hire date: {importPreviewStats.missingHireDate}</div>
                          </div>
                          <div>
                            <p className="text-xs font-medium text-foreground">Preview first rows</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Showing the first {Math.min(importPreviewStats.previewRows.length, importRows.length)} row(s) of {importRows.length} so you can spot contact, payroll, and portal-readiness gaps before import.
                            </p>
                          </div>
                          <div className="space-y-2 text-xs text-muted-foreground">
                            {importPreviewStats.previewRows.map(({ row, rowNumber, missingCore, missingBankFields }, index) => (
                              <div key={`${row.firstname || "row"}-${index}`} className="rounded-md bg-muted/50 px-2 py-2">
                                <div className="font-medium text-foreground">
                                  Row {rowNumber}: {(row.firstname || "-")} {(row.lastname || "-")}
                                </div>
                                <div className="mt-1">
                                  Department: {row.department || "-"} | Position: {row.position || "-"} | Status: {row.status || "ACTIVE"}
                                </div>
                                <div>
                                  Email: {row.email || "-"} | Phone: {row.phone || "-"}
                                </div>
                                <div>
                                  Bank ready: {missingBankFields.length === 0 ? "Yes" : `No (${missingBankFields.join(", ")})`}
                                </div>
                                <div>
                                  Core profile: {missingCore.length === 0 ? "Ready" : `Missing ${missingCore.join(", ")}`}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => handleImportSubmit(true)} disabled={importing}>
                      {importing ? "Checking..." : "Preview import"}
                    </Button>
                    <Button onClick={() => handleImportSubmit(false)} disabled={importing}>
                      {importing ? "Importing..." : "Import employees"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <Button variant="outline" onClick={handleExport}>Export CSV</Button>
              <Button asChild variant="outline">
                <Link href={{ pathname: "/admin/audit", query: { entityType: "EMPLOYEE", sourcePage: STAFF_SOURCE_PAGE } }}>
                  Open staff audit log
                </Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
            <Card className="border-border/60 bg-background/80 shadow-none"><CardContent className="py-4"><p className="text-xs text-muted-foreground">Total staff</p><p className="text-2xl font-semibold">{stats.total}</p></CardContent></Card>
            <Card className="border-border/60 bg-background/80 shadow-none"><CardContent className="py-4"><p className="text-xs text-muted-foreground">Active now</p><p className="text-2xl font-semibold">{stats.active}</p></CardContent></Card>
            <Card className="border-border/60 bg-background/80 shadow-none"><CardContent className="py-4"><p className="text-xs text-muted-foreground">On leave</p><p className="text-2xl font-semibold">{stats.onLeave}</p></CardContent></Card>
            <Card className="border-border/60 bg-background/80 shadow-none"><CardContent className="py-4"><p className="text-xs text-muted-foreground">Missing profile fields</p><p className="text-2xl font-semibold">{stats.missingProfile}</p></CardContent></Card>
            <Card className="border-border/60 bg-background/80 shadow-none"><CardContent className="py-4"><p className="text-xs text-muted-foreground">Needs onboarding</p><p className="text-2xl font-semibold">{stats.pendingOnboarding}</p></CardContent></Card>
            <Card className="border-border/60 bg-background/80 shadow-none"><CardContent className="py-4"><p className="text-xs text-muted-foreground">Linked accounts</p><p className="text-2xl font-semibold">{stats.linkedAccount}</p></CardContent></Card>
            <Card className="border-border/60 bg-background/80 shadow-none"><CardContent className="py-4"><p className="text-xs text-muted-foreground">Missing bank details</p><p className="text-2xl font-semibold">{stats.missingBankDetails}</p></CardContent></Card>
          </div>
        </CardContent>
      </Card>

      {isError ? (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">Staff directory data could not be loaded.</p>
              <p className="text-sm text-muted-foreground">{statusChangeErrorMessage}</p>
            </div>
            <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
              {isFetching ? "Retrying..." : "Retry"}
            </Button>
          </CardContent>
        </Card>
      ) : null}

        <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <Card>
          <CardHeader>
            <CardTitle>Attention needed</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <button
              type="button"
              className="rounded-lg border p-4 text-left transition hover:bg-muted/50"
              onClick={() => {
                applyDirectoryShortcut({ nextCompleteness: "missing" });
              }}
            >
              <div className="text-sm font-medium">Profiles missing key fields</div>
              <div className="mt-1 text-2xl font-semibold">{stats.missingProfile}</div>
              <p className="mt-2 text-xs text-muted-foreground">
                Filter the directory to employees missing email, phone, department, position, or hire date.
              </p>
            </button>
            <button
              type="button"
              className="rounded-lg border p-4 text-left transition hover:bg-muted/50"
              onClick={() => {
                applyDirectoryShortcut({ nextAccountLink: "unlinked" });
              }}
            >
              <div className="text-sm font-medium">No linked user account</div>
              <div className="mt-1 text-2xl font-semibold">{stats.unlinkedAccount}</div>
              <p className="mt-2 text-xs text-muted-foreground">
                Use this to find employees who still cannot access the employee portal.
              </p>
            </button>
            <button
              type="button"
              className="rounded-lg border p-4 text-left transition hover:bg-muted/50"
              onClick={() => {
                applyDirectoryShortcut({ nextStatus: "ON_LEAVE" });
              }}
            >
              <div className="text-sm font-medium">Employees currently on leave</div>
              <div className="mt-1 text-2xl font-semibold">{stats.onLeave}</div>
              <p className="mt-2 text-xs text-muted-foreground">
                Narrow the directory to current on-leave staff for handover or coverage review.
              </p>
            </button>
            <button
              type="button"
              className="rounded-lg border p-4 text-left transition hover:bg-muted/50"
              onClick={() => {
                applyDirectoryShortcut({ nextOnboarding: "pending" });
              }}
            >
              <div className="text-sm font-medium">Onboarding still pending</div>
              <div className="mt-1 text-2xl font-semibold">{stats.pendingOnboarding}</div>
              <p className="mt-2 text-xs text-muted-foreground">
                Resume onboarding for hires or employee records still waiting on required HR completion.
              </p>
            </button>
            <div className="rounded-lg border p-4">
              <div className="text-sm font-medium">Payroll readiness blockers</div>
              <div className="mt-1 text-2xl font-semibold">{stats.missingBankDetails}</div>
              <p className="mt-2 text-xs text-muted-foreground">
                Employees missing bank details will block bank export. Review payroll fields from each employee profile.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Directory tools</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <p className="text-sm font-medium">Quick filters</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => applyDirectoryShortcut({ nextCompleteness: "missing" })}>
                  Missing profile fields
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyDirectoryShortcut({ nextOnboarding: "pending" })}>
                  Needs onboarding
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyDirectoryShortcut({ nextAccountLink: "unlinked" })}>
                  No linked account
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyDirectoryShortcut({ nextStatus: "ON_LEAVE" })}>
                  On leave today
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDepartment("all");
                    setSearch("");
                    setSearchDebounced("");
                    setCompleteness("all");
                    setOnboarding("all");
                    setRole("all");
                    setAccountLink("all");
                    setStatus("all");
                    setSort("recent");
                    setPage(1);
                    scrollToEmployeesTable();
                  }}
                >
                  Reset workspace
                </Button>
              </div>
            </div>
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input placeholder="Save current view name" value={savingViewName} onChange={(e) => setSavingViewName(e.target.value)} className="w-full md:w-64" />
                <Button variant="secondary" onClick={saveCurrentView} disabled={savingViewBusy}>
                  {savingViewBusy ? "Saving..." : "Save view"}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select onValueChange={applySavedView} value="">
                  <SelectTrigger className="w-full md:w-[220px]"><SelectValue placeholder="Apply saved view" /></SelectTrigger>
                  <SelectContent>
                    {savedViewsLoading ? (
                      <SelectItem value="__loading" disabled>Loading views...</SelectItem>
                    ) : savedViews.length === 0 ? (
                      <SelectItem value="__none" disabled>No saved views</SelectItem>
                    ) : (
                      savedViews.map((view) => (
                        <SelectItem key={view.id} value={view.id}>{view.name}</SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                {savedViews.map((view) => (
                  <Button key={view.id} variant="ghost" size="sm" onClick={() => removeSavedView(view.id)} disabled={savingViewBusy}>
                    Delete {view.name}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setBulkDialogOpen(true)}
                  disabled={(bulkScope === "selected" && selectedCount === 0) || (bulkScope === "all_filtered" && totalRows === 0)}
                >
                  Bulk update status ({bulkScope === "selected" ? selectedCount : "all filtered"})
                </Button>
                <Select value={bulkScope} onValueChange={(value) => setBulkScope(value as BulkScope)}>
                  <SelectTrigger className="h-8 w-[200px]"><SelectValue placeholder="Bulk scope" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="selected">Selected rows</SelectItem>
                    <SelectItem value="all_filtered">All filtered rows</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={bulkStatus} onValueChange={(value) => setBulkStatus(value as EmployeeStatus)}>
                  <SelectTrigger className="h-8 w-[180px]"><SelectValue placeholder="Choose status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACTIVE">Active</SelectItem>
                    <SelectItem value="ON_LEAVE">On leave</SelectItem>
                    <SelectItem value="SUSPENDED">Suspended</SelectItem>
                    <SelectItem value="TERMINATED">Terminated</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2 md:hidden">
                <span className="text-xs text-muted-foreground">Card density</span>
                <Button
                  type="button"
                  size="sm"
                  variant={mobileDensity === "comfortable" ? "default" : "outline"}
                  onClick={() => setMobileDensity("comfortable")}
                >
                  Comfortable
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={mobileDensity === "compact" ? "default" : "outline"}
                  onClick={() => setMobileDensity("compact")}
                >
                  Compact
                </Button>
              </div>
            </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Recent staff activity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentStaffActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {recentActivityQuery.isError ? "Recent staff activity is unavailable right now." : "No recent staff-directory activity found."}
              </p>
            ) : (
              recentStaffActivity.map((item) => {
                const meta = parseAuditMeta(item.meta);
                return (
                  <div key={item.id} className="rounded-xl border border-border/70 bg-background/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium">{formatActivityTitle(item.action)}</p>
                        <p className="text-sm text-muted-foreground">{formatActivitySummary(meta)}</p>
                      </div>
                      <span className="rounded-full border border-border/70 bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
                        {toPlainEnglishLabel(item.entityType)}
                      </span>
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      {item.actor?.name || item.actor?.email || "System"} • {new Date(item.createdAt).toLocaleString()}
                    </p>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card ref={employeesCardRef}>
        <CardHeader className="flex flex-col gap-3">
          <CardTitle>Employees</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Input placeholder="Search staff" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="w-full md:w-60" />
            <Select value={status} onValueChange={(value) => { setStatus(value); setPage(1); }}>
              <SelectTrigger className="w-full md:w-[160px]"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="ON_LEAVE">On leave</SelectItem>
                <SelectItem value="SUSPENDED">Suspended</SelectItem>
                <SelectItem value="TERMINATED">Terminated</SelectItem>
              </SelectContent>
            </Select>
            <Select value={department} onValueChange={(value) => { setDepartment(value); setPage(1); }}>
              <SelectTrigger className="w-full md:w-[180px]"><SelectValue placeholder="Department" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                <SelectItem value="__MISSING__">No department</SelectItem>
                {departmentOptions.map((option) => (
                  <SelectItem key={option} value={option}>{option}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={role} onValueChange={(value) => { setRole(value); setPage(1); }}>
              <SelectTrigger className="w-full md:w-[160px]"><SelectValue placeholder="Role" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All roles</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
                <SelectItem value="STAFF">Staff</SelectItem>
                <SelectItem value="ACCOUNTANT">Accountant</SelectItem>
              </SelectContent>
            </Select>
            <Select value={accountLink} onValueChange={(value) => { setAccountLink(value as AccountLinkFilter); setPage(1); }}>
              <SelectTrigger className="w-full md:w-[180px]"><SelectValue placeholder="Account link" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All account states</SelectItem>
                <SelectItem value="linked">Linked account</SelectItem>
                <SelectItem value="unlinked">No linked account</SelectItem>
              </SelectContent>
            </Select>
            <Select value={completeness} onValueChange={(value) => { setCompleteness(value as CompletenessFilter); setPage(1); }}>
              <SelectTrigger className="w-full md:w-[190px]"><SelectValue placeholder="Profile completeness" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All profiles</SelectItem>
                <SelectItem value="complete">Complete profiles</SelectItem>
                <SelectItem value="missing">Missing key fields</SelectItem>
              </SelectContent>
            </Select>
            <Select value={onboarding} onValueChange={(value) => { setOnboarding(value as OnboardingFilter); setPage(1); }}>
              <SelectTrigger className="w-full md:w-[190px]"><SelectValue placeholder="Onboarding" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All onboarding states</SelectItem>
                <SelectItem value="pending">Needs onboarding</SelectItem>
                <SelectItem value="complete">Onboarding complete</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(value) => setSort(value as SortOrder)}>
              <SelectTrigger className="w-full md:w-[170px]"><SelectValue placeholder="Sort" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Most recent hire</SelectItem>
                <SelectItem value="name_asc">Name A-Z</SelectItem>
                <SelectItem value="name_desc">Name Z-A</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              onClick={() => {
                setSearch("");
                setSearchDebounced("");
                setStatus("all");
                setDepartment("all");
                setRole("all");
                setAccountLink("all");
                setCompleteness("all");
                setSort("recent");
                setPageSize(25);
                setPage(1);
              }}
            >
              Clear
            </Button>
          </div>
            {activeChips.length > 0 ? (
              <div className="flex flex-wrap gap-2">
              {activeChips.map((chip) => (
                <Button key={chip.key} variant="secondary" size="sm" onClick={() => removeFilterChip(chip.key)}>
                  {chip.label} x
                </Button>
              ))}
            </div>
          ) : null}
          {exportNotice ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {exportNotice}
            </div>
          ) : null}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading staff...</p>
          ) : isError ? (
            <div className="rounded-md border border-destructive/40 p-4 text-sm">
              <p className="font-medium">The staff list is unavailable right now.</p>
              <p className="mt-1 text-muted-foreground">{statusChangeErrorMessage}</p>
              <Button className="mt-3" variant="outline" onClick={() => void refetch()} disabled={isFetching}>
                {isFetching ? "Retrying..." : "Retry"}
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-3 md:hidden">
                <div className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(e) => toggleVisibleSelection(e.target.checked)}
                    aria-label="Select all visible"
                  />
                  <span className="text-muted-foreground">Select all visible</span>
                </div>
                {pagedRows.length === 0 ? (
                  <div className="rounded-md border p-4 text-center text-sm text-muted-foreground">No staff found.</div>
                ) : (
                  pagedRows.map((row) => {
                    const missing = getMissingProfileFields(row);
                    return (
                      <Card key={row.id}>
                        <CardContent className={mobileDensity === "compact" ? "space-y-2 py-3" : "space-y-3 py-4"}>
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <Link href={`/admin/hr/staff/${row.id}`} className="font-medium underline-offset-2 hover:underline">
                                {row.firstName} {row.lastName}
                              </Link>
                              <div className="text-xs text-muted-foreground">
                                {row.hireDate ? `Hired ${new Date(row.hireDate).toLocaleDateString()}` : "Hire date not set"}
                              </div>
                            </div>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(row.id)}
                              onChange={(e) => {
                                const next = new Set(selectedIds);
                                if (e.target.checked) next.add(row.id);
                                else next.delete(row.id);
                                setSelectedIds(next);
                              }}
                              aria-label={`Select ${row.firstName} ${row.lastName}`}
                            />
                          </div>
                          <div className={mobileDensity === "compact" ? "grid grid-cols-2 gap-1 text-[11px]" : "grid grid-cols-2 gap-2 text-xs"}>
                            <div><span className="text-muted-foreground">Department:</span> {row.department || "-"}</div>
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Position:</span>
                              {row.position ? <Badge variant="outline">{row.position}</Badge> : "-"}
                            </div>
                            <div><span className="text-muted-foreground">Email:</span> {row.email || "-"}</div>
                            <div><span className="text-muted-foreground">Phone:</span> {row.phone || "-"}</div>
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Access:</span>
                              {row.user?.role ? (
                                <Badge className={`px-2 py-0.5 text-[10px] font-medium shadow-none ${getAccessRoleBadgeClass(row.user.role)}`}>
                                  {row.user.role}
                                </Badge>
                              ) : (
                                "-"
                              )}
                            </div>
                            <div><span className="text-muted-foreground">Updated:</span> {row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "-"}</div>
                          </div>
                          <div className={mobileDensity === "compact" ? "space-y-1.5" : "space-y-2"}>
                            <Badge variant={statusTone[row.status]}>{formatEmployeeStatusLabel(row.status)}</Badge>
                            <Select value={row.status} onValueChange={(value) => openStatusChangeDialog(row, value as EmployeeStatus)}>
                              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Update status" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="ACTIVE">Active</SelectItem>
                                <SelectItem value="ON_LEAVE">On leave</SelectItem>
                                <SelectItem value="SUSPENDED">Suspended</SelectItem>
                                <SelectItem value="TERMINATED">Terminated</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                            <div className="space-y-1">
                              <Badge variant={row.user?.id ? "secondary" : "outline"}>{getAccountLinkLabel(row)}</Badge>
                              <div className="text-xs text-muted-foreground">
                                {row.user?.id
                                  ? `Portal ready${row.user?.role ? ` - ${row.user.role}` : ""}`
                                  : "Employee portal access can be linked later from Users & Roles."}
                              </div>
                              {!row.user?.id ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-auto px-0 text-xs text-primary hover:bg-transparent"
                                  onClick={() => openLinkedUserDialog(row)}
                                >
                                  Create linked user
                                </Button>
                              ) : null}
                            </div>
                          <div>
                            <div className="space-y-1">
                              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Profile</div>
                              {missing.length === 0 ? (
                                <Badge variant="secondary">Complete profile</Badge>
                              ) : (
                                <div className="space-y-1">
                                  <Badge variant="destructive">Missing {missing.length}</Badge>
                                  <div className="text-xs text-muted-foreground">{missing.join(", ")}</div>
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="space-y-1">
                            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Onboarding</div>
                            <Badge variant={row.onboarding?.status === "pending" ? "outline" : "secondary"}>
                              {row.onboarding?.status === "pending" ? "Needs onboarding" : "Onboarding complete"}
                            </Badge>
                            <div className="text-xs text-muted-foreground">
                              {getOnboardingWorkflowSummary(row)}
                            </div>
                          </div>
                          <div className={mobileDensity === "compact" ? "flex flex-wrap items-center gap-1.5" : "flex flex-wrap items-center gap-2"}>
                            <Button asChild size="sm" variant="outline">
                              <Link href={`/admin/hr/staff/${row.id}`}>Open profile</Link>
                            </Button>
                            {row.onboarding?.status === "pending" ? (
                              <Button asChild size="sm">
                                <Link href={`/admin/hr/onboarding?source=staff&employeeId=${row.id}`}>Resume onboarding</Link>
                              </Button>
                            ) : null}
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button size="sm" variant="outline" className="gap-1">
                                  <MoreHorizontal className="h-4 w-4" />
                                  More
                                </Button>
                              </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem asChild>
                                    <Link href={`/admin/hr/staff/${row.id}/paystubs`}>Open payslips</Link>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem asChild>
                                    <Link href={`/admin/hr/leave?employeeId=${row.id}`}>Open leave</Link>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem asChild>
                                    <Link href={`/admin/hr/compensation?employeeId=${row.id}`}>Open compensation</Link>
                                  </DropdownMenuItem>
                                  {!row.user?.id ? (
                                    <DropdownMenuItem onClick={() => openLinkedUserDialog(row)}>
                                      Create linked user
                                    </DropdownMenuItem>
                                  ) : null}
                                  {!row.user?.id ? (
                                    <DropdownMenuItem asChild>
                                      <Link href="/admin/users">Open Users &amp; Roles</Link>
                                    </DropdownMenuItem>
                                  ) : null}
                                  <DropdownMenuItem
                                    onClick={async () => {
                                      await navigator.clipboard.writeText(`${window.location.origin}/admin/hr/staff/${row.id}`);
                                    toast.success("Profile link copied.");
                                  }}
                                >
                                  Copy link
                                </DropdownMenuItem>
                                <DropdownMenuItem asChild>
                                  <Link
                                    href={{
                                      pathname: "/admin/audit",
                                      query: {
                                        entityType: "EMPLOYEE",
                                        entityId: row.id,
                                        sourcePage: STAFF_SOURCE_PAGE,
                                      },
                                    }}
                                  >
                                    Open audit
                                  </Link>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>

              <div className="hidden md:block">
                <Table className="table-fixed">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[36px]">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={(e) => toggleVisibleSelection(e.target.checked)}
                          aria-label="Select all visible"
                        />
                      </TableHead>
                      <TableHead className="w-[210px]">Name</TableHead>
                      <TableHead className="w-[170px]">Work</TableHead>
                      <TableHead className="w-[160px]">Status</TableHead>
                      <TableHead className="w-[220px]">Access</TableHead>
                      <TableHead className="w-[250px]">Readiness</TableHead>
                      <TableHead className="w-[130px]">Last updated</TableHead>
                      <TableHead className="w-[72px] text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pagedRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                          No staff found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      pagedRows.map((row) => {
                        const missing = getMissingProfileFields(row);
                        const updatedAt = row.updatedAt ? new Date(row.updatedAt) : null;
                        return (
                          <TableRow key={row.id}>
                            <TableCell>
                              <input
                                type="checkbox"
                                checked={selectedIds.has(row.id)}
                                onChange={(e) => {
                                  const next = new Set(selectedIds);
                                  if (e.target.checked) next.add(row.id);
                                  else next.delete(row.id);
                                  setSelectedIds(next);
                                }}
                                aria-label={`Select ${row.firstName} ${row.lastName}`}
                              />
                            </TableCell>
                            <TableCell className="whitespace-normal align-top">
                              <Link href={`/admin/hr/staff/${row.id}`} className="font-medium underline-offset-2 hover:underline">
                                {row.firstName} {row.lastName}
                              </Link>
                              <div className="text-xs text-muted-foreground">
                                {row.hireDate ? `Hired ${new Date(row.hireDate).toLocaleDateString()}` : "Hire date not set"}
                              </div>
                            </TableCell>
                            <TableCell className="whitespace-normal align-top">
                              <div className="space-y-1">
                                <div className="text-sm">{row.department || "Department pending"}</div>
                                {row.position ? (
                                  <Badge variant="outline" className="w-fit">
                                    {row.position}
                                  </Badge>
                                ) : (
                                  <div className="text-xs text-muted-foreground">Position pending</div>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="whitespace-normal align-top">
                              <div className="flex min-w-[140px] flex-col gap-1">
                                <Badge variant={statusTone[row.status]}>{formatEmployeeStatusLabel(row.status)}</Badge>
                                <Select value={row.status} onValueChange={(value) => openStatusChangeDialog(row, value as EmployeeStatus)}>
                                  <SelectTrigger className="h-7 w-full text-xs"><SelectValue placeholder="Update status" /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="ACTIVE">Active</SelectItem>
                                    <SelectItem value="ON_LEAVE">On leave</SelectItem>
                                    <SelectItem value="SUSPENDED">Suspended</SelectItem>
                                    <SelectItem value="TERMINATED">Terminated</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </TableCell>
                            <TableCell className="whitespace-normal align-top">
                              <div className="max-w-[220px] space-y-1">
                                <div className="flex flex-col items-start gap-1">
                                  <Badge variant={row.user?.id ? "secondary" : "outline"}>{getAccountLinkLabel(row)}</Badge>
                                  {row.user?.role ? (
                                    <Badge className={`px-2 py-0.5 text-[10px] font-medium shadow-none ${getAccessRoleBadgeClass(row.user.role)}`}>
                                      {row.user.role}
                                    </Badge>
                                  ) : null}
                                </div>
                                <Link
                                  href={`/admin/hr/staff/${row.id}`}
                                  className="inline-flex text-xs font-medium text-primary underline-offset-2 hover:underline"
                                >
                                  Open employee profile
                                </Link>
                                {!row.user?.id ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-auto px-0 text-xs text-primary hover:bg-transparent"
                                    onClick={() => openLinkedUserDialog(row)}
                                  >
                                    Create linked user
                                  </Button>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="whitespace-normal align-top">
                              <div className="max-w-[250px] space-y-2">
                                <div className="flex flex-wrap gap-2">
                                  {missing.length === 0 ? (
                                    <Badge variant="secondary">Profile complete</Badge>
                                  ) : (
                                    <Badge variant="destructive">Profile missing {missing.length}</Badge>
                                  )}
                                  {row.onboarding?.status === "complete" ? (
                                    <Badge variant="secondary">Onboarding complete</Badge>
                                  ) : null}
                                </div>
                                {row.onboarding?.status === "pending" ? (
                                  <Link
                                    href={`/admin/hr/onboarding?source=staff&employeeId=${row.id}`}
                                    className="inline-flex text-xs font-medium text-primary underline-offset-2 hover:underline"
                                  >
                                    Resume onboarding
                                  </Link>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="whitespace-normal align-top text-xs text-muted-foreground">
                              {updatedAt ? (
                                <>
                                  <div>{updatedAt.toLocaleDateString()}</div>
                                  <div>{updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
                                </>
                              ) : (
                                "-"
                              )}
                            </TableCell>
                            <TableCell className="align-top">
                              <div className="flex justify-end">
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button size="icon" variant="outline" aria-label={`More actions for ${row.firstName} ${row.lastName}`}>
                                      <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem asChild>
                                      <Link href={`/admin/hr/staff/${row.id}`}>Open profile</Link>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem asChild>
                                      <Link href={`/admin/hr/staff/${row.id}/paystubs`}>Open payslips</Link>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem asChild>
                                      <Link href={`/admin/hr/leave?employeeId=${row.id}`}>Open leave</Link>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem asChild>
                                      <Link href={`/admin/hr/compensation?employeeId=${row.id}`}>Open compensation</Link>
                                    </DropdownMenuItem>
                                    {row.onboarding?.status === "pending" ? (
                                      <DropdownMenuItem asChild>
                                        <Link href={`/admin/hr/onboarding?source=staff&employeeId=${row.id}`}>Resume onboarding</Link>
                                      </DropdownMenuItem>
                                    ) : null}
                                    {!row.user?.id ? (
                                      <DropdownMenuItem onClick={() => openLinkedUserDialog(row)}>
                                        Create linked user
                                      </DropdownMenuItem>
                                    ) : null}
                                    {!row.user?.id ? (
                                      <DropdownMenuItem asChild>
                                        <Link href="/admin/users">Open Users &amp; Roles</Link>
                                      </DropdownMenuItem>
                                    ) : null}
                                    <DropdownMenuItem
                                      onClick={async () => {
                                        await navigator.clipboard.writeText(`${window.location.origin}/admin/hr/staff/${row.id}`);
                                        toast.success("Profile link copied.");
                                      }}
                                    >
                                      Copy link
                                    </DropdownMenuItem>
                                    <DropdownMenuItem asChild>
                                      <Link
                                        href={{
                                          pathname: "/admin/audit",
                                          query: {
                                            entityType: "EMPLOYEE",
                                            entityId: row.id,
                                            sourcePage: STAFF_SOURCE_PAGE,
                                          },
                                        }}
                                      >
                                        Open audit
                                      </Link>
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="text-muted-foreground">Showing {totalRows === 0 ? 0 : (safePage - 1) * pageSize + 1} to {Math.min(safePage * pageSize, totalRows)} of {totalRows}</div>
                <div className="flex items-center gap-2">
                  <Select
                    value={String(pageSize)}
                    onValueChange={(value) => {
                      setPageSize(normalizePageSize(value));
                      setPage(1);
                    }}
                  >
                    <SelectTrigger className="h-8 w-[130px]"><SelectValue placeholder="Rows per page" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10 rows</SelectItem>
                      <SelectItem value="25">25 rows</SelectItem>
                      <SelectItem value="50">50 rows</SelectItem>
                      <SelectItem value="100">100 rows</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={safePage <= 1}>Previous</Button>
                  <span>Page {safePage} / {totalPages}</span>
                  <Button variant="outline" size="sm" onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} disabled={safePage >= totalPages}>Next</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {selectedCount > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 shadow-lg backdrop-blur md:hidden">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-2">
            <div className="text-sm">{selectedCount} selected</div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setBulkScope("selected");
                  setBulkDialogOpen(true);
                }}
              >
                Bulk update
              </Button>
            </div>
          </div>
        </div>
        ) : null}

        <Dialog open={linkedUserDialogOpen} onOpenChange={(open) => { if (!open) closeLinkedUserDialog(); }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create linked user</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                Create a user account for {linkedUserEmployee ? `${linkedUserEmployee.firstName} ${linkedUserEmployee.lastName}` : "this employee"} and link it directly to the employee portal.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="text-xs text-muted-foreground">Full name</label>
                  <Input
                    value={linkedUserForm.name}
                    onChange={(e) => setLinkedUserForm((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="Employee full name"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Email</label>
                  <Input
                    type="email"
                    value={linkedUserForm.email}
                    onChange={(e) => setLinkedUserForm((prev) => ({ ...prev, email: e.target.value }))}
                    placeholder="employee@example.com"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Phone</label>
                  <Input
                    value={linkedUserForm.phone}
                    onChange={(e) => setLinkedUserForm((prev) => ({ ...prev, phone: e.target.value }))}
                    placeholder="0240000000"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs text-muted-foreground">User role</label>
                  <Select
                    value={linkedUserForm.role}
                    onValueChange={(value) => setLinkedUserForm((prev) => ({ ...prev, role: value as LinkedUserRole }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="STAFF">Staff</SelectItem>
                      <SelectItem value="ACCOUNTANT">Accountant</SelectItem>
                      <SelectItem value="DISPATCHER">Dispatcher</SelectItem>
                      <SelectItem value="ADMIN">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                The invite is sent immediately. If the employee already has email or phone on file, those values must match here so the account links back to the correct profile.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={closeLinkedUserDialog} disabled={linkedUserSubmitting}>Cancel</Button>
              <Button onClick={handleCreateLinkedUser} disabled={linkedUserSubmitting}>
                {linkedUserSubmitting ? "Creating..." : "Create linked user"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
          <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm bulk status update</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            Update {bulkScope === "selected" ? `${selectedCount} selected` : "all filtered"} employee(s) to <span className="font-medium text-foreground">{bulkStatus.replace("_", " ")}</span>?
            This action is audit-logged.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialogOpen(false)} disabled={bulkSaving}>Cancel</Button>
            <Button onClick={handleBulkUpdate} disabled={bulkSaving}>
              {bulkSaving ? "Updating..." : "Confirm update"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(pendingStatusChange)} onOpenChange={(open) => { if (!open) closeStatusChangeDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm status change</DialogTitle>
          </DialogHeader>
          {pendingStatusChange ? (
            <div className="space-y-3 text-sm">
              <div>
                Update <span className="font-medium text-foreground">{pendingStatusChange.employee.firstName} {pendingStatusChange.employee.lastName}</span> from{" "}
                <span className="font-medium text-foreground">{formatEmployeeStatusLabel(pendingStatusChange.employee.status)}</span> to{" "}
                <span className="font-medium text-foreground">{formatEmployeeStatusLabel(pendingStatusChange.nextStatus)}</span>.
              </div>
              <p className="text-muted-foreground">{getStatusChangePrompt(pendingStatusChange.nextStatus)}</p>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="status-change-reason">
                  {statusChangeRequiresReason ? "Reason for this change" : "Reason for this change (optional)"}
                </label>
                <Input
                  id="status-change-reason"
                  placeholder={statusChangeRequiresReason ? "Add a short reason" : "Optional staff note for audit history"}
                  value={statusChangeReason}
                  onChange={(e) => setStatusChangeReason(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  This note is stored in the audit log with the staff-directory status change.
                </p>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeStatusChangeDialog} disabled={statusChangeSaving}>Cancel</Button>
            <Button onClick={confirmStatusChange} disabled={statusChangeSaving}>
              {statusChangeSaving ? "Updating..." : "Confirm status change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
