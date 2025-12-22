import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function num(v: unknown) {
  return Number(v || 0);
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const products = await prisma.product.findMany({
    select: { id: true, stock: true },
  });
  const movements = await prisma.inventoryMovement.groupBy({
    by: ["productId"],
    _sum: { delta: true },
  });
  const movementMap = new Map(movements.map((m) => [m.productId, num(m._sum.delta)]));
  const stockMismatches = products.filter(
    (p) => num(p.stock) !== (movementMap.get(p.id) ?? 0)
  ).length;
  const negativeStock = products.filter((p) => num(p.stock) < 0).length;

  const orders = await prisma.order.findMany({
    select: { id: true, total: true, amountPaid: true, balance: true, status: true },
  });
  const activeOrders = orders.filter((o) => o.status !== "CANCELLED");
  const orderBalanceMismatches = activeOrders.filter((o) => {
    const expected = Math.max(0, num(o.total) - num(o.amountPaid));
    return Math.abs(num(o.balance) - expected) > 0.01;
  }).length;

  const orderPayments = await prisma.payment.groupBy({
    by: ["orderId", "status"],
    where: { orderId: { not: null } },
    _sum: { amount: true },
  });
  const orderPaymentsMap = new Map<string, number>();
  for (const row of orderPayments) {
    if (!row.orderId) continue;
    if (row.status === "VOID") continue;
    const signed =
      row.status === "REFUND" ? -num(row._sum.amount) : num(row._sum.amount);
    orderPaymentsMap.set(
      row.orderId,
      (orderPaymentsMap.get(row.orderId) ?? 0) + signed
    );
  }
  const paymentMismatches = activeOrders.filter((o) => {
    const paidFromPayments = orderPaymentsMap.get(o.id) ?? 0;
    return Math.abs(num(o.amountPaid) - paidFromPayments) > 0.01;
  }).length;

  const legacyAutoApply = await prisma.payment.count({
    where: { orderId: null, note: { contains: "\"reference\":\"AUTO_APPLY\"" } },
  });

  return NextResponse.json({
    stockMismatches,
    negativeStock,
    orderBalanceMismatches,
    paymentMismatches,
    legacyAutoApply,
  });
}
