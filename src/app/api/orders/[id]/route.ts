import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notifyOrderEvent } from "@/lib/notifications";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;
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
    deliveredQuantity?: number;
    returnedQuantity?: number;
    product: { id: string; name: string; imageUrl: string | null } | null;
  }>;
  payments: Array<{
    id: string;
    amount: unknown;
    note: string | null;
    status: string;
    createdAt: Date;
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
    items: (o.items || []).map((i: OrderWithRelations["items"][number]) => {
      const deliveredQuantity = Number(
        (i as { deliveredQuantity?: unknown }).deliveredQuantity ?? 0,
      );
      const returnedQuantity = Number(
        (i as { returnedQuantity?: unknown }).returnedQuantity ?? 0,
      );
      return {
        id: i.id,
        quantity: i.quantity,
        price: Number(i.price),
        deliveredQuantity,
        returnedQuantity,
        product: i.product
          ? {
              id: i.product.id,
              name: i.product.name,
              imageUrl: i.product.imageUrl,
            }
          : null,
      };
    }),
    payments: (o.payments || []).map(
      (p: OrderWithRelations["payments"][number]) => ({
        id: p.id,
        amount: Number(p.amount ?? 0),
        note: p.note || null,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
      }),
    ),
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
      include: {
        items: {
          include: { product: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
        user: { select: { name: true, email: true } },
        payments: true,
      },
    });

    if (!order) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Also load any legacy AUTO_APPLY credit adjustment payments for this user
    // that are not tied to a single orderId, so receipts can show applied credit.
    let merged = order as unknown as OrderWithRelations;
    if (order.userId) {
      const autoApplyPayments = await prisma.payment.findMany({
        where: {
          userId: order.userId,
          orderId: null,
          note: {
            contains: "\"reference\":\"AUTO_APPLY\"",
          },
        },
      });
      if (autoApplyPayments.length > 0) {
        const existing = (order.payments || []).reduce(
          (map, p) => map.set(p.id, p),
          new Map<string, (typeof order.payments)[number]>(),
        );
        for (const p of autoApplyPayments) {
          if (existing.has(p.id)) continue;
          if (!p.note) continue;
          try {
            const meta = JSON.parse(p.note) as {
              applied?: Array<{ orderId?: string }>;
            };
            const appliesToOrder = Array.isArray(meta.applied)
              ? meta.applied.some((a) => a?.orderId === order.id)
              : false;
            if (appliesToOrder) existing.set(p.id, p);
          } catch {
            // ignore malformed notes
          }
        }
        merged = {
          ...(order as unknown as OrderWithRelations),
          payments: Array.from(existing.values()),
        };
      }
    }

    return NextResponse.json({ data: serializeOrder(merged) });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch order";
    console.error("Error fetching order:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch order",
        details: process.env.NODE_ENV === "production" ? undefined : message,
      },
      { status: 500 }
    );
  }
}

const updateSchema = z.object({
  status: z
    .enum(["UNPAID", "PARTIALLY_PAID", "PAID", "PENDING_PAYMENT", "CANCELLED"])
    .or(z.string().min(1))
    .optional(),
  deliveryStatus: z
    .enum(["NOT_DELIVERED", "PARTIALLY_DELIVERED", "DELIVERED", "RETURNED"])
    .optional(),
  // When cancelling a RETURNED order, optionally restock items into inventory.
  restockReturned: z.boolean().optional(),
  cancelReason: z.string().min(5).max(200).optional(),
});

