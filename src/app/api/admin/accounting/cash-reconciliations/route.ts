import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { findClosedPeriod } from "@/lib/accounting-periods";
import { buildUtcDayRange } from "@/lib/otc-shift-close";

const DEFAULT_CASH_CODE = "1000";
const DEFAULT_OVER_SHORT_CODE = "6990";
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const createSchema = z.object({
  cashAccountId: z.string().optional(),
  countedAt: z.string().min(1),
  actualAmount: z.number(),
  mode: z.enum(["ledger", "operational"]).optional(),
  operationalScope: z.enum(["all", "otc"]).optional(),
  allowReopenOverride: z.boolean().optional(),
  reopenReason: z.string().max(300).optional(),
  varianceReason: z.enum([
    "COUNT_ERROR",
    "UNRECORDED_PAYOUT",
    "TIMING_DIFFERENCE",
    "SUSPECTED_SHRINKAGE",
    "OTHER",
  ]).optional(),
  notes: z.string().optional(),
  postAdjustment: z.boolean().optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

async function resolveCashAccount(codeOverride?: string | null) {
  const setting = await prisma.appSetting.findUnique({
    where: { key: "accounting.posting.accounts" },
  });
  const value = setting?.value && typeof setting.value === "object" ? setting.value : null;
  const cashCode = (value as Record<string, string> | null)?.CASH || codeOverride || DEFAULT_CASH_CODE;
  let account = await prisma.ledgerAccount.findUnique({ where: { code: cashCode } });
  if (!account) {
    account = await prisma.ledgerAccount.create({
      data: { code: cashCode, name: "Cash", type: "ASSET" },
    });
  }
  return account;
}

async function resolveOverShortAccount() {
  let account = await prisma.ledgerAccount.findUnique({ where: { code: DEFAULT_OVER_SHORT_CODE } });
  if (!account) {
    account = await prisma.ledgerAccount.create({
      data: { code: DEFAULT_OVER_SHORT_CODE, name: "Cash Over/Short", type: "EXPENSE" },
    });
  }
  return account;
}

async function loadCashBalance(accountId: string, asOf?: Date) {
  const totals = await prisma.journalLine.aggregate({
    where: {
      accountId,
      entry: {
        status: "POSTED",
        entryDate: asOf ? { lte: asOf } : undefined,
      },
    },
    _sum: { debit: true, credit: true },
  });
  const debit = Number(totals._sum.debit || 0);
  const credit = Number(totals._sum.credit || 0);
  return debit - credit;
}

type CashLineWithEntry = {
  debit: number;
  credit: number;
  entry: {
    sourceType: string;
    sourceId: string | null;
    memo: string | null;
  };
};

async function loadCashLines(accountId: string, start?: Date, end?: Date): Promise<CashLineWithEntry[]> {
  const rows = await prisma.journalLine.findMany({
    where: {
      accountId,
      entry: {
        status: "POSTED",
        entryDate: {
          gte: start,
          lte: end,
        },
      },
    },
    select: {
      debit: true,
      credit: true,
      entry: {
        select: {
          sourceType: true,
          sourceId: true,
          memo: true,
        },
      },
    },
  });
  return rows.map((row) => ({
    debit: Number(row.debit || 0),
    credit: Number(row.credit || 0),
    entry: {
      sourceType: String(row.entry.sourceType || "MANUAL"),
      sourceId: row.entry.sourceId || null,
      memo: row.entry.memo || null,
    },
  }));
}

async function filterOperationalLines(
  lines: CashLineWithEntry[],
  scope: "all" | "otc",
): Promise<CashLineWithEntry[]> {
  if (scope !== "otc") return lines;
  const paymentIds = Array.from(
    new Set(
      lines
        .filter((line) => line.entry.sourceType === "PAYMENT" && line.entry.sourceId)
        .map((line) => String(line.entry.sourceId)),
    ),
  );
  const orderIds = Array.from(
    new Set(
      lines
        .filter((line) => line.entry.sourceType === "ORDER" && line.entry.sourceId)
        .map((line) => String(line.entry.sourceId)),
    ),
  );

  const [walkInPayments, walkInOrders] = await Promise.all([
    paymentIds.length
      ? prisma.payment.findMany({
          where: {
            id: { in: paymentIds },
            order: { customerType: "WALK_IN" },
          },
          select: { id: true },
        })
      : Promise.resolve([]),
    orderIds.length
      ? prisma.order.findMany({
          where: {
            id: { in: orderIds },
            customerType: "WALK_IN",
          },
          select: { id: true },
        })
      : Promise.resolve([]),
  ]);

  const walkInPaymentIds = new Set(walkInPayments.map((row) => row.id));
  const walkInOrderIds = new Set(walkInOrders.map((row) => row.id));

  return lines.filter((line) => {
    if (line.entry.sourceType === "PAYMENT" && line.entry.sourceId) {
      return walkInPaymentIds.has(String(line.entry.sourceId));
    }
    if (line.entry.sourceType === "ORDER" && line.entry.sourceId) {
      return walkInOrderIds.has(String(line.entry.sourceId));
    }
    if (line.entry.sourceType === "MANUAL") {
      const memo = (line.entry.memo || "").toUpperCase();
      return memo.includes("OTC_SHIFT") || memo.includes("OTC");
    }
    return false;
  });
}

function summarizeLines(lines: CashLineWithEntry[]) {
  const cashIn = lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
  const cashOut = lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
  return {
    cashIn: Number(cashIn.toFixed(2)),
    cashOut: Number(cashOut.toFixed(2)),
    net: Number((cashIn - cashOut).toFixed(2)),
  };
}

async function buildSourceBreakdown(lines: CashLineWithEntry[]) {
  const labels: Record<string, string> = {
    PAYMENT_OTC: "Customer payments (OTC / walk-in)",
    PAYMENT_ONLINE: "Order checkout payments (registered)",
    PAYMENT_ACCOUNT: "Customer payments (balance collections)",
    PAYMENT: "Customer payments",
    ORDER: "Order postings",
    EXPENSE: "Expenses",
    PURCHASE: "Supplier payments (cash out)",
    PAYROLL: "Payroll",
    MANUAL: "Manual/adjustments",
  };
  const paymentIds = Array.from(
    new Set(
      lines
        .filter((line) => line.entry.sourceType === "PAYMENT" && line.entry.sourceId)
        .map((line) => String(line.entry.sourceId)),
    ),
  );
  const paymentTypeById = new Map<string, "OTC" | "ONLINE" | "ACCOUNT_COLLECTION">();
  if (paymentIds.length > 0) {
    const paymentRows = await prisma.payment.findMany({
      where: { id: { in: paymentIds } },
      select: {
        id: true,
        note: true,
        createdAt: true,
        order: {
          select: {
            customerType: true,
            createdAt: true,
          },
        },
      },
    });
    for (const row of paymentRows) {
      if (row.order?.customerType === "WALK_IN") {
        paymentTypeById.set(row.id, "OTC");
        continue;
      }
      let meta: { reference?: string; location?: string } | null = null;
      try {
        meta = row.note ? (JSON.parse(row.note) as { reference?: string; location?: string }) : null;
      } catch {
        meta = null;
      }
      const reference = String(meta?.reference || "").trim().toUpperCase();
      const location = String(meta?.location || "").trim().toLowerCase();
      if (reference === "ADMIN_ORDER_PAYMENT" || reference.includes("COLLECTION")) {
        paymentTypeById.set(row.id, "ACCOUNT_COLLECTION");
        continue;
      }
      if (reference === "ADMIN_ORDER_INITIAL" || location.includes("orders/new") || location.includes("checkout")) {
        paymentTypeById.set(row.id, "ONLINE");
        continue;
      }
      const orderCreatedAt = row.order?.createdAt ? new Date(row.order.createdAt).getTime() : 0;
      const paymentCreatedAt = row.createdAt ? new Date(row.createdAt).getTime() : 0;
      const deltaMs = Math.abs(paymentCreatedAt - orderCreatedAt);
      paymentTypeById.set(row.id, deltaMs <= 5 * 60 * 1000 ? "ONLINE" : "ACCOUNT_COLLECTION");
    }
  }
  const bucket = new Map<string, { sourceType: string; label: string; cashIn: number; cashOut: number; net: number }>();
  for (const line of lines) {
    let sourceType = line.entry.sourceType || "MANUAL";
    if (sourceType === "PAYMENT" && line.entry.sourceId) {
      const paymentType = paymentTypeById.get(String(line.entry.sourceId));
      if (paymentType === "OTC") sourceType = "PAYMENT_OTC";
      else if (paymentType === "ONLINE") sourceType = "PAYMENT_ONLINE";
      else if (paymentType === "ACCOUNT_COLLECTION") sourceType = "PAYMENT_ACCOUNT";
    }
    const label = labels[sourceType] || sourceType;
    const prev = bucket.get(sourceType) || { sourceType, label, cashIn: 0, cashOut: 0, net: 0 };
    const cashIn = prev.cashIn + Number(line.debit || 0);
    const cashOut = prev.cashOut + Number(line.credit || 0);
    bucket.set(sourceType, {
      sourceType,
      label,
      cashIn: Number(cashIn.toFixed(2)),
      cashOut: Number(cashOut.toFixed(2)),
      net: Number((cashIn - cashOut).toFixed(2)),
    });
  }
  return Array.from(bucket.values()).sort((a, b) => b.net - a.net);
}

async function getOperationalDaySummary(accountId: string, dayYmd: string, scope: "all" | "otc") {
  const dayRange = buildUtcDayRange(dayYmd);
  const dayLinesRaw = await loadCashLines(accountId, dayRange.from, dayRange.to);
  const dayLines = await filterOperationalLines(dayLinesRaw, scope);
  const daySummary = summarizeLines(dayLines);
  return {
    dayRange,
    dayLines,
    daySummary,
    sourceBreakdown: await buildSourceBreakdown(dayLines),
  };
}

function resolveAsOfInput(raw?: string | null) {
  const input = String(raw || "").trim();
  if (YMD_RE.test(input)) {
    const range = buildUtcDayRange(input);
    return {
      dayYmd: input,
      asOfDate: range.to,
    };
  }
  const parsed = input ? new Date(input) : new Date();
  if (Number.isNaN(parsed.getTime())) {
    const now = new Date();
    const fallbackYmd = now.toISOString().slice(0, 10);
    return {
      dayYmd: fallbackYmd,
      asOfDate: buildUtcDayRange(fallbackYmd).to,
    };
  }
  const dayYmd = parsed.toISOString().slice(0, 10);
  return {
    dayYmd,
    asOfDate: buildUtcDayRange(dayYmd).to,
  };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const asOf = searchParams.get("asOf");
  const cashAccountId = searchParams.get("cashAccountId");
  const mode = (searchParams.get("mode") || "operational").toLowerCase();
  const operationalScope = (searchParams.get("operationalScope") || "all").toLowerCase() === "otc" ? "otc" : "all";
  const historyRange = (searchParams.get("historyRange") || "all").toLowerCase();
  const historyFrom = String(searchParams.get("historyFrom") || "").trim();
  const historyTo = String(searchParams.get("historyTo") || "").trim();
  const historyVariance = String(searchParams.get("historyVariance") || "all").toLowerCase();
  const pageRaw = Number(searchParams.get("historyPage") || "1");
  const pageSizeRaw = Number(searchParams.get("historyPageSize") || "10");
  const historyPage = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const historyPageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(50, Math.max(5, Math.floor(pageSizeRaw)))
    : 10;
  const { dayYmd, asOfDate } = resolveAsOfInput(asOf);

  const cashAccount = cashAccountId
    ? await prisma.ledgerAccount.findUnique({ where: { id: cashAccountId } })
    : await resolveCashAccount();
  if (!cashAccount) {
    return NextResponse.json({ error: "Cash account not found" }, { status: 404 });
  }

  const cashAccounts = await prisma.ledgerAccount.findMany({
    where: {
      type: "ASSET",
      OR: [
        { code: cashAccount.code },
        { name: { contains: "cash", mode: "insensitive" } },
      ],
    },
    orderBy: { code: "asc" },
  });

  const expectedBalance = await loadCashBalance(cashAccount.id, asOfDate);
  const { daySummary, sourceBreakdown } = await getOperationalDaySummary(
    cashAccount.id,
    dayYmd,
    operationalScope,
  );
  const cashInPeriod = daySummary.cashIn;
  const cashOutPeriod = daySummary.cashOut;
  const expectedDayNet = daySummary.net;
  let ledgerDiagnostics: {
    isNegative: boolean;
    firstNegativeDay: string | null;
    mostNegativeMoveDay: string | null;
    mostNegativeMoveAmount: number;
  } | null = null;
  if (expectedBalance < 0) {
    const lines = await prisma.journalLine.findMany({
      where: {
        accountId: cashAccount.id,
        entry: {
          status: "POSTED",
          entryDate: { lte: asOfDate },
        },
      },
      select: {
        debit: true,
        credit: true,
        entry: { select: { entryDate: true } },
      },
      orderBy: {
        entry: {
          entryDate: "asc",
        },
      },
    });
    let running = 0;
    let firstNegativeDay: string | null = null;
    const dayNet = new Map<string, number>();
    for (const row of lines) {
      const delta = Number(Number(row.debit || 0) - Number(row.credit || 0));
      running += delta;
      const day = row.entry.entryDate.toISOString().slice(0, 10);
      dayNet.set(day, Number(((dayNet.get(day) || 0) + delta).toFixed(2)));
      if (!firstNegativeDay && running < 0) {
        firstNegativeDay = day;
      }
    }
    let mostNegativeMoveDay: string | null = null;
    let mostNegativeMoveAmount = 0;
    for (const [day, net] of dayNet.entries()) {
      if (net < mostNegativeMoveAmount) {
        mostNegativeMoveAmount = net;
        mostNegativeMoveDay = day;
      }
    }
    ledgerDiagnostics = {
      isNegative: true,
      firstNegativeDay,
      mostNegativeMoveDay,
      mostNegativeMoveAmount: Number(mostNegativeMoveAmount.toFixed(2)),
    };
  }
  const selectedDayRange = buildUtcDayRange(dayYmd);
  const selectedDayReconciliations = await prisma.cashReconciliation.findMany({
    where: {
      cashAccountId: cashAccount.id,
      countedAt: {
        gte: selectedDayRange.from,
        lte: selectedDayRange.to,
      },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      countedAt: true,
      createdAt: true,
      expectedAmount: true,
      actualAmount: true,
      variance: true,
      notes: true,
      journalEntryId: true,
      createdBy: { select: { id: true, name: true, email: true } },
    },
  });
  const selectedDayLatest = selectedDayReconciliations[0] || null;

  const [movementLines, reconciledRows] = await Promise.all([
    prisma.journalLine.findMany({
      where: {
        accountId: cashAccount.id,
        entry: {
          status: "POSTED",
          entryDate: {
            lte: asOfDate,
          },
        },
      },
      select: {
        entry: {
          select: {
            entryDate: true,
          },
        },
      },
    }),
    prisma.cashReconciliation.findMany({
      where: {
        cashAccountId: cashAccount.id,
        countedAt: {
          lte: asOfDate,
        },
      },
      select: {
        countedAt: true,
      },
    }),
  ]);
  const movementDays = new Set(
    movementLines.map((row) => row.entry.entryDate.toISOString().slice(0, 10)),
  );
  const reconciledDays = new Set(
    reconciledRows.map((row) => row.countedAt.toISOString().slice(0, 10)),
  );
  const missedDays = Array.from(movementDays)
    .filter((d) => !reconciledDays.has(d))
    .sort();
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const historyWhere: {
    cashAccountId: string;
    countedAt?: { gte?: Date; lte?: Date };
    variance?: { not: number };
  } = {
    cashAccountId: cashAccount.id,
  };
  if (historyRange === "today") {
    historyWhere.countedAt = { gte: todayStart };
  } else if (historyRange === "month") {
    historyWhere.countedAt = { gte: monthStart };
  }
  if (YMD_RE.test(historyFrom)) {
    const fromRange = buildUtcDayRange(historyFrom);
    historyWhere.countedAt = {
      ...(historyWhere.countedAt || {}),
      gte: fromRange.from,
    };
  }
  if (YMD_RE.test(historyTo)) {
    const toRange = buildUtcDayRange(historyTo);
    historyWhere.countedAt = {
      ...(historyWhere.countedAt || {}),
      lte: toRange.to,
    };
  }
  if (historyVariance === "nonzero") {
    historyWhere.variance = { not: 0 };
  }

  const [historyTotal, reconciliations] = await Promise.all([
    prisma.cashReconciliation.count({ where: historyWhere }),
    prisma.cashReconciliation.findMany({
      where: historyWhere,
      orderBy: { countedAt: "desc" },
      skip: (historyPage - 1) * historyPageSize,
      take: historyPageSize,
      include: {
        cashAccount: true,
        createdBy: { select: { id: true, name: true, email: true } },
      },
    }),
  ]);
  const historyTotalPages = Math.max(1, Math.ceil(historyTotal / historyPageSize));
  const reconciliationIds = reconciliations.map((row) => row.id);
  const auditRows = reconciliationIds.length
    ? await prisma.auditLog.findMany({
        where: {
          action: "CASH_RECONCILIATION_RECORDED",
          entityType: "CASH_RECONCILIATION",
          entityId: { in: reconciliationIds },
        },
        orderBy: { createdAt: "desc" },
        select: {
          entityId: true,
          meta: true,
        },
      })
    : [];
  const modeByRecId = new Map<string, "ledger" | "operational">();
  for (const row of auditRows) {
    if (modeByRecId.has(row.entityId)) continue;
    try {
      const meta = JSON.parse(row.meta || "{}") as { mode?: string };
      const parsedMode = String(meta?.mode || "").toLowerCase();
      if (parsedMode === "ledger" || parsedMode === "operational") {
        modeByRecId.set(row.entityId, parsedMode);
      }
    } catch {
      // ignore malformed audit meta
    }
  }
  const reconciliationsWithMode = reconciliations.map((row) => ({
    ...row,
    reconcileMode: modeByRecId.get(row.id) || null,
  }));

  return NextResponse.json({
    asOf: asOfDate.toISOString(),
    mode,
    cashAccount,
    cashAccounts,
    expectedBalance,
    operational: {
      day: dayYmd,
      scope: operationalScope,
      cashInPeriod,
      cashOutPeriod,
      expectedDayNet,
      sourceBreakdown,
    },
    reconciliations: reconciliationsWithMode,
    history: {
      range: historyRange === "today" || historyRange === "month" ? historyRange : "all",
      from: YMD_RE.test(historyFrom) ? historyFrom : null,
      to: YMD_RE.test(historyTo) ? historyTo : null,
      variance: historyVariance === "nonzero" ? "nonzero" : "all",
      page: historyPage,
      pageSize: historyPageSize,
      total: historyTotal,
      totalPages: historyTotalPages,
    },
    selectedDay: {
      day: dayYmd,
      reconciled: selectedDayReconciliations.length > 0,
      reconciliationCount: selectedDayReconciliations.length,
      latestReconciliationId: selectedDayLatest?.id || null,
      latestReconciliationAt: selectedDayLatest?.countedAt?.toISOString() || null,
      latestCreatedAt: selectedDayLatest?.createdAt?.toISOString() || null,
      latestVariance: Number(selectedDayLatest?.variance || 0),
      latestBy:
        selectedDayLatest?.createdBy?.name ||
        selectedDayLatest?.createdBy?.email ||
        null,
      records: selectedDayReconciliations.map((row) => ({
        id: row.id,
        countedAt: row.countedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        expectedAmount: Number(row.expectedAmount || 0),
        actualAmount: Number(row.actualAmount || 0),
        variance: Number(row.variance || 0),
        notes: row.notes || null,
        journalEntryId: row.journalEntryId || null,
        createdBy: row.createdBy
          ? {
              id: row.createdBy.id,
              name: row.createdBy.name,
              email: row.createdBy.email,
            }
          : null,
      })),
    },
    unreconciledDays: {
      count: missedDays.length,
      oldest: missedDays[0] || null,
      newest: missedDays[missedDays.length - 1] || null,
      sample: missedDays.slice(0, 10),
      all: missedDays,
    },
    ledgerDiagnostics,
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  try {
    const body = await req.json();
    const parsed = createSchema.safeParse({
      ...body,
      actualAmount: Number(body.actualAmount),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { dayYmd, asOfDate: countedAt } = resolveAsOfInput(parsed.data.countedAt);
    const allowReopenOverride = Boolean(parsed.data.allowReopenOverride);
    const reopenReason = String(parsed.data.reopenReason || "").trim();
    const mode = parsed.data.mode || "operational";
    const operationalScope = parsed.data.operationalScope || "all";
    const cashAccount = parsed.data.cashAccountId
      ? await prisma.ledgerAccount.findUnique({ where: { id: parsed.data.cashAccountId } })
      : await resolveCashAccount();
    if (!cashAccount) {
      return NextResponse.json({ error: "Cash account not found" }, { status: 404 });
    }
    const dayRange = buildUtcDayRange(dayYmd);
    const existingForDay = await prisma.cashReconciliation.findMany({
      where: {
        cashAccountId: cashAccount.id,
        countedAt: {
          gte: dayRange.from,
          lte: dayRange.to,
        },
      },
      orderBy: { createdAt: "desc" },
      take: 1,
      select: {
        id: true,
        createdAt: true,
        variance: true,
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
    const latestExisting = existingForDay[0] || null;
    if (latestExisting && !allowReopenOverride) {
      return NextResponse.json(
        {
          error: `Cash reconciliation already exists for ${dayYmd}. Enable override to resave this day.`,
          code: "DAY_ALREADY_RECONCILED",
          existing: {
            id: latestExisting.id,
            createdAt: latestExisting.createdAt.toISOString(),
            variance: Number(latestExisting.variance || 0),
            by:
              latestExisting.createdBy?.name ||
              latestExisting.createdBy?.email ||
              null,
          },
        },
        { status: 409 },
      );
    }
    if (latestExisting && allowReopenOverride && reopenReason.length < 10) {
      return NextResponse.json(
        { error: "Override reason must be at least 10 characters." },
        { status: 400 },
      );
    }

    const expectedAmount =
      mode === "operational"
        ? (
            await getOperationalDaySummary(cashAccount.id, dayYmd, operationalScope)
          ).daySummary.net
        : await loadCashBalance(cashAccount.id, countedAt);
    const actualAmount = parsed.data.actualAmount;
    const variance = Number((actualAmount - expectedAmount).toFixed(2));
    const varianceReason = parsed.data.varianceReason || null;
    const noteText = parsed.data.notes?.trim() || "";
    if (variance !== 0) {
      if (!varianceReason) {
        return NextResponse.json(
          { error: "Variance reason is required when variance is non-zero." },
          { status: 400 },
        );
      }
      if (!noteText) {
        return NextResponse.json(
          { error: "Variance explanation is required when variance is non-zero." },
          { status: 400 },
        );
      }
    }

    const composedNotes = varianceReason
      ? `[VAR_REASON:${varianceReason}]${noteText ? ` ${noteText}` : ""}`
      : noteText || null;

    let journalEntryId: string | null = null;
    const shouldPost = parsed.data.postAdjustment !== false && variance !== 0;
    if (shouldPost) {
      const closedPeriod = await findClosedPeriod(countedAt);
      if (closedPeriod) {
        return NextResponse.json(
          { error: `Cannot post adjustment in closed period "${closedPeriod.name}".` },
          { status: 400 },
        );
      }

      const overShort = await resolveOverShortAccount();
      const amount = Math.abs(variance);
      const lines = variance > 0
        ? [
            { accountId: cashAccount.id, debit: amount, credit: 0, description: "Cash count adjustment" },
            { accountId: overShort.id, debit: 0, credit: amount, description: "Cash over/short" },
          ]
        : [
            { accountId: overShort.id, debit: amount, credit: 0, description: "Cash over/short" },
            { accountId: cashAccount.id, debit: 0, credit: amount, description: "Cash count adjustment" },
          ];

      const entry = await prisma.journalEntry.create({
        data: {
          entryDate: countedAt,
          memo: varianceReason
            ? `Cash reconciliation adjustment (${varianceReason})`
            : "Cash reconciliation adjustment",
          sourceType: "MANUAL",
          status: "POSTED",
          approvedById: session.user?.id,
          approvedAt: new Date(),
          lines: {
            create: lines.map((line) => ({
              accountId: line.accountId,
              debit: line.debit,
              credit: line.credit,
              description: line.description,
            })),
          },
        },
      });
      journalEntryId = entry.id;
    }

    const rec = await prisma.cashReconciliation.create({
      data: {
        cashAccountId: cashAccount.id,
        countedAt,
        expectedAmount,
        actualAmount,
        variance,
        notes: composedNotes,
        createdById: session.user?.id,
        journalEntryId,
      },
      include: {
        cashAccount: true,
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user?.id || null,
        action: "CASH_RECONCILIATION_RECORDED",
        entityType: "CASH_RECONCILIATION",
        entityId: rec.id,
        meta: JSON.stringify({
          cashAccountId: cashAccount.id,
          countedAt: countedAt.toISOString(),
          mode,
          operationalScope: mode === "operational" ? operationalScope : null,
          expectedAmount,
          actualAmount,
          variance,
          varianceReason,
          notes: noteText || null,
          journalEntryId,
          adjustmentPosted: shouldPost,
          overrideUsed: allowReopenOverride,
          reopenReason: allowReopenOverride ? reopenReason || null : null,
          replacedDayReconciliationId: latestExisting?.id || null,
        }),
      },
    });
    if (latestExisting && allowReopenOverride) {
      await prisma.auditLog.create({
        data: {
          actorId: session.user?.id || null,
          action: "CASH_RECONCILIATION_REOPENED",
          entityType: "CASH_RECONCILIATION",
          entityId: latestExisting.id,
          meta: JSON.stringify({
            day: dayYmd,
            replacedById: rec.id,
            reason: reopenReason || null,
          }),
        },
      });
    }

    return NextResponse.json(rec);
  } catch (error) {
    console.error("Cash reconciliation error:", error);
    return NextResponse.json({ error: "Failed to save cash reconciliation" }, { status: 500 });
  }
}
