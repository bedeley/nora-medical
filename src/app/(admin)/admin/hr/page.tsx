"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Users,
  Briefcase,
  Banknote,
  AlertTriangle,
  FileDown,
  CalendarDays,
  ClipboardList,
  Wallet,
  SlidersHorizontal,
  RefreshCw,
  Plus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";

async function fetcher(url: string) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : `Request failed with status ${response.status}`);
  }
  return data;
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

function toIsoDateTime(dateOnly: string, endOfDay = false) {
  if (!dateOnly) return "";
  const suffix = endOfDay ? "T23:59:59.999" : "T00:00:00.000";
  return new Date(`${dateOnly}${suffix}`).toISOString();
}

function CountCaption({
  count,
  singularLabel,
  pluralLabel,
  isLoading,
  isError,
}: {
  count: number | null;
  singularLabel: string;
  pluralLabel: string;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isError) {
    return <p className="text-xs text-destructive">Summary unavailable</p>;
  }
  if (isLoading || count === null) {
    return <p className="text-xs text-muted-foreground">Loading summary...</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      {count} {count === 1 ? singularLabel : pluralLabel}
    </p>
  );
}

function SummaryValue({
  value,
  isLoading,
  isError,
}: {
  value: number | null;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isError) return <span className="text-sm text-destructive">Unavailable</span>;
  if (isLoading || value === null) return <span className="text-sm text-muted-foreground">Loading...</span>;
  return <span>{value}</span>;
}

