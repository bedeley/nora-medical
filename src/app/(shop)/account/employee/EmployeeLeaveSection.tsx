"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDateGH, formatDateTimeGH } from "@/lib/currency";

type LeaveType = "ANNUAL" | "SICK" | "UNPAID" | "OTHER";
type LeaveStatus = "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";

type LeaveSummary = {
  approvedTotals: Record<LeaveType, number>;
  usedTotals: Record<LeaveType, number>;
  pending: number;
  activeApprovedLeave?: {
    type: LeaveType;
    startDate: string | Date;
    endDate: string | Date;
  } | null;
};

type LeaveRequestRow = {
  id: string;
  type: LeaveType;
  status: LeaveStatus;
  startDate: string | Date;
  endDate: string | Date;
  reason?: string | null;
  approvedAt?: string | Date | null;
  cancelledAt?: string | Date | null;
  createdAt: string | Date;
};

function toPlainLabel(value: string | null | undefined) {
  const normalized = String(value || "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function tone(status: string | null | undefined) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "APPROVED" || normalized === "ACTIVE") {
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200";
  }
  if (normalized === "REQUESTED" || normalized === "PENDING" || normalized === "ON_LEAVE") {
    return "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200";
  }
  if (normalized === "REJECTED" || normalized === "CANCELLED") {
    return "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200";
  }
  return "bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-200";
}

function toDateInputValue(value: Date) {
  const offset = value.getTimezoneOffset();
  const adjusted = new Date(value.getTime() - offset * 60_000);
  return adjusted.toISOString().slice(0, 10);
}

function buildUsagePercent(used: number, approved: number) {
  if (approved <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / approved) * 100)));
}

function buildMonthCalendar(leaveRequests: LeaveRequestRow[]) {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const leadingSlots = (monthStart.getDay() + 6) % 7;
  const daysInMonth = monthEnd.getDate();
  const cells: Array<{
    key: string;
    dayNumber?: number;
    status?: LeaveStatus;
    leaveType?: LeaveType;
  }> = [];

  for (let i = 0; i < leadingSlots; i += 1) {
    cells.push({ key: `blank-${i}` });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const current = new Date(today.getFullYear(), today.getMonth(), day);
    const matchingLeave = leaveRequests.find((leave) => {
      const start = new Date(leave.startDate);
      const end = new Date(leave.endDate);
      start.setHours(0, 0, 0, 0);
      end.setHours(0, 0, 0, 0);
      current.setHours(0, 0, 0, 0);
      return current >= start && current <= end && (leave.status === "APPROVED" || leave.status === "REQUESTED");
    });
    cells.push({
      key: `day-${day}`,
      dayNumber: day,
      status: matchingLeave?.status,
      leaveType: matchingLeave?.type,
    });
  }

  return {
    monthLabel: today.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    cells,
  };
}

