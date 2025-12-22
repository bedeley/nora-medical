import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { notifyOrderEvent } from "@/lib/notifications";
import { z } from "zod";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

const schema = z.object({
  itemId: z.string().min(1),
  mode: z.enum(["delivered", "partial", "reset"]),
  quantity: z.number().int().nonnegative().optional(),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-order-item-delivery", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const params = await context.params;
  const orderId = params.id;

  try {
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }
    const { itemId, mode } = parsed.data;
    const qty = parsed.data.quantity;

    const result = await prisma.$transaction(async (tx: TxClient) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (!order) {
        throw new Error("Order not found");
      }
      const item = order.items.find((it) => it.id === itemId);
      if (!item) {
        throw new Error("Order item not found");
      }

      const totalQty = item.quantity;
      const previousDeliveredQuantity = item.deliveredQuantity ?? 0;
      let deliveredQuantity = previousDeliveredQuantity;

      if (mode === "reset") {
        deliveredQuantity = 0;
      } else if (mode === "delivered") {
        deliveredQuantity = totalQty;
      } else {
        const requested = typeof qty === "number" ? qty : 0;
        if (!Number.isInteger(requested) || requested < 0) {
          throw new Error("Invalid delivered quantity");
        }
        const remaining = Math.max(0, totalQty - deliveredQuantity);
        if (requested > remaining) {
          throw new Error("Delivered quantity cannot exceed remaining quantity");
        }
        deliveredQuantity += requested;
      }

      const updatedItem = await tx.orderItem.update({
        where: { id: item.id },
        data: { deliveredQuantity },
      });

      // Recompute overall order deliveryStatus from items, unless it's explicitly RETURNED
      const previousStatus = (order.deliveryStatus || "NOT_DELIVERED") as string;
      let newStatus = previousStatus;
      let deliveredAt = order.deliveredAt ?? null;

      if (previousStatus !== "RETURNED") {
        const itemsAfter = await tx.orderItem.findMany({
          where: { orderId: order.id },
          select: { quantity: true, deliveredQuantity: true },
        });
        const allDelivered = itemsAfter.every(
          (it) => (it.deliveredQuantity ?? 0) >= it.quantity,
        );
        const anyDelivered = itemsAfter.some(
          (it) => (it.deliveredQuantity ?? 0) > 0,
        );

        if (allDelivered) {
          newStatus = "DELIVERED";
          deliveredAt = deliveredAt || new Date();
        } else if (anyDelivered) {
          newStatus = "PARTIALLY_DELIVERED";
          deliveredAt = null;
        } else {
          newStatus = "NOT_DELIVERED";
          deliveredAt = null;
        }

        if (newStatus !== previousStatus || deliveredAt !== order.deliveredAt) {
          await tx.order.update({
            where: { id: order.id },
            data: {
              deliveryStatus: newStatus,
              deliveredAt,
            },
          });
        }
      }

      return {
        orderId: order.id,
        userId: order.userId,
        item: updatedItem,
        previousStatus,
        newStatus,
        deliveryChanged: deliveredQuantity !== previousDeliveredQuantity,
      };
    });

    try {
      await recordAuditLog({
        actorId: user?.id,
        action: "ORDER_ITEM_DELIVERY_UPDATE",
        entityType: "ORDER",
        entityId: result.orderId,
        meta: {
          itemId: parsed.data.itemId,
          mode: parsed.data.mode,
          quantity: parsed.data.quantity ?? null,
        },
      });
    } catch {
      // best-effort
    }

    // Notify customer if delivery status or delivered quantity changed
    try {
      if (result.userId && (result.deliveryChanged || result.newStatus !== result.previousStatus)) {
        const order = await prisma.order.findUnique({
          where: { id: result.orderId },
          select: { deliveryStatus: true },
        });
        const status = String(order?.deliveryStatus || result.newStatus || "").toUpperCase();
        if (status === "DELIVERED" || status === "PARTIALLY_DELIVERED" || status === "RETURNED") {
          await notifyOrderEvent({
            kind: "order_delivery_updated",
            userId: result.userId,
            orderId: result.orderId,
            deliveryStatus: status as
              | "DELIVERED"
              | "PARTIALLY_DELIVERED"
              | "RETURNED",
          });
        }
      }
    } catch (e) {
      console.warn("notifyOrderEvent (item delivery) error:", e);
    }

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "Failed to update item delivery";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
