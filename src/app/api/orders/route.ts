import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => any ? A : never;

/**
 * ✅ GET /api/orders
 * Fetch user orders (or all orders if admin)
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = session.user as AuthenticatedUser;
  const isAdmin = user.role === "ADMIN";

  try {
    const orders = await prisma.order.findMany({
      where: isAdmin ? {} : { userId: user.id },
      include: {
        items: { include: { product: true } },
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const safeOrders = orders.map((o: {
      id: string;
      total: unknown;
      amountPaid: unknown;
      status: string;
      deliveryStatus: string | null;
      deliveredAt: Date | null;
      createdAt: Date;
      user: { name: string | null; email: string | null } | null;
      items: Array<{
        id: string;
        quantity: number;
        price: unknown;
        product: { id: string; name: string; imageUrl: string | null };
      }>;
    }) => {
      const total = Number(o.total);
      let amountPaid = Number(o.amountPaid ?? 0);
      const epsilon = 0.01;
      // Always recompute balance from total/amountPaid, then infer display status
      let balance = Math.max(0, total - amountPaid);
      let status = o.status as string;
      if (status !== "CANCELLED") {
        if (balance <= epsilon) {
          // Treat tiny balances as fully paid
          status = "PAID";
          amountPaid = total;
          balance = 0;
        } else if (amountPaid <= epsilon) {
          status = "UNPAID";
        } else if (status !== "PARTIALLY_PAID") {
          status = "PARTIALLY_PAID";
        }
      }
      return {
        id: o.id,
        status,
        deliveryStatus: o.deliveryStatus || "NOT_DELIVERED",
        deliveredAt: o.deliveredAt
          ? new Date(o.deliveredAt).toISOString()
          : null,
        total,
        amountPaid,
        balance,
        createdAt: o.createdAt.toISOString(),
        user: o.user,
        items: o.items.map((i: {
          id: string;
          quantity: number;
          price: unknown;
          product: { id: string; name: string; imageUrl: string | null };
        }) => ({
          id: i.id,
          quantity: i.quantity,
          price: Number(i.price),
          product: {
            id: i.product.id,
            name: i.product.name,
            imageUrl: i.product.imageUrl,
          },
        })),
      };
    });

    return NextResponse.json(safeOrders);
  } catch (error) {
    console.error("Error fetching orders:", error);
    return NextResponse.json(
      { error: "Failed to fetch orders" },
      { status: 500 }
    );
  }
}

/**
 * ✅ POST /api/orders
 * Create a new order from the current user’s cart
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req))
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const userId = (session.user as AuthenticatedUser).id;

  try {
    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true } } },
    });

    if (!cart || cart.items.length === 0) {
      return NextResponse.json({ error: "Empty cart" }, { status: 400 });
    }

    // Validate stock and active products
    for (const ci of cart.items) {
      const p = ci.product;
      if (!p || p.archived) {
        return NextResponse.json(
          { error: `Product unavailable: ${p?.name || ci.productId}` },
          { status: 400 }
        );
      }
      if (typeof p.stock === "number" && p.stock < ci.quantity) {
        return NextResponse.json(
          { error: `Insufficient stock for ${p.name}. In stock: ${p.stock}` },
          { status: 400 }
        );
      }
    }

    const total = cart.items.reduce(
      (sum: number, it: { quantity: number; product: { price: unknown } }) =>
        sum + Number(it.product.price) * it.quantity,
      0
    );

    // ✅ All actions in one safe transaction
    const order = await prisma.$transaction(async (tx: TxClient) => {
      const newOrder = await tx.order.create({
        data: {
          userId,
          total,
          amountPaid: 0,
          balance: total,
          status: "UNPAID",
        },
      });

      await tx.orderItem.createMany({
        data: cart.items.map((ci: {
          productId: string;
          product: { price: unknown; cost: unknown };
          quantity: number;
        }) => ({
          orderId: newOrder.id,
          productId: ci.productId,
          price: Number(ci.product.price),
          costAtSale: Number(ci.product.cost ?? 0),
          quantity: ci.quantity,
        })),
      });

      // Decrement stock
      for (const ci of cart.items as Array<{ productId: string; quantity: number }>) {
        await tx.product.update({
          where: { id: ci.productId },
          data: { stock: { decrement: ci.quantity } },
        });
        // Log inventory movement for sale
        await tx.inventoryMovement.create({
          data: { productId: ci.productId, delta: -ci.quantity, reason: "SALE" },
        });
      }

      // Clear cart after checkout
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      return newOrder;
    });

    return NextResponse.json({
      success: true,
      message: "Order placed successfully.",
      orderId: order.id,
      total,
    });
  } catch (error) {
    console.error("Error creating order:", error);
    return NextResponse.json(
      { error: "Failed to create order" },
      { status: 500 }
    );
  }
}

