import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { loadAccountTotals, parseValidatedDateRange } from "../../utils";

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
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const fromJob = searchParams.get("job") === "1";
  let parsedRange: ReturnType<typeof parseValidatedDateRange>;
  try {
    parsedRange = parseValidatedDateRange(start, end);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid date range.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!fromJob && parsedRange.normalizedStart && parsedRange.normalizedEnd) {
    const startDate = new Date(`${parsedRange.normalizedStart}T00:00:00`);
    const endDate = new Date(`${parsedRange.normalizedEnd}T00:00:00`);
    const dayMs = 24 * 60 * 60 * 1000;
    const spanDays = Math.floor((endDate.getTime() - startDate.getTime()) / dayMs) + 1;
    if (spanDays > 366) {
      return NextResponse.json(
        { error: "Range is large. Use the queued export job option for better performance." },
        { status: 413 },
      );
    }
  }

  const totals = await loadAccountTotals(parsedRange.dateFilter);

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

  const filename = `profit-loss${parsedRange.normalizedStart || parsedRange.normalizedEnd ? `-${parsedRange.normalizedStart || "start"}-${parsedRange.normalizedEnd || "end"}` : ""}.csv`;

  await recordAuditLog({
    actorId: actor?.id || null,
    action: "report.export.pl.csv",
    entityType: "AccountingReport",
    entityId: "pl",
    meta: {
      sourcePage: "admin/accounting/reports/pl",
      report: "profit-loss",
      format: "csv",
      basis: "accrual",
      start: parsedRange.normalizedStart,
      end: parsedRange.normalizedEnd,
      rowCount: rows.length,
      incomeRowCount: income.length,
      expenseRowCount: expenses.length,
      incomeTotal,
      generatedAt: new Date().toISOString(),
      actorRole: actor?.role || null,
      actorEmail: actor?.email || null,
    },
  });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
