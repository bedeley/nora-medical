import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import {
  buildCompensationWhereClause,
  normalizeCompensationQueryState,
} from "@/lib/hr-compensation-utils";

const MAX_EXPORT_ROWS = 5000;

function escapeCsv(value: string) {
  if (!value) return "";
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const queryState = normalizeCompensationQueryState(searchParams);
  const where = buildCompensationWhereClause(queryState);

  const rows = await prisma.compensation.findMany({
    where,
    orderBy: [{ status: "asc" }, { effectiveDate: "desc" }],
    take: MAX_EXPORT_ROWS,
    select: {
      id: true,
      status: true,
      effectiveDate: true,
      currency: true,
      baseSalary: true,
      allowances: true,
      deductions: true,
      bonus: true,
      employee: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  });

  const header = [
    "Employee ID",
    "Employee Name",
    "Employee Email",
    "Status",
    "Effective Date",
    "Currency",
    "Base Salary",
    "Allowances",
    "Deductions",
    "Bonus",
  ];
  const csvRows = rows.map((row) => [
    row.employee.id,
    `${row.employee.firstName} ${row.employee.lastName}`.trim(),
    row.employee.email || "",
    row.status,
    row.effectiveDate ? row.effectiveDate.toISOString().slice(0, 10) : "",
    row.currency || "GHS",
    Number(row.baseSalary || 0).toFixed(2),
    Number(row.allowances || 0).toFixed(2),
    Number(row.deductions || 0).toFixed(2),
    Number(row.bonus || 0).toFixed(2),
  ]);
  const csv = [header, ...csvRows]
    .map((line) => line.map((v) => escapeCsv(String(v))).join(","))
    .join("\n");

  const datePart = new Date().toISOString().slice(0, 10);
  const filename = `compensation-${queryState.status.toLowerCase()}-${datePart}.csv`;
  const byteSize = Buffer.byteLength(csv, "utf8");

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "report.export.hr-compensation.csv",
      entityType: "HRCompensationReport",
      entityId: "compensation",
      meta: {
        sourcePage: "admin/hr/compensation",
        section: "compensation-records",
        operation: "export_csv",
        before: {
          employeeId: queryState.employeeId,
          statusFilter: queryState.status,
          search: queryState.search,
        },
        after: {
          fileName: filename,
          rowCount: csvRows.length,
          columnCount: header.length,
          byteSize,
        },
        exportLabel: "HR compensation CSV",
        status: "SUCCESS",
        resultSummary: "Compensation CSV export completed successfully.",
      },
    });
  } catch {
    // best-effort
  }

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
