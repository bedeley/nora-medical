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
  orderIds: z.array(z.string().min(1)).min(1).max(200),
  riderName: z.string().min(2).max(80),
  riderPhone: z.string().max(30).optional(),
  note: z.string().max(200).optional(),
  riderUserId: z.string().min(1).optional(),
  assignmentMode: z.enum(["FULL", "PARTIAL"]).optional(),
  partialPercent: z.number().int().min(1).max(99).optional(),
  perOrderAssignments: z
    .array(
      z.object({
        orderId: z.string().min(1),
        assignmentMode: z.enum(["FULL", "PARTIAL"]).default("FULL"),
        assignedItems: z
          .array(
            z.object({
              itemId: z.string().min(1),
              quantity: z.number().int().min(0),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export async function POST(req: Request) {
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
  const limited = await rateLimit(req, "admin-delivery-bulk-assign", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const orderIds = Array.from(new Set(parsed.data.orderIds));
  const riderName = parsed.data.riderName.trim();
  const riderPhone = String(parsed.data.riderPhone || "").trim() || null;
  const note = String(parsed.data.note || "").trim() || null;
  const assignmentMode = parsed.data.assignmentMode || "FULL";
  const partialPercent = parsed.data.partialPercent ?? 50;
  const perOrderAssignments = new Map(
    (parsed.data.perOrderAssignments || []).map((row) => [row.orderId, row]),
  );

  let riderUserId: string | null = parsed.data.riderUserId || null;
  if (!riderUserId) {
    const byPhone = riderPhone
      ? await prisma.user.findUnique({
          where: { phone: riderPhone },
          select: { id: true, role: true, archived: true },
        })
      : null;
    if (byPhone && !byPhone.archived && String(byPhone.role) === "DISPATCHER") {
      riderUserId = byPhone.id;
    } else {
      try {
        const byName = await prisma.user.findFirst({
          where: {
            role: "DISPATCHER",
            archived: false,
            name: { equals: riderName, mode: "insensitive" },
          },
          select: { id: true },
        });
        if (byName) riderUserId = byName.id;
      } catch {
        // ignore role lookup if DB enum is not migrated yet
      }
    }
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: {
      id: true,
      deletedAt: true,
      status: true,
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
  const orderMap = new Map(orders.map((o) => [o.id, o]));

  let assigned = 0;
  let skipped = 0;
  const errors: Array<{ id: string; reason: string }> = [];

  for (const orderId of orderIds) {
    const order = orderMap.get(orderId);
    if (!order || order.deletedAt) {
      skipped += 1;
      errors.push({ id: orderId, reason: "Order not found" });
      continue;
    }
    if (String(order.status || "").toUpperCase() === "CANCELLED") {
      skipped += 1;
      errors.push({ id: orderId, reason: "Cancelled order" });
      continue;
    }

    const assignedItems = (order.items || [])
      .map((item) => {
        const remaining = Math.max(0, Number(item.quantity || 0) - Number(item.deliveredQuantity || 0));
        if (remaining <= 0) return null;
        const override = perOrderAssignments.get(order.id);
        const effectiveMode = override?.assignmentMode || assignmentMode;
        let assignedQty = 0;
        if (effectiveMode === "FULL") {
          assignedQty = remaining;
        } else if (override?.assignedItems?.length) {
          const found = override.assignedItems.find((x) => x.itemId === item.id);
          const requested = Number(found?.quantity || 0);
          assignedQty = Math.max(0, Math.min(remaining, Number.isFinite(requested) ? Math.floor(requested) : 0));
        } else {
          assignedQty = Math.max(1, Math.min(remaining, Math.floor((remaining * partialPercent) / 100)));
        }
        if (assignedQty <= 0) return null;
        return {
          itemId: item.id,
          productName: item.product?.name || "Item",
          assignedQty,
          remainingQtyAtAssign: remaining,
        };
      })
      .filter(Boolean) as Array<{
      itemId: string;
      productName: string;
      assignedQty: number;
      remainingQtyAtAssign: number;
    }>;
    if (!assignedItems.length) {
      skipped += 1;
      errors.push({ id: orderId, reason: "No remaining undelivered items to assign" });
      continue;
    }

    const override = perOrderAssignments.get(order.id);
    const effectiveMode = override?.assignmentMode || assignmentMode;
    const meta = {
      assignmentId: randomUUID(),
      assignmentMode: effectiveMode,
      partialPercent: effectiveMode === "PARTIAL" ? partialPercent : null,
      assignedItems,
      riderUserId,
      riderName,
      riderPhone,
      note,
      assignedAt: new Date().toISOString(),
      bulk: true,
    };
    await recordAuditLog({
      actorId: user?.id,
      action: "ORDER_DELIVERY_ASSIGN",
      entityType: "ORDER",
      entityId: order.id,
      meta,
    });
    assigned += 1;
  }

  return NextResponse.json({
    ok: true,
    assigned,
    skipped,
    errors: errors.slice(0, 20),
  });
}
