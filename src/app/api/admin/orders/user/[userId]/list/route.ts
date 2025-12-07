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
  if (!userId) {
    return NextResponse.json({ error: "Missing user ID" }, { status: 400 });
  }

  try {
    const orders = await prisma.order.findMany({
      where: { userId },
      include: {
        payments: true,
        items: {
          include: { product: { select: { id: true, name: true, imageUrl: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Normalize numeric fields and ensure balance is consistent with total/amountPaid
    const data = orders.map((o: typeof orders[number]) => {
      const total = Number(o.total);
      const amountPaid = Number(o.amountPaid ?? 0);
      const rawBalance = Number(o.balance ?? 0);
      const computedBalance = Math.max(0, total - amountPaid);
      const balance = rawBalance === 0 ? computedBalance : rawBalance;
      return {
        id: o.id,
        status: o.status,
        deliveryStatus: o.deliveryStatus,
        deliveredAt: o.deliveredAt ? o.deliveredAt.toISOString() : null,
        createdAt: o.createdAt.toISOString(),
        total,
        amountPaid,
        balance,
        payments: (o.payments || []).map((p) => ({
          id: p.id,
          amount: Number(p.amount),
          note: p.note,
          status: p.status || null,
          refundDisposition: p.refundDisposition || null,
          createdAt: p.createdAt.toISOString(),
        })),
        items: (o.items || []).map((it) => ({
          id: it.id,
          quantity: it.quantity,
          price: Number(it.price),
          deliveredQuantity: Number((it as { deliveredQuantity?: unknown }).deliveredQuantity ?? 0),
          returnedQuantity: Number((it as { returnedQuantity?: unknown }).returnedQuantity ?? 0),
          product: it.product
            ? {
                id: it.product.id,
                name: it.product.name,
                imageUrl: it.product.imageUrl,
              }
            : null,
        })),
      };
    });

    return NextResponse.json({ orders: data });
  } catch (error) {
    console.error("Admin list orders error:", error);
    return NextResponse.json({ error: "Failed to load orders" }, { status: 500 });
  }
}
