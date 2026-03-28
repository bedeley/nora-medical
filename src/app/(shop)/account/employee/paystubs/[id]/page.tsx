import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateGH, formatDateTimeGH } from "@/lib/currency";
import {
  EMPLOYEE_PORTAL_HOME_PAGE,
  EMPLOYEE_PORTAL_PAYSTUB_PAGE,
  getEmployeePortalPaystubData,
} from "@/lib/employee-portal";
import {
  formatPaystubDateRange,
  getPaystubCurrentBreakdownRows,
  getPaystubRoleSummary,
  getPaystubYtdBreakdownRows,
  num,
} from "@/lib/hr-paystub-utils";
import { EmployeePaystubPrintButton } from "./EmployeePaystubPrintButton";

export const dynamic = "force-dynamic";

function toPlainLabel(value: string | null | undefined) {
  const normalized = String(value || "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency: "GHS",
    currencyDisplay: "symbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export default async function EmployeePaystubPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = await params;
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent("/account/employee")}`);
  }

  const payload = await getEmployeePortalPaystubData(user.id, resolvedParams.id);
  if (!payload) {
    return (
      <section className="container mx-auto max-w-4xl px-4 py-10">
        <Card className="border shadow-sm">
          <CardHeader>
            <CardTitle>Paystub not found</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This paystub is not available in your employee portal.
            </p>
            <Button asChild variant="outline">
              <Link href="/account/employee">Back to employee portal</Link>
            </Button>
          </CardContent>
        </Card>
      </section>
    );
  }

  const { payslip, ytdTotals } = payload;
  const currentRows = getPaystubCurrentBreakdownRows({
    grossPay: payslip.grossPay,
    netPay: payslip.netPay,
    lineItems: payslip.lineItems as Record<string, unknown> | null | undefined,
  });
  const ytdRows = getPaystubYtdBreakdownRows(ytdTotals);
  const periodLabel = formatPaystubDateRange(
    payslip.payrollRun.periodStart,
    payslip.payrollRun.periodEnd,
  );

  return (
    <section className="container mx-auto max-w-5xl px-4 py-8 print:px-0 print:py-0">
      <div className="mb-6 rounded-3xl border border-border/70 bg-gradient-to-br from-emerald-100/70 via-background to-sky-100/60 p-6 shadow-sm print:hidden dark:from-emerald-950/40 dark:via-card dark:to-sky-950/35">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{toPlainLabel(payslip.payrollRun.status) || "Recorded"}</Badge>
              <Badge variant="outline">{toPlainLabel(payslip.payrollRun.runType) || "Regular run"}</Badge>
            </div>
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.22em] text-muted-foreground">
                Employee paystub
              </p>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                {periodLabel}
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                View your payroll summary, download the PDF copy, or print this paystub.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
              <span>{`${payslip.employee.firstName} ${payslip.employee.lastName}`.trim()}</span>
              <span>{getPaystubRoleSummary(payslip.employee.position, payslip.employee.department)}</span>
              <span>{formatDateTimeGH(payslip.createdAt)}</span>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:w-[280px]">
            <Button asChild variant="outline" className="justify-start">
              <Link href="/account/employee">Back to portal</Link>
            </Button>
            <Button asChild className="justify-start">
              <a href={`/api/account/employee/payslips/${payslip.id}/pdf?sourcePage=${encodeURIComponent(EMPLOYEE_PORTAL_PAYSTUB_PAGE)}`}>Download PDF</a>
            </Button>
            <EmployeePaystubPrintButton payslipId={payslip.id} />
            <Button asChild variant="ghost" className="justify-start">
              <a
                href={`/api/account/employee/payslips/${payslip.id}/pdf?sourcePage=${encodeURIComponent(EMPLOYEE_PORTAL_PAYSTUB_PAGE)}`}
                target="_blank"
                rel="noreferrer"
              >
                Open PDF in new tab
              </a>
            </Button>
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Net pay</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">{formatMoney(num(payslip.netPay))}</p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Gross pay</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">{formatMoney(num(payslip.grossPay))}</p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Created</p>
            <p className="mt-2 text-sm font-semibold text-foreground">{formatDateTimeGH(payslip.createdAt)}</p>
          </div>
          <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Payroll run</p>
            <p className="mt-2 break-all text-sm font-semibold text-foreground">{payslip.payrollRun.id}</p>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-4xl rounded-3xl border border-border bg-card shadow-sm print:rounded-none print:border-0 print:shadow-none">
        <div className="border-b border-border px-6 py-6 print:px-0 print:pt-0">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Noralls Medical Supplies
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-foreground">Official paystub</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Paystub ID: <span className="font-medium text-foreground">{payslip.id}</span>
              </p>
            </div>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>Run status: <span className="font-medium text-foreground">{toPlainLabel(payslip.payrollRun.status)}</span></p>
              <p>Run type: <span className="font-medium text-foreground">{toPlainLabel(payslip.payrollRun.runType)}</span></p>
              <p>Created: <span className="font-medium text-foreground">{formatDateTimeGH(payslip.createdAt)}</span></p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 border-b border-border px-6 py-6 md:grid-cols-2 print:px-0">
          <div className="rounded-2xl border border-border/80 bg-background/50 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Employee</p>
            <p className="mt-2 text-lg font-semibold text-foreground">
              {`${payslip.employee.firstName} ${payslip.employee.lastName}`.trim()}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {getPaystubRoleSummary(payslip.employee.position, payslip.employee.department)}
            </p>
            {payslip.employee.email ? (
              <p className="mt-2 text-sm text-muted-foreground">{payslip.employee.email}</p>
            ) : null}
          </div>
          <div className="rounded-2xl border border-border/80 bg-background/50 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Payroll period</p>
            <p className="mt-2 text-lg font-semibold text-foreground">{periodLabel}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Start {formatDateGH(payslip.payrollRun.periodStart)} | End {formatDateGH(payslip.payrollRun.periodEnd)}
            </p>
            <p className="mt-2 break-all text-sm text-muted-foreground">
              Payroll run ID: <span className="font-medium text-foreground">{payslip.payrollRun.id}</span>
            </p>
          </div>
        </div>

        <div className="grid gap-6 px-6 py-6 md:grid-cols-2 print:px-0">
          <Card className="border-border/80 shadow-none">
            <CardHeader>
              <CardTitle>Current period</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {currentRows.map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-4 border-b border-border/70 pb-3 last:border-b-0 last:pb-0">
                  <span className="text-sm text-muted-foreground">{row.label}</span>
                  <span className="text-sm font-semibold text-foreground">{formatMoney(row.value)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card className="border-border/80 shadow-none">
            <CardHeader>
              <CardTitle>Year to date</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {ytdRows.map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-4 border-b border-border/70 pb-3 last:border-b-0 last:pb-0">
                  <span className="text-sm text-muted-foreground">{row.label}</span>
                  <span className="text-sm font-semibold text-foreground">{formatMoney(row.value)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="border-t border-border px-6 py-4 text-sm text-muted-foreground print:px-0">
          This paystub is confidential and intended for the employee named above.
        </div>
      </div>

      <div className="mt-6 print:hidden">
        <Button asChild variant="ghost">
          <Link href={EMPLOYEE_PORTAL_HOME_PAGE.startsWith("/") ? EMPLOYEE_PORTAL_HOME_PAGE : `/${EMPLOYEE_PORTAL_HOME_PAGE}`}>
            Return to employee portal
          </Link>
        </Button>
      </div>
    </section>
  );
}
