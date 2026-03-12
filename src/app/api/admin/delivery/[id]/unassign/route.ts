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
  reason: z.string().max(200).optional(),
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
  const limited = await rateLimit(req, "admin-delivery-unassign", 60_000, 60);
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
    return NextResponse.json({ error: "Delivered orders cannot be unassigned." }, { status: 409 });
  }

  const latestAssign = await prisma.auditLog.findFirst({
    where: { entityType: "ORDER", entityId: order.id, action: "ORDER_DELIVERY_ASSIGN" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, meta: true },
  });
  if (!latestAssign) {
    return NextResponse.json({ error: "No active assignment found." }, { status: 409 });
  }
  const latestUnassign = await prisma.auditLog.findFirst({
    where: { entityType: "ORDER", entityId: order.id, action: "ORDER_DELIVERY_UNASSIGN" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (latestUnassign && latestUnassign.createdAt >= latestAssign.createdAt) {
    return NextResponse.json({ error: "Order is already unassigned." }, { status: 409 });
  }
  const [latestReturnPending, latestReturnConfirmed] = await Promise.all([
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
  ]);
  const returnPendingActive =
    Boolean(latestReturnPending?.createdAt) &&
    latestReturnPending!.createdAt >= latestAssign.createdAt &&
    (!latestReturnConfirmed || latestReturnConfirmed.createdAt < latestReturnPending!.createdAt) &&
    (!latestUnassign || latestUnassign.createdAt < latestReturnPending!.createdAt);
  if (returnPendingActive) {
    return NextResponse.json(
      { error: "Dispatcher return handover is pending. Confirm return received before unassigning." },
      { status: 409 },
    );
  }

  const assignMeta = parseMeta(latestAssign.meta);
  const reason = String(parsed.data.reason || "").trim() || null;

  await recordAuditLog({
    actorId: user?.id,
    action: "ORDER_DELIVERY_UNASSIGN",
    entityType: "ORDER",
    entityId: order.id,
    meta: {
      reason,
      previous: {
        riderUserId: String(assignMeta?.riderUserId || "") || null,
        riderName: String(assignMeta?.riderName || "") || null,
        riderPhone: String(assignMeta?.riderPhone || "") || null,
        assignmentId: String(assignMeta?.assignmentId || "") || null,
      },
      unassignedAt: new Date().toISOString(),
    },
  });

  return NextResponse.json({ ok: true });
}
