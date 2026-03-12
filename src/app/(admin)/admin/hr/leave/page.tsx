"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useMemo, useState } from "react";
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
  const [dialogOpen, setDialogOpen] = useState(false);
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
    if (status !== "all") params.set("status", status);
    if (type !== "all") params.set("type", type);
    if (employeeFilter !== "all") params.set("employeeId", employeeFilter);
    return `/api/admin/hr/leave?${params.toString()}`;
  }, [status, type, employeeFilter]);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "hr", "leave", status, type],
    queryFn: () => fetcher(query),
  });

  const employees = Array.isArray(employeesData?.rows) ? (employeesData.rows as Employee[]) : [];
  const rows = Array.isArray(data?.rows) ? (data.rows as LeaveRequest[]) : [];

  const resolveWorkweekDays = (value: unknown) => {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 5 && num <= 7) return Math.floor(num);
    return 5;
  };

  useEffect(() => {
    const remote = settingsData?.values?.["hr.workweekDays"];
    setWorkweekDays(resolveWorkweekDays(remote));
  }, [settingsData]);

  useEffect(() => {
    fetch("/api/admin/hr/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "hr.workweekDays", value: workweekDays }),
    }).catch(() => {});
  }, [workweekDays]);

  const handleCreate = async () => {
    if (!form.employeeId || !form.startDate || !form.endDate) {
      toast.error("Employee, start date, and end date are required.");
      return;
    }
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
    }
  };

  const handleStatusUpdate = async (leaveId: string, nextStatus: LeaveRequest["status"]) => {
    try {
      const res = await fetch(`/api/admin/hr/leave/${leaveId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
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
    }
  };

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
              <Button onClick={handleCreate}>Save leave</Button>
            </div>
          </DialogContent>
        </Dialog>
      </header>

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
            <Select
              value={String(workweekDays)}
              onValueChange={(value) => setWorkweekDays(Number(value))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Workweek days" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5">5-day week (Mon-Fri)</SelectItem>
                <SelectItem value="6">6-day week (Mon-Sat)</SelectItem>
                <SelectItem value="7">7-day week</SelectItem>
              </SelectContent>
            </Select>
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
                        {row.employee ? `${row.employee.firstName} ${row.employee.lastName}` : "—"}
                      </TableCell>
                      <TableCell>{row.type}</TableCell>
                      <TableCell>{row.status}</TableCell>
                      <TableCell>
                        {new Date(row.startDate).toLocaleDateString()} -{" "}
                        {new Date(row.endDate).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <div className="text-xs">
                          {approvedDays(row)}/{usedDays(row)}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{row.reason || "—"}</TableCell>
                      <TableCell className="flex flex-wrap gap-2">
                        {row.status === "REQUESTED" ? (
                          <Button size="sm" variant="outline" onClick={() => handleStatusUpdate(row.id, "APPROVED")}>
                            Approve
                          </Button>
                        ) : null}
                        {row.status === "REQUESTED" ? (
                          <Button size="sm" variant="outline" onClick={() => handleStatusUpdate(row.id, "REJECTED")}>
                            Reject
                          </Button>
                        ) : null}
                        {row.status !== "CANCELLED" ? (
                          <Button size="sm" variant="ghost" onClick={() => handleStatusUpdate(row.id, "CANCELLED")}>
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
