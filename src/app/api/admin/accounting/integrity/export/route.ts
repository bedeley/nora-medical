import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { loadAccountTotals, parseDateRange, toNet } from "@/app/api/admin/accounting/reports/utils";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function toBaseSourceId(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.split(":")[0] || raw;
}

const escapeCsv = (value: string) => {
  if (!value) return "";
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
};

function formatPlainEnglishDate(value: string) {
  const text = String(value || "").trim();
  const exactDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!exactDate) return text;
  const date = new Date(Date.UTC(Number(exactDate[1]), Number(exactDate[2]) - 1, Number(exactDate[3])));
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const asOf = searchParams.get("asOf");

  // Parse strictly: YYYY-MM-DD only, boundary set in UTC to match main route.
  let asOfDate: Date | null = null;
  if (asOf) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf.trim());
    if (!m) {
      return NextResponse.json({ error: "Invalid as-of date. Use YYYY-MM-DD." }, { status: 400 });
    }
    asOfDate = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999));
  }

  const dateFilter = asOfDate ? parseDateRange(null, asOfDate.toISOString()) : undefined;
  const paymentWhere = asOfDate
    ? { deletedAt: null, createdAt: { lte: asOfDate } }
    : { deletedAt: null };
  const purchaseWhere: Prisma.PurchaseWhereInput = {
    deletedAt: null,
    status: "RECEIVED",
    ...(asOfDate ? { createdAt: { lte: asOfDate } } : {}),
  };
  const supplierPaymentWhere: Prisma.SupplierPaymentWhereInput = {
    deletedAt: null,
    status: "NORMAL",
    ...(asOfDate ? { createdAt: { lte: asOfDate } } : {}),
  };
  const creditPayoutWhere: Prisma.PaymentWhereInput = {
    deletedAt: null,
    status: "REFUND",
    refundDisposition: "CASH",
    note: { contains: "\"location\":\"admin/customers:credit-payout\"" },
    ...(asOfDate ? { createdAt: { lte: asOfDate } } : {}),
  };

  const arAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1100" },
    select: { id: true },
  });
  if (!arAccount) {
    return NextResponse.json({ error: "AR account (1100) not found." }, { status: 500 });
  }

  const [draftEntries, totals, products, payments, orderArLines, purchases, supplierPayments] = await Promise.all([
    prisma.journalEntry.count({
      where: {
        status: "DRAFT",
        ...(dateFilter && (dateFilter.gte || dateFilter.lte) ? { entryDate: dateFilter } : {}),
      },
    }),
    loadAccountTotals(dateFilter),
    prisma.product.findMany({ select: { id: true, stock: true, cost: true } }),
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
    prisma.purchase.findMany({
      select: { id: true, unitCost: true, quantity: true },
      where: purchaseWhere,
    }),
    prisma.supplierPayment.findMany({
      select: { id: true, method: true, reference: true, amount: true },
      where: supplierPaymentWhere,
    }),
  ]);

  const totalsByCode = new Map(totals.map((row) => [row.code, row]));
  const arRow = totalsByCode.get("1100");
  const inventoryRow = totalsByCode.get("1200");
  const apRow = totalsByCode.get("2000");
  const arLedger = arRow ? toNet(arRow) : 0;
  const inventoryLedger = inventoryRow ? toNet(inventoryRow) : 0;
  const apLedger = apRow ? toNet(apRow) : 0;
  const trialBalance = totals.reduce((sum, row) => sum + row.debit - row.credit, 0);

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

  // AP operational: total received purchase cost minus total supplier payments.
  const eligibleSupplierPayments = supplierPayments.filter((row) => {
    const method = String(row.method || "").toLowerCase();
    if (method === "credit_memo") return false;
    if (String(row.reference || "").toUpperCase() === "SUPPLIER_RETURN") return false;
    return true;
  });
  const apOperational =
    purchases.reduce((sum, row) => sum + Number(row.unitCost || 0) * Number(row.quantity || 0), 0) -
    eligibleSupplierPayments.reduce((sum, row) => sum + Number(row.amount || 0), 0);

  const settlementLogs = await prisma.auditLog.findMany({
    where: {
      entityType: "DELIVERY_SETTLEMENT",
      action: "DELIVERY_COLLECTION_SETTLEMENT_CREATED",
      ...(asOfDate ? { createdAt: { lte: asOfDate } } : {}),
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

  // Use toBaseSourceId to match the same logic as the main integrity route.
  const supplierPosted = await prisma.journalEntry.findMany({
    where: { sourceType: "PURCHASE", status: "POSTED", sourceId: { in: eligibleSupplierPayments.map((s) => s.id) } },
    select: { sourceId: true },
  });
  const supplierPostedIds = new Set(supplierPosted.map((row) => toBaseSourceId(row.sourceId)));
  const missingSupplierPayments = eligibleSupplierPayments.filter((row) => !supplierPostedIds.has(row.id)).length;

  const creditPayouts = await prisma.payment.findMany({
    where: creditPayoutWhere,
    select: { id: true, amount: true },
  });
  const payoutPosted = await prisma.journalEntry.findMany({
    where: { sourceType: "PAYMENT", status: "POSTED", sourceId: { in: creditPayouts.map((p) => p.id) } },
    select: { sourceId: true },
  });
  const payoutPostedIds = new Set(payoutPosted.map((row) => toBaseSourceId(row.sourceId)));
  const missingCreditPayouts = creditPayouts.filter((row) => !payoutPostedIds.has(row.id)).length;

  // Extended reconciliation checks
  const glRevenue = totalsByCode.get("4000") ? toNet(totalsByCode.get("4000")!) : 0;
  const glCogs = totalsByCode.get("5000") ? toNet(totalsByCode.get("5000")!) : 0;
  const glVat = totalsByCode.get("2100") ? toNet(totalsByCode.get("2100")!) : 0;
  const glStoreCredit = totalsByCode.get("2200") ? toNet(totalsByCode.get("2200")!) : 0;
  const glCash = totalsByCode.get("1000") ? toNet(totalsByCode.get("1000")!) : 0;
  const glBank = totalsByCode.get("1010") ? toNet(totalsByCode.get("1010")!) : 0;

  const [orderAggregates, cogsItems] = await Promise.all([
    prisma.order.aggregate({
      _sum: { subtotal: true, taxAmount: true },
      where: { status: { not: "CANCELLED" }, deletedAt: null, ...(asOfDate ? { createdAt: { lte: asOfDate } } : {}) },
    }),
    prisma.orderItem.findMany({
      select: { costAtSale: true, quantity: true, returnedQuantity: true },
      where: { order: { status: { not: "CANCELLED" }, deletedAt: null, ...(asOfDate ? { createdAt: { lte: asOfDate } } : {}) } },
    }),
  ]);

  const revenueOperational = Number(orderAggregates._sum.subtotal || 0);
  const vatOperational = Number(orderAggregates._sum.taxAmount || 0);
  const cogsOperational = cogsItems.reduce((sum, item) => {
    const soldQty = Math.max(0, Number(item.quantity || 0) - Number(item.returnedQuantity || 0));
    return sum + soldQty * Number(item.costAtSale || 0);
  }, 0);

  const creditRefundTotal = payments
    .filter((p) => String(p.status || "").toUpperCase() === "REFUND" && String(p.refundDisposition || "").toUpperCase() === "CREDIT")
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const storeCreditOperational = creditRefundTotal - creditPayouts.reduce((sum, p) => sum + Number(p.amount || 0), 0);

  // Duplicate payment count
  const normalPayments = payments.filter((p) => String(p.status || "").toUpperCase() === "NORMAL");
  const dupMap = new Map<string, typeof normalPayments>();
  for (const p of normalPayments) {
    const note = (() => { try { return JSON.parse(p.note || "{}") as { orderId?: string }; } catch { return {}; } })();
    if (!note.orderId) continue;
    const key = `${note.orderId}:${Number(p.amount).toFixed(2)}`;
    if (!dupMap.has(key)) dupMap.set(key, []);
    dupMap.get(key)!.push(p);
  }
  const duplicatePaymentGroupCount = Array.from(dupMap.values()).filter((g) => g.length >= 2).length;

  const rows = [
    ["Core integrity", "Draft journal entries", String(draftEntries), "Journal entries still saved as draft instead of posted."],
    ["Core integrity", "Trial balance difference", trialBalance.toFixed(2), "Difference between total debits and total credits across the ledger."],
    ["Core integrity", "Negative stock items", String(negativeStockCount), "Products whose on-hand quantity is below zero."],
    ["Core integrity", "Duplicate payment groups", String(duplicatePaymentGroupCount), "Potential duplicate normal-payment groups with the same order and amount."],
    ["Receivables", "AR ledger balance", arLedger.toFixed(2), "Accounts receivable balance from the general ledger."],
    ["Receivables", "Customer balances", customerBalances.toFixed(2), "Outstanding customer balances calculated from operational records."],
    ["Receivables", "AR difference", (arLedger - customerBalances).toFixed(2), "Variance between the AR ledger and customer balances."],
    ["Inventory", "Inventory ledger balance", inventoryLedger.toFixed(2), "Inventory asset balance from the general ledger."],
    ["Inventory", "Inventory valuation", inventoryValuation.toFixed(2), "Operational stock value based on quantity on hand and product cost."],
    ["Inventory", "Inventory difference", (inventoryLedger - inventoryValuation).toFixed(2), "Variance between the inventory ledger and operational stock valuation."],
    ["Payables", "AP ledger balance", apLedger.toFixed(2), "Accounts payable balance from the general ledger."],
    ["Payables", "AP operational balance", apOperational.toFixed(2), "Received purchases less eligible supplier payments in operations."],
    ["Payables", "AP difference", (apLedger - apOperational).toFixed(2), "Variance between the AP ledger and operational payable balance."],
    ["Missing postings", "Missing supplier payment postings", String(missingSupplierPayments), "Supplier payments that exist operationally but are missing a posted journal entry."],
    ["Missing postings", "Missing credit payout postings", String(missingCreditPayouts), "Store-credit cash payouts missing a posted journal entry."],
    ["Missing postings", "Missing settlement postings", String(missingSettlements), "Delivery settlements missing a posted journal entry."],
    ["GL vs operational", "GL revenue", glRevenue.toFixed(2), "Revenue balance from the general ledger."],
    ["GL vs operational", "Operational revenue", revenueOperational.toFixed(2), "Revenue calculated from non-cancelled operational orders."],
    ["GL vs operational", "Revenue difference", (glRevenue - revenueOperational).toFixed(2), "Variance between the revenue ledger and operational order revenue."],
    ["GL vs operational", "GL cost of goods sold", glCogs.toFixed(2), "Cost of goods sold balance from the general ledger."],
    ["GL vs operational", "Operational cost of goods sold", cogsOperational.toFixed(2), "Operational cost of goods sold from order items sold net of returns."],
    ["GL vs operational", "Cost of goods sold difference", (glCogs - cogsOperational).toFixed(2), "Variance between GL COGS and operational COGS."],
    ["GL vs operational", "GL VAT", glVat.toFixed(2), "VAT liability balance from the general ledger."],
    ["GL vs operational", "Operational VAT", vatOperational.toFixed(2), "VAT calculated from non-cancelled operational orders."],
    ["GL vs operational", "VAT difference", (glVat - vatOperational).toFixed(2), "Variance between GL VAT and operational VAT."],
    ["GL vs operational", "GL store credit liability", glStoreCredit.toFixed(2), "Store-credit liability balance from the general ledger."],
    ["GL vs operational", "Operational store credit liability", storeCreditOperational.toFixed(2), "Operational store-credit refunds less cash payouts."],
    ["GL vs operational", "Store credit difference", (glStoreCredit - storeCreditOperational).toFixed(2), "Variance between GL store credit and operational store credit."],
    ["Cash positions", "GL cash balance", glCash.toFixed(2), "Cash-on-hand balance from the general ledger."],
    ["Cash positions", "GL bank balance", glBank.toFixed(2), "Bank balance from the general ledger."],
  ];

  const csv = [["Section", "Metric", "Value", "Explanation"], ...rows]
    .map((row) => row.map((value) => escapeCsv(String(value))).join(","))
    .join("\n");

  const filename = `accounting-integrity-${new Date().toISOString().slice(0, 10)}.csv`;
  const displayFileName = asOf
    ? `Accounting integrity report (${formatPlainEnglishDate(asOf)}).csv`
    : "Accounting integrity report.csv";
  const byteSize = Buffer.byteLength(csv, "utf8");
  const scopeSnapshot = asOfDate
    ? `As of ${asOfDate.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`
    : "Current integrity snapshot";

  await recordAuditLog({
    actorId: actor?.id || null,
    action: "report.export.integrity.csv",
    entityType: "AccountingReport",
    entityId: "integrity",
    meta: {
      exportLabel: "Accounting integrity CSV export",
      reportLabel: "Accounting integrity report",
      sourcePage: "admin/accounting/integrity",
      report: "accounting-integrity",
      format: "CSV",
      fileName: filename,
      displayFileName,
      columnCount: 4,
      byteSize,
      asOf,
      asOfApplied: asOfDate ? asOfDate.toISOString() : null,
      scopeSnapshot,
      rowCount: rows.length,
      resultSummary: `Exported ${rows.length} integrity metrics.`,
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
