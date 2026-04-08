import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import crypto from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { rateLimit } from "@/lib/rate-limit";
import { buildBalanceSheetExportAuditMeta, resolveBalanceSheetAsOf } from "@/lib/balance-sheet-report-utils";
import { RETAINED_EARNINGS_ACCOUNT_CODE } from "@/lib/opening-retained-earnings";
import { type AccountTotals, loadAccountTotals, parseDateRange, toNet } from "../../../utils";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

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

function sanitize(value: unknown) {
  return String(value ?? "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatAmount(value: number) {
  return Number(value || 0).toFixed(2);
}

function ellipsize(value: string, max = 56) {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const fromJob = searchParams.get("job") === "1";
  const limited = await rateLimit(req, "admin-accounting-balance-sheet-export-pdf", 60_000, fromJob ? 180 : 30);
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

  const assetTotal = assets.reduce((sum, row) => sum + toNet(row), 0);
  const liabilityTotal = liabilities.reduce((sum, row) => sum + toNet(row), 0);
  const equityTotal = equityWithEarnings.reduce((sum, row) => sum + toNet(row), 0);
  const detailRowCount = assets.length + liabilities.length + equityWithEarnings.length;

  if (detailRowCount > MAX_EXPORT_ROWS) {
    return NextResponse.json(
      { error: `Export is too large (${detailRowCount} rows). Narrow the date or account scope before exporting.` },
      { status: 413 },
    );
  }

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [842, 595];
  const margin = 24;
  const top = 570;
  const lineHeight = 13;
  let page = pdf.addPage(pageSize);
  let y = top;

  const columns = [
    { label: "Section", width: 105 },
    { label: "Class", width: 85 },
    { label: "Code", width: 60 },
    { label: "Account", width: 370 },
    { label: "Balance", width: 120 },
  ];

  const drawHeader = () => {
    page.drawText("Balance Sheet", { x: margin, y, size: 16, font: bold, color: rgb(0.07, 0.07, 0.07) });
    y -= 18;
    page.drawText(sanitize(`As of: ${asOfEffective}`), { x: margin, y, size: 9, font });
    y -= 12;
    page.drawText(sanitize(`Generated: ${new Date().toISOString()}`), { x: margin, y, size: 9, font });
    y -= 16;
    let x = margin;
    columns.forEach((column) => {
      page.drawText(column.label, { x, y, size: 8.5, font: bold });
      x += column.width;
    });
    y -= 8;
    page.drawLine({
      start: { x: margin, y },
      end: { x: margin + columns.reduce((sum, column) => sum + column.width, 0), y },
      thickness: 0.6,
      color: rgb(0.75, 0.75, 0.75),
    });
    y -= 9;
  };

  const writeRow = (cells: string[]) => {
    if (y < 40) {
      page = pdf.addPage(pageSize);
      y = top;
      drawHeader();
    }
    let x = margin;
    cells.forEach((cell, index) => {
      const raw = sanitize(cell);
      const content = ellipsize(raw, index === 3 ? 62 : 22);
      page.drawText(content, { x, y, size: 8, font });
      x += columns[index]!.width;
    });
    y -= lineHeight;
  };

  drawHeader();

  for (const row of assets) {
    writeRow([
      "Assets",
      isCurrentAccount(row, "ASSET") ? "Current" : "Non-current",
      row.code,
      row.name,
      formatAmount(toNet(row)),
    ]);
  }
  for (const row of liabilities) {
    writeRow([
      "Liabilities",
      isCurrentAccount(row, "LIABILITY") ? "Current" : "Non-current",
      row.code,
      row.name,
      formatAmount(toNet(row)),
    ]);
  }
  for (const row of equityWithEarnings) {
    writeRow(["Equity", "-", row.code, row.name, formatAmount(toNet(row))]);
  }

  if (y < 58) {
    page = pdf.addPage(pageSize);
    y = top;
    drawHeader();
  }
  y -= 4;
  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + columns.reduce((sum, column) => sum + column.width, 0), y },
    thickness: 0.6,
    color: rgb(0.65, 0.65, 0.65),
  });
  y -= 12;
  page.drawText(`Total Assets: ${formatAmount(assetTotal)}`, { x: margin, y, size: 9, font: bold });
  y -= 12;
  page.drawText(`Total Liabilities: ${formatAmount(liabilityTotal)}`, { x: margin, y, size: 9, font: bold });
  y -= 12;
  page.drawText(`Total Equity: ${formatAmount(equityTotal)}`, { x: margin, y, size: 9, font: bold });
  y -= 12;
  page.drawText(`Liabilities + Equity: ${formatAmount(liabilityTotal + equityTotal)}`, { x: margin, y, size: 9, font: bold });

  const bytes = await pdf.save();
  const byteSize = bytes.length;
  const checksumSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const filename = `balance-sheet${asOfEffective ? `-${asOfEffective}` : ""}.pdf`;

  await recordAuditLog({
    actorId: actor?.id || null,
    action: "report.export.balance-sheet.pdf",
    entityType: "AccountingReport",
    entityId: "balance-sheet",
    meta: {
      ...buildBalanceSheetExportAuditMeta({
        correlationId,
        inputAsOf: asOf || null,
        effectiveAsOf: asOfEffective,
        actorRole: actor?.role || null,
        actorEmail: actor?.email || null,
        assetsRowCount: assets.length,
        liabilitiesRowCount: liabilities.length,
        equityRowCount: equityWithEarnings.length,
        totalRowCount: detailRowCount,
        integrityRowCount: detailRowCount,
        checksumSha256,
        format: "pdf",
      }),
      fileName: filename,
      byteSize,
      rowCount: detailRowCount,
      resultSummary: "Export completed successfully.",
      scopeSnapshot: `As of ${asOfEffective}`,
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Export-Row-Count": String(detailRowCount),
    "X-Export-Checksum-Sha256": checksumSha256,
  };
  if (correlationId) {
    headers["X-Report-Correlation-Id"] = correlationId;
  }

  return new NextResponse(Buffer.from(bytes), { headers });
}
