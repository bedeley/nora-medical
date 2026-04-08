import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { Tooltip } from "@/components/ui/tooltip";
import Link from "next/link";
import { Info, AlertTriangle, CheckCircle, ExternalLink } from "lucide-react";
import { BackfillAutoApplyButton, BackfillStockMovementsButton } from "@/components/admin/CopySqlButton";
import HealthOpsPanel from "@/components/admin/HealthOpsPanel";
import { loadAccountTotals, toNet } from "@/app/api/admin/accounting/reports/utils";
import { getPodComplianceSnapshot } from "@/lib/pod-compliance";

function num(v: unknown) {
  return Number(v || 0);
}

function toBaseSourceId(value: string | null | undefined) {
  const sourceId = String(value || "").trim();
  if (!sourceId) return "";
  return sourceId.split(":")[0] || sourceId;
}

function parsePaymentNote(note?: string | null) {
  if (!note) return null;
  try {
    return JSON.parse(note) as {
      method?: string;
      provider?: string;
      status?: string;
      applied?: Array<{ orderId?: string; applied?: number }>;
    };
  } catch {
    return null;
  }
}

export default async function AdminHealthPage() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return (
      <section className="container mx-auto py-8">
        <p className="text-sm text-muted-foreground">Unauthorized.</p>
      </section>
    );
  }

  // ── Inventory ────────────────────────────────────────────────────────────────
  const products = await prisma.product.findMany({
    select: { id: true, name: true, stock: true, cost: true, archived: true, deletedAt: true },
    orderBy: { name: "asc" },
  });
  const movements = await prisma.inventoryMovement.groupBy({
    by: ["productId"],
    _sum: { delta: true },
  });
  const movementMap = new Map(movements.map((m) => [m.productId, num(m._sum.delta)]));
  const inStockCount = products.filter((p) => (movementMap.get(p.id) ?? 0) > 0).length;
  const negativeStockItems = products
    .map((p) => ({ id: p.id, name: p.name, movementSum: movementMap.get(p.id) ?? 0 }))
    .filter((p) => p.movementSum < 0);
  const stockMismatches = products
    .map((p) => ({
      id: p.id,
      name: p.name,
      stock: num(p.stock),
      movementSum: movementMap.get(p.id) ?? 0,
      archived: p.archived,
      deletedAt: p.deletedAt,
    }))
    .filter((p) => {
      if (p.deletedAt) return p.stock !== 0 || p.movementSum !== 0;
      return p.stock !== p.movementSum;
    });

  // ── Core data (parallelised) ─────────────────────────────────────────────────
  const [
    orders,
    totals,
    payments,
    expenses,
    purchases,
    orderPosts,
    paymentPosts,
    expensePosts,
    purchasePosts,
    paymentTotals,
    expensesAggregate,
    orderItems,
    supplierPayments,
    creditPayouts,
    settlementLogs,
    legacyAutoApply,
    draftCount,
    draftSamples,
    recentPostFailures,
    orderAggregates,
  ] = await Promise.all([
    // Non-cancelled only — fixes missing-orders over-count
    prisma.order.findMany({
      select: { id: true, total: true, amountPaid: true, balance: true, status: true },
      where: { status: { not: "CANCELLED" } },
    }),
    loadAccountTotals(undefined),
    // orderId needed for duplicate-payment detection
    prisma.payment.findMany({
      select: { id: true, amount: true, status: true, refundDisposition: true, note: true, createdAt: true, orderId: true },
      where: { deletedAt: null },
    }),
    prisma.expense.findMany({ select: { id: true }, where: { deletedAt: null } }),
    // unitCost + quantity needed for AP reconciliation and supplier overpayments
    prisma.purchase.findMany({
      select: { id: true, unitCost: true, quantity: true },
      where: { deletedAt: null, status: "RECEIVED" },
    }),
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
    prisma.payment.groupBy({ by: ["status"], _sum: { amount: true } }),
    prisma.expense.aggregate({ _sum: { amount: true } }),
    prisma.orderItem.findMany({
      select: { quantity: true, returnedQuantity: true, costAtSale: true, order: { select: { status: true } } },
    }),
    // amount + purchaseId needed for AP reconciliation and supplier overpayments
    prisma.supplierPayment.findMany({
      where: { deletedAt: null, status: "NORMAL" },
      select: { id: true, method: true, reference: true, amount: true, purchaseId: true },
    }),
    prisma.payment.findMany({
      where: {
        deletedAt: null,
        status: "REFUND",
        refundDisposition: "CASH",
        note: { contains: "\"location\":\"admin/customers:credit-payout\"" },
      },
      select: { id: true, amount: true },
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
    prisma.payment.findMany({
      where: { orderId: null, note: { contains: "\"reference\":\"AUTO_APPLY\"" } },
      select: { id: true, amount: true, note: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
    // Draft journal entries — count + aging sample
    prisma.journalEntry.count({ where: { status: "DRAFT" } }),
    prisma.journalEntry.findMany({
      where: { status: "DRAFT" },
      select: { createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 200,
    }),
    // Recent posting failures from audit log
    prisma.auditLog.findMany({
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
      select: { id: true, action: true, entityType: true, entityId: true, createdAt: true },
    }),
    // Revenue + VAT operational: sum of non-cancelled order subtotal and taxAmount
    prisma.order.aggregate({
      _sum: { subtotal: true, taxAmount: true },
      where: { status: { not: "CANCELLED" }, deletedAt: null },
    }),
  ]);

  // ── AR ledger (sequential: needs arAccount.id) ───────────────────────────────
  const arAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1100" },
    select: { id: true },
  });
  const orderArLines = arAccount
    ? await prisma.journalLine.findMany({
        where: {
          accountId: arAccount.id,
          entry: { status: "POSTED", sourceType: "ORDER" },
        },
        select: { debit: true, credit: true },
      })
    : [];

  // ── Settlement posting check (sequential: needs settlementIds) ───────────────
  const settlementIds = settlementLogs
    .map((log) => {
      if (!log.meta) return null;
      try {
        const meta = JSON.parse(log.meta) as { totalBalance?: number };
        return Number(meta.totalBalance || 0) > 0 ? log.entityId : null;
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

  // ── POD compliance (7-day window) ────────────────────────────────────────────
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

  // ── Posting completeness ─────────────────────────────────────────────────────
  const orderPostedIds = new Set(orderPosts.map((row) => row.sourceId as string));
  const paymentPostedIds = new Set(paymentPosts.map((row) => toBaseSourceId(row.sourceId as string)));
  const expensePostedIds = new Set(expensePosts.map((row) => row.sourceId as string));
  const purchasePostedIds = new Set(purchasePosts.map((row) => toBaseSourceId(row.sourceId as string)));
  const settlementPostedIds = new Set(
    settlementPosted.map((e) => e.sourceId).filter(Boolean) as string[],
  );

  const eligiblePayments = payments.filter((row) => {
    const amount = Number(row.amount || 0);
    if (amount <= 0) return false;
    const status = String(row.status || "").toUpperCase();
    if (status === "REFUND" || status === "VOID") return false;
    const disposition = String(row.refundDisposition || "").toUpperCase();
    if (disposition === "CREDIT") return false;
    if (row.note) {
      try {
        const meta = JSON.parse(row.note) as { reference?: string; balanceAdjustment?: boolean };
        if (meta.reference === "ITEM_RETURN") return false;
        if (meta.balanceAdjustment) return false;
      } catch { /* ignore */ }
    }
    return true;
  });
  const eligibleSupplierPayments = supplierPayments.filter((row) => {
    if (String(row.method || "").toLowerCase() === "credit_memo") return false;
    if (String(row.reference || "").toUpperCase() === "SUPPLIER_RETURN") return false;
    return true;
  });

  const missingOrders = orders.filter((row) => !orderPostedIds.has(row.id)).length;
  const missingPayments = eligiblePayments.filter((row) => !paymentPostedIds.has(row.id)).length;
  const missingExpenses = expenses.filter((row) => !expensePostedIds.has(row.id)).length;
  const missingPurchases = purchases.filter((row) => !purchasePostedIds.has(row.id)).length;
  const missingSupplierPayments = eligibleSupplierPayments.filter((row) => !purchasePostedIds.has(row.id)).length;
  const missingCreditPayouts = creditPayouts.filter((row) => !paymentPostedIds.has(row.id)).length;
  const missingSettlements = settlementIds.filter((id) => !settlementPostedIds.has(id)).length;
  const missingPostingTotal =
    missingOrders + missingPayments + missingExpenses + missingPurchases +
    missingSupplierPayments + missingCreditPayouts + missingSettlements;

  // ── GL account balances ──────────────────────────────────────────────────────
  const totalsByCode = new Map(totals.map((row) => [row.code, row]));
  const arRow = totalsByCode.get("1100");
  const inventoryRow = totalsByCode.get("1200");
  const apRow = totalsByCode.get("2000");
  const revenueRow = totalsByCode.get("4000");
  const cogsRow = totalsByCode.get("5000");
  const vatRow = totalsByCode.get("2100");
  const storeCreditRow = totalsByCode.get("2200");
  const cashRow = totalsByCode.get("1000");
  const bankRow = totalsByCode.get("1010");

  const arLedger = arRow ? toNet(arRow) : 0;
  const inventoryLedger = inventoryRow ? toNet(inventoryRow) : 0;
  const apLedger = apRow ? toNet(apRow) : 0;
  const glRevenue = revenueRow ? toNet(revenueRow) : 0;
  const glCogs = cogsRow ? toNet(cogsRow) : 0;
  const glVat = vatRow ? toNet(vatRow) : 0;
  const glStoreCredit = storeCreditRow ? toNet(storeCreditRow) : 0;
  const glCash = cashRow ? toNet(cashRow) : 0;
  const glBank = bankRow ? toNet(bankRow) : 0;

  // Trial balance: sum(debits) − sum(credits) across all POSTED lines — must be 0.
  const trialBalance = totals.reduce((sum, row) => sum + row.debit - row.credit, 0);
  const trialBalanceOk = Math.abs(trialBalance) < 0.01;

  // ── AR reconciliation ────────────────────────────────────────────────────────
  const paymentsTotalAsOf = eligiblePayments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const orderArTotal = orderArLines.reduce(
    (sum, line) => sum + Number(line.debit || 0) - Number(line.credit || 0),
    0,
  );
  const customerBalances = Math.max(0, orderArTotal - paymentsTotalAsOf);
  const arDifference = arLedger - customerBalances;
  const arMismatch = Math.abs(arDifference) > 0.01;

  // ── Inventory reconciliation ─────────────────────────────────────────────────
  const inventoryValuation = products.reduce(
    (sum, p) => sum + (movementMap.get(p.id) ?? 0) * num(p.cost),
    0,
  );
  const inventoryDifference = inventoryLedger - inventoryValuation;
  const inventoryMismatch = Math.abs(inventoryDifference) > 0.01;

  // ── AP reconciliation ────────────────────────────────────────────────────────
  const totalPurchaseCost = purchases.reduce(
    (sum, p) => sum + Number(p.unitCost || 0) * Number(p.quantity || 0),
    0,
  );
  const totalSupplierPaid = eligibleSupplierPayments.reduce(
    (sum, p) => sum + Number(p.amount || 0),
    0,
  );
  const apOperational = totalPurchaseCost - totalSupplierPaid;
  const apDifference = apLedger - apOperational;
  const apMismatch = Math.abs(apDifference) > 0.01;

  // ── Revenue / COGS / VAT / store-credit reconciliation ───────────────────────
  const revenueOperational = Number(orderAggregates._sum.subtotal || 0);
  const vatOperational = Number(orderAggregates._sum.taxAmount || 0);
  const revenueDifference = glRevenue - revenueOperational;
  const vatDifference = glVat - vatOperational;

  let cogsTotal = 0;
  let cogsMissing = 0;
  for (const item of orderItems) {
    if (item.order.status === "CANCELLED") continue;
    const netQty = Math.max(0, item.quantity - item.returnedQuantity);
    if (item.costAtSale == null) { if (netQty > 0) cogsMissing += 1; continue; }
    cogsTotal += num(item.costAtSale) * netQty;
  }
  const cogsDifference = glCogs - cogsTotal; // cogsTotal = cogsOperational

  const creditRefundTotal = payments
    .filter((p) =>
      String(p.status || "").toUpperCase() === "REFUND" &&
      String(p.refundDisposition || "").toUpperCase() === "CREDIT",
    )
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const creditPayoutTotal = creditPayouts.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const storeCreditOperational = creditRefundTotal - creditPayoutTotal;
  const storeCreditDifference = glStoreCredit - storeCreditOperational;

  const glDifferences = [
    { label: "Revenue (4000)", gl: glRevenue, operational: revenueOperational, diff: revenueDifference },
    { label: "COGS (5000)", gl: glCogs, operational: cogsTotal, diff: cogsDifference },
    { label: "VAT (2100)", gl: glVat, operational: vatOperational, diff: vatDifference },
    { label: "Store credit (2200)", gl: glStoreCredit, operational: storeCreditOperational, diff: storeCreditDifference },
  ];
  const extendedGlMismatch = glDifferences.some((r) => Math.abs(r.diff) > 0.01);

  // ── Draft entry aging ────────────────────────────────────────────────────────
  const nowMs = Date.now();
  const draftAging = { fresh: 0, warning: 0, old: 0, critical: 0 };
  for (const entry of draftSamples) {
    const ageDays = Math.floor((nowMs - entry.createdAt.getTime()) / 86400000);
    if (ageDays > 30) draftAging.critical++;
    else if (ageDays > 7) draftAging.old++;
    else if (ageDays >= 3) draftAging.warning++;
    else draftAging.fresh++;
  }
  const staleDrafts = draftAging.old + draftAging.critical;
  const hasStaleDrafts = staleDrafts > 0;

  // ── Data quality checks ──────────────────────────────────────────────────────
  const orderPaymentsMap = new Map<string, number>();
  for (const payment of payments) {
    if (!payment.orderId) continue;
    const status = String(payment.status || "").toUpperCase();
    if (status === "VOID") continue;
    const amount = Number(payment.amount || 0);
    const signedAmount = status === "REFUND" ? -Math.abs(amount) : amount;
    orderPaymentsMap.set(
      payment.orderId,
      (orderPaymentsMap.get(payment.orderId) ?? 0) + signedAmount,
    );
  }
  const paymentMismatchCount = orders.filter((order) => {
    const projectedPaid = orderPaymentsMap.get(order.id) ?? 0;
    return Math.abs(num(order.amountPaid) - projectedPaid) > 0.01;
  }).length;
  const orderBalanceMismatchCount = orders.filter((order) => {
    const projectedPaid = orderPaymentsMap.get(order.id) ?? 0;
    const projectedBalance = Math.max(0, num(order.total) - projectedPaid);
    return Math.abs(num(order.balance) - projectedBalance) > 0.01;
  }).length;
  const customerOverpaymentCount = orders.filter(
    (o) => num(o.amountPaid) > num(o.total) + 0.01,
  ).length;
  const orderBalanceIssueCount = orders.filter((o) => {
    if (o.status === "PAID" && num(o.balance) > 0.01) return true;
    if (num(o.amountPaid) > num(o.total) + 0.01) return true;
    return false;
  }).length;

  // Duplicate payments: same orderId + amount within 24 h
  const normalOrderPayments = payments.filter(
    (p) => String(p.status || "").toUpperCase() === "NORMAL" && p.orderId,
  );
  const dupeMap = new Map<string, typeof normalOrderPayments>();
  for (const p of normalOrderPayments) {
    const key = `${p.orderId}:${Number(p.amount || 0).toFixed(2)}`;
    if (!dupeMap.has(key)) dupeMap.set(key, []);
    dupeMap.get(key)!.push(p);
  }
  const duplicatePaymentCount = Array.from(dupeMap.values()).filter((group) => {
    if (group.length < 2) return false;
    const times = group.map((p) => new Date(p.createdAt).getTime()).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] < 86_400_000) return true;
    }
    return false;
  }).length;

  // Supplier overpayments: total paid per purchase > purchase cost
  const spByPurchase = new Map<string, number>();
  for (const sp of eligibleSupplierPayments) {
    if (!sp.purchaseId) continue;
    spByPurchase.set(sp.purchaseId, (spByPurchase.get(sp.purchaseId) ?? 0) + Number(sp.amount || 0));
  }
  const supplierOverpaymentCount = purchases.filter((p) => {
    const paid = spByPurchase.get(p.id) ?? 0;
    const cost = Number(p.unitCost || 0) * Number(p.quantity || 0);
    return paid > cost + 0.01;
  }).length;

  // ── Legacy AUTO_APPLY ────────────────────────────────────────────────────────
  const legacyAutoApplyView = legacyAutoApply
    .map((p) => {
      const meta = parsePaymentNote(p.note);
      const applied = meta?.applied ?? [];
      const appliedOrders = applied
        .map((entry) => ({ orderId: entry.orderId || "", applied: Number(entry.applied || 0) }))
        .filter((entry) => entry.orderId);
      return { ...p, appliedOrders, canBackfill: appliedOrders.length === 1 };
    })
    .filter((p) => p.appliedOrders.length > 0);

  // ── Financial summaries ──────────────────────────────────────────────────────
  const paymentsByStatus = new Map(paymentTotals.map((p) => [p.status, num(p._sum.amount)]));
  const paymentsNormal = paymentsByStatus.get("NORMAL") ?? 0;
  const paymentsRefund = paymentsByStatus.get("REFUND") ?? 0;
  const paymentsVoid = paymentsByStatus.get("VOID") ?? 0;
  const paymentsTotal = paymentsNormal + paymentsRefund;
  const totalExpenses = num(expensesAggregate._sum.amount);
  const totalOrderValue = orders.reduce((s, o) => s + num(o.total), 0);
  const totalPaid = orders.reduce((s, o) => s + num(o.amountPaid), 0);
  const totalBalance = orders.reduce((s, o) => s + num(o.balance), 0);
  const grossProfit = paymentsTotal - cogsTotal;
  const netProfit = grossProfit - totalExpenses;
  const accrualGrossProfit = totalOrderValue - cogsTotal;
  const accrualNetProfit = accrualGrossProfit - totalExpenses;

  // ── Derived severity flags ───────────────────────────────────────────────────
  const hasCriticalIssues =
    missingPostingTotal > 0 || arMismatch || inventoryMismatch || apMismatch ||
    !trialBalanceOk || hasStaleDrafts;
  const hasWarnings =
    stockMismatches.length > 0 || negativeStockItems.length > 0 ||
    legacyAutoApplyView.length > 0 || podCompliance7d.alert ||
    paymentMismatchCount > 0 || orderBalanceMismatchCount > 0 ||
    customerOverpaymentCount > 0 || orderBalanceIssueCount > 0 ||
    duplicatePaymentCount > 0 || supplierOverpaymentCount > 0 ||
    extendedGlMismatch || recentPostFailures.length > 0 ||
    draftAging.warning > 0 || draftCount > 0;

  return (
    <div className="container mx-auto py-8 space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-semibold">Health Check</h1>
        <p className="text-sm text-muted-foreground">
          Monitors stock integrity, GL posting completeness, ledger consistency,
          delivery POD compliance, and data quality.
          For deep ledger reconciliation and drilldowns see{" "}
          <Link href="/admin/accounting/integrity" className="underline hover:text-foreground">
            Accounting → Data Integrity
          </Link>.
        </p>
      </div>

      {/* ── Ops panel ──────────────────────────────────────────────────────── */}
      <HealthOpsPanel currentUserName={user?.name || user?.email || "Admin"} />

      {/* ── Severity banners ───────────────────────────────────────────────── */}
      {hasCriticalIssues && (
        <Card className="border-rose-300 bg-rose-50/70 dark:border-rose-900 dark:bg-rose-950/30">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-rose-600 dark:text-rose-400 mt-0.5 shrink-0" />
              <div className="space-y-1 text-sm text-rose-700 dark:text-rose-200">
                {!trialBalanceOk && (
                  <p><strong>GL is out of balance</strong> — trial balance is {formatCurrency(trialBalance)} (must be 0). All financial reports are unreliable until resolved.</p>
                )}
                {missingPostingTotal > 0 && (
                  <p><strong>{missingPostingTotal}</strong> unposted transaction(s) — ledger is incomplete. Review &ldquo;Ledger readiness&rdquo; below.</p>
                )}
                {arMismatch && (
                  <p>AR ledger differs from customer balance by <strong>{formatCurrency(Math.abs(arDifference))}</strong>.</p>
                )}
                {inventoryMismatch && (
                  <p>Inventory ledger differs from stock valuation by <strong>{formatCurrency(Math.abs(inventoryDifference))}</strong>.</p>
                )}
                {apMismatch && (
                  <p>AP ledger differs from outstanding purchase balance by <strong>{formatCurrency(Math.abs(apDifference))}</strong>.</p>
                )}
                {hasStaleDrafts && (
                  <p><strong>{staleDrafts}</strong> journal {staleDrafts === 1 ? "entry" : "entries"} stuck in DRAFT for &gt;7 days — revenue/costs not yet in the GL.</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {!hasCriticalIssues && hasWarnings && (
        <Card className="border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-700 dark:text-amber-200">No critical issues — warnings require attention below.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {!hasCriticalIssues && !hasWarnings && (
        <Card className="border-green-300 bg-green-50/50 dark:border-green-800 dark:bg-green-950/30">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
              <p className="text-sm text-green-700 dark:text-green-200 font-medium">All checks passing.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          SECTION 1 — Ledger integrity
      ══════════════════════════════════════════════════════════════════════════ */}
      <div id="ledger-integrity" className="space-y-3 scroll-mt-24">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Ledger integrity</h2>
            <Tooltip content="Trial balance, AR/AP/Inventory reconciliation, GL vs operational for Revenue/COGS/VAT/Store credit, draft entries and posting completeness.">
              <span className="text-muted-foreground hover:text-foreground"><Info className="h-4 w-4" /></span>
            </Tooltip>
          </div>
          <Link href="/admin/accounting/integrity" className="flex items-center gap-1 text-xs text-blue-700 underline hover:text-blue-900">
            Full reconciliation <ExternalLink className="h-3 w-3" />
          </Link>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-5 text-sm">

            {/* Trial balance */}
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-1">Trial balance</div>
              <div className="flex justify-between font-medium">
                <span>Debits − Credits (must be 0)</span>
                <span className={`tabular-nums ${trialBalanceOk ? "text-green-700" : "text-rose-600 font-bold"}`}>
                  {formatCurrency(trialBalance)}{trialBalanceOk ? " ✓" : " ⚠ GL OUT OF BALANCE"}
                </span>
              </div>
            </div>

            {/* AR / Inventory / AP */}
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-2">Balance sheet reconciliation (GL vs operational)</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b">
                    <th className="text-left pb-1 font-medium">Account</th>
                    <th className="text-right pb-1 font-medium">GL ledger</th>
                    <th className="text-right pb-1 font-medium">Operational</th>
                    <th className="text-right pb-1 font-medium">Difference</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {[
                    { label: "AR (1100)", gl: arLedger, op: customerBalances, diff: arDifference, warn: arMismatch },
                    { label: "Inventory (1200)", gl: inventoryLedger, op: inventoryValuation, diff: inventoryDifference, warn: inventoryMismatch },
                    { label: "AP (2000)", gl: apLedger, op: apOperational, diff: apDifference, warn: apMismatch },
                  ].map((row) => (
                    <tr key={row.label}>
                      <td className="py-1.5">{row.label}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatCurrency(row.gl)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatCurrency(row.op)}</td>
                      <td className={`py-1.5 text-right tabular-nums font-medium ${row.warn ? "text-rose-600" : "text-green-700"}`}>
                        {formatCurrency(row.diff)}{row.warn ? " ⚠" : " ✓"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Revenue / COGS / VAT / Store credit */}
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-2">Income statement reconciliation (GL vs operational)</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground border-b">
                    <th className="text-left pb-1 font-medium">Account</th>
                    <th className="text-right pb-1 font-medium">GL ledger</th>
                    <th className="text-right pb-1 font-medium">Operational</th>
                    <th className="text-right pb-1 font-medium">Difference</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {glDifferences.map((row) => {
                    const warn = Math.abs(row.diff) > 0.01;
                    return (
                      <tr key={row.label}>
                        <td className="py-1.5">{row.label}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatCurrency(row.gl)}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatCurrency(row.operational)}</td>
                        <td className={`py-1.5 text-right tabular-nums font-medium ${warn ? "text-amber-600" : "text-green-700"}`}>
                          {formatCurrency(row.diff)}{warn ? " ⚠" : " ✓"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Cash & Bank GL balances */}
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-2">Cash & bank GL balances</div>
              <div className="grid grid-cols-2 gap-x-6 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Cash (1000)</span>
                  <span className="tabular-nums">{formatCurrency(glCash)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Bank (1010)</span>
                  <span className="tabular-nums">{formatCurrency(glBank)}</span>
                </div>
              </div>
            </div>

            {/* Draft entry aging */}
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-semibold text-muted-foreground">Draft journal entries</div>
                {draftCount > 0 && (
                  <Link href="/admin/accounting/journal?status=DRAFT" className="text-xs text-blue-700 underline">
                    View drafts
                  </Link>
                )}
              </div>
              {draftCount === 0 ? (
                <p className="text-xs text-green-700">No draft entries — all journal entries are posted. ✓</p>
              ) : (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Total drafts:</span>
                    <span className={`font-medium ${hasStaleDrafts ? "text-rose-600" : "text-amber-600"}`}>{draftCount}</span>
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs">
                    {draftAging.fresh > 0 && (
                      <span className="inline-flex items-center gap-1 rounded bg-green-100 px-2 py-0.5 text-green-800 dark:bg-green-900/40 dark:text-green-300">
                        {draftAging.fresh} fresh (&lt;3d)
                      </span>
                    )}
                    {draftAging.warning > 0 && (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                        {draftAging.warning} aging (3-7d)
                      </span>
                    )}
                    {draftAging.old > 0 && (
                      <span className="inline-flex items-center gap-1 rounded bg-orange-100 px-2 py-0.5 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300">
                        {draftAging.old} old (&gt;7d)
                      </span>
                    )}
                    {draftAging.critical > 0 && (
                      <span className="inline-flex items-center gap-1 rounded bg-rose-100 px-2 py-0.5 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300">
                        {draftAging.critical} critical (&gt;30d)
                      </span>
                    )}
                  </div>
                  {hasStaleDrafts && (
                    <p className="text-xs text-rose-600 mt-1">
                      Entries &gt;7 days in DRAFT are not in the GL — revenue/costs are understated until posted.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Posting completeness */}
            <div id="ledger-readiness" className="border-t pt-4 scroll-mt-24">
              <div className="text-xs font-semibold text-muted-foreground mb-2">Ledger readiness — unposted transactions</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                {[
                  ["Orders", missingOrders],
                  ["Payments", missingPayments],
                  ["Expenses", missingExpenses],
                  ["Purchases", missingPurchases],
                  ["Supplier payments", missingSupplierPayments],
                  ["Store-credit payouts", missingCreditPayouts],
                  ["Delivery settlements", missingSettlements],
                ].map(([label, count]) => (
                  <div key={label as string} className="flex justify-between">
                    <span className="text-muted-foreground">{label}</span>
                    <span className={`font-medium tabular-nums ${Number(count) > 0 ? "text-rose-600" : "text-green-700"}`}>
                      {count}
                    </span>
                  </div>
                ))}
              </div>
              {missingPostingTotal > 0 && (
                <div className="mt-2 flex justify-between border-t pt-2 font-semibold text-xs">
                  <span>Total unposted</span>
                  <span className="text-rose-600 tabular-nums">{missingPostingTotal}</span>
                </div>
              )}
            </div>

          </CardContent>
        </Card>
      </div>

      {/* ── Recent posting failures ─────────────────────────────────────────── */}
      {recentPostFailures.length > 0 && (
        <Card className="border-rose-200 dark:border-rose-900">
          <CardHeader>
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              Recent posting failures
              <span className="text-sm font-normal text-rose-600">({recentPostFailures.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="min-w-full text-xs whitespace-nowrap">
              <thead className="text-muted-foreground border-b">
                <tr>
                  <th className="text-left py-1.5 pr-4">Action</th>
                  <th className="text-left py-1.5 pr-4">Entity type</th>
                  <th className="text-left py-1.5 pr-4">Entity ID</th>
                  <th className="text-right py-1.5">When</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {recentPostFailures.map((row) => (
                  <tr key={row.id} className="text-rose-700 dark:text-rose-300">
                    <td className="py-1.5 pr-4 font-mono">{row.action}</td>
                    <td className="py-1.5 pr-4">{row.entityType}</td>
                    <td className="py-1.5 pr-4 font-mono">{row.entityId}</td>
                    <td className="py-1.5 text-right text-muted-foreground">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground mt-2">
              These failures explain why the unposted counts above may not clear automatically. Resolve the underlying issue then use &ldquo;Post now&rdquo; on{" "}
              <Link href="/admin/accounting/integrity" className="underline">Data Integrity</Link>.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════
          SECTION 2 — Data quality
      ══════════════════════════════════════════════════════════════════════════ */}
      <div id="data-quality" className="space-y-3 scroll-mt-24">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Data quality</h2>
          <Tooltip content="Operational data consistency checks — overpayments, duplicate payments, balance anomalies.">
            <span className="text-muted-foreground hover:text-foreground"><Info className="h-4 w-4" /></span>
          </Tooltip>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          <Card id="payment-mismatches" className={`${paymentMismatchCount > 0 ? "border-amber-300 dark:border-amber-800" : ""} scroll-mt-24`}>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Payment mismatches</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-semibold ${paymentMismatchCount > 0 ? "text-amber-600" : ""}`}>
                {paymentMismatchCount}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {paymentMismatchCount > 0 ? "amountPaid differs from posted payment total" : "None detected"}
              </p>
            </CardContent>
          </Card>
          <Card id="order-balance-mismatches" className={`${orderBalanceMismatchCount > 0 ? "border-amber-300 dark:border-amber-800" : ""} scroll-mt-24`}>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Order balance mismatches</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-semibold ${orderBalanceMismatchCount > 0 ? "text-amber-600" : ""}`}>
                {orderBalanceMismatchCount}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {orderBalanceMismatchCount > 0 ? "balance differs from order total less payments" : "None detected"}
              </p>
            </CardContent>
          </Card>
          <Card className={customerOverpaymentCount > 0 ? "border-amber-300 dark:border-amber-800" : ""}>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Customer overpayments</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-semibold ${customerOverpaymentCount > 0 ? "text-amber-600" : ""}`}>
                {customerOverpaymentCount}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {customerOverpaymentCount > 0 ? "amountPaid > total" : "None detected"}
              </p>
            </CardContent>
          </Card>
          <Card className={orderBalanceIssueCount > 0 ? "border-amber-300 dark:border-amber-800" : ""}>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Order balance issues</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-semibold ${orderBalanceIssueCount > 0 ? "text-amber-600" : ""}`}>
                {orderBalanceIssueCount}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {orderBalanceIssueCount > 0 ? "PAID status with balance > 0" : "None detected"}
              </p>
            </CardContent>
          </Card>
          <Card className={duplicatePaymentCount > 0 ? "border-amber-300 dark:border-amber-800" : ""}>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Duplicate payments</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-semibold ${duplicatePaymentCount > 0 ? "text-amber-600" : ""}`}>
                {duplicatePaymentCount}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {duplicatePaymentCount > 0 ? "Same order + amount within 24 h" : "None detected"}
              </p>
            </CardContent>
          </Card>
          <Card className={supplierOverpaymentCount > 0 ? "border-amber-300 dark:border-amber-800" : ""}>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Supplier overpayments</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-semibold ${supplierOverpaymentCount > 0 ? "text-amber-600" : ""}`}>
                {supplierOverpaymentCount}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {supplierOverpaymentCount > 0 ? "Paid > purchase cost" : "None detected"}
              </p>
            </CardContent>
          </Card>
        </div>
        {(paymentMismatchCount > 0 || orderBalanceMismatchCount > 0 || customerOverpaymentCount > 0 || orderBalanceIssueCount > 0 || duplicatePaymentCount > 0 || supplierOverpaymentCount > 0) && (
          <p className="text-xs text-muted-foreground">
            For detailed drilldowns and CSV export visit{" "}
            <Link href="/admin/accounting/integrity" className="underline">Accounting → Data Integrity</Link>.
          </p>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          SECTION 3 — Operational checks
      ══════════════════════════════════════════════════════════════════════════ */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Operational checks</h2>
          <Tooltip content="Inventory integrity, stock mismatches, legacy payment records, and POD compliance.">
            <span className="text-muted-foreground hover:text-foreground"><Info className="h-4 w-4" /></span>
          </Tooltip>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader><CardTitle className="text-sm font-semibold">In-stock products</CardTitle></CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{inStockCount}</div>
              <Link href="/admin/inventory" className="text-xs text-blue-700 underline mt-1 inline-block">View inventory</Link>
            </CardContent>
          </Card>
          <Card className={stockMismatches.length > 0 ? "border-rose-300 dark:border-rose-800" : ""}>
            <CardHeader><CardTitle className="text-sm font-semibold">Stock mismatches</CardTitle></CardHeader>
            <CardContent>
              <div className={`text-2xl font-semibold ${stockMismatches.length > 0 ? "text-rose-600" : ""}`}>
                {stockMismatches.length}
              </div>
              {stockMismatches.length > 0 && <p className="text-xs text-muted-foreground mt-1">stock field ≠ movement sum</p>}
            </CardContent>
          </Card>
          <Card className={negativeStockItems.length > 0 ? "border-amber-300 dark:border-amber-800" : ""}>
            <CardHeader><CardTitle className="text-sm font-semibold">Negative stock</CardTitle></CardHeader>
            <CardContent>
              <div className={`text-2xl font-semibold ${negativeStockItems.length > 0 ? "text-amber-600" : ""}`}>
                {negativeStockItems.length}
              </div>
              {negativeStockItems.length > 0 && <p className="text-xs text-muted-foreground mt-1">by movement sum</p>}
            </CardContent>
          </Card>
          <Card className={legacyAutoApplyView.length > 0 ? "border-amber-300 dark:border-amber-800" : ""}>
            <CardHeader><CardTitle className="text-sm font-semibold">Legacy AUTO_APPLY</CardTitle></CardHeader>
            <CardContent>
              <div className={`text-2xl font-semibold ${legacyAutoApplyView.length > 0 ? "text-amber-600" : ""}`}>
                {legacyAutoApplyView.length}
              </div>
              {legacyAutoApplyView.length > 0 && <p className="text-xs text-muted-foreground mt-1">unlinked payments</p>}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── POD Compliance ─────────────────────────────────────────────────── */}
      <Card id="pod-compliance" className={`${podCompliance7d.alert ? "border-amber-300 dark:border-amber-800" : ""} scroll-mt-24`}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold">POD compliance (last 7 days)</CardTitle>
            <Link href="/admin/delivery/pod-report" className="flex items-center gap-1 text-xs text-blue-700 underline">
              Full report <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          <div className="flex justify-between">
            <span>Delivered orders</span>
            <span className="tabular-nums">{podCompliance7d.delivered}</span>
          </div>
          <div className="flex justify-between">
            <span>POD captured</span>
            <span className="tabular-nums">{podCompliance7d.podCaptured}</span>
          </div>
          <div className="flex justify-between font-medium">
            <span>POD missing</span>
            <span className={`tabular-nums ${podCompliance7d.alert ? "text-amber-600" : "text-green-700"}`}>
              {podCompliance7d.podMissing} ({podCompliance7d.podMissingRatePct}%){podCompliance7d.alert ? " ⚠" : " ✓"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground pt-1">
            Alert threshold: {podCompliance7d.thresholdPct}% missing (min {podCompliance7d.minDelivered} delivered in window).
            {podCompliance7d.delivered < podCompliance7d.minDelivered && (
              <> Fewer than {podCompliance7d.minDelivered} delivered — alert suppressed.</>
            )}
          </p>
        </CardContent>
      </Card>

      {/* ═══════════════════════════════════════════════════════════════════════
          SECTION 4 — Orders snapshot & Financial summary
      ══════════════════════════════════════════════════════════════════════════ */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Orders & financial summary</h2>
          <Tooltip content="Active orders only (cancelled excluded). Cash basis uses payments received; accrual uses order values.">
            <span className="text-muted-foreground hover:text-foreground"><Info className="h-4 w-4" /></span>
          </Tooltip>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader><CardTitle className="text-sm font-semibold">Order value (active)</CardTitle></CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalOrderValue)}</CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm font-semibold">Paid (active)</CardTitle></CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalPaid)}</CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm font-semibold">Outstanding balance</CardTitle></CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalBalance)}</CardContent>
          </Card>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-sm font-semibold">Cash basis</CardTitle></CardHeader>
            <CardContent className="text-sm space-y-1">
              {[["Revenue", paymentsTotal], ["COGS (net)", cogsTotal], ["Gross profit", grossProfit], ["Expenses", totalExpenses], ["Net profit", netProfit]].map(([label, val]) => (
                <div key={label as string} className="flex justify-between">
                  <span className={label === "Net profit" ? "font-semibold" : ""}>{label}</span>
                  <span className={`tabular-nums ${label === "Net profit" ? "font-semibold" : ""}`}>{formatCurrency(val as number)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm font-semibold">Accrual basis</CardTitle></CardHeader>
            <CardContent className="text-sm space-y-1">
              {[["Revenue", totalOrderValue], ["COGS (net)", cogsTotal], ["Gross profit", accrualGrossProfit], ["Expenses", totalExpenses], ["Net profit", accrualNetProfit]].map(([label, val]) => (
                <div key={label as string} className="flex justify-between">
                  <span className={label === "Net profit" ? "font-semibold" : ""}>{label}</span>
                  <span className={`tabular-nums ${label === "Net profit" ? "font-semibold" : ""}`}>{formatCurrency(val as number)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader><CardTitle className="text-base font-semibold">Payment status totals</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-2">Type</th>
                  <th className="text-right py-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {[["Normal", paymentsNormal], ["Refunds", paymentsRefund], ["Voids", paymentsVoid]].map(([type, val]) => (
                  <tr key={type as string} className="border-t">
                    <td className="py-2">{type}</td>
                    <td className="py-2 text-right tabular-nums">{formatCurrency(val as number)}</td>
                  </tr>
                ))}
                <tr className="border-t font-semibold">
                  <td className="py-2">Net</td>
                  <td className="py-2 text-right tabular-nums">{formatCurrency(paymentsTotal)}</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base font-semibold">COGS coverage</CardTitle></CardHeader>
          <CardContent>
            {cogsMissing === 0
              ? <p className="text-sm text-muted-foreground">All order items include a recorded cost at sale.</p>
              : <p className="text-sm text-amber-600">{cogsMissing} order item(s) missing cost-at-sale — COGS may be understated.</p>
            }
          </CardContent>
        </Card>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          SECTION 5 — Detail tables (issues only)
      ══════════════════════════════════════════════════════════════════════════ */}

      {/* Stock vs movement mismatches */}
      <Card id="stock-movement-mismatches" className="scroll-mt-24">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-semibold">
            Stock vs movement mismatches
            {stockMismatches.length > 0 && <span className="ml-2 text-sm font-normal text-rose-600">({stockMismatches.length})</span>}
          </CardTitle>
          {stockMismatches.length > 0 && <BackfillStockMovementsButton />}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {stockMismatches.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              <p>No mismatches — stock field matches movement sum for all products.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link href="/admin/movements" className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted">View movements</Link>
                <Link href="/admin/inventory" className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted">View inventory</Link>
              </div>
            </div>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-2">Product</th>
                  <th className="text-right py-2">Stock field</th>
                  <th className="text-right py-2">Movement sum</th>
                  <th className="text-right py-2">Archived</th>
                </tr>
              </thead>
              <tbody>
                {stockMismatches.map((p) => (
                  <tr key={p.id} className="border-t bg-rose-50/60 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">
                    <td className="py-2">{p.name}</td>
                    <td className="py-2 text-right font-semibold">{p.stock}</td>
                    <td className="py-2 text-right font-semibold">{p.movementSum}</td>
                    <td className="py-2 text-right">{p.archived ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Negative stock */}
      <Card id="negative-stock" className="scroll-mt-24">
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            Negative stock
            {negativeStockItems.length > 0 && <span className="ml-2 text-sm font-normal text-amber-600">({negativeStockItems.length})</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {negativeStockItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No products with negative movement sum.</p>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-2">Product</th>
                  <th className="text-right py-2">Movement sum</th>
                </tr>
              </thead>
              <tbody>
                {negativeStockItems.map((p) => (
                  <tr key={p.id} className="border-t bg-amber-50/60 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                    <td className="py-2">{p.name}</td>
                    <td className="py-2 text-right font-semibold">{p.movementSum}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Legacy AUTO_APPLY */}
      {legacyAutoApplyView.length > 0 && (
        <Card id="legacy-auto-apply" className="scroll-mt-24">
          <CardHeader>
            <CardTitle className="text-base font-semibold">Legacy AUTO_APPLY payments ({legacyAutoApplyView.length})</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="min-w-full text-sm whitespace-nowrap">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-2 pr-4">Payment ID</th>
                  <th className="text-right py-2 pr-4">Amount</th>
                  <th className="text-left py-2 pr-4">Applied orders</th>
                  <th className="text-right py-2 pr-4">Backfill</th>
                  <th className="text-right py-2 pr-4">Created</th>
                </tr>
              </thead>
              <tbody>
                {legacyAutoApplyView.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="py-2 pr-4">{p.id}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{formatCurrency(num(p.amount))}</td>
                    <td className="py-2 pr-4">
                      {p.appliedOrders.map((e) => `${e.orderId}: ${formatCurrency(e.applied)}`).join(", ")}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {p.canBackfill ? <BackfillAutoApplyButton paymentId={p.id} /> : <span className="text-xs text-muted-foreground">Manual</span>}
                    </td>
                    <td className="py-2 pr-4 text-right">{p.createdAt.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

    </div>
  );
}
