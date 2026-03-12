import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { randomUUID } from "crypto";

const schema = z.object({
  riderName: z.string().min(2).max(80),
  riderPhone: z.string().max(30).optional(),
  note: z.string().max(200).optional(),
  riderUserId: z.string().min(1).optional(),
  assignmentMode: z.enum(["FULL", "PARTIAL"]).optional(),
  assignedItems: z
    .array(
      z.object({
        itemId: z.string().min(1),
        quantity: z.number().int().nonnegative(),
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
  const limited = await rateLimit(req, "admin-delivery-assign", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const params = await context.params;
  const orderId = params.id;
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      deletedAt: true,
      status: true,
      deliveryStatus: true,
      items: {
        select: {
          id: true,
          quantity: true,
          deliveredQuantity: true,
          product: { select: { name: true } },
        },
      },
    },
  });
  if (!order || order.deletedAt) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  if (String(order.status || "").toUpperCase() === "CANCELLED") {
    return NextResponse.json({ error: "Cancelled orders cannot be assigned" }, { status: 400 });
  }

  const [latestReturnPending, latestReturnConfirmed, latestUnassign, latestAssign] = await Promise.all([
    prisma.auditLog.findFirst({
      where: { entityType: "ORDER", entityId: order.id, action: "ORDER_DELIVERY_RETURN_PENDING" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.auditLog.findFirst({
      where: { entityType: "ORDER", entityId: order.id, action: "ORDER_DELIVERY_RETURN_CONFIRMED" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.auditLog.findFirst({
      where: { entityType: "ORDER", entityId: order.id, action: "ORDER_DELIVERY_UNASSIGN" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.auditLog.findFirst({
      where: { entityType: "ORDER", entityId: order.id, action: "ORDER_DELIVERY_ASSIGN" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  const returnPendingActive =
    Boolean(latestReturnPending?.createdAt) &&
    (!latestAssign || latestReturnPending!.createdAt >= latestAssign.createdAt) &&
    (!latestReturnConfirmed || latestReturnConfirmed.createdAt < latestReturnPending!.createdAt) &&
    (!latestUnassign || latestUnassign.createdAt < latestReturnPending!.createdAt);
  if (returnPendingActive) {
    return NextResponse.json(
      { error: "Dispatcher handover is pending. Confirm return received before reassigning." },
      { status: 409 },
    );
  }

  const remainingByItem = new Map(
    (order.items || []).map((item) => [
      item.id,
      Math.max(0, Number(item.quantity || 0) - Number(item.deliveredQuantity || 0)),
    ]),
  );
  const hasRemaining = Array.from(remainingByItem.values()).some((v) => v > 0);
  if (!hasRemaining) {
    return NextResponse.json({ error: "All order items are already fully delivered." }, { status: 409 });
  }

  const assignmentMode = parsed.data.assignmentMode || "FULL";
  let assignedItems: Array<{
    itemId: string;
    productName: string;
    assignedQty: number;
    remainingQtyAtAssign: number;
  }> = [];
  if (assignmentMode === "FULL") {
    assignedItems = (order.items || [])
      .map((item) => {
        const remaining = remainingByItem.get(item.id) || 0;
        return {
          itemId: item.id,
          productName: item.product?.name || "Item",
          assignedQty: remaining,
          remainingQtyAtAssign: remaining,
        };
      })
      .filter((row) => row.assignedQty > 0);
  } else {
    const requested = parsed.data.assignedItems || [];
    if (!requested.length) {
      return NextResponse.json(
        { error: "Partial assignment requires item-level quantities." },
        { status: 400 },
      );
    }
    const next: typeof assignedItems = [];
    for (const row of requested) {
      const remaining = remainingByItem.get(row.itemId);
      if (remaining === undefined) {
        return NextResponse.json({ error: "Invalid order item in assignment payload." }, { status: 400 });
      }
      if (row.quantity > remaining) {
        return NextResponse.json(
          { error: "Assigned quantity cannot exceed remaining undelivered quantity." },
          { status: 400 },
        );
      }
      if (row.quantity <= 0) continue;
      const item = (order.items || []).find((it) => it.id === row.itemId);
      next.push({
        itemId: row.itemId,
        productName: item?.product?.name || "Item",
        assignedQty: row.quantity,
        remainingQtyAtAssign: remaining,
      });
    }
    if (!next.length) {
      return NextResponse.json(
        { error: "Partial assignment must include at least one item quantity greater than zero." },
        { status: 400 },
      );
    }
    assignedItems = next;
  }

  const meta = {
    assignmentId: randomUUID(),
    assignmentMode,
    assignedItems,
    riderUserId: null as string | null,
    riderName: parsed.data.riderName.trim(),
    riderPhone: String(parsed.data.riderPhone || "").trim() || null,
    note: String(parsed.data.note || "").trim() || null,
    assignedAt: new Date().toISOString(),
  };

  if (parsed.data.riderUserId) {
    meta.riderUserId = parsed.data.riderUserId;
  } else {
    // Best-effort auto-link: if rider details match an active dispatcher account.
    const byPhone = meta.riderPhone
      ? await prisma.user.findUnique({
          where: { phone: meta.riderPhone },
          select: { id: true, role: true, archived: true },
        })
      : null;
    if (byPhone && !byPhone.archived && String(byPhone.role) === "DISPATCHER") {
      meta.riderUserId = byPhone.id;
    } else {
      try {
        const byName = await prisma.user.findFirst({
          where: {
            role: "DISPATCHER",
            archived: false,
            name: { equals: meta.riderName, mode: "insensitive" },
          },
          select: { id: true },
        });
        if (byName) meta.riderUserId = byName.id;
      } catch {
        // If DISPATCHER role is not yet migrated in DB, continue without riderUserId link.
      }
    }
  }

  await recordAuditLog({
    actorId: user?.id,
    action: "ORDER_DELIVERY_ASSIGN",
    entityType: "ORDER",
    entityId: order.id,
    meta,
  });

  return NextResponse.json({ ok: true, assignment: meta });
}