function HrActionCard({
  icon: Icon,
  title,
  caption,
  description,
  href,
  actionLabel,
}: {
  icon: LucideIcon;
  title: string;
  caption?: ReactNode;
  description: string;
  href: string;
  actionLabel: string;
}) {
  return (
    <Card className="h-full border-border/70">
      <CardHeader className="flex items-start gap-3 sm:flex-row">
        <div className="rounded-xl border border-border/70 bg-muted/50 p-2.5">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-base">{title}</CardTitle>
          {caption ?? null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{description}</p>
        <Button asChild className="w-full justify-center">
          <Link href={href}>{actionLabel}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function RailLink({
  icon: Icon,
  title,
  description,
  href,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-start gap-3 rounded-xl border border-border/70 bg-background/80 px-4 py-3 transition hover:border-primary/40 hover:bg-muted/60"
    >
      <div className="rounded-lg border border-border/70 bg-muted/50 p-2">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 space-y-1">
        <p className="font-medium leading-none">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </Link>
  );
}

type RecentHrActivityItem = {
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

export default function AdminHrPage() {
  const [employeeDialogOpen, setEmployeeDialogOpen] = useState(false);
  const [payrollDialogOpen, setPayrollDialogOpen] = useState(false);
  const [savingEmployee, setSavingEmployee] = useState(false);
  const [savingPayrollRun, setSavingPayrollRun] = useState(false);
  const [employeeForm, setEmployeeForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    department: "",
    position: "",
    status: "ACTIVE",
    hireDate: "",
  });
  const [payrollForm, setPayrollForm] = useState({
    periodStart: "",
    periodEnd: "",
  });

  const settingsQuery = useQuery({
    queryKey: ["admin", "hr", "settings", "workweekDays"],
    queryFn: () => fetcher("/api/admin/hr/settings?keys=hr.workweekDays"),
  });
  const summaryQuery = useQuery({
    queryKey: ["admin", "hr", "summary"],
    queryFn: () => fetcher("/api/admin/hr/summary"),
  });

  const resolveWorkweekDays = (value: unknown) => {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 5 && num <= 7) return Math.floor(num);
    return 5;
  };
  const workweekDays = resolveWorkweekDays(settingsQuery.data?.values?.["hr.workweekDays"]);

  const employeeSummary = summaryQuery.data?.people;
  const payrollSummary = summaryQuery.data?.payroll?.latestRun ?? null;
  const portalSummary = summaryQuery.data?.portal;
  const leaveSummary = summaryQuery.data?.leave;
  const hiringSummary = summaryQuery.data?.hiring;
  const issuesSummary = summaryQuery.data?.issues;

  const employeeCount = typeof employeeSummary?.total === "number" ? employeeSummary.total : null;
  const activeEmployees = typeof employeeSummary?.active === "number" ? employeeSummary.active : null;
  const onLeaveEmployees = typeof employeeSummary?.onLeave === "number" ? employeeSummary.onLeave : null;
  const missingProfiles = typeof employeeSummary?.missingProfiles === "number" ? employeeSummary.missingProfiles : null;
  const linkedEmployees = typeof employeeSummary?.linkedEmployees === "number" ? employeeSummary.linkedEmployees : null;
  const unlinkedEmployees = typeof employeeSummary?.unlinkedEmployees === "number" ? employeeSummary.unlinkedEmployees : null;
  const jobCount = typeof hiringSummary?.openRoles === "number" ? hiringSummary.openRoles : null;
  const openIssues = typeof issuesSummary?.open === "number" ? issuesSummary.open : null;
  const pendingLeaveRequests = typeof leaveSummary?.pendingRequests === "number" ? leaveSummary.pendingRequests : null;
  const visiblePortalDocuments =
    typeof portalSummary?.visibleDocuments === "number" ? portalSummary.visibleDocuments : null;
  const visiblePortalReviews =
    typeof portalSummary?.visibleReviewSummaries === "number" ? portalSummary.visibleReviewSummaries : null;
  const awaitingPortalVisibility =
    typeof portalSummary?.awaitingVisibilityReviewSummaries === "number"
      ? portalSummary.awaitingVisibilityReviewSummaries
      : null;
  const recentActivity: RecentHrActivityItem[] = Array.isArray(summaryQuery.data?.recentActivity)
    ? (summaryQuery.data.recentActivity as RecentHrActivityItem[])
    : [];

  const failedSections = [
    settingsQuery.isError ? "workweek settings" : null,
    summaryQuery.isError ? "hr summary" : null,
  ].filter((value): value is string => Boolean(value));

  async function retryFailedLoads() {
    await Promise.all([
      settingsQuery.refetch(),
      summaryQuery.refetch(),
    ]);
  }

  async function handleCreateEmployee() {
    setSavingEmployee(true);
    try {
      const response = await fetch("/api/admin/hr/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(employeeForm),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : "Failed to create employee.");
      }
      toast.success("Employee created successfully.");
      setEmployeeDialogOpen(false);
      setEmployeeForm({
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        department: "",
        position: "",
        status: "ACTIVE",
        hireDate: "",
      });
      await summaryQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create employee.");
    } finally {
      setSavingEmployee(false);
    }
  }

  async function handleCreatePayrollRun() {
    setSavingPayrollRun(true);
    try {
      const response = await fetch("/api/admin/hr/payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodStart: toIsoDateTime(payrollForm.periodStart),
          periodEnd: toIsoDateTime(payrollForm.periodEnd, true),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : "Failed to create payroll run.");
      }
      toast.success("Payroll run created successfully.");
      setPayrollDialogOpen(false);
      setPayrollForm({ periodStart: "", periodEnd: "" });
      await summaryQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create payroll run.");
    } finally {
      setSavingPayrollRun(false);
    }
  }

  return (
    <section className="space-y-6">
      <Card className="overflow-hidden border-border/70 bg-gradient-to-br from-background via-primary/5 to-background">
        <CardContent className="space-y-6 p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-3xl space-y-3">
              <div className="inline-flex items-center rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-primary">
                HR workspace
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Human Resources</h1>
                <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
                  Run HR operations from one control page: people records, hiring, payroll, leave, reviews, and
                  reporting.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href="#people-operations"
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  People
                </a>
                <a
                  href="#pay-and-performance"
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  Payroll and performance
                </a>
                <a
                  href="#hr-controls"
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  Controls and reports
                </a>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 xl:justify-end">
              <span className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs text-muted-foreground">
                Default workweek: {settingsQuery.isError ? "Unavailable" : `${workweekDays} day(s)`}
              </span>
              <Dialog open={employeeDialogOpen} onOpenChange={setEmployeeDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="mr-2 h-4 w-4" />
                    Add employee
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add employee</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input
                      placeholder="First name"
                      value={employeeForm.firstName}
                      onChange={(e) => setEmployeeForm((prev) => ({ ...prev, firstName: e.target.value }))}
                    />
                    <Input
                      placeholder="Last name"
                      value={employeeForm.lastName}
                      onChange={(e) => setEmployeeForm((prev) => ({ ...prev, lastName: e.target.value }))}
                    />
                    <Input
                      placeholder="Email"
                      value={employeeForm.email}
                      onChange={(e) => setEmployeeForm((prev) => ({ ...prev, email: e.target.value }))}
                    />
                    <Input
                      placeholder="Phone"
                      value={employeeForm.phone}
                      onChange={(e) => setEmployeeForm((prev) => ({ ...prev, phone: e.target.value }))}
                    />
                    <Input
                      placeholder="Department"
                      value={employeeForm.department}
                      onChange={(e) => setEmployeeForm((prev) => ({ ...prev, department: e.target.value }))}
                    />
                    <Input
                      placeholder="Position"
                      value={employeeForm.position}
                      onChange={(e) => setEmployeeForm((prev) => ({ ...prev, position: e.target.value }))}
                    />
                    <Select
                      value={employeeForm.status}
                      onValueChange={(value) => setEmployeeForm((prev) => ({ ...prev, status: value }))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ACTIVE">Active</SelectItem>
                        <SelectItem value="ON_LEAVE">On leave</SelectItem>
                        <SelectItem value="SUSPENDED">Suspended</SelectItem>
                        <SelectItem value="TERMINATED">Terminated</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="date"
                      value={employeeForm.hireDate}
                      onChange={(e) => setEmployeeForm((prev) => ({ ...prev, hireDate: e.target.value }))}
                    />
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setEmployeeDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="button" onClick={() => void handleCreateEmployee()} disabled={savingEmployee}>
                      {savingEmployee ? "Saving..." : "Create employee"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <Dialog open={payrollDialogOpen} onOpenChange={setPayrollDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" variant="outline">
                    <Plus className="mr-2 h-4 w-4" />
                    Create payroll run
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create payroll run</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input
                      type="date"
                      value={payrollForm.periodStart}
                      onChange={(e) => setPayrollForm((prev) => ({ ...prev, periodStart: e.target.value }))}
                    />
                    <Input
                      type="date"
                      value={payrollForm.periodEnd}
                      onChange={(e) => setPayrollForm((prev) => ({ ...prev, periodEnd: e.target.value }))}
                    />
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setPayrollDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="button" onClick={() => void handleCreatePayrollRun()} disabled={savingPayrollRun}>
                      {savingPayrollRun ? "Saving..." : "Create payroll run"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/hr/settings">Manage HR settings</Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Total staff</p>
              <p className="mt-2 text-2xl font-semibold">
                <SummaryValue value={employeeCount} isLoading={summaryQuery.isLoading} isError={summaryQuery.isError} />
              </p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Active staff</p>
              <p className="mt-2 text-2xl font-semibold">
                <SummaryValue
                  value={activeEmployees}
                  isLoading={summaryQuery.isLoading}
                  isError={summaryQuery.isError}
                />
              </p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">On leave</p>
              <p className="mt-2 text-2xl font-semibold">
                <SummaryValue
                  value={onLeaveEmployees}
                  isLoading={summaryQuery.isLoading}
                  isError={summaryQuery.isError}
                />
              </p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Open roles</p>
              <p className="mt-2 text-2xl font-semibold">
                <SummaryValue value={jobCount} isLoading={summaryQuery.isLoading} isError={summaryQuery.isError} />
              </p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Open issues</p>
              <p className="mt-2 text-2xl font-semibold">
                <SummaryValue value={openIssues} isLoading={summaryQuery.isLoading} isError={summaryQuery.isError} />
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-border/70 bg-background/70 p-4">
            <p className="text-sm font-medium">Current HR snapshot</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {summaryQuery.isError
                ? "Staff summary is currently unavailable."
                : `Active staff: ${activeEmployees ?? "Loading"} • On leave: ${onLeaveEmployees ?? "Loading"} • Missing profile details: ${missingProfiles ?? "Loading"}`}
            </p>
          </div>
        </CardContent>
      </Card>

      {failedSections.length > 0 ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base">Some HR summary data could not be loaded</CardTitle>
              <p className="text-sm text-muted-foreground">
                Retry the page summary before using these counts for planning: {failedSections.join(", ")}.
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => void retryFailedLoads()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry failed loads
            </Button>
          </CardHeader>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,0.95fr)]">
        <div className="space-y-6">
          <section id="people-operations" className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold tracking-tight">People operations</h2>
              <p className="text-sm text-muted-foreground">
                Manage employee records, active hiring work, and staff issues from one area.
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <HrActionCard
                icon={Users}
                title="Staff Directory"
                caption={
                  <CountCaption
                    count={employeeCount}
                    singularLabel="employee"
                    pluralLabel="employees"
                    isLoading={summaryQuery.isLoading}
                    isError={summaryQuery.isError}
                  />
                }
                description="Open employee workspaces, review profile completeness, and manage day-to-day staff records."
                href="/admin/hr/staff"
                actionLabel="Open Staff"
              />
              <HrActionCard
                icon={Briefcase}
                title="Hiring"
                caption={
                  <CountCaption
                    count={jobCount}
                    singularLabel="posting"
                    pluralLabel="postings"
                    isLoading={summaryQuery.isLoading}
                    isError={summaryQuery.isError}
                  />
                }
                description="Track job postings, applicants, interviews, and closing actions for active roles."
                href="/admin/hr/hiring"
                actionLabel="Open Hiring"
              />
              <HrActionCard
                icon={AlertTriangle}
                title="Staff Issues"
                caption={
                  <CountCaption
                    count={openIssues}
                    singularLabel="open issue"
                    pluralLabel="open issues"
                    isLoading={summaryQuery.isLoading}
                    isError={summaryQuery.isError}
                  />
                }
                description="Review open employee issues, assign follow-up, and close resolved concerns."
                href="/admin/hr/issues"
                actionLabel="Open Issues"
              />
            </div>
          </section>

          <section id="pay-and-performance" className="space-y-4">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold tracking-tight">Payroll and performance</h2>
              <p className="text-sm text-muted-foreground">
                Move between compensation setup, payroll execution, and published review cycles.
              </p>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <HrActionCard
                icon={Banknote}
                title="Compensation"
                description="Review salary changes, allowances, deductions, and compensation approval history."
                href="/admin/hr/compensation"
                actionLabel="Open Compensation"
              />
              <HrActionCard
                icon={Wallet}
                title="Payroll Runs"
                description="Open payroll runs, resolve blockers, and complete final payroll actions from the run workspace."
                href="/admin/hr/payroll"
                actionLabel="Open Payroll Runs"
              />
              <HrActionCard
                icon={ClipboardList}
                title="Performance Reviews"
                description="Manage review cycles, publication state, and employee-facing visibility for review summaries."
                href="/admin/hr/reviews"
                actionLabel="Open Reviews"
              />
            </div>
          </section>
        </div>

        <aside className="space-y-6">
          <Card className="border-border/70">
            <CardHeader>
              <CardTitle className="text-lg">Attention needed</CardTitle>
              <p className="text-sm text-muted-foreground">
                Use these summaries to jump straight into current HR blockers and pending work.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-xl border border-border/70 bg-background/80 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Missing staff profile details</p>
                    <p className="text-sm text-muted-foreground">Employees missing core HR information should be fixed first.</p>
                  </div>
                  <p className="text-xl font-semibold">
                    <SummaryValue value={missingProfiles} isLoading={summaryQuery.isLoading} isError={summaryQuery.isError} />
                  </p>
                </div>
                <Button asChild variant="outline" className="mt-4 w-full">
                  <Link href="/admin/hr/staff?completeness=missing">Open missing profiles</Link>
                </Button>
              </div>

              <div className="rounded-xl border border-border/70 bg-background/80 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Pending leave requests</p>
                    <p className="text-sm text-muted-foreground">Open leave requests that still need an HR decision.</p>
                  </div>
                  <p className="text-xl font-semibold">
                    <SummaryValue
                      value={pendingLeaveRequests}
                      isLoading={summaryQuery.isLoading}
                      isError={summaryQuery.isError}
                    />
                  </p>
                </div>
                <Button asChild variant="outline" className="mt-4 w-full">
                  <Link href="/admin/hr/leave?status=REQUESTED">Open pending leave</Link>
                </Button>
              </div>

              <div className="rounded-xl border border-border/70 bg-background/80 p-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Latest payroll run</p>
                  {payrollSummary ? (
                    <>
                      <p className="text-sm text-muted-foreground">
                        {new Date(payrollSummary.periodStart).toLocaleDateString()} to{" "}
                        {new Date(payrollSummary.periodEnd).toLocaleDateString()} • {payrollSummary.status}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Payslips: {payrollSummary.payslipCount} • Bank blockers: {payrollSummary.missingBankDetailsCount} • Expense entry:{" "}
                        {payrollSummary.hasExpenseEntry ? "Created" : "Not created"}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {summaryQuery.isError ? "Unavailable" : "No payroll run available yet."}
                    </p>
                  )}
                </div>
                <div className="mt-4 grid gap-2">
                  {payrollSummary ? (
                    <Button asChild className="w-full">
                      <Link href={`/admin/hr/payroll/${payrollSummary.id}`}>Open latest payroll run</Link>
                    </Button>
                  ) : null}
                  <Button asChild variant="outline" className="w-full">
                    <Link href="/admin/hr/payroll">Open payroll runs</Link>
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>

      <div id="hr-controls" className="grid gap-6 xl:grid-cols-3">
        <Card className="border-border/70 xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Employee portal oversight</CardTitle>
            <p className="text-sm text-muted-foreground">
              Track whether staff are linked to portal accounts and how much HR content is currently published.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border/70 bg-background/80 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Linked employees</p>
                <p className="mt-2 text-2xl font-semibold">
                  <SummaryValue value={linkedEmployees} isLoading={summaryQuery.isLoading} isError={summaryQuery.isError} />
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {summaryQuery.isError ? "Unavailable" : `${unlinkedEmployees ?? "Loading"} still need a linked user profile.`}
                </p>
              </div>
              <div className="rounded-xl border border-border/70 bg-background/80 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Visible HR documents</p>
                <p className="mt-2 text-2xl font-semibold">
                  <SummaryValue
                    value={visiblePortalDocuments}
                    isLoading={summaryQuery.isLoading}
                    isError={summaryQuery.isError}
                  />
                </p>
                <p className="mt-1 text-sm text-muted-foreground">Documents employees can currently view in the portal.</p>
              </div>
              <div className="rounded-xl border border-border/70 bg-background/80 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Visible review summaries</p>
                <p className="mt-2 text-2xl font-semibold">
                  <SummaryValue
                    value={visiblePortalReviews}
                    isLoading={summaryQuery.isLoading}
                    isError={summaryQuery.isError}
                  />
                </p>
                <p className="mt-1 text-sm text-muted-foreground">Review summaries employees can currently read.</p>
              </div>
              <div className="rounded-xl border border-border/70 bg-background/80 p-4">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Awaiting visibility decision</p>
                <p className="mt-2 text-2xl font-semibold">
                  <SummaryValue
                    value={awaitingPortalVisibility}
                    isLoading={summaryQuery.isLoading}
                    isError={summaryQuery.isError}
                  />
                </p>
                <p className="mt-1 text-sm text-muted-foreground">Submitted reviews not yet marked visible in the employee portal.</p>
              </div>
            </div>
            <div className="grid gap-2">
              <Button asChild variant="outline" className="w-full">
                <Link href="/admin/users">Open users and roles</Link>
              </Button>
              <Button asChild variant="outline" className="w-full">
                <Link href="/admin/hr/reviews">Open review visibility controls</Link>
              </Button>
              <Button asChild variant="outline" className="w-full">
                <Link href="/account/employee">Open employee portal</Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70">
          <CardHeader>
            <CardTitle className="text-lg">Quick actions</CardTitle>
            <p className="text-sm text-muted-foreground">
              Shortcuts for the HR work admins typically need first.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <RailLink
              icon={Users}
              title="Review missing profiles"
              description="Fix missing employee profile details before payroll and portal work."
              href="/admin/hr/staff?completeness=missing"
            />
            <RailLink
              icon={CalendarDays}
              title="Open pending leave"
              description="Go straight to leave requests that still need a decision."
              href="/admin/hr/leave?status=REQUESTED"
            />
            <RailLink
              icon={Wallet}
              title="Create or review payroll"
              description="Open payroll runs to create a new run or continue the latest one."
              href="/admin/hr/payroll"
            />
            <RailLink
              icon={SlidersHorizontal}
              title="Open HR settings"
              description="Update shared HR defaults for payroll, leave, and reviews."
              href="/admin/hr/settings"
            />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.8fr)]">
        <Card className="border-border/70">
          <CardHeader>
            <CardTitle className="text-lg">Reporting and exports</CardTitle>
            <p className="text-sm text-muted-foreground">
              Export key HR datasets for operational review, finance handoff, or external analysis.
            </p>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            <RailLink
              icon={FileDown}
              title="Export staff CSV"
              description="Download the current employee directory for offline review."
              href="/api/admin/hr/reports/staff"
            />
            <RailLink
              icon={FileDown}
              title="Export hires CSV"
              description="Download hiring records and applicant outcomes."
              href="/api/admin/hr/reports/hires"
            />
            <RailLink
              icon={FileDown}
              title="Export issues CSV"
              description="Download staff issue records for case tracking and reporting."
              href="/api/admin/hr/reports/issues"
            />
          </CardContent>
        </Card>

        <Card className="border-border/70">
          <CardHeader>
            <CardTitle className="text-lg">Recent HR activity</CardTitle>
            <p className="text-sm text-muted-foreground">
              Latest HR actions across staff, payroll, leave, hiring, reviews, and portal publication work.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {summaryQuery.isError ? "Activity unavailable right now." : "No recent HR activity found."}
              </p>
            ) : (
              recentActivity.slice(0, 2).map((item) => {
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
            <Button asChild variant="outline" className="w-full">
              <Link href="/admin/audit?sourcePage=admin/hr">Open HR audit</Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-muted/20 xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">What this page covers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>Use this hub to get into the right HR workspace quickly, then complete detailed actions on the destination pages.</p>
            <p>Employee detail, payroll run detail, staff audit, and employee portal oversight now live deeper in the HR module.</p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
