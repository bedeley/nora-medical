import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { getPaystubDetailData } from "@/lib/hr-paystub-detail";
import { buildPaystubActionAuditMeta } from "@/lib/hr-paystub-utils";
import { assertSameOrigin } from "@/lib/origin";

function buildAuditActor(user: AuthenticatedUser) {
  return {
    id: user.id,
    name: user.name || null,
    email: user.email || null,
    role: user.role,
  };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Payslip id is required" }, { status: 400 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const payload = await getPaystubDetailData(resolvedParams.id);
  if (!payload) {
    return NextResponse.json({ error: "Paystub not found" }, { status: 404 });
  }

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "PAYSLIP_PRINT",
      entityType: "PAYSLIP",
      entityId: payload.payslip.id,
      meta: buildPaystubActionAuditMeta({
        actor: buildAuditActor(user),
        payslip: {
          id: payload.payslip.id,
          employeeId: payload.payslip.employeeId,
          payrollRunId: payload.payslip.payrollRunId,
          employee: payload.payslip.employee,
          payrollRun: payload.payslip.payrollRun,
        },
        operation: "print_paystub",
        after: {
          delivery: "print",
        },
        resultSummary: "Paystub print opened successfully.",
      }),
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ ok: true });
}
