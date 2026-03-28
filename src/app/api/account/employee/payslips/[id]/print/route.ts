import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { buildPaystubActionAuditMeta } from "@/lib/hr-paystub-utils";
import {
  EMPLOYEE_PORTAL_PAYSTUB_PAGE,
  getEmployeePortalPaystubData,
} from "@/lib/employee-portal";
import { assertSameOrigin } from "@/lib/origin";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Payslip id is required." }, { status: 400 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const payload = await getEmployeePortalPaystubData(user.id, resolvedParams.id);
  if (!payload) {
    return NextResponse.json({ error: "Paystub not found." }, { status: 404 });
  }

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "PAYSLIP_PRINT",
      entityType: "PAYSLIP",
      entityId: payload.payslip.id,
      meta: {
        page: EMPLOYEE_PORTAL_PAYSTUB_PAGE,
        ...buildPaystubActionAuditMeta({
          actor: {
            id: user.id,
            name: user.name || null,
            email: user.email || null,
            role: user.role,
          },
          payslip: {
            id: payload.payslip.id,
            employeeId: payload.payslip.employeeId,
            payrollRunId: payload.payslip.payrollRunId,
            employee: payload.payslip.employee,
            payrollRun: payload.payslip.payrollRun,
          },
          sourcePage: EMPLOYEE_PORTAL_PAYSTUB_PAGE,
          section: "employee-portal-paystub",
          operation: "print_paystub",
          after: {
            delivery: "print",
          },
          resultSummary: "Employee paystub print opened successfully.",
        }),
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ ok: true });
}
