import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

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

export async function PATCH(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let expenseId = params?.id;
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

    const existing = await prisma.expense.findUnique({
      where: { id: expenseId },
      select: { createdAt: true, isReversal: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }
    if (existing.isReversal) {
      return NextResponse.json(
        { error: "Reversal entries are locked. Please create a new adjustment instead." },
        { status: 403 }
      );
    }
    const ageMs = Date.now() - new Date(existing.createdAt).getTime();
    const limitMs = 48 * 60 * 60 * 1000;
    if (ageMs > limitMs) {
      return NextResponse.json(
        { error: "Edits are locked after 48 hours. Please create a reversal instead." },
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
    });

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "EXPENSE_UPDATE",
        entityType: "EXPENSE",
        entityId: expenseId,
        meta: parsed.data,
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

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
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
  if (!assertSameOrigin(_req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  try {
    const existing = await prisma.expense.findUnique({
      where: { id: params.id },
      select: { createdAt: true, isReversal: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }
    if (existing.isReversal) {
      return NextResponse.json(
        { error: "Reversal entries cannot be deleted. Please create a new adjustment instead." },
        { status: 403 }
      );
    }
    const ageMs = Date.now() - new Date(existing.createdAt).getTime();
    const limitMs = 48 * 60 * 60 * 1000;
    if (ageMs > limitMs) {
      return NextResponse.json(
        { error: "Deletes are locked after 48 hours. Please create a reversal instead." },
        { status: 403 }
      );
    }
    await prisma.expense.update({
      where: { id: params.id },
      data: { deletedAt: new Date() },
    });

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "EXPENSE_DELETE",
        entityType: "EXPENSE",
        entityId: params.id,
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

export async function POST(_req: Request, { params }: { params: { id: string } }) {
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
  if (!assertSameOrigin(_req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(_req, "admin-expense-restore", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const existing = await prisma.expense.findUnique({
      where: { id: params.id },
      select: { id: true, deletedAt: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    }
    if (!existing.deletedAt) {
      return NextResponse.json({ error: "Expense is not deleted" }, { status: 400 });
    }
    await prisma.expense.update({
      where: { id: params.id },
      data: { deletedAt: null },
    });

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "EXPENSE_RESTORE",
        entityType: "EXPENSE",
        entityId: params.id,
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
