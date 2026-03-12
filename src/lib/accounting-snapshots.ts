import { prisma } from "@/lib/prisma";
import { loadAccountTotals, parseDateRange, toNet } from "@/app/api/admin/accounting/reports/utils";

export async function buildPeriodSnapshot(periodId: string) {
  const period = await prisma.fiscalPeriod.findUnique({
    where: { id: periodId },
  });
  if (!period) return null;

  const totals = await loadAccountTotals(parseDateRange(period.startDate.toISOString(), period.endDate.toISOString()));

  const income = totals.filter((row) => row.type === "INCOME").map((row) => ({
    code: row.code,
    name: row.name,
    amount: row.credit - row.debit,
  }));
  const expenses = totals.filter((row) => row.type === "EXPENSE").map((row) => ({
    code: row.code,
    name: row.name,
    amount: row.debit - row.credit,
  }));
  const incomeTotal = income.reduce((sum, row) => sum + row.amount, 0);
  const expenseTotal = expenses.reduce((sum, row) => sum + row.amount, 0);
  const netProfit = incomeTotal - expenseTotal;

  const asOfTotals = await loadAccountTotals(parseDateRange(null, period.endDate.toISOString()));
  const assets = asOfTotals.filter((row) => row.type === "ASSET").map((row) => ({
    code: row.code,
    name: row.name,
    balance: toNet(row),
  }));
  const liabilities = asOfTotals.filter((row) => row.type === "LIABILITY").map((row) => ({
    code: row.code,
    name: row.name,
    balance: toNet(row),
  }));
  const equity = asOfTotals.filter((row) => row.type === "EQUITY").map((row) => ({
    code: row.code,
    name: row.name,
    balance: toNet(row),
  }));
  const assetsTotal = assets.reduce((sum, row) => sum + row.balance, 0);
  const liabilitiesTotal = liabilities.reduce((sum, row) => sum + row.balance, 0);
  const equityTotal = equity.reduce((sum, row) => sum + row.balance, 0);

  return {
    period: {
      id: period.id,
      name: period.name,
      startDate: period.startDate,
      endDate: period.endDate,
    },
    generatedAt: new Date(),
    profitAndLoss: {
      income,
      expenses,
      incomeTotal,
      expenseTotal,
      netProfit,
    },
    balanceSheet: {
      assets,
      liabilities,
      equity,
      totals: {
        assets: assetsTotal,
        liabilities: liabilitiesTotal,
        equity: equityTotal,
        liabilitiesPlusEquity: liabilitiesTotal + equityTotal,
      },
      asOf: period.endDate,
    },
  };
}
