import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { generatePayslipsForRun } from "@/lib/hr-payroll";
import { recordAuditLog } from "@/lib/audit-log";
import { getGhanaStatutoryConfigFromSettings } from "@/lib/hr-ghana-statutory";

const generateSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  bonus: z.number().optional(),
  autoCalculation: z.boolean().optional(),
  taxMode: z.enum(["percent", "amount"]).optional(),
  taxValue: z.number().min(0).optional(),
  ssnitMode: z.enum(["percent", "amount"]).optional(),
  ssnitValue: z.number().min(0).optional(),
  previewOnly: z.boolean().optional(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

function monthRange(year: number, month: number) {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = generateSchema.safeParse({
    ...body,
    year: typeof body.year === "string" ? Number(body.year) : body.year,
    month: typeof body.month === "string" ? Number(body.month) : body.month,
    bonus: typeof body.bonus === "string" ? Number(body.bonus) : body.bonus,
    autoCalculation: typeof body.autoCalculation === "boolean" ? body.autoCalculation : undefined,
    taxMode: body.taxMode,
    taxValue: typeof body.taxValue === "string" ? Number(body.taxValue) : body.taxValue,
    ssnitMode: body.ssnitMode,
    ssnitValue: typeof body.ssnitValue === "string" ? Number(body.ssnitValue) : body.ssnitValue,
    previewOnly: typeof body.previewOnly === "boolean" ? body.previewOnly : undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const { year, month } = parsed.data;
  const { start, end } = monthRange(year, month);
  const bonus = parsed.data.bonus ?? 0;
  const ghanaConfig = await getGhanaStatutoryConfigFromSettings();
  if (!ghanaConfig.autoStatutoryCalc) {
    return NextResponse.json(
      {
        error:
          "Automatic Ghana statutory calculation is off in HR Settings. Turn it on before generating paystubs.",
      },
      { status: 400 },
    );
  }
  const autoCalculation = parsed.data.autoCalculation ?? ghanaConfig.autoStatutoryCalc;
  const manual =
    autoCalculation
      ? undefined
      : {
          taxMode: parsed.data.taxMode ?? "percent",
          taxValue: parsed.data.taxValue ?? 0,
          ssnitMode: parsed.data.ssnitMode ?? "percent",
          ssnitValue: parsed.data.ssnitValue ?? ghanaConfig.ssnitEmployeeRate,
        };

  let run = await prisma.payrollRun.findFirst({
    where: {
      periodStart: { gte: start, lte: end },
      periodEnd: { gte: start, lte: end },
      status: "DRAFT",
      runType: "REGULAR",
    },
    orderBy: { createdAt: "desc" },
  });

  if (!run) {
    const finalizedExists = await prisma.payrollRun.findFirst({
      where: {
        periodStart: { gte: start, lte: end },
        periodEnd: { gte: start, lte: end },
        status: { in: ["FINALIZED", "PAID"] },
        runType: "REGULAR",
      },
      select: { id: true },
    });
    if (finalizedExists) {
      return NextResponse.json(
        { error: "Payroll run already finalized for this month." },
        { status: 409 }
      );
    }
  }

  let temporaryPreviewRunId: string | null = null;
  if (!run) {
    const createdRun = await prisma.payrollRun.create({
      data: {
        periodStart: start,
        periodEnd: end,
        status: "DRAFT",
        runType: "REGULAR",
        totalGross: 0,
        totalNet: 0,
      },
    });
    run = createdRun;
    if (parsed.data.previewOnly) {
      temporaryPreviewRunId = createdRun.id;
    }
  }

  const result = await generatePayslipsForRun({
    payrollRunId: run.id,
    taxPercent: 0,
    pensionPercent: 0,
    bonus,
    statutory: {
      mode: "ghana",
      enablePaye: ghanaConfig.enablePaye,
      enableSsnitEmployee: ghanaConfig.enableSsnitEmployee,
      enableSsnitEmployer: ghanaConfig.enableSsnitEmployer,
      ssnitEmployeeRate: ghanaConfig.ssnitEmployeeRate,
      ssnitEmployerRate: ghanaConfig.ssnitEmployerRate,
      taxableAllowancePercent: ghanaConfig.taxableAllowancePercent,
      payeBands: ghanaConfig.payeBands,
      manual,
    },
    previewOnly: parsed.data.previewOnly ?? false,
  });

  if (result.error) {
    if (temporaryPreviewRunId) {
      await prisma.payrollRun.delete({ where: { id: temporaryPreviewRunId } }).catch(() => undefined);
    }
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  if (parsed.data.previewOnly) {
    if (temporaryPreviewRunId) {
      await prisma.payrollRun.delete({ where: { id: temporaryPreviewRunId } }).catch(() => undefined);
    }
    return NextResponse.json({ ...result, payrollRunId: run.id, previewOnly: true });
  }
  try {
    await recordAuditLog({
      actorId: user.id,
      action: "PAYROLL_GENERATE_MONTHLY",
      entityType: "PAYROLL_RUN",
      entityId: run.id,
      meta: {
        sourcePage: "admin/hr/payroll",
        section: "monthly-generation",
        operation: "generate_monthly_paystubs",
        year,
        month,
        payrollRunId: run.id,
        created: result.created,
        updated: result.updated ?? 0,
        skipped: result.skipped,
        bonus,
        statutory: {
          mode: "ghana",
          autoCalculation,
          collectPaye: ghanaConfig.enablePaye,
          collectSsnitEmployee: ghanaConfig.enableSsnitEmployee,
          trackSsnitEmployer: ghanaConfig.enableSsnitEmployer,
        },
        status: "SUCCESS",
        resultSummary: `Generated ${result.created} payslip(s), updated ${result.updated ?? 0}, skipped ${result.skipped}.`,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ ...result, payrollRunId: run.id });
}
