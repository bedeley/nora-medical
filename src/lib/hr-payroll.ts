import { prisma } from "@/lib/prisma";

function toDay(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysInclusive(start: Date, end: Date) {
  const s = toDay(start).getTime();
  const e = toDay(end).getTime();
  if (e < s) return 0;
  return Math.floor((e - s) / 86_400_000) + 1;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export async function generatePayslipsForRun(params: {
  payrollRunId: string;
  taxPercent: number;
  pensionPercent: number;
  bonus: number;
}) {
  const { payrollRunId, taxPercent, pensionPercent, bonus } = params;
  const run = await prisma.payrollRun.findUnique({
    where: { id: payrollRunId },
  });
  if (!run) {
    return { created: 0, skipped: 0, updatedTotals: false, error: "Payroll run not found" };
  }
  if (run.status !== "DRAFT") {
    return {
      created: 0,
      skipped: 0,
      updatedTotals: false,
      error: "Payroll run must be in DRAFT status to generate payslips.",
    };
  }

  const periodStart = run.periodStart;
  const periodEnd = run.periodEnd;
  const totalDays = daysInclusive(periodStart, periodEnd);
  if (totalDays <= 0) {
    return { created: 0, skipped: 0, updatedTotals: false, error: "Invalid payroll period" };
  }

  const employees = await prisma.employee.findMany({
    where: {
      status: "ACTIVE",
      AND: [
        { OR: [{ hireDate: null }, { hireDate: { lte: periodEnd } }] },
        { OR: [{ terminationDate: null }, { terminationDate: { gte: periodStart } }] },
      ],
    },
    select: { id: true, hireDate: true, terminationDate: true },
  });

  if (!employees.length) {
    return { created: 0, skipped: 0, updatedTotals: false };
  }

  const compensationRows = await prisma.compensation.findMany({
    where: {
      employeeId: { in: employees.map((e) => e.id) },
      effectiveDate: { lte: periodEnd },
      status: "ACTIVE",
    },
    orderBy: [{ employeeId: "asc" }, { effectiveDate: "desc" }],
  });

  const compensationByEmployee = new Map<string, typeof compensationRows[number]>();
  for (const row of compensationRows) {
    if (!compensationByEmployee.has(row.employeeId)) {
      compensationByEmployee.set(row.employeeId, row);
    }
  }

  const existingPayslips = await prisma.payslip.findMany({
    where: { payrollRunId: run.id },
    select: { employeeId: true },
  });
  const existingEmployeeIds = new Set(existingPayslips.map((p) => p.employeeId));

  const createData = [] as {
    payrollRunId: string;
    employeeId: string;
    grossPay: number;
    netPay: number;
    lineItems: Record<string, number>;
  }[];

  for (const employee of employees) {
    if (existingEmployeeIds.has(employee.id)) continue;
    const comp = compensationByEmployee.get(employee.id);
    if (!comp) continue;

    const start = employee.hireDate && employee.hireDate > periodStart ? employee.hireDate : periodStart;
    const end =
      employee.terminationDate && employee.terminationDate < periodEnd
        ? employee.terminationDate
        : periodEnd;
    const workedDays = daysInclusive(start, end);
    if (workedDays <= 0) continue;

    const factor = workedDays / totalDays;
    const base = Number(comp.baseSalary || 0);
    const allowances = Number(comp.allowances || 0);
    const perEmployeeBonus = Number(comp.bonus || 0);
    const bonusValue = perEmployeeBonus > 0 ? perEmployeeBonus : bonus;
    const gross = round2((base + allowances + bonusValue) * factor);
    const tax = round2((gross * taxPercent) / 100);
    const pension = round2((gross * pensionPercent) / 100);
    const deductions = round2(tax + pension);
    const net = round2(gross - deductions);
    const proratedBonus = round2(bonusValue * factor);

    createData.push({
      payrollRunId: run.id,
      employeeId: employee.id,
      grossPay: gross,
      netPay: net,
      lineItems: {
        tax,
        pension,
        bonus: proratedBonus,
        allowances: round2(allowances * factor),
        deductions,
        prorateFactor: round2(factor),
      },
    });
  }

  if (!createData.length) {
    return { created: 0, skipped: employees.length, updatedTotals: false };
  }

  await prisma.payslip.createMany({ data: createData, skipDuplicates: true });

  const totals = await prisma.payslip.aggregate({
    where: { payrollRunId: run.id },
    _sum: { grossPay: true, netPay: true },
  });

  await prisma.payrollRun.update({
    where: { id: run.id },
    data: {
      totalGross: Number(totals._sum.grossPay || 0),
      totalNet: Number(totals._sum.netPay || 0),
    },
  });

  return { created: createData.length, skipped: employees.length - createData.length, updatedTotals: true };
}
