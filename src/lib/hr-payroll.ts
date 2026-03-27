import { prisma } from "@/lib/prisma";
import { computeProgressiveTax, type GhanaPayeBand } from "@/lib/hr-ghana-statutory-core";

function localCalendarDayIndex(date: Date) {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

export function daysInclusive(start: Date, end: Date) {
  const s = localCalendarDayIndex(start);
  const e = localCalendarDayIndex(end);
  if (e < s) return 0;
  return e - s + 1;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function dayIndex(date: Date) {
  return localCalendarDayIndex(date);
}

function startDayIndex(date: Date | null | undefined) {
  if (!date) return null;
  return dayIndex(date);
}

export function computeGeneratedPayslipAmounts(input: {
  baseSalary: number;
  allowances: number;
  compensationDeductions: number;
  bonusValue: number;
  factor: number;
  taxPercent: number;
  pensionPercent: number;
}) {
  const gross = round2((input.baseSalary + input.allowances + input.bonusValue) * input.factor);
  const tax = round2((gross * input.taxPercent) / 100);
  const pension = round2((gross * input.pensionPercent) / 100);
  const proratedCompensationDeductions = round2(input.compensationDeductions * input.factor);
  const calculatedDeductions = round2(tax + pension + proratedCompensationDeductions);
  const deductions = round2(Math.min(gross, calculatedDeductions));
  const unappliedDeductions = round2(Math.max(0, calculatedDeductions - deductions));
  const net = round2(gross - deductions);
  const proratedBonus = round2(input.bonusValue * input.factor);
  const proratedAllowances = round2(input.allowances * input.factor);

  return {
    gross,
    net,
    tax,
    pension,
    deductions,
    calculatedDeductions,
    unappliedDeductions,
    proratedBonus,
    proratedAllowances,
    proratedCompensationDeductions,
  };
}

export function computeGeneratedGhanaPayslipAmounts(input: {
  baseSalary: number;
  allowances: number;
  compensationDeductions: number;
  bonusValue: number;
  factor: number;
  ssnitMode?: "percent" | "amount";
  taxMode?: "percent" | "amount";
  ssnitEmployeeRate: number;
  enablePaye?: boolean;
  enableSsnitEmployee?: boolean;
  enableSsnitEmployer?: boolean;
  ssnitEmployeeAmount?: number;
  ssnitEmployerRate?: number;
  taxableAllowancePercent?: number;
  taxPercent?: number;
  taxAmount?: number;
  payeBands: GhanaPayeBand[];
}) {
  const proratedBaseSalary = round2(input.baseSalary * input.factor);
  const gross = round2((input.baseSalary + input.allowances + input.bonusValue) * input.factor);
  const proratedAllowances = round2(input.allowances * input.factor);
  const taxableAllowances = round2(
    proratedAllowances * ((input.taxableAllowancePercent ?? 100) / 100),
  );
  const nonTaxableAllowances = round2(Math.max(0, proratedAllowances - taxableAllowances));
  const enableSsnitEmployee = input.enableSsnitEmployee !== false;
  const enableSsnitEmployer = input.enableSsnitEmployer !== false;
  const enablePaye = input.enablePaye !== false;
  const employeeSsnit =
    enableSsnitEmployee
      ? (input.ssnitMode ?? "percent") === "amount"
        ? round2((input.ssnitEmployeeAmount ?? 0) * input.factor)
        : round2((proratedBaseSalary * input.ssnitEmployeeRate) / 100)
      : 0;
  const chargeableIncome = round2(
    Math.max(0, proratedBaseSalary + taxableAllowances + round2(input.bonusValue * input.factor) - employeeSsnit),
  );
  const tax = enablePaye
    ? (input.taxMode ?? "percent") === "amount"
      ? round2((input.taxAmount ?? 0) * input.factor)
      : (input.taxPercent ?? null) != null
        ? round2((chargeableIncome * (input.taxPercent ?? 0)) / 100)
        : computeProgressiveTax(chargeableIncome, input.payeBands)
    : 0;
  const employerSsnit = enableSsnitEmployer
    ? round2((proratedBaseSalary * (input.ssnitEmployerRate ?? 0)) / 100)
    : 0;
  const pension = employeeSsnit;
  const proratedCompensationDeductions = round2(input.compensationDeductions * input.factor);
  const calculatedDeductions = round2(tax + pension + proratedCompensationDeductions);
  const deductions = round2(Math.min(gross, calculatedDeductions));
  const unappliedDeductions = round2(Math.max(0, calculatedDeductions - deductions));
  const net = round2(gross - deductions);
  const proratedBonus = round2(input.bonusValue * input.factor);

  return {
    gross,
    net,
    tax,
    pension,
    deductions,
    calculatedDeductions,
    unappliedDeductions,
    proratedBonus,
    proratedAllowances,
    proratedCompensationDeductions,
    chargeableIncome,
    employeeSsnit,
    employerSsnit,
    taxableAllowances,
    nonTaxableAllowances,
  };
}

type CompensationSliceInput = {
  effectiveDate: Date;
  baseSalary: number;
  allowances: number;
  deductions: number;
  bonus: number;
};

export function computeProratedPayslipFromCompensations(input: {
  activeStartDay: number;
  activeEndDay: number;
  periodTotalDays: number;
  taxPercent: number;
  pensionPercent: number;
  defaultBonus: number;
  statutory?: {
    mode: "ghana";
    enablePaye: boolean;
    enableSsnitEmployee: boolean;
    enableSsnitEmployer: boolean;
    ssnitEmployeeRate: number;
    ssnitEmployerRate: number;
    taxableAllowancePercent: number;
    payeBands: GhanaPayeBand[];
    manual?: {
      taxMode: "percent" | "amount";
      taxValue: number;
      ssnitMode: "percent" | "amount";
      ssnitValue: number;
    };
  };
  compensations: CompensationSliceInput[];
}) {
  if (input.activeEndDay < input.activeStartDay) return null;
  if (input.periodTotalDays <= 0) return null;
  if (!input.compensations.length) return null;

  const rows = input.compensations
    .map((row) => ({ ...row, effectiveDay: dayIndex(row.effectiveDate) }))
    .sort((a, b) => a.effectiveDay - b.effectiveDay);

  let pointer = -1;
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].effectiveDay <= input.activeStartDay) pointer = index;
    else break;
  }

  let cursorDay = input.activeStartDay;
  let totals = {
    gross: 0,
    net: 0,
    tax: 0,
    pension: 0,
    deductions: 0,
    calculatedDeductions: 0,
    unappliedDeductions: 0,
    allowances: 0,
    bonus: 0,
    compensationDeductions: 0,
    employerSsnit: 0,
    taxableAllowances: 0,
    nonTaxableAllowances: 0,
  };

  while (cursorDay <= input.activeEndDay) {
    if (pointer < 0) {
      pointer = rows.findIndex((entry) => entry.effectiveDay >= cursorDay);
      if (pointer < 0) break;
      cursorDay = Math.max(cursorDay, rows[pointer].effectiveDay);
      if (cursorDay > input.activeEndDay) break;
    }

    const current = rows[pointer];
    const next = rows[pointer + 1];
    const segmentEndDay =
      next && next.effectiveDay <= input.activeEndDay
        ? Math.max(cursorDay, next.effectiveDay - 1)
        : input.activeEndDay;
    const workedDays = segmentEndDay - cursorDay + 1;
    if (workedDays <= 0) break;

    const factor = workedDays / input.periodTotalDays;
    const bonusValue = current.bonus > 0 ? current.bonus : input.defaultBonus;
    const amounts =
      input.statutory?.mode === "ghana"
        ? computeGeneratedGhanaPayslipAmounts({
            baseSalary: current.baseSalary,
            allowances: current.allowances,
            compensationDeductions: current.deductions,
            bonusValue,
            factor,
            ssnitMode: input.statutory.manual?.ssnitMode,
            taxMode: input.statutory.manual?.taxMode,
            enablePaye: input.statutory.enablePaye,
            enableSsnitEmployee: input.statutory.enableSsnitEmployee,
            enableSsnitEmployer: input.statutory.enableSsnitEmployer,
            ssnitEmployeeRate: input.statutory.ssnitEmployeeRate,
            ssnitEmployeeAmount: input.statutory.manual?.ssnitValue,
            ssnitEmployerRate: input.statutory.ssnitEmployerRate,
            taxableAllowancePercent: input.statutory.taxableAllowancePercent,
            taxPercent:
              input.statutory.manual?.taxMode === "percent"
                ? input.statutory.manual.taxValue
                : undefined,
            taxAmount:
              input.statutory.manual?.taxMode === "amount"
                ? input.statutory.manual.taxValue
                : undefined,
            payeBands: input.statutory.payeBands,
          })
        : computeGeneratedPayslipAmounts({
            baseSalary: current.baseSalary,
            allowances: current.allowances,
            compensationDeductions: current.deductions,
            bonusValue,
            factor,
            taxPercent: input.taxPercent,
            pensionPercent: input.pensionPercent,
          });

    totals = {
      gross: round2(totals.gross + amounts.gross),
      net: round2(totals.net + amounts.net),
      tax: round2(totals.tax + amounts.tax),
      pension: round2(totals.pension + amounts.pension),
      deductions: round2(totals.deductions + amounts.deductions),
      calculatedDeductions: round2(totals.calculatedDeductions + amounts.calculatedDeductions),
      unappliedDeductions: round2(totals.unappliedDeductions + amounts.unappliedDeductions),
      allowances: round2(totals.allowances + amounts.proratedAllowances),
      bonus: round2(totals.bonus + amounts.proratedBonus),
      compensationDeductions: round2(
        totals.compensationDeductions + amounts.proratedCompensationDeductions,
      ),
      employerSsnit: round2(totals.employerSsnit + Number((amounts as { employerSsnit?: number }).employerSsnit || 0)),
      taxableAllowances: round2(
        totals.taxableAllowances + Number((amounts as { taxableAllowances?: number }).taxableAllowances || amounts.proratedAllowances),
      ),
      nonTaxableAllowances: round2(
        totals.nonTaxableAllowances + Number((amounts as { nonTaxableAllowances?: number }).nonTaxableAllowances || 0),
      ),
    };

    cursorDay = segmentEndDay + 1;
    while (pointer + 1 < rows.length && rows[pointer + 1].effectiveDay <= cursorDay) {
      pointer += 1;
    }
  }

  if (totals.gross <= 0 && totals.net <= 0 && totals.deductions <= 0) return null;
  return totals;
}

