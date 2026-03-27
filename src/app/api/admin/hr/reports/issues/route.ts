import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";

function toCsv(rows: string[][]) {
  return rows
    .map((row) =>
      row
        .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
        .join(",")
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

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const statusRaw = searchParams.get("status")?.trim().toUpperCase() || "";
  const employeeId = searchParams.get("employeeId")?.trim() || "";
  const q = searchParams.get("q")?.trim() || "";
  const severityRaw = searchParams.get("severity")?.trim().toUpperCase() || "";
  const fromRaw = searchParams.get("from")?.trim() || "";
  const toRaw = searchParams.get("to")?.trim() || "";
  const sortRaw = (searchParams.get("sort")?.trim() || "createdAt_desc").toLowerCase();

  const allowedStatuses = new Set(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]);
  const status = allowedStatuses.has(statusRaw) ? statusRaw : "";
  const allowedSeverities = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
  const severity = allowedSeverities.has(severityRaw) ? severityRaw : "";
  const fromDate = fromRaw ? new Date(fromRaw) : null;
  const toDate = toRaw ? new Date(toRaw) : null;
  if (fromRaw && (!fromDate || Number.isNaN(fromDate.getTime()))) {
    return NextResponse.json({ error: "Invalid from date." }, { status: 400 });
  }
  if (toRaw && (!toDate || Number.isNaN(toDate.getTime()))) {
    return NextResponse.json({ error: "Invalid to date." }, { status: 400 });
  }
  if (fromDate && toDate && toDate.getTime() < fromDate.getTime()) {
    return NextResponse.json({ error: "To date must be on or after from date." }, { status: 400 });
  }

  const allowedSorts = new Set([
    "createdat_desc",
    "createdat_asc",
    "severity_desc",
    "severity_asc",
    "status_asc",
    "status_desc",
  ]);
  const sort = allowedSorts.has(sortRaw) ? sortRaw : "createdat_desc";
  const orderBy =
    sort === "createdat_asc"
      ? { createdAt: "asc" as const }
      : sort === "severity_desc"
        ? { severity: "desc" as const }
        : sort === "severity_asc"
          ? { severity: "asc" as const }
          : sort === "status_asc"
            ? { status: "asc" as const }
            : sort === "status_desc"
              ? { status: "desc" as const }
              : { createdAt: "desc" as const };

  const where = {
    ...(status ? { status: status as "OPEN" } : {}),
    ...(employeeId ? { employeeId } : {}),
    ...(severity ? { severity: severity as "LOW" } : {}),
    ...(fromDate || toDate
      ? {
          createdAt: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate
              ? {
                  lte: new Date(
                    Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate(), 23, 59, 59, 999),
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { type: { contains: q, mode: "insensitive" as const } },
            { description: { contains: q, mode: "insensitive" as const } },
            { resolution: { contains: q, mode: "insensitive" as const } },
            { employee: { is: { firstName: { contains: q, mode: "insensitive" as const } } } },
            { employee: { is: { lastName: { contains: q, mode: "insensitive" as const } } } },
          ],
        }
      : {}),
  };

  const issues = await prisma.staffIssue.findMany({
    where,
    include: { employee: true },
    orderBy,
  });

  const rows = [
    ["IssueId", "Employee", "Type", "Severity", "Status", "OpenedAt", "ClosedAt"],
    ...issues.map((issue) => [
      issue.id,
      `${issue.employee.firstName} ${issue.employee.lastName}`,
      issue.type,
      issue.severity,
      issue.status,
      issue.createdAt.toISOString().slice(0, 10),
      issue.closedAt ? issue.closedAt.toISOString().slice(0, 10) : "",
    ]),
  ];

  const csv = toCsv(rows);
  const fileName = `hr_issues_${Date.now()}.csv`;
  try {
    await recordAuditLog({
      actorId: user.id,
      action: "report.export.hr-issues.csv",
      entityType: "STAFF_ISSUE",
      entityId: "HR_ISSUES_EXPORT",
      meta: {
        sourcePage: "admin/hr/issues",
        section: "issue-export",
        operation: "export_issues_csv",
        before: {
          statusFilter: status || "ALL",
          employeeId: employeeId || null,
          severityFilter: severity || "ALL",
          q: q || null,
          from: fromRaw || null,
          to: toRaw || null,
          sort,
        },
        after: {
          rowCount: Math.max(0, rows.length - 1),
          columnCount: rows[0]?.length || 0,
        },
        fileName,
        format: "csv",
        status: "SUCCESS",
        resultSummary: "HR issues CSV exported successfully.",
      },
    });
  } catch {
    // best-effort
  }

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=${fileName}`,
    },
  });
}
