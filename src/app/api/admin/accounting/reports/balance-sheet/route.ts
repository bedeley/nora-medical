import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadAccountTotals, parseDateRange, toNet } from "../utils";

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
  const dateFilter = parseDateRange(null, asOf || new Date().toISOString());
  const totals = await loadAccountTotals(dateFilter);
  const asOfDate = new Date(asOf || new Date().toISOString());
  const currentPeriod = await prisma.fiscalPeriod.findFirst({
    where: {
      startDate: { lte: asOfDate },
      endDate: { gte: asOfDate },
    },
    orderBy: { startDate: "desc" },
  });

  const assets = totals.filter((row) => row.type === "ASSET");
  const liabilities = totals.filter((row) => row.type === "LIABILITY");
  const equity = totals.filter((row) => row.type === "EQUITY");
  const income = totals.filter((row) => row.type === "INCOME");
  const expenses = totals.filter((row) => row.type === "EXPENSE");

  const assetTotal = assets.reduce((sum, row) => sum + toNet(row), 0);
  const liabilityTotal = liabilities.reduce((sum, row) => sum + toNet(row), 0);
  const equityTotal = equity.reduce((sum, row) => sum + toNet(row), 0);
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
  const equityWithEarnings = [
    ...equity,
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
  const equityWithEarningsTotal = equityTotal + netIncomeToDate;

  return NextResponse.json({
    asOf: asOf || new Date().toISOString(),
    assets,
    liabilities,
    equity: equityWithEarnings,
    totals: {
      assets: assetTotal,
      liabilities: liabilityTotal,
      equity: equityWithEarningsTotal,
      liabilitiesPlusEquity: liabilityTotal + equityWithEarningsTotal,
    },
  });
}
