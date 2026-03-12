import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function num(v: unknown) {
  return Number(v || 0);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Payslip id is required" }, { status: 400 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payslip = await prisma.payslip.findUnique({
    where: { id: resolvedParams.id },
    include: {
      employee: true,
      payrollRun: true,
    },
  });
  if (!payslip) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const periodEnd = payslip.payrollRun.periodEnd || new Date();
  const yearStart = new Date(periodEnd.getFullYear(), 0, 1);
  const yearEnd = new Date(periodEnd.getFullYear(), 11, 31, 23, 59, 59, 999);

  const ytdPayslips = await prisma.payslip.findMany({
    where: {
      employeeId: payslip.employeeId,
      payrollRun: {
        periodEnd: {
          gte: yearStart,
          lte: yearEnd,
        },
      },
    },
    select: {
      payrollRunId: true,
      grossPay: true,
      netPay: true,
      lineItems: true,
      payrollRun: {
        select: {
          periodStart: true,
          periodEnd: true,
          status: true,
          runType: true,
          createdAt: true,
        },
      },
    },
  });

  const periodKey = (start: Date, end: Date) =>
    `${start.toISOString()}|${end.toISOString()}`;

  const regularRunsByPeriod = new Map<string, { id: string }>();
  for (const slip of ytdPayslips) {
    const run = slip.payrollRun;
    if (!run) continue;
    if (run.runType !== "REGULAR") continue;
    if (run.status !== "FINALIZED" && run.status !== "PAID") continue;
    const key = periodKey(run.periodStart, run.periodEnd);
    const existing = regularRunsByPeriod.get(key);
    if (!existing) {
      regularRunsByPeriod.set(key, { id: slip.payrollRunId });
      continue;
    }
    const existingSlip = ytdPayslips.find((item) => item.payrollRunId === existing.id);
    const existingRun = existingSlip?.payrollRun;
    if (!existingRun) {
      regularRunsByPeriod.set(key, { id: slip.payrollRunId });
      continue;
    }
    const score = run.status === "PAID" ? 2 : 1;
    const existingScore = existingRun.status === "PAID" ? 2 : 1;
    if (score > existingScore) {
      regularRunsByPeriod.set(key, { id: slip.payrollRunId });
    } else if (score === existingScore) {
      if (run.createdAt > existingRun.createdAt) {
        regularRunsByPeriod.set(key, { id: slip.payrollRunId });
      }
    }
  }

  const eligiblePayslips = ytdPayslips.filter((slip) => {
    const run = slip.payrollRun;
    if (!run) return false;
    const runPeriodEnd = run.periodEnd || new Date();
    if (slip.payrollRunId === payslip.payrollRunId) return true;
    if (runPeriodEnd >= periodEnd) return false;
    if (run.runType === "ADJUSTMENT") {
      return run.status === "FINALIZED" || run.status === "PAID";
    }
    if (run.runType === "REGULAR") {
      const key = periodKey(run.periodStart, run.periodEnd);
      const selected = regularRunsByPeriod.get(key);
      return selected?.id === slip.payrollRunId;
    }
    return false;
  });

  const ytdTotals = eligiblePayslips.reduce(
    (acc, slip) => {
      const gross = num(slip.grossPay);
      const net = num(slip.netPay);
      const lineItems = slip.lineItems as Record<string, unknown> | null | undefined;
      const tax = num(lineItems?.tax);
      const pension = num(lineItems?.pension);
      const deductions = Math.max(0, num(lineItems?.deductions ?? gross - net));
      return {
        gross: acc.gross + gross,
        net: acc.net + net,
        deductions: acc.deductions + deductions,
        tax: acc.tax + tax,
        pension: acc.pension + pension,
      };
    },
    { gross: 0, net: 0, deductions: 0, tax: 0, pension: 0 }
  );

  return NextResponse.json({ payslip, ytdTotals });
}
