import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { type AccountTotals, loadAccountTotals, parseDateRange, toNet } from "../../utils";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const escapeCsv = (value: string) => {
  if (!value) return "";
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
};

function isCurrentAccount(
  row: { code: string; subtype?: string | null },
  section: "ASSET" | "LIABILITY",
) {
  const subtype = (row.subtype || "").toLowerCase();
  if (subtype.includes("non-current") || subtype.includes("noncurrent") || subtype.includes("long-term")) {
    return false;
  }
  if (subtype.includes("current") || subtype.includes("short-term")) {
    return true;
  }
  if (section === "ASSET") {
    return ["1000", "1010", "1020", "1030", "1040", "1100", "1200"].includes(row.code);
  }
  return row.code.startsWith("2");
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
  const equityWithEarnings: AccountTotals[] = [
    ...equity,
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

  const header = ["Section", "Class", "Code", "Account", "Balance"];
  const rows = [
    ...assets.map((row) => [
      "Assets",
      isCurrentAccount(row, "ASSET") ? "Current" : "Non-current",
      row.code,
      row.name,
      toNet(row).toFixed(2),
    ]),
    ...liabilities.map((row) => [
      "Liabilities",
      isCurrentAccount(row, "LIABILITY") ? "Current" : "Non-current",
      row.code,
      row.name,
      toNet(row).toFixed(2),
    ]),
    ...equityWithEarnings.map((row) => ["Equity", "-", row.code, row.name, toNet(row).toFixed(2)]),
  ];

  const csv = [header, ...rows]
    .map((row) => row.map((value) => escapeCsv(String(value))).join(","))
    .join("\n");

  const filename = `balance-sheet${asOf ? `-${asOf}` : ""}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