export async function generatePayslipsForRun(params: {
  payrollRunId: string;
  taxPercent: number;
  pensionPercent: number;
  bonus: number;
  statutory?: {
    mode: "ghana";
    enablePaye: boolean;
    enableSsnitEmployee: boolean;
    enableSsnitEmployer: boolean;
    ssnitEmployeeRate: number;
    ssnitEmployerRate: number;
    taxableAllowancePercent: number;
    payeBands: GhanaPayeBand[];
    manual?: {
      taxMode: "percent" | "amount";
      taxValue: number;
      ssnitMode: "percent" | "amount";
      ssnitValue: number;
    };
  };
  previewOnly?: boolean;
}) {
  const { payrollRunId, taxPercent, pensionPercent, bonus, statutory, previewOnly } = params;
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
  const periodStartDay = dayIndex(periodStart);
  const periodEndDay = dayIndex(periodEnd);
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
    orderBy: [{ employeeId: "asc" }, { effectiveDate: "asc" }],
  });

  const compensationByEmployee = new Map<string, Array<typeof compensationRows[number]>>();
  for (const row of compensationRows) {
    const list = compensationByEmployee.get(row.employeeId) ?? [];
    list.push(row);
    compensationByEmployee.set(row.employeeId, list);
  }

  const existingPayslips = await prisma.payslip.findMany({
    where: { payrollRunId: run.id },
    select: { id: true, employeeId: true },
  });
  const existingByEmployee = new Map(existingPayslips.map((p) => [p.employeeId, p.id]));

  const upsertData = [] as {
    payrollRunId: string;
    employeeId: string;
    grossPay: number;
    netPay: number;
    lineItems: Record<string, number>;
  }[];

  for (const employee of employees) {
    const compensationList = compensationByEmployee.get(employee.id);
    if (!compensationList?.length) continue;

    const hireDay = startDayIndex(employee.hireDate);
    const terminationDay = startDayIndex(employee.terminationDate);
    const activeStartDay = Math.max(periodStartDay, hireDay ?? periodStartDay);
    const activeEndDay = Math.min(periodEndDay, terminationDay ?? periodEndDay);
    if (activeEndDay < activeStartDay) continue;

    const totals = computeProratedPayslipFromCompensations({
      activeStartDay,
      activeEndDay,
      periodTotalDays: totalDays,
      taxPercent,
      pensionPercent,
      defaultBonus: bonus,
      statutory,
      compensations: compensationList.map((row) => ({
        effectiveDate: row.effectiveDate,
        baseSalary: Number(row.baseSalary || 0),
        allowances: Number(row.allowances || 0),
        deductions: Number(row.deductions || 0),
        bonus: Number(row.bonus || 0),
      })),
    });
    if (!totals) continue;

    upsertData.push({
      payrollRunId: run.id,
      employeeId: employee.id,
      grossPay: totals.gross,
      netPay: totals.net,
      lineItems: {
        tax: totals.tax,
        pension: totals.pension,
        bonus: totals.bonus,
        allowances: totals.allowances,
        taxableAllowances: totals.taxableAllowances,
        nonTaxableAllowances: totals.nonTaxableAllowances,
        employerSsnit: totals.employerSsnit,
        compensationDeductions: totals.compensationDeductions,
        deductions: totals.deductions,
        calculatedDeductions: totals.calculatedDeductions,
        unappliedDeductions: totals.unappliedDeductions,
        prorateFactor: round2((activeEndDay - activeStartDay + 1) / totalDays),
      },
    });
  }

  if (!upsertData.length) {
    return {
      created: 0,
      updated: 0,
      skipped: employees.length,
      updatedTotals: false,
      previewRows: [],
      previewCreated: 0,
      previewUpdated: 0,
    };
  }

  const previewRows = upsertData.map((row) => ({
    employeeId: row.employeeId,
    grossPay: row.grossPay,
    netPay: row.netPay,
    lineItems: row.lineItems,
  }));
  const previewCreated = upsertData.filter((row) => !existingByEmployee.has(row.employeeId)).length;
  const previewUpdated = upsertData.length - previewCreated;
  if (previewOnly) {
    return {
      created: 0,
      updated: 0,
      skipped: employees.length - upsertData.length,
      updatedTotals: false,
      previewRows,
      previewCreated,
      previewUpdated,
    };
  }

  let created = 0;
  let updated = 0;
  await prisma.$transaction(
    upsertData.map((entry) => {
      const existingId = existingByEmployee.get(entry.employeeId);
      if (existingId) {
        updated += 1;
        return prisma.payslip.update({
          where: { id: existingId },
          data: {
            grossPay: entry.grossPay,
            netPay: entry.netPay,
            lineItems: entry.lineItems,
          },
        });
      }
      created += 1;
      return prisma.payslip.create({ data: entry });
    }),
  );

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

  return {
    created,
    updated,
    skipped: employees.length - upsertData.length,
    updatedTotals: true,
    previewRows,
    previewCreated,
    previewUpdated,
  };
}
