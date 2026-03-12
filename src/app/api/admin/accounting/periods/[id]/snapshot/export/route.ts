import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const snapshot = await prisma.periodCloseSnapshot.findFirst({
    where: { periodId: params.id },
    orderBy: { createdAt: "desc" },
  });
  if (!snapshot) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const data = snapshot.data as {
    period: { name: string; startDate: string; endDate: string };
    profitAndLoss: {
      income: { code: string; name: string; amount: number }[];
      expenses: { code: string; name: string; amount: number }[];
      incomeTotal: number;
      expenseTotal: number;
      netProfit: number;
    };
    balanceSheet: {
      assets: { code: string; name: string; balance: number }[];
      liabilities: { code: string; name: string; balance: number }[];
      equity: { code: string; name: string; balance: number }[];
      totals: {
        assets: number;
        liabilities: number;
        equity: number;
        liabilitiesPlusEquity: number;
      };
    };
  };

  const rows: string[][] = [
    ["Period Close Report", data.period.name],
    ["Start", data.period.startDate],
    ["End", data.period.endDate],
    [],
    ["Profit & Loss"],
    ["Section", "Code", "Account", "Amount"],
    ...data.profitAndLoss.income.map((row) => ["Income", row.code, row.name, row.amount.toFixed(2)]),
    ...data.profitAndLoss.expenses.map((row) => ["Expense", row.code, row.name, row.amount.toFixed(2)]),
    ["Totals", "", "Income total", data.profitAndLoss.incomeTotal.toFixed(2)],
    ["Totals", "", "Expense total", data.profitAndLoss.expenseTotal.toFixed(2)],
    ["Totals", "", "Net profit", data.profitAndLoss.netProfit.toFixed(2)],
    [],
    ["Balance Sheet"],
    ["Section", "Code", "Account", "Balance"],
    ...data.balanceSheet.assets.map((row) => ["Assets", row.code, row.name, row.balance.toFixed(2)]),
    ...data.balanceSheet.liabilities.map((row) => ["Liabilities", row.code, row.name, row.balance.toFixed(2)]),
    ...data.balanceSheet.equity.map((row) => ["Equity", row.code, row.name, row.balance.toFixed(2)]),
    ["Totals", "", "Assets", data.balanceSheet.totals.assets.toFixed(2)],
    ["Totals", "", "Liabilities", data.balanceSheet.totals.liabilities.toFixed(2)],
    ["Totals", "", "Equity", data.balanceSheet.totals.equity.toFixed(2)],
    ["Totals", "", "Liabilities + Equity", data.balanceSheet.totals.liabilitiesPlusEquity.toFixed(2)],
  ];

  const csv = rows
    .map((row) => row.map((value) => escapeCsv(String(value))).join(","))
    .join("\n");

  const filename = `period-close-${params.id}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
