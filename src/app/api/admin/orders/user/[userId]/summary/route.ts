import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: { userId: string } }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = params.userId;
  try {
    const orders = await prisma.order.findMany({
      where: { userId, status: { not: "CANCELLED" } },
      select: { total: true, amountPaid: true },
    });
    const ordersTotal = orders.reduce((s, o) => s + Number(o.total || 0), 0);
    const paidTotal = orders.reduce(
      (s, o) => s + Number(o.amountPaid || 0),
      0,
    );
    const balance = Math.max(0, ordersTotal - paidTotal);
    return NextResponse.json({ ordersTotal, paidTotal, balance });
  } catch (e) {
    console.error("Order summary by user error:", e);
    return NextResponse.json({ error: "Failed to load order summary" }, { status: 500 });
  }
}
