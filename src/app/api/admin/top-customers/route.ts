import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type TopCustomer = {
  userId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  ordersTotal: number;
  paidTotal: number;
  paymentsTotal: number;
  creditAvailable: number;
};

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;

  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [users, orderSums, paymentSums] = await Promise.all([
      prisma.user.findMany({
        where: { OR: [{ role: "CUSTOMER" }, { role: "ADMIN" }, { role: "STAFF" }, { role: "ACCOUNTANT" }] },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
      }),
      prisma.order.groupBy({
        by: ["userId"],
        where: { status: { not: "CANCELLED" } },
        _sum: { total: true, amountPaid: true },
      }),
      prisma.payment.groupBy({
        by: ["userId"],
        // Exclude internal auto-apply adjustment entries so that "credit"
        // matches the store credit logic used elsewhere.
        where: {
          NOT: {
            note: {
              contains: "\"reference\":\"AUTO_APPLY\"",
            },
          },
        },
        _sum: { amount: true },
      }),
    ]);

    const ordersByUser: Record<string, { ordersTotal: number; paidTotal: number }> = {};
    for (const o of orderSums) {
      if (!o.userId) continue;
      ordersByUser[o.userId] = {
        ordersTotal: Number(o._sum.total ?? 0),
        paidTotal: Number(o._sum.amountPaid ?? 0),
      };
    }

    const paymentsByUser: Record<string, number> = {};
    for (const p of paymentSums) {
      if (!p.userId) continue;
      paymentsByUser[p.userId] = Number(p._sum.amount ?? 0);
    }

    const customers: TopCustomer[] = users.map((u) => {
      const ordersTotal = ordersByUser[u.id]?.ordersTotal ?? 0;
      const paidTotal = ordersByUser[u.id]?.paidTotal ?? 0;
      const paymentsTotal = paymentsByUser[u.id] ?? 0;
      const creditAvailable = Math.max(0, paymentsTotal - paidTotal);
      return {
        userId: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        ordersTotal,
        paidTotal,
        paymentsTotal,
        creditAvailable,
      };
    });

    // Filter out customers with no activity at all
    const active = customers.filter(
      (c) => c.ordersTotal > 0 || c.paidTotal > 0 || c.paymentsTotal > 0,
    );

    // Sort by total value of orders (descending), then by paid total
    active.sort((a, b) => {
      if (b.ordersTotal !== a.ordersTotal) {
        return b.ordersTotal - a.ordersTotal;
      }
      return b.paidTotal - a.paidTotal;
    });

    return NextResponse.json(active.slice(0, 10));
  } catch (error) {
    console.error("Error fetching top customers:", error);
    return NextResponse.json(
      { error: "Failed to fetch top customers" },
      { status: 500 },
    );
  }
}
