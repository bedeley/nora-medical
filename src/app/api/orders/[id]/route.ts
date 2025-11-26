import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

type OrderWithRelations = {
  id: string;
  total: unknown;
  amountPaid?: unknown;
  balance?: unknown;
  status: string;
  deliveryStatus?: string | null;
  deliveredAt?: Date | string | null;
  createdAt: Date;
  user: { name: string | null; email: string | null } | null;
  placedById?: string | null;
  adminNote?: string | null;
  items: Array<{
    id: string;
    quantity: number;
    price: unknown;
    product: { id: string; name: string; imageUrl: string | null } | null;
  }>;
};

function serializeOrder(o: OrderWithRelations) {
  const total = Number(o.total);
  let amountPaid = Number(o.amountPaid ?? 0);
  const epsilon = 0.01;
  let balance = Math.max(0, total - amountPaid);
  let status = o.status as string;
  if (status !== "CANCELLED") {
    if (balance <= epsilon) {
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
    total,
    amountPaid,
    balance,
    status,
    deliveryStatus: o.deliveryStatus || "NOT_DELIVERED",
    deliveredAt: o.deliveredAt ? new Date(o.deliveredAt).toISOString() : null,
    createdAt: o.createdAt.toISOString(),
    user: o.user,
    placedById: o.placedById || null,
    adminNote: o.adminNote || null,
    items: (o.items || []).map((i) => ({
      id: i.id,
      quantity: i.quantity,
      price: Number(i.price),
      product: i.product
        ? {
            id: i.product.id,
            name: i.product.name,
            imageUrl: i.product.imageUrl,
          }
        : null,
    })),
  };
}

// GET /api/orders/[id] — fetch single order (admin or owner)
export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = session.user as AuthenticatedUser;
  const isAdmin = user.role === "ADMIN";
  const params = await context.params;

  try {
    const order = await prisma.order.findFirst({
      where: isAdmin ? { id: params.id } : { id: params.id, userId: user.id },
      include: { items: { include: { product: true } }, user: { select: { name: true, email: true } } },
    });

    if (!order) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ data: serializeOrder(order as unknown as OrderWithRelations) });
  } catch (error) {
    console.error("Error fetching order:", error);
    return NextResponse.json(
      { error: "Failed to fetch order" },
      { status: 500 }
    );
  }
}

const updateSchema = z.object({
  status: z
    .enum(["UNPAID", "PARTIALLY_PAID", "PAID", "PENDING_PAYMENT", "CANCELLED"]) // removed SHIPPED
    .or(z.string().min(1))
    .optional(),
  deliveryStatus: z
    .enum(["NOT_DELIVERED", "PARTIALLY_DELIVERED", "DELIVERED"]) // new delivery tracking
    .optional(),
});

// PATCH /api/orders/[id] — update status (admin only)
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const body = await req.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success || (!parsed.data.status && !parsed.data.deliveryStatus)) {
      return NextResponse.json({ error: "Invalid update payload" }, { status: 400 });
    }

    const current = await prisma.order.findUnique({ where: { id: params.id } });
    if (!current) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const newStatus = parsed.data.status;
    const newDelivery = parsed.data.deliveryStatus;
    let amountPaid = Number(current.amountPaid ?? 0);
    const total = Number(current.total ?? 0);
    let balance = Number(current.balance ?? Math.max(0, total - amountPaid));

    if (newStatus) {
      if (newStatus === "PAID") {
        amountPaid = total;
        balance = 0;
      } else if (newStatus === "UNPAID") {
        amountPaid = 0;
        balance = total;
      } else if (newStatus === "PARTIALLY_PAID") {
        // Keep existing amounts but normalize balance from amountPaid
        balance = Math.max(0, total - amountPaid);
      } else if (newStatus === "CANCELLED") {
        // Leave financials as-is; UI excludes cancelled from outstanding banners
      } else {
        // Normalize other statuses to consistent balance
        balance = Math.max(0, total - amountPaid);
      }
    }

    const data: {
      amountPaid: number;
      balance: number;
      status?: string;
      deliveryStatus?: string;
      deliveredAt?: Date | null;
    } = { amountPaid, balance };
    if (newStatus) data.status = newStatus;
    if (newDelivery) {
      data.deliveryStatus = newDelivery;
      data.deliveredAt = newDelivery === "DELIVERED" ? new Date() : null;
    }

    const updated = await prisma.order.update({
      where: { id: params.id },
      data,
      include: {
        items: { include: { product: true } },
        user: { select: { name: true, email: true } },
      },
    });

    return NextResponse.json({ success: true, data: serializeOrder(updated) });
  } catch (error) {
    console.error("Error updating order status:", error);
    return NextResponse.json(
      { error: "Failed to update order" },
      { status: 500 }
    );
  }
}

// DELETE /api/orders/[id] — delete order (admin only)
export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const order = await prisma.order.findUnique({ where: { id: params.id } });
    if (!order) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const amountPaid = Number(order.amountPaid ?? 0);
    const delivered = order.deliveryStatus === "DELIVERED" || order.deliveryStatus === "PARTIALLY_DELIVERED";
    if (amountPaid > 0 || delivered) {
      return NextResponse.json({ error: "Only undelivered, unpaid orders can be deleted" }, { status: 400 });
    }

    await prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({ where: { orderId: params.id }, data: { orderId: null } });
      await tx.orderItem.deleteMany({ where: { orderId: params.id } });
      await tx.order.delete({ where: { id: params.id } });
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting order:", error);
    return NextResponse.json(
      { error: "Failed to delete order" },
      { status: 500 }
    );
  }
}
