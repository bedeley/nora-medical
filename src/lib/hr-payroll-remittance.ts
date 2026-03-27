import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type RemittanceStatus = "PENDING" | "REMITTED";

export type PayrollRemittanceState = {
  payeStatus: RemittanceStatus;
  ssnitStatus: RemittanceStatus;
  payeRemittedAt: string | null;
  ssnitRemittedAt: string | null;
  payePaymentMethod: "BANK" | "CASH" | null;
  ssnitPaymentMethod: "BANK" | "CASH" | null;
  payeReference: string | null;
  ssnitReference: string | null;
  notes: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type MonthlyStatutorySummary = {
  monthKey: string;
  periodStart: string;
  periodEnd: string;
  runCount: number;
  payslipCount: number;
  employeeCount: number;
  totalGross: number;
  totalNet: number;
  payeTax: number;
  ssnitEmployee: number;
  ssnitEmployer: number;
  otherDeductions: number;
  remittance: PayrollRemittanceState;
};

export type MonthlyStatutoryEmployeeBreakdownRow = {
  payrollRunId: string;
  employeeId: string;
  employeeName: string;
  email: string | null;
  department: string | null;
  position: string | null;
  grossPay: number;
  payeTax: number;
  ssnitEmployee: number;
  ssnitEmployer: number;
  ssnitTotal: number;
};

export type StatutoryTotalsInput = {
  grossPay: number;
  netPay: number;
  lineItems?: Record<string, unknown> | null;
};

export type StatutoryTotals = {
  payeTax: number;
  ssnitEmployee: number;
  ssnitEmployer: number;
  otherDeductions: number;
  totalGross: number;
  totalNet: number;
};

type RemittanceStateInput = Partial<PayrollRemittanceState>;

const REMITTANCE_KEY_PREFIX = "hr.payroll.remittance.";

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function toFiniteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asIsoOrNull(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function asStringOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function computeStatutoryTotals(rows: StatutoryTotalsInput[]): StatutoryTotals {
  const totalGross = round2(rows.reduce((sum, row) => sum + toFiniteNumber(row.grossPay), 0));
  const totalNet = round2(rows.reduce((sum, row) => sum + toFiniteNumber(row.netPay), 0));
  const payeTax = round2(
    rows.reduce((sum, row) => sum + toFiniteNumber((row.lineItems || {})["tax"]), 0),
  );
  const ssnitEmployee = round2(
    rows.reduce((sum, row) => sum + toFiniteNumber((row.lineItems || {})["pension"]), 0),
  );
  const ssnitEmployer = round2(
    rows.reduce((sum, row) => sum + toFiniteNumber((row.lineItems || {})["employerSsnit"]), 0),
  );
  const otherDeductions = round2(Math.max(0, totalGross - totalNet - payeTax - ssnitEmployee));
  return {
    payeTax,
    ssnitEmployee,
    ssnitEmployer,
    otherDeductions,
    totalGross,
    totalNet,
  };
}

export function payrollMonthKey(year: number, month: number) {
  const safeYear = Number(year);
  const safeMonth = Number(month);
  return `${safeYear}-${String(safeMonth).padStart(2, "0")}`;
}

export function payrollMonthRange(year: number, month: number) {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

export function remittanceSettingKey(monthKey: string) {
  return `${REMITTANCE_KEY_PREFIX}${monthKey}`;
}

function defaultRemittanceState(): PayrollRemittanceState {
  return {
    payeStatus: "PENDING",
    ssnitStatus: "PENDING",
    payeRemittedAt: null,
    ssnitRemittedAt: null,
    payePaymentMethod: null,
    ssnitPaymentMethod: null,
    payeReference: null,
    ssnitReference: null,
    notes: null,
    updatedBy: null,
    updatedAt: null,
  };
}

function normalizeRemittanceState(value: unknown): PayrollRemittanceState {
  const state = defaultRemittanceState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return state;
  const row = value as Record<string, unknown>;
  const payeStatus = row.payeStatus === "REMITTED" ? "REMITTED" : "PENDING";
  const ssnitStatus = row.ssnitStatus === "REMITTED" ? "REMITTED" : "PENDING";
  const payePaymentMethod = row.payePaymentMethod === "CASH" ? "CASH" : row.payePaymentMethod === "BANK" ? "BANK" : null;
  const ssnitPaymentMethod = row.ssnitPaymentMethod === "CASH" ? "CASH" : row.ssnitPaymentMethod === "BANK" ? "BANK" : null;
  return {
    payeStatus,
    ssnitStatus,
    payeRemittedAt: asIsoOrNull(row.payeRemittedAt),
    ssnitRemittedAt: asIsoOrNull(row.ssnitRemittedAt),
    payePaymentMethod,
    ssnitPaymentMethod,
    payeReference: asStringOrNull(row.payeReference),
    ssnitReference: asStringOrNull(row.ssnitReference),
    notes: asStringOrNull(row.notes),
    updatedBy: asStringOrNull(row.updatedBy),
    updatedAt: asIsoOrNull(row.updatedAt),
  };
}

export async function getMonthlyRemittanceState(monthKey: string) {
  const row = await prisma.siteSetting.findUnique({
    where: { key: remittanceSettingKey(monthKey) },
    select: { value: true },
  });
  return normalizeRemittanceState(row?.value ?? null);
}

export async function saveMonthlyRemittanceState(monthKey: string, input: RemittanceStateInput) {
  const current = await getMonthlyRemittanceState(monthKey);
  const next: PayrollRemittanceState = {
    ...current,
    ...input,
    updatedAt: new Date().toISOString(),
  };
  await prisma.siteSetting.upsert({
    where: { key: remittanceSettingKey(monthKey) },
    update: { value: next },
    create: { key: remittanceSettingKey(monthKey), value: next },
  });
  return next;
}

export async function getMonthlyStatutorySummary(year: number, month: number): Promise<MonthlyStatutorySummary> {
  const monthKey = payrollMonthKey(year, month);
  const { start, end } = payrollMonthRange(year, month);
  const runs = await prisma.payrollRun.findMany({
    where: {
      periodStart: { gte: start, lte: end },
      periodEnd: { gte: start, lte: end },
      status: { in: ["FINALIZED", "PAID"] },
      runType: { in: ["REGULAR", "ADJUSTMENT"] },
    },
    select: {
      id: true,
      totalGross: true,
      totalNet: true,
    },
  });
  const runIds = runs.map((run) => run.id);
  const payslips = runIds.length
    ? await prisma.payslip.findMany({
        where: { payrollRunId: { in: runIds } },
        select: {
          employeeId: true,
          grossPay: true,
          netPay: true,
          lineItems: true,
        },
      })
    : [];

  const totals = computeStatutoryTotals(
    payslips.map((slip) => ({
      grossPay: toFiniteNumber(slip.grossPay),
      netPay: toFiniteNumber(slip.netPay),
      lineItems: slip.lineItems as Record<string, unknown> | null | undefined,
    })),
  );
  const totalGross = round2(
    runs.reduce((sum, run) => sum + toFiniteNumber(run.totalGross), 0) || totals.totalGross,
  );
  const totalNet = round2(
    runs.reduce((sum, run) => sum + toFiniteNumber(run.totalNet), 0) || totals.totalNet,
  );
  const remittance = await getMonthlyRemittanceState(monthKey);

  return {
    monthKey,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    runCount: runs.length,
    payslipCount: payslips.length,
    employeeCount: new Set(payslips.map((slip) => slip.employeeId)).size,
    totalGross,
    totalNet,
    payeTax: totals.payeTax,
    ssnitEmployee: totals.ssnitEmployee,
    ssnitEmployer: totals.ssnitEmployer,
    otherDeductions: totals.otherDeductions,
    remittance,
  };
}

export async function listRecentMonthlyStatutorySummaries(opts?: { months?: number; anchorDate?: Date }) {
  const months = Math.min(24, Math.max(1, Number(opts?.months || 12)));
  const anchorDate = opts?.anchorDate || new Date();
  const rows: MonthlyStatutorySummary[] = [];
  for (let offset = 0; offset < months; offset += 1) {
    const cursor = new Date(anchorDate.getFullYear(), anchorDate.getMonth() - offset, 1);
    rows.push(await getMonthlyStatutorySummary(cursor.getFullYear(), cursor.getMonth() + 1));
  }
  return rows;
}

export async function getMonthlyStatutoryEmployeeBreakdown(
  year: number,
  month: number,
): Promise<MonthlyStatutoryEmployeeBreakdownRow[]> {
  const { start, end } = payrollMonthRange(year, month);
  const runs = await prisma.payrollRun.findMany({
    where: {
      periodStart: { gte: start, lte: end },
      periodEnd: { gte: start, lte: end },
      status: { in: ["FINALIZED", "PAID"] },
      runType: { in: ["REGULAR", "ADJUSTMENT"] },
    },
    select: { id: true },
  });
  const runIds = runs.map((run) => run.id);
  if (runIds.length === 0) return [];

  const payslips = await prisma.payslip.findMany({
    where: { payrollRunId: { in: runIds } },
    select: {
      payrollRunId: true,
      employeeId: true,
      grossPay: true,
      lineItems: true,
      employee: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          department: true,
          position: true,
        },
      },
    },
  });

  const grouped = new Map<string, MonthlyStatutoryEmployeeBreakdownRow>();
  for (const slip of payslips) {
    const lineItems = (slip.lineItems as Record<string, unknown> | null | undefined) || {};
    const grossPay = round2(Math.max(0, Number(slip.grossPay || 0)));
    const payeTax = round2(Math.max(0, Number(lineItems.tax || 0)));
    const ssnitEmployee = round2(Math.max(0, Number(lineItems.pension || 0)));
    const ssnitEmployer = round2(Math.max(0, Number(lineItems.employerSsnit || 0)));
    const existing = grouped.get(slip.employeeId);
    const employeeName = `${String(slip.employee?.firstName || "").trim()} ${String(slip.employee?.lastName || "").trim()}`.trim();
    if (!existing) {
      grouped.set(slip.employeeId, {
        payrollRunId: slip.payrollRunId,
        employeeId: slip.employeeId,
        employeeName: employeeName || "Unknown employee",
        email: slip.employee?.email || null,
        department: slip.employee?.department || null,
        position: slip.employee?.position || null,
        grossPay,
        payeTax,
        ssnitEmployee,
        ssnitEmployer,
        ssnitTotal: round2(ssnitEmployee + ssnitEmployer),
      });
      continue;
    }
    existing.grossPay = round2(existing.grossPay + grossPay);
    existing.payeTax = round2(existing.payeTax + payeTax);
    existing.ssnitEmployee = round2(existing.ssnitEmployee + ssnitEmployee);
    existing.ssnitEmployer = round2(existing.ssnitEmployer + ssnitEmployer);
    existing.ssnitTotal = round2(existing.ssnitEmployee + existing.ssnitEmployer);
  }

  return Array.from(grouped.values()).sort((a, b) => {
    if (b.ssnitTotal !== a.ssnitTotal) return b.ssnitTotal - a.ssnitTotal;
    return a.employeeName.localeCompare(b.employeeName);
  });
}

export async function getHrPayrollRemittancePolicy() {
  const row = await prisma.siteSetting.findUnique({
    where: { key: "hr.payroll.remittance.requireReference" },
    select: { value: true },
  });
  return {
    requireReference: Boolean(row?.value === true),
  };
}

export async function recordRemittanceFiledSnapshot(input: {
  monthKey: string;
  liability: "PAYE" | "SSNIT";
  paymentMethod: "BANK" | "CASH";
  reference: string | null;
  remittedAtIso: string;
  actorId: string;
  scheduleRows: Prisma.InputJsonObject[];
  totalAmount: number;
}) {
  const key = `hr.payroll.remittance.filed.${input.monthKey}.${input.liability}`;
  const value: Prisma.InputJsonObject = {
    monthKey: input.monthKey,
    liability: input.liability,
    paymentMethod: input.paymentMethod,
    reference: input.reference,
    remittedAt: input.remittedAtIso,
    actorId: input.actorId,
    totalAmount: Number(input.totalAmount || 0),
    employeeCount: input.scheduleRows.length,
    scheduleRows: input.scheduleRows,
    createdAt: new Date().toISOString(),
  };
  try {
    await prisma.siteSetting.create({
      data: { key, value },
    });
  } catch {
    // immutable snapshot: keep first write only
  }
}
