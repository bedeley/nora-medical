import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
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

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() || "";
  const statusRaw = searchParams.get("status")?.trim() || "";
  const department = searchParams.get("department")?.trim() || "";
  const allowedStatuses = new Set(["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"]);
  const status = allowedStatuses.has(statusRaw) ? statusRaw : "";

  const employees = await prisma.employee.findMany({
    where: {
      ...(status ? { status: status as "ACTIVE" } : {}),
      ...(department ? { department } : {}),
      ...(q
        ? {
            OR: [
              { firstName: { contains: q, mode: "insensitive" } },
              { lastName: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { phone: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ rows: employees });
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
          status: employee.status,
          department: employee.department,
          position: employee.position,
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
