import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
  const action = searchParams.get("action") || undefined;
  const actorId = searchParams.get("actorId") || undefined;
  const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") || 100)));
  const start = searchParams.get("start") || undefined;
  const end = searchParams.get("end") || undefined;

  const where: {
    entityType?: string;
    entityId?: string;
    action?: string;
    actorId?: string;
    createdAt?: { gte?: Date; lte?: Date };
  } = {};

  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (action) where.action = action;
  if (actorId) where.actorId = actorId;
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

  const logs = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      actor: { select: { id: true, email: true, name: true, role: true } },
    },
  });

  return NextResponse.json(
    logs.map((l) => ({
      id: l.id,
      actor: l.actor,
      action: l.action,
      entityType: l.entityType,
      entityId: l.entityId,
      meta: l.meta ? (() => { try { return JSON.parse(l.meta); } catch { return null; } })() : null,
      createdAt: l.createdAt.toISOString(),
    })),
  );
}