export function EmployeeLeaveSection({
  leaveSummary,
  leaveRequests,
}: {
  leaveSummary: LeaveSummary;
  leaveRequests: LeaveRequestRow[];
}) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState("");
  const [visibleCount, setVisibleCount] = useState(Math.min(4, leaveRequests.length || 4));
  const [form, setForm] = useState(() => {
    const now = new Date();
    const nextWeek = new Date(now);
    nextWeek.setDate(now.getDate() + 7);
    return {
      type: "ANNUAL" as LeaveType,
      startDate: toDateInputValue(now),
      endDate: toDateInputValue(nextWeek),
      reason: "",
    };
  });

  const leaveRows = useMemo(
    () =>
      leaveRequests.map((leave) => ({
        ...leave,
        canCancel: leave.status === "REQUESTED",
      })),
    [leaveRequests],
  );
  const visibleLeaveRows = leaveRows.slice(0, visibleCount);
  const canShowMore = visibleCount < leaveRows.length;
  const canShowLess = leaveRows.length > 4 && visibleCount > 4;
  const calendar = useMemo(() => buildMonthCalendar(leaveRequests), [leaveRequests]);

  const submitLeaveRequest = async () => {
    if (!form.startDate || !form.endDate) {
      toast.error("Select both a start date and end date.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/account/employee/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Unable to submit leave request.");
      }
      toast.success("Leave request submitted.");
      setDialogOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to submit leave request.");
    } finally {
      setSubmitting(false);
    }
  };

  const cancelLeave = async (leaveId: string) => {
    setCancellingId(leaveId);
    try {
      const res = await fetch(`/api/account/employee/leave/${leaveId}`, {
        method: "PATCH",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Unable to cancel leave request.");
      }
      toast.success("Leave request cancelled.");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to cancel leave request.");
    } finally {
      setCancellingId("");
    }
  };

  return (
    <>
      <Card className="border shadow-sm">
        <CardHeader>
          <CardTitle>Leave summary (YTD)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This summary shows approved and used working days from your leave history this year.
          </p>
          {leaveSummary.activeApprovedLeave ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/20">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                Current leave
              </p>
              <p className="mt-2 font-semibold text-foreground">
                {toPlainLabel(leaveSummary.activeApprovedLeave.type)} leave until{" "}
                {formatDateGH(leaveSummary.activeApprovedLeave.endDate)}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Approved from {formatDateGH(leaveSummary.activeApprovedLeave.startDate)} to{" "}
                {formatDateGH(leaveSummary.activeApprovedLeave.endDate)}.
              </p>
            </div>
          ) : null}
          <div className="grid gap-3">
            {(["ANNUAL", "SICK", "UNPAID", "OTHER"] as const).map((type) => (
              <div key={type} className="rounded-2xl border border-border/70 bg-background/60 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {toPlainLabel(type)}
                    </p>
                    <p className="mt-2 font-semibold text-foreground">
                      Approved {leaveSummary.approvedTotals[type]} day(s)
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Used {leaveSummary.usedTotals[type]} day(s)
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Usage</p>
                    <p className="mt-2 font-semibold text-foreground">
                      {buildUsagePercent(leaveSummary.usedTotals[type], leaveSummary.approvedTotals[type])}%
                    </p>
                  </div>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{
                      width: `${buildUsagePercent(
                        leaveSummary.usedTotals[type],
                        leaveSummary.approvedTotals[type],
                      )}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pending requests</p>
            <p className="mt-2 font-semibold text-foreground">{leaveSummary.pending}</p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Leave calendar</p>
              <p className="text-xs text-muted-foreground">{calendar.monthLabel}</p>
            </div>
            <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[11px] text-muted-foreground">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
                <div key={day}>{day}</div>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-7 gap-1">
              {calendar.cells.map((cell) => (
                <div
                  key={cell.key}
                  className={[
                    "flex h-10 items-center justify-center rounded-md border text-xs",
                    !cell.dayNumber ? "border-transparent bg-transparent" : "border-border/60 bg-background",
                    cell.status === "APPROVED" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" : "",
                    cell.status === "REQUESTED" ? "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  title={cell.leaveType ? `${toPlainLabel(cell.leaveType)} (${toPlainLabel(cell.status)})` : ""}
                >
                  {cell.dayNumber || ""}
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span className="h-3 w-3 rounded-full bg-emerald-400" />
                Approved leave
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-3 w-3 rounded-full bg-amber-400" />
                Pending leave
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>Leave request history</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Submit new leave requests here and cancel pending ones before HR reviews them.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => setDialogOpen(true)}>
            Request leave
          </Button>
        </CardHeader>
        <CardContent>
          {leaveRows.length > 0 ? (
            <div className="space-y-3">
              <div className="grid gap-3">
                {visibleLeaveRows.map((leave) => (
                  <div key={leave.id} className="rounded-2xl border border-border/70 bg-background/60 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={tone(leave.status)}>{toPlainLabel(leave.status)}</Badge>
                      <Badge variant="outline">{toPlainLabel(leave.type)}</Badge>
                    </div>
                    <p className="mt-3 font-semibold text-foreground">
                      {formatDateGH(leave.startDate)} to {formatDateGH(leave.endDate)}
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {leave.reason || "No reason was recorded for this leave request."}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
                      <span>Created {formatDateTimeGH(leave.createdAt)}</span>
                      {leave.approvedAt ? <span>Approved {formatDateTimeGH(leave.approvedAt)}</span> : null}
                      {leave.cancelledAt ? <span>Cancelled {formatDateTimeGH(leave.cancelledAt)}</span> : null}
                    </div>
                    {leave.canCancel ? (
                      <div className="mt-4">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={cancellingId === leave.id}
                          onClick={() => cancelLeave(leave.id)}
                        >
                          {cancellingId === leave.id ? "Cancelling..." : "Cancel request"}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
              {leaveRows.length > 4 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                  <span>
                    Showing {Math.min(visibleCount, leaveRows.length)} of {leaveRows.length} leave requests
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {canShowMore ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setVisibleCount((current) => Math.min(leaveRows.length, current + 4))}
                      >
                        Show more leave requests
                      </Button>
                    ) : null}
                    {canShowLess ? (
                      <Button type="button" size="sm" variant="ghost" onClick={() => setVisibleCount(4)}>
                        Show fewer leave requests
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              No leave requests have been recorded yet. Use the request button above when you need to submit time off
              for HR approval.
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Request leave</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Leave type</span>
              <select
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={form.type}
                onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value as LeaveType }))}
              >
                <option value="ANNUAL">Annual leave</option>
                <option value="SICK">Sick leave</option>
                <option value="UNPAID">Unpaid leave</option>
                <option value="OTHER">Other leave</option>
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Start date</span>
                <Input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((prev) => ({ ...prev, startDate: e.target.value }))}
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">End date</span>
                <Input
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm((prev) => ({ ...prev, endDate: e.target.value }))}
                />
              </label>
            </div>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">Reason</span>
              <Textarea
                value={form.reason}
                onChange={(e) => setForm((prev) => ({ ...prev, reason: e.target.value }))}
                placeholder="Add a short reason for the request."
                rows={4}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="button" onClick={submitLeaveRequest} disabled={submitting}>
                {submitting ? "Submitting..." : "Submit request"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
