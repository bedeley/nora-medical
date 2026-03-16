import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const ACTIONS = [
  "fiscal-period.create",
  "fiscal-period.close",
  "fiscal-period.open",
  "fiscal-month.close",
  "fiscal-month.open",
  "fiscal-month.batch.close",
  "fiscal-month.batch.open",
  "fiscal-month.calendar.initialize",
  "fiscal-period.auto_generate.cron.run",
  "fiscal-period.auto_generate.manual.run",
  "fiscal-period.prior_adjustment.note",
];

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
  const fromDate = new Date(Date.now() - daysBack * 86_400_000);

  const rows = await prisma.auditLog.findMany({
    where: {
      action: { in: ACTIONS },
      deletedAt: null,
      createdAt: { gte: fromDate },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
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
  });
}
