import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { loadAccountingJournalPolicy } from "@/lib/accounting-journal-policy";
import {
  JOURNAL_IDS_ONLY_MAX,
  applyIdsOnlyCap,
  compareJournalStatus,
  normalizeJournalSearchQuery,
} from "@/lib/accounting-journal-query";
import { findClosedPeriod } from "@/lib/accounting-periods";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const MANUAL_CATEGORIES = [
  "PERIOD_END_ADJUSTMENT",
  "CORRECTION",
  "RECLASSIFICATION",
  "ACCRUAL_DEFERRAL",
  "OTHER_EXCEPTION",
] as const;
const JOURNAL_SOURCE_TYPES = ["ORDER", "PAYMENT", "EXPENSE", "PURCHASE", "PAYROLL", "MANUAL"] as const;
const DEFAULT_MANUAL_POLICY = {
  periodBasis: "MONTHLY_CALENDAR" as const,
  periodEndWindowDays: 5,
  requireExceptionOutsideWindow: true,
  minExceptionNoteLength: 12,
};

const lineSchema = z.object({
  accountId: z.string().min(1),
  debit: z.number().min(0),
  credit: z.number().min(0),
  description: z.string().max(200).optional(),
  taxCodeId: z.string().optional().nullable(),
});

const entrySchema = z
  .object({
    entryDate: z.string().min(1),
    memo: z.string().max(500).optional(),
    sourceType: z.enum(["ORDER", "PAYMENT", "EXPENSE", "PURCHASE", "PAYROLL", "MANUAL"]),
    manualCategory: z.enum(MANUAL_CATEGORIES).optional(),
    manualExceptionNote: z.string().max(500).optional(),
    priorPeriodId: z.string().max(120).optional().nullable(),
    priorPeriodNote: z.string().max(500).optional(),
    sourceId: z.string().optional().nullable(),
    status: z.enum(["DRAFT", "POSTED", "VOID"]).optional(),
    lines: z.array(lineSchema).min(2),
  })
  .superRefine((data, ctx) => {
    let debitTotal = 0;
    let creditTotal = 0;
    data.lines.forEach((line, idx) => {
      if (line.debit > 0 && line.credit > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lines", idx],
          message: "Line cannot have both debit and credit.",
        });
      }
      if (line.debit <= 0 && line.credit <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lines", idx],
          message: "Line must have a debit or credit amount.",
        });
      }
      debitTotal += line.debit;
      creditTotal += line.credit;
    });
    if (Math.abs(debitTotal - creditTotal) > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lines"],
        message: "Debits must equal credits.",
      });
    }
  });

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function withAndClauses(
  where: Prisma.JournalEntryWhereInput,
  clauses: Prisma.JournalEntryWhereInput[],
) {
  if (clauses.length === 0) return where;
  return {
    ...where,
    AND: [...(Array.isArray(where.AND) ? where.AND : []), ...clauses],
  };
}

function emptyJournalListResponse(
  page: number,
  pageSize: number,
  sortBy: "date" | "status" | "amount",
  sortDir: Prisma.SortOrder,
) {
  return {
    items: [],
    page,
    pageSize,
    total: 0,
    totalPages: 1,
    sortBy,
    sortDir,
  };
}

