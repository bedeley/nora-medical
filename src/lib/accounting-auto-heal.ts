import { prisma } from "@/lib/prisma";
import {
  postDeliverySettlementEntry,
  postExpenseEntry,
  postOrderEntry,
  postPaymentEntry,
  postPurchaseEntry,
  postStoreCreditPayoutEntry,
  postSupplierPaymentEntry,
} from "@/lib/accounting-posting";

type HealResult = {
  posted: {
    orders: number;
    payments: number;
    expenses: number;
    purchases: number;
    supplierPayments: number;
    creditPayouts: number;
    settlements: number;
  };
};

export async function autoHealMissingPostings(): Promise<HealResult> {
  const result: HealResult = {
    posted: {
      orders: 0,
      payments: 0,
      expenses: 0,
      purchases: 0,
      supplierPayments: 0,
      creditPayouts: 0,
      settlements: 0,
    },
  };

  const [orders, payments, expenses, purchases, supplierPayments, creditPayouts, settlementLogs] =
    await Promise.all([
      prisma.order.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } }),
      prisma.payment.findMany({
        where: { deletedAt: null },
        select: { id: true, status: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.expense.findMany({
        where: { deletedAt: null },
        select: { id: true, amount: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.purchase.findMany({
        where: { deletedAt: null, status: "RECEIVED" },
        select: { id: true, unitCost: true, quantity: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.supplierPayment.findMany({
        where: { deletedAt: null, status: "NORMAL" },
        select: { id: true, method: true, reference: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.payment.findMany({
        where: {
          deletedAt: null,
          status: "REFUND",
          refundDisposition: "CASH",
          note: { contains: "\"location\":\"admin/customers:credit-payout\"" },
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.auditLog.findMany({
        where: {
          entityType: "DELIVERY_SETTLEMENT",
          action: "DELIVERY_COLLECTION_SETTLEMENT_CREATED",
        },
        select: { entityId: true, meta: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: 2000,
      }),
    ]);

  const [orderPosts, paymentPosts, expensePosts, purchasePosts, settlementPosts] = await Promise.all([
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
    prisma.journalEntry.findMany({
      where: { sourceType: "MANUAL", status: "POSTED", sourceId: { not: null } },
      select: { sourceId: true },
    }),
  ]);

  const orderPostedIds = new Set(orderPosts.map((row) => row.sourceId as string));
  const paymentPostedIds = new Set(paymentPosts.map((row) => row.sourceId as string));
  const expensePostedIds = new Set(expensePosts.map((row) => row.sourceId as string));
  const purchasePostedIds = new Set(purchasePosts.map((row) => row.sourceId as string));
  const settlementPostedIds = new Set(settlementPosts.map((row) => row.sourceId as string));

  for (const order of orders) {
    if (orderPostedIds.has(order.id)) continue;
    const entry = await postOrderEntry({ orderId: order.id });
    if (entry) result.posted.orders += 1;
  }

  for (const payment of payments) {
    const status = String(payment.status || "").toUpperCase();
    if (status === "REFUND" || status === "VOID") continue;
    if (paymentPostedIds.has(payment.id)) continue;
    const entry = await postPaymentEntry({ paymentId: payment.id });
    if (entry) result.posted.payments += 1;
  }

  for (const expense of expenses) {
    if (expensePostedIds.has(expense.id)) continue;
    const entry = await postExpenseEntry({
      expenseId: expense.id,
      amount: Number(expense.amount || 0),
      createdAt: expense.createdAt,
    });
    if (entry) result.posted.expenses += 1;
  }

  for (const purchase of purchases) {
    if (purchasePostedIds.has(purchase.id)) continue;
    const amount = Number(purchase.unitCost || 0) * Number(purchase.quantity || 0);
    const entry = await postPurchaseEntry({
      purchaseId: purchase.id,
      amount,
      createdAt: purchase.createdAt,
      memo: "Auto-healed purchase posting",
    });
    if (entry) result.posted.purchases += 1;
  }

  for (const supplierPayment of supplierPayments) {
    const method = String(supplierPayment.method || "").toLowerCase();
    if (method === "credit_memo") continue;
    if (String(supplierPayment.reference || "").toUpperCase() === "SUPPLIER_RETURN") continue;
    if (purchasePostedIds.has(supplierPayment.id)) continue;
    const entry = await postSupplierPaymentEntry({ supplierPaymentId: supplierPayment.id });
    if (entry) result.posted.supplierPayments += 1;
  }

  for (const payout of creditPayouts) {
    if (paymentPostedIds.has(payout.id)) continue;
    const entry = await postStoreCreditPayoutEntry({ paymentId: payout.id });
    if (entry) result.posted.creditPayouts += 1;
  }

  for (const settlement of settlementLogs) {
    if (settlementPostedIds.has(settlement.entityId)) continue;
    let meta: {
      totalBalance?: number;
      totalClaimed?: number;
      settledAt?: string;
      receivedBy?: string;
      reference?: string;
      note?: string;
      destination?: "CASH" | "BANK";
    } | null = null;
    try {
      meta = JSON.parse(settlement.meta || "{}") as {
        totalBalance?: number;
        settledAt?: string;
        receivedBy?: string;
        reference?: string;
        note?: string;
        destination?: "CASH" | "BANK";
      };
    } catch {
      meta = null;
    }
    const amount = Number(meta?.totalBalance ?? meta?.totalClaimed ?? 0);
    if (!(amount > 0)) continue;
    const entry = await postDeliverySettlementEntry({
      settlementId: settlement.entityId,
      amount,
      settledAt: new Date(String(meta?.settledAt || settlement.createdAt.toISOString())),
      receivedBy: String(meta?.receivedBy || "").trim() || null,
      reference: String(meta?.reference || "").trim() || null,
      note: String(meta?.note || "").trim() || null,
      destination: meta?.destination === "BANK" ? "BANK" : "CASH",
    });
    if (entry) result.posted.settlements += 1;
  }

  return result;
}
