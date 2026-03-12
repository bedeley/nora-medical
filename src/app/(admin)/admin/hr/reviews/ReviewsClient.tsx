"use client";

import { useEffect, useMemo, useState } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useSearchParams } from "next/navigation";

type Employee = {
  id: string;
  firstName: string;
  lastName: string;
  hireDate?: string | null;
};

type Review = {
  id: string;
  employeeId: string;
  rating: "EXCEEDS" | "MEETS" | "NEEDS_IMPROVEMENT" | "UNSATISFACTORY";
  periodStart: string;
  periodEnd: string;
  summary?: string | null;
  strengths?: string | null;
  improvements?: string | null;
  goals?: string | null;
  employee?: Employee;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function ReviewsClient() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const presetEmployeeId = searchParams?.get("employeeId") || "";
  const [dialogOpen, setDialogOpen] = useState(false);
  const [employeeFilter, setEmployeeFilter] = useState(presetEmployeeId || "all");
  const [cadence, setCadence] = useState<"monthly" | "quarterly">("quarterly");
  const [autoEndDate, setAutoEndDate] = useState(true);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailReview, setDetailReview] = useState<Review | null>(null);
  const [form, setForm] = useState({
    employeeId: presetEmployeeId,
    rating: "MEETS",
    periodStart: "",
    periodEnd: "",
    summary: "",
    strengths: "",
    improvements: "",
    goals: "",
  });

  const { data: employeesData } = useQuery({
    queryKey: ["admin", "hr", "employees"],
    queryFn: () => fetcher("/api/admin/hr/employees"),
  });

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (employeeFilter !== "all") params.set("employeeId", employeeFilter);
    return `/api/admin/hr/reviews?${params.toString()}`;
  }, [employeeFilter]);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "hr", "reviews", employeeFilter],
    queryFn: () => fetcher(query),
  });

  const { data: settingsData } = useQuery({
    queryKey: ["admin", "hr", "settings", "reviewCadence"],
    queryFn: () => fetcher("/api/admin/hr/settings?keys=hr.reviewCadence"),
  });

  const { data: allReviewsData } = useQuery({
    queryKey: ["admin", "hr", "reviews", "all"],
    queryFn: () => fetcher("/api/admin/hr/reviews"),
  });

  const employees = useMemo(
    () => (Array.isArray(employeesData?.rows) ? (employeesData.rows as Employee[]) : []),
    [employeesData],
  );
  const rows = useMemo(() => (Array.isArray(data?.rows) ? (data.rows as Review[]) : []), [data]);
  const allReviews = useMemo(
    () => (Array.isArray(allReviewsData?.rows) ? (allReviewsData.rows as Review[]) : []),
    [allReviewsData],
  );

  const handleOpenDetail = (review: Review) => {
    setDetailReview(review);
    setDetailOpen(true);
  };

  useEffect(() => {
    const remote = settingsData?.values?.["hr.reviewCadence"];
    if (remote === "monthly" || remote === "quarterly") {
      setCadence(remote);
    }
  }, [settingsData]);

  useEffect(() => {
    if (!cadence) return;
    fetch("/api/admin/hr/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "hr.reviewCadence", value: cadence }),
    }).catch(() => {});
  }, [cadence]);

  const computePeriodEnd = (start: string, interval: "monthly" | "quarterly") => {
    if (!start) return "";
    const [yearRaw, monthRaw, dayRaw] = start.split("-").map(Number);
    if (!yearRaw || !monthRaw || !dayRaw) return "";
    const monthsToAdd = interval === "monthly" ? 1 : 3;
    const targetMonthIndex = (monthRaw - 1) + monthsToAdd;
    const targetYear = yearRaw + Math.floor(targetMonthIndex / 12);
    const targetMonth = targetMonthIndex % 12;
    const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
    const clampedDay = Math.min(dayRaw, lastDay);
    const end = new Date(targetYear, targetMonth, clampedDay);
    end.setDate(end.getDate() - 1);
    return end.toISOString().slice(0, 10);
  };

  useEffect(() => {
    if (!autoEndDate || !form.periodStart) return;
    const nextEnd = computePeriodEnd(form.periodStart, cadence);
    if (!nextEnd || nextEnd === form.periodEnd) return;
    setForm((prev) => ({ ...prev, periodEnd: nextEnd }));
  }, [autoEndDate, form.periodStart, form.periodEnd, cadence]);

  const reminders = useMemo(() => {
    const monthsToAdd = cadence === "monthly" ? 1 : 3;
    const latestByEmployee = new Map<string, Review>();
    allReviews.forEach((review) => {
      const existing = latestByEmployee.get(review.employeeId);
      const reviewEnd = new Date(review.periodEnd).getTime();
      if (!existing) {
        latestByEmployee.set(review.employeeId, review);
        return;
      }
      const existingEnd = new Date(existing.periodEnd).getTime();
      if (reviewEnd > existingEnd) {
        latestByEmployee.set(review.employeeId, review);
      }
    });

    const addMonths = (date: Date, months: number) => {
      const copy = new Date(date);
      copy.setMonth(copy.getMonth() + months);
      return copy;
    };

    const today = new Date();
    return employees.map((employee) => {
      const lastReview = latestByEmployee.get(employee.id);
      const lastDate = lastReview
        ? new Date(lastReview.periodEnd)
        : employee.hireDate
          ? new Date(employee.hireDate)
          : new Date();
      const nextDue = addMonths(lastDate, monthsToAdd);
      return {
        employee,
        lastReview,
        nextDue,
        overdue: nextDue < today,
      };
    });
  }, [allReviews, employees, cadence]);

  const handleCreate = async () => {
    if (!form.employeeId || !form.periodStart || !form.periodEnd) {
      toast.error("Employee and period dates are required.");
      return;
    }
    try {
      const res = await fetch("/api/admin/hr/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to create review.");
        return;
      }
      toast.success("Performance review created.");
      setDialogOpen(false);
      setAutoEndDate(true);
      setForm({
        employeeId: form.employeeId,
        rating: "MEETS",
        periodStart: "",
        periodEnd: "",
        summary: "",
        strengths: "",
        improvements: "",
        goals: "",
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "reviews"] });
    } catch {
      toast.error("Failed to create review.");
    }
  };

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Performance Reviews</h1>
          <p className="text-muted-foreground">Track employee performance and goals.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>+ Add Review</Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Add Performance Review</DialogTitle>
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
                <Select value={form.rating} onValueChange={(value) => setForm((prev) => ({ ...prev, rating: value }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Rating" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="EXCEEDS">Exceeds</SelectItem>
                    <SelectItem value="MEETS">Meets</SelectItem>
                    <SelectItem value="NEEDS_IMPROVEMENT">Needs improvement</SelectItem>
                    <SelectItem value="UNSATISFACTORY">Unsatisfactory</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="date"
                  value={form.periodStart}
                  onChange={(e) => setForm((prev) => ({ ...prev, periodStart: e.target.value }))}
                />
                <div className="space-y-2">
                  <Input
                    type="date"
                    value={form.periodEnd}
                    onChange={(e) => {
                      setAutoEndDate(false);
                      setForm((prev) => ({ ...prev, periodEnd: e.target.value }));
                    }}
                  />
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={autoEndDate}
                      onChange={(e) => setAutoEndDate(e.target.checked)}
                    />
                    Auto-calc end date from cadence
                  </label>
                </div>
                <Textarea
                  placeholder="Summary"
                  value={form.summary}
                  onChange={(e) => setForm((prev) => ({ ...prev, summary: e.target.value }))}
                  className="sm:col-span-2"
                />
                <Textarea
                  placeholder="Strengths"
                  value={form.strengths}
                  onChange={(e) => setForm((prev) => ({ ...prev, strengths: e.target.value }))}
                  className="sm:col-span-2"
                />
                <Textarea
                  placeholder="Improvements"
                  value={form.improvements}
                  onChange={(e) => setForm((prev) => ({ ...prev, improvements: e.target.value }))}
                  className="sm:col-span-2"
                />
                <Textarea
                  placeholder="Goals"
                  value={form.goals}
                  onChange={(e) => setForm((prev) => ({ ...prev, goals: e.target.value }))}
                  className="sm:col-span-2"
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={handleCreate}>Save review</Button>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Review Details</DialogTitle>
              </DialogHeader>
              {detailReview ? (
                <div className="grid gap-4 text-sm">
                  <div className="grid gap-1">
                    <div className="text-xs text-muted-foreground">Employee</div>
                    <div className="font-medium">
                      {detailReview.employee
                        ? `${detailReview.employee.firstName} ${detailReview.employee.lastName}`
                        : "—"}
                    </div>
                  </div>
                  <div className="grid gap-1">
                    <div className="text-xs text-muted-foreground">Period</div>
                    <div className="font-medium">
                      {new Date(detailReview.periodStart).toLocaleDateString()} -{" "}
                      {new Date(detailReview.periodEnd).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="grid gap-1">
                    <div className="text-xs text-muted-foreground">Rating</div>
                    <div className="font-medium">{detailReview.rating.replace("_", " ")}</div>
                  </div>
                  <div className="grid gap-1">
                    <div className="text-xs text-muted-foreground">Summary</div>
                    <div className="font-medium">{detailReview.summary || "—"}</div>
                  </div>
                  <div className="grid gap-1">
                    <div className="text-xs text-muted-foreground">Strengths</div>
                    <div className="font-medium">{detailReview.strengths || "—"}</div>
                  </div>
                  <div className="grid gap-1">
                    <div className="text-xs text-muted-foreground">Improvements</div>
                    <div className="font-medium">{detailReview.improvements || "—"}</div>
                  </div>
                  <div className="grid gap-1">
                    <div className="text-xs text-muted-foreground">Goals</div>
                    <div className="font-medium">{detailReview.goals || "—"}</div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Select a review to view details.</p>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Review Reminders</CardTitle>
          <Select value={cadence} onValueChange={(value) => setCadence(value as "monthly" | "quarterly")}> 
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Cadence" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Last Review</TableHead>
                <TableHead>Next Due</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reminders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                    No employees found.
                  </TableCell>
                </TableRow>
              ) : (
                reminders.map((item) => (
                  <TableRow key={item.employee.id}>
                    <TableCell>
                      {item.employee.firstName} {item.employee.lastName}
                    </TableCell>
                    <TableCell>
                      {item.lastReview
                        ? new Date(item.lastReview.periodEnd).toLocaleDateString()
                        : item.employee.hireDate
                          ? new Date(item.employee.hireDate).toLocaleDateString()
                          : "—"}
                    </TableCell>
                    <TableCell>{item.nextDue.toLocaleDateString()}</TableCell>
                    <TableCell className={item.overdue ? "text-red-600 font-medium" : "text-muted-foreground"}>
                      {item.overdue ? "Overdue" : "On track"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Review History</CardTitle>
          <Select value={employeeFilter} onValueChange={setEmployeeFilter}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Filter by employee" />
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
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading reviews...</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Rating</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                      No reviews recorded yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        {row.employee ? `${row.employee.firstName} ${row.employee.lastName}` : "—"}
                      </TableCell>
                      <TableCell>
                        {new Date(row.periodStart).toLocaleDateString()} -{" "}
                        {new Date(row.periodEnd).toLocaleDateString()}
                      </TableCell>
                      <TableCell>{row.rating.replace("_", " ")}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{row.summary || "—"}</TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => handleOpenDetail(row)}>
                          View details
                        </Button>
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
