import { prisma } from "@/lib/prisma";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (
  arg: infer A,
) => unknown
  ? A
  : never;

const EPSILON = 0.01;

export async function getCreditLimitForUser(tx: TxClient, userId?: string | null) {
  if (!userId) return 0;
  const row = await tx.balance.findUnique({
    where: { userId },
    select: { creditLimit: true },
  });
  return Number(row?.creditLimit ?? 0);
}

export async function computeOutstandingBalance(
  tx: TxClient,
  userId?: string | null,
) {
  if (!userId) return 0;
  const orders = await tx.order.findMany({
    where: { userId, status: { not: "CANCELLED" } },
    select: { total: true, amountPaid: true },
  });
  return orders.reduce((sum, o) => {
    const total = Number(o.total || 0);
    const paid = Number(o.amountPaid || 0);
    return sum + Math.max(0, total - paid);
  }, 0);
}

export async function isCreditLimitExceeded(
  tx: TxClient,
  userId?: string | null,
) {
  const creditLimit = await getCreditLimitForUser(tx, userId);
  if (!userId || creditLimit <= EPSILON) {
    return { creditLimit, outstanding: 0, exceeded: false };
  }
  const outstanding = await computeOutstandingBalance(tx, userId);
  return {
    creditLimit,
    outstanding,
    exceeded: outstanding > creditLimit + EPSILON,
  };
}
