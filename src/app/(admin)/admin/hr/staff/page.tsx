"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type EmployeeStatus = "ACTIVE" | "ON_LEAVE" | "SUSPENDED" | "TERMINATED";
type UserRole = "ADMIN" | "STAFF" | "ACCOUNTANT";
type CompletenessFilter = "all" | "complete" | "missing";
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
  user?: { role?: UserRole | null } | null;
};

type SavedView = {
  id: string;
  name: string;
  filters: {
    q: string;
    status: string;
    department: string;
    role: string;
    completeness: CompletenessFilter;
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
  };
};

const STAFF_SOURCE_PAGE = "admin/hr/staff";

const statusTone: Record<EmployeeStatus, "default" | "secondary" | "destructive"> = {
  ACTIVE: "default",
  ON_LEAVE: "secondary",
  SUSPENDED: "destructive",
  TERMINATED: "secondary",
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || "Request failed.");
  return body as StaffListResponse;
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


export default function AdminHrStaffPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initialQ = searchParams.get("q") || "";
  const initialStatus = searchParams.get("status") || "all";
  const initialDepartment = searchParams.get("department") || "all";
  const initialRole = searchParams.get("role") || "all";
  const initialCompleteness = (searchParams.get("completeness") || "all") as CompletenessFilter;
  const initialSort = (searchParams.get("sort") || "recent") as SortOrder;
  const initialPage = Math.max(1, Number(searchParams.get("page") || "1") || 1);
  const initialPageSize = normalizePageSize(searchParams.get("pageSize"));

  const [search, setSearch] = useState(initialQ);
  const [searchDebounced, setSearchDebounced] = useState(initialQ);
  const [status, setStatus] = useState(initialStatus);
  const [department, setDepartment] = useState(initialDepartment);
  const [role, setRole] = useState(initialRole);
  const [completeness, setCompleteness] = useState<CompletenessFilter>(
    ["all", "complete", "missing"].includes(initialCompleteness) ? initialCompleteness : "all",
  );
  const [sort, setSort] = useState<SortOrder>(["recent", "name_asc", "name_desc"].includes(initialSort) ? initialSort : "recent");
  const [page, setPage] = useState(initialPage);
  const [pageSize, setPageSize] = useState(initialPageSize);

  const [dialogOpen, setDialogOpen] = useState(false);
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

  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    department: "",
    position: "",
    status: "ACTIVE",
    hireDate: "",
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
    bankCode: "",
    bankBranch: "",
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
    if (completeness !== "all") params.set("completeness", completeness);
    if (sort !== "recent") params.set("sort", sort);
    if (page !== 1) params.set("page", String(page));
    if (pageSize !== 25) params.set("pageSize", String(pageSize));
    const next = params.toString();
    const current = searchParams.toString();
    if (next !== current) router.replace(next ? `${pathname}?${next}` : pathname);
  }, [searchDebounced, status, department, role, completeness, sort, page, pageSize, pathname, router, searchParams]);

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
    if (completeness !== "all") params.set("completeness", completeness);
    if (sort !== "recent") params.set("sort", sort);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    return `/api/admin/hr/employees?${params.toString()}`;
  }, [searchDebounced, status, department, role, completeness, sort, page, pageSize]);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "hr", "employees", searchDebounced, status, department, role, completeness, sort, page, pageSize],
    queryFn: () => fetcher(query),
  });

  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data?.rows]);
  const pagedRows = rows;
  const totalRows = data?.total || 0;
  const totalPages = data?.totalPages || 1;
  const safePage = data?.page || 1;
  const departmentOptions = data?.departmentOptions || [];
  const selectedCount = selectedIds.size;
  const allVisibleSelected = pagedRows.length > 0 && pagedRows.every((row) => selectedIds.has(row.id));

  const stats = useMemo(() => {
    return (
      data?.summary || {
        total: 0,
        active: 0,
        onLeave: 0,
        suspended: 0,
        terminated: 0,
        missingProfile: 0,
      }
    );
  }, [data?.summary]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

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
        return;
      }
      toast.success(`Imported ${body.created} employee(s).`);
      setImportOpen(false);
      setImportRows([]);
      setImportErrors([]);
      setImportPreviewSummary("");
      await queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employees"] });
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

  const handleExport = async () => {
    try {
      setExportNotice("");
      const params = new URLSearchParams();
      if (searchDebounced.trim()) params.set("q", searchDebounced.trim());
      if (status !== "all") params.set("status", status);
      if (department !== "all") params.set("department", department);
      if (role !== "all") params.set("role", role);
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

  const handleCreate = async () => {
    try {
      const res = await fetch("/api/admin/hr/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to create employee.");
        return;
      }
      toast.success("Employee added.");
      setDialogOpen(false);
      setForm({
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        department: "",
        position: "",
        status: "ACTIVE",
        hireDate: "",
        bankName: "",
        bankAccountName: "",
        bankAccountNumber: "",
        bankCode: "",
        bankBranch: "",
      });
      await queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employees"] });
    } catch {
      toast.error("Failed to create employee.");
    }
  };

  const handleStatusUpdate = async (employee: Employee, nextStatus: EmployeeStatus) => {
    try {
      const payload = {
        status: nextStatus,
        expectedUpdatedAt: employee.updatedAt || "",
        sourcePage: STAFF_SOURCE_PAGE,
        section: "staff-status",
        operation: "update_employee_status",
        resultSummary: "Employee status updated from staff directory.",
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
      await queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employees"] });
    } catch {
      toast.error("Failed to update status.");
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
              completeness,
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
    setCompleteness(view.filters.completeness);
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
    completeness !== "all" ? { key: "completeness", label: `Profile: ${completeness}` } : null,
    sort !== "recent" ? { key: "sort", label: `Sort: ${sort}` } : null,
  ].filter((chip): chip is { key: string; label: string } => Boolean(chip));

  const removeFilterChip = (key: string) => {
    if (key === "q") {
      setSearch("");
      setSearchDebounced("");
    }
    if (key === "status") setStatus("all");
    if (key === "department") setDepartment("all");
    if (key === "role") setRole("all");
    if (key === "completeness") setCompleteness("all");
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
      await queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employees"] });
    } catch {
      toast.error("Bulk update failed.");
    } finally {
      setBulkSaving(false);
    }
  };

  return (
    <section className="space-y-6 pb-20 md:pb-0">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Staff Directory</h1>
          <p className="text-muted-foreground">Maintain employee profiles and status.</p>
          <p className="mt-1 text-xs text-muted-foreground">Employee profiles can be auto-linked when accounts are created in Users & Roles.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href={{ pathname: "/admin/audit", query: { entityType: "EMPLOYEE", sourcePage: STAFF_SOURCE_PAGE } }}>
              Open staff audit log
            </Link>
          </Button>
          <Button variant="outline" onClick={handleExport}>Export CSV</Button>
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
                  </div>
                ) : null}
                {importPreviewSummary ? (
                  <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-700">
                    {importPreviewSummary}
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
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>+ Add employee</Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>Add Employee</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input placeholder="First name" value={form.firstName} onChange={(e) => setForm((p) => ({ ...p, firstName: e.target.value }))} />
                <Input placeholder="Last name" value={form.lastName} onChange={(e) => setForm((p) => ({ ...p, lastName: e.target.value }))} />
                <Input placeholder="Email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} />
                <Input placeholder="Phone" value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} />
                <Input placeholder="Department" value={form.department} onChange={(e) => setForm((p) => ({ ...p, department: e.target.value }))} />
                <Input placeholder="Position" value={form.position} onChange={(e) => setForm((p) => ({ ...p, position: e.target.value }))} />
                <Select value={form.status} onValueChange={(value) => setForm((p) => ({ ...p, status: value }))}>
                  <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACTIVE">Active</SelectItem>
                    <SelectItem value="ON_LEAVE">On leave</SelectItem>
                    <SelectItem value="SUSPENDED">Suspended</SelectItem>
                    <SelectItem value="TERMINATED">Terminated</SelectItem>
                  </SelectContent>
                </Select>
                <Input type="date" value={form.hireDate} onChange={(e) => setForm((p) => ({ ...p, hireDate: e.target.value }))} />
                <Input placeholder="Bank name" value={form.bankName} onChange={(e) => setForm((p) => ({ ...p, bankName: e.target.value }))} />
                <Input placeholder="Bank code" value={form.bankCode} onChange={(e) => setForm((p) => ({ ...p, bankCode: e.target.value }))} />
                <Input placeholder="Account name" value={form.bankAccountName} onChange={(e) => setForm((p) => ({ ...p, bankAccountName: e.target.value }))} />
                <Input placeholder="Account number" value={form.bankAccountNumber} onChange={(e) => setForm((p) => ({ ...p, bankAccountNumber: e.target.value }))} />
                <Input placeholder="Bank branch" value={form.bankBranch} onChange={(e) => setForm((p) => ({ ...p, bankBranch: e.target.value }))} />
              </div>
              <DialogFooter>
                <Button onClick={handleCreate}>Save employee</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">Total</p><p className="text-2xl font-semibold">{stats.total}</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">Active</p><p className="text-2xl font-semibold">{stats.active}</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">On leave</p><p className="text-2xl font-semibold">{stats.onLeave}</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">Suspended</p><p className="text-2xl font-semibold">{stats.suspended}</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">Terminated</p><p className="text-2xl font-semibold">{stats.terminated}</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-xs text-muted-foreground">Needs profile update</p><p className="text-2xl font-semibold">{stats.missingProfile}</p></CardContent></Card>
      </div>

      <Card>
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
            <Select value={completeness} onValueChange={(value) => { setCompleteness(value as CompletenessFilter); setPage(1); }}>
              <SelectTrigger className="w-full md:w-[190px]"><SelectValue placeholder="Profile completeness" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All profiles</SelectItem>
                <SelectItem value="complete">Complete profiles</SelectItem>
                <SelectItem value="missing">Missing key fields</SelectItem>
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
                setCompleteness("all");
                setSort("recent");
                setPageSize(25);
                setPage(1);
              }}
            >
              Clear
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCompleteness("missing");
                setPage(1);
              }}
            >
              Needs profile update
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStatus("ON_LEAVE");
                setPage(1);
              }}
            >
              On leave
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDepartment("__MISSING__");
                setPage(1);
              }}
            >
              No department
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDepartment("all");
                setSearch("");
                setSearchDebounced("");
                setCompleteness("all");
                setRole("all");
                setStatus("all");
                setSort("recent");
                setPage(1);
              }}
            >
              Reset all presets
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
          <div className="flex flex-wrap items-center gap-2">
            <Input placeholder="Save current view name" value={savingViewName} onChange={(e) => setSavingViewName(e.target.value)} className="w-full md:w-64" />
            <Button variant="secondary" onClick={saveCurrentView} disabled={savingViewBusy}>
              {savingViewBusy ? "Saving..." : "Save view"}
            </Button>
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
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading staff...</p>
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
                            <div><span className="text-muted-foreground">Position:</span> {row.position || "-"}</div>
                            <div><span className="text-muted-foreground">Email:</span> {row.email || "-"}</div>
                            <div><span className="text-muted-foreground">Phone:</span> {row.phone || "-"}</div>
                            <div><span className="text-muted-foreground">Role:</span> {row.user?.role || "-"}</div>
                            <div><span className="text-muted-foreground">Updated:</span> {row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "-"}</div>
                          </div>
                          <div className={mobileDensity === "compact" ? "space-y-1.5" : "space-y-2"}>
                            <Badge variant={statusTone[row.status]}>{row.status.replace("_", " ")}</Badge>
                            <Select value={row.status} onValueChange={(value) => handleStatusUpdate(row, value as EmployeeStatus)}>
                              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Update status" /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="ACTIVE">Active</SelectItem>
                                <SelectItem value="ON_LEAVE">On leave</SelectItem>
                                <SelectItem value="SUSPENDED">Suspended</SelectItem>
                                <SelectItem value="TERMINATED">Terminated</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            {missing.length === 0 ? (
                              <Badge variant="secondary">Complete profile</Badge>
                            ) : (
                              <div className="space-y-1">
                                <Badge variant="destructive">Missing {missing.length}</Badge>
                                <div className="text-xs text-muted-foreground">{missing.join(", ")}</div>
                              </div>
                            )}
                          </div>
                          <div className={mobileDensity === "compact" ? "flex flex-wrap gap-1.5" : "flex flex-wrap gap-2"}>
                            <Button asChild size="sm" variant="outline">
                              <Link href={`/admin/hr/staff/${row.id}`}>Open profile</Link>
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={async () => {
                                await navigator.clipboard.writeText(`${window.location.origin}/admin/hr/staff/${row.id}`);
                                toast.success("Profile link copied.");
                              }}
                            >
                              Copy link
                            </Button>
                            <Button asChild size="sm" variant="outline">
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
                                Audit
                              </Link>
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>

              <div className="hidden md:block">
                <Table>
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
                      <TableHead>Name</TableHead>
                      <TableHead>Department</TableHead>
                      <TableHead>Position</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Contact</TableHead>
                      <TableHead>Profile</TableHead>
                      <TableHead>Last updated</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pagedRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center text-sm text-muted-foreground">
                          No staff found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      pagedRows.map((row) => {
                        const missing = getMissingProfileFields(row);
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
                            <TableCell>
                              <Link href={`/admin/hr/staff/${row.id}`} className="font-medium underline-offset-2 hover:underline">
                                {row.firstName} {row.lastName}
                              </Link>
                              <div className="text-xs text-muted-foreground">
                                {row.hireDate ? `Hired ${new Date(row.hireDate).toLocaleDateString()}` : "Hire date not set"}
                              </div>
                            </TableCell>
                            <TableCell>{row.department || "-"}</TableCell>
                            <TableCell>{row.position || "-"}</TableCell>
                            <TableCell>
                              <div className="flex min-w-[170px] flex-col gap-1">
                                <Badge variant={statusTone[row.status]}>{row.status.replace("_", " ")}</Badge>
                                <Select value={row.status} onValueChange={(value) => handleStatusUpdate(row, value as EmployeeStatus)}>
                                  <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Update status" /></SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="ACTIVE">Active</SelectItem>
                                    <SelectItem value="ON_LEAVE">On leave</SelectItem>
                                    <SelectItem value="SUSPENDED">Suspended</SelectItem>
                                    <SelectItem value="TERMINATED">Terminated</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="text-sm">{row.email || "-"}</div>
                              <div className="text-xs text-muted-foreground">{row.phone || "-"}</div>
                              <div className="text-xs text-muted-foreground">Role: {row.user?.role || "-"}</div>
                            </TableCell>
                            <TableCell>
                              {missing.length === 0 ? (
                                <Badge variant="secondary">Complete</Badge>
                              ) : (
                                <div className="space-y-1">
                                  <Badge variant="destructive">Missing {missing.length}</Badge>
                                  <div className="text-xs text-muted-foreground">{missing.join(", ")}</div>
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "-"}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-2">
                                <Button asChild size="sm" variant="outline">
                                  <Link href={`/admin/hr/staff/${row.id}`}>Open profile</Link>
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={async () => {
                                    await navigator.clipboard.writeText(`${window.location.origin}/admin/hr/staff/${row.id}`);
                                    toast.success("Profile link copied.");
                                  }}
                                >
                                  Copy link
                                </Button>
                                <Button asChild size="sm" variant="outline">
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
                                    Audit
                                  </Link>
                                </Button>
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
    </section>
  );
}
