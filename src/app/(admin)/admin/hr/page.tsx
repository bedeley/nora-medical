"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Users, Briefcase, Banknote, AlertTriangle, FileDown, CalendarDays, ClipboardList, Wallet, SlidersHorizontal } from "lucide-react";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AdminHrPage() {
  const { data: settingsData } = useQuery({
    queryKey: ["admin", "hr", "settings", "workweekDays"],
    queryFn: () => fetcher("/api/admin/hr/settings?keys=hr.workweekDays"),
  });
  const { data: employeesData } = useQuery({
    queryKey: ["admin", "hr", "employees"],
    queryFn: () => fetcher("/api/admin/hr/employees"),
  });
  const { data: jobsData } = useQuery({
    queryKey: ["admin", "hr", "jobs"],
    queryFn: () => fetcher("/api/admin/hr/jobs"),
  });
  const { data: issuesData } = useQuery({
    queryKey: ["admin", "hr", "issues"],
    queryFn: () => fetcher("/api/admin/hr/issues?status=OPEN"),
  });

  const resolveWorkweekDays = (value: unknown) => {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 5 && num <= 7) return Math.floor(num);
    return 5;
  };
  const workweekDays = resolveWorkweekDays(settingsData?.values?.["hr.workweekDays"]);

  const employeeCount = Array.isArray(employeesData?.rows) ? employeesData.rows.length : null;
  const jobCount = Array.isArray(jobsData?.rows) ? jobsData.rows.length : null;
  const openIssues = Array.isArray(issuesData?.rows) ? issuesData.rows.length : null;

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold">Human Resources</h1>
          <p className="text-muted-foreground">
            Manage staffing, hiring, compensation, and payroll from one place.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Default workweek: {workweekDays} day(s)</span>
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/hr/settings">Manage HR settings</Link>
          </Button>
        </div>
      </header>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex items-center gap-3">
            <Users className="h-6 w-6 text-primary" />
            <div>
              <CardTitle>Staff Directory</CardTitle>
              {employeeCount !== null ? (
                <p className="text-xs text-muted-foreground">{employeeCount} employees</p>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              View employee profiles, departments, and status updates.
            </p>
            <Link href="/admin/hr/staff">
              <Button className="w-full">Open Staff</Button>
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex items-center gap-3">
            <Briefcase className="h-6 w-6 text-primary" />
            <div>
              <CardTitle>Hiring</CardTitle>
              {jobCount !== null ? (
                <p className="text-xs text-muted-foreground">{jobCount} postings</p>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Track job openings, applicants, and interviews.
            </p>
            <Link href="/admin/hr/hiring">
              <Button className="w-full">Open Hiring</Button>
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex items-center gap-3">
            <Banknote className="h-6 w-6 text-primary" />
            <CardTitle>Compensation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Track salaries, allowances, and payroll runs.
            </p>
            <Link href="/admin/hr/compensation">
              <Button className="w-full">Open Payroll</Button>
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex items-center gap-3">
            <Wallet className="h-6 w-6 text-primary" />
            <CardTitle>Payroll Runs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Open payroll runs and complete final review actions.
            </p>
            <Link href="/admin/hr/payroll">
              <Button className="w-full">Open Payroll Runs</Button>
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex items-center gap-3">
            <AlertTriangle className="h-6 w-6 text-primary" />
            <div>
              <CardTitle>Staff Issues</CardTitle>
              {openIssues !== null ? (
                <p className="text-xs text-muted-foreground">{openIssues} open issues</p>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Document and resolve staff concerns.
            </p>
            <Link href="/admin/hr/issues">
              <Button className="w-full">Open Issues</Button>
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex items-center gap-3">
            <FileDown className="h-6 w-6 text-primary" />
            <CardTitle>HR Reports</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Export staff, hires, and issues as CSV.
            </p>
            <div className="grid gap-2">
              <Button asChild variant="outline" className="w-full">
                <Link href="/api/admin/hr/reports/staff">Export Staff CSV</Link>
              </Button>
              <Button asChild variant="outline" className="w-full">
                <Link href="/api/admin/hr/reports/hires">Export Hires CSV</Link>
              </Button>
              <Button asChild variant="outline" className="w-full">
                <Link href="/api/admin/hr/reports/issues">Export Issues CSV</Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex items-center gap-3">
            <CalendarDays className="h-6 w-6 text-primary" />
            <CardTitle>Leave Tracking</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Track time off and approve leave requests.
            </p>
            <Link href="/admin/hr/leave">
              <Button className="w-full">Open Leave</Button>
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex items-center gap-3">
            <ClipboardList className="h-6 w-6 text-primary" />
            <CardTitle>Performance Reviews</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Log review cycles, ratings, and goals.
            </p>
            <Link href="/admin/hr/reviews">
              <Button className="w-full">Open Reviews</Button>
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex items-center gap-3">
            <SlidersHorizontal className="h-6 w-6 text-primary" />
            <CardTitle>HR Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Manage shared defaults for leave and review workflows.
            </p>
            <Link href="/admin/hr/settings">
              <Button className="w-full" variant="outline">Open Settings</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
