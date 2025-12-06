import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const userId = segments[segments.length - 2];
  try {
    const orders = await prisma.order.findMany({
      where: { userId, status: { not: "CANCELLED" } },
      select: { total: true, amountPaid: true },
    });
    const ordersTotal = orders.reduce(
      (s: number, o: { total: unknown }) => s + Number(o.total || 0),
      0
    );
    const paidTotal = orders.reduce(
      (s: number, o: { amountPaid: unknown }) => s + Number(o.amountPaid || 0),
      0,
    );
    const balance = Math.max(0, ordersTotal - paidTotal);
    return NextResponse.json({ ordersTotal, paidTotal, balance });
  } catch (e) {
    console.error("Order summary by user error:", e);
    return NextResponse.json({ error: "Failed to load order summary" }, { status: 500 });
  }
}
