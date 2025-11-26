import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PaymentStatus, RefundDestination } from "@/lib/prisma-enums";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const self = searchParams.get("self") === "1";
  const sessionUser = session.user as AuthenticatedUser;
  const role = sessionUser.role;

  try {
    if (!self && role === "ADMIN") {
      // Derive balances live from orders to avoid drift (all customers)
      const [users, orderSums] = await Promise.all([
        prisma.user.findMany({
          where: { role: "CUSTOMER" },
          select: { id: true, name: true, email: true },
        }),
        prisma.order.groupBy({
          by: ["userId"],
          where: { status: { not: "CANCELLED" } },
          _sum: { total: true, amountPaid: true },
        }),
      ]);

      const sumsByUser: Record<string, { totalDue: number; totalPaid: number }> = {};
      for (const s of orderSums) {
        if (!s.userId) continue;
        const totalDue = Number(s._sum.total ?? 0);
        const totalPaid = Number(s._sum.amountPaid ?? 0);
        sumsByUser[s.userId] = { totalDue, totalPaid };
      }

      const nowIso = new Date().toISOString();
      const rows = users.map((u: { id: string; name: string | null; email: string | null }) => {
        const totals = sumsByUser[u.id] || { totalDue: 0, totalPaid: 0 };
        const balance = Math.max(0, totals.totalDue - totals.totalPaid);
        return {
          id: u.id,
          totalDue: totals.totalDue,
          totalPaid: totals.totalPaid,
          balance,
          updatedAt: nowIso,
          user: { name: u.name, email: u.email },
        };
      });

      return NextResponse.json(rows);
    }

    // Single-user summary (for customers and for admin when self=1)
    const userId = sessionUser.id;

    const [orders, payments] = await Promise.all([
      prisma.order.findMany({
        where: { userId, NOT: { status: "CANCELLED" } },
        select: { total: true, amountPaid: true },
      }),
      prisma.payment.findMany({
        where: { userId },
        select: { amount: true, status: true, refundDisposition: true },
      }),
    ]);

    const totalDue = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);
    const totalPaid = orders.reduce((sum, o) => sum + Number(o.amountPaid || 0), 0);
    const paymentsTotal = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const balance = Math.max(0, totalDue - totalPaid);
    const cashRefunds = payments
      .filter(
        (p) => p.status === PaymentStatus.REFUND && p.refundDisposition === RefundDestination.CASH
      )
      .reduce((sum, p) => sum + Math.abs(Number(p.amount || 0)), 0);
    const unappliedFunds = Math.max(0, paymentsTotal - totalPaid);

    return NextResponse.json({
      totalDue,
      totalPaid,
      balance,
      paymentsTotal,
      unappliedFunds,
      cashRefunds,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to load balances" },
      { status: 500 }
    );
  }
}
