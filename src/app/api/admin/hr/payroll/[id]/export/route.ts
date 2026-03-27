import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { buildPayrollRunExportAuditMeta } from "@/lib/hr-payroll-report-utils";
import { buildPayrollExportFileName, buildPayrollExportRows } from "@/lib/hr-payroll-export-routes";

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

function toCsv(rows: string[][]) {
  return rows
    .map((row) =>
      row
        .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
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

  const rows = buildPayrollExportRows(run.payslips);

  const csv = toCsv(rows);
  const periodStart = run.periodStart.toISOString().slice(0, 10);
  const periodEnd = run.periodEnd.toISOString().slice(0, 10);
  const fileName = buildPayrollExportFileName(run.id, run.periodStart, run.periodEnd);
  const byteSize = Buffer.byteLength(csv, "utf8");
  try {
    await recordAuditLog({
      actorId: user.id,
      action: "report.export.payroll.csv",
      entityType: "PayrollRunReport",
      entityId: run.id,
      meta: {
        actor: buildAuditActor(user),
        ...buildPayrollRunExportAuditMeta({
          format: "csv",
          payrollRunId: run.id,
          runType: run.runType,
          runStatus: run.status,
          periodStart,
          periodEnd,
          fileName,
          rowCount: rows.length - 1,
          columnCount: rows[0].length,
          byteSize,
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