// PATCH /api/orders/[id] — update status (admin only)
export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as AuthenticatedUser;
  const role = user.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!isAdmin && !isStaff)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const params = await context.params;
    const orderId = params.id;

    const body = await req.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success || (!parsed.data.status && !parsed.data.deliveryStatus)) {
      return NextResponse.json({ error: "Invalid update payload" }, { status: 400 });
    }

    // Staff can only update delivery status, not financial/order status.
    if (!isAdmin && parsed.data.status) {
      return NextResponse.json(
        { error: "Only admins can change payment status." },
        { status: 403 },
      );
    }

    const current = await prisma.order.findUnique({ where: { id: orderId } });
    if (!current) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const newStatus = parsed.data.status;
    const newDelivery = parsed.data.deliveryStatus;
    const restockReturned = parsed.data.restockReturned === true;
    const cancelReason = parsed.data.cancelReason?.trim();
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
        if (!cancelReason) {
          return NextResponse.json(
            { error: "Please provide a brief cancellation reason." },
            { status: 400 },
          );
        }
        // Prevent cancelling a delivered order unless it has been marked as RETURNED
        const currentDelivery = current.deliveryStatus || "NOT_DELIVERED";
        if (
          currentDelivery === "DELIVERED" ||
          currentDelivery === "PARTIALLY_DELIVERED"
        ) {
          return NextResponse.json(
            {
              error:
                "Change delivery status to RETURNED before cancelling a delivered order.",
            },
            { status: 400 },
          );
        }
        // Leave financials as-is; cancelled orders are excluded from outstanding banners
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

    const updated = await prisma.$transaction(async (tx: TxClient) => {
      // If cancelling an order, optionally restock items into inventory.
      // - For RETURNED orders, this happens only when restockReturned = true.
      // - For NOT_DELIVERED orders, always restock so that stock is restored
      //   when a sale that never delivered is cancelled.
      if (newStatus === "CANCELLED" && (restockReturned || current.deliveryStatus === "NOT_DELIVERED")) {
        const before = await tx.order.findUnique({
          where: { id: orderId },
          include: { items: true },
        });
        if (!before) throw new Error("Order not found for restock");

        if (restockReturned) {
          if (before.deliveryStatus !== "RETURNED") {
            throw new Error(
              "Can only restock items for orders marked as RETURNED.",
            );
          }
        } else {
          // Auto-restock only for orders that were never delivered.
          if (before.deliveryStatus !== "NOT_DELIVERED") {
            throw new Error(
              "Auto-restock is only allowed for NOT_DELIVERED orders.",
            );
          }
        }

        for (const it of before.items) {
          if (!it.productId || !it.quantity) continue;
          await tx.product.update({
            where: { id: it.productId },
            data: { stock: { increment: it.quantity } },
          });
          await tx.inventoryMovement.create({
            data: {
              productId: it.productId,
              delta: it.quantity,
              reason: "RETURN",
            },
          });
        }
      }

      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data,
      include: {
        items: {
          include: { product: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
        user: { select: { name: true, email: true } },
        payments: true,
      },
      });

      // If the overall delivery status is being set to DELIVERED, mark all
      // line items as fully delivered as well so per-item delivery stays
      // consistent with the order-level status.
      if (newDelivery === "DELIVERED") {
        const items = await tx.orderItem.findMany({
          where: { orderId },
          select: { id: true, quantity: true },
        });
        for (const it of items) {
          await tx.orderItem.update({
            where: { id: it.id },
            data: { deliveredQuantity: it.quantity },
          });
        }
      } else if (newDelivery === "RETURNED") {
        // If the overall delivery status is RETURNED, mark all line items as
        // fully returned so item-level summaries reflect a full return of the
        // order.
        const items = await tx.orderItem.findMany({
          where: { orderId },
          select: { id: true, quantity: true },
        });
        for (const it of items) {
          await tx.orderItem.update({
            where: { id: it.id },
            data: { returnedQuantity: it.quantity },
          });
        }
      }

      return updatedOrder;
    });

    // Fire-and-forget customer notifications for key events
    try {
      const userId = current.userId || undefined;
      if (userId) {
        if (newStatus === "CANCELLED") {
          await notifyOrderEvent({
            kind: "order_cancelled",
            userId,
            orderId: updated.id,
            total,
            amountPaid,
          });
        }
        if (
          newDelivery &&
          (newDelivery === "DELIVERED" ||
            newDelivery === "PARTIALLY_DELIVERED" ||
            newDelivery === "RETURNED")
        ) {
          await notifyOrderEvent({
            kind: "order_delivery_updated",
            userId,
            orderId: updated.id,
            deliveryStatus: newDelivery,
          });
        }
      }
    } catch (e) {
      console.warn("notifyOrderEvent error:", e);
    }

    // Audit log for status/delivery changes
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "ORDER_UPDATE",
        entityType: "ORDER",
        entityId: updated.id,
        meta: {
          previousStatus: current.status,
          newStatus,
          previousDeliveryStatus: current.deliveryStatus || "NOT_DELIVERED",
          newDeliveryStatus: parsed.data.deliveryStatus || current.deliveryStatus || "NOT_DELIVERED",
          restockReturned,
          cancelReason: cancelReason || null,
        },
      });
      if (newStatus === "CANCELLED") {
        await recordAuditLog({
          actorId: user.id,
          action: "ORDER_CANCEL",
          entityType: "ORDER",
          entityId: updated.id,
          meta: {
            previousStatus: current.status,
            newStatus,
            previousDeliveryStatus: current.deliveryStatus || "NOT_DELIVERED",
            newDeliveryStatus: parsed.data.deliveryStatus || current.deliveryStatus || "NOT_DELIVERED",
            restockReturned,
            reason: cancelReason || null,
          },
        });
      }
    } catch {
      // audit logging is best-effort
    }

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
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const params = await context.params;
    const orderId = params.id;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const amountPaid = Number(order.amountPaid ?? 0);
    const delivered = order.deliveryStatus === "DELIVERED" || order.deliveryStatus === "PARTIALLY_DELIVERED";
    if (amountPaid > 0 || delivered) {
      return NextResponse.json({ error: "Only undelivered, unpaid orders can be deleted" }, { status: 400 });
    }

    await prisma.$transaction(async (tx: TxClient) => {
      await tx.payment.updateMany({ where: { orderId }, data: { orderId: null } });
      await tx.orderItem.deleteMany({ where: { orderId } });
      await tx.order.delete({ where: { id: orderId } });
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "ORDER_DELETE",
        entityType: "ORDER",
        entityId: orderId,
        meta: {
          amountPaid,
          deliveryStatus: order.deliveryStatus,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting order:", error);
    return NextResponse.json(
      { error: "Failed to delete order" },
      { status: 500 }
    );
  }
}
