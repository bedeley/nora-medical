import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";

const MAX_EXPORT_ROWS = 5000;

function escapeCsv(value: string) {
  if (!value) return "";
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, "\"\"")}"`;
  return value;
}

function timestampLabel() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function buildMissingProfileWhere(): Prisma.EmployeeWhereInput {
  return {
    OR: [
      { email: null },
      { email: "" },
      { phone: null },
      { phone: "" },
      { department: null },
      { department: "" },
      { position: null },
      { position: "" },
      { hireDate: null },
    ],
  };
}

function buildDepartmentClause(departmentRaw: string): Prisma.EmployeeWhereInput | undefined {
  if (departmentRaw === "__MISSING__") {
    return {
      OR: [{ department: null }, { department: "" }],
    };
  }
  if (departmentRaw) return { department: departmentRaw };
  return undefined;
}

function buildSearchClause(q: string): Prisma.EmployeeWhereInput | undefined {
  if (!q) return undefined;
  return {
    OR: [
      { firstName: { contains: q, mode: "insensitive" as const } },
      { lastName: { contains: q, mode: "insensitive" as const } },
      { email: { contains: q, mode: "insensitive" as const } },
      { phone: { contains: q, mode: "insensitive" as const } },
    ],
  };
}

function buildScopeSnapshot(params: {
  q: string;
  status: string;
  departmentRaw: string;
  role: string;
  completeness: string;
}) {
  const parts: string[] = [];
  if (params.q) parts.push(`search=${params.q}`);
  if (params.status) parts.push(`status=${params.status}`);
  if (params.departmentRaw) parts.push(`department=${params.departmentRaw}`);
  if (params.role) parts.push(`role=${params.role}`);
  if (params.completeness) parts.push(`completeness=${params.completeness}`);
  return parts.length > 0 ? parts.join("; ") : "All staff (no filters)";
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
  const q = String(searchParams.get("q") || "").trim();
  const statusRaw = String(searchParams.get("status") || "").trim().toUpperCase();
  const departmentRaw = String(searchParams.get("department") || "").trim();
  const roleRaw = String(searchParams.get("role") || "").trim().toUpperCase();
  const completenessRaw = String(searchParams.get("completeness") || "").trim().toLowerCase();

  const allowedStatuses = new Set(["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"]);
  const allowedRoles = new Set(["ADMIN", "STAFF", "ACCOUNTANT"]);
  const status = allowedStatuses.has(statusRaw) ? statusRaw : "";
  const role = allowedRoles.has(roleRaw) ? roleRaw : "";
  const completeness = completenessRaw === "complete" || completenessRaw === "missing" ? completenessRaw : "";
  const missingProfileWhere = buildMissingProfileWhere();
  const whereClauses: Prisma.EmployeeWhereInput[] = [];
  const departmentClause = buildDepartmentClause(departmentRaw);
  const searchClause = buildSearchClause(q);
  if (status) {
    whereClauses.push({
      status: status as "ACTIVE" | "ON_LEAVE" | "SUSPENDED" | "TERMINATED",
    });
  }
  if (departmentClause) whereClauses.push(departmentClause);
  if (role) whereClauses.push({ user: { role: role as "ADMIN" | "STAFF" | "ACCOUNTANT" } });
  if (searchClause) whereClauses.push(searchClause);
  if (completeness === "missing") whereClauses.push(missingProfileWhere);
  if (completeness === "complete") whereClauses.push({ NOT: missingProfileWhere });
  const where: Prisma.EmployeeWhereInput = whereClauses.length > 0 ? { AND: whereClauses } : {};

  const [filteredRows, totalMatches] = await Promise.all([
    prisma.employee.findMany({
      where,
      include: {
        user: {
          select: { role: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_EXPORT_ROWS,
    }),
    prisma.employee.count({ where }),
  ]);
  const truncated = totalMatches > filteredRows.length;

  const header = [
    "id",
    "firstName",
    "lastName",
    "email",
    "phone",
    "department",
    "position",
    "status",
    "role",
    "hireDate",
    "terminationDate",
  ];
  const csvRows = filteredRows.map((row) => [
    row.id,
    row.firstName,
    row.lastName,
    row.email || "",
    row.phone || "",
    row.department || "",
    row.position || "",
    row.status,
    row.user?.role || "",
    row.hireDate ? row.hireDate.toISOString() : "",
    row.terminationDate ? row.terminationDate.toISOString() : "",
  ]);
  const csv = [header, ...csvRows]
    .map((line) => line.map((value) => escapeCsv(String(value))).join(","))
    .join("\n");
  const fileName = `hr-staff-${timestampLabel()}.csv`;
  const byteSize = Buffer.byteLength(csv, "utf8");
  const scopeSnapshot = buildScopeSnapshot({ q, status, departmentRaw, role, completeness });

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_STAFF_EXPORT_CSV",
      entityType: "EMPLOYEE",
      entityId: "staff_export",
      meta: {
        actor: { id: user.id, role: user.role },
        sourcePage: "admin/hr/staff",
        section: "staff-export",
        operation: "export_staff_csv",
        fileName,
        format: "csv",
        rowCount: csvRows.length,
        columnCount: header.length,
        byteSize,
        scopeSnapshot,
        before: {
          q: q || null,
          status: status || null,
          department: departmentRaw || null,
          role: role || null,
          completeness: completeness || null,
        },
        after: {
          fileName,
          rowCount: csvRows.length,
          columnCount: header.length,
          byteSize,
          totalMatches,
          truncated,
        },
        status: "SUCCESS",
        resultSummary: truncated
          ? "Staff CSV export completed with truncation at max export row limit."
          : "Staff CSV export completed from staff directory.",
      },
    });
  } catch {
    // best-effort
  }

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "X-Export-Truncated": truncated ? "1" : "0",
      "X-Export-Total-Matches": String(totalMatches),
      "X-Export-Max-Rows": String(MAX_EXPORT_ROWS),
    },
  });
}
