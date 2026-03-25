import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizePeriodActivityFilters, PERIOD_ACTIVITY_ACTIONS } from "@/lib/accounting-period-activity-query";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function parsePositiveInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const limit = parsePositiveInt(params.get("limit"), 25, 10, 100);
  const daysBack = parsePositiveInt(params.get("daysBack"), 90, 1, 3650);
  const cursor = params.get("cursor")?.trim() || null;
  const normalized = normalizePeriodActivityFilters({
    action: params.get("action"),
    actor: params.get("actor"),
    from: params.get("from"),
    to: params.get("to"),
    daysBack,
  });
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }
  const { filters } = normalized;

  const rows = await prisma.auditLog.findMany({
    where: {
      action: filters.action ? filters.action : { in: [...PERIOD_ACTIVITY_ACTIONS] },
      deletedAt: null,
      createdAt: {
        gte: filters.effectiveFromDate,
        ...(filters.toDate ? { lte: filters.toDate } : {}),
      },
      ...(filters.actor
        ? {
            actor: {
              is: {
                OR: [
                  { name: { contains: filters.actor, mode: "insensitive" } },
                  { email: { contains: filters.actor, mode: "insensitive" } },
                ],
              },
            },
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      createdAt: true,
      action: true,
      entityType: true,
      entityId: true,
      meta: true,
      actor: {
        select: { id: true, name: true, email: true, role: true },
      },
    },
  });

  const hasMore = rows.length > limit;
  const visibleRows = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? visibleRows[visibleRows.length - 1]?.id || null : null;

  return NextResponse.json({
    rows: visibleRows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actor: row.actor
        ? {
            id: row.actor.id,
            name: row.actor.name || null,
            email: row.actor.email || null,
            role: row.actor.role || null,
          }
        : null,
      meta: row.meta || null,
    })),
    nextCursor,
    hasMore,
    daysBack,
    appliedFilters: {
      action: filters.action,
      actor: filters.actor || null,
      from: filters.from,
      to: filters.to,
    },
  });
}
