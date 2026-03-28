import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDateGH, formatDateTimeGH } from "@/lib/currency";
import {
  EMPLOYEE_PORTAL_DOCUMENTS_PAGE,
  EMPLOYEE_PORTAL_HOME_PAGE,
  EMPLOYEE_PORTAL_LEAVE_PAGE,
  employeePortalReviewsEnabled,
  getEmployeePortalData,
  EMPLOYEE_PORTAL_PAYSTUBS_PAGE,
  EMPLOYEE_PORTAL_REVIEWS_PAGE,
} from "@/lib/employee-portal";
import { EmployeeContactUpdateRequestCard } from "./EmployeeContactUpdateRequestCard";
import { EmployeePortalAcknowledgeButton } from "./EmployeePortalAcknowledgeButton";
import { EmployeePortalExpandableItems } from "./EmployeePortalExpandableItems";
import { EmployeeLeaveSection } from "./EmployeeLeaveSection";

export const dynamic = "force-dynamic";

function toPlainLabel(value: string | null | undefined) {
  const normalized = String(value || "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function profileTone(status: string | null | undefined) {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "ACTIVE" || normalized === "APPROVED" || normalized === "MEETS" || normalized === "EXCEEDS") {
    return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200";
  }
  if (normalized === "REQUESTED" || normalized === "PENDING" || normalized === "SUBMITTED" || normalized === "ON_LEAVE") {
    return "bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200";
  }
  if (normalized === "REJECTED" || normalized === "CANCELLED" || normalized === "TERMINATED" || normalized === "UNSATISFACTORY") {
    return "bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200";
  }
  return "bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-200";
}

function reviewSummaryFallback(review: {
  summary: string | null;
  strengths: string | null;
  improvements: string | null;
  goals: string | null;
}) {
  return (
    review.summary ||
    review.strengths ||
    review.improvements ||
    review.goals ||
    "No written summary was added to this review."
  );
}

