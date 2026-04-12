import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
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

const expenseUpdateSchema = z
  .object({
    category: z.string().min(2).optional(),
    amount: z.number().optional(),
    vendor: z.string().optional(),
    reason: z.string().optional(),
    note: z.string().optional(),
    payNow: z.boolean().optional(),
    paymentMode: z.enum(["cash", "bank", "momo"]).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.reason || data.reason.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Reason is required for updates.",
      });
    }
    if (data.payNow && !data.paymentMode) {
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
  const withoutExisting = base.replace(/\n?Settlement:.*$/i, "").trim();
  if (!withoutExisting) return settlementText;
  return `${withoutExisting}\n${settlementText}`;
}

function parseAuditMeta(meta: string | null) {
  if (!meta) return null;
  try {
    return JSON.parse(meta) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function recordBlockedExpenseAction(params: {
  actorId?: string | null;
  request: Request;
  action: "EXPENSE_UPDATE_BLOCKED" | "EXPENSE_DELETE_BLOCKED" | "EXPENSE_SETTLE_BLOCKED";
  expenseId: string;
  reason: string;
  createdAt?: Date | null;
  category?: string | null;
  amount?: number | null;
  payrollRunId?: string | null;
  settlementCount?: number;
  reversalCount?: number;
  lockCode?: string | null;
}) {
  try {
    await recordAuditLog({
      actorId: params.actorId || null,
      action: params.action,
      entityType: "EXPENSE",
      entityId: params.expenseId,
      request: params.request,
      outcome: "FAILED",
      meta: {
        sourcePage: "admin/expenses",
        expenseId: params.expenseId,
        reason: params.reason,
        category: params.category ?? null,
        amount: params.amount ?? null,
        createdAt: params.createdAt?.toISOString() ?? null,
        payrollRunId: params.payrollRunId ?? null,
        settlementCount: params.settlementCount ?? 0,
        reversalCount: params.reversalCount ?? 0,
        lockCode: params.lockCode ?? null,
      },
    });
  } catch {
    // best-effort
  }
}

async function getExpenseMutationFacts(expenseId: string) {
  const expense = await prisma.expense.findUnique({
    where: { id: expenseId },
    select: {
      id: true,
      createdAt: true,
      deletedAt: true,
      isReversal: true,
      amount: true,
      category: true,
      note: true,
      reason: true,
      vendor: true,
      payrollRunId: true,
      reversalOfId: true,
    },
  });
  if (!expense) return null;

  const [reversalCount, settlementCount] = await Promise.all([
    prisma.expense.count({
      where: {
        reversalOfId: expenseId,
        isReversal: true,
        deletedAt: null,
      },
    }),
    prisma.journalEntry.count({
      where: {
        sourceType: "EXPENSE",
        sourceId: { startsWith: `${expenseId}:settlement:` },
        status: "POSTED",
      },
    }),
  ]);

  const mutationState = getExpenseMutationState({
    createdAt: expense.createdAt,
    deletedAt: expense.deletedAt,
    isReversal: expense.isReversal,
    payrollRunId: expense.payrollRunId,
    reversalCount,
    settlementCount,
  });

  return {
    expense,
    reversalCount,
    settlementCount,
    mutationState,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as AuthenticatedUser;
  const role = user.role;
  if (role !== "ADMIN" && role !== "ACCOUNTANT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const facts = await getExpenseMutationFacts(id);
  if (!facts || facts.expense.deletedAt) {
    return NextResponse.json({ error: "Expense not found" }, { status: 404 });
  }

  const expenseId = facts.expense.id;
  const [original, reversals, relatedEntries, auditLogs] = await Promise.all([
    facts.expense.reversalOfId
      ? prisma.expense.findUnique({
          where: { id: facts.expense.reversalOfId },
          select: {
            id: true,
            category: true,
            amount: true,
            vendor: true,
            reason: true,
            note: true,
            createdAt: true,
            deletedAt: true,
          },
        })
      : Promise.resolve(null),
    prisma.expense.findMany({
      where: {
        reversalOfId: expenseId,
        isReversal: true,
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        category: true,
        amount: true,
        vendor: true,
        reason: true,
        note: true,
        createdAt: true,
      },
    }),
    prisma.journalEntry.findMany({
      where: {
        sourceType: "EXPENSE",
        OR: [
          { sourceId: expenseId },
          { sourceId: { startsWith: `${expenseId}:settlement:` } },
        ],
      },
      orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        sourceId: true,
        memo: true,
        entryDate: true,
        createdAt: true,
        status: true,
        lines: {
          select: {
            debit: true,
            credit: true,
            description: true,
            account: {
              select: {
                code: true,
                name: true,
              },
            },
          },
        },
      },
    }),
    prisma.auditLog.findMany({
      where: {
        entityType: "EXPENSE",
        entityId: expenseId,
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        action: true,
        outcome: true,
        meta: true,
        createdAt: true,
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    }),
  ]);

  const settlementEntries = relatedEntries.filter((entry) =>
    String(entry.sourceId || "").startsWith(`${expenseId}:settlement:`)
  );
  const settlementPaid = settlementEntries.reduce(
    (sum, entry) => sum + entry.lines.reduce((lineSum, line) => lineSum + Number(line.debit || 0), 0),
    0,
  );
  const originalAmount = Number(facts.expense.amount || 0);
  const reversedAmount = Math.abs(reversals.reduce((sum, row) => sum + Number(row.amount || 0), 0));
  const remainingAfterReversals = Math.max(0, originalAmount - reversedAmount);

  return NextResponse.json({
    expense: {
      ...facts.expense,
      amount: Number(facts.expense.amount),
      mutationLocked: facts.mutationState.mutationLocked,
      canEdit: facts.mutationState.canEdit,
      canDelete: facts.mutationState.canDelete,
      canReverse: facts.mutationState.canReverse,
      canSettle: facts.mutationState.canSettle,
      lockCode: facts.mutationState.lockCode,
      lockReason: facts.mutationState.lockReason,
      settlementCount: facts.settlementCount,
      reversalCount: facts.reversalCount,
    },
    original:
      original && !original.deletedAt
        ? {
            ...original,
            amount: Number(original.amount),
          }
        : null,
    reversals: reversals.map((row) => ({
      ...row,
      amount: Number(row.amount),
    })),
    journals: relatedEntries.map((entry) => ({
      ...entry,
      lines: entry.lines.map((line) => ({
        ...line,
        debit: Number(line.debit),
        credit: Number(line.credit),
      })),
    })),
    audits: auditLogs.map((row) => ({
      id: row.id,
      action: row.action,
      outcome: row.outcome,
      createdAt: row.createdAt,
      actor: row.actor,
      meta: parseAuditMeta(row.meta),
    })),
    metrics: {
      originalAmount,
      settlementPaid,
      settlementOutstanding: Math.max(0, originalAmount - settlementPaid),
      reversedAmount,
      remainingAfterReversals,
    },
  });
}

export async function PATCH(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id: paramId } = await params;
  let expenseId: string | undefined = paramId;
  const user = session.user as AuthenticatedUser;
  const role = user.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!isAdmin && !isAccountant) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(_req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(_req, "admin-expense-update", 60_000, 120);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const body = await _req.json();
    if (!expenseId || expenseId === "undefined" || expenseId === "null") {
      const fallback = typeof body?.id === "string" ? body.id.trim() : "";
      expenseId = fallback || undefined;
    }
    if (!expenseId) {
      return NextResponse.json({ error: "Missing expense id" }, { status: 400 });
    }
    const parsed = expenseUpdateSchema.safeParse({
      ...body,
      amount: body.amount === undefined ? undefined : Number(body.amount),
      payNow: body.payNow === undefined ? undefined : Boolean(body.payNow),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    if (parsed.data.category && isSystemDrivenExpenseCategory(parsed.data.category)) {
      return NextResponse.json(
        {
          error:
            "This category is system-driven (COGS, Payroll Expense, Cash Over/Short) and cannot be posted from manual Expenses.",
        },
        { status: 400 },
      );
    }
    if (parsed.data.category) {
      const categoryCheck = await validateExpenseCategorySelection(parsed.data.category);
      if (!categoryCheck.ok) {
        return NextResponse.json({ error: categoryCheck.error }, { status: 400 });
      }
    }

    const facts = await getExpenseMutationFacts(expenseId);
    if (!facts || facts.expense.deletedAt) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }
    const { expense: existing, mutationState, settlementCount, reversalCount } = facts;
    if (mutationState.mutationLocked) {
      await recordBlockedExpenseAction({
        actorId: user.id,
        request: _req,
        action: "EXPENSE_UPDATE_BLOCKED",
        expenseId,
        reason: mutationState.lockReason || "Expense is locked.",
        createdAt: existing.createdAt,
        category: existing.category,
        amount: Number(existing.amount),
        payrollRunId: existing.payrollRunId,
        settlementCount,
        reversalCount,
        lockCode: mutationState.lockCode,
      });
      return NextResponse.json(
        { error: mutationState.lockReason || "Expense is locked." },
        { status: 403 }
      );
    }
    if (parsed.data.amount !== undefined && !existing.isReversal && parsed.data.amount <= 0) {
      return NextResponse.json(
        { error: "Amount must be positive for expenses." },
        { status: 400 }
      );
    }
    if (parsed.data.amount !== undefined && existing.isReversal && parsed.data.amount >= 0) {
      return NextResponse.json(
        { error: "Reversal amount must be negative." },
        { status: 400 }
      );
    }

    const { payNow, paymentMode, ...updatableFields } = parsed.data;
    const nextNote =
      payNow !== undefined
        ? appendSettlementContext(parsed.data.note, payNow, paymentMode)
        : parsed.data.note;

    const updated = await prisma.expense.update({
      where: { id: expenseId },
      data: {
        ...updatableFields,
        note: nextNote,
      },
      select: {
        id: true,
        amount: true,
        category: true,
        note: true,
        reason: true,
        createdAt: true,
        isReversal: true,
      },
    });

    // Re-post journal entry if amount or category changed within the edit window.
    // Void the old POSTED entry so ensureEntry will create a fresh one.
    const amountChanged =
      parsed.data.amount !== undefined &&
      Number(parsed.data.amount) !== Number(existing.amount);
    const categoryChanged =
      parsed.data.category !== undefined &&
      parsed.data.category !== existing.category;
    if (amountChanged || categoryChanged) {
      try {
        const oldEntry = await prisma.journalEntry.findFirst({
          where: { sourceType: "EXPENSE", sourceId: expenseId, status: "POSTED" },
          select: { id: true },
        });
        if (oldEntry) {
          await prisma.journalEntry.update({
            where: { id: oldEntry.id },
            data: { status: "VOID" },
          });
        }
        await postExpenseEntry({
          expenseId: updated.id,
          amount: Number(updated.amount),
          createdAt: updated.createdAt,
          category: updated.category,
          note: updated.note || updated.reason || updated.category,
          isReversal: updated.isReversal ?? false,
        });
      } catch (e) {
        console.warn("Journal re-post after expense edit failed:", e);
      }
    }

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "EXPENSE_UPDATE",
        entityType: "EXPENSE",
        entityId: expenseId,
        request: _req,
        meta: {
          sourcePage: "admin/expenses",
          expenseId,
          previousAmount: Number(existing.amount),
          previousCategory: existing.category,
          previousNote: existing.note ?? null,
          previousVendor: existing.vendor ?? null,
          settlementCount,
          reversalCount,
          newAmount: Number(updated.amount),
          newCategory: updated.category,
          newNote: updated.note ?? null,
          amountChanged,
          categoryChanged,
          journalReposted: amountChanged || categoryChanged,
          reason: parsed.data.reason ?? null,
          payNow: payNow ?? null,
          paymentMode: paymentMode ?? null,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json(updated);
  } catch (err) {
    console.error("Error updating expense:", err);
    const message = err instanceof Error ? err.message : "Failed to update expense";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const user = session.user as AuthenticatedUser;
  const role = user.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!isAdmin && !isAccountant) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(_req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  try {
    const facts = await getExpenseMutationFacts(id);
    if (!facts || facts.expense.deletedAt) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }
    const { expense: existing, mutationState, settlementCount, reversalCount } = facts;
    if (mutationState.mutationLocked) {
      await recordBlockedExpenseAction({
        actorId: user.id,
        request: _req,
        action: "EXPENSE_DELETE_BLOCKED",
        expenseId: id,
        reason: mutationState.lockReason || "Expense is locked.",
        createdAt: existing.createdAt,
        category: existing.category,
        amount: Number(existing.amount),
        payrollRunId: existing.payrollRunId,
        settlementCount,
        reversalCount,
        lockCode: mutationState.lockCode,
      });
      return NextResponse.json(
        { error: mutationState.lockReason || "Expense is locked." },
        { status: 403 }
      );
    }
    await prisma.expense.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "EXPENSE_DELETE",
        entityType: "EXPENSE",
        entityId: id,
        request: _req,
        meta: {
          sourcePage: "admin/expenses",
          expenseId: id,
          category: existing.category,
          amount: Number(existing.amount),
          vendor: existing.vendor ?? null,
          reason: existing.reason ?? null,
          createdAt: existing.createdAt.toISOString(),
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Error deleting expense:", err);
    return NextResponse.json(
      { error: "Failed to delete expense" },
      { status: 500 }
    );
  }
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const user = session.user as AuthenticatedUser;
  const role = user.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!isAdmin && !isAccountant) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(_req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(_req, "admin-expense-restore", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const existing = await prisma.expense.findUnique({
      where: { id },
      select: {
        id: true,
        deletedAt: true,
        category: true,
        amount: true,
        vendor: true,
      },
    });
    if (!existing) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }
    if (!existing.deletedAt) {
      return NextResponse.json({ error: "Expense is not deleted" }, { status: 400 });
    }
    await prisma.expense.update({
      where: { id },
      data: { deletedAt: null },
    });

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "EXPENSE_RESTORE",
        entityType: "EXPENSE",
        entityId: id,
        request: _req,
        meta: {
          sourcePage: "admin/expenses",
          expenseId: id,
          category: existing.category,
          amount: Number(existing.amount),
          vendor: existing.vendor ?? null,
          restoredAt: new Date().toISOString(),
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Error restoring expense:", err);
    return NextResponse.json(
      { error: "Failed to restore expense" },
      { status: 500 }
    );
  }
}
