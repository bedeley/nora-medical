import { NextResponse } from "next/server";
import { generatePayslipsForRun } from "@/lib/hr-payroll";
import { prisma } from "@/lib/prisma";

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

  const taxPercent = parseNumber(process.env.HR_PAYROLL_TAX_PERCENT) ?? 0;
  const pensionPercent = parseNumber(process.env.HR_PAYROLL_PENSION_PERCENT) ?? 0;
  const bonus = parseNumber(process.env.HR_PAYROLL_BONUS) ?? 0;

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
    taxPercent,
    pensionPercent,
    bonus,
  });

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({
    ...result,
    payrollRunId: ensuredRun.id,
    year,
    month,
    enabled: true,
  });
}
