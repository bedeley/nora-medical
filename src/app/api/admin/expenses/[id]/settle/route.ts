import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { postExpenseSettlementEntry } from "@/lib/accounting-posting";
import { getExpenseMutationState } from "@/lib/expense-admin";

const settleSchema = z.object({
  paymentMode: z.enum(["cash", "bank", "momo"]),
  amount: z.number().positive(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function withSettlementNote(
  baseNote: string | null | undefined,
  paymentMode: "cash" | "bank" | "momo",
  paidAmount: number,
  totalAmount: number,
) {
  const now = new Date();
  const modeLabel = paymentMode === "bank" ? "bank transfer" : paymentMode === "momo" ? "MoMo" : "cash";
  const base = String(baseNote || "").trim();
  const cleaned = base.replace(/\n?Settlement:.*$/i, "").trim();
  const outstanding = Math.max(0, totalAmount - paidAmount);
  const paidOn = now.toISOString();
  const ratio = `${paidAmount.toFixed(2)}/${totalAmount.toFixed(2)}`;
  const settlementLine =
    outstanding > 0
      ? `Settlement: partially paid ${ratio}, via ${modeLabel}, on ${paidOn}`
      : `Settlement: paid ${ratio}, via ${modeLabel}, on ${paidOn}`;
  return cleaned ? `${cleaned}\n${settlementLine}` : settlementLine;
}

async function recordBlockedSettlement(params: {
  actorId?: string | null;
  request: Request;
  expenseId: string;
  reason: string;
  category?: string | null;
  amount?: number | null;
  createdAt?: Date | null;
  payrollRunId?: string | null;
  settlementCount?: number;
  reversalCount?: number;
  lockCode?: string | null;
}) {
  try {
    await recordAuditLog({
      actorId: params.actorId || null,
      action: "EXPENSE_SETTLE_BLOCKED",
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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-expense-settle", 60_000, 120);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const { id } = await params;
  const parsed = settleSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const expense = await prisma.expense.findUnique({
    where: { id },
    select: {
      id: true,
      amount: true,
      note: true,
      category: true,
      deletedAt: true,
      isReversal: true,
      createdAt: true,
      payrollRunId: true,
    },
  });
  if (!expense || expense.deletedAt) {
    return NextResponse.json({ error: "Expense not found" }, { status: 404 });
  }
  const reversalCount = await prisma.expense.count({
    where: {
      reversalOfId: expense.id,
      isReversal: true,
      deletedAt: null,
    },
  });
  const baseAccrualEntry = await prisma.journalEntry.findFirst({
    where: {
      sourceType: "EXPENSE",
      sourceId: expense.id,
      status: "POSTED",
      lines: {
        some: {
          credit: { gt: 0 },
          account: { code: "2300" },
        },
      },
    },
    select: { id: true },
  });
  const settlementEntries = await prisma.journalEntry.findMany({
    where: {
      sourceType: "EXPENSE",
      sourceId: { startsWith: `${expense.id}:settlement:` },
      status: "POSTED",
    },
    select: {
      id: true,
      lines: { select: { debit: true } },
    },
  });
  const settledSoFar = settlementEntries.reduce(
    (sum, entry) => sum + (entry.lines || []).reduce((lineSum, line) => lineSum + Number(line.debit || 0), 0),
    0,
  );
  const mutationState = getExpenseMutationState({
    createdAt: expense.createdAt,
    deletedAt: expense.deletedAt,
    isReversal: expense.isReversal,
    payrollRunId: expense.payrollRunId,
    reversalCount,
    settlementCount: settlementEntries.length,
  });
  if (!mutationState.canSettle) {
    await recordBlockedSettlement({
      actorId: user?.id,
      request: req,
      expenseId: expense.id,
      reason: mutationState.lockReason || "Expense cannot be settled from this page.",
      category: expense.category,
      amount: Number(expense.amount),
      createdAt: expense.createdAt,
      payrollRunId: expense.payrollRunId,
      settlementCount: settlementEntries.length,
      reversalCount,
      lockCode: mutationState.lockCode,
    });
    return NextResponse.json(
      { error: mutationState.lockReason || "Expense cannot be settled from this page." },
      { status: 400 },
    );
  }
  if (!baseAccrualEntry && settlementEntries.length === 0) {
    return NextResponse.json({ error: "Expense is not marked as accrued/unpaid." }, { status: 400 });
  }
  const outstanding = Math.max(0, Number(expense.amount || 0) - settledSoFar);
  if (!(outstanding > 0)) {
    return NextResponse.json({ error: "Expense accrual has already been fully settled." }, { status: 400 });
  }

  const paymentMode = parsed.data.paymentMode;
  const requestedAmount = Number(parsed.data.amount || 0);
  if (!(requestedAmount > 0)) {
    return NextResponse.json({ error: "Invalid expense amount for settlement." }, { status: 400 });
  }
  if (requestedAmount > outstanding) {
    return NextResponse.json(
      { error: `Payment exceeds outstanding amount (${outstanding.toFixed(2)}).` },
      { status: 400 },
    );
  }

  const settlementKey = `${Date.now()}`;
  const entry = await postExpenseSettlementEntry({
    expenseId: expense.id,
    amount: requestedAmount,
    createdAt: new Date(),
    settlementKey,
    paymentMode,
    memo: `Expense settlement - ${expense.category}`,
  });
  if (!entry) {
    return NextResponse.json({ error: "Failed to post settlement entry." }, { status: 500 });
  }

  const newPaidTotal = Math.min(Number(expense.amount || 0), settledSoFar + requestedAmount);
  const settlementSequence = settlementEntries.length + 1;
  const settlementStatusAfter = newPaidTotal >= Number(expense.amount || 0) ? "PAID" : "PARTIALLY_PAID";
  const settledAt = new Date().toISOString();
  const paymentModeLabel =
    paymentMode === "bank" ? "Bank transfer" : paymentMode === "momo" ? "MoMo" : "Cash";
  const updatedExpense = await prisma.expense.update({
    where: { id: expense.id },
    data: {
      note: withSettlementNote(
        expense.note,
        paymentMode,
        newPaidTotal,
        Number(expense.amount || 0),
      ),
    },
    select: { id: true, note: true },
  });

  await recordAuditLog({
    actorId: user?.id,
    action: "EXPENSE_SETTLE",
    entityType: "EXPENSE",
    entityId: expense.id,
    request: req,
    meta: {
      sourcePage: "admin/expenses",
      expenseId: expense.id,
      category: expense.category,
      settledAt,
      amount: requestedAmount,
      paidSoFar: newPaidTotal,
      outstanding: Math.max(0, Number(expense.amount || 0) - newPaidTotal),
      totalExpenseAmount: Number(expense.amount || 0),
      paymentMode,
      paymentModeLabel,
      settlementStatusAfter,
      settlementSequence,
      journalEntryId: entry.id,
    },
  });

  return NextResponse.json({
    ok: true,
    expenseId: expense.id,
    note: updatedExpense.note,
    journalEntryId: entry.id,
  });
}
