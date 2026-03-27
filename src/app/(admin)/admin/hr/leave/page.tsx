"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSearchParams } from "next/navigation";
import { humanizeLeaveStatus, humanizeLeaveType } from "@/lib/hr-leave-utils";

type Employee = {
  id: string;
  firstName: string;
  lastName: string;
};

type LeaveRequest = {
  id: string;
  employeeId: string;
  type: "ANNUAL" | "SICK" | "UNPAID" | "OTHER";
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";
  startDate: string;
  endDate: string;
  updatedAt: string;
  cancelledAt?: string | null;
  reason?: string | null;
  employee?: Employee;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function isBetween(day: Date, start: Date, end: Date) {
  const time = new Date(day).setHours(0, 0, 0, 0);
  const startTime = new Date(start).setHours(0, 0, 0, 0);
  const endTime = new Date(end).setHours(0, 0, 0, 0);
  return time >= startTime && time <= endTime;
}

function LeaveTrackingPageContent() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const presetEmployeeId = searchParams?.get("employeeId") || "";
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("all");
  const [employeeFilter, setEmployeeFilter] = useState(presetEmployeeId || "all");
  const [workweekDays, setWorkweekDays] = useState(5);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [activeTodayOnly, setActiveTodayOnly] = useState(false);
  const [jumpPage, setJumpPage] = useState("1");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [savingLeaveId, setSavingLeaveId] = useState<string | null>(null);
  const [creatingLeave, setCreatingLeave] = useState(false);
  const [decisionDialog, setDecisionDialog] = useState<{
    open: boolean;
    row: LeaveRequest | null;
    nextStatus: "REJECTED" | "CANCELLED" | null;
    note: string;
  }>({
    open: false,
    row: null,
    nextStatus: null,
    note: "",
  });
  const [form, setForm] = useState({
    employeeId: presetEmployeeId,
    type: "ANNUAL",
    startDate: "",
    endDate: "",
    reason: "",
  });

  const { data: employeesData } = useQuery({
    queryKey: ["admin", "hr", "employees"],
    queryFn: () => fetcher("/api/admin/hr/employees"),
  });

  const { data: settingsData } = useQuery({
    queryKey: ["admin", "hr", "settings", "workweekDays"],
    queryFn: () => fetcher("/api/admin/hr/settings?keys=hr.workweekDays"),
  });

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (!activeTodayOnly && status !== "all") params.set("status", status);
    if (type !== "all") params.set("type", type);
    if (employeeFilter !== "all") params.set("employeeId", employeeFilter);
    if (activeTodayOnly) params.set("activeToday", "1");
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    return `/api/admin/hr/leave?${params.toString()}`;
  }, [activeTodayOnly, status, type, employeeFilter, page, pageSize]);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "hr", "leave", activeTodayOnly, status, type, employeeFilter, page, pageSize],
    queryFn: () => fetcher(query),
  });

  const employees = Array.isArray(employeesData?.rows) ? (employeesData.rows as Employee[]) : [];
  const rows = useMemo(
    () => (Array.isArray(data?.rows) ? (data.rows as LeaveRequest[]) : []),
    [data],
  );
  const total = Number(data?.total || 0);
  const totalPages = Number(data?.totalPages || 1);

  useEffect(() => {
    setPage(1);
  }, [activeTodayOnly, status, type, employeeFilter, pageSize]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    setJumpPage(String(page));
  }, [page]);

  const resolveWorkweekDays = (value: unknown) => {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 5 && num <= 7) return Math.floor(num);
    return 5;
  };

  useEffect(() => {
    const remote = settingsData?.values?.["hr.workweekDays"];
    setWorkweekDays(resolveWorkweekDays(remote));
  }, [settingsData]);

  const hasOverlap = (targetStart: Date, targetEnd: Date, existingStart: string, existingEnd: string) => {
    const start = new Date(existingStart);
    const end = new Date(existingEnd);
    return start <= targetEnd && end >= targetStart;
  };

  const handleCreate = async () => {
    if (!form.employeeId || !form.startDate || !form.endDate) {
      toast.error("Employee, start date, and end date are required.");
      return;
    }
    const startDate = new Date(form.startDate);
    const endDate = new Date(form.endDate);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      toast.error("Enter valid leave dates.");
      return;
    }
    if (endDate < startDate) {
      toast.error("End date must be after start date.");
      return;
    }
    try {
      const existingRes = await fetch(`/api/admin/hr/leave?employeeId=${form.employeeId}&page=1&pageSize=200`);
      const existingBody = await existingRes.json().catch(() => ({}));
      const existingRows = Array.isArray(existingBody?.rows) ? (existingBody.rows as LeaveRequest[]) : [];
      const activeOverlap = existingRows.some((row) => {
        if (row.status !== "REQUESTED" && row.status !== "APPROVED") return false;
        return hasOverlap(startDate, endDate, row.startDate, row.endDate);
      });
      if (activeOverlap) {
        toast.error("This leave overlaps another active leave request for this employee.");
        return;
      }
    } catch {
      // continue and let the server validate overlap
    }
    setCreatingLeave(true);
    try {
      const res = await fetch("/api/admin/hr/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to create leave request.");
        return;
      }
      toast.success("Leave request created.");
      setDialogOpen(false);
      setForm({ employeeId: "", type: "ANNUAL", startDate: "", endDate: "", reason: "" });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "leave"] });
    } catch {
      toast.error("Failed to create leave request.");
    } finally {
      setCreatingLeave(false);
    }
  };

  const handleStatusUpdate = async (
    row: LeaveRequest,
    nextStatus: LeaveRequest["status"],
    decisionNote = "",
  ) => {
    setSavingLeaveId(row.id);
    try {
      const res = await fetch(`/api/admin/hr/leave/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: nextStatus,
          decisionNote,
          expectedUpdatedAt: row.updatedAt,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update leave status.");
        return;
      }
      toast.success("Leave status updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "leave"] });
    } catch {
      toast.error("Failed to update leave status.");
    } finally {
      setSavingLeaveId(null);
    }
  };

  const openDecisionDialog = (row: LeaveRequest, nextStatus: "REJECTED" | "CANCELLED") => {
    setDecisionDialog({
      open: true,
      row,
      nextStatus,
      note: "",
    });
  };

  const handleDecisionSubmit = async () => {
    if (!decisionDialog.row || !decisionDialog.nextStatus) return;
    const note = decisionDialog.note.trim();
    if (note.length < 3) {
      toast.error("A short note is required.");
      return;
    }
    const row = decisionDialog.row;
    const nextStatus = decisionDialog.nextStatus;
    setDecisionDialog({
      open: false,
      row: null,
      nextStatus: null,
      note: "",
    });
    await handleStatusUpdate(row, nextStatus, note);
  };

  const canTransitionStatus = (
    from: LeaveRequest["status"],
    to: LeaveRequest["status"],
  ) => {
    if (from === "REQUESTED") return to === "APPROVED" || to === "REJECTED" || to === "CANCELLED";
    if (from === "APPROVED") return to === "CANCELLED";
    return false;
  };

  const summary = useMemo(() => {
    let requested = 0;
    let approved = 0;
    let cancelled = 0;
    rows.forEach((row) => {
      if (row.status === "REQUESTED") requested += 1;
      if (row.status === "APPROVED") approved += 1;
      if (row.status === "CANCELLED") cancelled += 1;
    });
    return { requested, approved, cancelled };
  }, [rows]);

  const countWorkingDays = (start: Date, end: Date) => {
    const days: number[] = [];
    if (workweekDays >= 7) {
      days.push(0, 1, 2, 3, 4, 5, 6);
    } else if (workweekDays === 6) {
      days.push(1, 2, 3, 4, 5, 6);
    } else {
      days.push(1, 2, 3, 4, 5);
    }
    const startDate = new Date(start);
    const endDate = new Date(end);
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(0, 0, 0, 0);
    if (endDate < startDate) return 0;
    let count = 0;
    const current = new Date(startDate);
    while (current <= endDate) {
      if (days.includes(current.getDay())) count += 1;
      current.setDate(current.getDate() + 1);
    }
    return count;
  };

  const approvedDays = (row: LeaveRequest) => {
    const start = new Date(row.startDate);
    const end = new Date(row.endDate);
    return countWorkingDays(start, end);
  };

  const usedDays = (row: LeaveRequest) => {
    if (row.status !== "APPROVED" && row.status !== "CANCELLED") return 0;
    const start = new Date(row.startDate);
    const end = new Date(row.endDate);
    const today = new Date();
    const endLimit = row.status === "CANCELLED" && row.cancelledAt
      ? new Date(row.cancelledAt)
      : today;
    const cappedEnd = endLimit < end ? endLimit : end;
    if (cappedEnd < start) return 0;
    const days = countWorkingDays(start, cappedEnd);
    return Math.min(approvedDays(row), days);
  };

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Leave Tracking</h1>
          <p className="text-muted-foreground">Manage time off requests and approvals.</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>+ Add Leave</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Add Leave Request</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select value={form.employeeId} onValueChange={(value) => setForm((prev) => ({ ...prev, employeeId: value }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Employee" />
                </SelectTrigger>
                <SelectContent>
                  {employees.map((employee) => (
                    <SelectItem key={employee.id} value={employee.id}>
                      {employee.firstName} {employee.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={form.type} onValueChange={(value) => setForm((prev) => ({ ...prev, type: value }))}>
                <SelectTrigger>
                  <SelectValue placeholder="Leave type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ANNUAL">Annual</SelectItem>
                  <SelectItem value="SICK">Sick</SelectItem>
                  <SelectItem value="UNPAID">Unpaid</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((prev) => ({ ...prev, startDate: e.target.value }))}
              />
              <Input
                type="date"
                value={form.endDate}
                onChange={(e) => setForm((prev) => ({ ...prev, endDate: e.target.value }))}
              />
              <Input
                placeholder="Reason (optional)"
                value={form.reason}
                onChange={(e) => setForm((prev) => ({ ...prev, reason: e.target.value }))}
                className="sm:col-span-2"
              />
            </div>
            <div className="flex justify-end">
              <Button onClick={handleCreate} disabled={creatingLeave}>
                {creatingLeave ? "Saving..." : "Save leave"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">Requested</div>
            <div className="text-2xl font-semibold">{summary.requested}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">Approved</div>
            <div className="text-2xl font-semibold">{summary.approved}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-xs text-muted-foreground">Cancelled</div>
            <div className="text-2xl font-semibold">{summary.cancelled}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Calendar View</CardTitle>
          </CardHeader>
          <CardContent>
            <Calendar
              mode="single"
              modifiers={{
                leave: (day) =>
                  rows.some((row) =>
                    row.status !== "REJECTED" &&
                    row.status !== "CANCELLED" &&
                    isBetween(day, new Date(row.startDate), new Date(row.endDate))
                  ),
              }}
              modifiersClassNames={{
                leave: "bg-amber-100 text-amber-900",
              }}
            />
            <div className="mt-3 text-xs text-muted-foreground">
              Highlighted days indicate approved or requested leave windows.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Filters</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            <div className="rounded-md border px-3 py-2">
              <div className="text-xs text-muted-foreground">Workweek setting</div>
              <div className="mt-0.5 text-sm font-medium">{workweekDays}-day week</div>
              <Button asChild variant="link" size="sm" className="h-auto px-0 py-1 text-xs">
                <Link href="/admin/hr/settings">Change in HR Settings</Link>
              </Button>
            </div>
            <Select value={employeeFilter} onValueChange={setEmployeeFilter}>
              <SelectTrigger>
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
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="REQUESTED">Requested</SelectItem>
                <SelectItem value="APPROVED">Approved</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger>
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="ANNUAL">Annual</SelectItem>
                <SelectItem value="SICK">Sick</SelectItem>
                <SelectItem value="UNPAID">Unpaid</SelectItem>
                <SelectItem value="OTHER">Other</SelectItem>
              </SelectContent>
            </Select>
            <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
              <SelectTrigger>
                <SelectValue placeholder="Rows per page" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10 rows</SelectItem>
                <SelectItem value="25">25 rows</SelectItem>
                <SelectItem value="50">50 rows</SelectItem>
                <SelectItem value="100">100 rows</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant={activeTodayOnly ? "default" : "outline"}
              onClick={() => setActiveTodayOnly((prev) => !prev)}
            >
              {activeTodayOnly ? "Showing active today" : "Show active today"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Leave Requests</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading leave requests...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead>Approved/Used</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                      No leave requests yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        {row.employee ? `${row.employee.firstName} ${row.employee.lastName}` : "Not set"}
                      </TableCell>
                      <TableCell>{humanizeLeaveType(row.type)}</TableCell>
                      <TableCell>{humanizeLeaveStatus(row.status)}</TableCell>
                      <TableCell>
                        {new Date(row.startDate).toLocaleDateString()} -{" "}
                        {new Date(row.endDate).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <div className="text-xs">
                          {approvedDays(row)}/{usedDays(row)}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{row.reason || "Not provided"}</TableCell>
                      <TableCell className="flex flex-wrap gap-2">
                        {canTransitionStatus(row.status, "APPROVED") ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={savingLeaveId === row.id}
                            onClick={() => handleStatusUpdate(row, "APPROVED")}
                          >
                            Approve
                          </Button>
                        ) : null}
                        {canTransitionStatus(row.status, "REJECTED") ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={savingLeaveId === row.id}
                            onClick={() => openDecisionDialog(row, "REJECTED")}
                          >
                            Reject
                          </Button>
                        ) : null}
                        {canTransitionStatus(row.status, "CANCELLED") ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={savingLeaveId === row.id}
                            onClick={() => openDecisionDialog(row, "CANCELLED")}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col items-start justify-between gap-2 text-sm sm:flex-row sm:items-center">
        <div className="text-muted-foreground">
          Page {Math.min(page, totalPages)} of {totalPages} ({total} total requests)
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((prev) => prev + 1)}
          >
            Next
          </Button>
          <Input
            type="number"
            min={1}
            max={Math.max(1, totalPages)}
            className="w-24"
            value={jumpPage}
            onChange={(e) => setJumpPage(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const next = Number(jumpPage);
              if (!Number.isFinite(next)) return;
              const clamped = Math.max(1, Math.min(totalPages, Math.floor(next)));
              setPage(clamped);
            }}
          >
            Go
          </Button>
        </div>
      </div>

      <Dialog
        open={decisionDialog.open}
        onOpenChange={(open) =>
          setDecisionDialog((prev) => ({
            ...prev,
            open,
            ...(open ? {} : { row: null, nextStatus: null, note: "" }),
          }))
        }
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {decisionDialog.nextStatus === "REJECTED" ? "Reject leave request" : "Cancel leave request"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Add a short note for the audit log (minimum 3 characters).
            </p>
            <Input
              placeholder="Enter note"
              value={decisionDialog.note}
              onChange={(e) => setDecisionDialog((prev) => ({ ...prev, note: e.target.value }))}
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setDecisionDialog({
                    open: false,
                    row: null,
                    nextStatus: null,
                    note: "",
                  })
                }
              >
                Cancel
              </Button>
              <Button type="button" onClick={handleDecisionSubmit}>
                Confirm
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default function LeaveTrackingPage() {
  return (
    <Suspense fallback={<section className="space-y-6"><p className="text-sm text-muted-foreground">Loading leave tracking...</p></section>}>
      <LeaveTrackingPageContent />
    </Suspense>
  );
}
