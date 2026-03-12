import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import {
  clampPageSize,
  isPrismaUniqueConstraintError,
  normalizeReconciliationPeriodInput,
  parsePositiveInt,
  parseReconciliationListParams,
  parseReconciliationSort,
  parseReconciliationStatusFilter,
} from "@/lib/accounting-reconciliations";

const SLA_ALERT_KEY = "accounting.reconciliations.sla.alert.snapshot";

const reconcileSchema = z.object({
  bankAccountId: z.string().min(1),
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  statementBalance: z.number(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(req: Request) {
  const startedAt = Date.now();
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-accounting-reconciliations-list", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const { searchParams } = new URL(req.url);

  const parsed = z
    .object({
      bankAccountId: z.string().trim().max(64).optional(),
      status: z.string().optional(),
      q: z.string().trim().max(80).optional(),
      periodStartFrom: z.string().trim().max(10).optional(),
      periodEndTo: z.string().trim().max(10).optional(),
      assignedToId: z.string().trim().max(64).optional(),
      minOpenAgeDays: z.coerce.number().int().min(1).max(3650).optional(),
      pageMode: z.enum(["offset", "cursor"]).optional(),
      cursor: z.string().trim().max(64).optional(),
      sort: z.string().optional(),
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().optional(),
    })
    .safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
  }

  const safeParams = new URLSearchParams();
  if (parsed.data.bankAccountId) safeParams.set("bankAccountId", parsed.data.bankAccountId);
  if (parsed.data.status) safeParams.set("status", parseReconciliationStatusFilter(parsed.data.status));
  if (parsed.data.q) safeParams.set("q", parsed.data.q);
  if (parsed.data.periodStartFrom) safeParams.set("periodStartFrom", parsed.data.periodStartFrom);
  if (parsed.data.periodEndTo) safeParams.set("periodEndTo", parsed.data.periodEndTo);
  if (parsed.data.assignedToId) safeParams.set("assignedToId", parsed.data.assignedToId);
  if (parsed.data.minOpenAgeDays) safeParams.set("minOpenAgeDays", String(parsed.data.minOpenAgeDays));
  if (parsed.data.pageMode) safeParams.set("pageMode", parsed.data.pageMode);
  if (parsed.data.cursor) safeParams.set("cursor", parsed.data.cursor);
  safeParams.set("sort", parseReconciliationSort(parsed.data.sort));
  safeParams.set("page", String(parsePositiveInt(String(parsed.data.page || 1), 1)));
  safeParams.set("pageSize", String(clampPageSize(parsePositiveInt(String(parsed.data.pageSize || 20), 20))));

  const params = parseReconciliationListParams(safeParams);

  const orderBy: Prisma.ReconciliationOrderByWithRelationInput[] = (() => {
    switch (params.sort) {
      case "periodEnd_asc":
        return [{ periodEnd: "asc" }, { createdAt: "asc" }];
      case "updatedAt_desc":
        return [{ updatedAt: "desc" }];
      case "statementBalance_desc":
        return [{ statementBalance: "desc" }, { periodEnd: "desc" }];
      case "createdAt_asc":
        return [{ createdAt: "asc" }];
      default:
        return [{ periodEnd: "desc" }, { createdAt: "desc" }];
    }
  })();

  const openAgeCutoff = params.minOpenAgeDays
    ? new Date(Date.now() - params.minOpenAgeDays * 86_400_000)
    : null;

  const assignedToIdFilter = (safeParams.get("assignedToId") || "").trim();
  const assignedWhere =
    assignedToIdFilter === "unassigned"
      ? { assignedToId: null }
      : assignedToIdFilter
        ? { assignedToId: assignedToIdFilter }
        : {};

  const where: Prisma.ReconciliationWhereInput = {
    ...assignedWhere,
    bankAccountId: params.bankAccountId,
    status:
      params.minOpenAgeDays && params.status === "all"
        ? { in: ["DRAFT", "IN_PROGRESS"] }
        : params.status === "all"
          ? undefined
          : params.status,
    periodStart: params.periodStartFrom ? { gte: new Date(`${params.periodStartFrom}T00:00:00.000Z`) } : undefined,
    periodEnd: params.periodEndTo ? { lte: new Date(`${params.periodEndTo}T23:59:59.999Z`) } : undefined,
    createdAt: openAgeCutoff ? { lte: openAgeCutoff } : undefined,
    OR: params.q
      ? [
          { id: { contains: params.q, mode: "insensitive" } },
          { bankAccount: { name: { contains: params.q, mode: "insensitive" } } },
        ]
      : undefined,
  };

  const skip = (params.page - 1) * params.pageSize;
  const useCursorMode = params.pageMode === "cursor";
  const listPromise = useCursorMode
    ? prisma.reconciliation.findMany({
        where,
        orderBy: [{ id: "asc" }],
        include: {
          bankAccount: true,
          assignedTo: { select: { id: true, name: true, email: true } },
        },
        cursor: params.cursor ? { id: params.cursor } : undefined,
        skip: params.cursor ? 1 : 0,
        take: params.pageSize,
      })
    : prisma.reconciliation.findMany({
        where,
        orderBy,
        include: {
          bankAccount: true,
          assignedTo: { select: { id: true, name: true, email: true } },
        },
        skip,
        take: params.pageSize,
      });

  const [total, items, groupedStatus, aggregate] = await Promise.all([
    prisma.reconciliation.count({ where }),
    listPromise,
    prisma.reconciliation.groupBy({
      by: ["status"],
      where,
      _count: { _all: true },
    }),
    prisma.reconciliation.aggregate({
      where,
      _sum: { statementBalance: true },
    }),
  ]);

  const byStatus = new Map(groupedStatus.map((row) => [row.status, row._count._all]));
  const totalPages = Math.max(1, Math.ceil(total / params.pageSize));

  const itemProgress = await Promise.all(
    items.map(async (rec) => {
      const [totalBankTxns, matchedBankTxns] = await Promise.all([
        prisma.bankTransaction.count({
          where: {
            bankAccountId: rec.bankAccountId,
            postedAt: {
              gte: rec.periodStart,
              lte: rec.periodEnd,
            },
          },
        }),
        prisma.bankTransaction.count({
          where: {
            bankAccountId: rec.bankAccountId,
            matched: true,
            postedAt: {
              gte: rec.periodStart,
              lte: rec.periodEnd,
            },
          },
        }),
      ]);
      const unmatchedBankTxns = Math.max(0, totalBankTxns - matchedBankTxns);
      const matchedPercent = totalBankTxns > 0 ? Math.round((matchedBankTxns / totalBankTxns) * 100) : 0;
      return { totalBankTxns, matchedBankTxns, unmatchedBankTxns, matchedPercent };
    }),
  );

  const openWhere: Prisma.ReconciliationWhereInput = {
    ...where,
    status: { in: ["DRAFT", "IN_PROGRESS"] },
  };
  const [openOver7, openOver14, oldestOpen] = await Promise.all([
    prisma.reconciliation.count({
      where: {
        ...openWhere,
        createdAt: { lte: new Date(Date.now() - 7 * 86_400_000) },
      },
    }),
    prisma.reconciliation.count({
      where: {
        ...openWhere,
        createdAt: { lte: new Date(Date.now() - 14 * 86_400_000) },
      },
    }),
    prisma.reconciliation.findFirst({
      where: openWhere,
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);

  const oldestOpenDays = oldestOpen?.createdAt
    ? Math.max(0, Math.ceil((Date.now() - oldestOpen.createdAt.getTime()) / 86_400_000))
    : 0;

  const prevSetting = await prisma.appSetting.findUnique({
    where: { key: SLA_ALERT_KEY },
    select: { value: true },
  });
  const prevValue = prevSetting?.value && typeof prevSetting.value === "object"
    ? (prevSetting.value as Record<string, unknown>)
    : {};
  const prevOpenOver14 = Number(prevValue.openOver14 || 0);
  const prevOldestOpenDays = Number(prevValue.oldestOpenDays || 0);
  const lastAlertAt = prevValue.lastAlertAt ? String(prevValue.lastAlertAt) : null;
  const cooldownMs = 6 * 60 * 60 * 1000;
  const canAlert = !lastAlertAt || Date.now() - new Date(lastAlertAt).getTime() >= cooldownMs;
  const crossedOpen14 = prevOpenOver14 <= 0 && openOver14 > 0;
  const crossedOldest14 = prevOldestOpenDays < 14 && oldestOpenDays >= 14;
  if (canAlert && (crossedOpen14 || crossedOldest14)) {
    await recordAuditLog({
      actorId: user?.id || null,
      action: "reconciliation.sla.alert",
      entityType: "ACCOUNTING_RECONCILIATION",
      entityId: "SLA_THRESHOLD",
      meta: {
        openOver7,
        openOver14,
        oldestOpenDays,
        crossedOpen14,
        crossedOldest14,
      },
    });
  }
  await prisma.appSetting.upsert({
    where: { key: SLA_ALERT_KEY },
    update: {
      value: {
        openOver7,
        openOver14,
        oldestOpenDays,
        lastCheckedAt: new Date().toISOString(),
        lastAlertAt: canAlert && (crossedOpen14 || crossedOldest14) ? new Date().toISOString() : lastAlertAt,
      },
    },
    create: {
      key: SLA_ALERT_KEY,
      value: {
        openOver7,
        openOver14,
        oldestOpenDays,
        lastCheckedAt: new Date().toISOString(),
        lastAlertAt: canAlert && (crossedOpen14 || crossedOldest14) ? new Date().toISOString() : null,
      },
    },
  });

  const queryMs = Date.now() - startedAt;
  if (queryMs >= 700) {
    console.warn("Slow reconciliation list query", {
      queryMs,
      page: params.page,
      pageSize: params.pageSize,
      status: params.status,
      bankAccountId: params.bankAccountId || null,
      hasSearch: Boolean(params.q),
      sort: params.sort,
      total,
    });
  }

  return NextResponse.json({
    items: items.map((item, idx) => ({
      ...item,
      matchStats: itemProgress[idx],
    })),
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages,
    hasNextPage: params.page < totalPages,
    nextCursor: useCursorMode && items.length === params.pageSize ? items[items.length - 1]?.id || null : null,
    pageMode: params.pageMode,
    queryMs,
    summary: {
      total,
      draft: Number(byStatus.get("DRAFT") || 0),
      inProgress: Number(byStatus.get("IN_PROGRESS") || 0),
      closed: Number(byStatus.get("CLOSED") || 0),
      totalBalance: Number(aggregate._sum.statementBalance || 0),
      sla: {
        openOver7,
        openOver14,
        oldestOpenDays,
      },
    },
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-accounting-reconciliations-create", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  try {
    const body = await req.json();
    const parsed = reconcileSchema.safeParse({
      ...body,
      statementBalance: Number(body.statementBalance),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const period = normalizeReconciliationPeriodInput(parsed.data.periodStart, parsed.data.periodEnd);
    if (!period) {
      return NextResponse.json(
        { error: "Invalid period. Use YYYY-MM-DD dates and ensure start is not after end." },
        { status: 400 },
      );
    }
    const rec = await prisma.reconciliation.create({
      data: {
        bankAccountId: parsed.data.bankAccountId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        statementBalance: parsed.data.statementBalance,
        status: "IN_PROGRESS",
      },
    });
    return NextResponse.json(rec);
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "A reconciliation already exists for this bank and period." },
        { status: 409 },
      );
    }
    console.error("Accounting reconciliation create error:", error);
    return NextResponse.json({ error: "Failed to create reconciliation" }, { status: 500 });
  }
}
