import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { notifyOrderEvent } from "@/lib/notifications";

function parseMeta(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const statusSchema = z.object({
  status: z.enum([
    "PENDING",
    "ASSIGNED",
    "OUT_FOR_DELIVERY",
    "FAILED_ATTEMPT",
    "RESCHEDULED",
    "PARTIALLY_DELIVERED",
    "DELIVERED",
  ]),
  reason: z
    .enum(["NO_ANSWER", "WRONG_LOCATION", "CUSTOMER_NOT_AVAILABLE", "WEATHER", "OTHER"])
    .optional(),
  note: z.string().max(240).optional(),
  scheduledAt: z.string().datetime().optional(),
  recipientName: z.string().max(120).optional(),
  recipientPhone: z.string().max(30).optional(),
  deliveryNote: z.string().max(240).optional(),
  proofImageUrl: z
    .string()
    .max(500)
    .optional()
    .refine(
      (val) => {
        if (!val) return true;
        if (val.startsWith("/uploads/")) return true;
        try {
          const u = new URL(val);
          return u.protocol === "https:" || u.protocol === "http:";
        } catch {
          return false;
        }
      },
      { message: "Invalid proof image URL" },
    ),
  podRequired: z.boolean().optional(),
  itemDeliveries: z
    .array(
      z.object({
        itemId: z.string().min(1),
        deliveredQuantity: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-delivery-status", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const params = await context.params;
  const orderId = params.id;
  const parsed = statusSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const payload = parsed.data;
  if (payload.status === "FAILED_ATTEMPT" && !payload.reason) {
    return NextResponse.json({ error: "reason is required for failed attempts" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      deletedAt: true,
      status: true,
      deliveryStatus: true,
      deliveredAt: true,
    },
  });
  if (!order || order.deletedAt) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  if (String(order.status || "").toUpperCase() === "CANCELLED") {
    return NextResponse.json({ error: "Cancelled orders cannot be updated" }, { status: 400 });
  }

  if (
    payload.status !== "DELIVERED" &&
    payload.status !== "PARTIALLY_DELIVERED" &&
    String(order.deliveryStatus || "").toUpperCase() === "DELIVERED"
  ) {
    return NextResponse.json(
      { error: "Order already marked delivered. Use returns flow for post-delivery issues." },
      { status: 409 },
    );
  }

  let finalDeliveryStatus: "NOT_DELIVERED" | "PARTIALLY_DELIVERED" | "DELIVERED" = "NOT_DELIVERED";
  let fulfilledAssignmentMeta:
    | {
        assignmentId: string;
        assignmentMode: string;
        deliveredItems: Array<{ itemId: string; deliveredQty: number }>;
      }
    | null = null;
  if (payload.status === "DELIVERED") {
    const latestAssignment = await prisma.auditLog.findFirst({
      where: {
        entityType: "ORDER",
        entityId: order.id,
        action: "ORDER_DELIVERY_ASSIGN",
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, meta: true },
    });
    const assignmentMeta = parseMeta(latestAssignment?.meta);
    const assignmentId = String(assignmentMeta?.assignmentId || "");
    const assignedItems = Array.isArray(assignmentMeta?.assignedItems)
      ? (assignmentMeta?.assignedItems as Array<Record<string, unknown>>)
      : [];
    if (assignmentId) {
      const alreadyFulfilled = await prisma.auditLog.findFirst({
        where: {
          entityType: "ORDER",
          entityId: order.id,
          action: "ORDER_DELIVERY_ASSIGN_FULFILLED",
          meta: { contains: assignmentId },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (alreadyFulfilled && latestAssignment && alreadyFulfilled.createdAt >= latestAssignment.createdAt) {
        return NextResponse.json(
          { error: "Latest assignment is already marked delivered. Create a new assignment for another trip." },
          { status: 409 },
        );
      }
    }
    if (assignedItems.length) {
      const txResult = await prisma.$transaction(async (tx) => {
        const items = await tx.orderItem.findMany({
          where: { orderId: order.id },
          select: { id: true, quantity: true, deliveredQuantity: true },
        });
        const byId = new Map(items.map((it) => [it.id, it]));
        const deliveredItems: Array<{ itemId: string; deliveredQty: number }> = [];
        for (const row of assignedItems) {
          const itemId = String(row.itemId || "");
          const assignedQty = Math.max(0, Math.floor(Number(row.assignedQty || 0)));
          if (!itemId || assignedQty <= 0) continue;
          const item = byId.get(itemId);
          if (!item) continue;
          const currentDelivered = Math.max(0, Number(item.deliveredQuantity || 0));
          const nextDelivered = Math.min(Number(item.quantity || 0), currentDelivered + assignedQty);
          await tx.orderItem.update({
            where: { id: item.id },
            data: { deliveredQuantity: nextDelivered },
          });
          deliveredItems.push({ itemId: item.id, deliveredQty: Math.max(0, nextDelivered - currentDelivered) });
        }
        const after = await tx.orderItem.findMany({
          where: { orderId: order.id },
          select: { quantity: true, deliveredQuantity: true },
        });
        const allDelivered = after.every((it) => (it.deliveredQuantity ?? 0) >= it.quantity);
        const anyDelivered = after.some((it) => (it.deliveredQuantity ?? 0) > 0);
        const nextStatus: "DELIVERED" | "PARTIALLY_DELIVERED" | "NOT_DELIVERED" = allDelivered
          ? "DELIVERED"
          : anyDelivered
          ? "PARTIALLY_DELIVERED"
          : "NOT_DELIVERED";
        await tx.order.update({
          where: { id: order.id },
          data: {
            deliveryStatus: nextStatus,
            deliveredAt: nextStatus === "DELIVERED" ? order.deliveredAt || new Date() : null,
          },
        });
        return {
          nextStatus,
          fulfilledAssignmentMeta: assignmentId
            ? {
                assignmentId,
                assignmentMode: String(assignmentMeta?.assignmentMode || ""),
                deliveredItems,
              }
            : null,
        };
      });
      finalDeliveryStatus = txResult.nextStatus;
      fulfilledAssignmentMeta = txResult.fulfilledAssignmentMeta;
    } else {
      await prisma.$transaction(async (tx) => {
        const items = await tx.orderItem.findMany({
          where: { orderId: order.id },
          select: { id: true, quantity: true },
        });
        for (const item of items) {
          await tx.orderItem.update({
            where: { id: item.id },
            data: { deliveredQuantity: item.quantity },
          });
        }
        await tx.order.update({
          where: { id: order.id },
          data: { deliveryStatus: "DELIVERED", deliveredAt: order.deliveredAt || new Date() },
        });
      });
      finalDeliveryStatus = "DELIVERED";
    }
  } else if (payload.status === "PARTIALLY_DELIVERED") {
    const itemDeliveries = payload.itemDeliveries || [];
    if (!itemDeliveries.length) {
      return NextResponse.json(
        { error: "Provide item-level delivered quantities for partial delivery." },
        { status: 400 },
      );
    }
    const itemsBefore = await prisma.orderItem.findMany({
      where: { orderId: order.id },
      select: { id: true, quantity: true },
    });
    const itemMapBefore = new Map(itemsBefore.map((it) => [it.id, it]));
    for (const row of itemDeliveries) {
      const item = itemMapBefore.get(row.itemId);
      if (!item) {
        return NextResponse.json({ error: "Invalid order item in partial delivery payload." }, { status: 400 });
      }
      if (row.deliveredQuantity > item.quantity) {
        return NextResponse.json({ error: "Delivered quantity cannot exceed ordered quantity." }, { status: 400 });
      }
    }
    await prisma.$transaction(async (tx) => {
      for (const row of itemDeliveries) {
        await tx.orderItem.update({
          where: { id: row.itemId },
          data: { deliveredQuantity: row.deliveredQuantity },
        });
      }
      const after = await tx.orderItem.findMany({
        where: { orderId: order.id },
        select: { quantity: true, deliveredQuantity: true },
      });
      const anyDelivered = after.some((it) => (it.deliveredQuantity ?? 0) > 0);
      // Keep dispatch partial updates explicitly partial.
      // Do not auto-promote to DELIVERED from this path.
      const nextStatus = anyDelivered ? "PARTIALLY_DELIVERED" : "NOT_DELIVERED";
      await tx.order.update({
        where: { id: order.id },
        data: {
          deliveryStatus: nextStatus,
          deliveredAt: null,
        },
      });
      finalDeliveryStatus = nextStatus;
    });
  } else if (
    payload.status === "PENDING" ||
    payload.status === "ASSIGNED" ||
    payload.status === "OUT_FOR_DELIVERY" ||
    payload.status === "FAILED_ATTEMPT" ||
    payload.status === "RESCHEDULED"
  ) {
    await prisma.order.update({
      where: { id: order.id },
      data: { deliveryStatus: "NOT_DELIVERED", deliveredAt: null },
    });
    finalDeliveryStatus = "NOT_DELIVERED";
  }

  const meta = {
    status: payload.status,
    reason: payload.reason || null,
    note: String(payload.note || "").trim() || null,
    scheduledAt: payload.scheduledAt || null,
    podRequired: Boolean(payload.podRequired),
    recipientName: payload.status === "DELIVERED" ? String(payload.recipientName || "").trim() || null : null,
    recipientPhone: payload.status === "DELIVERED" ? String(payload.recipientPhone || "").trim() || null : null,
    deliveryNote: payload.status === "DELIVERED" ? String(payload.deliveryNote || "").trim() || null : null,
    proofImageUrl: payload.status === "DELIVERED" ? String(payload.proofImageUrl || "").trim() || null : null,
    attemptAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await recordAuditLog({
    actorId: user?.id,
    action: "ORDER_DELIVERY_STATUS_UPDATE",
    entityType: "ORDER",
    entityId: order.id,
    meta,
  });
  if (fulfilledAssignmentMeta) {
    await recordAuditLog({
      actorId: user?.id,
      action: "ORDER_DELIVERY_ASSIGN_FULFILLED",
      entityType: "ORDER",
      entityId: order.id,
      meta: {
        assignmentId: fulfilledAssignmentMeta.assignmentId,
        assignmentMode: fulfilledAssignmentMeta.assignmentMode,
        deliveredItems: fulfilledAssignmentMeta.deliveredItems,
        fulfilledAt: new Date().toISOString(),
        source: "admin-dispatch",
      },
    });
  }

  try {
    if (order.userId && finalDeliveryStatus !== "NOT_DELIVERED") {
      await notifyOrderEvent({
        kind: "order_delivery_updated",
        userId: order.userId,
        orderId: order.id,
        deliveryStatus: finalDeliveryStatus,
      });
    }
  } catch (e) {
    console.warn("notifyOrderEvent (delivery status) error:", e);
  }

  return NextResponse.json({ ok: true, status: finalDeliveryStatus });
}
