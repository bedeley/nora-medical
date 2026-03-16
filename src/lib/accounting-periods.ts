import { prisma } from "@/lib/prisma";

export type MonthlyCloseRow = {
  month: string;
  closedAt: string;
  closedById?: string | null;
  closedByName?: string | null;
  note?: string | null;
};

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseDateOnlyInput(value: string) {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const [yearText, monthText, dayText] = trimmed.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const normalized = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function isValidMonthKey(month: string) {
  return MONTH_KEY_RE.test(String(month || "").trim());
}

export function toMonthKey(date: Date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function parseMonthlyCloseRows(value: unknown): MonthlyCloseRow[] {
  if (!Array.isArray(value)) return [];
  const out: MonthlyCloseRow[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const month = String((row as { month?: unknown }).month || "").trim();
    if (!isValidMonthKey(month) || seen.has(month)) continue;
    seen.add(month);
    out.push({
      month,
      closedAt: String((row as { closedAt?: unknown }).closedAt || new Date().toISOString()),
      closedById: (row as { closedById?: unknown }).closedById ? String((row as { closedById?: unknown }).closedById) : null,
      closedByName: (row as { closedByName?: unknown }).closedByName ? String((row as { closedByName?: unknown }).closedByName) : null,
      note: (row as { note?: unknown }).note ? String((row as { note?: unknown }).note) : null,
    });
  }
  out.sort((a, b) => b.month.localeCompare(a.month));
  return out;
}

export async function loadMonthlyCloseRows() {
  const setting = await prisma.appSetting.findUnique({
    where: { key: "accounting.monthlyClose.closedMonths" },
    select: { value: true },
  });
  return parseMonthlyCloseRows(setting?.value ?? null);
}

export async function saveMonthlyCloseRows(rows: MonthlyCloseRow[]) {
  const normalized = parseMonthlyCloseRows(rows);
  await prisma.appSetting.upsert({
    where: { key: "accounting.monthlyClose.closedMonths" },
    update: { value: normalized },
    create: { key: "accounting.monthlyClose.closedMonths", value: normalized },
  });
  return normalized;
}

export function normalizeFiscalPeriodDateRange(startDateText: string, endDateText: string) {
  const startInput = parseDateOnlyInput(startDateText);
  const endInput = parseDateOnlyInput(endDateText);
  if (!startInput || !endInput) {
    return { error: "Use date format YYYY-MM-DD." as const };
  }

  const start = new Date(Date.UTC(startInput.year, startInput.month - 1, startInput.day, 0, 0, 0, 0));
  const end = new Date(Date.UTC(endInput.year, endInput.month - 1, endInput.day, 23, 59, 59, 999));

  if (start.getTime() > end.getTime()) {
    return { error: "Start date must be before end date." as const };
  }

  return { start, end };
}

export async function findClosedPeriod(date: Date) {
  const fiscalClosed = await prisma.fiscalPeriod.findFirst({
    where: {
      startDate: { lte: date },
      endDate: { gte: date },
      status: "CLOSED",
    },
    select: { id: true, name: true },
  });
  if (fiscalClosed) return fiscalClosed;

  const monthKey = toMonthKey(date);
  const monthlyRows = await loadMonthlyCloseRows();
  const monthlyClosed = monthlyRows.some((row) => row.month === monthKey);
  if (monthlyClosed) {
    return {
      id: `MONTH:${monthKey}`,
      name: `Monthly close ${monthKey}`,
    };
  }
  return null;
}

export async function ensureDefaultOpenFiscalPeriod(anchorDate: Date = new Date()) {
  const existingCovering = await prisma.fiscalPeriod.findFirst({
    where: {
      startDate: { lte: anchorDate },
      endDate: { gte: anchorDate },
    },
    orderBy: { startDate: "desc" },
  });
  if (existingCovering) return existingCovering;

  const periodCount = await prisma.fiscalPeriod.count();
  if (periodCount > 0) return null;

  const year = anchorDate.getUTCFullYear();
  const startDate = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

  return prisma.fiscalPeriod.create({
    data: {
      name: `${year} Fiscal Year`,
      startDate,
      endDate,
      status: "OPEN",
    },
  });
}
