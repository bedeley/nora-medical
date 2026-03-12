import { prisma } from "@/lib/prisma";

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
  return prisma.fiscalPeriod.findFirst({
    where: {
      startDate: { lte: date },
      endDate: { gte: date },
      status: "CLOSED",
    },
    select: { id: true, name: true },
  });
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
