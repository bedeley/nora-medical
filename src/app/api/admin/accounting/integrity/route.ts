import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loadAccountTotals, parseDateRange, toNet } from "@/app/api/admin/accounting/reports/utils";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function parseAsOfUtcEnd(asOf?: string | null) {
  if (!asOf) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  return new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
}

function toBaseSourceId(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.split(":")[0] || raw;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const asOf = searchParams.get("asOf");
  const asOfEnd = parseAsOfUtcEnd(asOf);
  if (asOf && asOfEnd === null) {
    return NextResponse.json({ error: "Invalid as-of date" }, { status: 400 });
  }
  const dateFilter = asOfEnd ? parseDateRange(null, asOfEnd.toISOString()) : undefined;
  const orderWhere = asOfEnd
    ? { status: { not: "CANCELLED" }, createdAt: { lte: asOfEnd } }
    : { status: { not: "CANCELLED" } };
  const paymentWhere = asOfEnd
    ? { deletedAt: null, createdAt: { lte: asOfEnd } }
    : { deletedAt: null };
  const movementWhere = asOfEnd
    ? { deletedAt: null, createdAt: { lte: asOfEnd } }
    : { deletedAt: null };

  const arAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1100" },
    select: { id: true },
  });

  const [draftEntries, totals, products, orders, payments, expenses, purchases, supplierPayments, creditPayouts, orderArLines, movements] =
    await Promise.all([
      prisma.journalEntry.count({ where: { status: "DRAFT" } }),
      loadAccountTotals(dateFilter),
      prisma.product.findMany({ select: { id: true, stock: true, cost: true } }),
      prisma.order.findMany({ select: { id: true }, where: orderWhere }),
      prisma.payment.findMany({
        select: { id: true, amount: true, status: true, refundDisposition: true, note: true, createdAt: true },
        where: paymentWhere,
      }),
      prisma.expense.findMany({ select: { id: true }, where: { deletedAt: null } }),
      prisma.purchase.findMany({
        select: { id: true },
        where: { deletedAt: null, status: "RECEIVED" },
      }),
      prisma.supplierPayment.findMany({
        select: { id: true, method: true, reference: true, amount: true, paidAt: true, createdAt: true },
        where: { deletedAt: null, status: "NORMAL" },
      }),
      prisma.payment.findMany({
        where: {
          deletedAt: null,
          status: "REFUND",
          refundDisposition: "CASH",
          note: { contains: "\"location\":\"admin/customers:credit-payout\"" },
        },
        select: { id: true, amount: true, createdAt: true, note: true },
      }),
      prisma.journalLine.findMany({
        where: {
          accountId: arAccount?.id ?? "__missing_ar_account__",
          entry: {
            status: "POSTED",
            sourceType: "ORDER",
            entryDate: dateFilter,
          },
        },
        select: { debit: true, credit: true },
      }),
      prisma.inventoryMovement.groupBy({
        by: ["productId"],
        where: movementWhere,
        _sum: { delta: true },
      }),
    ]);
  const settlementLogs = await prisma.auditLog.findMany({
    where: {
      entityType: "DELIVERY_SETTLEMENT",
      action: "DELIVERY_COLLECTION_SETTLEMENT_CREATED",
    },
    select: { entityId: true, meta: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  const settlements = settlementLogs
    .map((log) => {
      let totalBalance = 0;
      let receivedBy = "";
      try {
        const meta = JSON.parse(log.meta || "{}") as { totalBalance?: number; receivedBy?: string };
        totalBalance = Number(meta.totalBalance || 0);
        receivedBy = String(meta.receivedBy || "");
      } catch {
        totalBalance = 0;
      }
      return {
        id: log.entityId,
        totalBalance,
        receivedBy,
        createdAt: log.createdAt,
      };
    })
    .filter((row) => row.totalBalance > 0);

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
  const stockMap = new Map<string, number>();
  for (const m of movements) {
    stockMap.set(m.productId, (stockMap.get(m.productId) ?? 0) + Number(m._sum.delta || 0));
  }
  // Use ledger as authoritative valuation to avoid drift from costing differences.
  const inventoryValuation = inventoryLedger;
  const negativeStockCount = products.filter((product) => (stockMap.get(product.id) ?? 0) < 0).length;

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
      where: { sourceType: "MANUAL", status: "POSTED", sourceId: { in: settlements.map((s) => s.id) } },
      select: { sourceId: true },
    }),
  ]);

  const orderPostedIds = new Set(orderPosts.map((row) => String(row.sourceId || "")));
  const paymentPostedIds = new Set(paymentPosts.map((row) => toBaseSourceId(row.sourceId)));
  const expensePostedIds = new Set(expensePosts.map((row) => row.sourceId as string));
  const purchasePostedIds = new Set(purchasePosts.map((row) => toBaseSourceId(row.sourceId)));
  const settlementPostedIds = new Set(settlementPosts.map((row) => row.sourceId as string));

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
  const missingSettlements = settlements.filter((row) => !settlementPostedIds.has(row.id)).length;

  const missingOrderIds = orders.filter((row) => !orderPostedIds.has(row.id)).map((row) => row.id);
  const missingPaymentIds = eligiblePayments
    .filter((row) => !paymentPostedIds.has(row.id))
    .map((row) => row.id);
  const missingExpenseIds = expenses.filter((row) => !expensePostedIds.has(row.id)).map((row) => row.id);
  const missingPurchaseIds = purchases.filter((row) => !purchasePostedIds.has(row.id)).map((row) => row.id);
  const missingSupplierPaymentIds = eligibleSupplierPayments
    .filter((row) => !purchasePostedIds.has(row.id))
    .map((row) => row.id);
  const missingCreditPayoutIds = creditPayouts.filter((row) => !paymentPostedIds.has(row.id)).map((row) => row.id);
  const missingSettlementIds = settlements.filter((row) => !settlementPostedIds.has(row.id)).map((row) => row.id);

  const [
    missingOrderItems,
    missingPaymentItems,
    missingExpenseItems,
    missingPurchaseItems,
    missingSettlementItems,
    missingSupplierPaymentItems,
    missingCreditPayoutItems,
  ] =
    await Promise.all([
      missingOrderIds.length
        ? prisma.order.findMany({
            where: { id: { in: missingOrderIds.slice(0, 20) } },
            select: {
              id: true,
              invoiceNumber: true,
              total: true,
              amountPaid: true,
              status: true,
              createdAt: true,
            },
          })
        : [],
      missingPaymentIds.length
        ? prisma.payment.findMany({
            where: { id: { in: missingPaymentIds.slice(0, 20) } },
            select: {
              id: true,
              amount: true,
              status: true,
              refundDisposition: true,
              createdAt: true,
              note: true,
              order: { select: { id: true, invoiceNumber: true } },
              user: { select: { id: true, name: true, email: true } },
            },
          })
        : [],
      missingExpenseIds.length
        ? prisma.expense.findMany({
            where: { id: { in: missingExpenseIds.slice(0, 20) } },
            select: { id: true, amount: true, note: true, createdAt: true },
          })
        : [],
      missingPurchaseIds.length
        ? prisma.purchase.findMany({
            where: { id: { in: missingPurchaseIds.slice(0, 20) } },
            select: {
              id: true,
              quantity: true,
              unitCost: true,
              status: true,
              createdAt: true,
              supplier: true,
              supplierRef: { select: { name: true } },
              product: { select: { name: true, sku: true } },
            },
          })
        : [],
      missingSettlementIds.length
        ? Promise.resolve(
            settlements
              .filter((row) => missingSettlementIds.includes(row.id))
              .slice(0, 20)
              .map((row) => ({
                id: row.id,
                totalBalance: row.totalBalance,
                receivedBy: row.receivedBy || null,
                createdAt: row.createdAt,
              })),
          )
        : Promise.resolve([]),
      missingSupplierPaymentIds.length
        ? Promise.resolve(
            eligibleSupplierPayments
              .filter((row) => missingSupplierPaymentIds.includes(row.id))
              .slice(0, 20)
              .map((row) => ({
                id: row.id,
                amount: Number(row.amount || 0),
                method: row.method,
                reference: row.reference,
                createdAt: row.paidAt || row.createdAt,
              })),
          )
        : Promise.resolve([]),
      missingCreditPayoutIds.length
        ? Promise.resolve(
            creditPayouts
              .filter((row) => missingCreditPayoutIds.includes(row.id))
              .slice(0, 20)
              .map((row) => ({
                id: row.id,
                amount: Number(row.amount || 0),
                createdAt: row.createdAt,
                note: row.note || null,
              })),
          )
        : Promise.resolve([]),
    ]);

  const paymentPostFailures = missingPaymentIds.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "PAYMENT",
          entityId: { in: missingPaymentIds },
          action: { in: ["ACCOUNTING_POST_SKIPPED", "ACCOUNTING_POST_FAILED"] },
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          action: true,
          entityId: true,
          meta: true,
          createdAt: true,
        },
      })
    : [];

  const recentPostFailures = await prisma.auditLog.findMany({
    where: {
      action: {
        in: [
          "ACCOUNTING_POST_SKIPPED",
          "ACCOUNTING_POST_FAILED",
          "RETURN_POSTING_FAILED",
          "DELIVERY_COLLECTION_SETTLEMENT_POST_FAILED",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      meta: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    draftEntries,
    arLedger,
    customerBalances,
    arDifference: arLedger - customerBalances,
    inventoryLedger,
    inventoryValuation,
    inventoryDifference: inventoryLedger - inventoryValuation,
    negativeStockCount,
    missingPostings: {
      orders: missingOrders,
      payments: missingPayments,
      expenses: missingExpenses,
      purchases: missingPurchases,
      supplierPayments: missingSupplierPayments,
      creditPayouts: missingCreditPayouts,
      settlements: missingSettlements,
    },
    missingPostingItems: {
      orders: missingOrderItems,
      payments: missingPaymentItems.map((payment) => {
        let noteMeta: { reference?: string; method?: string; balanceAdjustment?: boolean } | null = null;
        if (payment.note) {
          try {
            const parsed = JSON.parse(payment.note) as {
              reference?: string;
              method?: string;
              balanceAdjustment?: boolean;
            };
            noteMeta = parsed;
          } catch {
            noteMeta = null;
          }
        }
        const failureRow = paymentPostFailures.find((row) => row.entityId === payment.id);
        let failureMeta: Record<string, unknown> | null = null;
        let failureReason: string | undefined;
        if (failureRow?.meta) {
          try {
            const parsed = JSON.parse(failureRow.meta) as Record<string, unknown>;
            failureMeta = parsed;
            if (typeof parsed.reason === "string") {
              failureReason = parsed.reason;
            }
          } catch {
            failureMeta = null;
          }
        }
        return {
          ...payment,
          noteMeta,
          postingFailure: failureRow
            ? {
                action: failureRow.action,
                reason: failureReason,
                meta: failureMeta,
                createdAt: failureRow.createdAt.toISOString(),
              }
            : null,
        };
      }),
      expenses: missingExpenseItems,
      purchases: missingPurchaseItems,
      settlements: missingSettlementItems,
      supplierPayments: missingSupplierPaymentItems,
      creditPayouts: missingCreditPayoutItems,
    },
    recentPostFailures: recentPostFailures.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      meta: row.meta,
      createdAt: row.createdAt.toISOString(),
    })),
  });
}
