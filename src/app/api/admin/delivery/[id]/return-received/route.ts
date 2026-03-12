import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

function parseMeta(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const schema = z.object({
  note: z.string().max(240).optional(),
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
  const limited = await rateLimit(req, "admin-delivery-return-received", 60_000, 60);
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
    select: { id: true, deletedAt: true, status: true, deliveryStatus: true },
  });
  if (!order || order.deletedAt) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  if (String(order.status || "").toUpperCase() === "CANCELLED") {
    return NextResponse.json({ error: "Cancelled orders cannot be changed" }, { status: 400 });
  }
  if (String(order.deliveryStatus || "").toUpperCase() === "DELIVERED") {
    return NextResponse.json({ error: "Delivered orders do not require return handover." }, { status: 409 });
  }

  const [latestAssign, latestUnassign, latestReturnPending, latestReturnConfirmed] = await Promise.all([
    prisma.auditLog.findFirst({
      where: { entityType: "ORDER", entityId: order.id, action: "ORDER_DELIVERY_ASSIGN" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, meta: true },
    }),
    prisma.auditLog.findFirst({
      where: { entityType: "ORDER", entityId: order.id, action: "ORDER_DELIVERY_UNASSIGN" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.auditLog.findFirst({
      where: { entityType: "ORDER", entityId: order.id, action: "ORDER_DELIVERY_RETURN_PENDING" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, meta: true },
    }),
    prisma.auditLog.findFirst({
      where: { entityType: "ORDER", entityId: order.id, action: "ORDER_DELIVERY_RETURN_CONFIRMED" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);
  if (!latestAssign) {
    return NextResponse.json({ error: "No active assignment found." }, { status: 409 });
  }
  if (latestUnassign && latestUnassign.createdAt >= latestAssign.createdAt) {
    return NextResponse.json({ error: "Order is already unassigned." }, { status: 409 });
  }
  if (!latestReturnPending || latestReturnPending.createdAt < latestAssign.createdAt) {
    return NextResponse.json({ error: "No dispatcher return pending handover found." }, { status: 409 });
  }
  if (latestReturnConfirmed && latestReturnConfirmed.createdAt >= latestReturnPending.createdAt) {
    return NextResponse.json({ error: "Return handover already confirmed." }, { status: 409 });
  }

  const assignMeta = parseMeta(latestAssign.meta);
  const returnMeta = parseMeta(latestReturnPending.meta);
  const note = String(parsed.data.note || "").trim() || null;
  const receivedAt = new Date().toISOString();

  await recordAuditLog({
    actorId: user?.id,
    action: "ORDER_DELIVERY_RETURN_CONFIRMED",
    entityType: "ORDER",
    entityId: order.id,
    meta: {
      assignmentId: String(returnMeta?.assignmentId || assignMeta?.assignmentId || "") || null,
      riderUserId: String(returnMeta?.riderUserId || assignMeta?.riderUserId || "") || null,
      riderName: String(returnMeta?.riderName || assignMeta?.riderName || "") || null,
      riderPhone: String(returnMeta?.riderPhone || assignMeta?.riderPhone || "") || null,
      note,
      receivedAt,
    },
  });

  await recordAuditLog({
    actorId: user?.id,
    action: "ORDER_DELIVERY_UNASSIGN",
    entityType: "ORDER",
    entityId: order.id,
    meta: {
      reason: "Dispatcher return handover confirmed",
      previous: {
        riderUserId: String(assignMeta?.riderUserId || "") || null,
        riderName: String(assignMeta?.riderName || "") || null,
        riderPhone: String(assignMeta?.riderPhone || "") || null,
        assignmentId: String(assignMeta?.assignmentId || "") || null,
      },
      unassignedAt: receivedAt,
      source: "admin-return-received",
    },
  });

  return NextResponse.json({ ok: true });
}

