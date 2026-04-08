import { prisma } from "@/lib/prisma";
import { isCreditLimitExceeded } from "@/lib/credit";
import { roundCurrency } from "@/lib/currency";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

export async function recomputeOrderTotalsFromPayments(
  tx: TxClient,
  orderId: string
) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      total: true,
      subtotal: true,
      taxRate: true,
      taxAmount: true,
      status: true,
      amountPaid: true,
      balance: true,
      invoiceNumber: true,
      userId: true,
    },
  });
  if (!order) throw new Error("Order not found");
  if (order.status === "CANCELLED") return order;

  const payments = await tx.payment.findMany({
    where: { orderId },
    select: { amount: true, status: true, note: true },
  });

  const shouldExcludeFromPaid = (note: string | null) => {
    if (!note) return false;
    try {
      const meta = JSON.parse(note) as {
        method?: string;
        status?: string;
        providerRef?: string;
      };
      if (String(meta.method || "").toLowerCase() !== "momo") return false;
      const hasProviderRef = Boolean(String(meta.providerRef || "").trim());
      if (!hasProviderRef) return false;
      const momoStatus = String(meta.status || "").toUpperCase();
      // Provider-linked MoMo entries count only after confirmed success.
      return !(momoStatus === "SUCCESS" || momoStatus === "SUCCESSFUL");
    } catch {
      return false;
    }
  };

  let paid = 0;
  for (const p of payments) {
    if (p.status === "VOID") continue;
    if (shouldExcludeFromPaid(p.note)) continue;
    const amt = Number(p.amount || 0);
    paid += p.status === "REFUND" ? -Math.abs(amt) : amt;
  }

  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { price: true, quantity: true, returnedQuantity: true },
  });
  const subtotal = roundCurrency(
    items.reduce((sum, item) => {
      const price = Number(item.price || 0);
      const netQty = Math.max(0, Number(item.quantity || 0) - Number(item.returnedQuantity || 0));
      return sum + price * netQty;
    }, 0)
  );
  const taxRate = Number(order.taxRate || 0);
  const priorSubtotal = Number(order.subtotal || 0);
  const priorTax = Number(order.taxAmount || 0);
  const taxAmount = roundCurrency(
    taxRate > 0
      ? (subtotal * taxRate) / 100
      : priorSubtotal > 0
      ? (priorTax * subtotal) / priorSubtotal
      : 0
  );
  const total = roundCurrency(subtotal + taxAmount);
  // Prevent over-application: cap amountPaid at total so AR doesn't flip negative.
  const amountPaid = roundCurrency(Math.min(Math.max(0, paid), total));
  const balance = roundCurrency(Math.max(0, total - amountPaid));
  let newStatus = balance <= 0 ? "PAID" : amountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";
  if (String(order.status || "").toUpperCase() === "ON_HOLD_CREDIT") {
    if (balance <= 0) {
      newStatus = "PAID";
    } else if (order.userId) {
      const { exceeded } = await isCreditLimitExceeded(tx, order.userId);
      newStatus = exceeded ? "ON_HOLD_CREDIT" : newStatus;
    } else {
      newStatus = newStatus;
    }
  }

  return tx.order.update({
    where: { id: orderId },
    data: { subtotal, taxAmount, total, amountPaid, balance, status: newStatus },
  });
}
