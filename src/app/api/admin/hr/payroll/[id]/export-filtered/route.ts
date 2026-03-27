import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import {
  buildPayrollExportFileName,
  filterAndSortPayrollPayslips,
  normalizePayrollPayslipSort,
} from "@/lib/hr-payroll-export-routes";
import { buildPayrollFilteredExportAuditMeta } from "@/lib/hr-payroll-report-utils";
import { getPayrollRunYtdTotalsForEmployees } from "@/lib/hr-paystub-detail";

function toCsv(rows: Array<Array<string | number>>) {
  return rows
    .map((row) =>
      row
        .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
        .join(","),
    )
    .join("\n");
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

function buildAuditActor(user: AuthenticatedUser) {
  return {
    id: user.id,
    name: user.name || null,
    email: user.email || null,
    role: user.role,
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Payroll run id is required" }, { status: 400 });
  }
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const run = await prisma.payrollRun.findUnique({
    where: { id: resolvedParams.id },
    include: { payslips: { include: { employee: true } } },
  });
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(req.url);
  const q = String(url.searchParams.get("q") || "").trim();
  const sort = normalizePayrollPayslipSort(url.searchParams.get("sort"));

  const filteredPayslips = filterAndSortPayrollPayslips(run.payslips, q, sort);
  const ytdTotals = await getPayrollRunYtdTotalsForEmployees({
    employeeIds: run.payslips.map((slip) => slip.employeeId),
    payrollRunId: run.id,
    periodEnd: run.periodEnd || new Date(),
  });

  const rows: Array<Array<string | number>> = [
    [
      "Employee",
      "Current Gross",
      "Current Net",
      "Current Tax",
      "Current Pension",
      "YTD Gross",
      "YTD Net",
      "YTD Tax",
      "YTD Pension",
      "Employee Id",
    ],
    ...filteredPayslips.map((slip) => [
      `${slip.employee.firstName} ${slip.employee.lastName}`,
      Number(slip.grossPay || 0).toFixed(2),
      Number(slip.netPay || 0).toFixed(2),
      Number((slip.lineItems as Record<string, unknown> | null | undefined)?.tax ?? 0).toFixed(2),
      Number((slip.lineItems as Record<string, unknown> | null | undefined)?.pension ?? 0).toFixed(2),
      Number(ytdTotals[slip.employeeId]?.gross || 0).toFixed(2),
      Number(ytdTotals[slip.employeeId]?.net || 0).toFixed(2),
      Number(ytdTotals[slip.employeeId]?.tax || 0).toFixed(2),
      Number(ytdTotals[slip.employeeId]?.pension || 0).toFixed(2),
      slip.employeeId,
    ]),
  ];

  const csv = toCsv(rows);
  const fileName = buildPayrollExportFileName(run.id, run.periodStart, run.periodEnd).replace(
    "payroll-",
    "payroll-filtered-",
  );
  const byteSize = Buffer.byteLength(csv, "utf8");

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "report.export.payroll.filtered.csv",
      entityType: "PayrollRunReport",
      entityId: run.id,
      meta: {
        actor: buildAuditActor(user),
        ...buildPayrollFilteredExportAuditMeta({
          payrollRunId: run.id,
          runType: run.runType,
          runStatus: run.status,
          periodStart: run.periodStart.toISOString().slice(0, 10),
          periodEnd: run.periodEnd.toISOString().slice(0, 10),
          fileName,
          rowCount: Math.max(0, rows.length - 1),
          columnCount: rows[0]?.length || 0,
          byteSize,
          search: q || null,
          sort,
          totalPayslips: run.payslips.length,
        }),
      },
    });
  } catch {
    // best-effort
  }

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
