"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import Link from "next/link";
import { Textarea } from "@/components/ui/textarea";
import {
  canTransitionIssueStatus,
  prettyIssueStatus,
  statusRequiresResolution,
  type IssueStatus,
} from "@/lib/hr-issues-utils";

type Employee = {
  id: string;
  firstName: string;
  lastName: string;
};

type StaffIssue = {
  id: string;
  employeeId: string;
  employee?: { firstName: string; lastName: string } | null;
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
  description: string;
  resolution?: string | null;
  openedAt?: string;
  createdAt: string;
  closedAt?: string | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AdminHrIssuesPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [detailIssue, setDetailIssue] = useState<StaffIssue | null>(null);
  const [editingIssue, setEditingIssue] = useState<StaffIssue | null>(null);
  const [searchText, setSearchText] = useState("");
  const [employeeFilter, setEmployeeFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [sort, setSort] = useState("createdAt_desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("25");
  const [selectedIssueIds, setSelectedIssueIds] = useState<string[]>([]);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [bulkTargetStatus, setBulkTargetStatus] = useState<IssueStatus | null>(null);
  const [bulkResolution, setBulkResolution] = useState("");
  const [presetName, setPresetName] = useState("");
  const [savedPresets, setSavedPresets] = useState<Record<string, string>>({});
  const [selectedPreset, setSelectedPreset] = useState("none");
  const [form, setForm] = useState({
    employeeId: "",
    type: "",
    severity: "LOW",
    status: "OPEN",
    description: "",
  });
  const [editForm, setEditForm] = useState({
    type: "",
    severity: "LOW",
    status: "OPEN",
    description: "",
    resolution: "",
    openedAt: "",
    closedAt: "",
  });

  const { data: employeesData } = useQuery({
    queryKey: ["admin", "hr", "employees"],
    queryFn: () => fetcher("/api/admin/hr/employees"),
  });

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (searchText.trim()) params.set("q", searchText.trim());
    if (employeeFilter !== "all") params.set("employeeId", employeeFilter);
    if (severityFilter !== "all") params.set("severity", severityFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    if (sort !== "createdAt_desc") params.set("sort", sort);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    return `/api/admin/hr/issues?${params.toString()}`;
  }, [searchText, employeeFilter, severityFilter, statusFilter, fromDate, toDate, sort, page, pageSize]);

  const { data: issuesData } = useQuery({
    queryKey: [
      "admin",
      "hr",
      "issues",
      searchText,
      employeeFilter,
      severityFilter,
      statusFilter,
      fromDate,
      toDate,
      sort,
      page,
      pageSize,
    ],
    queryFn: () => fetcher(query),
  });

  const employees = useMemo(
    () => (Array.isArray(employeesData?.rows) ? (employeesData.rows as Employee[]) : []),
    [employeesData],
  );
  const issues = useMemo(
    () => (Array.isArray(issuesData?.rows) ? (issuesData.rows as StaffIssue[]) : []),
    [issuesData],
  );
  const total = Number(issuesData?.total || 0);
  const totalPages = Number(issuesData?.totalPages || 1);
  const agingSummary = useMemo(() => {
    const now = Date.now();
    let active = 0;
    let olderThan7 = 0;
    let olderThan14 = 0;
    for (const issue of issues) {
      if (issue.status === "RESOLVED" || issue.status === "CLOSED") continue;
      active += 1;
      const ageDays = Math.floor((now - new Date(issue.createdAt).getTime()) / (24 * 60 * 60 * 1000));
      if (ageDays > 7) olderThan7 += 1;
      if (ageDays > 14) olderThan14 += 1;
    }
    return { active, olderThan7, olderThan14 };
  }, [issues]);

  const handleCreateIssue = async () => {
    try {
      const res = await fetch("/api/admin/hr/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to create staff issue.");
        return;
      }
      toast.success("Staff issue logged.");
      setDialogOpen(false);
      setForm({ employeeId: "", type: "", severity: "LOW", status: "OPEN", description: "" });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "issues"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to create staff issue.");
    }
  };

  const issueStatuses: IssueStatus[] = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];

  const handleIssueStatusUpdate = async (issueId: string, status: StaffIssue["status"]) => {
    try {
      const res = await fetch(`/api/admin/hr/issues/${issueId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || "Failed to update status.");
        return;
      }
      toast.success("Issue updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "issues"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update status.");
    }
  };

  const toggleSelectedIssue = (issueId: string) => {
    setSelectedIssueIds((current) =>
      current.includes(issueId) ? current.filter((id) => id !== issueId) : [...current, issueId],
    );
  };

  const toggleSelectAllVisible = () => {
    const rowIds = issues.map((issue) => issue.id);
    const allSelected = rowIds.length > 0 && rowIds.every((id) => selectedIssueIds.includes(id));
    if (allSelected) {
      setSelectedIssueIds((current) => current.filter((id) => !rowIds.includes(id)));
      return;
    }
    setSelectedIssueIds((current) => Array.from(new Set([...current, ...rowIds])));
  };

  const performBulkStatusUpdate = async (
    targetStatus: StaffIssue["status"],
    resolution: string,
  ) => {
    if (selectedIssueIds.length === 0) {
      toast.error("Select at least one issue.");
      return;
    }
    try {
      const res = await fetch("/api/admin/hr/issues/bulk-workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueIds: selectedIssueIds, targetStatus, resolution }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Bulk status update failed.");
        return;
      }
      const successCount = Number(body.successCount || 0);
      const failureCount = Number(body.failureCount || 0);
      if (successCount > 0) {
        toast.success(`Updated ${successCount} issue(s).`);
        setSelectedIssueIds([]);
      }
      if (failureCount > 0) {
        const failures = Array.isArray(body.failures) ? body.failures : [];
        const summary = failures
          .slice(0, 3)
          .map((item: { issueId?: string; reason?: string }) => `${item.issueId || "unknown"}: ${item.reason || "Unknown"}`)
          .join(" | ");
        toast.error(
          failureCount > 3 ? `${failureCount} failed. ${summary} ...` : `${failureCount} failed. ${summary}`,
        );
      }
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "issues"] });
    } catch (err) {
      console.error(err);
      toast.error("Bulk status update failed.");
    }
  };

  const requestBulkStatusUpdate = (targetStatus: StaffIssue["status"]) => {
    if (selectedIssueIds.length === 0) {
      toast.error("Select at least one issue.");
      return;
    }
    if (!statusRequiresResolution(targetStatus)) {
      void performBulkStatusUpdate(targetStatus, "");
      return;
    }
    setBulkTargetStatus(targetStatus);
    setBulkResolution("");
    setBulkDialogOpen(true);
  };

  const handleOpenDetail = (issue: StaffIssue) => {
    setDetailIssue(issue);
    setDetailOpen(true);
  };

  const handleOpenEdit = (issue: StaffIssue) => {
    setEditingIssue(issue);
    setEditForm({
      type: issue.type || "",
      severity: issue.severity || "LOW",
      status: issue.status || "OPEN",
      description: issue.description || "",
      resolution: issue.resolution || "",
      openedAt: issue.openedAt ? new Date(issue.openedAt).toISOString().slice(0, 10) : "",
      closedAt: issue.closedAt ? new Date(issue.closedAt).toISOString().slice(0, 10) : "",
    });
    setEditOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editingIssue) return;
    try {
      const res = await fetch(`/api/admin/hr/issues/${editingIssue.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update issue.");
        return;
      }
      toast.success("Issue updated.");
      setEditOpen(false);
      setEditingIssue(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "issues"] });
    } catch (err) {
      console.error(err);
      toast.error("Failed to update issue.");
    }
  };

  const saveCurrentFilterPreset = () => {
    const name = presetName.trim();
    if (!name) {
      toast.error("Enter a preset name.");
      return;
    }
    const params = new URLSearchParams();
    if (searchText.trim()) params.set("q", searchText.trim());
    if (employeeFilter !== "all") params.set("employeeId", employeeFilter);
    if (severityFilter !== "all") params.set("severity", severityFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    if (sort !== "createdAt_desc") params.set("sort", sort);
    if (pageSize !== "25") params.set("pageSize", pageSize);
    const next = { ...savedPresets, [name]: params.toString() };
    setSavedPresets(next);
    setSelectedPreset(name);
    window.localStorage.setItem("hr.issues.filterPresets", JSON.stringify(next));
    toast.success("Filter preset saved.");
  };

  const applyFilterPreset = (name: string) => {
    if (name === "none") return;
    const encoded = savedPresets[name];
    if (!encoded) return;
    const params = new URLSearchParams(encoded);
    setSearchText(params.get("q") || "");
    setEmployeeFilter(params.get("employeeId") || "all");
    setSeverityFilter(params.get("severity") || "all");
    setStatusFilter(params.get("status") || "all");
    setFromDate(params.get("from") || "");
    setToDate(params.get("to") || "");
    setSort(params.get("sort") || "createdAt_desc");
    setPageSize(params.get("pageSize") || "25");
    setPage(1);
    setSelectedPreset(name);
  };

  const deleteSelectedPreset = () => {
    if (selectedPreset === "none") {
      toast.error("Select a preset to delete.");
      return;
    }
    const next = { ...savedPresets };
    delete next[selectedPreset];
    setSavedPresets(next);
    setSelectedPreset("none");
    window.localStorage.setItem("hr.issues.filterPresets", JSON.stringify(next));
    toast.success("Preset deleted.");
  };

  const copyFilterLink = async () => {
    try {
      const url = new URL(`${window.location.origin}/admin/hr/issues`);
      const params = new URLSearchParams();
      if (searchText.trim()) params.set("q", searchText.trim());
      if (employeeFilter !== "all") params.set("employeeId", employeeFilter);
      if (severityFilter !== "all") params.set("severity", severityFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      if (sort !== "createdAt_desc") params.set("sort", sort);
      if (pageSize !== "25") params.set("pageSize", pageSize);
      url.search = params.toString();
      await navigator.clipboard.writeText(url.toString());
      toast.success("Filter link copied.");
    } catch {
      toast.error("Could not copy filter link.");
    }
  };

  const exportCurrentView = () => {
    const params = new URLSearchParams();
    if (searchText.trim()) params.set("q", searchText.trim());
    if (employeeFilter !== "all") params.set("employeeId", employeeFilter);
    if (severityFilter !== "all") params.set("severity", severityFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    if (sort !== "createdAt_desc") params.set("sort", sort);
    window.location.href = `/api/admin/hr/reports/issues?${params.toString()}`;
  };

  const severityBadgeClass = (severity: StaffIssue["severity"]) =>
    severity === "CRITICAL"
      ? "bg-red-100 text-red-700"
      : severity === "HIGH"
        ? "bg-orange-100 text-orange-700"
        : severity === "MEDIUM"
          ? "bg-amber-100 text-amber-700"
          : "bg-slate-100 text-slate-700";

  const statusBadgeClass = (status: StaffIssue["status"]) =>
    status === "OPEN"
      ? "bg-slate-100 text-slate-700"
      : status === "IN_PROGRESS"
        ? "bg-blue-100 text-blue-700"
        : status === "RESOLVED"
          ? "bg-green-100 text-green-700"
          : "bg-zinc-200 text-zinc-700";

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("hr.issues.filterPresets");
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (parsed && typeof parsed === "object") {
        setSavedPresets(parsed);
      }
    } catch {
      // ignore invalid local storage
    }
  }, []);

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Staff Issues</h1>
          <p className="text-muted-foreground">Track and resolve HR cases.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href="/admin/audit?entityType=STAFF_ISSUE&sourcePage=admin/hr/issues">Issues Audit Log</Link>
          </Button>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>+ Log Issue</Button>
          </DialogTrigger>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>New Staff Issue</DialogTitle>
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
                placeholder="Issue type (e.g. Salary dispute)"
                value={form.type}
                onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}
              />
              <Select
                value={form.severity}
                onValueChange={(value) => setForm((prev) => ({ ...prev, severity: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Severity" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOW">Low</SelectItem>
                  <SelectItem value="MEDIUM">Medium</SelectItem>
                  <SelectItem value="HIGH">High</SelectItem>
                  <SelectItem value="CRITICAL">Critical</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={form.status}
                onValueChange={(value) => setForm((prev) => ({ ...prev, status: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPEN">Open</SelectItem>
                  <SelectItem value="IN_PROGRESS">In progress</SelectItem>
                  <SelectItem value="RESOLVED">Resolved</SelectItem>
                  <SelectItem value="CLOSED">Closed</SelectItem>
                </SelectContent>
              </Select>
              <Textarea
                placeholder="Description"
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                rows={4}
              />
            </div>
            <div className="flex justify-end">
              <Button onClick={handleCreateIssue}>Save issue</Button>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Issue Details</DialogTitle>
            </DialogHeader>
            {detailIssue ? (
              <div className="grid gap-3 text-sm">
                <div><span className="text-muted-foreground">Type:</span> {detailIssue.type}</div>
                <div><span className="text-muted-foreground">Severity:</span> {detailIssue.severity}</div>
                <div><span className="text-muted-foreground">Status:</span> {detailIssue.status}</div>
                <div><span className="text-muted-foreground">Description:</span> {detailIssue.description || "Not available"}</div>
                <div><span className="text-muted-foreground">Resolution:</span> {detailIssue.resolution || "Not available"}</div>
                <div>
                  <span className="text-muted-foreground">Opened:</span>{" "}
                  {detailIssue.openedAt ? new Date(detailIssue.openedAt).toLocaleDateString() : "Not available"}
                </div>
                <div>
                  <span className="text-muted-foreground">Logged:</span>{" "}
                  {new Date(detailIssue.createdAt).toLocaleDateString()}
                </div>
                <div>
                  <span className="text-muted-foreground">Closed:</span>{" "}
                  {detailIssue.closedAt ? new Date(detailIssue.closedAt).toLocaleDateString() : "Not available"}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No issue selected.</p>
            )}
          </DialogContent>
        </Dialog>
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Edit Issue</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3">
              <Input
                placeholder="Issue type"
                value={editForm.type}
                onChange={(e) => setEditForm((prev) => ({ ...prev, type: e.target.value }))}
              />
              <Select
                value={editForm.severity}
                onValueChange={(value) => setEditForm((prev) => ({ ...prev, severity: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Severity" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOW">Low</SelectItem>
                  <SelectItem value="MEDIUM">Medium</SelectItem>
                  <SelectItem value="HIGH">High</SelectItem>
                  <SelectItem value="CRITICAL">Critical</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={editForm.status}
                onValueChange={(value) => setEditForm((prev) => ({ ...prev, status: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  {issueStatuses.map((option) => (
                    <SelectItem
                      key={option}
                      value={option}
                      disabled={editingIssue ? !canTransitionIssueStatus(editingIssue.status, option) : false}
                    >
                      {prettyIssueStatus(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Textarea
                placeholder="Description"
                value={editForm.description}
                onChange={(e) => setEditForm((prev) => ({ ...prev, description: e.target.value }))}
                rows={4}
              />
              <Textarea
                placeholder="Resolution (required for Resolved/Closed)"
                value={editForm.resolution}
                onChange={(e) => setEditForm((prev) => ({ ...prev, resolution: e.target.value }))}
                rows={3}
              />
              <Input
                type="date"
                value={editForm.openedAt}
                onChange={(e) => setEditForm((prev) => ({ ...prev, openedAt: e.target.value }))}
              />
              <Input
                type="date"
                value={editForm.closedAt}
                onChange={(e) => setEditForm((prev) => ({ ...prev, closedAt: e.target.value }))}
              />
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSaveEdit}>Save changes</Button>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog open={bulkDialogOpen} onOpenChange={setBulkDialogOpen}>
          <DialogContent className="max-w-xl">
            <DialogHeader>
              <DialogTitle>Bulk Resolution Note</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {bulkTargetStatus === "CLOSED"
                  ? "Closing issues requires a resolution note."
                  : "Resolving issues requires a resolution note."}
              </p>
              <Textarea
                rows={4}
                placeholder="Enter one resolution note for all selected issues"
                value={bulkResolution}
                onChange={(e) => setBulkResolution(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setBulkDialogOpen(false);
                  setBulkTargetStatus(null);
                  setBulkResolution("");
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (!bulkTargetStatus) return;
                  const note = bulkResolution.trim();
                  if (!note) {
                    toast.error("Resolution note is required.");
                    return;
                  }
                  setBulkDialogOpen(false);
                  void performBulkStatusUpdate(bulkTargetStatus, note);
                }}
              >
                Apply
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Issue Aging Snapshot (Current Page)</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3 text-sm">
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Active Issues</div>
            <div className="font-semibold">{agingSummary.active}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Older than 7 days</div>
            <div className="font-semibold text-amber-700">{agingSummary.olderThan7}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Older than 14 days</div>
            <div className="font-semibold text-red-600">{agingSummary.olderThan14}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Logged Issues</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Input
              className="w-56"
              placeholder="Search issue type/description/employee"
              value={searchText}
              onChange={(e) => {
                setSearchText(e.target.value);
                setPage(1);
              }}
            />
            <Select
              value={employeeFilter}
              onValueChange={(value) => {
                setEmployeeFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Employee" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All employees</SelectItem>
                {employees.map((employee) => (
                  <SelectItem key={employee.id} value={employee.id}>
                    {employee.firstName} {employee.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={severityFilter}
              onValueChange={(value) => {
                setSeverityFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All severity</SelectItem>
                <SelectItem value="LOW">Low</SelectItem>
                <SelectItem value="MEDIUM">Medium</SelectItem>
                <SelectItem value="HIGH">High</SelectItem>
                <SelectItem value="CRITICAL">Critical</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All status</SelectItem>
                <SelectItem value="OPEN">Open</SelectItem>
                <SelectItem value="IN_PROGRESS">In progress</SelectItem>
                <SelectItem value="RESOLVED">Resolved</SelectItem>
                <SelectItem value="CLOSED">Closed</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="date"
              className="w-40"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setPage(1);
              }}
            />
            <Input
              type="date"
              className="w-40"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setPage(1);
              }}
            />
            <Select
              value={sort}
              onValueChange={(value) => {
                setSort(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="createdAt_desc">Newest logged</SelectItem>
                <SelectItem value="createdAt_asc">Oldest logged</SelectItem>
                <SelectItem value="severity_desc">Severity high-low</SelectItem>
                <SelectItem value="severity_asc">Severity low-high</SelectItem>
                <SelectItem value="status_asc">Status A-Z</SelectItem>
                <SelectItem value="status_desc">Status Z-A</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSearchText("");
                setEmployeeFilter("all");
                setSeverityFilter("all");
                setStatusFilter("all");
                setFromDate("");
                setToDate("");
                setSort("createdAt_desc");
                setPageSize("25");
                setPage(1);
              }}
            >
              Clear filters
            </Button>
            <Input
              className="w-40"
              placeholder="Preset name"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <Button size="sm" variant="outline" onClick={saveCurrentFilterPreset}>
              Save preset
            </Button>
            <Select
              value={selectedPreset}
              onValueChange={(value) => {
                setSelectedPreset(value);
                applyFilterPreset(value);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Load preset" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Load preset</SelectItem>
                {Object.keys(savedPresets)
                  .sort((a, b) => a.localeCompare(b))
                  .map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={deleteSelectedPreset}>
              Delete preset
            </Button>
            <Button size="sm" variant="outline" onClick={copyFilterLink}>
              Copy filter link
            </Button>
            <Button size="sm" variant="outline" onClick={exportCurrentView}>
              Export current view
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <Button size="sm" variant="outline" onClick={toggleSelectAllVisible}>
              {issues.length > 0 && issues.every((issue) => selectedIssueIds.includes(issue.id))
                ? "Unselect all visible"
                : "Select all visible"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => requestBulkStatusUpdate("IN_PROGRESS")}>
              Start progress
            </Button>
            <Button size="sm" variant="outline" onClick={() => requestBulkStatusUpdate("RESOLVED")}>
              Resolve selected
            </Button>
            <Button size="sm" variant="outline" onClick={() => requestBulkStatusUpdate("CLOSED")}>
              Close selected
            </Button>
            <Button size="sm" variant="outline" onClick={() => requestBulkStatusUpdate("OPEN")}>
              Reopen selected
            </Button>
            <span className="text-muted-foreground">{selectedIssueIds.length} selected</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Select</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Logged</TableHead>
                <TableHead>Closed</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {issues.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                    No staff issues logged yet.
                  </TableCell>
                </TableRow>
              ) : (
                issues.map((issue) => {
                  const employee = issue.employee || employees.find((e) => e.id === issue.employeeId);
                  return (
                    <TableRow key={issue.id}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selectedIssueIds.includes(issue.id)}
                          onChange={() => toggleSelectedIssue(issue.id)}
                          aria-label={`Select issue ${issue.id}`}
                        />
                      </TableCell>
                      <TableCell>
                        {employee ? `${employee.firstName} ${employee.lastName}` : "Not available"}
                      </TableCell>
                      <TableCell>{issue.type}</TableCell>
                      <TableCell>
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${severityBadgeClass(issue.severity)}`}>
                          {issue.severity}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={issue.status}
                          onValueChange={(value) =>
                            handleIssueStatusUpdate(issue.id, value as StaffIssue["status"])
                          }
                        >
                          <SelectTrigger className="h-7 w-full sm:w-[150px] text-xs">
                            <SelectValue placeholder="Status" />
                          </SelectTrigger>
                          <SelectContent>
                            {issueStatuses.map((option) => (
                              <SelectItem
                                key={option}
                                value={option}
                                disabled={!canTransitionIssueStatus(issue.status, option)}
                              >
                                {prettyIssueStatus(option)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="mt-1">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${statusBadgeClass(issue.status)}`}>
                            {issue.status === "IN_PROGRESS" ? "IN PROGRESS" : issue.status}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>{new Date(issue.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        {issue.closedAt ? new Date(issue.closedAt).toLocaleDateString() : "Not available"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={() => handleOpenDetail(issue)}>
                            View
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => handleOpenEdit(issue)}>
                            Edit
                          </Button>
                          <Button size="sm" variant="outline" asChild>
                            <Link href={`/admin/audit?entityType=STAFF_ISSUE&entityId=${encodeURIComponent(issue.id)}&sourcePage=admin/hr/issues`}>
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
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <div>
              Page {page} of {Math.max(1, totalPages)} | {total} issue(s)
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={pageSize}
                onValueChange={(value) => {
                  setPageSize(value);
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-8 w-28">
                  <SelectValue placeholder="Rows" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10 rows</SelectItem>
                  <SelectItem value="25">25 rows</SelectItem>
                  <SelectItem value="50">50 rows</SelectItem>
                  <SelectItem value="100">100 rows</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page <= 1}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPage((current) => Math.min(Math.max(1, totalPages), current + 1))}
                disabled={page >= Math.max(1, totalPages)}
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
