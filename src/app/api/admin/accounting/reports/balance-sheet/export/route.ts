import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import crypto from "node:crypto";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { rateLimit } from "@/lib/rate-limit";
import { buildBalanceSheetExportAuditMeta, resolveBalanceSheetAsOf } from "@/lib/balance-sheet-report-utils";
import { RETAINED_EARNINGS_ACCOUNT_CODE } from "@/lib/opening-retained-earnings";
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

const MAX_EXPORT_ROWS = 5000;

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const fromJob = searchParams.get("job") === "1";
  const limited = await rateLimit(req, "admin-accounting-balance-sheet-export-csv", 60_000, fromJob ? 180 : 40);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many export requests. Please wait and retry." }, { status: 429 });
  }
  const asOf = searchParams.get("asOf");
  const correlationId = String(searchParams.get("correlationId") || "").trim() || null;
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

  const assets = totals.filter((row) => row.type === "ASSET");
  const liabilities = totals.filter((row) => row.type === "LIABILITY");
  const openingRetainedEarningsRows = totals.filter(
    (row) => row.type === "EQUITY" && row.code === RETAINED_EARNINGS_ACCOUNT_CODE,
  );
  const equity = totals.filter(
    (row) => row.type === "EQUITY" && row.code !== RETAINED_EARNINGS_ACCOUNT_CODE,
  );
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
  const openingRetainedEarningsTotal = openingRetainedEarningsRows.reduce((sum, row) => sum + toNet(row), 0);
  const retainedEarnings = openingRetainedEarningsTotal + netIncomeToDate - currentPeriodNetIncome;
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
  if (rows.length + 1 > MAX_EXPORT_ROWS) {
    return NextResponse.json(
      { error: `Export is too large (${rows.length + 1} rows). Narrow the date or account scope before exporting.` },
      { status: 413 },
    );
  }

  const csv = [header, ...rows]
    .map((row) => row.map((value) => escapeCsv(String(value))).join(","))
    .join("\n");
  const integrityRowCount = rows.length + 1;
  const checksumSha256 = crypto.createHash("sha256").update(csv, "utf8").digest("hex");

  const filename = `balance-sheet${asOfEffective ? `-${asOfEffective}` : ""}.csv`;

  await recordAuditLog({
    actorId: actor?.id || null,
    action: "report.export.balance-sheet.csv",
    entityType: "AccountingReport",
    entityId: "balance-sheet",
    meta: buildBalanceSheetExportAuditMeta({
      correlationId,
      inputAsOf: asOf || null,
      effectiveAsOf: asOfEffective,
      actorRole: actor?.role || null,
      actorEmail: actor?.email || null,
      assetsRowCount: assets.length,
      liabilitiesRowCount: liabilities.length,
      equityRowCount: equityWithEarnings.length,
      totalRowCount: rows.length,
      integrityRowCount,
      checksumSha256,
    }),
  });

  const headers: Record<string, string> = {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  };
  if (correlationId) {
    headers["X-Report-Correlation-Id"] = correlationId;
  }
  headers["X-Export-Row-Count"] = String(integrityRowCount);
  headers["X-Export-Checksum-Sha256"] = checksumSha256;

  return new NextResponse(csv, { headers });
}
