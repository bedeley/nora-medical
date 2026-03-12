import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const rowSchema = z.object({
  firstname: z.string().min(1),
  lastname: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().min(5).optional().or(z.literal("")),
  department: z.string().optional().or(z.literal("")),
  position: z.string().optional().or(z.literal("")),
  status: z.enum(["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"]).optional().or(z.literal("")),
  hiredate: z.string().optional().or(z.literal("")),
  bankname: z.string().optional().or(z.literal("")),
  bankaccountname: z.string().optional().or(z.literal("")),
  bankaccountnumber: z.string().optional().or(z.literal("")),
  bankcode: z.string().optional().or(z.literal("")),
  bankbranch: z.string().optional().or(z.literal("")),
});

const payloadSchema = z.object({
  rows: z.array(z.record(z.string(), z.string())).min(1),
});

const defaultOnboardingTasks = [
  "Signed offer letter",
  "Bank details collected",
  "Tax ID verified",
  "Compensation set",
  "Pension enrollment",
  "Orientation completed",
];

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

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const errors: string[] = [];
  let created = 0;
  let skipped = 0;

  for (const [index, raw] of parsed.data.rows.entries()) {
    const normalized = Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key.trim().toLowerCase(), String(value || "").trim()])
    );
    const row = rowSchema.safeParse(normalized);
    if (!row.success) {
      errors.push(`Row ${index + 1}: Invalid data.`);
      continue;
    }

    const email = normalizeOptional(row.data.email);
    const phone = normalizeOptional(row.data.phone);
    const lookup = [];
    if (email) lookup.push({ email });
    if (phone) lookup.push({ phone });
    const existing = lookup.length
      ? await prisma.employee.findFirst({ where: { OR: lookup } })
      : null;
    if (existing) {
      skipped += 1;
      continue;
    }

    const hireDate = normalizeOptional(row.data.hiredate);
    try {
      const employee = await prisma.employee.create({
        data: {
          firstName: row.data.firstname.trim(),
          lastName: row.data.lastname.trim(),
          email,
          phone,
          department: normalizeOptional(row.data.department),
          position: normalizeOptional(row.data.position),
          status: row.data.status || "ACTIVE",
          hireDate: hireDate ? new Date(hireDate) : null,
          bankName: normalizeOptional(row.data.bankname),
          bankAccountName: normalizeOptional(row.data.bankaccountname),
          bankAccountNumber: normalizeOptional(row.data.bankaccountnumber),
          bankCode: normalizeOptional(row.data.bankcode),
          bankBranch: normalizeOptional(row.data.bankbranch),
        },
      });
      await prisma.onboardingTask.createMany({
        data: defaultOnboardingTasks.map((title) => ({
          employeeId: employee.id,
          title,
        })),
      });
      created += 1;
    } catch {
      errors.push(`Row ${index + 1}: Failed to create employee.`);
    }
  }

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_EMPLOYEE_IMPORT",
      entityType: "EMPLOYEE",
      entityId: "bulk",
      meta: { created, skipped, errors: errors.length },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ created, skipped, errors });
}
