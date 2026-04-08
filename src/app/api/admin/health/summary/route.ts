import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadAccountTotals, parseDateRange, toNet } from "@/app/api/admin/accounting/reports/utils";
import { getPodComplianceSnapshot } from "@/lib/pod-compliance";

function num(v: unknown) {
  return Number(v || 0);
}

function toBaseSourceId(value: string | null | undefined) {
  const sourceId = String(value || "").trim();
  if (!sourceId) return "";
  return sourceId.split(":")[0] || sourceId;
}

export async function GET(req: Request) {
  const { verifyCronSecret } = await import("@/lib/cron-auth");
  const hasCronAccess = verifyCronSecret(req);

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const hasAdminAccess = Boolean(session && user?.role === "ADMIN");
  if (!hasAdminAccess && !hasCronAccess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const asOf = searchParams.get("asOf");
  const asOfDate = asOf ? new Date(asOf) : null;
  if (asOfDate && Number.isNaN(asOfDate.getTime())) {
    return NextResponse.json({ error: "Invalid as-of date" }, { status: 400 });
  }
  if (asOfDate) {
    asOfDate.setHours(23, 59, 59, 999);
  }
  const dateFilter = asOfDate ? parseDateRange(null, asOfDate.toISOString()) : undefined;
  const orderWhere = asOfDate
    ? { status: { not: "CANCELLED" }, createdAt: { lte: asOfDate } }
    : { status: { not: "CANCELLED" } };
  const paymentWhere = asOfDate
    ? { deletedAt: null, createdAt: { lte: asOfDate } }
    : { deletedAt: null };
  const movementWhere = asOfDate
    ? { deletedAt: null, createdAt: { lte: asOfDate } }
    : { deletedAt: null };

  const [
    products,
    movements,
    totals,
    orders,
    payments,
    expenses,
    purchases,
    supplierPayments,
    creditPayouts,
    orderArLines,
    settlementLogs,
  ] = await Promise.all([
    prisma.product.findMany({ select: { id: true, stock: true, cost: true } }),
    prisma.inventoryMovement.groupBy({
      by: ["productId"],
      where: movementWhere,
      _sum: { delta: true },
    }),
    loadAccountTotals(dateFilter),
    prisma.order.findMany({
      select: { id: true, total: true, amountPaid: true, balance: true, status: true, createdAt: true },
      where: orderWhere,
    }),
    prisma.payment.findMany({
      select: { id: true, amount: true, status: true, refundDisposition: true, note: true, createdAt: true, orderId: true },
      where: paymentWhere,
    }),
    prisma.expense.findMany({ select: { id: true }, where: { deletedAt: null } }),
    prisma.purchase.findMany({
      select: { id: true, unitCost: true, quantity: true },
      where: { deletedAt: null, status: "RECEIVED" },
    }),
    prisma.supplierPayment.findMany({
      select: { id: true, method: true, status: true, reference: true, amount: true, purchaseId: true },
      where: { deletedAt: null, status: "NORMAL" },
    }),
    prisma.payment.findMany({
      where: {
        deletedAt: null,
        status: "REFUND",
        refundDisposition: "CASH",
        note: { contains: "\"location\":\"admin/customers:credit-payout\"" },
      },
      select: { id: true },
    }),
    prisma.journalLine.findMany({
      where: {
        account: { code: "1100" },
        entry: { status: "POSTED", sourceType: "ORDER", entryDate: dateFilter },
      },
      select: { debit: true, credit: true },
    }),
    prisma.auditLog.findMany({
      where: {
        entityType: "DELIVERY_SETTLEMENT",
        action: "DELIVERY_COLLECTION_SETTLEMENT_CREATED",
      },
      select: { entityId: true, meta: true },
      orderBy: { createdAt: "desc" },
      take: 2000,
    }),
  ]);

  const movementMap = new Map(movements.map((m) => [m.productId, num(m._sum.delta)]));
  // Use movement sums as source of truth; compare against the denormalised stock field.
  const stockMismatches = products.filter((p) => {
    if (p.stock == null) return false;
    return num(p.stock) !== (movementMap.get(p.id) ?? 0);
  }).length;
  const negativeStock = products.filter((p) => (movementMap.get(p.id) ?? 0) < 0).length;

  const orderPayments = await prisma.payment.groupBy({
    by: ["orderId", "status"],
    where: { orderId: { not: null }, ...paymentWhere },
    _sum: { amount: true },
  });
  const orderPaymentsMap = new Map<string, number>();
  for (const row of orderPayments) {
    if (!row.orderId) continue;
    if (row.status === "VOID") continue;
    const raw = num(row._sum.amount);
    const signed = row.status === "REFUND" ? -Math.abs(raw) : raw;
    orderPaymentsMap.set(
      row.orderId,
      (orderPaymentsMap.get(row.orderId) ?? 0) + signed
    );
  }
  const paymentMismatches = orders.filter((order) => {
    const projectedPaid = orderPaymentsMap.get(order.id) ?? 0;
    return Math.abs(num(order.amountPaid) - projectedPaid) > 0.01;
  }).length;
  const orderBalanceMismatches = orders.filter((order) => {
    const projectedPaid = orderPaymentsMap.get(order.id) ?? 0;
    const projectedBalance = Math.max(0, num(order.total) - projectedPaid);
    return Math.abs(num(order.balance) - projectedBalance) > 0.01;
  }).length;

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
  // Real inventory valuation: movement-based quantity × recorded cost per product.
  const inventoryValuation = products.reduce(
    (sum, p) => sum + (movementMap.get(p.id) ?? 0) * num(p.cost),
    0,
  );
  const arDifference = arLedger - customerBalances;
  const inventoryDifference = inventoryLedger - inventoryValuation;
  const arMismatch = Math.abs(arDifference) > 0.01;
  const inventoryMismatch = Math.abs(inventoryDifference) > 0.01;

  // Trial balance: sum of all debits minus credits across posted lines — must be 0.
  const trialBalance = totals.reduce((sum, row) => sum + row.debit - row.credit, 0);
  const trialBalanceOk = Math.abs(trialBalance) < 0.01;

  // AP reconciliation
  const apRow = totalsByCode.get("2000");
  const apLedger = apRow ? toNet(apRow) : 0;
  const eligibleSpForAp = supplierPayments.filter((row) => {
    if (String(row.method || "").toLowerCase() === "credit_memo") return false;
    if (String(row.reference || "").toUpperCase() === "SUPPLIER_RETURN") return false;
    return true;
  });
  const apOperational =
    purchases.reduce((sum, p) => sum + Number(p.unitCost || 0) * Number(p.quantity || 0), 0) -
    eligibleSpForAp.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const apDifference = apLedger - apOperational;
  const apMismatch = Math.abs(apDifference) > 0.01;

  const [orderPosts, paymentPosts, expensePosts, purchasePosts] = await Promise.all([
    prisma.journalEntry.findMany({
      where: { sourceType: "ORDER", status: "POSTED", sourceId: { not: null } },
      select: { sourceId: true },
    }),
    prisma.journalEntry.findMany({
      where: { sourceType: "PAYMENT", status: "POSTED", sourceId: { not: null } },
      select: { sourceId: true },
    }),
    prisma.journalEntry.findMany({
      where: { sourceType: "EXPENSE", status: "POSTED", sourceId: { not: null } },
      select: { sourceId: true },
    }),
    prisma.journalEntry.findMany({
      where: { sourceType: "PURCHASE", status: "POSTED", sourceId: { not: null } },
      select: { sourceId: true },
    }),
  ]);

  const orderPostedIds = new Set(orderPosts.map((row) => row.sourceId as string));
  const paymentPostedIds = new Set(paymentPosts.map((row) => toBaseSourceId(row.sourceId as string)));
  const expensePostedIds = new Set(expensePosts.map((row) => row.sourceId as string));
  const purchasePostedIds = new Set(purchasePosts.map((row) => toBaseSourceId(row.sourceId as string)));

  const missingOrders = orders.filter((row) => !orderPostedIds.has(row.id)).length;
  const missingPayments = eligiblePayments.filter((row) => !paymentPostedIds.has(row.id)).length;
  const missingExpenses = expenses.filter((row) => !expensePostedIds.has(row.id)).length;
  const missingPurchases = purchases.filter((row) => !purchasePostedIds.has(row.id)).length;
  const eligibleSupplierPayments = supplierPayments.filter((row) => {
    const method = String(row.method || "").toLowerCase();
    if (method === "credit_memo") return false;
    if (String(row.reference || "").toUpperCase() === "SUPPLIER_RETURN") return false;
    return true;
  });
  const missingSupplierPayments = eligibleSupplierPayments.filter((row) => !purchasePostedIds.has(row.id)).length;
  const missingCreditPayouts = creditPayouts.filter((row) => !paymentPostedIds.has(row.id)).length;
  const settlementIds = settlementLogs
    .map((log) => {
      if (!log.meta) return null;
      try {
        const meta = JSON.parse(log.meta) as { totalBalance?: number };
        const amount = Number(meta.totalBalance || 0);
        if (!(amount > 0)) return null;
        return log.entityId;
      } catch {
        return log.entityId;
      }
    })
    .filter(Boolean) as string[];
  const settlementPosted = settlementIds.length
    ? await prisma.journalEntry.findMany({
        where: { sourceType: "MANUAL", sourceId: { in: settlementIds }, status: "POSTED" },
        select: { sourceId: true },
      })
    : [];
  const settlementPostedIds = new Set(settlementPosted.map((entry) => entry.sourceId).filter(Boolean) as string[]);
  const missingSettlements = settlementIds.filter((id) => !settlementPostedIds.has(id)).length;

  const legacyAutoApply = await prisma.payment.count({
    where: { orderId: null, note: { contains: "\"reference\":\"AUTO_APPLY\"" } },
  });

  const podThresholdPct = Number(process.env.HEALTH_POD_MISSING_ALERT_PCT || 15);
  const podMinDelivered = Number(process.env.HEALTH_POD_MIN_DELIVERIES || 20);
  const now = new Date();
  const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const podCompliance7d = await getPodComplianceSnapshot({
    from: last7Days,
    to: now,
    thresholdPct: podThresholdPct,
    minDelivered: podMinDelivered,
  });

  return NextResponse.json({
    stockMismatches,
    negativeStock,
    orderBalanceMismatches,
    paymentMismatches,
    legacyAutoApply,
    arDifference,
    inventoryDifference,
    apDifference,
    trialBalance,
    ledgerMismatches: Number(arMismatch) + Number(inventoryMismatch) + Number(apMismatch) + Number(!trialBalanceOk),
    missingPostings: {
      orders: missingOrders,
      payments: missingPayments,
      expenses: missingExpenses,
      purchases: missingPurchases,
      supplierPayments: missingSupplierPayments,
      creditPayouts: missingCreditPayouts,
      settlements: missingSettlements,
    },
    podCompliance7d,
  });
}
