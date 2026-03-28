import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDateGH, formatDateTimeGH } from "@/lib/currency";
import {
  EMPLOYEE_PORTAL_HOME_PAGE,
  EMPLOYEE_PORTAL_PAYSTUBS_PAGE,
  getEmployeePortalData,
} from "@/lib/employee-portal";

export const dynamic = "force-dynamic";

function toPlainLabel(value: string | null | undefined) {
  const normalized = String(value || "").replace(/[._-]+/g, " ").trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase() : "";
}

export default async function EmployeePaystubHistoryPage() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/${EMPLOYEE_PORTAL_PAYSTUBS_PAGE}`)}`);
  }
  const portal = await getEmployeePortalData(user.id);
  if (!portal) {
    redirect(`/${EMPLOYEE_PORTAL_HOME_PAGE}`);
  }

  return (
    <section className="container mx-auto max-w-5xl px-4 py-8">
      <Card className="border shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>All paystubs</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Review every paystub that has been published to your employee portal.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href={`/${EMPLOYEE_PORTAL_HOME_PAGE}`}>Back to portal</Link>
          </Button>
        </CardHeader>
        <CardContent>
          {portal.employee.payslips.length > 0 ? (
            <div className="grid gap-3">
              {portal.employee.payslips.map((payslip) => (
                <div key={payslip.id} className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-background/60 p-4 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary">{toPlainLabel(payslip.payrollRun.status)}</Badge>
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
                      <a href={`/api/account/employee/payslips/${payslip.id}/pdf?sourcePage=${encodeURIComponent(EMPLOYEE_PORTAL_PAYSTUBS_PAGE)}`}>Download PDF</a>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              No paystubs are available yet. Payroll history will appear here after HR publishes your first payslip.
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
