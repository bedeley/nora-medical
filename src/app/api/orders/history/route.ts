import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const orders = await prisma.order.findMany({
    where: { userId: (session.user as AuthenticatedUser).id },
    include: {
      payments: true,
      items: {
        include: {
          product: { select: { id: true, name: true, imageUrl: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Normalize numeric fields and include computed balance consistently
  const data = orders.map((o: typeof orders[number]) => {
    const total = Number(o.total);
    const amountPaid = Number(o.amountPaid ?? 0);
    const rawBalance = Number(o.balance ?? 0);
    const computedBalance = Math.max(0, total - amountPaid);
    const balance = rawBalance === 0 ? computedBalance : rawBalance;
    return {
      id: o.id,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
      total,
      amountPaid,
      balance,
      payments: (o.payments || []).map((p: typeof o.payments[number]) => ({
        id: p.id,
        amount: Number(p.amount),
        note: p.note,
        status: p.status || null,
        refundDisposition: p.refundDisposition || null,
        createdAt: p.createdAt.toISOString(),
      })),
      items: (o.items || []).map((it: typeof o.items[number]) => ({
        id: it.id,
        quantity: it.quantity,
        price: Number(it.price),
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

  return Response.json({ orders: data });
}

