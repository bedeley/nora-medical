import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveBalanceSheetAsOf } from "@/lib/balance-sheet-report-utils";
import { loadAccountTotals, parseDateRange, toNet } from "../utils";

const DEFAULT_ROW_LIMIT = 500;
const MAX_ROW_LIMIT = 2000;
type SortBy = "code" | "name" | "balance";
type SortDir = "asc" | "desc";

function normalizeSortBy(value: string | null): SortBy {
  const key = String(value || "").trim().toLowerCase();
  if (key === "name" || key === "balance") return key;
  return "code";
}

function normalizeSortDir(value: string | null): SortDir {
  return String(value || "").trim().toLowerCase() === "desc" ? "desc" : "asc";
}

function sortRows<T extends { code: string; name: string; debit: number; credit: number }>(
  rows: T[],
  sortBy: SortBy,
  sortDir: SortDir,
  section: "ASSET" | "LIABILITY" | "EQUITY",
) {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sortBy === "name") return a.name.localeCompare(b.name) * direction;
    if (sortBy === "balance") {
      const aNet = section === "ASSET" ? a.debit - a.credit : a.credit - a.debit;
      const bNet = section === "ASSET" ? b.debit - b.credit : b.credit - b.debit;
      return (aNet - bNet) * direction;
    }
    return a.code.localeCompare(b.code) * direction;
  });
}

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const asOf = searchParams.get("asOf");
  const sortBy = normalizeSortBy(searchParams.get("sortBy"));
  const sortDir = normalizeSortDir(searchParams.get("sortDir"));
  const requestedRowLimit = Number(searchParams.get("rows") || DEFAULT_ROW_LIMIT);
  const rowLimit = Number.isFinite(requestedRowLimit)
    ? Math.max(50, Math.min(MAX_ROW_LIMIT, Math.floor(requestedRowLimit)))
    : DEFAULT_ROW_LIMIT;
  const defaultAsOf = new Date().toISOString().slice(0, 10);
  const parsed = resolveBalanceSheetAsOf(asOf, defaultAsOf);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const asOfEffective = parsed.asOf;
  const dateFilter = parseDateRange(null, asOfEffective);
  const totals = await loadAccountTotals(dateFilter);
  const asOfDate = new Date(`${asOfEffective}T00:00:00`);
  const currentPeriod = await prisma.fiscalPeriod.findFirst({
    where: {
      startDate: { lte: asOfDate },
      endDate: { gte: asOfDate },
    },
    orderBy: { startDate: "desc" },
  });

  const assetsAll = totals.filter((row) => row.type === "ASSET");
  const liabilitiesAll = totals.filter((row) => row.type === "LIABILITY");
  const equityAll = totals.filter((row) => row.type === "EQUITY");
  const income = totals.filter((row) => row.type === "INCOME");
  const expenses = totals.filter((row) => row.type === "EXPENSE");

  const assetTotal = assetsAll.reduce((sum, row) => sum + toNet(row), 0);
  const liabilityTotal = liabilitiesAll.reduce((sum, row) => sum + toNet(row), 0);
  const equityTotal = equityAll.reduce((sum, row) => sum + toNet(row), 0);
  const incomeTotal = income.reduce((sum, row) => sum + toNet(row), 0);
  const expenseTotal = expenses.reduce((sum, row) => sum + toNet(row), 0);
  const netIncomeToDate = incomeTotal - expenseTotal;
  let currentPeriodNetIncome = 0;
  if (currentPeriod) {
    const periodTotals = await loadAccountTotals(
      parseDateRange(currentPeriod.startDate.toISOString(), currentPeriod.endDate.toISOString()),
    );
    const periodIncome = periodTotals.filter((row) => row.type === "INCOME");
    const periodExpenses = periodTotals.filter((row) => row.type === "EXPENSE");
    const periodIncomeTotal = periodIncome.reduce((sum, row) => sum + toNet(row), 0);
    const periodExpenseTotal = periodExpenses.reduce((sum, row) => sum + toNet(row), 0);
    currentPeriodNetIncome = periodIncomeTotal - periodExpenseTotal;
  }
  const retainedEarnings = netIncomeToDate - currentPeriodNetIncome;
  const equityWithEarningsAll = [
    ...equityAll,
    {
      accountId: "retained-earnings",
      code: "RE",
      name: "Retained Earnings",
      type: "EQUITY",
      debit: retainedEarnings < 0 ? Math.abs(retainedEarnings) : 0,
      credit: retainedEarnings > 0 ? retainedEarnings : 0,
    },
    {
      accountId: "current-period-profit",
      code: "CPL",
      name: "Current Period Profit/Loss",
      type: "EQUITY",
      debit: currentPeriodNetIncome < 0 ? Math.abs(currentPeriodNetIncome) : 0,
      credit: currentPeriodNetIncome > 0 ? currentPeriodNetIncome : 0,
    },
  ];
  const assetsSorted = sortRows(assetsAll, sortBy, sortDir, "ASSET");
  const liabilitiesSorted = sortRows(liabilitiesAll, sortBy, sortDir, "LIABILITY");
  const equityWithEarningsSorted = sortRows(equityWithEarningsAll, sortBy, sortDir, "EQUITY");
  const assets = assetsSorted.slice(0, rowLimit);
  const liabilities = liabilitiesSorted.slice(0, rowLimit);
  const equityWithEarnings = equityWithEarningsSorted.slice(0, rowLimit);
  const rowsTruncated =
    assetsAll.length > assets.length ||
    liabilitiesAll.length > liabilities.length ||
    equityWithEarningsAll.length > equityWithEarnings.length;
  const equityWithEarningsTotal = equityTotal + netIncomeToDate;

  return NextResponse.json(
    {
      asOf: asOfEffective,
      assets,
      liabilities,
      equity: equityWithEarnings,
      totals: {
        assets: assetTotal,
        liabilities: liabilityTotal,
        equity: equityWithEarningsTotal,
        liabilitiesPlusEquity: liabilityTotal + equityWithEarningsTotal,
      },
      rowLimit,
      rowsTruncated,
      rowCounts: {
        assets: { returned: assets.length, total: assetsAll.length },
        liabilities: { returned: liabilities.length, total: liabilitiesAll.length },
        equity: { returned: equityWithEarnings.length, total: equityWithEarningsAll.length },
      },
      sort: { by: sortBy, dir: sortDir },
    },
    {
      headers: {
        "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
      },
    },
  );
}
