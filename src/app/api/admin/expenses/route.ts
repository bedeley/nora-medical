import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

const expenseSchema = z
  .object({
    category: z.string().min(2, "Category is required"),
    amount: z.number(),
    vendor: z.string().optional(),
    reason: z.string().optional(),
    note: z.string().optional(),
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
  });

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
      reversalOfId: typeof body.reversalOfId === "string" ? body.reversalOfId : undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
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

    const expense = await prisma.expense.create({
      data: {
        category: parsed.data.category,
        amount: parsed.data.amount,
        vendor: parsed.data.vendor,
        reason: parsed.data.reason,
        note: parsed.data.note,
        isReversal: Boolean(parsed.data.isReversal),
        reversalOfId: parsed.data.reversalOfId || null,
      },
    });

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "EXPENSE_CREATE",
        entityType: "EXPENSE",
        entityId: expense.id,
        meta: {
          category: expense.category,
          amount: Number(expense.amount),
          vendor: expense.vendor ?? null,
          reason: expense.reason ?? null,
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
    const format = searchParams.get("format");

    const where: {
      category?: { contains: string; mode: "insensitive" };
      vendor?: { contains: string; mode: "insensitive" };
      OR?: Array<{
        note?: { contains: string; mode: "insensitive" };
        category?: { contains: string; mode: "insensitive" };
        vendor?: { contains: string; mode: "insensitive" };
        reason?: { contains: string; mode: "insensitive" };
      }>;
      createdAt?: { gte?: Date; lte?: Date };
      deletedAt?: null;
    } = {};
    where.deletedAt = null;
    if (category) where.category = { contains: category, mode: "insensitive" };
    const vendor = searchParams.get("vendor");
    if (vendor) where.vendor = { contains: vendor, mode: "insensitive" };
    if (q)
      where.OR = [
        { note: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
        { vendor: { contains: q, mode: "insensitive" } },
        { reason: { contains: q, mode: "insensitive" } },
      ];
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
    const itemsWithRemaining = items.map((item) => {
      if (item.isReversal) {
        return { ...item, reversalRemaining: null, reversedSoFar: null };
      }
      const reversedSoFar = Math.abs(reversalMap.get(item.id) ?? 0);
      const originalAmount = Number(item.amount);
      const remaining = Math.max(0, originalAmount - reversedSoFar);
      return {
        ...item,
        reversalRemaining: remaining,
        reversedSoFar,
      };
    });

    // Prepare totals
    const totalAmount = items.reduce(
      (sum: number, e: { amount: unknown }) => sum + Number(e.amount),
      0
    );

    if (format === "csv") {
      const header = ["Date", "Category", "Amount", "Vendor", "Reason", "Note"]; 
    const rows = items.map((e: { createdAt: Date; category: string; amount: unknown; vendor?: string | null; reason?: string | null; note?: string | null }) => [
      new Date(e.createdAt).toISOString(),
      e.category.replaceAll("\"", "'"),
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

    return NextResponse.json({ items: itemsWithRemaining, totalAmount });
  } catch (err) {
    console.error("Error listing expenses:", err);
    return NextResponse.json(
      { error: "Failed to list expenses" },
      { status: 500 }
    );
  }
}
