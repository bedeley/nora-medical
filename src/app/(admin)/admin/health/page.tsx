"use server";

import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { Tooltip } from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import { BackfillAutoApplyButton, FixActionsMenu } from "@/components/admin/CopySqlButton";
import ReconcileOrdersButton from "@/components/admin/ReconcileOrdersButton";

function num(v: unknown) {
  return Number(v || 0);
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
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Unauthorized.</p>
      </div>
    );
  }

  const products = await prisma.product.findMany({
    select: { id: true, name: true, stock: true, cost: true, archived: true },
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
    }))
    .filter((p) => p.stock !== p.movementSum);

  const orders = await prisma.order.findMany({
    select: { id: true, total: true, amountPaid: true, balance: true, status: true },
  });
  const activeOrders = orders.filter((o) => o.status !== "CANCELLED");
  const orderBalanceIssues = activeOrders
    .map((o) => {
      const total = num(o.total);
      const paid = num(o.amountPaid);
      const balance = num(o.balance);
      const expected = Math.max(0, total - paid);
      return { ...o, total, paid, balance, expected };
    })
    .filter((o) => Math.abs(o.balance - o.expected) > 0.01);

  const orderPayments = await prisma.payment.groupBy({
    by: ["orderId", "status"],
    where: { orderId: { not: null } },
    _sum: { amount: true },
  });
  const orderPaymentsMap = new Map<string, number>();
  for (const row of orderPayments) {
    if (!row.orderId) continue;
    if (row.status === "VOID") continue;
    const signed = row.status === "REFUND" ? -num(row._sum.amount) : num(row._sum.amount);
    orderPaymentsMap.set(row.orderId, (orderPaymentsMap.get(row.orderId) ?? 0) + signed);
  }
  const paymentMismatches = activeOrders
    .map((o) => {
      const paid = num(o.amountPaid);
      const paidFromPayments = orderPaymentsMap.get(o.id) ?? 0;
      const delta = paid - paidFromPayments;
      const likelyCause =
        delta > 0
          ? "Order paid is higher than recorded payments"
          : "Payments total is higher than order paid";
      return { ...o, paid, paidFromPayments, delta, likelyCause };
    })
    .filter((o) => Math.abs(o.paid - o.paidFromPayments) > 0.01);

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
  const paymentsTotal = paymentsNormal - paymentsRefund;

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
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Health Check</h1>
        <p className="text-sm text-muted-foreground">
          Verifies stock totals, order balances, revenue, costs, and expenses.
        </p>
      </div>

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
              <CardTitle className="text-sm">In-stock products</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{inStock.length}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Stock mismatches</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{stockMismatches.length}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Balance mismatches</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{orderBalanceIssues.length}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Payment mismatches</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{paymentMismatches.length}</CardContent>
          </Card>
        </div>
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
              <CardTitle className="text-sm">Order value (active)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalOrderValue)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Paid (active)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalPaid)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Outstanding balance</CardTitle>
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
              <CardTitle className="text-sm">Revenue (cash)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(paymentsTotal)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">COGS (net)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(cogsTotal)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Expenses</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalExpenses)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Gross profit (cash)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(grossProfit)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Net profit (cash)</CardTitle>
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
              <CardTitle className="text-sm">Revenue (accrual)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalOrderValue)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">COGS (net)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(cogsTotal)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Expenses</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(totalExpenses)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Gross profit (accrual)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(accrualGrossProfit)}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Net profit (accrual)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">{formatCurrency(accrualNetProfit)}</CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>In-stock products</CardTitle>
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
                    No products currently in stock.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Stock vs movement mismatches</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {stockMismatches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No mismatches found.</p>
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
                  <tr key={p.id} className="border-t">
                    <td className="py-2">{p.name}</td>
                    <td className="py-2 text-right">{p.stock}</td>
                    <td className="py-2 text-right">{p.movementSum}</td>
                    <td className="py-2 text-right">{p.archived ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Order balance mismatches</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {orderBalanceIssues.length === 0 ? (
            <p className="text-sm text-muted-foreground">All orders balance correctly.</p>
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
                  <tr key={o.id} className="border-t">
                    <td className="py-2">{o.id}</td>
                    <td className="py-2 text-right">{formatCurrency(o.total)}</td>
                    <td className="py-2 text-right">{formatCurrency(o.paid)}</td>
                    <td className="py-2 text-right">{formatCurrency(o.balance)}</td>
                    <td className="py-2 text-right">{formatCurrency(o.expected)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>Order payments mismatches</CardTitle>
          <ReconcileOrdersButton orderIds={paymentMismatches.map((o) => o.id)} />
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {paymentMismatches.length === 0 ? (
            <p className="text-sm text-muted-foreground">All orders match payment totals.</p>
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
                  <tr key={o.id} className="border-t">
                    <td className="py-2 pr-4">{o.id}</td>
                    <td className="py-2 pr-4 text-right">{formatCurrency(o.paid)}</td>
                    <td className="py-2 pr-4 text-right">{formatCurrency(o.paidFromPayments)}</td>
                    <td className="py-2 pr-4 text-right">
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
          <CardTitle>Payments for mismatched orders</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {mismatchPaymentsView.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payment rows found.</p>
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
                  <tr key={p.id} className="border-t">
                    <td className="py-2 pr-4">{p.orderId}</td>
                    <td className="py-2 pr-4">{p.id}</td>
                    <td className="py-2 pr-4 text-right">{formatCurrency(num(p.amount))}</td>
                    <td className="py-2 pr-4 text-right">{p.status}</td>
                    <td className="py-2 pr-4">{p.meta?.method ?? "-"}</td>
                    <td className="py-2 pr-4">{p.meta?.provider ?? "-"}</td>
                    <td className="py-2 pr-4 text-right">
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
        <Card>
          <CardHeader>
            <CardTitle>Mismatch diagnostics</CardTitle>
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
                  <div className="mt-3 grid gap-4 md:grid-cols-3 text-sm">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Order totals
                      </p>
                      <p>Total: {formatCurrency(num(o.total))}</p>
                      <p>Paid: {formatCurrency(o.paid)}</p>
                      <p>Balance: {formatCurrency(num(o.balance))}</p>
                      <p>Status: {o.status}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        Linked payments
                      </p>
                      <p>Rows: {linked.length}</p>
                      <p>Total: {formatCurrency(linkedTotal)}</p>
                      {linked.length === 0 && (
                        <p className="text-muted-foreground">No linked payments.</p>
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
                          No payment notes reference this order.
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
            <CardTitle>Unlinked applied payments</CardTitle>
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
            <CardTitle>Legacy AUTO_APPLY payments</CardTitle>
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
          <CardTitle>Payment status totals</CardTitle>
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
          <CardTitle>COGS coverage</CardTitle>
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
          <CardTitle>Negative stock</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {negativeStock.length === 0 ? (
            <p className="text-sm text-muted-foreground">No products with negative stock.</p>
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
