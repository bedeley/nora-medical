import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { loadAccountTotals, parseDateRange, parseValidatedDateRange, toNet, type AccountTotals } from "../../utils";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const escapeCsv = (value: string) => {
  if (!value) return "";
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};

const asCsv = (rows: Array<Array<string | number>>) =>
  rows
    .map((row) => row.map((value) => escapeCsv(String(value))).join(","))
    .join("\n");

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const asOf = searchParams.get("asOf");
  const fromJob = searchParams.get("job") === "1";

  let parsedPlRange: ReturnType<typeof parseValidatedDateRange>;
  let parsedAsOfRange: ReturnType<typeof parseValidatedDateRange>;
  try {
    parsedPlRange = parseValidatedDateRange(start, end);
    parsedAsOfRange = parseValidatedDateRange(null, asOf || end || new Date().toISOString().slice(0, 10));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid date range.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!fromJob && parsedPlRange.normalizedStart && parsedPlRange.normalizedEnd) {
    const startDate = new Date(`${parsedPlRange.normalizedStart}T00:00:00`);
    const endDate = new Date(`${parsedPlRange.normalizedEnd}T00:00:00`);
    const dayMs = 24 * 60 * 60 * 1000;
    const spanDays = Math.floor((endDate.getTime() - startDate.getTime()) / dayMs) + 1;
    if (spanDays > 366) {
      return NextResponse.json(
        { error: "Range is large. Use the queued export job option for better performance." },
        { status: 413 },
      );
    }
  }

  const generatedAt = new Date().toISOString();
  const asOfEffective = parsedAsOfRange.normalizedEnd || new Date().toISOString().slice(0, 10);

  const plTotals = await loadAccountTotals(parsedPlRange.dateFilter);
  const plIncome = plTotals.filter((row) => row.type === "INCOME");
  const plExpenses = plTotals.filter((row) => row.type === "EXPENSE");
  const plIncomeTotal = plIncome.reduce((sum, row) => sum + (row.credit - row.debit), 0);
  const plExpenseTotal = plExpenses.reduce((sum, row) => sum + (row.debit - row.credit), 0);
  const plNet = plIncomeTotal - plExpenseTotal;

  const tbTotals = plTotals;
  const tbSummary = tbTotals.reduce(
    (acc, row) => {
      acc.debit += row.debit;
      acc.credit += row.credit;
      return acc;
    },
    { debit: 0, credit: 0 },
  );

  const bsTotals = await loadAccountTotals(parseDateRange(null, asOfEffective));
  const bsAsOfDate = new Date(asOfEffective);
  const currentPeriod = await prisma.fiscalPeriod.findFirst({
    where: {
      startDate: { lte: bsAsOfDate },
      endDate: { gte: bsAsOfDate },
    },
    orderBy: { startDate: "desc" },
  });

  const bsAssets = bsTotals.filter((row) => row.type === "ASSET");
  const bsLiabilities = bsTotals.filter((row) => row.type === "LIABILITY");
  const bsEquity = bsTotals.filter((row) => row.type === "EQUITY");
  const bsIncome = bsTotals.filter((row) => row.type === "INCOME");
  const bsExpenses = bsTotals.filter((row) => row.type === "EXPENSE");

  const assetTotal = bsAssets.reduce((sum, row) => sum + toNet(row), 0);
  const liabilityTotal = bsLiabilities.reduce((sum, row) => sum + toNet(row), 0);
  const equityTotal = bsEquity.reduce((sum, row) => sum + toNet(row), 0);
  const incomeTotal = bsIncome.reduce((sum, row) => sum + toNet(row), 0);
  const expenseTotal = bsExpenses.reduce((sum, row) => sum + toNet(row), 0);
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
  const equityWithEarnings: AccountTotals[] = [
    ...bsEquity,
    {
      accountId: "retained-earnings",
      code: "RE",
      name: "Retained Earnings",
      debit: retainedEarnings < 0 ? Math.abs(retainedEarnings) : 0,
      credit: retainedEarnings > 0 ? retainedEarnings : 0,
      type: "EQUITY",
    },
    {
      accountId: "current-period-profit",
      code: "CPL",
      name: "Current Period Profit/Loss",
      debit: currentPeriodNetIncome < 0 ? Math.abs(currentPeriodNetIncome) : 0,
      credit: currentPeriodNetIncome > 0 ? currentPeriodNetIncome : 0,
      type: "EQUITY",
    },
  ];
  const equityWithEarningsTotal = equityTotal + netIncomeToDate;

  const rows: Array<Array<string | number>> = [
    ["REPORTING PACK", "Noralls Medical Supplies"],
    ["Generated At (UTC)", generatedAt],
    ["P&L Start", parsedPlRange.normalizedStart || ""],
    ["P&L End", parsedPlRange.normalizedEnd || ""],
    ["Balance Sheet As Of", asOfEffective],
    [],
    ["PROFIT & LOSS"],
    ["Section", "Code", "Account", "Amount"],
    ...plIncome.map((row) => ["Income", row.code, row.name, (row.credit - row.debit).toFixed(2)]),
    ...plExpenses.map((row) => ["Expense", row.code, row.name, (row.debit - row.credit).toFixed(2)]),
    ["", "", "Total income", plIncomeTotal.toFixed(2)],
    ["", "", "Total expenses", plExpenseTotal.toFixed(2)],
    ["", "", "Net profit", plNet.toFixed(2)],
    [],
    ["BALANCE SHEET"],
    ["Section", "Code", "Account", "Balance"],
    ...bsAssets.map((row) => ["Assets", row.code, row.name, toNet(row).toFixed(2)]),
    ...bsLiabilities.map((row) => ["Liabilities", row.code, row.name, toNet(row).toFixed(2)]),
    ...equityWithEarnings.map((row) => ["Equity", row.code, row.name, toNet(row).toFixed(2)]),
    ["", "", "Total assets", assetTotal.toFixed(2)],
    ["", "", "Total liabilities", liabilityTotal.toFixed(2)],
    ["", "", "Total equity", equityWithEarningsTotal.toFixed(2)],
    ["", "", "Liabilities + equity", (liabilityTotal + equityWithEarningsTotal).toFixed(2)],
    [],
    ["TRIAL BALANCE"],
    ["Code", "Account", "Type", "Debit", "Credit"],
    ...tbTotals.map((row) => [row.code, row.name, row.type, row.debit.toFixed(2), row.credit.toFixed(2)]),
    ["", "", "Total debits", tbSummary.debit.toFixed(2), ""],
    ["", "", "Total credits", "", tbSummary.credit.toFixed(2)],
  ];

  const csv = asCsv(rows);
  const filename = `reporting-pack-${generatedAt.slice(0, 10)}.csv`;

  await recordAuditLog({
    actorId: actor?.id || null,
    action: "report.export.accounting-pack.csv",
    entityType: "AccountingReport",
    entityId: "reporting-pack",
    meta: {
      sourcePage: "admin/accounting/reports/pl",
      report: "reporting-pack",
      format: "csv",
      basis: "accrual",
      plStart: parsedPlRange.normalizedStart,
      plEnd: parsedPlRange.normalizedEnd,
      balanceSheetAsOf: asOfEffective,
      generatedAt,
      actorRole: actor?.role || null,
      actorEmail: actor?.email || null,
      sections: {
        plRows: plIncome.length + plExpenses.length,
        balanceSheetRows: bsAssets.length + bsLiabilities.length + equityWithEarnings.length,
        trialBalanceRows: tbTotals.length,
      },
    },
  });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
