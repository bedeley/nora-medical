import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { setFeatureEnabled } from "@/lib/features";
import {
  postExpenseEntry,
  postDeliverySettlementEntry,
  postOrderEntry,
  postPaymentEntry,
  postPurchaseEntry,
  postStoreCreditPayoutEntry,
  postSupplierPaymentEntry,
  postPayrollAccrualEntry,
  postPayrollSettlementEntry,
} from "@/lib/accounting-posting";
import { loadAccountTotals, toNet } from "@/app/api/admin/accounting/reports/utils";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN";
}

const EPSILON = 0.01;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-accounting-sync", 60_000, 5);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    await setFeatureEnabled("accounting_auto_post", true);

    const [orders, payments, expenses, payrollRuns, purchases, supplierPayments, creditPayouts, settlementLogs] = await Promise.all([
      prisma.order.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } }),
      prisma.payment.findMany({
        where: { deletedAt: null },
        select: { id: true, status: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.expense.findMany({
        where: { deletedAt: null },
        select: { id: true, amount: true, createdAt: true, category: true, payrollRunId: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.payrollRun.findMany({
        where: { status: { in: ["FINALIZED", "PAID"] } },
        select: { id: true, status: true },
        orderBy: { periodStart: "asc" },
      }),
      prisma.purchase.findMany({
        where: { deletedAt: null, status: "RECEIVED" },
        select: { id: true, unitCost: true, quantity: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.supplierPayment.findMany({
        where: { deletedAt: null, status: "NORMAL" },
        select: { id: true },
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

    let postedOrders = 0;
    let postedPayments = 0;
    let postedExpenses = 0;
    let postedPurchases = 0;
    let postedSupplierPayments = 0;
    let postedCreditPayouts = 0;
    let postedSettlements = 0;
    let postedPayrollAccruals = 0;
    let postedPayrollSettlements = 0;

    for (const order of orders) {
      const entry = await postOrderEntry({ orderId: order.id });
      if (entry) postedOrders += 1;
    }

    for (const payment of payments) {
      const status = String(payment.status || "").toUpperCase();
      if (status === "REFUND" || status === "VOID") continue;
      const entry = await postPaymentEntry({ paymentId: payment.id });
      if (entry) postedPayments += 1;
    }

    for (const expense of expenses) {
      if (expense.payrollRunId) continue;
      const entry = await postExpenseEntry({
        expenseId: expense.id,
        amount: Number(expense.amount || 0),
        createdAt: expense.createdAt,
        category: expense.category,
      });
      if (entry) postedExpenses += 1;
    }

    for (const run of payrollRuns) {
      const accrual = await postPayrollAccrualEntry({ payrollRunId: run.id });
      if (accrual) postedPayrollAccruals += 1;
      if (run.status === "PAID") {
        const settlement = await postPayrollSettlementEntry({ payrollRunId: run.id });
        if (settlement) postedPayrollSettlements += 1;
      }
    }

    for (const purchase of purchases) {
      const amount = Number(purchase.unitCost || 0) * Number(purchase.quantity || 0);
      const entry = await postPurchaseEntry({
        purchaseId: purchase.id,
        amount,
        createdAt: purchase.createdAt,
        memo: "Backfilled purchase",
      });
      if (entry) postedPurchases += 1;
    }

    for (const payment of supplierPayments) {
      const entry = await postSupplierPaymentEntry({ supplierPaymentId: payment.id });
      if (entry) postedSupplierPayments += 1;
    }

    for (const payout of creditPayouts) {
      const entry = await postStoreCreditPayoutEntry({ paymentId: payout.id });
      if (entry) postedCreditPayouts += 1;
    }

    for (const settlement of settlementLogs) {
      let meta: {
        totalBalance?: number;
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
      const amount = Number(meta?.totalBalance || 0);
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
      if (entry) postedSettlements += 1;
    }

    const totals = await loadAccountTotals();
    const inventoryRow = totals.find((row) => row.code === "1200");
    if (!inventoryRow) {
      return NextResponse.json({ error: "Inventory ledger account (1200) not found." }, { status: 400 });
    }

    const inventoryLedger = toNet(inventoryRow);
    const products = await prisma.product.findMany({ select: { stock: true, cost: true } });
    const inventoryValuation = products.reduce(
      (sum, product) => sum + Number(product.cost || 0) * Number(product.stock || 0),
      0,
    );
    const difference = inventoryLedger - inventoryValuation;

    let inventoryAdjustmentPosted = false;
    let inventoryAdjustmentAmount = 0;

    if (Math.abs(difference) >= EPSILON) {
      const inventoryAccountId =
        inventoryRow.accountId ||
        (await prisma.ledgerAccount.findUnique({ where: { code: "1200" } }))?.id;
      if (!inventoryAccountId) {
        return NextResponse.json({ error: "Inventory account (1200) missing." }, { status: 400 });
      }

      const offsetAccount =
        (await prisma.ledgerAccount.findUnique({ where: { code: "5000" } })) ||
        (await prisma.ledgerAccount.findUnique({ where: { code: "6000" } }));
      if (!offsetAccount) {
        return NextResponse.json({ error: "Missing offset account (5000 or 6000)." }, { status: 400 });
      }

      const adjustment = Math.abs(difference);
      const inventoryDebit = difference < 0 ? adjustment : 0;
      const inventoryCredit = difference > 0 ? adjustment : 0;
      const offsetDebit = difference > 0 ? adjustment : 0;
      const offsetCredit = difference < 0 ? adjustment : 0;

      await prisma.journalEntry.create({
        data: {
          entryDate: new Date(),
          memo: "Inventory valuation adjustment",
          sourceType: "MANUAL",
          status: "POSTED",
          approvedById: (session.user as AuthenticatedUser).id,
          approvedAt: new Date(),
          lines: {
            create: [
              {
                accountId: inventoryAccountId,
                debit: inventoryDebit,
                credit: inventoryCredit,
                description: "Inventory valuation alignment",
              },
              {
                accountId: offsetAccount.id,
                debit: offsetDebit,
                credit: offsetCredit,
                description: "Inventory valuation offset",
              },
            ],
          },
        },
      });

      inventoryAdjustmentPosted = true;
      inventoryAdjustmentAmount = adjustment;
    }

    try {
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: "ACCOUNTING_SYNC",
        entityType: "ACCOUNTING",
        entityId: "sync",
        meta: {
          postedOrders,
          postedPayments,
          postedExpenses,
          postedPurchases,
          postedSettlements,
          postedPayrollAccruals,
          postedPayrollSettlements,
          inventoryAdjustmentPosted,
          inventoryAdjustmentAmount,
          difference,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({
      ok: true,
      posted: {
        orders: postedOrders,
        payments: postedPayments,
        expenses: postedExpenses,
        purchases: postedPurchases,
        supplierPayments: postedSupplierPayments,
        creditPayouts: postedCreditPayouts,
        settlements: postedSettlements,
      },
      inventoryAdjustment: {
        posted: inventoryAdjustmentPosted,
        amount: inventoryAdjustmentAmount,
        difference,
      },
    });
  } catch (error) {
    console.error("Accounting sync error:", error);
    return NextResponse.json({ error: "Failed to sync accounting" }, { status: 500 });
  }
}
