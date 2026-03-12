import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadAccountTotals, parseDateRange, toNet } from "@/app/api/admin/accounting/reports/utils";

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
  const asOf = searchParams.get("asOf");
  let asOfDate = asOf ? new Date(asOf) : null;
  if (asOfDate && Number.isNaN(asOfDate.getTime())) {
    return NextResponse.json({ error: "Invalid as-of date" }, { status: 400 });
  }
  if (!asOfDate) {
    const setting = await prisma.appSetting.findUnique({
      where: { key: "accounting.integrity.asOf" },
      select: { value: true },
    });
    if (setting?.value && typeof setting.value === "string") {
      const parsed = new Date(setting.value);
      if (!Number.isNaN(parsed.getTime())) {
        asOfDate = parsed;
      }
    }
  }
  if (asOfDate) {
    asOfDate.setHours(23, 59, 59, 999);
  }
  const dateFilter = asOfDate ? parseDateRange(null, asOfDate.toISOString()) : undefined;
  const paymentWhere = asOfDate
    ? { deletedAt: null, createdAt: { lte: asOfDate } }
    : { deletedAt: null };

  const arAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1100" },
    select: { id: true },
  });
  if (!arAccount) {
    return NextResponse.json({ error: "AR account (1100) not found." }, { status: 500 });
  }

  const [draftEntries, totals, products, payments, orderArLines] = await Promise.all([
    prisma.journalEntry.count({ where: { status: "DRAFT" } }),
    loadAccountTotals(dateFilter),
    prisma.product.findMany({ select: { stock: true, cost: true } }),
    prisma.payment.findMany({
      select: { amount: true, status: true, refundDisposition: true, note: true, createdAt: true },
      where: paymentWhere,
    }),
    prisma.journalLine.findMany({
      where: {
        accountId: arAccount.id,
        entry: {
          status: "POSTED",
          sourceType: "ORDER",
          entryDate: dateFilter,
        },
      },
      select: { debit: true, credit: true },
    }),
  ]);

  const totalsByCode = new Map(totals.map((row) => [row.code, row]));
  const arRow = totalsByCode.get("1100");
  const inventoryRow = totalsByCode.get("1200");
  const arLedger = arRow ? toNet(arRow) : 0;
  const inventoryLedger = inventoryRow ? toNet(inventoryRow) : 0;

  const eligiblePayments = payments.filter((row) => {
    const amount = Number(row.amount || 0);
    if (amount <= 0) return false;
    const status = String(row.status || "").toUpperCase();
    if (status === "REFUND" || status === "VOID") return false;
    const disposition = String(row.refundDisposition || "").toUpperCase();
    if (disposition === "CREDIT") return false;
    if (row.note) {
      try {
        const meta = JSON.parse(row.note) as {
          reference?: string;
          balanceAdjustment?: boolean;
        };
        if (meta.reference === "ITEM_RETURN") return false;
        if (meta.balanceAdjustment) return false;
      } catch {
        // ignore malformed notes
      }
    }
    return true;
  });

  const paymentsTotalAsOf = eligiblePayments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const orderArTotal = orderArLines.reduce(
    (sum, line) => sum + Number(line.debit || 0) - Number(line.credit || 0),
    0,
  );

  const customerBalances = Math.max(0, orderArTotal - paymentsTotalAsOf);
  const inventoryValuation = products.reduce(
    (sum, product) => sum + Number(product.cost || 0) * Number(product.stock || 0),
    0,
  );
  const negativeStockCount = products.filter((product) => Number(product.stock || 0) < 0).length;
  const settlementLogs = await prisma.auditLog.findMany({
    where: {
      entityType: "DELIVERY_SETTLEMENT",
      action: "DELIVERY_COLLECTION_SETTLEMENT_CREATED",
    },
    select: { entityId: true, meta: true },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  const settlementIds = settlementLogs
    .map((log) => {
      try {
        const meta = JSON.parse(log.meta || "{}") as { totalBalance?: number };
        return Number(meta.totalBalance || 0) > 0 ? log.entityId : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as string[];
  const settlementPosted = settlementIds.length
    ? await prisma.journalEntry.findMany({
        where: { sourceType: "MANUAL", sourceId: { in: settlementIds }, status: "POSTED" },
        select: { sourceId: true },
      })
    : [];
  const settlementPostedIds = new Set(settlementPosted.map((row) => row.sourceId).filter(Boolean) as string[]);
  const missingSettlements = settlementIds.filter((id) => !settlementPostedIds.has(id)).length;
  const supplierPayments = await prisma.supplierPayment.findMany({
    where: { deletedAt: null, status: "NORMAL" },
    select: { id: true, method: true, reference: true },
  });
  const eligibleSupplierPayments = supplierPayments.filter((row) => {
    const method = String(row.method || "").toLowerCase();
    if (method === "credit_memo") return false;
    if (String(row.reference || "").toUpperCase() === "SUPPLIER_RETURN") return false;
    return true;
  });
  const supplierPosted = await prisma.journalEntry.findMany({
    where: { sourceType: "PURCHASE", status: "POSTED", sourceId: { in: eligibleSupplierPayments.map((s) => s.id) } },
    select: { sourceId: true },
  });
  const supplierPostedIds = new Set(supplierPosted.map((row) => row.sourceId).filter(Boolean) as string[]);
  const missingSupplierPayments = eligibleSupplierPayments.filter((row) => !supplierPostedIds.has(row.id)).length;
  const creditPayouts = await prisma.payment.findMany({
    where: {
      deletedAt: null,
      status: "REFUND",
      refundDisposition: "CASH",
      note: { contains: "\"location\":\"admin/customers:credit-payout\"" },
    },
    select: { id: true },
  });
  const payoutPosted = await prisma.journalEntry.findMany({
    where: { sourceType: "PAYMENT", status: "POSTED", sourceId: { in: creditPayouts.map((p) => p.id) } },
    select: { sourceId: true },
  });
  const payoutPostedIds = new Set(payoutPosted.map((row) => row.sourceId).filter(Boolean) as string[]);
  const missingCreditPayouts = creditPayouts.filter((row) => !payoutPostedIds.has(row.id)).length;

  const rows = [
    ["draftEntries", String(draftEntries)],
    ["arLedger", arLedger.toFixed(2)],
    ["customerBalances", customerBalances.toFixed(2)],
    ["arDifference", (arLedger - customerBalances).toFixed(2)],
    ["inventoryLedger", inventoryLedger.toFixed(2)],
    ["inventoryValuation", inventoryValuation.toFixed(2)],
    ["inventoryDifference", (inventoryLedger - inventoryValuation).toFixed(2)],
    ["negativeStockCount", String(negativeStockCount)],
    ["missingSupplierPayments", String(missingSupplierPayments)],
    ["missingCreditPayouts", String(missingCreditPayouts)],
    ["missingSettlements", String(missingSettlements)],
  ];

  const csv = [["Metric", "Value"], ...rows]
    .map((row) => row.map((value) => escapeCsv(String(value))).join(","))
    .join("\n");

  const filename = `accounting-integrity-${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