async function enrichJournalEntries<T extends { id: string; sourceType: string; sourceId?: string | null }>(
  entries: T[],
): Promise<Array<T & { sourceLabel: string | null; apBalanceAfter: number | null }>> {
  const orderIds = entries
    .filter((entry) => entry.sourceType === "ORDER" && entry.sourceId)
    .map((entry) => entry.sourceId as string);
  const paymentIds = entries
    .filter((entry) => entry.sourceType === "PAYMENT" && entry.sourceId)
    .map((entry) => String(entry.sourceId || "").split(":")[0] || "")
    .filter(Boolean);
  const purchaseSourceIds = entries
    .filter((entry) => entry.sourceType === "PURCHASE" && entry.sourceId)
    .map((entry) => entry.sourceId as string);

  const [orders, payments, purchaseSources, supplierPaymentSources] = await Promise.all([
    orderIds.length
      ? prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, invoiceNumber: true, receiptHash: true },
        })
      : Promise.resolve([]),
    paymentIds.length
      ? prisma.payment.findMany({
          where: { id: { in: paymentIds } },
          select: { id: true, orderId: true },
        })
      : Promise.resolve([]),
    purchaseSourceIds.length
      ? prisma.purchase.findMany({
          where: { id: { in: purchaseSourceIds } },
          select: { id: true, supplierId: true, supplier: true, unitCost: true, quantity: true },
        })
      : Promise.resolve([]),
    purchaseSourceIds.length
      ? prisma.supplierPayment.findMany({
          where: { id: { in: purchaseSourceIds } },
          select: { id: true, purchaseId: true },
        })
      : Promise.resolve([]),
  ]);
  const paymentOrderIds = payments.map((payment) => payment.orderId).filter(Boolean) as string[];
  const paymentOrders = paymentOrderIds.length
    ? await prisma.order.findMany({
        where: { id: { in: paymentOrderIds } },
        select: { id: true, invoiceNumber: true, receiptHash: true },
      })
    : [];

  const invoiceByOrderId = new Map(
    [...orders, ...paymentOrders].map((order) => [
      order.id,
      `${order.invoiceNumber || ""} ${order.receiptHash || ""}`.trim(),
    ] as const),
  );
  const invoiceByPaymentId = new Map(
    payments.map((payment) => [payment.id, invoiceByOrderId.get(payment.orderId || "") || ""]),
  );
  const purchaseIdsFromPayments = supplierPaymentSources
    .map((sp) => sp.purchaseId)
    .filter(Boolean) as string[];
  const purchaseIds = Array.from(new Set([
    ...purchaseSources.map((p) => p.id),
    ...purchaseIdsFromPayments,
  ]));
  const purchasesById = new Map(purchaseSources.map((p) => [p.id, p]));
  if (purchaseIds.length > 0) {
    const missingIds = purchaseIds.filter((id) => !purchasesById.has(id));
    if (missingIds.length > 0) {
      const missingPurchases = await prisma.purchase.findMany({
        where: { id: { in: missingIds } },
        select: { id: true, supplierId: true, supplier: true, unitCost: true, quantity: true },
      });
      for (const p of missingPurchases) {
        purchasesById.set(p.id, p);
      }
    }
  }
  const paidByPurchase = new Map<string, number>();
  if (purchaseIds.length > 0) {
    const paymentSums = await prisma.supplierPayment.groupBy({
      by: ["purchaseId"],
      where: { deletedAt: null, status: "NORMAL", purchaseId: { in: purchaseIds } },
      _sum: { amount: true },
    });
    for (const row of paymentSums) {
      if (row.purchaseId) paidByPurchase.set(row.purchaseId, Number(row._sum.amount || 0));
    }
  }
  const purchaseIdBySupplierPaymentId = new Map(
    supplierPaymentSources.map((sp) => [sp.id, sp.purchaseId]).filter(([, pid]) => Boolean(pid)) as [string, string][],
  );
  const apBalanceByEntryId = new Map<string, number>();
  for (const entry of entries) {
    if (entry.sourceType !== "PURCHASE" || !entry.sourceId) continue;
    let purchaseId = entry.sourceId;
    if (!purchasesById.has(purchaseId) && purchaseIdBySupplierPaymentId.has(purchaseId)) {
      purchaseId = purchaseIdBySupplierPaymentId.get(purchaseId) as string;
    }
    const purchase = purchasesById.get(purchaseId);
    if (!purchase) continue;
    const total = Number(purchase.unitCost || 0) * Number(purchase.quantity || 0);
    const paid = paidByPurchase.get(purchaseId) || 0;
    const outstanding = Math.max(0, total - paid);
    apBalanceByEntryId.set(entry.id, outstanding);
  }

  const enriched = entries.map((entry) => {
    if (entry.sourceType !== "ORDER" || !entry.sourceId) return { ...entry, sourceLabel: null };
    return {
      ...entry,
      sourceLabel: invoiceByOrderId.get(entry.sourceId) || null,
    };
  });

  return enriched.map((entry) => {
    if (entry.sourceType !== "PAYMENT" || !entry.sourceId) {
      return {
        ...entry,
        apBalanceAfter: apBalanceByEntryId.get(entry.id) ?? null,
      };
    }
    const paymentId = String(entry.sourceId || "").split(":")[0] || "";
    return {
      ...entry,
      sourceLabel: invoiceByPaymentId.get(paymentId) || null,
      apBalanceAfter: apBalanceByEntryId.get(entry.id) ?? null,
    };
  });
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const sourceType = searchParams.get("sourceType");
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const scopeMode = String(searchParams.get("scopeMode") || "").toLowerCase();
  const includeArchive = searchParams.get("includeArchive") === "1";
  const paginate = searchParams.get("paginate") === "1";
  const idsOnly = searchParams.get("idsOnly") === "1";
  const aggregate = searchParams.get("aggregate") === "1";
  const balanceScope = searchParams.get("balanceScope") === "1";
  const link = String(searchParams.get("link") || "").trim();
  const account = String(searchParams.get("account") || "").trim();
  const accountId = String(searchParams.get("accountId") || "").trim();
  const entryDirRaw = String(searchParams.get("entryDir") || "").toLowerCase();
  const entryDir = entryDirRaw === "debit" || entryDirRaw === "credit" ? entryDirRaw : "";
  const outOfBalanceOnly = searchParams.get("outOfBalance") === "1";
  const missingRefOnly = searchParams.get("missingRef") === "1";
  const largeAmountOnly = searchParams.get("largeAmount") === "1";
  const staleDraftOnly = searchParams.get("staleDraft") === "1";
  const largestVarianceFirst = searchParams.get("largestVariance") === "1";
  const rawPage = Number(searchParams.get("page") || "1");
  const rawPageSize = Number(searchParams.get("pageSize") || "25");
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const pageSize = Number.isFinite(rawPageSize) ? Math.max(10, Math.min(200, Math.floor(rawPageSize))) : 25;
  const qRaw = String(searchParams.get("q") || "");
  const normalizedQ = normalizeJournalSearchQuery(qRaw);
  if (!normalizedQ.ok) {
    return NextResponse.json(
      { error: normalizedQ.error },
      { status: 400 },
    );
  }
  const q = normalizedQ.q;
  const sortByRaw = String(searchParams.get("sortBy") || "date").toLowerCase();
  const sortDirRaw = String(searchParams.get("sortDir") || "desc").toLowerCase();
  const sortBy: "date" | "status" | "amount" =
    sortByRaw === "status" || sortByRaw === "amount" ? sortByRaw : "date";
  const sortDir: Prisma.SortOrder = sortDirRaw === "asc" ? "asc" : "desc";
  const journalPolicy = await loadAccountingJournalPolicy();
  const largeAmountAnomalyThreshold = journalPolicy.largeAmountAnomalyThreshold ?? 25000;

  const where: Prisma.JournalEntryWhereInput = {};
  const andClauses: Prisma.JournalEntryWhereInput[] = [];
  if (!includeArchive) {
    where.archivedAt = null;
  }
  if (status === "DRAFT" || status === "POSTED" || status === "VOID") {
    where.status = status;
  }
  if (
    sourceType === "ORDER" ||
    sourceType === "PAYMENT" ||
    sourceType === "EXPENSE" ||
    sourceType === "PURCHASE" ||
    sourceType === "PAYROLL" ||
    sourceType === "MANUAL"
  ) {
    where.sourceType = sourceType;
  }
  if (start || end) {
    where.entryDate = {};
    if (start) {
      if (YMD_RE.test(start)) {
        where.entryDate.gte = new Date(`${start}T00:00:00.000Z`);
      } else {
        where.entryDate.gte = new Date(start);
      }
    }
    if (end) {
      if (YMD_RE.test(end)) {
        where.entryDate.lte = new Date(`${end}T23:59:59.999Z`);
      } else {
        const endDate = new Date(end);
        endDate.setHours(23, 59, 59, 999);
        where.entryDate.lte = endDate;
      }
    }
  }
  const hasExplicitDateWindow = Boolean(start || end);
  if (!hasExplicitDateWindow && !includeArchive && scopeMode !== "all_non_archived") {
    const recentWindowDays = journalPolicy.recentWindowDays;
    const recentStart = new Date();
    recentStart.setUTCDate(recentStart.getUTCDate() - recentWindowDays);
    recentStart.setUTCHours(0, 0, 0, 0);
    const existingEntryDate =
      where.entryDate && typeof where.entryDate === "object" && !("toISOString" in where.entryDate)
        ? where.entryDate
        : {};
    where.entryDate = {
      ...existingEntryDate,
      gte: recentStart,
    };
  }
  if (q) {
    const qAsSourceType = q.toUpperCase();
    const sourceTypeExactMatch = JOURNAL_SOURCE_TYPES.includes(qAsSourceType as (typeof JOURNAL_SOURCE_TYPES)[number])
      ? [{ sourceType: qAsSourceType as (typeof JOURNAL_SOURCE_TYPES)[number] }]
      : [];
    andClauses.push({
      OR: [
        { memo: { contains: q, mode: "insensitive" } },
        ...sourceTypeExactMatch,
        { sourceId: { contains: q, mode: "insensitive" } },
        {
          lines: {
            some: {
              OR: [
                { description: { contains: q, mode: "insensitive" } },
                { account: { code: { contains: q, mode: "insensitive" } } },
                { account: { name: { contains: q, mode: "insensitive" } } },
              ],
            },
          },
        },
      ],
    });
  }
  if (link) {
    // Also search order invoice numbers — they live on the Order model and are
    // joined in as sourceLabel during enrichment, so a plain sourceId search
    // would miss them. We resolve matching order IDs here first.
    const orderIdsMatchingInvoice = await prisma.order.findMany({
      where: {
        OR: [
          { invoiceNumber: { contains: link, mode: "insensitive" } },
          { receiptHash: { contains: link, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    }).then((rows) => rows.map((r) => r.id));
    andClauses.push({
      OR: [
        { sourceId: { contains: link, mode: "insensitive" } },
        { memo: { contains: link, mode: "insensitive" } },
        {
          lines: {
            some: {
              description: { contains: link, mode: "insensitive" },
            },
          },
        },
        ...(orderIdsMatchingInvoice.length > 0
          ? [{ sourceType: "ORDER" as const, sourceId: { in: orderIdsMatchingInvoice } }]
          : []),
      ],
    });
  }
  if (accountId) {
    andClauses.push({
      lines: {
        some: {
          accountId,
        },
      },
    });
  }
  if (account) {
    andClauses.push({
      lines: {
        some: {
          OR: [
            { account: { code: { contains: account, mode: "insensitive" } } },
            { account: { name: { contains: account, mode: "insensitive" } } },
          ],
        },
      },
    });
  }
  if (entryDir) {
    // Build a line-level scope that respects any active account filter so the
    // net-direction check is scoped to the same lines the user is drilling into.
    const lineScopeForDir: Prisma.JournalLineWhereInput = {
      ...(accountId ? { accountId } : {}),
      ...(account
        ? {
            account: {
              OR: [
                { code: { contains: account, mode: "insensitive" } },
                { name: { contains: account, mode: "insensitive" } },
              ],
            },
          }
        : {}),
    };
    // Determine net direction at the entry level: sum debits vs credits across
    // all matching lines, then keep only entries whose net is debit-heavy or
    // credit-heavy. Using `debit: { gt: 0 }` would match every double-entry
    // because every entry has both debit and credit lines.
    const dirGrouped = await prisma.journalLine.groupBy({
      by: ["entryId"],
      where: { entry: withAndClauses(where, andClauses), ...lineScopeForDir },
      _sum: { debit: true, credit: true },
    });
    const dirMatchedIds = dirGrouped
      .filter((row) => {
        const net = Number(row._sum.debit || 0) - Number(row._sum.credit || 0);
        return entryDir === "debit" ? net > 0 : net < 0;
      })
      .map((row) => row.entryId);
    if (dirMatchedIds.length === 0) {
      if (idsOnly) return NextResponse.json({ ids: [], total: 0, truncated: false, max: JOURNAL_IDS_ONLY_MAX });
      if (aggregate) return NextResponse.json({ total: 0, posted: 0, draft: 0, void: 0, debit: 0, credit: 0, outOfBalanceCount: 0, exceptionCounts: { missingRef: 0, largeAmount: 0, staleDraft: 0 }, sourceCounts: {}, draftQueue: { count: 0, oldest: null, oldestAgeDays: 0 } });
      if (paginate) return NextResponse.json(emptyJournalListResponse(page, pageSize, sortBy, sortDir));
      return NextResponse.json([]);
    }
    andClauses.push({ id: { in: dirMatchedIds } });
  }
  if (missingRefOnly) {
    andClauses.push({
      status: "POSTED",
      NOT: { sourceType: "MANUAL" },
      OR: [{ sourceId: null }, { sourceId: "" }],
    });
  }
  if (staleDraftOnly) {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    andClauses.push({
      status: "DRAFT",
      entryDate: { lte: cutoff },
    });
  }
  let scopedWhere = withAndClauses(where, andClauses);
  if (outOfBalanceOnly || largeAmountOnly) {
    const grouped = await prisma.journalLine.groupBy({
      by: ["entryId"],
      where: { entry: scopedWhere },
      _sum: { debit: true, credit: true },
    });
    const matchedIds = grouped
      .filter((row) => {
        const debit = Number(row._sum.debit || 0);
        const credit = Number(row._sum.credit || 0);
        if (outOfBalanceOnly && Math.abs(debit - credit) <= 0.01) return false;
        if (largeAmountOnly && Math.max(Math.abs(debit), Math.abs(credit)) < largeAmountAnomalyThreshold) return false;
        return true;
      })
      .map((row) => row.entryId);
    if (matchedIds.length === 0) {
      if (idsOnly) {
        return NextResponse.json({
          ids: [],
          total: 0,
          truncated: false,
          max: JOURNAL_IDS_ONLY_MAX,
        });
      }
      if (aggregate) {
        return NextResponse.json({ total: 0, posted: 0, draft: 0, void: 0, debit: 0, credit: 0, outOfBalanceCount: 0, exceptionCounts: { missingRef: 0, largeAmount: 0, staleDraft: 0 }, sourceCounts: {}, draftQueue: { count: 0, oldest: null, oldestAgeDays: 0 } });
      }
      if (paginate) {
        return NextResponse.json(emptyJournalListResponse(page, pageSize, sortBy, sortDir));
      }
      return NextResponse.json([]);
    }
    scopedWhere = withAndClauses(scopedWhere, [{ id: { in: matchedIds } }]);
  }

  if (aggregate) {
    const staleDraftCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [statusRows, sourceRows, groupedLines, missingRefCount, staleDraftCount, oldestDraft] = await Promise.all([
      prisma.journalEntry.groupBy({
        by: ["status"],
        where: scopedWhere,
        _count: { _all: true },
      }),
      prisma.journalEntry.groupBy({
        by: ["sourceType"],
        where: scopedWhere,
        _count: { _all: true },
      }),
      prisma.journalLine.groupBy({
        by: ["entryId"],
        where: { entry: scopedWhere },
        _sum: { debit: true, credit: true },
      }),
      prisma.journalEntry.count({
        where: withAndClauses(scopedWhere, [
          {
            status: "POSTED",
            NOT: { sourceType: "MANUAL" },
            OR: [{ sourceId: null }, { sourceId: "" }],
          },
        ]),
      }),
      prisma.journalEntry.count({
        where: withAndClauses(scopedWhere, [
          {
            status: "DRAFT",
            entryDate: { lte: staleDraftCutoff },
          },
        ]),
      }),
      prisma.journalEntry.findFirst({
        where: withAndClauses(scopedWhere, [{ status: "DRAFT" }]),
        orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
        include: {
          approvedBy: { select: { id: true, name: true, email: true } },
          lines: {
            include: {
              account: true,
              taxCode: true,
            },
          },
        },
      }),
    ]);

    const summary = {
      total: 0,
      posted: 0,
      draft: 0,
      void: 0,
      debit: 0,
      credit: 0,
      outOfBalanceCount: 0,
      exceptionCounts: {
        missingRef: missingRefCount,
        largeAmount: 0,
        staleDraft: staleDraftCount,
      },
      sourceCounts: {} as Record<string, number>,
      draftQueue: {
        count: 0,
        oldest: oldestDraft
          ? {
              ...oldestDraft,
              entryDate: oldestDraft.entryDate.toISOString(),
            }
          : null,
        oldestAgeDays: oldestDraft
          ? Math.max(0, Math.floor((Date.now() - oldestDraft.entryDate.getTime()) / (1000 * 60 * 60 * 24)))
          : 0,
      },
    };

    for (const row of statusRows) {
      const count = Number(row._count._all || 0);
      summary.total += count;
      if (row.status === "POSTED") summary.posted = count;
      if (row.status === "DRAFT") {
        summary.draft = count;
        summary.draftQueue.count = count;
      }
      if (row.status === "VOID") summary.void = count;
    }
    for (const row of sourceRows) {
      summary.sourceCounts[row.sourceType] = Number(row._count._all || 0);
    }
    for (const row of groupedLines) {
      const debit = Number(row._sum.debit || 0);
      const credit = Number(row._sum.credit || 0);
      summary.debit += debit;
      summary.credit += credit;
      if (Math.abs(debit - credit) > 0.01) summary.outOfBalanceCount += 1;
      if (Math.max(Math.abs(debit), Math.abs(credit)) >= largeAmountAnomalyThreshold) {
        summary.exceptionCounts.largeAmount += 1;
      }
    }

    return NextResponse.json(summary);
  }

  if (balanceScope) {
    const rows = await prisma.journalEntry.findMany({
      where: scopedWhere,
      orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        entryDate: true,
        sourceType: true,
        sourceId: true,
        lines: {
          select: {
            debit: true,
            credit: true,
            account: {
              select: {
                code: true,
              },
            },
          },
        },
      },
    });
    const enriched = await enrichJournalEntries(rows);
    return NextResponse.json(enriched);
  }

  if (idsOnly) {
    const rows = await prisma.journalEntry.findMany({
      where: scopedWhere,
      orderBy: [{ entryDate: sortDir }, { createdAt: sortDir }],
      select: { id: true },
    });
    const capped = applyIdsOnlyCap(rows.map((row) => row.id));
    return NextResponse.json(capped);
  }

  let amountSortedEntryIds: string[] | null = null;
  let varianceSortedEntryIds: string[] | null = null;
  if (largestVarianceFirst) {
    const grouped = await prisma.journalLine.groupBy({
      by: ["entryId"],
      where: { entry: scopedWhere },
      _sum: { debit: true, credit: true },
    });
    varianceSortedEntryIds = grouped
      .map((row) => ({
        entryId: row.entryId,
        variance: Math.abs(Number(row._sum.debit || 0) - Number(row._sum.credit || 0)),
      }))
      .sort((a, b) => {
        if (b.variance !== a.variance) return b.variance - a.variance;
        return a.entryId.localeCompare(b.entryId);
      })
      .map((row) => row.entryId);
    if (varianceSortedEntryIds.length === 0) {
      varianceSortedEntryIds = [];
    }
  }
  if (sortBy === "amount") {
    const grouped = await prisma.journalLine.groupBy({
      by: ["entryId"],
      where: { entry: scopedWhere },
      _sum: { debit: true },
      orderBy: { _sum: { debit: sortDir } },
    });
    amountSortedEntryIds = grouped.map((row) => row.entryId);
    if (amountSortedEntryIds.length === 0) {
      amountSortedEntryIds = [];
    }
  }

  let entries: Awaited<ReturnType<typeof prisma.journalEntry.findMany>> = [];
  let total = 0;
  if (largestVarianceFirst && varianceSortedEntryIds) {
    total = varianceSortedEntryIds.length;
    const pagedIds = paginate
      ? varianceSortedEntryIds.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)
      : varianceSortedEntryIds;
    if (pagedIds.length > 0) {
      const rows = await prisma.journalEntry.findMany({
        where: { id: { in: pagedIds } },
        include: {
          approvedBy: { select: { id: true, name: true, email: true } },
          lines: {
            include: {
              account: true,
              taxCode: true,
            },
          },
        },
      });
      const map = new Map(rows.map((row) => [row.id, row]));
      entries = pagedIds.map((id) => map.get(id)).filter(Boolean) as typeof rows;
    }
  } else if (sortBy === "amount" && amountSortedEntryIds) {
    total = amountSortedEntryIds.length;
    const pagedIds = paginate
      ? amountSortedEntryIds.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)
      : amountSortedEntryIds;
    if (pagedIds.length > 0) {
      const rows = await prisma.journalEntry.findMany({
        where: { id: { in: pagedIds } },
        include: {
          approvedBy: { select: { id: true, name: true, email: true } },
          lines: {
            include: {
              account: true,
              taxCode: true,
            },
          },
        },
      });
      const map = new Map(rows.map((row) => [row.id, row]));
      entries = pagedIds.map((id) => map.get(id)).filter(Boolean) as typeof rows;
    }
  } else {
    if (sortBy === "status") {
      const statusRows = await prisma.journalEntry.findMany({
        where: scopedWhere,
        select: { id: true, status: true, entryDate: true, createdAt: true },
      });
      statusRows.sort((a, b) => compareJournalStatus(a, b, sortDir));
      total = statusRows.length;
      const pagedIds = paginate
        ? statusRows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize).map((row) => row.id)
        : statusRows.map((row) => row.id);
      if (pagedIds.length > 0) {
        const rows = await prisma.journalEntry.findMany({
          where: { id: { in: pagedIds } },
          include: {
            approvedBy: { select: { id: true, name: true, email: true } },
            lines: {
              include: {
                account: true,
                taxCode: true,
              },
            },
          },
        });
        const map = new Map(rows.map((row) => [row.id, row]));
        entries = pagedIds.map((id) => map.get(id)).filter(Boolean) as typeof rows;
      }
    } else {
      const orderBy: Prisma.JournalEntryOrderByWithRelationInput[] = [
        { entryDate: sortDir },
        { createdAt: sortDir },
      ];
      const [rows, count] = await Promise.all([
        prisma.journalEntry.findMany({
          where: scopedWhere,
          orderBy,
          ...(paginate ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
          include: {
            approvedBy: { select: { id: true, name: true, email: true } },
            lines: {
              include: {
                account: true,
                taxCode: true,
              },
            },
          },
        }),
        paginate ? prisma.journalEntry.count({ where: scopedWhere }) : Promise.resolve(0),
      ]);
      entries = rows;
      total = count;
    }
  }
  const enrichedWithAp = await enrichJournalEntries(entries);
  if (!paginate) {
    return NextResponse.json(enrichedWithAp);
  }
  return NextResponse.json({
    items: enrichedWithAp,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    sortBy,
    sortDir,
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
    const parsed = entrySchema.safeParse({
      ...body,
      status: body.status ?? "POSTED",
      sourceId: body.sourceId || null,
      lines: Array.isArray(body.lines)
        ? body.lines.map((line: { debit?: unknown; credit?: unknown }) => ({
            ...line,
            debit: Number(line.debit || 0),
            credit: Number(line.credit || 0),
          }))
        : [],
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const user = session.user as AuthenticatedUser;
    const isManual = parsed.data.sourceType === "MANUAL";
    const normalizedSourceId = String(parsed.data.sourceId || "").trim();
    let manualPeriodBasisForAudit: "MONTHLY_CALENDAR" | "FISCAL_PERIOD_END" | null = null;
    const entryDate = new Date(parsed.data.entryDate);
    if (!isManual && parsed.data.status === "POSTED" && !normalizedSourceId) {
      return NextResponse.json(
        { error: "Posted non-manual journal entries require a source reference." },
        { status: 400 },
      );
    }
    if (isManual && user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "Manual journal entries are limited to admins." },
        { status: 403 },
      );
    }
    if (isManual && !parsed.data.memo?.trim()) {
      return NextResponse.json(
        { error: "Manual journal entries require a reason in the memo field." },
        { status: 400 },
      );
    }
    if (isManual && !parsed.data.manualCategory) {
      return NextResponse.json(
        { error: "Manual journal entries require an adjustment category." },
        { status: 400 },
      );
    }
    const priorPeriodId = String(parsed.data.priorPeriodId || "").trim();
    const priorPeriodNote = String(parsed.data.priorPeriodNote || "").trim();
    let priorPeriodForAudit: { id: string; name: string; endDate: Date } | null = null;
    if (isManual) {
      const setting = await prisma.appSetting.findUnique({
        where: { key: "accounting.manualEntries.policy" },
        select: { value: true },
      });
      const raw = (setting?.value ?? null) as Record<string, unknown> | null;
      const periodBasisRaw = String(raw?.periodBasis || DEFAULT_MANUAL_POLICY.periodBasis).toUpperCase();
      const periodBasis = periodBasisRaw === "FISCAL_PERIOD_END" ? "FISCAL_PERIOD_END" : "MONTHLY_CALENDAR";
      const policy: {
        periodBasis: "MONTHLY_CALENDAR" | "FISCAL_PERIOD_END";
        periodEndWindowDays: number;
        requireExceptionOutsideWindow: boolean;
        minExceptionNoteLength: number;
      } = {
        periodBasis,
        periodEndWindowDays: Number(raw?.periodEndWindowDays ?? DEFAULT_MANUAL_POLICY.periodEndWindowDays),
        requireExceptionOutsideWindow:
          typeof raw?.requireExceptionOutsideWindow === "boolean"
            ? raw.requireExceptionOutsideWindow
            : DEFAULT_MANUAL_POLICY.requireExceptionOutsideWindow,
        minExceptionNoteLength: Number(raw?.minExceptionNoteLength ?? DEFAULT_MANUAL_POLICY.minExceptionNoteLength),
      };
      const normalizedWindowDays = Number.isFinite(policy.periodEndWindowDays)
        ? Math.max(0, Math.min(31, Math.floor(policy.periodEndWindowDays)))
        : DEFAULT_MANUAL_POLICY.periodEndWindowDays;
      const normalizedMinNote = Number.isFinite(policy.minExceptionNoteLength)
        ? Math.max(8, Math.min(200, Math.floor(policy.minExceptionNoteLength)))
        : DEFAULT_MANUAL_POLICY.minExceptionNoteLength;

      manualPeriodBasisForAudit = policy.periodBasis;

      let isWithinPeriodEndWindow = false;
      if (policy.periodBasis === "MONTHLY_CALENDAR") {
        const year = entryDate.getUTCFullYear();
        const month = entryDate.getUTCMonth();
        const monthEnd = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
        const daysToMonthEnd = Math.max(
          0,
          Math.floor((monthEnd.getTime() - entryDate.getTime()) / (24 * 60 * 60 * 1000)),
        );
        isWithinPeriodEndWindow = daysToMonthEnd <= normalizedWindowDays;
      } else {
        const period = await prisma.fiscalPeriod.findFirst({
          where: {
            startDate: { lte: entryDate },
            endDate: { gte: entryDate },
          },
          select: { id: true, name: true, endDate: true },
        });
        isWithinPeriodEndWindow = Boolean(
          period &&
            Math.abs(
              Math.floor((period.endDate.getTime() - entryDate.getTime()) / (24 * 60 * 60 * 1000)),
            ) <= normalizedWindowDays,
        );
      }
      const exceptionNote = String(parsed.data.manualExceptionNote || "").trim();
      if (
        policy.requireExceptionOutsideWindow &&
        !isWithinPeriodEndWindow &&
        exceptionNote.length < normalizedMinNote
      ) {
        return NextResponse.json(
          {
            error: `Manual entries outside period-end window require an exception note (${normalizedMinNote}+ chars).`,
          },
          { status: 400 },
        );
      }
      if (priorPeriodId) {
        const priorPeriod = await prisma.fiscalPeriod.findUnique({
          where: { id: priorPeriodId },
          select: { id: true, name: true, status: true, startDate: true, endDate: true },
        });
        if (!priorPeriod) {
          return NextResponse.json(
            { error: "Selected prior period was not found." },
            { status: 400 },
          );
        }
        if (priorPeriod.status !== "CLOSED") {
          return NextResponse.json(
            { error: "Prior-period adjustment requires a closed fiscal period reference." },
            { status: 400 },
          );
        }
        const activeOpenPeriod = await prisma.fiscalPeriod.findFirst({
          where: {
            status: "OPEN",
            startDate: { lte: entryDate },
            endDate: { gte: entryDate },
          },
          select: { id: true, name: true },
        });
        if (!activeOpenPeriod) {
          return NextResponse.json(
            { error: "Prior-period adjustments must be dated in a currently open fiscal period." },
            { status: 400 },
          );
        }
        if (entryDate.getTime() <= priorPeriod.endDate.getTime()) {
          return NextResponse.json(
            { error: "Prior-period adjustment entry date must be after the referenced closed period end date." },
            { status: 400 },
          );
        }
        if (priorPeriodNote.length < 12) {
          return NextResponse.json(
            { error: "Prior-period adjustment requires an amendment note of at least 12 characters." },
            { status: 400 },
          );
        }
        priorPeriodForAudit = {
          id: priorPeriod.id,
          name: priorPeriod.name,
          endDate: priorPeriod.endDate,
        };
      }
    }
    if (isManual) {
      const policy = await loadAccountingJournalPolicy();
      const allowPnl = policy.manualEntryAllowPnl;
      const accountIds = Array.from(
        new Set(parsed.data.lines.map((line) => line.accountId)),
      );
      const accounts = await prisma.ledgerAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, type: true },
      });
      const typesById = new Map(accounts.map((acc) => [acc.id, acc.type]));
      const invalid = accountIds.filter((id) => {
        const type = typesById.get(id);
        if (!type) return true;
        if (allowPnl) return false;
        return type === "INCOME" || type === "EXPENSE";
      });
      if (invalid.length > 0) {
        return NextResponse.json(
          {
            error:
              "Manual entries cannot post to Income/Expense accounts under current journal policy.",
          },
          { status: 400 },
        );
      }
    }

    const closedPeriod = await findClosedPeriod(entryDate);
    if (closedPeriod) {
      return NextResponse.json(
        { error: `Period "${closedPeriod.name}" is closed.` },
        { status: 400 },
      );
    }

    const entry = await prisma.journalEntry.create({
      data: {
        entryDate,
        memo: parsed.data.memo,
        sourceType: parsed.data.sourceType,
        sourceId:
          parsed.data.sourceType === "MANUAL"
            ? `MANUAL:${parsed.data.manualCategory || "OTHER_EXCEPTION"}`
            : normalizedSourceId || null,
        status: parsed.data.status ?? "POSTED",
        approvedById: parsed.data.status === "POSTED" ? (session.user as AuthenticatedUser).id : null,
        approvedAt: parsed.data.status === "POSTED" ? new Date() : null,
        lines: {
          create: parsed.data.lines.map((line) => ({
            accountId: line.accountId,
            debit: line.debit,
            credit: line.credit,
            description: line.description,
            taxCodeId: line.taxCodeId ?? null,
          })),
        },
      },
      include: {
        lines: true,
      },
    });
    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: parsed.data.status === "POSTED" ? "journal.post" : "journal.create",
      entityType: "JournalEntry",
      entityId: entry.id,
      meta: {
        status: parsed.data.status ?? "POSTED",
        manualCategory: parsed.data.manualCategory ?? null,
        manualPeriodBasis: manualPeriodBasisForAudit,
        manualExceptionNote: parsed.data.manualExceptionNote
          ? `[len:${parsed.data.manualExceptionNote.trim().length}]`
          : null,
        priorPeriodId: priorPeriodForAudit?.id || null,
        priorPeriodName: priorPeriodForAudit?.name || null,
        priorPeriodEndDate: priorPeriodForAudit?.endDate?.toISOString() || null,
        priorPeriodNote: priorPeriodNote ? `[len:${priorPeriodNote.length}]` : null,
      },
    });
    if (priorPeriodForAudit) {
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: "fiscal-period.prior_adjustment.note",
        entityType: "FiscalPeriod",
        entityId: priorPeriodForAudit.id,
        meta: {
          journalEntryId: entry.id,
          journalStatus: parsed.data.status ?? "POSTED",
          memo: (parsed.data.memo || "").slice(0, 200),
          priorPeriodNote: priorPeriodNote.slice(0, 300),
        },
      });
    }
    return NextResponse.json(entry);
  } catch (error) {
    console.error("Accounting journal create error:", error);
    return NextResponse.json({ error: "Failed to create journal entry" }, { status: 500 });
  }
}
