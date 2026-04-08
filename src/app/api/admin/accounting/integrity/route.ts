import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { Prisma } from "@prisma/client";
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
  const purchaseWhere: Prisma.PurchaseWhereInput = {
    deletedAt: null,
    status: "RECEIVED",
    ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
  };
  const supplierPaymentWhere: Prisma.SupplierPaymentWhereInput = {
    deletedAt: null,
    status: "NORMAL",
    ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
  };
  const creditPayoutWhere: Prisma.PaymentWhereInput = {
    deletedAt: null,
    status: "REFUND",
    refundDisposition: "CASH",
    note: { contains: "\"location\":\"admin/customers:credit-payout\"" },
    ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
  };
  const movementWhere = asOfEnd
    ? { deletedAt: null, createdAt: { lte: asOfEnd } }
    : { deletedAt: null };

  const arAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1100" },
    select: { id: true },
  });

  const [draftEntries, totals, products, orders, payments, expenses, purchases, supplierPayments, creditPayouts, orderArLines, movements] =
    await Promise.all([
      prisma.journalEntry.count({
        where: {
          status: "DRAFT",
          ...(dateFilter && (dateFilter.gte || dateFilter.lte) ? { entryDate: dateFilter } : {}),
        },
      }),
      loadAccountTotals(dateFilter),
      prisma.product.findMany({ select: { id: true, stock: true, cost: true } }),
      prisma.order.findMany({ select: { id: true }, where: orderWhere }),
      prisma.payment.findMany({
        select: { id: true, orderId: true, amount: true, status: true, refundDisposition: true, note: true, createdAt: true },
        where: paymentWhere,
      }),
      prisma.expense.findMany({ select: { id: true }, where: { deletedAt: null } }),
      prisma.purchase.findMany({
        select: { id: true, unitCost: true, quantity: true },
        where: purchaseWhere,
      }),
      prisma.supplierPayment.findMany({
        select: { id: true, method: true, reference: true, amount: true, paidAt: true, createdAt: true },
        where: supplierPaymentWhere,
      }),
      prisma.payment.findMany({
        where: creditPayoutWhere,
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
      ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
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
  const apRow = totalsByCode.get("2000");
  const revenueRow = totalsByCode.get("4000");
  const cogsRow = totalsByCode.get("5000");
  const vatRow = totalsByCode.get("2100");
  const arLedger = arRow ? toNet(arRow) : 0;
  const inventoryLedger = inventoryRow ? toNet(inventoryRow) : 0;
  const apLedger = apRow ? toNet(apRow) : 0;
  // Trial balance: sum of all debits minus sum of all credits across all posted entries — must be 0 if balanced.
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
  const stockMap = new Map<string, number>();
  for (const m of movements) {
    stockMap.set(m.productId, (stockMap.get(m.productId) ?? 0) + Number(m._sum.delta || 0));
  }
  // Inventory valuation: movement-based stock × unit cost per product.
  const inventoryValuation = products.reduce(
    (sum, product) => sum + (stockMap.get(product.id) ?? 0) * Number(product.cost || 0),
    0,
  );
  const negativeStockCount = products.filter((product) => (stockMap.get(product.id) ?? 0) < 0).length;
  const eligibleSupplierPayments = supplierPayments.filter((row) => {
    const method = String(row.method || "").toLowerCase();
    if (method === "credit_memo") return false;
    if (String(row.reference || "").toUpperCase() === "SUPPLIER_RETURN") return false;
    return true;
  });
  // AP: total received purchase cost vs. eligible supplier settlements (GL vs operational).
  const apOperational =
    purchases.reduce((sum, row) => sum + Number(row.unitCost || 0) * Number(row.quantity || 0), 0) -
    eligibleSupplierPayments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const purchaseIds = new Set(purchases.map((row) => row.id));
  const supplierPaymentIds = new Set(eligibleSupplierPayments.map((row) => row.id));
  const orderIds = new Set(orders.map((row) => row.id));
  let inventoryPurchaseBacked = 0;
  let inventoryGlOnly = 0;
  let apOperationalBacked = 0;
  let apGlOnly = 0;
  let revenueOrderBacked = 0;
  let revenueGlOnly = 0;
  let cogsOrderBacked = 0;
  let cogsGlOnly = 0;
  let vatOrderBacked = 0;
  let vatGlOnly = 0;
  const classifiedAccountIds = [inventoryRow?.accountId, apRow?.accountId, revenueRow?.accountId, cogsRow?.accountId, vatRow?.accountId]
    .filter(Boolean) as string[];
  if (classifiedAccountIds.length > 0) {
    const classifiedLines = await prisma.journalLine.findMany({
      where: {
        accountId: { in: classifiedAccountIds },
        entry: {
          status: "POSTED",
          ...(dateFilter && (dateFilter.gte || dateFilter.lte) ? { entryDate: dateFilter } : {}),
        },
      },
      select: {
        accountId: true,
        debit: true,
        credit: true,
        entry: { select: { sourceId: true } },
      },
    });
    for (const line of classifiedLines) {
      const amount = Number(line.credit || 0) - Number(line.debit || 0);
      const baseSourceId = toBaseSourceId(line.entry.sourceId);
      if (line.accountId === inventoryRow?.accountId) {
        if (baseSourceId && purchaseIds.has(baseSourceId)) inventoryPurchaseBacked += Number(line.debit || 0) - Number(line.credit || 0);
        else inventoryGlOnly += Number(line.debit || 0) - Number(line.credit || 0);
        continue;
      }
      if (line.accountId === apRow?.accountId) {
        if ((baseSourceId && purchaseIds.has(baseSourceId)) || (baseSourceId && supplierPaymentIds.has(baseSourceId))) {
          apOperationalBacked += amount;
        } else {
          apGlOnly += amount;
        }
        continue;
      }
      if (line.accountId === revenueRow?.accountId) {
        if (baseSourceId && orderIds.has(baseSourceId)) revenueOrderBacked += amount;
        else revenueGlOnly += amount;
        continue;
      }
      if (line.accountId === cogsRow?.accountId) {
        const expenseAmount = Number(line.debit || 0) - Number(line.credit || 0);
        if (baseSourceId && orderIds.has(baseSourceId)) cogsOrderBacked += expenseAmount;
        else cogsGlOnly += expenseAmount;
        continue;
      }
      if (line.accountId === vatRow?.accountId) {
        if (baseSourceId && orderIds.has(baseSourceId)) vatOrderBacked += amount;
        else vatGlOnly += amount;
      }
    }
  }

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

  // ─── Extended checks ──────────────────────────────────────────────────────

  const [orderAggregates, cogsItems, allOrdersCandidates, draftEntrySamples, supplierPaymentsByPurchase] =
    await Promise.all([
      // Revenue + VAT: aggregate non-cancelled order subtotals and tax
      prisma.order.aggregate({
        _sum: { subtotal: true, taxAmount: true },
        where: {
          status: { not: "CANCELLED" },
          deletedAt: null,
          ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
        },
      }),
      // COGS: cost of items sold (costAtSale × net qty)
      prisma.orderItem.findMany({
        select: { costAtSale: true, quantity: true, returnedQuantity: true },
        where: {
          order: {
            status: { not: "CANCELLED" },
            deletedAt: null,
            ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
          },
        },
      }),
      // Orders for overpayment + balance consistency checks (most recent 2000)
      prisma.order.findMany({
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          amountPaid: true,
          balance: true,
          status: true,
          createdAt: true,
        },
        where: {
          deletedAt: null,
          status: { not: "CANCELLED" },
          ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 2000,
      }),
      // Draft entries for aging breakdown
      prisma.journalEntry.findMany({
        where: {
          status: "DRAFT",
          ...(dateFilter && (dateFilter.gte || dateFilter.lte) ? { entryDate: dateFilter } : {}),
        },
        select: { id: true, memo: true, sourceType: true, sourceId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: 100,
      }),
      // Supplier payments totalled per purchase for overpayment check
      prisma.supplierPayment.groupBy({
        by: ["purchaseId"],
        where: {
          deletedAt: null,
          status: "NORMAL",
          purchaseId: { not: null },
          ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
        },
        _sum: { amount: true },
      }),
    ]);

  // ── Revenue, COGS, VAT, Store-credit GL balances (already in totals) ──
  const glRevenue = totalsByCode.get("4000") ? toNet(totalsByCode.get("4000")!) : 0;
  const glCogs = totalsByCode.get("5000") ? toNet(totalsByCode.get("5000")!) : 0;
  const glVat = totalsByCode.get("2100") ? toNet(totalsByCode.get("2100")!) : 0;
  const glStoreCredit = totalsByCode.get("2200") ? toNet(totalsByCode.get("2200")!) : 0;
  const glCash = totalsByCode.get("1000") ? toNet(totalsByCode.get("1000")!) : 0;
  const glBank = totalsByCode.get("1010") ? toNet(totalsByCode.get("1010")!) : 0;

  const revenueOperational = Number(orderAggregates._sum.subtotal || 0);
  const vatOperational = Number(orderAggregates._sum.taxAmount || 0);
  const revenueDifference = glRevenue - revenueOperational;
  const vatDifference = glVat - vatOperational;

  const cogsOperational = cogsItems.reduce((sum, item) => {
    const soldQty = Math.max(0, Number(item.quantity || 0) - Number(item.returnedQuantity || 0));
    return sum + soldQty * Number(item.costAtSale || 0);
  }, 0);
  const cogsDifference = glCogs - cogsOperational;

  // Store credit: credit-disposition refunds issued minus credit payouts made
  const creditRefundTotal = payments
    .filter(
      (p) =>
        String(p.status || "").toUpperCase() === "REFUND" &&
        String(p.refundDisposition || "").toUpperCase() === "CREDIT",
    )
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const creditPayoutTotal = creditPayouts.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const storeCreditOperational = creditRefundTotal - creditPayoutTotal;
  const storeCreditDifference = glStoreCredit - storeCreditOperational;

  // ── Draft entry aging ──
  const nowMs = Date.now();
  const draftAging = { fresh: 0, warning: 0, old: 0, critical: 0 };
  for (const entry of draftEntrySamples) {
    const ageDays = Math.floor((nowMs - entry.createdAt.getTime()) / 86400000);
    if (ageDays > 30) draftAging.critical++;
    else if (ageDays > 7) draftAging.old++;
    else if (ageDays >= 3) draftAging.warning++;
    else draftAging.fresh++;
  }
  // Return oldest 10 as a traceable sample
  const draftEntriesForUI = draftEntrySamples.slice(-10).map((e) => ({
    id: e.id,
    memo: e.memo || null,
    sourceType: e.sourceType || null,
    sourceId: e.sourceId || null,
    createdAt: e.createdAt.toISOString(),
  }));

  // ── Duplicate payments: same orderId + amount within 24 h ──
  const paymentsWithOrder = payments.filter(
    (p) => String(p.status || "").toUpperCase() === "NORMAL" && p.orderId,
  );
  const dupeMap = new Map<string, typeof paymentsWithOrder>();
  for (const p of paymentsWithOrder) {
    const key = `${p.orderId}:${Number(p.amount).toFixed(2)}`;
    if (!dupeMap.has(key)) dupeMap.set(key, []);
    dupeMap.get(key)!.push(p);
  }
  const duplicatePaymentGroups = Array.from(dupeMap.values()).filter((group) => {
    if (group.length < 2) return false;
    const times = group.map((p) => new Date(p.createdAt).getTime()).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] < 86_400_000) return true;
    }
    return false;
  });
  const duplicatePaymentItems = duplicatePaymentGroups
    .flatMap((group) => group)
    .slice(0, 20)
    .map((p) => ({
      id: p.id,
      orderId: p.orderId || null,
      amount: Number(p.amount),
      createdAt: new Date(p.createdAt).toISOString(),
    }));

  // ── Customer overpayments: amountPaid > total ──
  const customerOverpaymentItems = allOrdersCandidates
    .filter((o) => Number(o.amountPaid || 0) > Number(o.total || 0) + 0.01)
    .slice(0, 20)
    .map((o) => ({
      id: o.id,
      invoiceNumber: o.invoiceNumber || null,
      total: Number(o.total || 0),
      amountPaid: Number(o.amountPaid || 0),
      excess: Number(o.amountPaid || 0) - Number(o.total || 0),
      createdAt: o.createdAt.toISOString(),
    }));

  // ── Order balance consistency ──
  const orderBalanceIssueItems = allOrdersCandidates
    .filter((o) => {
      const paid = Number(o.amountPaid || 0);
      const total = Number(o.total || 0);
      const balance = Number(o.balance || 0);
      // Marked PAID but still has a positive balance (underpayment discrepancy)
      if (o.status === "PAID" && balance > 0.01) return true;
      // amountPaid exceeds total (overpayment in source record)
      if (paid > total + 0.01) return true;
      return false;
    })
    .slice(0, 20)
    .map((o) => {
      const paid = Number(o.amountPaid || 0);
      const total = Number(o.total || 0);
      const balance = Number(o.balance || 0);
      let issue: string;
      if (paid > total + 0.01) issue = "overpaid";
      else if (o.status === "PAID" && balance > 0.01) issue = "paid_with_balance";
      else issue = "inconsistent";
      return {
        id: o.id,
        invoiceNumber: o.invoiceNumber || null,
        status: o.status,
        total,
        amountPaid: paid,
        balance,
        issue,
        createdAt: o.createdAt.toISOString(),
      };
    });

  // ── Supplier overpayments: total paid > purchase cost ──
  const supplierOverpaymentItems = supplierPaymentsByPurchase
    .filter((group) => {
      if (!group.purchaseId) return false;
      const purchase = purchases.find((p) => p.id === group.purchaseId);
      if (!purchase) return false;
      const totalPaid = Number(group._sum.amount || 0);
      const purchaseCost = Number(purchase.unitCost || 0) * Number(purchase.quantity || 0);
      return totalPaid > purchaseCost + 0.01;
    })
    .slice(0, 20)
    .map((group) => {
      const purchase = purchases.find((p) => p.id === group.purchaseId)!;
      const totalPaid = Number(group._sum.amount || 0);
      const purchaseCost = Number(purchase.unitCost || 0) * Number(purchase.quantity || 0);
      return {
        purchaseId: group.purchaseId!,
        totalPaid,
        purchaseCost,
        excess: totalPaid - purchaseCost,
      };
    });

  return NextResponse.json({
    draftEntries,
    arLedger,
    customerBalances,
    arDifference: arLedger - customerBalances,
    inventoryLedger,
    inventoryValuation,
    inventoryDifference: inventoryLedger - inventoryValuation,
    inventoryPurchaseBacked,
    inventoryGlOnly,
    negativeStockCount,
    apLedger,
    apOperational,
    apDifference: apLedger - apOperational,
    apOperationalBacked,
    apGlOnly,
    trialBalance,
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
    // ── Extended reconciliation checks ──
    glRevenue,
    revenueOperational,
    revenueDifference,
    revenueOrderBacked,
    revenueGlOnly,
    glCogs,
    cogsOperational,
    cogsDifference,
    cogsOrderBacked,
    cogsGlOnly,
    glVat,
    vatOperational,
    vatDifference,
    vatOrderBacked,
    vatGlOnly,
    glStoreCredit,
    storeCreditOperational,
    storeCreditDifference,
    glCash,
    glBank,
    // ── Data quality checks ──
    draftAging,
    draftEntriesSample: draftEntriesForUI,
    duplicatePayments: {
      count: duplicatePaymentGroups.length,
      items: duplicatePaymentItems,
    },
    customerOverpayments: {
      count: customerOverpaymentItems.length,
      items: customerOverpaymentItems,
    },
    orderBalanceIssues: {
      count: orderBalanceIssueItems.length,
      items: orderBalanceIssueItems,
    },
    supplierOverpayments: {
      count: supplierOverpaymentItems.length,
      items: supplierOverpaymentItems,
    },
  });
}
