"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, BriefcaseBusiness, IdCard, UserRoundPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { validateStaffBankInput, validateStaffContactInput } from "@/lib/hr-staff-profile-utils";
import {
  getEmployeeOnboardingState,
  HIRING_PIPELINE_PENDING_NOTE,
  type OnboardingStatus,
} from "@/lib/hr-onboarding-status";

type EmployeeStatus = "ACTIVE" | "ON_LEAVE" | "SUSPENDED" | "TERMINATED";

type EmployeeRecord = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  department?: string | null;
  position?: string | null;
  status: EmployeeStatus;
  hireDate?: string | null;
  notes?: string | null;
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankCode?: string | null;
  bankBranch?: string | null;
  updatedAt: string;
  onboarding?: {
    status: OnboardingStatus;
    summary: string;
    missingFields: string[];
    hasPendingMarker: boolean;
  };
};

type OnboardingQueueResponse = {
  rows: EmployeeRecord[];
  total: number;
  summary: {
    pendingOnboarding: number;
  };
};

type FormState = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  department: string;
  position: string;
  status: EmployeeStatus;
  hireDate: string;
  notes: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankCode: string;
  bankBranch: string;
};

const ONBOARDING_SOURCE_PAGE = "admin/hr/onboarding";

function fetcher<T>(url: string): Promise<T> {
  return fetch(url).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(typeof body?.error === "string" ? body.error : "Request failed.");
    }
    return body as T;
  });
}

function createEmptyForm(): FormState {
  return {
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    department: "",
    position: "",
    status: "ACTIVE",
    hireDate: "",
    notes: "",
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
    bankCode: "",
    bankBranch: "",
  };
}

function toFormSnapshot(form: FormState) {
  return JSON.stringify(form);
}

function getEmployeeForm(record: EmployeeRecord): FormState {
  return {
    firstName: record.firstName || "",
    lastName: record.lastName || "",
    email: record.email || "",
    phone: record.phone || "",
    department: record.department || "",
    position: record.position || "",
    status: record.status || "ACTIVE",
    hireDate: toDateInputValue(record.hireDate),
    notes: record.notes || "",
    bankName: record.bankName || "",
    bankAccountName: record.bankAccountName || "",
    bankAccountNumber: record.bankAccountNumber || "",
    bankCode: record.bankCode || "",
    bankBranch: record.bankBranch || "",
  };
}

