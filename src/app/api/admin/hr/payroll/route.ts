import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { summarizeMissingBankDetails } from "@/lib/hr-payslip-utils";

const payrollSchema = z.object({
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
}).strict();

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
  const statusRaw = searchParams.get("status")?.trim() || "";
  const allowedStatuses = new Set(["DRAFT", "FINALIZED", "PAID", "CANCELLED"]);
  const status = allowedStatuses.has(statusRaw) ? statusRaw : "";

  const runs = await prisma.payrollRun.findMany({
    where: status ? { status: status as "DRAFT" } : undefined,
    orderBy: { periodStart: "desc" },
    take: 200,
    include: {
      expense: true,
      _count: {
        select: { payslips: true },
      },
      payslips: {
        select: {
          employeeId: true,
          employee: {
            select: {
              id: true,
              bankName: true,
              bankAccountName: true,
              bankAccountNumber: true,
              bankCode: true,
              bankBranch: true,
            },
          },
        },
      },
    },
  });

  return NextResponse.json({
    rows: runs.map((run) => {
      const missingBankSummary = summarizeMissingBankDetails(run.payslips);
      return {
        ...run,
        payslipCount: run._count?.payslips ?? 0,
        missingBankDetailsCount: missingBankSummary.count,
        firstMissingBankEmployeeId: missingBankSummary.entries[0]?.employeeId ?? null,
      };
    }),
  });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  if (
    typeof body?.status !== "undefined" ||
    typeof body?.totalGross !== "undefined" ||
    typeof body?.totalNet !== "undefined"
  ) {
    return NextResponse.json(
      {
        error:
          "Manual status and total overrides are not allowed when creating payroll runs.",
      },
      { status: 400 },
    );
  }
  const parsed = payrollSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const periodStart = new Date(parsed.data.periodStart);
    const periodEnd = new Date(parsed.data.periodEnd);
    if (periodEnd.getTime() < periodStart.getTime()) {
      return NextResponse.json({ error: "Period end cannot be earlier than period start." }, { status: 400 });
    }

    const overlap = await prisma.payrollRun.findFirst({
      where: {
        runType: "REGULAR",
        status: { not: "CANCELLED" },
        periodStart: { lte: periodEnd },
        periodEnd: { gte: periodStart },
      },
      select: { id: true, status: true, periodStart: true, periodEnd: true },
    });
    if (overlap) {
      return NextResponse.json(
        {
          error:
            overlap.status === "DRAFT"
              ? "A draft payroll run already exists for an overlapping period."
              : "A finalized or paid payroll run already exists for an overlapping period.",
          overlap: {
            id: overlap.id,
            status: overlap.status,
            periodStart: overlap.periodStart.toISOString(),
            periodEnd: overlap.periodEnd.toISOString(),
          },
        },
        { status: 409 },
      );
    }

    const run = await prisma.payrollRun.create({
      data: {
        periodStart,
        periodEnd,
        status: "DRAFT",
        runType: "REGULAR",
        totalGross: 0,
        totalNet: 0,
        finalizedAt: null,
      },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "PAYROLL_RUN_CREATE",
        entityType: "PAYROLL_RUN",
        entityId: run.id,
        meta: {
          sourcePage: "admin/hr/payroll",
          section: "payroll-runs",
          operation: "create_run",
          before: null,
          after: {
            periodStart: run.periodStart.toISOString(),
            periodEnd: run.periodEnd.toISOString(),
            status: "DRAFT",
          },
          status: "SUCCESS",
          resultSummary: "Payroll run created successfully.",
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(run);
  } catch (err) {
    console.error("Error creating payroll run:", err);
    return NextResponse.json({ error: "Failed to create payroll run" }, { status: 500 });
  }
}
