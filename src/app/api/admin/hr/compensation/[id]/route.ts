import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const updateSchema = z.object({
  baseSalary: z.number().optional(),
  allowances: z.number().optional(),
  deductions: z.number().optional(),
  bonus: z.number().optional(),
  currency: z.string().min(3).optional(),
  effectiveDate: z.string().datetime().optional().or(z.literal("")),
  note: z.string().optional().or(z.literal("")),
  status: z.enum(["DRAFT", "PENDING", "ACTIVE"]).optional(),
});

const onboardingCompensationTitle = "Compensation set";

function normalizeOptional(value?: string) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function dayBounds(date: Date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

async function markCompensationOnboardingTask(employeeId: string) {
  const existing = await prisma.onboardingTask.findFirst({
    where: { employeeId, title: onboardingCompensationTitle },
  });
  if (existing) {
    if (existing.status !== "COMPLETE" || !existing.completedAt) {
      await prisma.onboardingTask.update({
        where: { id: existing.id },
        data: {
          status: "COMPLETE",
          completedAt: new Date(),
        },
      });
    }
    return;
  }
  await prisma.onboardingTask.create({
    data: {
      employeeId,
      title: onboardingCompensationTitle,
      status: "COMPLETE",
      completedAt: new Date(),
    },
  });
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
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

  const existing = await prisma.compensation.findUnique({
    where: { id: resolvedParams.id },
    select: { id: true, employeeId: true, effectiveDate: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Compensation not found" }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  if (typeof parsed.data.baseSalary === "number") data.baseSalary = parsed.data.baseSalary;
  if (typeof parsed.data.allowances === "number") data.allowances = parsed.data.allowances;
  if (typeof parsed.data.deductions === "number") data.deductions = parsed.data.deductions;
  if (typeof parsed.data.bonus === "number") data.bonus = parsed.data.bonus;
  if (typeof parsed.data.currency === "string") data.currency = parsed.data.currency.trim();
  if ("effectiveDate" in parsed.data) {
    data.effectiveDate = parsed.data.effectiveDate ? new Date(parsed.data.effectiveDate) : null;
  }
  if ("note" in parsed.data) data.note = normalizeOptional(parsed.data.note);
  if (parsed.data.status) data.status = parsed.data.status;
  if (parsed.data.status === "ACTIVE") {
    data.approvedAt = new Date();
  }
  if (parsed.data.status && parsed.data.status !== "ACTIVE") {
    data.approvedAt = null;
  }

  try {
    if ("effectiveDate" in parsed.data && parsed.data.effectiveDate) {
      const nextDate = new Date(parsed.data.effectiveDate);
      const bounds = dayBounds(nextDate);
      const collision = await prisma.compensation.findFirst({
        where: {
          employeeId: existing.employeeId,
          id: { not: existing.id },
          effectiveDate: {
            gte: bounds.start,
            lte: bounds.end,
          },
        },
        select: { id: true },
      });
      if (collision) {
        return NextResponse.json(
          { error: "Compensation already exists for this employee on that effective date." },
          { status: 409 }
        );
      }
    }

    const compensation = await prisma.compensation.update({
      where: { id: resolvedParams.id },
      data,
    });
    if (compensation.status === "ACTIVE") {
      try {
        await markCompensationOnboardingTask(compensation.employeeId);
      } catch (err) {
        console.error("Failed to complete onboarding compensation task:", err);
      }
    }
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "COMPENSATION_UPDATE",
        entityType: "COMPENSATION",
        entityId: compensation.id,
        meta: {
          baseSalary: Number(compensation.baseSalary),
          allowances: Number(compensation.allowances),
          deductions: Number(compensation.deductions),
          bonus: Number(compensation.bonus),
          effectiveDate: compensation.effectiveDate?.toISOString?.() ?? null,
          status: compensation.status,
          approvedAt: compensation.approvedAt?.toISOString?.() ?? null,
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(compensation);
  } catch (err) {
    console.error("Error updating compensation:", err);
    return NextResponse.json({ error: "Failed to update compensation" }, { status: 500 });
  }
}
