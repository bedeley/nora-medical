import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { loadAccountTotals, parseDateRange } from "../../utils";

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

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const totals = await loadAccountTotals(parseDateRange(start, end));

  const income = totals.filter((row) => row.type === "INCOME");
  const expenses = totals.filter((row) => row.type === "EXPENSE");
  const incomeTotal = income.reduce((sum, row) => sum + (row.credit - row.debit), 0);

  const header = ["Section", "Code", "Account", "Amount", "% of Revenue"];
  const rows = [
    ...income.map((row) => [
      "Income",
      row.code,
      row.name,
      (row.credit - row.debit).toFixed(2),
      incomeTotal ? (((row.credit - row.debit) / incomeTotal) * 100).toFixed(2) : "0.00",
    ]),
    ...expenses.map((row) => [
      "Expense",
      row.code,
      row.name,
      (row.debit - row.credit).toFixed(2),
      incomeTotal ? (((row.debit - row.credit) / incomeTotal) * 100).toFixed(2) : "0.00",
    ]),
  ];
  const csv = [header, ...rows]
    .map((row) => row.map((value) => escapeCsv(String(value))).join(","))
    .join("\n");

  const filename = `profit-loss${start || end ? `-${start || "start"}-${end || "end"}` : ""}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
