import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { formatCurrency } from "@/lib/currency";
import { postExpenseEntry } from "@/lib/accounting-posting";
import { getExpenseMutationState } from "@/lib/expense-admin";

const SYSTEM_DRIVEN_EXPENSE_CODES = new Set(["5000", "6100", "6990"]);
const SYSTEM_DRIVEN_EXPENSE_NAME_PATTERNS = [
  /cost of goods sold/i,
  /payroll expense/i,
  /cash over\/short/i,
];

function isSystemDrivenExpenseCategory(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const code = raw.match(/^(\d{4})\b/)?.[1] || "";
  if (SYSTEM_DRIVEN_EXPENSE_CODES.has(code)) return true;
  return SYSTEM_DRIVEN_EXPENSE_NAME_PATTERNS.some((rx) => rx.test(raw));
}

async function validateExpenseCategorySelection(value: string) {
  const raw = String(value || "").trim();
  const code = raw.match(/^(\d{4})\b/)?.[1] || "";
  if (!code) {
    return { ok: false as const, error: "Select a category that starts with a 4-digit account code." };
  }
  const account = await prisma.ledgerAccount.findUnique({
    where: { code },
    select: { id: true, type: true, isActive: true },
  });
  if (!account || account.type !== "EXPENSE" || !account.isActive) {
    return { ok: false as const, error: `Expense account ${code} is missing or inactive.` };
  }
  if (SYSTEM_DRIVEN_EXPENSE_CODES.has(code)) {
    return {
      ok: false as const,
      error:
        "This category is system-driven (COGS, Payroll Expense, Cash Over/Short) and cannot be posted from manual Expenses.",
    };
  }
  return { ok: true as const, code };
}

const expenseSchema = z
  .object({
    category: z.string().min(2, "Category is required"),
    amount: z.number(),
    vendor: z.string().optional(),
    reason: z.string().optional(),
    note: z.string().optional(),
    payNow: z.boolean().optional(),
    paymentMode: z.enum(["cash", "bank", "momo"]).optional(),
    isReversal: z.boolean().optional(),
    reversalOfId: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.isReversal) {
      if (!data.reversalOfId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reversalOfId"],
          message: "Reversal must reference the original expense.",
        });
      }
      if (!data.reason || data.reason.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reason"],
          message: "Reason is required for reversals.",
        });
      }
      if (!(Number(data.amount) < 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["amount"],
          message: "Reversal amount must be negative.",
        });
      }
    } else if (!(Number(data.amount) > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "Amount must be positive.",
      });
    }
    if (!data.isReversal && data.payNow && !data.paymentMode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paymentMode"],
        message: "Payment mode is required when paying now.",
      });
    }
  });

function appendSettlementContext(note: string | undefined, payNow: boolean, paymentMode?: "cash" | "bank" | "momo") {
  const base = String(note || "").trim();
  const settlementText = payNow
    ? paymentMode === "bank"
      ? "Settlement: bank transfer (paid now)"
      : paymentMode === "momo"
      ? "Settlement: MoMo (paid now)"
      : "Settlement: cash (paid now)"
    : "Settlement: accrued (unpaid)";
  if (!base) return settlementText;
  if (base.toLowerCase().includes("settlement:")) return base;
  return `${base}\n${settlementText}`;
}

type ExpenseSortBy = "createdAt" | "category" | "vendor" | "amount" | "settlementStatus";
type ExpenseSortDir = "asc" | "desc";

function parsePositiveInt(value: string | null, fallback: number, max = 500) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normalizeExpenseSortBy(value: string | null): ExpenseSortBy {
  return value === "category" ||
    value === "vendor" ||
    value === "amount" ||
    value === "settlementStatus"
    ? value
    : "createdAt";
}

