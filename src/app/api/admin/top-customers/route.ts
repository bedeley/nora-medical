import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseISO, isValid, startOfDay, endOfDay } from "date-fns";

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

export async function GET(request: Request) {
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
    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");

    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (start && isValid(parseISO(start))) dateFilter.gte = startOfDay(parseISO(start));
    if (end && isValid(parseISO(end))) dateFilter.lte = endOfDay(parseISO(end));
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    // Fetch grouped sums first — only users with activity will appear
    const [orderSums, paymentSums] = await Promise.all([
      prisma.order.groupBy({
        by: ["userId"],
        where: {
          status: { not: "CANCELLED" },
          ...(hasDateFilter ? { createdAt: dateFilter } : {}),
        },
        _sum: { total: true, amountPaid: true },
      }),
      prisma.payment.groupBy({
        by: ["userId"],
        where: {
          status: { notIn: ["REFUND", "VOID"] },
          NOT: { note: { contains: "\"reference\":\"AUTO_APPLY\"" } },
          ...(hasDateFilter ? { createdAt: dateFilter } : {}),
        },
        _sum: { amount: true },
      }),
    ]);

    // Collect only user IDs that have actual activity — avoids loading all users
    const activeUserIds = [
      ...new Set([
        ...orderSums.map((o) => o.userId).filter((id): id is string => Boolean(id)),
        ...paymentSums.map((p) => p.userId).filter((id): id is string => Boolean(id)),
      ]),
    ];

    if (activeUserIds.length === 0) return NextResponse.json([]);

    const users = await prisma.user.findMany({
      where: { id: { in: activeUserIds } },
      select: { id: true, name: true, email: true, phone: true },
    });

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
      return { userId: u.id, name: u.name, email: u.email, phone: u.phone, ordersTotal, paidTotal, paymentsTotal, creditAvailable };
    });

    customers.sort((a, b) => {
      if (b.ordersTotal !== a.ordersTotal) return b.ordersTotal - a.ordersTotal;
      return b.paidTotal - a.paidTotal;
    });

    return NextResponse.json(customers.slice(0, 10));
  } catch (error) {
    console.error("Error fetching top customers:", error);
    return NextResponse.json({ error: "Failed to fetch top customers" }, { status: 500 });
  }
}
