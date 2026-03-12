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
        meta: {
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
      })
      : [];
    const reversalMap = new Map(
      reversalTotals
        .filter((row) => row.reversalOfId)
        .map((row) => [row.reversalOfId as string, Number(row._sum.amount ?? 0)])
    );
    const settlementEntries = await prisma.journalEntry.findMany({
      where: {
        sourceType: "EXPENSE",
        status: "POSTED",
        sourceId: { contains: ":settlement:" },
      },
      select: {
        sourceId: true,
        createdAt: true,
        lines: { select: { debit: true } },
      },
    });
    const settlementMap = new Map<string, number>();
    const latestSettlementAtMap = new Map<string, string>();
    for (const entry of settlementEntries) {
      const sourceId = String(entry.sourceId || "");
      const expenseId = sourceId.split(":settlement:")[0] || "";
      if (!expenseId) continue;
      const settlementAmount = (entry.lines || []).reduce((sum, line) => sum + Number(line.debit || 0), 0);
      if (!(settlementAmount > 0)) continue;
      settlementMap.set(expenseId, (settlementMap.get(expenseId) || 0) + settlementAmount);
      const iso = new Date(entry.createdAt).toISOString();
      const prev = latestSettlementAtMap.get(expenseId) || "";
      if (!prev || new Date(iso).getTime() > new Date(prev).getTime()) {
        latestSettlementAtMap.set(expenseId, iso);
      }
    }
    const itemsWithRemaining = items.map((item) => {
      if (item.isReversal) {
        return {
          ...item,
          reversalRemaining: null,
          reversedSoFar: null,
          settlementPaid: null,
          settlementOutstanding: null,
          settlementStatus: null,
          settlementLastPaidAt: null,
        };
      }
      const reversedSoFar = Math.abs(reversalMap.get(item.id) ?? 0);
      const originalAmount = Number(item.amount);
      const remaining = Math.max(0, originalAmount - reversedSoFar);
      const noteText = String(item.note || "");
      const hasSettlementJournal = settlementMap.has(item.id);
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
      return {
        ...item,
        reversalRemaining: remaining,
        reversedSoFar,
        settlementPaid,
        settlementOutstanding,
        settlementStatus,
        settlementLastPaidAt: latestSettlementAtMap.get(item.id) || null,
      };
    });
    const stateFilter =
      settlementState === "UNPAID" || settlementState === "PARTIALLY_PAID" || settlementState === "PAID"
        ? settlementState
        : "";
    const filteredItems = stateFilter
      ? itemsWithRemaining.filter((item) => item.settlementStatus === stateFilter)
      : itemsWithRemaining;

    // Prepare totals
    const totalAmount = filteredItems.reduce(
      (sum: number, e: { amount: unknown }) => sum + Number(e.amount),
      0
    );

    if (format === "csv") {
      const header = ["Date", "Category", "Amount (GHS)", "Amount (Raw)", "Vendor", "Reason", "Note"]; 
      const rows = filteredItems.map((e: { createdAt: Date; category: string; amount: unknown; vendor?: string | null; reason?: string | null; note?: string | null }) => [
        new Date(e.createdAt).toISOString(),
        e.category.replaceAll("\"", "'"),
        formatCurrency(Number(e.amount)),
        Number(e.amount).toFixed(2),
        (e.vendor ?? "").replaceAll("\"", "'"),
        (e.reason ?? "").replaceAll("\"", "'"),
        (e.note ?? "").replaceAll("\"", "'")
      ]);
      const csv = [header, ...rows]
        .map((r: Array<string | number>) => r.map((v: string | number) => `"${String(v)}"`).join(","))
        .join("\n");
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename=expenses_${Date.now()}.csv`,
        },
      });
    }

    return NextResponse.json({ items: filteredItems, totalAmount });
  } catch (err) {
    console.error("Error listing expenses:", err);
    return NextResponse.json(
      { error: "Failed to list expenses" },
      { status: 500 }
    );
  }
}