function normalizeExpenseSortDir(value: string | null): ExpenseSortDir {
  return value === "asc" ? "asc" : "desc";
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as AuthenticatedUser;
  const role = user.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!isAdmin && !isAccountant) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-expense-create", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const body = await req.json();
    const parsed = expenseSchema.safeParse({
      ...body,
      amount: Number(body.amount),
      isReversal: Boolean(body.isReversal),
      payNow: body.payNow === undefined ? undefined : Boolean(body.payNow),
      reversalOfId: typeof body.reversalOfId === "string" ? body.reversalOfId : undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    if (isSystemDrivenExpenseCategory(parsed.data.category)) {
      return NextResponse.json(
        {
          error:
            "This category is system-driven (COGS, Payroll Expense, Cash Over/Short) and cannot be posted from manual Expenses.",
        },
        { status: 400 },
      );
    }
    const categoryCheck = await validateExpenseCategorySelection(parsed.data.category);
    if (!categoryCheck.ok) {
      return NextResponse.json({ error: categoryCheck.error }, { status: 400 });
    }

    if (parsed.data.isReversal && parsed.data.reversalOfId) {
      const original = await prisma.expense.findUnique({
        where: { id: parsed.data.reversalOfId },
        select: { id: true, amount: true, isReversal: true },
      });
      if (!original) {
        return NextResponse.json({ error: "Original expense not found for reversal." }, { status: 400 });
      }
      if (original.isReversal) {
        return NextResponse.json({ error: "Cannot reverse a reversal entry." }, { status: 400 });
      }
      const reversalTotals = await prisma.expense.aggregate({
        where: {
          reversalOfId: parsed.data.reversalOfId,
          isReversal: true,
          deletedAt: null,
        },
        _sum: { amount: true },
      });
      const reversedSoFar = Math.abs(Number(reversalTotals._sum.amount ?? 0));
      const originalAmount = Number(original.amount);
      const remaining = Math.max(0, originalAmount - reversedSoFar);
      const requested = Math.abs(Number(parsed.data.amount));
      if (remaining <= 0) {
        return NextResponse.json(
          { error: "Reversal limit reached for this expense." },
          { status: 400 }
        );
      }
      if (requested > remaining) {
        return NextResponse.json(
          { error: `Reversal amount exceeds remaining balance (${remaining.toFixed(2)}).` },
          { status: 400 }
        );
      }
    }

    const payNow = Boolean(parsed.data.payNow);
    const paymentMode = parsed.data.paymentMode;
    const noteWithSettlement = parsed.data.isReversal
      ? parsed.data.note
      : appendSettlementContext(parsed.data.note, payNow, paymentMode);

    const expense = await prisma.expense.create({
      data: {
        category: parsed.data.category,
        amount: parsed.data.amount,
        vendor: parsed.data.vendor,
        reason: parsed.data.reason,
        note: noteWithSettlement,
        isReversal: Boolean(parsed.data.isReversal),
        reversalOfId: parsed.data.reversalOfId || null,
      },
    });

    let expenseJournalEntryId: string | null = null;
    try {
      const posted = await postExpenseEntry({
        expenseId: expense.id,
        amount: Number(expense.amount),
        createdAt: expense.createdAt,
        category: expense.category,
        note: expense.note || expense.reason || expense.category,
        isReversal: expense.isReversal,
      });
      expenseJournalEntryId = posted?.id ?? null;
    } catch (e) {
      console.warn("Accounting expense posting skipped:", e);
    }

    const settlementType = expense.isReversal
      ? null
      : payNow
      ? "PAID_NOW"
      : "ACCRUED";
    const settlementStatus = expense.isReversal
      ? null
      : payNow
      ? "PAID"
      : "UNPAID";
    const paymentJournalEntryId =
      !expense.isReversal && payNow ? expenseJournalEntryId : null;
    const noteSummary = String(expense.note || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" | ") || null;

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "EXPENSE_CREATE",
        entityType: "EXPENSE",
        entityId: expense.id,
        request: req,
        meta: {
          sourcePage: "admin/expenses",
          expenseId: expense.id,
          createdAt: expense.createdAt.toISOString(),
          category: expense.category,
          amount: Number(expense.amount),
          vendor: expense.vendor ?? null,
          reason: expense.reason ?? null,
          note: expense.note ?? null,
          noteSummary,
          payNow: parsed.data.isReversal ? null : payNow,
          paymentMode: parsed.data.isReversal ? null : paymentMode || null,
          settlementType,
          settlementStatus,
          journalEntryId: expenseJournalEntryId,
          paymentJournalEntryId,
          isReversal: expense.isReversal ?? false,
          reversalOfId: expense.reversalOfId ?? null,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json(expense);
  } catch (err) {
    console.error("Error creating expense:", err);
    return NextResponse.json(
      { error: "Failed to create expense" },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as AuthenticatedUser;
  const role = user.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!isAdmin && !isAccountant) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const category = searchParams.get("category");
    const q = searchParams.get("q");
    const sourceIdRaw = searchParams.get("sourceId");
    const sourceId = sourceIdRaw ? String(sourceIdRaw).trim().split(":")[0] : "";
    const qExactId = /^[a-z0-9]{20,}$/i.test(String(q || "").trim())
      ? String(q || "").trim().split(":")[0]
      : "";
    const settlementState = searchParams.get("settlementState");
    const format = searchParams.get("format");
    const page = parsePositiveInt(searchParams.get("page"), 1, 1_000_000);
    const pageSize = parsePositiveInt(searchParams.get("pageSize"), 50, 200);
    const sortBy = normalizeExpenseSortBy(searchParams.get("sortBy"));
    const sortDir = normalizeExpenseSortDir(searchParams.get("sortDir"));

    const where: {
      category?: { contains: string; mode: "insensitive" };
      vendor?: { contains: string; mode: "insensitive" };
      OR?: Array<{
        id?: string;
        note?: { contains: string; mode: "insensitive" };
        category?: { contains: string; mode: "insensitive" };
        vendor?: { contains: string; mode: "insensitive" };
        reason?: { contains: string; mode: "insensitive" };
      }>;
      createdAt?: { gte?: Date; lte?: Date };
      deletedAt?: null;
      id?: string;
    } = {};
    where.deletedAt = null;
    if (category) where.category = { contains: category, mode: "insensitive" };
    const vendor = searchParams.get("vendor");
    if (vendor) where.vendor = { contains: vendor, mode: "insensitive" };
    if (q && !qExactId)
      where.OR = [
        { id: q },
        { note: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
        { vendor: { contains: q, mode: "insensitive" } },
        { reason: { contains: q, mode: "insensitive" } },
      ];
    if (sourceId) where.id = sourceId;
    else if (qExactId) where.id = qExactId;
    if (start || end) {
      where.createdAt = {};
      if (start) where.createdAt.gte = new Date(start);
      if (end) {
        const to = new Date(end);
        // include the entire end day
        to.setHours(23, 59, 59, 999);
        where.createdAt.lte = to;
      }
    }

    const items = await prisma.expense.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    const originalIds = items.filter((item) => !item.isReversal).map((item) => item.id);
    const reversalTotals = originalIds.length
      ? await prisma.expense.groupBy({
        by: ["reversalOfId"],
        where: {
          reversalOfId: { in: originalIds },
          isReversal: true,
          deletedAt: null,
        },
        _sum: { amount: true },
        _count: { _all: true },
      })
      : [];
    const reversalMap = new Map(
      reversalTotals
        .filter((row) => row.reversalOfId)
        .map((row) => [row.reversalOfId as string, Number(row._sum.amount ?? 0)])
    );
    const reversalCountMap = new Map(
      reversalTotals
        .filter((row) => row.reversalOfId)
        .map((row) => [row.reversalOfId as string, Number(row._count?._all ?? 0)])
    );
    // Scope settlement entry query to the current result set so large databases
    // don't have to scan every settlement entry on every page load.
    const settlementEntries = originalIds.length
      ? await prisma.journalEntry.findMany({
          where: {
            sourceType: "EXPENSE",
            status: "POSTED",
            OR: originalIds.map((id) => ({
              sourceId: { startsWith: `${id}:settlement:` },
            })),
          },
          select: {
            sourceId: true,
            createdAt: true,
            lines: { select: { debit: true } },
          },
        })
      : [];
    const settlementMap = new Map<string, number>();
    const settlementCountMap = new Map<string, number>();
    const latestSettlementAtMap = new Map<string, string>();
    for (const entry of settlementEntries) {
      const sourceId = String(entry.sourceId || "");
      const expenseId = sourceId.split(":settlement:")[0] || "";
      if (!expenseId) continue;
      const settlementAmount = (entry.lines || []).reduce((sum, line) => sum + Number(line.debit || 0), 0);
      if (!(settlementAmount > 0)) continue;
      settlementMap.set(expenseId, (settlementMap.get(expenseId) || 0) + settlementAmount);
      settlementCountMap.set(expenseId, (settlementCountMap.get(expenseId) || 0) + 1);
      const iso = new Date(entry.createdAt).toISOString();
      const prev = latestSettlementAtMap.get(expenseId) || "";
      if (!prev || new Date(iso).getTime() > new Date(prev).getTime()) {
        latestSettlementAtMap.set(expenseId, iso);
      }
    }
    const itemsWithRemaining = items.map((item) => {
      if (item.isReversal) {
        const mutationState = getExpenseMutationState({
          createdAt: item.createdAt,
          deletedAt: item.deletedAt,
          isReversal: item.isReversal,
          payrollRunId: item.payrollRunId,
          reversalCount: 0,
          settlementCount: 0,
        });
        return {
          ...item,
          reversalRemaining: null,
          reversedSoFar: null,
          reversalCount: 0,
          settlementCount: 0,
          settlementPaid: null,
          settlementOutstanding: null,
          settlementStatus: null,
          settlementLastPaidAt: null,
          mutationLocked: mutationState.mutationLocked,
          canEdit: mutationState.canEdit,
          canDelete: mutationState.canDelete,
          canReverse: mutationState.canReverse,
          canSettle: mutationState.canSettle,
          lockCode: mutationState.lockCode,
          lockReason: mutationState.lockReason,
        };
      }
      const reversedSoFar = Math.abs(reversalMap.get(item.id) ?? 0);
      const reversalCount = reversalCountMap.get(item.id) ?? 0;
      const originalAmount = Number(item.amount);
      const remaining = Math.max(0, originalAmount - reversedSoFar);
      const noteText = String(item.note || "");
      const hasSettlementJournal = settlementMap.has(item.id);
      const settlementCount = settlementCountMap.get(item.id) ?? 0;
      const isAccrualTracked = /settlement:\s*accrued/i.test(noteText) || hasSettlementJournal;
      const paidRaw = settlementMap.get(item.id) ?? 0;
      const settlementPaid = isAccrualTracked ? Math.min(originalAmount, Math.max(0, paidRaw)) : null;
      const settlementOutstanding =
        isAccrualTracked && settlementPaid !== null
          ? Math.max(0, originalAmount - settlementPaid)
          : null;
      const settlementStatus =
        isAccrualTracked && settlementOutstanding !== null
          ? settlementPaid === 0
            ? "UNPAID"
            : settlementOutstanding > 0
            ? "PARTIALLY_PAID"
            : "PAID"
          : null;
      const mutationState = getExpenseMutationState({
        createdAt: item.createdAt,
        deletedAt: item.deletedAt,
        isReversal: item.isReversal,
        payrollRunId: item.payrollRunId,
        reversalCount,
        settlementCount,
      });
      return {
        ...item,
        reversalRemaining: remaining,
        reversedSoFar,
        reversalCount,
        settlementCount,
        settlementPaid,
        settlementOutstanding,
        settlementStatus,
        settlementLastPaidAt: latestSettlementAtMap.get(item.id) || null,
        mutationLocked: mutationState.mutationLocked,
        canEdit: mutationState.canEdit,
        canDelete: mutationState.canDelete,
        canReverse: mutationState.canReverse,
        canSettle: mutationState.canSettle,
        lockCode: mutationState.lockCode,
        lockReason: mutationState.lockReason,
      };
    });
    const stateFilter =
      settlementState === "UNPAID" || settlementState === "PARTIALLY_PAID" || settlementState === "PAID"
        ? settlementState
        : "";
    const filteredItems = stateFilter
      ? itemsWithRemaining.filter((item) => item.settlementStatus === stateFilter)
      : itemsWithRemaining;

    const sortedItems = [...filteredItems].sort((a, b) => {
      const direction = sortDir === "asc" ? 1 : -1;
      const settlementRank = (value: string | null | undefined) =>
        value === "UNPAID" ? 0 : value === "PARTIALLY_PAID" ? 1 : value === "PAID" ? 2 : 3;
      const aVal =
        sortBy === "amount"
          ? Number(a.amount)
          : sortBy === "category"
          ? String(a.category || "").toLowerCase()
          : sortBy === "vendor"
          ? String(a.vendor || "").toLowerCase()
          : sortBy === "settlementStatus"
          ? settlementRank(a.settlementStatus)
          : new Date(a.createdAt).getTime();
      const bVal =
        sortBy === "amount"
          ? Number(b.amount)
          : sortBy === "category"
          ? String(b.category || "").toLowerCase()
          : sortBy === "vendor"
          ? String(b.vendor || "").toLowerCase()
          : sortBy === "settlementStatus"
          ? settlementRank(b.settlementStatus)
          : new Date(b.createdAt).getTime();
      if (aVal < bVal) return -1 * direction;
      if (aVal > bVal) return 1 * direction;
      return direction * (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    });

    const totalAmount = filteredItems.reduce(
      (sum: number, e: { amount: unknown }) => sum + Number(e.amount),
      0
    );
    const totalCount = filteredItems.length;
    const grossAmount = filteredItems
      .filter((item) => !item.isReversal)
      .reduce((sum, item) => sum + Number(item.amount), 0);
    const reversalAmount = Math.abs(
      filteredItems
        .filter((item) => item.isReversal)
        .reduce((sum, item) => sum + Number(item.amount), 0)
    );
    const outstandingLiability = filteredItems
      .filter((item) => item.settlementStatus === "UNPAID" || item.settlementStatus === "PARTIALLY_PAID")
      .reduce((sum, item) => sum + Number(item.settlementOutstanding || 0), 0);
    const unpaidCount = filteredItems.filter(
      (item) => item.settlementStatus === "UNPAID" || item.settlementStatus === "PARTIALLY_PAID"
    ).length;
    const topCategories = Array.from(
      filteredItems
        .filter((item) => !item.isReversal)
        .reduce((acc, item) => {
          const key = String(item.category || "").trim();
          if (!key) return acc;
          acc.set(key, (acc.get(key) || 0) + 1);
          return acc;
        }, new Map<string, number>())
        .entries(),
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([category, count]) => ({ category, count }));
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const currentPage = Math.min(Math.max(1, page), totalPages);
    const pagedItems =
      format === "csv"
        ? sortedItems
        : sortedItems.slice((currentPage - 1) * pageSize, currentPage * pageSize);

    if (format === "csv") {
      const header = [
        "Date", "Category", "Amount (GHS)", "Amount (Raw)",
        "Vendor", "Reason",
        "Settlement Status", "Paid (GHS)", "Outstanding (GHS)",
        "Settlement Count", "Reversal Count", "Mutation Lock", "Lock Reason",
        "Note",
      ];
      const csvRows = sortedItems.map((e) => [
        new Date(e.createdAt).toISOString(),
        e.category.replaceAll("\"", "'"),
        formatCurrency(Number(e.amount)),
        Number(e.amount).toFixed(2),
        (e.vendor ?? "").replaceAll("\"", "'"),
        (e.reason ?? "").replaceAll("\"", "'"),
        e.settlementStatus ?? "",
        e.settlementPaid !== null ? Number(e.settlementPaid).toFixed(2) : "",
        e.settlementOutstanding !== null ? Number(e.settlementOutstanding).toFixed(2) : "",
        String(e.settlementCount ?? 0),
        String(e.reversalCount ?? 0),
        e.mutationLocked ? "Locked" : "Open",
        e.lockReason ?? "",
        (e.note ?? "").replaceAll("\"", "'"),
      ]);
      const csv = [header, ...csvRows]
        .map((r) => r.map((v) => `"${String(v).replaceAll('"', "'")}"`).join(","))
        .join("\n");
      const fileDate =
        start && end
          ? `${start}_to_${end}`
          : new Date().toISOString().slice(0, 10);
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename=expenses_${fileDate}.csv`,
        },
        });
    }

    return NextResponse.json({
      items: pagedItems,
      totalAmount,
      totalCount,
      page: currentPage,
      pageSize,
      totalPages,
      sortBy,
      sortDir,
      summary: {
        grossAmount,
        reversalAmount,
        netAmount: totalAmount,
        outstandingLiability,
        unpaidCount,
        topCategories,
      },
    });
  } catch (err) {
    console.error("Error listing expenses:", err);
    return NextResponse.json(
      { error: "Failed to list expenses" },
      { status: 500 }
    );
  }
}
