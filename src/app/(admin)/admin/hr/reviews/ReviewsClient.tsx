"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
  workflowStatus?: "DRAFT" | "SUBMITTED" | "ACKNOWLEDGED";
  workflowArchived?: boolean;
  workflowEmployeeVisible?: boolean;
  workflowAcknowledgedAt?: string | null;
  workflowAcknowledgedBy?: string | null;
};

type ReminderItem = {
  employee: Employee;
  lastReview?: Review;
  nextDue: Date;
  dueInDays: number;
  status: "overdue" | "due_soon" | "on_track";
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function ReviewsClient() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const presetEmployeeId = searchParams?.get("employeeId") || "";
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [employeeFilter, setEmployeeFilter] = useState(presetEmployeeId || "all");
  const [ratingFilter, setRatingFilter] = useState("all");
  const [reviewStatusFilter, setReviewStatusFilter] = useState("all");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [sort, setSort] = useState("periodEnd_desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("25");
  const [reminderFilter, setReminderFilter] = useState("all");
  const [cadence, setCadence] = useState<"monthly" | "quarterly">("quarterly");
  const [autoEndDate, setAutoEndDate] = useState(true);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailReview, setDetailReview] = useState<Review | null>(null);
  const [editingReview, setEditingReview] = useState<Review | null>(null);
  const [expandedRows, setExpandedRows] = useState<string[]>([]);
  const [selectedReviewIds, setSelectedReviewIds] = useState<string[]>([]);
  const [presetName, setPresetName] = useState("");
  const [savedPresets, setSavedPresets] = useState<Record<string, string>>({});
  const [selectedPreset, setSelectedPreset] = useState("none");
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
  const [editForm, setEditForm] = useState({
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
    if (ratingFilter !== "all") params.set("rating", ratingFilter);
    if (reviewStatusFilter !== "all") params.set("reviewStatus", reviewStatusFilter);
    if (searchText.trim()) params.set("q", searchText.trim());
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    if (includeArchived) params.set("includeArchived", "1");
    params.set("sort", sort);
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    return `/api/admin/hr/reviews?${params.toString()}`;
  }, [
    employeeFilter,
    ratingFilter,
    reviewStatusFilter,
    searchText,
    fromDate,
    toDate,
    includeArchived,
    sort,
    page,
    pageSize,
  ]);

  const { data, isLoading } = useQuery({
    queryKey: [
      "admin",
      "hr",
      "reviews",
      employeeFilter,
      ratingFilter,
      reviewStatusFilter,
      searchText,
      fromDate,
      toDate,
      includeArchived,
      sort,
      page,
      pageSize,
    ],
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
  const total = Number(data?.total || 0);
  const totalPages = Number(data?.totalPages || 1);
  const allReviews = useMemo(
    () => (Array.isArray(allReviewsData?.rows) ? (allReviewsData.rows as Review[]) : []),
    [allReviewsData],
  );

  const handleOpenDetail = (review: Review) => {
    setDetailReview(review);
    setDetailOpen(true);
  };

  const handleOpenEdit = (review: Review) => {
    setEditingReview(review);
    setEditForm({
      rating: review.rating,
      periodStart: new Date(review.periodStart).toISOString().slice(0, 10),
      periodEnd: new Date(review.periodEnd).toISOString().slice(0, 10),
      summary: review.summary || "",
      strengths: review.strengths || "",
      improvements: review.improvements || "",
      goals: review.goals || "",
    });
    setEditOpen(true);
  };

  useEffect(() => {
    const remote = settingsData?.values?.["hr.reviewCadence"];
    if (remote === "monthly" || remote === "quarterly") {
      setCadence(remote);
    }
  }, [settingsData]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("hr.reviews.filterPresets");
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (parsed && typeof parsed === "object") {
        setSavedPresets(parsed);
      }
    } catch {
      // ignore invalid local storage
    }
  }, []);

  useEffect(() => {
    const currentIds = new Set(rows.map((row) => row.id));
    setSelectedReviewIds((existing) => existing.filter((id) => currentIds.has(id)));
  }, [rows]);

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

  const reminders = useMemo<ReminderItem[]>(() => {
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
      const diffMs = nextDue.getTime() - today.getTime();
      const dueInDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
      const status: ReminderItem["status"] =
        dueInDays < 0 ? "overdue" : dueInDays <= 14 ? "due_soon" : "on_track";
      return {
        employee,
        lastReview,
        nextDue,
        dueInDays,
        status,
      };
    });
  }, [allReviews, employees, cadence]);

  const filteredReminders = useMemo(() => {
    if (reminderFilter === "all") return reminders;
    return reminders.filter((item) => item.status === reminderFilter);
  }, [reminders, reminderFilter]);

  const analytics = useMemo(() => {
    const ratingCounts = {
      EXCEEDS: 0,
      MEETS: 0,
      NEEDS_IMPROVEMENT: 0,
      UNSATISFACTORY: 0,
    };
    allReviews.forEach((review) => {
      ratingCounts[review.rating] += 1;
    });
    const overdueCount = reminders.filter((item) => item.status === "overdue").length;
    const dueSoonCount = reminders.filter((item) => item.status === "due_soon").length;
    const completedEmployees = reminders.filter((item) => Boolean(item.lastReview)).length;
    const completionPct = employees.length
      ? Math.round((completedEmployees / employees.length) * 100)
      : 0;
    return {
      totalReviews: allReviews.length,
      overdueCount,
      dueSoonCount,
      completionPct,
      ratingCounts,
    };
  }, [allReviews, reminders, employees.length]);

  const handleCreate = async () => {
    if (!form.employeeId || !form.periodStart || !form.periodEnd) {
      toast.error("Employee and period dates are required.");
      return;
    }
    if (new Date(form.periodEnd).getTime() < new Date(form.periodStart).getTime()) {
      toast.error("Period end must be on or after period start.");
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

  const handleUpdate = async () => {
    if (!editingReview) return;
    if (!editForm.periodStart || !editForm.periodEnd) {
      toast.error("Review period is required.");
      return;
    }
    if (new Date(editForm.periodEnd).getTime() < new Date(editForm.periodStart).getTime()) {
      toast.error("Period end must be on or after period start.");
      return;
    }
    try {
      const res = await fetch(`/api/admin/hr/reviews/${editingReview.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editForm),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update review.");
        return;
      }
      toast.success("Review updated.");
      setEditOpen(false);
      setEditingReview(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "reviews"] });
    } catch {
      toast.error("Failed to update review.");
    }
  };

  const handleWorkflowUpdate = async (
    review: Review,
    update: {
      workflowStatus?: "DRAFT" | "SUBMITTED" | "ACKNOWLEDGED";
      acknowledge?: boolean;
      archived?: boolean;
      employeeVisible?: boolean;
    },
  ) => {
    try {
      const res = await fetch(`/api/admin/hr/reviews/${review.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to update review workflow.");
        return;
      }
      toast.success("Review workflow updated.");
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "reviews"] });
    } catch {
      toast.error("Failed to update review workflow.");
    }
  };

  const handleBulkWorkflowUpdate = async (
    operation: "SUBMIT" | "ACKNOWLEDGE" | "ARCHIVE" | "UNARCHIVE" | "SHOW_IN_PORTAL" | "HIDE_FROM_PORTAL",
  ) => {
    if (selectedReviewIds.length === 0) {
      toast.error("Select at least one review.");
      return;
    }
    if (
      (operation === "ACKNOWLEDGE" || operation === "ARCHIVE") &&
      !window.confirm(`Confirm ${operation.toLowerCase()} for ${selectedReviewIds.length} selected review(s)?`)
    ) {
      return;
    }

    try {
      const res = await fetch("/api/admin/hr/reviews/bulk-workflow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewIds: selectedReviewIds, operation }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Bulk workflow update failed.");
        return;
      }
      const successCount = Number(body.successCount || 0);
      const failureCount = Number(body.failureCount || 0);
      const failures = Array.isArray(body.failures) ? body.failures : [];
      if (successCount > 0) {
        toast.success(`Updated ${successCount} review(s).`);
        setSelectedReviewIds([]);
      }
      if (failureCount > 0) {
        const failureSummary = failures
          .slice(0, 3)
          .map((item: { reviewId?: string; reason?: string }) => `${item.reviewId || "unknown"}: ${item.reason || "Unknown error"}`)
          .join(" | ");
        toast.error(
          failureCount > 3
            ? `${failureCount} review(s) failed. ${failureSummary} ...`
            : `${failureCount} review(s) failed. ${failureSummary}`,
        );
      }
      queryClient.invalidateQueries({ queryKey: ["admin", "hr", "reviews"] });
    } catch {
      toast.error("Bulk workflow update failed.");
    }
  };

  const toggleSelectedReview = (reviewId: string) => {
    setSelectedReviewIds((current) =>
      current.includes(reviewId)
        ? current.filter((id) => id !== reviewId)
        : [...current, reviewId],
    );
  };

  const toggleSelectAllVisible = () => {
    const rowIds = rows.map((row) => row.id);
    const allSelected = rowIds.length > 0 && rowIds.every((id) => selectedReviewIds.includes(id));
    if (allSelected) {
      setSelectedReviewIds((current) => current.filter((id) => !rowIds.includes(id)));
      return;
    }
    setSelectedReviewIds((current) => Array.from(new Set([...current, ...rowIds])));
  };

  const buildAuditHref = (review: Review) =>
    `/admin/audit?entityType=PERFORMANCE_REVIEW&entityId=${encodeURIComponent(review.id)}&sourcePage=admin/hr/reviews`;

  const saveCurrentFilterPreset = () => {
    const name = presetName.trim();
    if (!name) {
      toast.error("Enter a preset name.");
      return;
    }
    const params = new URLSearchParams();
    if (employeeFilter !== "all") params.set("employeeFilter", employeeFilter);
    if (ratingFilter !== "all") params.set("ratingFilter", ratingFilter);
    if (reviewStatusFilter !== "all") params.set("reviewStatusFilter", reviewStatusFilter);
    if (searchText.trim()) params.set("searchText", searchText.trim());
    if (fromDate) params.set("fromDate", fromDate);
    if (toDate) params.set("toDate", toDate);
    if (includeArchived) params.set("includeArchived", "1");
    if (sort !== "periodEnd_desc") params.set("sort", sort);
    if (pageSize !== "25") params.set("pageSize", pageSize);
    const nextPresets = { ...savedPresets, [name]: params.toString() };
    setSavedPresets(nextPresets);
    setSelectedPreset(name);
    window.localStorage.setItem("hr.reviews.filterPresets", JSON.stringify(nextPresets));
    toast.success("Filter preset saved.");
  };

  const applyFilterPreset = (preset: string) => {
    if (preset === "none") return;
    const encoded = savedPresets[preset];
    if (!encoded) return;
    const params = new URLSearchParams(encoded);
    setEmployeeFilter(params.get("employeeFilter") || "all");
    setRatingFilter(params.get("ratingFilter") || "all");
    setReviewStatusFilter(params.get("reviewStatusFilter") || "all");
    setSearchText(params.get("searchText") || "");
    setFromDate(params.get("fromDate") || "");
    setToDate(params.get("toDate") || "");
    setIncludeArchived(params.get("includeArchived") === "1");
    setSort(params.get("sort") || "periodEnd_desc");
    setPageSize(params.get("pageSize") || "25");
    setPage(1);
    setSelectedPreset(preset);
  };

  const renameSelectedPreset = () => {
    const nextName = presetName.trim();
    if (selectedPreset === "none") {
      toast.error("Select a preset to rename.");
      return;
    }
    if (!nextName) {
      toast.error("Enter a new preset name.");
      return;
    }
    if (savedPresets[nextName] && nextName !== selectedPreset) {
      toast.error("A preset with this name already exists.");
      return;
    }
    const encoded = savedPresets[selectedPreset];
    if (!encoded) {
      toast.error("Selected preset was not found.");
      return;
    }
    const nextPresets = { ...savedPresets };
    delete nextPresets[selectedPreset];
    nextPresets[nextName] = encoded;
    setSavedPresets(nextPresets);
    setSelectedPreset(nextName);
    window.localStorage.setItem("hr.reviews.filterPresets", JSON.stringify(nextPresets));
    toast.success("Preset renamed.");
  };

  const deleteSelectedPreset = () => {
    if (selectedPreset === "none") {
      toast.error("Select a preset to delete.");
      return;
    }
    if (!window.confirm(`Delete preset "${selectedPreset}"?`)) {
      return;
    }
    const nextPresets = { ...savedPresets };
    delete nextPresets[selectedPreset];
    setSavedPresets(nextPresets);
    setSelectedPreset("none");
    setPresetName("");
    window.localStorage.setItem("hr.reviews.filterPresets", JSON.stringify(nextPresets));
    toast.success("Preset deleted.");
  };

  const clearAllFilters = () => {
    setEmployeeFilter("all");
    setRatingFilter("all");
    setReviewStatusFilter("all");
    setIncludeArchived(false);
    setSearchText("");
    setFromDate("");
    setToDate("");
    setSort("periodEnd_desc");
    setPageSize("25");
    setPage(1);
    setSelectedPreset("none");
  };

  const applyCreatePreset = (preset: "this_month" | "last_quarter") => {
    const now = new Date();
    if (preset === "this_month") {
      const y = now.getFullYear();
      const m = now.getMonth();
      const start = new Date(y, m, 1).toISOString().slice(0, 10);
      const end = new Date(y, m + 1, 0).toISOString().slice(0, 10);
      setAutoEndDate(false);
      setForm((prev) => ({ ...prev, periodStart: start, periodEnd: end }));
      return;
    }
    const quarter = Math.floor(now.getMonth() / 3);
    const startMonth = (quarter - 1 + 4) % 4 * 3;
    const yearShift = quarter === 0 ? -1 : 0;
    const y = now.getFullYear() + yearShift;
    const start = new Date(y, startMonth, 1).toISOString().slice(0, 10);
    const end = new Date(y, startMonth + 3, 0).toISOString().slice(0, 10);
    setAutoEndDate(false);
    setForm((prev) => ({ ...prev, periodStart: start, periodEnd: end }));
  };

  const applyTemplate = (target: "create" | "edit", template: "strong" | "improve" | "balanced") => {
    const templateMap = {
      strong: {
        summary: "Consistently exceeds expectations in delivery quality and ownership.",
        strengths: "Strong communication, reliability, and proactive problem solving.",
        improvements: "Continue mentoring peers and scaling impact across the team.",
        goals: "Lead one process improvement initiative in the next review cycle.",
      },
      improve: {
        summary: "Meets baseline expectations but has clear improvement opportunities.",
        strengths: "Dependable attendance and willingness to learn.",
        improvements: "Improve turnaround time and documentation quality.",
        goals: "Complete targeted coaching plan and hit agreed performance milestones.",
      },
      balanced: {
        summary: "Solid performance with a mix of strengths and growth areas.",
        strengths: "Consistent output and collaboration with stakeholders.",
        improvements: "Increase consistency under peak workload periods.",
        goals: "Maintain quality baseline while improving speed and planning.",
      },
    } as const;
    const patch = templateMap[template];
    if (target === "create") {
      setForm((prev) => ({ ...prev, ...patch }));
      return;
    }
    setEditForm((prev) => ({ ...prev, ...patch }));
  };

  const exportRemindersCsv = () => {
    const header = ["Employee", "Last Review", "Next Due", "Due In Days", "Status"];
    const rowsCsv = filteredReminders.map((item) => [
      `${item.employee.firstName} ${item.employee.lastName}`,
      item.lastReview
        ? new Date(item.lastReview.periodEnd).toISOString().slice(0, 10)
        : item.employee.hireDate
          ? new Date(item.employee.hireDate).toISOString().slice(0, 10)
          : "",
      item.nextDue.toISOString().slice(0, 10),
      String(item.dueInDays),
      item.status,
    ]);
    const csv = [header, ...rowsCsv]
      .map((line) => line.map((value) => `"${String(value).replace(/"/g, "\"\"")}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `hr-review-reminders-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    toast.success(`Reminder export complete (${rowsCsv.length} row(s)).`);
  };

  const recordReminderAction = async (
    actionType: "OPEN_HISTORY" | "OPEN_LAST_REVIEW_AUDIT" | "START_REVIEW",
    employeeId: string,
    reviewId?: string,
  ) => {
    try {
      await fetch("/api/admin/hr/reviews/reminder-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionType, employeeId, reviewId }),
      });
    } catch {
      // best-effort
    }
  };

  const toggleExpandedRow = (reviewId: string) => {
    setExpandedRows((current) =>
      current.includes(reviewId)
        ? current.filter((id) => id !== reviewId)
        : [...current, reviewId],
    );
  };

  const copyReviewSummary = async (review: Review) => {
    const text = [
      `Employee: ${review.employee ? `${review.employee.firstName} ${review.employee.lastName}` : review.employeeId}`,
      `Period: ${new Date(review.periodStart).toLocaleDateString()} - ${new Date(review.periodEnd).toLocaleDateString()}`,
      `Rating: ${review.rating.replace("_", " ")}`,
      `Summary: ${review.summary || "Not provided"}`,
      `Strengths: ${review.strengths || "Not provided"}`,
      `Improvements: ${review.improvements || "Not provided"}`,
      `Goals: ${review.goals || "Not provided"}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Review summary copied.");
    } catch {
      toast.error("Could not copy review summary.");
    }
  };

  const openEmployeeHistory = (employeeId: string) => {
    setEmployeeFilter(employeeId);
    setPage(1);
    void recordReminderAction("OPEN_HISTORY", employeeId);
  };

  const startReviewFromReminder = (item: ReminderItem) => {
    const base = item.lastReview
      ? new Date(item.lastReview.periodEnd)
      : item.employee.hireDate
        ? new Date(item.employee.hireDate)
        : new Date();
    const startDate = new Date(base);
    startDate.setDate(startDate.getDate() + 1);
    const periodStart = startDate.toISOString().slice(0, 10);
    const periodEnd = computePeriodEnd(periodStart, cadence);
    setAutoEndDate(true);
    setForm((prev) => ({
      ...prev,
      employeeId: item.employee.id,
      periodStart,
      periodEnd,
    }));
    setDialogOpen(true);
    void recordReminderAction("START_REVIEW", item.employee.id, item.lastReview?.id);
  };

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold">Performance Reviews</h1>
          <p className="text-muted-foreground">Track employee performance and goals.</p>
          <p className="text-xs text-muted-foreground">Access policy: Admin only.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => window.open("/admin/audit?entityType=PERFORMANCE_REVIEW&sourcePage=admin/hr/reviews", "_blank")}
          >
            Review Audit Log
          </Button>
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
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" type="button" onClick={() => applyCreatePreset("this_month")}>
                      This month
                    </Button>
                    <Button size="sm" variant="outline" type="button" onClick={() => applyCreatePreset("last_quarter")}>
                      Last quarter
                    </Button>
                  </div>
                </div>
                <Textarea
                  placeholder="Summary"
                  value={form.summary}
                  onChange={(e) => setForm((prev) => ({ ...prev, summary: e.target.value }))}
                  className="sm:col-span-2"
                />
                <div className="sm:col-span-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" type="button" onClick={() => applyTemplate("create", "balanced")}>
                    Use Balanced Template
                  </Button>
                  <Button size="sm" variant="outline" type="button" onClick={() => applyTemplate("create", "strong")}>
                    Use Strong Template
                  </Button>
                  <Button size="sm" variant="outline" type="button" onClick={() => applyTemplate("create", "improve")}>
                    Use Improvement Template
                  </Button>
                </div>
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
                        : "Not available"}
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
                    <div className="font-medium">{detailReview.summary || "Not available"}</div>
                  </div>
                  <div className="grid gap-1">
                    <div className="text-xs text-muted-foreground">Strengths</div>
                    <div className="font-medium">{detailReview.strengths || "Not available"}</div>
                  </div>
                  <div className="grid gap-1">
                    <div className="text-xs text-muted-foreground">Improvements</div>
                    <div className="font-medium">{detailReview.improvements || "Not available"}</div>
                  </div>
                  <div className="grid gap-1">
                    <div className="text-xs text-muted-foreground">Goals</div>
                    <div className="font-medium">{detailReview.goals || "Not available"}</div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Select a review to view details.</p>
              )}
            </DialogContent>
          </Dialog>
          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Edit Review</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  value={editForm.rating}
                  onValueChange={(value) => setEditForm((prev) => ({ ...prev, rating: value }))}
                >
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
                <div />
                <Input
                  type="date"
                  value={editForm.periodStart}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, periodStart: e.target.value }))}
                />
                <Input
                  type="date"
                  value={editForm.periodEnd}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, periodEnd: e.target.value }))}
                />
                <Textarea
                  placeholder="Summary"
                  value={editForm.summary}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, summary: e.target.value }))}
                  className="sm:col-span-2"
                />
                <div className="sm:col-span-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" type="button" onClick={() => applyTemplate("edit", "balanced")}>
                    Use Balanced Template
                  </Button>
                  <Button size="sm" variant="outline" type="button" onClick={() => applyTemplate("edit", "strong")}>
                    Use Strong Template
                  </Button>
                  <Button size="sm" variant="outline" type="button" onClick={() => applyTemplate("edit", "improve")}>
                    Use Improvement Template
                  </Button>
                </div>
                <Textarea
                  placeholder="Strengths"
                  value={editForm.strengths}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, strengths: e.target.value }))}
                  className="sm:col-span-2"
                />
                <Textarea
                  placeholder="Improvements"
                  value={editForm.improvements}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, improvements: e.target.value }))}
                  className="sm:col-span-2"
                />
                <Textarea
                  placeholder="Goals"
                  value={editForm.goals}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, goals: e.target.value }))}
                  className="sm:col-span-2"
                />
              </div>
              <div className="flex justify-end">
                <Button onClick={handleUpdate}>Save changes</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Review Analytics</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Total Reviews</div>
            <div className="font-semibold">{analytics.totalReviews}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Overdue Reviews</div>
            <div className="font-semibold text-red-600">{analytics.overdueCount}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Due Soon (14 days)</div>
            <div className="font-semibold text-amber-700">{analytics.dueSoonCount}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Completion Rate</div>
            <div className="font-semibold">{analytics.completionPct}%</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Exceeds</div>
            <div className="font-semibold">{analytics.ratingCounts.EXCEEDS}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Meets</div>
            <div className="font-semibold">{analytics.ratingCounts.MEETS}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Needs Improvement</div>
            <div className="font-semibold">{analytics.ratingCounts.NEEDS_IMPROVEMENT}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Unsatisfactory</div>
            <div className="font-semibold">{analytics.ratingCounts.UNSATISFACTORY}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Review Reminders</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Select value={cadence} onValueChange={(value) => setCadence(value as "monthly" | "quarterly")}> 
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Cadence" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
              </SelectContent>
            </Select>
            <Button asChild variant="outline">
              <Link href="/admin/hr/settings">Set default cadence</Link>
            </Button>
            <Select value={reminderFilter} onValueChange={setReminderFilter}>
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="due_soon">Due soon</SelectItem>
                <SelectItem value="on_track">On track</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={exportRemindersCsv}>
              Export Reminders CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Last Review</TableHead>
                <TableHead>Next Due</TableHead>
                <TableHead>Due In</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredReminders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    No employees found.
                  </TableCell>
                </TableRow>
              ) : (
                filteredReminders.map((item) => (
                  <TableRow key={item.employee.id}>
                    <TableCell>
                      {item.employee.firstName} {item.employee.lastName}
                    </TableCell>
                    <TableCell>
                      {item.lastReview
                        ? new Date(item.lastReview.periodEnd).toLocaleDateString()
                        : item.employee.hireDate
                          ? new Date(item.employee.hireDate).toLocaleDateString()
                          : "Not available"}
                    </TableCell>
                    <TableCell>{item.nextDue.toLocaleDateString()}</TableCell>
                    <TableCell>
                      {item.dueInDays < 0
                        ? `${Math.abs(item.dueInDays)} day(s) late`
                        : `${item.dueInDays} day(s)`}
                    </TableCell>
                    <TableCell
                      className={
                        item.status === "overdue"
                          ? "text-red-600 font-medium"
                          : item.status === "due_soon"
                            ? "text-amber-700 font-medium"
                            : "text-muted-foreground"
                      }
                    >
                      {item.status === "overdue"
                        ? "Overdue"
                        : item.status === "due_soon"
                          ? "Due soon"
                          : "On track"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => startReviewFromReminder(item)}
                        >
                          Start review
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openEmployeeHistory(item.employee.id)}
                        >
                          View history
                        </Button>
                        {item.lastReview ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              const lastReview = item.lastReview;
                              if (!lastReview) return;
                              void recordReminderAction(
                                "OPEN_LAST_REVIEW_AUDIT",
                                item.employee.id,
                                lastReview.id,
                              );
                              window.open(buildAuditHref(lastReview), "_blank");
                            }}
                          >
                            Last review audit
                          </Button>
                        ) : null}
                      </div>
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
          <div className="flex flex-wrap gap-2">
            <Input
              className="w-48"
              placeholder="Search review text/name"
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
              <SelectTrigger className="w-56">
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
            <Select
              value={ratingFilter}
              onValueChange={(value) => {
                setRatingFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Rating" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All ratings</SelectItem>
                <SelectItem value="EXCEEDS">Exceeds</SelectItem>
                <SelectItem value="MEETS">Meets</SelectItem>
                <SelectItem value="NEEDS_IMPROVEMENT">Needs improvement</SelectItem>
                <SelectItem value="UNSATISFACTORY">Unsatisfactory</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={reviewStatusFilter}
              onValueChange={(value) => {
                setReviewStatusFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Review status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All workflow states</SelectItem>
                <SelectItem value="DRAFT">Draft</SelectItem>
                <SelectItem value="SUBMITTED">Submitted</SelectItem>
                <SelectItem value="ACKNOWLEDGED">Acknowledged</SelectItem>
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
                <SelectItem value="periodEnd_desc">Newest period</SelectItem>
                <SelectItem value="periodEnd_asc">Oldest period</SelectItem>
                <SelectItem value="rating_desc">Rating high-low</SelectItem>
                <SelectItem value="rating_asc">Rating low-high</SelectItem>
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-xs text-muted-foreground px-2">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => {
                  setIncludeArchived(e.target.checked);
                  setPage(1);
                }}
              />
              Include archived
            </label>
            <Input
              className="w-44"
              placeholder="Preset name"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <Button size="sm" variant="outline" onClick={saveCurrentFilterPreset}>
              Save Preset
            </Button>
            <Select
              value={selectedPreset}
              onValueChange={(value) => {
                setSelectedPreset(value);
                applyFilterPreset(value);
              }}
            >
              <SelectTrigger className="w-44">
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
            <Button size="sm" variant="outline" onClick={renameSelectedPreset}>
              Rename preset
            </Button>
            <Button size="sm" variant="outline" onClick={deleteSelectedPreset}>
              Delete preset
            </Button>
            <Button size="sm" variant="outline" onClick={clearAllFilters}>
              Clear filters
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <Button size="sm" variant="outline" onClick={toggleSelectAllVisible}>
              {rows.length > 0 && rows.every((row) => selectedReviewIds.includes(row.id))
                ? "Unselect all visible"
                : "Select all visible"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkWorkflowUpdate("SUBMIT")}
            >
              Submit selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkWorkflowUpdate("ACKNOWLEDGE")}
            >
              Acknowledge selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkWorkflowUpdate("ARCHIVE")}
            >
              Archive selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkWorkflowUpdate("UNARCHIVE")}
            >
              Unarchive selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkWorkflowUpdate("SHOW_IN_PORTAL")}
            >
              Show in employee portal
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleBulkWorkflowUpdate("HIDE_FROM_PORTAL")}
            >
              Hide from employee portal
            </Button>
            <span className="text-muted-foreground">
              {selectedReviewIds.length} selected
            </span>
          </div>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading reviews...</p>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-20 w-10 bg-background">Select</TableHead>
                  <TableHead className="sticky left-10 z-20 bg-background">Employee</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Rating</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Summary</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                      No reviews recorded yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <Fragment key={row.id}>
                      <TableRow>
                        <TableCell className="sticky left-0 z-10 bg-background">
                          <input
                            type="checkbox"
                            checked={selectedReviewIds.includes(row.id)}
                            onChange={() => toggleSelectedReview(row.id)}
                            aria-label={`Select review ${row.id}`}
                          />
                        </TableCell>
                        <TableCell className="sticky left-10 z-10 bg-background">
                          {row.employee ? `${row.employee.firstName} ${row.employee.lastName}` : "Not available"}
                        </TableCell>
                        <TableCell>
                          {new Date(row.periodStart).toLocaleDateString()} -{" "}
                          {new Date(row.periodEnd).toLocaleDateString()}
                        </TableCell>
                        <TableCell>{row.rating.replace("_", " ")}</TableCell>
                        <TableCell>
                          <div className="text-xs">
                            <div className="font-medium">{row.workflowStatus || "DRAFT"}</div>
                            {row.workflowArchived ? (
                              <div className="text-amber-700">Archived</div>
                            ) : null}
                            <div className={row.workflowEmployeeVisible ? "text-emerald-700" : "text-muted-foreground"}>
                              {row.workflowEmployeeVisible ? "Visible in employee portal" : "Hidden from employee portal"}
                            </div>
                            {row.workflowAcknowledgedAt ? (
                              <div className="text-muted-foreground">
                                Ack: {new Date(row.workflowAcknowledgedAt).toLocaleDateString()}
                              </div>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{row.summary || "Not available"}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" onClick={() => window.open(buildAuditHref(row), "_blank")}>
                              Audit
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => handleOpenDetail(row)}>
                              View details
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => handleOpenEdit(row)}>
                              Edit
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => toggleExpandedRow(row.id)}>
                              {expandedRows.includes(row.id) ? "Collapse" : "Expand"}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => copyReviewSummary(row)}>
                              Copy summary
                            </Button>
                            {(row.workflowStatus || "DRAFT") === "DRAFT" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  handleWorkflowUpdate(row, { workflowStatus: "SUBMITTED" })
                                }
                              >
                                Submit
                              </Button>
                            ) : null}
                            {(row.workflowStatus || "DRAFT") === "SUBMITTED" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleWorkflowUpdate(row, { acknowledge: true })}
                              >
                                Acknowledge
                              </Button>
                            ) : null}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                handleWorkflowUpdate(row, { archived: !Boolean(row.workflowArchived) })
                              }
                            >
                              {row.workflowArchived ? "Unarchive" : "Archive"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                handleWorkflowUpdate(row, {
                                  employeeVisible: !Boolean(row.workflowEmployeeVisible),
                                })
                              }
                            >
                              {row.workflowEmployeeVisible ? "Hide from portal" : "Show in portal"}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {expandedRows.includes(row.id) ? (
                        <TableRow key={`${row.id}-expanded`}>
                          <TableCell colSpan={7}>
                            <div className="grid gap-2 rounded-md border bg-muted/20 p-3 text-xs">
                              <div><strong>Summary:</strong> {row.summary || "Not provided"}</div>
                              <div><strong>Strengths:</strong> {row.strengths || "Not provided"}</div>
                              <div><strong>Improvements:</strong> {row.improvements || "Not provided"}</div>
                              <div><strong>Goals:</strong> {row.goals || "Not provided"}</div>
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  ))
                )}
              </TableBody>
            </Table>
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <div>
              Page {page} of {Math.max(1, totalPages)} | {total} review(s)
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





