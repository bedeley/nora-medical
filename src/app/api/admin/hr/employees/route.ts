import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const employeeSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().min(5).optional().or(z.literal("")),
  department: z.string().optional().or(z.literal("")),
  position: z.string().optional().or(z.literal("")),
  status: z.enum(["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"]).optional(),
  hireDate: z.string().optional().or(z.literal("")),
  managerId: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
  bankName: z.string().optional().or(z.literal("")),
  bankAccountName: z.string().optional().or(z.literal("")),
  bankAccountNumber: z.string().optional().or(z.literal("")),
  bankCode: z.string().optional().or(z.literal("")),
  bankBranch: z.string().optional().or(z.literal("")),
});

function normalizeOptional(value?: string) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const defaultOnboardingTasks = [
  "Signed offer letter",
  "Bank details collected",
  "Tax ID verified",
  "Compensation set",
  "Pension enrollment",
  "Orientation completed",
];

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
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

function buildMissingBankWhere(): Prisma.EmployeeWhereInput {
  return {
    OR: [
      { bankName: null },
      { bankName: "" },
      { bankAccountName: null },
      { bankAccountName: "" },
      { bankAccountNumber: null },
      { bankAccountNumber: "" },
      { bankCode: null },
      { bankCode: "" },
      { bankBranch: null },
      { bankBranch: "" },
    ],
  };
}

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() || "";
  const statusRaw = searchParams.get("status")?.trim() || "";
  const departmentRaw = searchParams.get("department")?.trim() || "";
  const roleRaw = searchParams.get("role")?.trim().toUpperCase() || "";
  const accountLinkRaw = searchParams.get("accountLink")?.trim().toLowerCase() || "";
  const completenessRaw = searchParams.get("completeness")?.trim().toLowerCase() || "";
  const sortRaw = searchParams.get("sort")?.trim().toLowerCase() || "recent";
  const pageRaw = Number(searchParams.get("page") || "1");
  const pageSizeRaw = Number(searchParams.get("pageSize") || "25");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(100, Math.max(10, Math.trunc(pageSizeRaw)))
      : 25;
  const skip = (page - 1) * pageSize;
  const allowedStatuses = new Set(["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"]);
  const allowedRoles = new Set(["ADMIN", "STAFF", "ACCOUNTANT"]);
  const status = allowedStatuses.has(statusRaw) ? statusRaw : "";
  const role = allowedRoles.has(roleRaw) ? roleRaw : "";
  const accountLink = accountLinkRaw === "linked" || accountLinkRaw === "unlinked" ? accountLinkRaw : "";
  const completeness = completenessRaw === "complete" || completenessRaw === "missing" ? completenessRaw : "";

  const baseClauses: Prisma.EmployeeWhereInput[] = [];
  const departmentFilter = buildDepartmentClause(departmentRaw);
  const searchClause = buildSearchClause(q);
  if (departmentFilter) baseClauses.push(departmentFilter);
  if (accountLink === "linked") baseClauses.push({ userId: { not: null } });
  if (accountLink === "unlinked") baseClauses.push({ userId: null });
  if (role) {
    baseClauses.push({
      user: {
        role: role as "ADMIN" | "STAFF" | "ACCOUNTANT",
      },
    });
  }
  if (searchClause) baseClauses.push(searchClause);
  const baseWhere: Prisma.EmployeeWhereInput = baseClauses.length > 0 ? { AND: baseClauses } : {};

  const missingProfileWhere = buildMissingProfileWhere();
  const missingBankWhere = buildMissingBankWhere();
  const whereClauses: Prisma.EmployeeWhereInput[] = [...baseClauses];
  if (status) {
    whereClauses.push({
      status: status as "ACTIVE" | "ON_LEAVE" | "SUSPENDED" | "TERMINATED",
    });
  }
  if (completeness === "missing") whereClauses.push(missingProfileWhere);
  if (completeness === "complete") whereClauses.push({ NOT: missingProfileWhere });
  const where: Prisma.EmployeeWhereInput = whereClauses.length > 0 ? { AND: whereClauses } : {};

  const orderBy =
    sortRaw === "name_asc"
      ? [{ firstName: "asc" as const }, { lastName: "asc" as const }]
      : sortRaw === "name_desc"
        ? [{ firstName: "desc" as const }, { lastName: "desc" as const }]
        : [{ createdAt: "desc" as const }];

  const [employees, total, departmentRows, totalAll, activeCount, onLeaveCount, suspendedCount, terminatedCount, missingCount, linkedCount, missingBankCount] =
    await Promise.all([
      prisma.employee.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              role: true,
            },
          },
        },
        orderBy,
        skip,
        take: pageSize,
      }),
      prisma.employee.count({ where }),
      prisma.employee.findMany({
        where: baseWhere,
        select: { department: true },
        distinct: ["department"],
        orderBy: { department: "asc" },
      }),
      prisma.employee.count({ where: baseWhere }),
      prisma.employee.count({
        where: { AND: [...baseClauses, { status: "ACTIVE" }] },
      }),
      prisma.employee.count({
        where: { AND: [...baseClauses, { status: "ON_LEAVE" }] },
      }),
      prisma.employee.count({
        where: { AND: [...baseClauses, { status: "SUSPENDED" }] },
      }),
      prisma.employee.count({
        where: { AND: [...baseClauses, { status: "TERMINATED" }] },
      }),
      prisma.employee.count({
        where: { AND: [...baseClauses, missingProfileWhere] },
      }),
      prisma.employee.count({
        where: { AND: [...baseClauses, { userId: { not: null } }] },
      }),
      prisma.employee.count({
        where: { AND: [...baseClauses, missingBankWhere] },
      }),
    ]);

  return NextResponse.json({
    rows: employees,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    departmentOptions: departmentRows
      .map((row) => row.department)
      .filter((value): value is string => Boolean(value && value.trim())),
    summary: {
      total: totalAll,
      active: activeCount,
      onLeave: onLeaveCount,
      suspended: suspendedCount,
      terminated: terminatedCount,
      missingProfile: missingCount,
      missingBankDetails: missingBankCount,
      linkedAccount: linkedCount,
      unlinkedAccount: Math.max(0, totalAll - linkedCount),
    },
  });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = employeeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const hireDate = normalizeOptional(parsed.data.hireDate);

  try {
    const employee = await prisma.employee.create({
      data: {
        firstName: parsed.data.firstName.trim(),
        lastName: parsed.data.lastName.trim(),
        email: normalizeOptional(parsed.data.email),
        phone: normalizeOptional(parsed.data.phone),
        department: normalizeOptional(parsed.data.department),
        position: normalizeOptional(parsed.data.position),
        status: parsed.data.status ?? "ACTIVE",
        hireDate: hireDate ? new Date(hireDate) : null,
        managerId: normalizeOptional(parsed.data.managerId),
        notes: normalizeOptional(parsed.data.notes),
        bankName: normalizeOptional(parsed.data.bankName),
        bankAccountName: normalizeOptional(parsed.data.bankAccountName),
        bankAccountNumber: normalizeOptional(parsed.data.bankAccountNumber),
        bankCode: normalizeOptional(parsed.data.bankCode),
        bankBranch: normalizeOptional(parsed.data.bankBranch),
      },
    });
    await prisma.onboardingTask.createMany({
      data: defaultOnboardingTasks.map((title) => ({
        employeeId: employee.id,
        title,
      })),
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_EMPLOYEE_CREATE",
        entityType: "EMPLOYEE",
        entityId: employee.id,
        meta: {
          actor: { id: user.id, role: user.role },
          sourcePage: "admin/hr/staff",
          section: "employee-create",
          operation: "create_employee",
          before: null,
          after: {
            firstName: employee.firstName,
            lastName: employee.lastName,
            email: employee.email,
            phone: employee.phone,
            department: employee.department,
            position: employee.position,
            status: employee.status,
          },
          status: employee.status,
          department: employee.department,
          position: employee.position,
          resultSummary: "Employee created successfully.",
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(employee);
  } catch (err) {
    console.error("Error creating employee:", err);
    return NextResponse.json({ error: "Failed to create employee" }, { status: 500 });
  }
}
