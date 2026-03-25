import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { loadAccountTotals, parseValidatedDateRange } from "../utils";

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
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  let parsedRange: ReturnType<typeof parseValidatedDateRange>;
  try {
    parsedRange = parseValidatedDateRange(start, end);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid date range.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const totals = await loadAccountTotals(parsedRange.dateFilter);

  const income = totals.filter((row) => row.type === "INCOME");
  const expenses = totals.filter((row) => row.type === "EXPENSE");

  const incomeTotal = income.reduce((sum, row) => sum + (row.credit - row.debit), 0);
  const expenseTotal = expenses.reduce((sum, row) => sum + (row.debit - row.credit), 0);
  const netProfit = incomeTotal - expenseTotal;

  return NextResponse.json({
    range: { start: parsedRange.normalizedStart, end: parsedRange.normalizedEnd },
    income,
    expenses,
    incomeTotal,
    expenseTotal,
    netProfit,
  });
}