export default async function EmployeePortalPage() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/account/employee")}`);
  }

  const portal = await getEmployeePortalData(user.id);
  if (!portal) {
    return (
      <section className="container mx-auto max-w-4xl px-4 py-10">
        <Card className="border shadow-sm">
          <CardHeader>
            <CardTitle>Employee portal unavailable</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Your account is not linked to an employee record yet. Contact HR if you need access to payslips,
              leave history, or onboarding items.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link href="/account">Back to account</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    );
  }

  const { employee, latestCompensation, latestPayslip, pendingOnboardingCount, leaveSummary, reviews, reviewsVisible, contactUpdateRequest } =
    portal;
  const employeeName = `${employee.firstName} ${employee.lastName}`.trim();
  const activeLeave = leaveSummary.activeApprovedLeave;
  const reviewsFeatureEnabled = employeePortalReviewsEnabled();

  return (
    <section className="container mx-auto max-w-6xl px-4 py-8">
      <div className="rounded-3xl border border-border/70 bg-gradient-to-br from-sky-100/70 via-background to-emerald-100/60 p-6 shadow-sm dark:from-sky-950/40 dark:via-card dark:to-emerald-950/35">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge className={profileTone(employee.status)}>{toPlainLabel(employee.status) || "Employee"}</Badge>
              {activeLeave ? (
                <Badge className={profileTone("ON_LEAVE")}>
                  On leave until {formatDateGH(activeLeave.endDate)}
                </Badge>
              ) : null}
            </div>
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Employee portal
              </p>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">{employeeName}</h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                View your profile, pay information, leave history, onboarding checklist, documents, and review summaries
                from one read-only workspace.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
              <span>{employee.department || "Department not provided"}</span>
              <span>{employee.position || "Position not provided"}</span>
              <span>Hire date {employee.hireDate ? formatDateGH(employee.hireDate) : "not provided"}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 lg:max-w-sm lg:justify-end">
            {latestPayslip ? (
              <Button asChild>
                <Link href={`/account/employee/paystubs/${latestPayslip.id}`}>Open latest paystub</Link>
              </Button>
            ) : null}
            <Button asChild variant="outline">
              <Link href="/account">Back to account</Link>
            </Button>
          </div>
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Current compensation</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">
              {latestCompensation ? formatCurrency(Number(latestCompensation.baseSalary || 0)) : "Not set"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {latestCompensation ? `Effective ${formatDateGH(latestCompensation.effectiveDate)}` : "No active compensation record yet."}
            </p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Latest net pay</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">
              {latestPayslip ? formatCurrency(Number(latestPayslip.netPay || 0)) : "No paystub yet"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {latestPayslip ? `${formatDateGH(latestPayslip.payrollRun.periodStart)} to ${formatDateGH(latestPayslip.payrollRun.periodEnd)}` : "Your payroll history will appear here after the first run."}
            </p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pending onboarding</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">{pendingOnboardingCount}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {pendingOnboardingCount > 0 ? "Outstanding items still need attention." : "All visible onboarding tasks are complete."}
            </p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Leave requests</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">{leaveSummary.pending}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {leaveSummary.pending > 0 ? "Pending leave requests are still under review." : "No leave requests are pending review."}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-border/70 bg-card/70 p-3 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="#profile-and-employment">Profile</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="#pay-and-documents">Pay and documents</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="#leave-and-onboarding">Leave and onboarding</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="#reviews">Reviews</Link>
          </Button>
        </div>
      </div>

      <div className="mt-6 grid gap-8 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-8">
          <div id="profile-and-employment" className="space-y-4 scroll-mt-24">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">Profile and employment</h2>
              <p className="text-sm text-muted-foreground">
                Review the core employee record that HR has published to your account.
              </p>
            </div>

            <Card className="border shadow-sm">
              <CardHeader>
                <CardTitle>Profile summary</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</p>
                  <p className="mt-2 font-semibold text-foreground">{toPlainLabel(employee.status)}</p>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Department</p>
                  <p className="mt-2 font-semibold text-foreground">{employee.department || "Not provided"}</p>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Position</p>
                  <p className="mt-2 font-semibold text-foreground">{employee.position || "Not provided"}</p>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Manager</p>
                  <p className="mt-2 font-semibold text-foreground">
                    {employee.manager ? `${employee.manager.firstName} ${employee.manager.lastName}`.trim() : "Not assigned"}
                  </p>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Hire date</p>
                  <p className="mt-2 font-semibold text-foreground">
                    {employee.hireDate ? formatDateGH(employee.hireDate) : "Not provided"}
                  </p>
                </div>
                <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Termination date</p>
                  <p className="mt-2 font-semibold text-foreground">
                    {employee.terminationDate ? formatDateGH(employee.terminationDate) : "Not provided"}
                  </p>
                </div>
              </CardContent>
            </Card>

            <div className="grid gap-6 xl:grid-cols-2">
              <Card className="border shadow-sm">
                <CardHeader>
                  <CardTitle>Contact details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Email</p>
                    <p className="mt-2 break-all font-semibold text-foreground">{employee.email || "Not provided"}</p>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Phone</p>
                    <p className="mt-2 font-semibold text-foreground">{employee.phone || "Not provided"}</p>
                  </div>
                </CardContent>
              </Card>

              <Card className="border shadow-sm">
                <CardHeader>
                  <CardTitle>Employment details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Employment status</p>
                    <p className="mt-2 font-semibold text-foreground">{toPlainLabel(employee.status)}</p>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Manager summary</p>
                    <p className="mt-2 font-semibold text-foreground">
                      {employee.manager
                        ? `${employee.manager.position || "Role not provided"} - ${employee.manager.department || "Department not provided"}`
                        : "Manager not assigned"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Profile updated</p>
                    <p className="mt-2 font-semibold text-foreground">{formatDateTimeGH(employee.updatedAt)}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Portal access reflects the latest approved HR record.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>

            <EmployeeContactUpdateRequestCard
              currentEmail={employee.email}
              currentPhone={employee.phone}
              pendingRequest={contactUpdateRequest}
            />
          </div>

          <div id="pay-and-documents" className="space-y-4 scroll-mt-24">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">Pay and documents</h2>
              <p className="text-sm text-muted-foreground">
                Open the latest paystub quickly, then expand your longer pay and document history when needed.
              </p>
            </div>

            <Card className="border shadow-sm">
              <CardHeader>
                <CardTitle>Current compensation summary</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  This reflects the latest compensation record that HR has published to your profile.
                </p>
              </CardHeader>
              <CardContent>
                {latestCompensation ? (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Base salary</p>
                      <p className="mt-2 text-lg font-semibold text-foreground">
                        {formatCurrency(Number(latestCompensation.baseSalary || 0))}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Allowances</p>
                      <p className="mt-2 text-lg font-semibold text-foreground">
                        {formatCurrency(Number(latestCompensation.allowances || 0))}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Bonus</p>
                      <p className="mt-2 text-lg font-semibold text-foreground">
                        {formatCurrency(Number(latestCompensation.bonus || 0))}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Deductions</p>
                      <p className="mt-2 text-lg font-semibold text-foreground">
                        {formatCurrency(Number(latestCompensation.deductions || 0))}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-background/60 p-4 sm:col-span-2">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Effective date</p>
                      <p className="mt-2 font-semibold text-foreground">
                        {formatDateGH(latestCompensation.effectiveDate)}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Status: {toPlainLabel(latestCompensation.status)}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-border/70 bg-background/60 p-4 sm:col-span-2">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Notes</p>
                      <p className="mt-2 text-sm text-foreground">
                        {latestCompensation.note || "No compensation notes were added to this record."}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                    No compensation record is visible yet. Contact HR if you believe your salary details should already
                    be available in the employee portal.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <div>
                  <CardTitle>Latest paystub</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Use the latest paystub card for the most current payroll summary.
                  </p>
                </div>
                {latestPayslip ? (
                  <Button asChild variant="outline">
                    <Link href={`/account/employee/paystubs/${latestPayslip.id}`}>Open latest paystub</Link>
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent>
                {latestPayslip ? (
                  <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
                    <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className={profileTone(latestPayslip.payrollRun.status)}>
                          {toPlainLabel(latestPayslip.payrollRun.status)}
                        </Badge>
                        <Badge variant="outline">{toPlainLabel(latestPayslip.payrollRun.runType)}</Badge>
                      </div>
                      <p className="mt-3 text-lg font-semibold text-foreground">
                        {formatDateGH(latestPayslip.payrollRun.periodStart)} to {formatDateGH(latestPayslip.payrollRun.periodEnd)}
                      </p>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Gross pay</p>
                          <p className="mt-1 text-xl font-semibold text-foreground">
                            {formatCurrency(Number(latestPayslip.grossPay || 0))}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Net pay</p>
                          <p className="mt-1 text-xl font-semibold text-foreground">
                            {formatCurrency(Number(latestPayslip.netPay || 0))}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Button asChild>
                        <Link href={`/account/employee/paystubs/${latestPayslip.id}`}>View paystub</Link>
                      </Button>
                      <Button asChild variant="outline">
                        <a
                          href={`/api/account/employee/payslips/${latestPayslip.id}/pdf?sourcePage=${encodeURIComponent(EMPLOYEE_PORTAL_HOME_PAGE)}`}
                        >
                          Download PDF
                        </a>
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                    No payslip has been published to your portal yet. Your latest payroll statement will appear here
                    after HR finalizes a run for your profile.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border shadow-sm">
              <CardHeader>
                <CardTitle>Paystub history</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your paystub history is listed here in date order. The latest few open first, and you can expand the
                  full list when needed.
                </p>
                <div className="pt-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/${EMPLOYEE_PORTAL_PAYSTUBS_PAGE}`}>View all paystubs</Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {employee.payslips.length > 0 ? (
                  <EmployeePortalExpandableItems itemLabel="payslips" initialCount={4} step={4}>
                    {employee.payslips.map((payslip) => (
                      <div
                        key={payslip.id}
                        className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-background/60 p-4 md:flex-row md:items-center md:justify-between"
                      >
                        <div className="space-y-2">
                          <div className="flex flex-wrap gap-2">
                            <Badge className={profileTone(payslip.payrollRun.status)}>
                              {toPlainLabel(payslip.payrollRun.status)}
                            </Badge>
                            <Badge variant="outline">{toPlainLabel(payslip.payrollRun.runType)}</Badge>
                          </div>
                          <p className="font-semibold text-foreground">
                            {formatDateGH(payslip.payrollRun.periodStart)} to {formatDateGH(payslip.payrollRun.periodEnd)}
                          </p>
                          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
                            <span>Gross {formatCurrency(Number(payslip.grossPay || 0))}</span>
                            <span>Net {formatCurrency(Number(payslip.netPay || 0))}</span>
                            <span>Created {formatDateTimeGH(payslip.createdAt)}</span>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button asChild size="sm">
                            <Link href={`/account/employee/paystubs/${payslip.id}`}>View</Link>
                          </Button>
                          <Button asChild size="sm" variant="outline">
                            <a
                              href={`/api/account/employee/payslips/${payslip.id}/pdf?sourcePage=${encodeURIComponent(EMPLOYEE_PORTAL_HOME_PAGE)}`}
                            >
                              Download PDF
                            </a>
                          </Button>
                        </div>
                      </div>
                    ))}
                  </EmployeePortalExpandableItems>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                    Your paystub history will appear here after payroll is processed. Once you have more than one
                    published payslip, you can expand the full history from this section.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border shadow-sm">
              <CardHeader>
                <CardTitle>HR documents</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Only documents that HR has marked visible for your portal are shown here.
                </p>
                <div className="pt-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/${EMPLOYEE_PORTAL_DOCUMENTS_PAGE}`}>View all documents</Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {employee.documents.length > 0 ? (
                  <EmployeePortalExpandableItems itemLabel="documents" initialCount={4} step={4}>
                    {employee.documents.map((doc) => (
                      <div key={doc.id} className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-background/60 p-4">
                        <div>
                          <p className="font-semibold text-foreground">{doc.title}</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {doc.fileType || "Document"} | Uploaded {formatDateGH(doc.uploadedAt)}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {doc.acknowledged
                              ? `Acknowledged ${formatDateTimeGH(doc.acknowledgedAt || doc.uploadedAt)}`
                              : "Not acknowledged yet"}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {String(doc.fileType || "").toLowerCase().includes("pdf") ||
                          String(doc.fileType || "").toLowerCase().startsWith("image/") ? (
                            <Button asChild size="sm" variant="outline">
                              <a href={`/api/account/employee/documents/${doc.id}/preview`} target="_blank" rel="noreferrer">
                                Preview
                              </a>
                            </Button>
                          ) : null}
                          <Button asChild size="sm" variant="outline">
                            <a href={`/api/account/employee/documents/${doc.id}/download`}>Download document</a>
                          </Button>
                          <EmployeePortalAcknowledgeButton
                            path={`/api/account/employee/documents/${doc.id}/acknowledge`}
                            label="document"
                            acknowledged={Boolean(doc.acknowledged)}
                          />
                        </div>
                      </div>
                    ))}
                  </EmployeePortalExpandableItems>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                    No HR documents are currently available in your portal. HR can publish letters, forms, or other
                    employee-safe documents here when they are ready for you to download.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="space-y-8">
          <div id="leave-and-onboarding" className="space-y-4 scroll-mt-24">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">Leave and onboarding</h2>
              <p className="text-sm text-muted-foreground">
                Track leave balances, submit requests, and keep an eye on any onboarding items that are still visible.
              </p>
            </div>

            <EmployeeLeaveSection leaveSummary={leaveSummary} leaveRequests={employee.leaveRequests} />

            <div>
              <Button asChild size="sm" variant="outline">
                <Link href={`/${EMPLOYEE_PORTAL_LEAVE_PAGE}`}>View full leave history</Link>
              </Button>
            </div>

            <Card className="border shadow-sm">
              <CardHeader>
                <CardTitle>Onboarding checklist</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  The latest onboarding items show first. Expand the list if you need older entries.
                </p>
              </CardHeader>
              <CardContent>
                {employee.onboardingTasks.length > 0 ? (
                  <EmployeePortalExpandableItems itemLabel="tasks" initialCount={4} step={4}>
                    {employee.onboardingTasks.map((task) => (
                      <div key={task.id} className="rounded-2xl border border-border/70 bg-background/60 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge className={profileTone(task.status)}>{toPlainLabel(task.status)}</Badge>
                          {task.dueDate ? <Badge variant="outline">Due {formatDateGH(task.dueDate)}</Badge> : null}
                        </div>
                        <p className="mt-3 font-semibold text-foreground">{task.title}</p>
                        <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                          <span>Updated {formatDateTimeGH(task.updatedAt)}</span>
                          {task.completedAt ? <span>Completed {formatDateTimeGH(task.completedAt)}</span> : null}
                        </div>
                      </div>
                    ))}
                  </EmployeePortalExpandableItems>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                    No onboarding tasks are currently visible for your profile. If you expected onboarding actions,
                    contact HR to confirm whether they are still pending or already complete.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div id="reviews" className="space-y-4 scroll-mt-24">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">Reviews</h2>
              <p className="text-sm text-muted-foreground">
                Review summaries appear here only when leadership has chosen to publish them to the employee portal.
              </p>
            </div>

            <Card className="border shadow-sm">
              <CardHeader>
                <CardTitle>Performance review summaries</CardTitle>
                <div className="pt-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/${EMPLOYEE_PORTAL_REVIEWS_PAGE}`}>View all review summaries</Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {!reviewsFeatureEnabled ? (
                  <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                    Performance review summaries are currently hidden in the employee portal.
                  </div>
                ) : reviewsVisible && reviews.length > 0 ? (
                  <EmployeePortalExpandableItems itemLabel="reviews" initialCount={3} step={3}>
                    {reviews.map((review) => (
                      <div key={review.id} className="rounded-2xl border border-border/70 bg-background/60 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge className={profileTone(review.rating)}>{toPlainLabel(review.rating)}</Badge>
                          <Badge variant="outline">{toPlainLabel(review.workflowStatus)}</Badge>
                        </div>
                        <p className="mt-3 font-semibold text-foreground">
                          {formatDateGH(review.periodStart)} to {formatDateGH(review.periodEnd)}
                        </p>
                        <p className="mt-2 text-sm text-muted-foreground">{reviewSummaryFallback(review)}</p>
                        <p className="mt-3 text-xs text-muted-foreground">
                          Recorded {formatDateTimeGH(review.createdAt)}
                        </p>
                        <div className="mt-3">
                          <EmployeePortalAcknowledgeButton
                            path={`/api/account/employee/reviews/${review.id}/acknowledge`}
                            label="review"
                            acknowledged={Boolean(review.acknowledged)}
                          />
                        </div>
                      </div>
                    ))}
                  </EmployeePortalExpandableItems>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                    No employee-visible review summaries are available yet. Leadership can publish individual summaries
                    to the employee portal after they are ready to be shared.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link href={`/${EMPLOYEE_PORTAL_HOME_PAGE}`.replace("//", "/")}>Refresh portal</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/account">Return to account</Link>
        </Button>
      </div>
    </section>
  );
}
