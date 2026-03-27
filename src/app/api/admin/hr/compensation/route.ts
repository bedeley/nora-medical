import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import {
  buildCompensationWhereClause,
  normalizeCompensationQueryState,
} from "@/lib/hr-compensation-utils";

const compensationSchema = z.object({
  employeeId: z.string().min(1),
  baseSalary: z.number(),
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

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const queryState = normalizeCompensationQueryState(searchParams);
  const where = buildCompensationWhereClause(queryState);

  const [total, compensations] = await Promise.all([
    prisma.compensation.count({ where }),
    prisma.compensation.findMany({
      where,
      orderBy: [{ effectiveDate: "desc" }, { id: "desc" }],
      skip: queryState.skip,
      take: queryState.take,
    }),
  ]);

  return NextResponse.json({
    rows: compensations,
    total,
    page: queryState.page,
    pageSize: queryState.pageSize,
    totalPages: Math.max(1, Math.ceil(total / queryState.pageSize)),
    filters: {
      employeeId: queryState.employeeId,
      status: queryState.status,
      search: queryState.search,
    },
  });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = compensationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const effectiveDate = parsed.data.effectiveDate ? new Date(parsed.data.effectiveDate) : new Date();
    const bounds = dayBounds(effectiveDate);
    const existing = await prisma.compensation.findFirst({
      where: {
        employeeId: parsed.data.employeeId,
        effectiveDate: {
          gte: bounds.start,
          lte: bounds.end,
        },
      },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Compensation already exists for this employee on that effective date." },
        { status: 409 }
      );
    }

    const compensation = await prisma.compensation.create({
      data: {
        employeeId: parsed.data.employeeId,
        baseSalary: parsed.data.baseSalary,
        allowances: parsed.data.allowances ?? 0,
        deductions: parsed.data.deductions ?? 0,
        bonus: parsed.data.bonus ?? 0,
        currency: parsed.data.currency?.trim() || "GHS",
        effectiveDate,
        note: normalizeOptional(parsed.data.note),
        status: parsed.data.status ?? "ACTIVE",
        approvedAt:
          (parsed.data.status ?? "ACTIVE") === "ACTIVE" ? new Date() : null,
      },
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
        action: "COMPENSATION_CREATE",
        entityType: "COMPENSATION",
        entityId: compensation.id,
        meta: {
          sourcePage: "admin/hr/compensation",
          section: "compensation-records",
          operation: "create_compensation",
          employeeId: compensation.employeeId,
          before: null,
          after: {
            baseSalary: Number(compensation.baseSalary),
            allowances: Number(compensation.allowances),
            deductions: Number(compensation.deductions),
            bonus: Number(compensation.bonus),
            effectiveDate: compensation.effectiveDate?.toISOString?.() ?? null,
            status: compensation.status,
            approvedAt: compensation.approvedAt?.toISOString?.() ?? null,
          },
          status: "SUCCESS",
          resultSummary: "Compensation record created successfully.",
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(compensation);
  } catch (err) {
    console.error("Error creating compensation:", err);
    return NextResponse.json({ error: "Failed to create compensation" }, { status: 500 });
  }
}
