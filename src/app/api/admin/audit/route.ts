import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const entityType = searchParams.get("entityType") || undefined;
  const entityId = searchParams.get("entityId") || undefined;
  const customerId = searchParams.get("customerId") || undefined;
  const action = searchParams.get("action") || undefined;
  const actorId = searchParams.get("actorId") || undefined;
  const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") || 100)));
  const start = searchParams.get("start") || undefined;
  const end = searchParams.get("end") || undefined;
  const format = searchParams.get("format") || "";

  const where: Prisma.AuditLogWhereInput = {};

  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (action) where.action = action;
  if (actorId === "system") {
    where.actorId = null;
  } else if (actorId) {
    where.actorId = actorId;
  }
  if (start || end) {
    where.createdAt = {};
    if (start) {
      const s = new Date(start);
      if (!Number.isNaN(s.getTime())) where.createdAt.gte = s;
    }
    if (end) {
      const e = new Date(end);
      if (!Number.isNaN(e.getTime())) {
        e.setHours(23, 59, 59, 999);
        where.createdAt.lte = e;
      }
    }
  }
  if (customerId) {
    const token = `"customerId":"${customerId}"`;
    const [orders, payments] = await Promise.all([
      prisma.order.findMany({
        where: { userId: customerId },
        select: { id: true },
      }),
      prisma.payment.findMany({
        where: { userId: customerId },
        select: { id: true },
      }),
    ]);
    const orderIds = orders.map((o) => o.id);
    const paymentIds = payments.map((p) => p.id);
    const or: Prisma.AuditLogWhereInput[] = [
      { entityType: "USER", entityId: customerId },
      { entityType: "CUSTOMER", entityId: customerId },
      { meta: { contains: token } },
    ];
    if (orderIds.length > 0) {
      or.push({ entityType: "ORDER", entityId: { in: orderIds } });
    }
    if (paymentIds.length > 0) {
      or.push({ entityType: "PAYMENT", entityId: { in: paymentIds } });
    }
    where.OR = or;
  }

  const logs = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      actor: { select: { id: true, email: true, name: true, role: true } },
    },
  });

  const rows = logs.map((l) => ({
    id: l.id,
    actor: l.actor,
    action: l.action,
    entityType: l.entityType,
    entityId: l.entityId,
    meta: l.meta ? (() => { try { return JSON.parse(l.meta); } catch { return null; } })() : null,
    createdAt: l.createdAt.toISOString(),
  }));

  if (format.toLowerCase() === "csv") {
    const header = ["When", "Actor", "Action", "EntityType", "EntityId", "Meta"];
    const lines = [header.join(",")];
    for (const row of rows) {
      const actor =
        row.actor?.email ||
        row.actor?.name ||
        row.actor?.id ||
        "System";
      const meta = row.meta ? JSON.stringify(row.meta) : "";
      lines.push([
        JSON.stringify(row.createdAt),
        JSON.stringify(actor),
        JSON.stringify(row.action),
        JSON.stringify(row.entityType),
        JSON.stringify(row.entityId),
        JSON.stringify(meta),
      ].join(","));
    }
    const csv = lines.join("\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=audit_${Date.now()}.csv`,
      },
    });
  }

  return NextResponse.json(rows);
}
