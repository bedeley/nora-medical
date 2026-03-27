import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { validateExpectedUpdatedAt } from "@/lib/hr-staff-profile-utils";

const updateSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().min(5).optional().or(z.literal("")),
  department: z.string().optional().or(z.literal("")),
  position: z.string().optional().or(z.literal("")),
  status: z.enum(["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"]).optional(),
  hireDate: z.string().optional().or(z.literal("")),
  terminationDate: z.string().optional().or(z.literal("")),
  managerId: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
  bankName: z.string().optional().or(z.literal("")),
  bankAccountName: z.string().optional().or(z.literal("")),
  bankAccountNumber: z.string().optional().or(z.literal("")),
  bankCode: z.string().optional().or(z.literal("")),
  bankBranch: z.string().optional().or(z.literal("")),
  expectedUpdatedAt: z.string().optional().or(z.literal("")),
  sourcePage: z.string().optional().or(z.literal("")),
  section: z.string().optional().or(z.literal("")),
  operation: z.string().optional().or(z.literal("")),
  resultSummary: z.string().optional().or(z.literal("")),
});

function normalizeOptional(value?: string) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const employee = await prisma.employee.findUnique({
    where: { id: resolvedParams.id },
    include: {
      compensations: { orderBy: { effectiveDate: "desc" } },
      payslips: { take: 5, orderBy: { createdAt: "desc" } },
      issues: { take: 5, orderBy: { createdAt: "desc" } },
      onboardingTasks: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!employee) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(employee);
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const hireDate = normalizeOptional(parsed.data.hireDate);
  const terminationDate = normalizeOptional(parsed.data.terminationDate);
  const data: Record<string, unknown> = {};

  if (typeof parsed.data.firstName === "string") data.firstName = parsed.data.firstName.trim();
  if (typeof parsed.data.lastName === "string") data.lastName = parsed.data.lastName.trim();
  if ("email" in parsed.data) data.email = normalizeOptional(parsed.data.email);
  if ("phone" in parsed.data) data.phone = normalizeOptional(parsed.data.phone);
  if ("department" in parsed.data) data.department = normalizeOptional(parsed.data.department);
  if ("position" in parsed.data) data.position = normalizeOptional(parsed.data.position);
  if (parsed.data.status) data.status = parsed.data.status;
  if ("hireDate" in parsed.data) data.hireDate = hireDate ? new Date(hireDate) : null;
  if ("terminationDate" in parsed.data) data.terminationDate = terminationDate ? new Date(terminationDate) : null;
  if ("managerId" in parsed.data) data.managerId = normalizeOptional(parsed.data.managerId);
  if ("notes" in parsed.data) data.notes = normalizeOptional(parsed.data.notes);
  if ("bankName" in parsed.data) data.bankName = normalizeOptional(parsed.data.bankName);
  if ("bankAccountName" in parsed.data) data.bankAccountName = normalizeOptional(parsed.data.bankAccountName);
  if ("bankAccountNumber" in parsed.data) data.bankAccountNumber = normalizeOptional(parsed.data.bankAccountNumber);
  if ("bankCode" in parsed.data) data.bankCode = normalizeOptional(parsed.data.bankCode);
  if ("bankBranch" in parsed.data) data.bankBranch = normalizeOptional(parsed.data.bankBranch);
  if (parsed.data.status === "TERMINATED" && !("terminationDate" in parsed.data)) {
    data.terminationDate = new Date();
  }
  if (
    parsed.data.status &&
    parsed.data.status !== "TERMINATED" &&
    !("terminationDate" in parsed.data)
  ) {
    data.terminationDate = null;
  }

  try {
    const existing = await prisma.employee.findUnique({
      where: { id: resolvedParams.id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        department: true,
        position: true,
        status: true,
        hireDate: true,
        terminationDate: true,
        managerId: true,
        notes: true,
        bankName: true,
        bankAccountName: true,
        bankAccountNumber: true,
        bankCode: true,
        bankBranch: true,
        updatedAt: true,
      },
    });
    if (!existing) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }
    const conflictCheck = validateExpectedUpdatedAt(existing.updatedAt, parsed.data.expectedUpdatedAt);
    if (!conflictCheck.ok) {
      return NextResponse.json({ error: conflictCheck.error }, { status: conflictCheck.status });
    }

    const employee = await prisma.employee.update({
      where: { id: resolvedParams.id },
      data,
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_EMPLOYEE_UPDATE",
        entityType: "EMPLOYEE",
        entityId: employee.id,
        meta: {
          actor: {
            id: user.id,
            role: user.role,
          },
          sourcePage: parsed.data.sourcePage?.trim() || "admin/hr/staff/[id]",
          section: parsed.data.section?.trim() || "staff-profile",
          operation: parsed.data.operation?.trim() || "update_employee_profile",
          before: {
            firstName: existing.firstName,
            lastName: existing.lastName,
            email: existing.email,
            phone: existing.phone,
            department: existing.department,
            position: existing.position,
            status: existing.status,
            hireDate: existing.hireDate?.toISOString?.() ?? null,
            terminationDate: existing.terminationDate?.toISOString?.() ?? null,
            managerId: existing.managerId,
            notesLength: existing.notes?.length || 0,
            bankName: existing.bankName,
            bankAccountName: existing.bankAccountName,
            bankAccountNumber: existing.bankAccountNumber ? "masked" : null,
            bankCode: existing.bankCode,
            bankBranch: existing.bankBranch,
          },
          after: {
            firstName: employee.firstName,
            lastName: employee.lastName,
            email: employee.email,
            phone: employee.phone,
            department: employee.department,
            position: employee.position,
            status: employee.status,
            hireDate: employee.hireDate?.toISOString?.() ?? null,
            terminationDate: employee.terminationDate?.toISOString?.() ?? null,
            managerId: employee.managerId,
            notesLength: employee.notes?.length || 0,
            bankName: employee.bankName,
            bankAccountName: employee.bankAccountName,
            bankAccountNumber: employee.bankAccountNumber ? "masked" : null,
            bankCode: employee.bankCode,
            bankBranch: employee.bankBranch,
          },
          status: "SUCCESS",
          resultSummary: parsed.data.resultSummary?.trim() || "Employee profile updated successfully.",
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(employee);
  } catch (err) {
    console.error("Error updating employee:", err);
    return NextResponse.json({ error: "Failed to update employee" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  try {
    const employee = await prisma.employee.update({
      where: { id: resolvedParams.id },
      data: {
        status: "TERMINATED",
        terminationDate: new Date(),
      },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_EMPLOYEE_TERMINATE",
        entityType: "EMPLOYEE",
        entityId: employee.id,
        meta: {
          status: employee.status,
          terminationDate: employee.terminationDate,
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(employee);
  } catch (err) {
    console.error("Error terminating employee:", err);
    return NextResponse.json({ error: "Failed to terminate employee" }, { status: 500 });
  }
}
