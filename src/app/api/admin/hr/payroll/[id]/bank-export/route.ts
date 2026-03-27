import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { buildPayrollRunExportAuditMeta } from "@/lib/hr-payroll-report-utils";
import { summarizeMissingBankDetails } from "@/lib/hr-payslip-utils";
import {
  buildBankExportFileName,
  buildBankExportHeader,
  buildBankExportRows,
  isBankExportAllowedStatus,
} from "@/lib/hr-payroll-export-routes";

function toCsvRow(values: Array<string | number | null | undefined>) {
  return values
    .map((value) => {
      const raw = value === null || value === undefined ? "" : String(value);
      const escaped = raw.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(",");
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
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Payroll run id is required" }, { status: 400 });
  }
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const run = await prisma.payrollRun.findUnique({
    where: { id: resolvedParams.id },
    include: {
      payslips: {
        include: { employee: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!run) {
    return NextResponse.json({ error: "Payroll run not found" }, { status: 404 });
  }
  if (!isBankExportAllowedStatus(run.status)) {
    return NextResponse.json({ error: "Bank export is available after finalize or paid." }, { status: 400 });
  }

  const missingSummary = summarizeMissingBankDetails(run.payslips);
  if (missingSummary.count > 0) {
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "report.export.payroll.bank-csv",
        entityType: "PayrollRunReport",
        entityId: run.id,
        meta: {
          actor: buildAuditActor(user),
          sourcePage: "admin/hr/payroll/[id]",
          section: "run-exports",
          operation: "export_bank_csv",
          before: {
            runType: run.runType,
            status: run.status,
            periodStart: run.periodStart.toISOString().slice(0, 10),
            periodEnd: run.periodEnd.toISOString().slice(0, 10),
          },
          after: {
            missingBankDetailsCount: missingSummary.count,
            missingEmployees: missingSummary.entries,
          },
          status: "FAILED",
          resultSummary: `Bank CSV export blocked because ${missingSummary.count} employee(s) are missing export-required bank details.`,
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(
      {
        error: "Missing bank details for some employees.",
        missing: missingSummary.entries,
      },
      { status: 400 }
    );
  }

  const header = buildBankExportHeader();
  const rows = buildBankExportRows(run.id, run.payslips);

  const csv = [toCsvRow(header), ...rows.map(toCsvRow)].join("\n");
  const periodStart = run.periodStart.toISOString().slice(0, 10);
  const periodEnd = run.periodEnd.toISOString().slice(0, 10);
  const fileName = buildBankExportFileName(run.id, run.periodStart, run.periodEnd);
  const byteSize = Buffer.byteLength(csv, "utf8");
  try {
    await recordAuditLog({
      actorId: user.id,
      action: "report.export.payroll.bank-csv",
      entityType: "PayrollRunReport",
      entityId: run.id,
      meta: {
        actor: buildAuditActor(user),
        ...buildPayrollRunExportAuditMeta({
          format: "bank_csv",
          payrollRunId: run.id,
          runType: run.runType,
          runStatus: run.status,
          periodStart,
          periodEnd,
          fileName,
          rowCount: rows.length,
          columnCount: header.length,
          byteSize,
          missingBankDetailsCount: missingSummary.count,
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
