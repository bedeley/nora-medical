import { NextResponse } from "next/server";
import { generatePayslipsForRun } from "@/lib/hr-payroll";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { getGhanaStatutoryConfigFromSettings } from "@/lib/hr-ghana-statutory";

function parseNumber(value?: string | null) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function monthRange(year: number, month: number) {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

export async function GET(req: Request) {
  const secret = (process.env.HR_PAYROLL_CRON_SECRET || "").trim();
  const authHeader = req.headers.get("authorization") || "";
  const headerSecret = req.headers.get("x-cron-secret") || "";
  const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : headerSecret.trim();

  if (!secret || provided !== secret) {
    return NextResponse.json({ enabled: false }, { status: 200 });
  }

  const bonus = parseNumber(process.env.HR_PAYROLL_BONUS) ?? 0;
  const ghanaConfig = await getGhanaStatutoryConfigFromSettings();

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const { start, end } = monthRange(year, month);

  const run = await prisma.payrollRun.findFirst({
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

  const ensuredRun =
    run ??
    (await prisma.payrollRun.create({
      data: {
        periodStart: start,
        periodEnd: end,
        status: "DRAFT",
        runType: "REGULAR",
        totalGross: 0,
        totalNet: 0,
      },
    }));

  const result = await generatePayslipsForRun({
    payrollRunId: ensuredRun.id,
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
    },
  });

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  try {
    await recordAuditLog({
      actorId: null,
      action: "PAYROLL_GENERATE_CRON",
      entityType: "PAYROLL_RUN",
      entityId: ensuredRun.id,
      meta: {
        sourcePage: "admin/hr/payroll/cron",
        section: "monthly-generation",
        operation: "generate_monthly_paystubs_cron",
        before: {
          payrollRunId: ensuredRun.id,
          status: ensuredRun.status,
          year,
          month,
        },
        after: {
          payrollRunId: ensuredRun.id,
          status: ensuredRun.status,
          created: result.created,
          updated: result.updated ?? 0,
          skipped: result.skipped,
        },
        taxPercent: "AUTO_GHANA_PAYE",
        pensionPercent: "AUTO_GHANA_SSNIT",
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
          autoCalculation: true,
        },
        actor: "System",
        status: "SUCCESS",
        resultSummary: `Cron generated ${result.created} payslip(s), updated ${result.updated ?? 0}, skipped ${result.skipped}.`,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({
    ...result,
    payrollRunId: ensuredRun.id,
    year,
    month,
    enabled: true,
  });
}
