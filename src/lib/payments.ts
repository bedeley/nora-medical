import { prisma } from "@/lib/prisma";

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
      status: true,
      amountPaid: true,
      balance: true,
      userId: true,
    },
  });
  if (!order) throw new Error("Order not found");
  if (order.status === "CANCELLED") return order;

  const payments = await tx.payment.findMany({
    where: { orderId },
    select: { amount: true, status: true },
  });

  let paid = 0;
  for (const p of payments) {
    if (p.status === "VOID") continue;
    const amt = Number(p.amount || 0);
    paid += p.status === "REFUND" ? -Math.abs(amt) : amt;
  }

  const total = Number(order.total || 0);
  const amountPaid = Math.max(0, paid);
  const balance = Math.max(0, total - amountPaid);
  const newStatus = balance <= 0 ? "PAID" : amountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";

  return tx.order.update({
    where: { id: orderId },
    data: { amountPaid, balance, status: newStatus },
  });
}
