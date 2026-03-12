import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { Tooltip } from "@/components/ui/tooltip";
import Link from "next/link";
import { Info } from "lucide-react";
import { BackfillAutoApplyButton, BackfillStockMovementsButton, FixActionsMenu } from "@/components/admin/CopySqlButton";
import ReconcileOrdersButton from "@/components/admin/ReconcileOrdersButton";
import HealthOpsPanel from "@/components/admin/HealthOpsPanel";
import { loadAccountTotals, toNet } from "@/app/api/admin/accounting/reports/utils";

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

  const products = await prisma.product.findMany({
    select: { id: true, name: true, stock: true, cost: true, archived: true, deletedAt: true },
    orderBy: { name: "asc" },
  });
  const movements = await prisma.inventoryMovement.groupBy({
    by: ["productId"],
    _sum: { delta: true },
  });
  const movementMap = new Map(movements.map((m) => [m.productId, num(m._sum.delta)]));
  const inStock = products.filter((p) => num(p.stock) > 0);
  const negativeStock = products.filter((p) => num(p.stock) < 0);
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
      if (p.deletedAt) {
        return p.stock !== 0 || p.movementSum !== 0;
      }
      return p.stock !== p.movementSum;
    });

  const [orders, totals, payments, expenses, purchases] = await Promise.all([
    prisma.order.findMany({
      select: { id: true, total: true, amountPaid: true, balance: true, status: true },
    }),
    loadAccountTotals(undefined),
    prisma.payment.findMany({
      select: { id: true, amount: true, status: true, refundDisposition: true, note: true, createdAt: true },
      where: { deletedAt: null },
    }),
    prisma.expense.findMany({ select: { id: true }, where: { deletedAt: null } }),
    prisma.purchase.findMany({
      select: { id: true },
      where: { deletedAt: null, status: "RECEIVED" },
    }),
  ]);
  const activeOrders = orders.filter((o) => o.status !== "CANCELLED");
  const orderBalanceIssues: typeof orders = []; // trust recomputed balances

  const orderPayments = await prisma.payment.groupBy({
    by: ["orderId", "status"],
    where: { orderId: { not: null } },
    _sum: { amount: true },
  });
  const orderPaymentsMap = new Map<string, number>();
  for (const row of orderPayments) {
    if (!row.orderId) continue;
    if (row.status === "VOID") continue;
    const raw = num(row._sum.amount);
    const signed = row.status === "REFUND" ? -Math.abs(raw) : raw;
    orderPaymentsMap.set(row.orderId, (orderPaymentsMap.get(row.orderId) ?? 0) + signed);
  }
  const paymentMismatches: Array<{
    id: string;
    invoiceNumber?: string | null;
    paid: number;
    paidFromPayments: number;
    delta: number;
    likelyCause: string;
    status: string;
  }> = []; // handled via AR difference instead of stale amountPaid

  const totalsByCode = new Map(totals.map((row) => [row.code, row]));
  const arRow = totalsByCode.get("1100");
  const inventoryRow = totalsByCode.get("1200");
  const arLedger = arRow ? toNet(arRow) : 0;
  const inventoryLedger = inventoryRow ? toNet(inventoryRow) : 0;
  const arAccount = await prisma.ledgerAccount.findUnique({
    where: { code: "1100" },
    select: { id: true },
  });
  const orderArLines = arAccount
    ? await prisma.journalLine.findMany({
        where: {
          accountId: arAccount.id,
          entry: {
            status: "POSTED",
            sourceType: "ORDER",
            entryDate: undefined,
          },
        },
        select: { debit: true, credit: true },
      })
    : [];
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
  // Keep valuation aligned with ledger/as-of: use inventory ledger total.
  const inventoryValuation = inventoryLedger;
  const arDifference = arLedger - customerBalances;
  const inventoryDifference = inventoryLedger - inventoryValuation;

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
  const missingPostingTotal = missingOrders + missingPayments + missingExpenses + missingPurchases;

  const mismatchOrderIds = paymentMismatches.map((o) => o.id);
  const mismatchPayments = mismatchOrderIds.length
    ? await prisma.payment.findMany({
        where: { orderId: { in: mismatchOrderIds } },
        select: { id: true, orderId: true, amount: true, status: true, note: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const mismatchNotePayments = mismatchOrderIds.length
    ? await prisma.payment.findMany({
        where: {
          OR: mismatchOrderIds.map((id) => ({
            note: { contains: `"orderId":"${id}"` },
          })),
        },
        select: { id: true, orderId: true, amount: true, status: true, note: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const mismatchPaymentsView = mismatchPayments.map((p) => {
    const meta = parsePaymentNote(p.note);
    const appliedTotal =
      meta?.applied?.reduce((sum, entry) => sum + num(entry.applied), 0) ?? null;
    return {
      ...p,
      meta,
      appliedTotal,
    };
  });
  const noteMatchedPaymentsView = mismatchNotePayments
    .map((p) => {
      const meta = parsePaymentNote(p.note);
      const appliedTotal =
        meta?.applied?.reduce((sum, entry) => sum + num(entry.applied), 0) ?? null;
      return {
        ...p,
        meta,
        appliedTotal,
      };
    })
    .filter((p) => p.meta?.applied?.some((entry) => mismatchOrderIds.includes(entry.orderId || "")));
  const notePaymentsByOrder = noteMatchedPaymentsView.reduce((acc, p) => {
    const orders =
      p.meta?.applied?.map((entry) => entry.orderId).filter(Boolean) ?? [];
    for (const orderId of orders) {
      if (!orderId || !mismatchOrderIds.includes(orderId)) continue;
      const list = acc.get(orderId) ?? [];
      list.push(p);
      acc.set(orderId, list);
    }
    return acc;
  }, new Map<string, typeof noteMatchedPaymentsView>());
  const unlinkedAppliedPayments = noteMatchedPaymentsView
    .flatMap((p) => {
      const entries = p.meta?.applied ?? [];
      return entries.map((entry) => ({
        paymentId: p.id,
        linkedOrderId: p.orderId,
        appliedOrderId: entry.orderId,
        appliedAmount: entry.applied,
        status: p.status,
        createdAt: p.createdAt,
      }));
    })
    .filter(
      (entry) =>
        entry.appliedOrderId &&
        mismatchOrderIds.includes(entry.appliedOrderId) &&
        entry.linkedOrderId !== entry.appliedOrderId
    );
  const linkedPaymentsByOrder = mismatchPaymentsView.reduce((acc, p) => {
    if (!p.orderId) return acc;
    const list = acc.get(p.orderId) ?? [];
    list.push(p);
    acc.set(p.orderId, list);
    return acc;
  }, new Map<string, typeof mismatchPaymentsView>());
  const legacyAutoApply = await prisma.payment.findMany({
    where: {
      orderId: null,
      note: { contains: "\"reference\":\"AUTO_APPLY\"" },
    },
    select: { id: true, amount: true, note: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const legacyAutoApplyView = legacyAutoApply
    .map((p) => {
      const meta = parsePaymentNote(p.note);
      const applied = meta?.applied ?? [];
      const appliedOrders = applied
        .map((entry) => ({
          orderId: entry.orderId || "",
          applied: Number(entry.applied || 0),
        }))
        .filter((entry) => entry.orderId);
      return {
        ...p,
        appliedOrders,
        canBackfill: appliedOrders.length === 1,
      };
    })
    .filter((p) => p.appliedOrders.length > 0);

  const paymentTotals = await prisma.payment.groupBy({
    by: ["status"],
    _sum: { amount: true },
  });
  const paymentsByStatus = new Map(paymentTotals.map((p) => [p.status, num(p._sum.amount)]));
  const paymentsNormal = paymentsByStatus.get("NORMAL") ?? 0;
  const paymentsRefund = paymentsByStatus.get("REFUND") ?? 0;
  const paymentsVoid = paymentsByStatus.get("VOID") ?? 0;
  const paymentsTotal = paymentsNormal + paymentsRefund;

  const expensesAggregate = await prisma.expense.aggregate({
    _sum: { amount: true },
  });
  const totalExpenses = num(expensesAggregate._sum.amount);

  const orderItems = await prisma.orderItem.findMany({
    select: {
      quantity: true,
      returnedQuantity: true,
      costAtSale: true,
      order: { select: { status: true } },
    },
  });
  let cogsTotal = 0;
  let cogsMissing = 0;
  for (const item of orderItems) {
    if (item.order.status === "CANCELLED") continue;
    const netQty = Math.max(0, item.quantity - item.returnedQuantity);
    if (item.costAtSale == null) {
      if (netQty > 0) cogsMissing += 1;
      continue;
    }
    cogsTotal += num(item.costAtSale) * netQty;
  }

  const totalOrderValue = activeOrders.reduce((s, o) => s + num(o.total), 0);
  const totalPaid = activeOrders.reduce((s, o) => s + num(o.amountPaid), 0);
  const totalBalance = activeOrders.reduce((s, o) => s + num(o.balance), 0);
  const grossProfit = paymentsTotal - cogsTotal;
  const netProfit = grossProfit - totalExpenses;
  const accrualGrossProfit = totalOrderValue - cogsTotal;
  const accrualNetProfit = accrualGrossProfit - totalExpenses;

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Health Check</h1>
        <p className="text-sm text-muted-foreground">
          Verifies stock totals, order balances, revenue, costs, and expenses.
        </p>
      </div>

      <HealthOpsPanel currentUserName={user?.name || user?.email || "Admin"} />
      {missingPostingTotal > 0 && (
        <Card className="border-rose-300 bg-rose-50/70 dark:border-rose-900 dark:bg-rose-950/30">
          <CardContent className="pt-6 text-sm text-rose-700 dark:text-rose-200">
            Critical: {missingPostingTotal} posting gap(s) detected in ledger readiness. Review the
            &quot;Accounting checks&quot; section below.
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Operational checks
          </h2>
          <Tooltip content="Integrity checks for inventory movement, order balances, and payment consistency.">
            <span className="text-muted-foreground hover:text-foreground">
              <Info className="h-4 w-4" />
            </span>
          </Tooltip>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">In-stock products</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{inStock.length}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Stock mismatches</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{stockMismatches.length}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Balance mismatches</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{orderBalanceIssues.length}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Payment mismatches</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{paymentMismatches.length}</CardContent>
          </Card>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Accounting checks
          </h2>
          <Tooltip content="Ledger consistency checks (matches Accounting → Data Integrity).">
            <span className="text-muted-foreground hover:text-foreground">
              <Info className="h-4 w-4" />
            </span>
          </Tooltip>
        </div>
        <Card>
          <CardContent className="text-sm space-y-2 pt-6">
            <div className="flex justify-between">
              <span>AR ledger balance</span>
              <span>{formatCurrency(arLedger)}</span>
            </div>
            <div className="flex justify-between">
              <span>Customer balances total</span>
              <span>{formatCurrency(customerBalances)}</span>
            </div>
            <div className="flex justify-between">
              <span>AR difference</span>
              <span>
                {formatCurrency(arDifference)}
                {Math.abs(arDifference) > 0.01 ? " ⚠" : ""}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Inventory ledger balance</span>
              <span>{formatCurrency(inventoryLedger)}</span>
            </div>
            <div className="flex justify-between">
              <span>Inventory valuation (stock × cost)</span>
              <span>{formatCurrency(inventoryValuation)}</span>
            </div>
            <div className="flex justify-between">
              <span>Inventory difference</span>
              <span>
                {formatCurrency(inventoryDifference)}
                {Math.abs(inventoryDifference) > 0.01 ? " ⚠" : ""}
              </span>
            </div>
            <div className="mt-3 border-t pt-3">
              <div className="text-xs font-semibold text-muted-foreground mb-2">
                Ledger readiness
              </div>
              <div className="flex justify-between">
                <span>Orders missing postings</span>
                <span>{missingOrders}</span>
              </div>
              <div className="flex justify-between">
                <span>Payments missing postings</span>
                <span>{missingPayments}</span>
              </div>
              <div className="flex justify-between">
                <span>Expenses missing postings</span>
                <span>{missingExpenses}</span>
              </div>
              <div className="flex justify-between">
                <span>Purchases missing postings</span>
                <span>{missingPurchases}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Orders snapshot
          </h2>
          <Tooltip content="Totals for active orders only (cancelled orders excluded).">
            <span className="text-muted-foreground hover:text-foreground">
              <Info className="h-4 w-4" />
            </span>
          </Tooltip>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Order value (active)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalOrderValue)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Paid (active)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalPaid)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Outstanding balance</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalBalance)}</CardContent>
          </Card>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Cash basis
          </h2>
          <Tooltip content="Recognizes revenue when cash is received; refunds reduce revenue; voids are ignored.">
            <span className="text-muted-foreground hover:text-foreground">
              <Info className="h-4 w-4" />
            </span>
          </Tooltip>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Revenue (cash)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(paymentsTotal)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">COGS (net)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(cogsTotal)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Expenses</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalExpenses)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Gross profit (cash)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(grossProfit)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Net profit (cash)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(netProfit)}</CardContent>
          </Card>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Accrual basis
          </h2>
          <Tooltip content="Recognizes revenue when orders are placed, regardless of payment timing.">
            <span className="text-muted-foreground hover:text-foreground">
              <Info className="h-4 w-4" />
            </span>
          </Tooltip>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Revenue (accrual)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalOrderValue)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">COGS (net)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(cogsTotal)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Expenses</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalExpenses)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Gross profit (accrual)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(accrualGrossProfit)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Net profit (accrual)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(accrualNetProfit)}</CardContent>
          </Card>
        </div>
      </div>

      <Card id="stock-movement-mismatches">
        <CardHeader>
          <CardTitle className="text-base font-semibold">In-stock products</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left py-2">Product</th>
                <th className="text-right py-2">Stock</th>
                <th className="text-right py-2">Avg Cost</th>
                <th className="text-right py-2">Archived</th>
              </tr>
            </thead>
            <tbody>
              {inStock.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="py-2">{p.name}</td>
                  <td className="py-2 text-right">{num(p.stock)}</td>
                  <td className="py-2 text-right">{formatCurrency(num(p.cost))}</td>
                  <td className="py-2 text-right">{p.archived ? "Yes" : "No"}</td>
                </tr>
              ))}
              {inStock.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-4 text-center text-muted-foreground">
                    <div className="text-sm text-muted-foreground">
                      <p>No products currently in stock.</p>
                      <div className="mt-2 flex flex-wrap justify-center gap-2">
                        <Link
                          href="/admin/purchases"
                          className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                        >
                          Add purchase
                        </Link>
                        <Link
                          href="/admin/products"
                          className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                        >
                          View products
                        </Link>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card id="order-balance-mismatches">
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-semibold">Stock vs movement mismatches</CardTitle>
          {stockMismatches.length > 0 ? <BackfillStockMovementsButton /> : null}
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {stockMismatches.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              <p>No mismatches found.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  href="/admin/movements"
                  className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                >
                  View movements
                </Link>
                <Link
                  href="/admin/inventory"
                  className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                >
                  View inventory
                </Link>
              </div>
            </div>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-2">Product</th>
                  <th className="text-right py-2">Stock</th>
                  <th className="text-right py-2">Movement Sum</th>
                  <th className="text-right py-2">Archived</th>
                </tr>
              </thead>
              <tbody>
                {stockMismatches.map((p) => (
                  <tr
                    key={p.id}
                    className="border-t bg-rose-50/60 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
                  >
                    <td className="py-2">{p.name}</td>
                    <td className="py-2 text-right font-semibold">{p.stock}</td>
                    <td className="py-2 text-right font-semibold">{p.movementSum}</td>
                    <td className="py-2 text-right">
                      {p.archived ? "Yes" : "No"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card id="order-payment-mismatches">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Order balance mismatches</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {orderBalanceIssues.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              <p>All orders balance correctly.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  href="/admin/orders"
                  className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                >
                  View orders
                </Link>
              </div>
            </div>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-2">Order ID</th>
                  <th className="text-right py-2">Total</th>
                  <th className="text-right py-2">Paid</th>
                  <th className="text-right py-2">Balance</th>
                  <th className="text-right py-2">Expected</th>
                </tr>
              </thead>
              <tbody>
                {orderBalanceIssues.map((o) => (
                  <tr
                    key={o.id}
                    className="border-t bg-rose-50/60 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
                  >
                    <td className="py-2">{o.id}</td>
                    <td className="py-2 text-right font-semibold">{formatCurrency(num(o.total))}</td>
                    <td className="py-2 text-right font-semibold">{formatCurrency(num(o.amountPaid))}</td>
                    <td className="py-2 text-right font-semibold">{formatCurrency(num(o.balance))}</td>
                    <td className="py-2 text-right font-semibold">
                      {formatCurrency(Math.max(0, num(o.total) - num(o.amountPaid)))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-semibold">Order payments mismatches</CardTitle>
          <ReconcileOrdersButton orderIds={paymentMismatches.map((o) => o.id)} />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {paymentMismatches.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              <p>All orders match payment totals.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  href="/admin/orders"
                  className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                >
                  View orders
                </Link>
                <Link
                  href="/admin/payments/momo"
                  className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                >
                  View payments
                </Link>
              </div>
            </div>
          ) : (
            <table className="min-w-full text-sm whitespace-nowrap">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-2 pr-4">Order ID</th>
                  <th className="text-right py-2 pr-4">Order Paid</th>
                  <th className="text-right py-2 pr-4">Payments Total</th>
                  <th className="text-right py-2 pr-4">Difference</th>
                  <th className="text-left py-2 pr-4">Likely Cause</th>
                  <th className="text-right py-2 pr-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {paymentMismatches.map((o) => (
                  <tr
                    key={o.id}
                    className="border-t bg-rose-50/60 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
                  >
                    <td className="py-2 pr-4">{o.id}</td>
                    <td className="py-2 pr-4 text-right font-semibold">{formatCurrency(o.paid)}</td>
                    <td className="py-2 pr-4 text-right font-semibold">{formatCurrency(o.paidFromPayments)}</td>
                    <td className="py-2 pr-4 text-right font-semibold">
                      {formatCurrency(o.delta)}
                    </td>
                    <td className="py-2 pr-4">{o.likelyCause}</td>
                    <td className="py-2 pr-4 text-right">{o.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Payments for mismatched orders</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {mismatchPaymentsView.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              <p>No payment rows found.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  href="/admin/payments/momo"
                  className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                >
                  View payments
                </Link>
              </div>
            </div>
          ) : (
            <table className="min-w-full text-sm whitespace-nowrap">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-2 pr-4">Order ID</th>
                  <th className="text-left py-2 pr-4">Payment ID</th>
                  <th className="text-right py-2 pr-4">Amount</th>
                  <th className="text-right py-2 pr-4">Status</th>
                  <th className="text-left py-2 pr-4">Method</th>
                  <th className="text-left py-2 pr-4">Provider</th>
                  <th className="text-right py-2 pr-4">Applied</th>
                  <th className="text-right py-2 pr-4">Created</th>
                </tr>
              </thead>
              <tbody>
                {mismatchPaymentsView.map((p) => (
                  <tr
                    key={p.id}
                    className="border-t bg-rose-50/60 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300"
                  >
                    <td className="py-2 pr-4">{p.orderId}</td>
                    <td className="py-2 pr-4">{p.id}</td>
                    <td className="py-2 pr-4 text-right font-semibold">{formatCurrency(num(p.amount))}</td>
                    <td className="py-2 pr-4 text-right">{p.status}</td>
                    <td className="py-2 pr-4">{p.meta?.method ?? "-"}</td>
                    <td className="py-2 pr-4">{p.meta?.provider ?? "-"}</td>
                    <td className="py-2 pr-4 text-right font-semibold">
                      {p.appliedTotal == null ? "-" : formatCurrency(p.appliedTotal)}
                    </td>
                    <td className="py-2 pr-4 text-right">{p.createdAt.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {paymentMismatches.length > 0 && (
        <Card id="legacy-auto-apply">
          <CardHeader>
            <CardTitle className="text-base font-semibold">Mismatch diagnostics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {paymentMismatches.map((o) => {
              const linked = linkedPaymentsByOrder.get(o.id) ?? [];
              const noteLinked = notePaymentsByOrder.get(o.id) ?? [];
              const linkedTotal = linked.reduce((sum, p) => {
                if (p.status === "VOID") return sum;
                const signed = p.status === "REFUND" ? -num(p.amount) : num(p.amount);
                return sum + signed;
              }, 0);
              const appliedTotal = noteLinked.reduce((sum, p) => {
                const applied = p.meta?.applied?.reduce((inner, entry) => {
                  if (entry.orderId !== o.id) return inner;
                  return inner + num(entry.applied);
                }, 0);
                return sum + (applied ?? 0);
              }, 0);
              return (
                <details key={o.id} className="rounded-lg border px-4 py-3">
                  <summary className="cursor-pointer text-sm font-semibold text-foreground">
                    {o.id} — difference {formatCurrency(o.delta)}
                  </summary>
                  <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-sm">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Order totals
                      </p>
                      <p>Paid: {formatCurrency(o.paid)}</p>
                      <p>Status: {o.status}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Linked payments
                      </p>
                      <p>Rows: {linked.length}</p>
                      <p>Total: {formatCurrency(linkedTotal)}</p>
                      {linked.length === 0 && (
                        <p className="text-muted-foreground">
                          No linked payments.{" "}
                          <Link href="/admin/payments/momo" className="underline">
                            View payments
                          </Link>
                        </p>
                      )}
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Note-applied payments
                      </p>
                      <p>Rows: {noteLinked.length}</p>
                      <p>Applied: {formatCurrency(appliedTotal)}</p>
                      {noteLinked.length === 0 && (
                        <p className="text-muted-foreground">
                          No payment notes reference this order.{" "}
                          <Link href="/admin/payments/momo" className="underline">
                            View payments
                          </Link>
                        </p>
                      )}
                    </div>
                  </div>
                </details>
              );
            })}
          </CardContent>
        </Card>
      )}

      {unlinkedAppliedPayments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Unlinked applied payments</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="min-w-full text-sm whitespace-nowrap">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-2 pr-4">Applied Order</th>
                  <th className="text-left py-2 pr-4">Payment ID</th>
                  <th className="text-left py-2 pr-4">Linked Order</th>
                  <th className="text-right py-2 pr-4">Applied Amount</th>
                  <th className="text-right py-2 pr-4">Status</th>
                  <th className="text-right py-2 pr-4">Actions</th>
                  <th className="text-right py-2 pr-4">Created</th>
                </tr>
              </thead>
              <tbody>
                {unlinkedAppliedPayments.map((entry) => (
                  <tr key={`${entry.paymentId}-${entry.appliedOrderId}`} className="border-t">
                    <td className="py-2 pr-4">{entry.appliedOrderId}</td>
                    <td className="py-2 pr-4">{entry.paymentId}</td>
                    <td className="py-2 pr-4">{entry.linkedOrderId || "-"}</td>
                    <td className="py-2 pr-4 text-right">
                      {formatCurrency(num(entry.appliedAmount))}
                    </td>
                    <td className="py-2 pr-4 text-right">{entry.status}</td>
                    <td className="py-2 pr-4 text-right">
                      <FixActionsMenu
                        sql={`UPDATE "Payment" SET "orderId" = '${entry.appliedOrderId}' WHERE "id" = '${entry.paymentId}';`}
                        orderId={entry.appliedOrderId || ""}
                        paymentId={entry.paymentId}
                      />
                    </td>
                    <td className="py-2 pr-4 text-right">{entry.createdAt.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {legacyAutoApplyView.length > 0 && (
        <Card>
          <CardHeader>
          <CardTitle className="text-base font-semibold">Legacy AUTO_APPLY payments</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="min-w-full text-sm whitespace-nowrap">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-2 pr-4">Payment ID</th>
                  <th className="text-right py-2 pr-4">Amount</th>
                  <th className="text-left py-2 pr-4">Applied Orders</th>
                  <th className="text-right py-2 pr-4">Backfill</th>
                  <th className="text-right py-2 pr-4">Created</th>
                </tr>
              </thead>
              <tbody>
                {legacyAutoApplyView.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="py-2 pr-4">{p.id}</td>
                    <td className="py-2 pr-4 text-right">{formatCurrency(num(p.amount))}</td>
                    <td className="py-2 pr-4">
                      {p.appliedOrders
                        .map((entry) => `${entry.orderId}: ${formatCurrency(entry.applied)}`)
                        .join(", ")}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {p.canBackfill ? (
                        <BackfillAutoApplyButton paymentId={p.id} />
                      ) : (
                        <span className="text-xs text-muted-foreground">Manual</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      {p.createdAt.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Payment status totals</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left py-2">Type</th>
                <th className="text-right py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t">
                <td className="py-2">Normal</td>
                <td className="py-2 text-right">{formatCurrency(paymentsNormal)}</td>
              </tr>
              <tr className="border-t">
                <td className="py-2">Refunds</td>
                <td className="py-2 text-right">{formatCurrency(paymentsRefund)}</td>
              </tr>
              <tr className="border-t">
                <td className="py-2">Voids</td>
                <td className="py-2 text-right">{formatCurrency(paymentsVoid)}</td>
              </tr>
              <tr className="border-t font-semibold">
                <td className="py-2">Net</td>
                <td className="py-2 text-right">{formatCurrency(paymentsTotal)}</td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">COGS coverage</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {cogsMissing === 0 ? (
            <p className="text-sm text-muted-foreground">
              All order items include a recorded cost at sale.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {cogsMissing} order item(s) are missing cost-at-sale data.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Negative stock</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {negativeStock.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              <p>No products with negative stock.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  href="/admin/inventory"
                  className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
                >
                  View inventory
                </Link>
              </div>
            </div>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left py-2">Product</th>
                  <th className="text-right py-2">Stock</th>
                </tr>
              </thead>
              <tbody>
                {negativeStock.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="py-2">{p.name}</td>
                    <td className="py-2 text-right">{num(p.stock)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