function toDateInputValue(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function getReturnHref(source: string) {
  if (source === "onboarding") return "/admin/hr/onboarding";
  if (source === "staff") return "/admin/hr/staff";
  if (source === "users") return "/admin/users";
  if (source === "hiring") return "/admin/hr/hiring";
  return "/admin/hr";
}

function getReturnLabel(source: string) {
  if (source === "onboarding") return "Back to onboarding queue";
  if (source === "staff") return "Back to staff directory";
  if (source === "users") return "Back to users and roles";
  if (source === "hiring") return "Back to hiring";
  return "Back to HR workspace";
}

function getFlowSummary(source: string, isExisting: boolean) {
  if (source === "hiring") {
    return isExisting
      ? "This employee came from the hiring pipeline. Complete the HR, payroll, and access details here before handing off to the staff profile."
      : "Finish the employee profile here after the candidate is hired so recruiting and staff onboarding stay in one controlled flow.";
  }
  if (source === "users") {
    return "Use this page for employee records. Return to Users & Roles only when you are ready to invite or manage account access.";
  }
  if (source === "staff") {
    return "Staff directory now routes employee creation into this centralized onboarding flow so profile setup stays consistent.";
  }
  return "Use one onboarding flow for every new employee record so HR, hiring, payroll readiness, and account handoff all start from the same place.";
}

function getAccessHint(source: string) {
  if (source === "users") {
    return "Finish HR details here, then return to Users & Roles to send the user invite.";
  }
  if (source === "hiring") {
    return "After saving, hand off to Users & Roles if the employee needs portal access or admin permissions.";
  }
  return "After saving, use Users & Roles to invite the employee into the portal or admin workspace.";
}

export default function HrOnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const employeeId = String(searchParams.get("employeeId") || "").trim();
  const source = String(searchParams.get("source") || "hr").trim().toLowerCase();
  const returnHref = getReturnHref(source);
  const returnLabel = getReturnLabel(source);
  const isExisting = employeeId.length > 0;
  const [form, setForm] = useState<FormState>(createEmptyForm);
  const [initialFormSnapshot, setInitialFormSnapshot] = useState(() => toFormSnapshot(createEmptyForm()));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [skipUnsavedGuard, setSkipUnsavedGuard] = useState(false);
  const [queueSearch, setQueueSearch] = useState(String(searchParams.get("q") || "").trim());
  const [queueSearchDebounced, setQueueSearchDebounced] = useState(String(searchParams.get("q") || "").trim());

  const employeeQuery = useQuery({
    queryKey: ["admin", "hr", "employee-onboarding", employeeId],
    queryFn: () => fetcher<EmployeeRecord>(`/api/admin/hr/employees/${employeeId}`),
    enabled: isExisting,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setQueueSearchDebounced(queueSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queueSearch]);

  const onboardingQueueQuery = useQuery({
    queryKey: ["admin", "hr", "onboarding-queue", queueSearchDebounced],
    queryFn: () =>
      fetcher<OnboardingQueueResponse>(
        `/api/admin/hr/employees?onboarding=pending&pageSize=8&sort=recent${queueSearchDebounced ? `&q=${encodeURIComponent(queueSearchDebounced)}` : ""}`,
      ),
    enabled: !isExisting,
  });

  useEffect(() => {
    if (!isExisting) {
      const emptyForm = createEmptyForm();
      setForm(emptyForm);
      setInitialFormSnapshot(toFormSnapshot(emptyForm));
      setFieldErrors({});
      setSkipUnsavedGuard(false);
      return;
    }
    if (!employeeQuery.data) return;
    const nextForm = getEmployeeForm(employeeQuery.data);
    setForm(nextForm);
    setInitialFormSnapshot(toFormSnapshot(nextForm));
    setFieldErrors({});
    setSkipUnsavedGuard(false);
  }, [employeeQuery.data, isExisting]);

  const hasUnsavedChanges = useMemo(() => toFormSnapshot(form) !== initialFormSnapshot, [form, initialFormSnapshot]);

  useUnsavedChangesGuard({
    enabled: hasUnsavedChanges && !submitting && !skipUnsavedGuard,
    message: "You have unsaved onboarding changes. Leave this page and discard them?",
  });

  const currentOnboardingState = useMemo(
    () =>
      getEmployeeOnboardingState({
        email: form.email,
        phone: form.phone,
        department: form.department,
        position: form.position,
        hireDate: form.hireDate,
        notes: form.notes,
      }),
    [form],
  );

  const coreReady = useMemo(() => 5 - currentOnboardingState.missingFields.filter((field) => field !== "Email" && field !== "Phone").length, [currentOnboardingState]);

  const contactReady = useMemo(
    () => 2 - currentOnboardingState.missingFields.filter((field) => field === "Email" || field === "Phone").length,
    [currentOnboardingState],
  );

  const bankFieldCount = useMemo(() => {
    return [
      form.bankName.trim(),
      form.bankAccountName.trim(),
      form.bankAccountNumber.trim(),
      form.bankCode.trim(),
      form.bankBranch.trim(),
    ].filter(Boolean).length;
  }, [form]);

  async function handleSubmit() {
    const trimmedFirstName = form.firstName.trim();
    const trimmedLastName = form.lastName.trim();
    const trimmedDepartment = form.department.trim();
    const trimmedPosition = form.position.trim();
    const trimmedHireDate = form.hireDate.trim();
    const nextErrors: Record<string, string> = {};

    if (!trimmedFirstName) nextErrors.firstName = "First name is required.";
    if (!trimmedLastName) nextErrors.lastName = "Last name is required.";
    if (!trimmedDepartment) nextErrors.department = "Department is required.";
    if (!trimmedPosition) nextErrors.position = "Position is required.";
    if (!trimmedHireDate) nextErrors.hireDate = "Hire date is required.";

    const { email, phone, errors: contactErrors } = validateStaffContactInput({
      email: form.email,
      phone: form.phone,
    });
    Object.assign(nextErrors, contactErrors);

    const hasAnyBankDetail = bankFieldCount > 0;
    let normalizedBank = {
      bankName: form.bankName.trim(),
      bankAccountName: form.bankAccountName.trim(),
      bankAccountNumber: form.bankAccountNumber.trim(),
      bankCode: form.bankCode.trim(),
      bankBranch: form.bankBranch.trim(),
    };

    if (hasAnyBankDetail) {
      const bankValidation = validateStaffBankInput(form);
      normalizedBank = bankValidation.normalized;
      Object.assign(nextErrors, bankValidation.errors);
    }

    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.error("Complete the highlighted onboarding fields.");
      return;
    }

    setSubmitting(true);
    try {
      const payload = {
        firstName: trimmedFirstName,
        lastName: trimmedLastName,
        email,
        phone,
        department: trimmedDepartment,
        position: trimmedPosition,
        status: form.status,
        hireDate: trimmedHireDate,
        notes: form.notes.trim() === HIRING_PIPELINE_PENDING_NOTE ? "" : form.notes.trim(),
        bankName: normalizedBank.bankName,
        bankAccountName: normalizedBank.bankAccountName,
        bankAccountNumber: normalizedBank.bankAccountNumber,
        bankCode: normalizedBank.bankCode,
        bankBranch: normalizedBank.bankBranch,
        sourcePage: ONBOARDING_SOURCE_PAGE,
        section: "employee-onboarding",
        operation: isExisting ? "complete_employee_onboarding" : "create_employee_onboarding",
        resultSummary: isExisting
          ? "Employee onboarding details completed."
          : "Employee created from the centralized onboarding flow.",
      };

      const res = await fetch(isExisting ? `/api/admin/hr/employees/${employeeId}` : "/api/admin/hr/employees", {
        method: isExisting ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          ...(isExisting ? { expectedUpdatedAt: employeeQuery.data?.updatedAt || "" } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "Failed to save employee onboarding.");
        return;
      }

      const savedEmployeeId = String(body?.id || employeeId || "").trim();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employees"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "employee-invites"] }),
        savedEmployeeId
          ? queryClient.invalidateQueries({ queryKey: ["admin", "hr", "employee-onboarding", savedEmployeeId] })
          : Promise.resolve(),
      ]);

      toast.success(isExisting ? "Employee onboarding updated." : "Employee created.");
      setSkipUnsavedGuard(true);
      if (savedEmployeeId) {
        router.push(`/admin/hr/staff/${savedEmployeeId}`);
        return;
      }
      router.push("/admin/hr/staff");
    } catch {
      toast.error("Failed to save employee onboarding.");
    } finally {
      setSubmitting(false);
    }
  }

  const heading = isExisting ? "Complete Employee Onboarding" : "Start Employee Onboarding";
  const onboardingSummary = getFlowSummary(source, isExisting);
  const accessHint = getAccessHint(source);
  const employeeName =
    isExisting && employeeQuery.data
      ? `${employeeQuery.data.firstName || ""} ${employeeQuery.data.lastName || ""}`.trim()
      : "";
  const onboardingQueueRows = (onboardingQueueQuery.data?.rows || []).filter((row) => row.id !== employeeId);
  const pendingOnboardingCount = onboardingQueueQuery.data?.summary?.pendingOnboarding || onboardingQueueRows.length;

  return (
    <section className="space-y-6 pb-20 md:pb-0">
      <Card className="overflow-hidden border-border/70 bg-gradient-to-br from-background via-primary/5 to-background">
        <CardContent className="space-y-6 p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-3xl space-y-3">
              <div className="inline-flex items-center rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-primary">
                Centralized HR onboarding
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{heading}</h1>
                <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">{onboardingSummary}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href="#core-profile"
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  Core profile
                </a>
                <a
                  href="#payroll-readiness"
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  Payroll readiness
                </a>
                <a
                  href="#next-steps"
                  className="rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground transition hover:border-primary/40 hover:bg-muted/70"
                >
                  Next steps
                </a>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 xl:max-w-md xl:justify-end">
              <Button asChild variant="outline" size="sm">
                <Link href={returnHref}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {returnLabel}
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/users">Open Users &amp; Roles</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/hr/staff">Open Staff Directory</Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Core profile</p>
              <p className="mt-2 text-2xl font-semibold">{coreReady}/5</p>
              <p className="mt-1 text-xs text-muted-foreground">Name, department, position, and hire date</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Contact readiness</p>
              <p className="mt-2 text-2xl font-semibold">{contactReady}/2</p>
              <p className="mt-1 text-xs text-muted-foreground">Email and phone used for portal and HR comms</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Payroll readiness</p>
              <p className="mt-2 text-2xl font-semibold">{bankFieldCount}/5</p>
              <p className="mt-1 text-xs text-muted-foreground">Bank details stay optional until payroll setup begins</p>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Flow source</p>
              <p className="mt-2 text-lg font-semibold capitalize">{source || "hr"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {employeeName ? `Editing ${employeeName}` : "New employee record"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {!isExisting ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Needs onboarding</CardTitle>
            <CardDescription>
              Resume deferred onboarding for hired employees or any employee record still missing required onboarding details.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="text-sm text-muted-foreground">
                {pendingOnboardingCount > 0
                  ? `${pendingOnboardingCount} employee record${pendingOnboardingCount === 1 ? "" : "s"} still need onboarding attention.`
                  : "No employee records are currently waiting on onboarding."}
              </div>
              <Input
                value={queueSearch}
                onChange={(e) => setQueueSearch(e.target.value)}
                placeholder="Search onboarding queue"
                className="w-full md:w-72"
              />
            </div>
            {onboardingQueueQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading onboarding queue...</div>
            ) : onboardingQueueRows.length === 0 ? (
              <div className="rounded-2xl border border-border/70 bg-background/80 p-4 text-sm text-muted-foreground">
                {queueSearchDebounced
                  ? "No pending onboarding records match this search."
                  : "No pending onboarding records right now."}
              </div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {onboardingQueueRows.map((row) => (
                  <div key={row.id} className="rounded-2xl border border-border/70 bg-background/80 p-4 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="font-medium">
                          {row.firstName} {row.lastName}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {row.department || "Department pending"} {row.position ? `- ${row.position}` : ""}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs uppercase tracking-[0.18em] text-amber-700">Pending onboarding</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {row.onboarding?.hasPendingMarker ? "From hiring pipeline" : "Missing required fields"}
                        </div>
                      </div>
                    </div>
                    <p className="mt-3 text-sm text-muted-foreground">{row.onboarding?.summary || "Resume onboarding."}</p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button asChild size="sm">
                        <Link href={`/admin/hr/onboarding?source=onboarding&employeeId=${row.id}`}>Resume onboarding</Link>
                      </Button>
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/admin/hr/staff/${row.id}`}>Open staff profile</Link>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {isExisting && employeeQuery.isLoading ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">Loading employee onboarding details...</CardContent>
        </Card>
      ) : null}

      {isExisting && employeeQuery.isError ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="p-6 text-sm text-destructive">
            {employeeQuery.error instanceof Error ? employeeQuery.error.message : "Employee details could not be loaded."}
          </CardContent>
        </Card>
      ) : null}

      {!isExisting || employeeQuery.data ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.9fr)]">
          <div className="space-y-6">
            <Card id="core-profile">
              <CardHeader>
                <CardTitle className="text-base">Core profile</CardTitle>
                <CardDescription>
                  Capture the employee identity and role details once here instead of recreating them across HR pages.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor="onboarding-first-name" className="text-xs font-medium text-muted-foreground">First name</label>
                  <Input
                    id="onboarding-first-name"
                    value={form.firstName}
                    onChange={(e) => setForm((prev) => ({ ...prev, firstName: e.target.value }))}
                    placeholder="First name"
                  />
                  {fieldErrors.firstName ? <p className="text-xs text-destructive">{fieldErrors.firstName}</p> : null}
                </div>
                <div className="space-y-2">
                  <label htmlFor="onboarding-last-name" className="text-xs font-medium text-muted-foreground">Last name</label>
                  <Input
                    id="onboarding-last-name"
                    value={form.lastName}
                    onChange={(e) => setForm((prev) => ({ ...prev, lastName: e.target.value }))}
                    placeholder="Last name"
                  />
                  {fieldErrors.lastName ? <p className="text-xs text-destructive">{fieldErrors.lastName}</p> : null}
                </div>
                <div className="space-y-2">
                  <label htmlFor="onboarding-department" className="text-xs font-medium text-muted-foreground">Department</label>
                  <Input
                    id="onboarding-department"
                    value={form.department}
                    onChange={(e) => setForm((prev) => ({ ...prev, department: e.target.value }))}
                    placeholder="Department"
                  />
                  {fieldErrors.department ? <p className="text-xs text-destructive">{fieldErrors.department}</p> : null}
                </div>
                <div className="space-y-2">
                  <label htmlFor="onboarding-position" className="text-xs font-medium text-muted-foreground">Position</label>
                  <Input
                    id="onboarding-position"
                    value={form.position}
                    onChange={(e) => setForm((prev) => ({ ...prev, position: e.target.value }))}
                    placeholder="Position"
                  />
                  {fieldErrors.position ? <p className="text-xs text-destructive">{fieldErrors.position}</p> : null}
                </div>
                <div className="space-y-2">
                  <label htmlFor="onboarding-status" className="text-xs font-medium text-muted-foreground">Status</label>
                  <Select
                    value={form.status}
                    onValueChange={(value) => setForm((prev) => ({ ...prev, status: value as EmployeeStatus }))}
                  >
                    <SelectTrigger id="onboarding-status">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="ON_LEAVE">On leave</SelectItem>
                      <SelectItem value="SUSPENDED">Suspended</SelectItem>
                      <SelectItem value="TERMINATED">Terminated</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label htmlFor="onboarding-hire-date" className="text-xs font-medium text-muted-foreground">Hire date</label>
                  <Input
                    id="onboarding-hire-date"
                    type="date"
                    value={form.hireDate}
                    onChange={(e) => setForm((prev) => ({ ...prev, hireDate: e.target.value }))}
                  />
                  {fieldErrors.hireDate ? <p className="text-xs text-destructive">{fieldErrors.hireDate}</p> : null}
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <label htmlFor="onboarding-notes" className="text-xs font-medium text-muted-foreground">Internal note</label>
                  <Textarea
                    id="onboarding-notes"
                    value={form.notes}
                    onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                    placeholder="Optional onboarding or hiring note"
                  />
                </div>
              </CardContent>
            </Card>

            <Card id="payroll-readiness">
              <CardHeader>
                <CardTitle className="text-base">Contact and payroll readiness</CardTitle>
                <CardDescription>
                  Use the same onboarding surface for staff contact data and optional bank information before payroll setup.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor="onboarding-email" className="text-xs font-medium text-muted-foreground">Email</label>
                  <Input
                    id="onboarding-email"
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                    placeholder="name@company.com"
                  />
                  {fieldErrors.email ? <p className="text-xs text-destructive">{fieldErrors.email}</p> : null}
                </div>
                <div className="space-y-2">
                  <label htmlFor="onboarding-phone" className="text-xs font-medium text-muted-foreground">Phone</label>
                  <Input
                    id="onboarding-phone"
                    value={form.phone}
                    onChange={(e) => setForm((prev) => ({ ...prev, phone: e.target.value }))}
                    placeholder="0241234567"
                  />
                  {fieldErrors.phone ? <p className="text-xs text-destructive">{fieldErrors.phone}</p> : null}
                </div>
                <div className="space-y-2">
                  <label htmlFor="onboarding-bank-name" className="text-xs font-medium text-muted-foreground">Bank name</label>
                  <Input
                    id="onboarding-bank-name"
                    value={form.bankName}
                    onChange={(e) => setForm((prev) => ({ ...prev, bankName: e.target.value }))}
                    placeholder="Bank name"
                  />
                  {fieldErrors.bankName ? <p className="text-xs text-destructive">{fieldErrors.bankName}</p> : null}
                </div>
                <div className="space-y-2">
                  <label htmlFor="onboarding-account-name" className="text-xs font-medium text-muted-foreground">Account name</label>
                  <Input
                    id="onboarding-account-name"
                    value={form.bankAccountName}
                    onChange={(e) => setForm((prev) => ({ ...prev, bankAccountName: e.target.value }))}
                    placeholder="Account name"
                  />
                  {fieldErrors.bankAccountName ? <p className="text-xs text-destructive">{fieldErrors.bankAccountName}</p> : null}
                </div>
                <div className="space-y-2">
                  <label htmlFor="onboarding-account-number" className="text-xs font-medium text-muted-foreground">Account number</label>
                  <Input
                    id="onboarding-account-number"
                    value={form.bankAccountNumber}
                    onChange={(e) => setForm((prev) => ({ ...prev, bankAccountNumber: e.target.value }))}
                    placeholder="Account number"
                  />
                  {fieldErrors.bankAccountNumber ? <p className="text-xs text-destructive">{fieldErrors.bankAccountNumber}</p> : null}
                </div>
                <div className="space-y-2">
                  <label htmlFor="onboarding-bank-code" className="text-xs font-medium text-muted-foreground">Bank code</label>
                  <Input
                    id="onboarding-bank-code"
                    value={form.bankCode}
                    onChange={(e) => setForm((prev) => ({ ...prev, bankCode: e.target.value }))}
                    placeholder="Optional bank code"
                  />
                  {fieldErrors.bankCode ? <p className="text-xs text-destructive">{fieldErrors.bankCode}</p> : null}
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <label htmlFor="onboarding-bank-branch" className="text-xs font-medium text-muted-foreground">Bank branch</label>
                  <Input
                    id="onboarding-bank-branch"
                    value={form.bankBranch}
                    onChange={(e) => setForm((prev) => ({ ...prev, bankBranch: e.target.value }))}
                    placeholder="Branch"
                  />
                  {fieldErrors.bankBranch ? <p className="text-xs text-destructive">{fieldErrors.bankBranch}</p> : null}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card id="next-steps">
              <CardHeader>
                <CardTitle className="text-base">Next steps</CardTitle>
                <CardDescription>
                  Save the employee record here, then move into staff maintenance or user-access handoff.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-2xl border border-border/70 bg-muted/40 p-4">
                  <div className="flex items-start gap-3">
                    <div className="rounded-xl border border-border/70 bg-background p-2">
                      <BriefcaseBusiness className="h-4 w-4 text-primary" />
                    </div>
                    <div className="space-y-1">
                      <p className="font-medium">Staff profile handoff</p>
                      <p className="text-sm text-muted-foreground">
                        Saving here sends you into the full staff profile for onboarding tasks, documents, payroll, and reviews.
                      </p>
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 bg-muted/40 p-4">
                  <div className="flex items-start gap-3">
                    <div className="rounded-xl border border-border/70 bg-background p-2">
                      <IdCard className="h-4 w-4 text-primary" />
                    </div>
                    <div className="space-y-1">
                      <p className="font-medium">Access handoff</p>
                      <p className="text-sm text-muted-foreground">{accessHint}</p>
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-border/70 bg-muted/40 p-4">
                  <div className="flex items-start gap-3">
                    <div className="rounded-xl border border-border/70 bg-background p-2">
                      <UserRoundPlus className="h-4 w-4 text-primary" />
                    </div>
                    <div className="space-y-1">
                      <p className="font-medium">Centralized source of truth</p>
                      <p className="text-sm text-muted-foreground">
                        HR overview, staff directory, and hiring now route new employee setup through this page.
                      </p>
                    </div>
                  </div>
                </div>
                {hasUnsavedChanges ? (
                  <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                    You have unsaved onboarding changes. Refreshing, using the browser back button, or opening another admin page will ask for confirmation before leaving.
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button onClick={() => void handleSubmit()} disabled={submitting || employeeQuery.isLoading}>
                    {submitting ? "Saving..." : isExisting ? "Save and open staff profile" : "Create and open staff profile"}
                  </Button>
                  <Button asChild variant="outline">
                    <Link href="/admin/users">Go to Users &amp; Roles</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}
    </section>
  );
}
