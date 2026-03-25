import { prisma } from "@/lib/prisma";

export type AccountTotals = {
  accountId: string;
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  subtype?: string | null;
  debit: number;
  credit: number;
};

type DateFilter = { gte?: Date; lte?: Date };
type ParsedRange = {
  dateFilter: DateFilter;
  normalizedStart: string | null;
  normalizedEnd: string | null;
};

function parseBoundaryDate(value: string, boundary: "start" | "end") {
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const monthIndex = Number(dateOnlyMatch[2]) - 1;
    const day = Number(dateOnlyMatch[3]);
    if (boundary === "start") {
      return new Date(year, monthIndex, day, 0, 0, 0, 0);
    }
    return new Date(year, monthIndex, day, 23, 59, 59, 999);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export const parseDateRange = (start?: string | null, end?: string | null) => {
  const range: DateFilter = {};
  if (start) {
    const parsedStart = parseBoundaryDate(start, "start");
    if (parsedStart) range.gte = parsedStart;
  }
  if (end) {
    const parsedEnd = parseBoundaryDate(end, "end");
    if (parsedEnd) range.lte = parsedEnd;
  }
  return range;
};

function normalizeDateLabel(value: string, parsed: Date) {
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (dateOnlyMatch) return value.trim();
  return parsed.toISOString().slice(0, 10);
}

export function parseValidatedDateRange(start?: string | null, end?: string | null): ParsedRange {
  const normalizedStartValue = typeof start === "string" ? start.trim() : "";
  const normalizedEndValue = typeof end === "string" ? end.trim() : "";

  const parsedStart = normalizedStartValue ? parseBoundaryDate(normalizedStartValue, "start") : null;
  if (normalizedStartValue && !parsedStart) {
    throw new Error("Start date is invalid. Use YYYY-MM-DD.");
  }

  const parsedEnd = normalizedEndValue ? parseBoundaryDate(normalizedEndValue, "end") : null;
  if (normalizedEndValue && !parsedEnd) {
    throw new Error("End date is invalid. Use YYYY-MM-DD.");
  }

  if (parsedStart && parsedEnd && parsedEnd.getTime() < parsedStart.getTime()) {
    throw new Error("End date cannot be earlier than start date.");
  }

  return {
    dateFilter: {
      ...(parsedStart ? { gte: parsedStart } : {}),
      ...(parsedEnd ? { lte: parsedEnd } : {}),
    },
    normalizedStart: parsedStart ? normalizeDateLabel(normalizedStartValue, parsedStart) : null,
    normalizedEnd: parsedEnd ? normalizeDateLabel(normalizedEndValue, parsedEnd) : null,
  };
}

export const loadAccountTotals = async (dateFilter?: DateFilter) => {
  const lines = await prisma.journalLine.findMany({
    where: {
      entry: {
        status: "POSTED",
        entryDate: dateFilter && (dateFilter.gte || dateFilter.lte) ? dateFilter : undefined,
      },
    },
    include: {
      account: true,
    },
  });

  const map = new Map<string, AccountTotals>();
  for (const line of lines) {
    const account = line.account;
    const existing = map.get(account.id) || {
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      subtype: account.subtype,
      debit: 0,
      credit: 0,
    };
    existing.debit += Number(line.debit || 0);
    existing.credit += Number(line.credit || 0);
    map.set(account.id, existing);
  }

  return Array.from(map.values()).sort((a, b) => a.code.localeCompare(b.code));
};

export const toNet = (acct: AccountTotals) => {
  if (acct.type === "ASSET" || acct.type === "EXPENSE") {
    return acct.debit - acct.credit;
  }
  return acct.credit - acct.debit;
};
