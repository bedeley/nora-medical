import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { validateExpectedUpdatedAt } from "@/lib/hr-staff-profile-utils";

const payloadSchema = z.object({
  status: z.enum(["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"]),
  scope: z.enum(["selected", "all_filtered"]).default("selected"),
  ids: z.array(z.string()).optional(),
  expected: z
    .array(
      z.object({
        id: z.string(),
        expectedUpdatedAt: z.string().optional().or(z.literal("")),
        beforeStatus: z.enum(["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"]).optional(),
      }),
    )
    .optional(),
  q: z.string().optional().or(z.literal("")),
  statusFilter: z.string().optional().or(z.literal("")),
  department: z.string().optional().or(z.literal("")),
  role: z.string().optional().or(z.literal("")),
  accountLink: z.string().optional().or(z.literal("")),
  completeness: z.string().optional().or(z.literal("")),
  sourcePage: z.string().optional().or(z.literal("")),
  section: z.string().optional().or(z.literal("")),
  operation: z.string().optional().or(z.literal("")),
  resultSummary: z.string().optional().or(z.literal("")),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

function buildMissingProfileWhere() {
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

function buildFilteredWhere(input: {
  q: string;
  statusFilter: string;
  department: string;
  role: string;
  accountLink: string;
  completeness: string;
}): Prisma.EmployeeWhereInput {
  const statusRaw = input.statusFilter.trim().toUpperCase();
  const roleRaw = input.role.trim().toUpperCase();
  const allowedStatuses = new Set(["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"]);
  const allowedRoles = new Set(["ADMIN", "STAFF", "ACCOUNTANT"]);
  const status = allowedStatuses.has(statusRaw) ? statusRaw : "";
  const role = allowedRoles.has(roleRaw) ? roleRaw : "";
  const accountLinkRaw = input.accountLink.trim().toLowerCase();
  const accountLink = accountLinkRaw === "linked" || accountLinkRaw === "unlinked" ? accountLinkRaw : "";
  const q = input.q.trim();
  const department = input.department.trim();
  const completeness = input.completeness.trim().toLowerCase();
  const missingWhere = buildMissingProfileWhere();

  const clauses: Prisma.EmployeeWhereInput[] = [];
  if (status) {
    clauses.push({
      status: status as "ACTIVE" | "ON_LEAVE" | "SUSPENDED" | "TERMINATED",
    });
  }
  if (department === "__MISSING__") {
    clauses.push({
      OR: [{ department: null }, { department: "" }],
    });
  } else if (department) {
    clauses.push({ department });
  }
  if (role) {
    clauses.push({
      user: {
        role: role as "ADMIN" | "STAFF" | "ACCOUNTANT",
      },
    });
  }
  if (accountLink === "linked") {
    clauses.push({ userId: { not: null } });
  }
  if (accountLink === "unlinked") {
    clauses.push({ userId: null });
  }
  if (q) {
    clauses.push({
      OR: [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  if (completeness === "missing") clauses.push(missingWhere);
  if (completeness === "complete") clauses.push({ NOT: missingWhere });
  return clauses.length > 0 ? { AND: clauses } : {};
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const sourcePage = parsed.data.sourcePage?.trim() || "admin/hr/staff";
  const section = parsed.data.section?.trim() || "bulk-status";
  const operation = parsed.data.operation?.trim() || "bulk_update_employee_status";
  const inputSummary = parsed.data.resultSummary?.trim();
  const nextStatus = parsed.data.status;
  const scope = parsed.data.scope;

  let targetRows: Array<{
    id: string;
    status: string;
    updatedAt: Date;
    firstName: string;
    lastName: string;
  }> = [];
  if (scope === "selected") {
    const ids = (parsed.data.ids || []).filter(Boolean);
    if (ids.length === 0) {
      return NextResponse.json({ error: "No employee selected." }, { status: 400 });
    }
    targetRows = await prisma.employee.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, updatedAt: true, firstName: true, lastName: true },
    });
  } else {
    const where = buildFilteredWhere({
      q: parsed.data.q || "",
      statusFilter: parsed.data.statusFilter || "",
      department: parsed.data.department || "",
      role: parsed.data.role || "",
      accountLink: parsed.data.accountLink || "",
      completeness: parsed.data.completeness || "",
    });
    targetRows = await prisma.employee.findMany({
      where,
      select: { id: true, status: true, updatedAt: true, firstName: true, lastName: true },
      take: 1000,
    });
  }

  if (targetRows.length === 0) {
    return NextResponse.json({ error: "No matching employees found." }, { status: 400 });
  }

  const expectedMap = new Map((parsed.data.expected || []).map((item) => [item.id, item.expectedUpdatedAt || ""]));
  let successCount = 0;
  let conflictCount = 0;
  let failedCount = 0;
  const beforeCounts: Record<string, number> = {};
  const perEmployeeSuccessLogs: Array<{
    employeeId: string;
    firstName: string;
    lastName: string;
    beforeStatus: string;
    afterStatus: string;
  }> = [];

  for (const row of targetRows) {
    beforeCounts[row.status] = (beforeCounts[row.status] || 0) + 1;
    if (scope === "selected") {
      const check = validateExpectedUpdatedAt(row.updatedAt, expectedMap.get(row.id));
      if (!check.ok) {
        if (check.status === 409) {
          conflictCount += 1;
          continue;
        }
        failedCount += 1;
        continue;
      }
    }
    try {
      await prisma.employee.update({
        where: { id: row.id },
        data: {
          status: nextStatus,
          terminationDate: nextStatus === "TERMINATED" ? new Date() : null,
        },
      });
      successCount += 1;
      perEmployeeSuccessLogs.push({
        employeeId: row.id,
        firstName: row.firstName,
        lastName: row.lastName,
        beforeStatus: row.status,
        afterStatus: nextStatus,
      });
    } catch {
      failedCount += 1;
    }
  }

  for (const item of perEmployeeSuccessLogs) {
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_EMPLOYEE_UPDATE",
        entityType: "EMPLOYEE",
        entityId: item.employeeId,
        meta: {
          actor: { id: user.id, role: user.role },
          sourcePage,
          section: "bulk-status",
          operation: "bulk_update_employee_status_item",
          before: {
            firstName: item.firstName,
            lastName: item.lastName,
            status: item.beforeStatus,
          },
          after: {
            firstName: item.firstName,
            lastName: item.lastName,
            status: item.afterStatus,
          },
          status: "SUCCESS",
          resultSummary: "Employee status updated via bulk action.",
        },
      });
    } catch {
      // best-effort
    }
  }

  try {
    const summaryEntityId =
      scope === "selected" && targetRows.length === 1
        ? targetRows[0]?.id || "selected"
        : scope === "selected"
          ? "selected"
          : "all_filtered";
    await recordAuditLog({
      actorId: user.id,
      action: "HR_EMPLOYEE_BULK_STATUS_UPDATE",
      entityType: "EMPLOYEE",
      entityId: summaryEntityId,
      meta: {
        actor: { id: user.id, role: user.role },
        sourcePage,
        section,
        operation,
        before: {
          scope,
          targetCount: targetRows.length,
          targetEmployeeIds:
            scope === "selected" && targetRows.length <= 5
              ? targetRows.map((row) => row.id)
              : undefined,
          beforeStatusCounts: beforeCounts,
        },
        after: {
          nextStatus,
          successCount,
          conflictCount,
          failedCount,
        },
        status: failedCount > 0 || conflictCount > 0 ? "PARTIAL_SUCCESS" : "SUCCESS",
        resultSummary:
          inputSummary ||
          `Bulk status update completed (${successCount} updated, ${conflictCount} conflict, ${failedCount} failed).`,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({
    successCount,
    conflictCount,
    failedCount,
    targetCount: targetRows.length,
    nextStatus,
  });
}
