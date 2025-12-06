import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

const expenseSchema = z.object({
  category: z.string().min(2, "Category is required"),
  amount: z.number().positive("Amount must be positive"),
  note: z.string().optional(),
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
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const expense = await prisma.expense.create({
      data: parsed.data,
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
      OR?: Array<{ note?: { contains: string; mode: "insensitive" }; category?: { contains: string; mode: "insensitive" } }>;
      createdAt?: { gte?: Date; lte?: Date };
    } = {};
    if (category) where.category = { contains: category, mode: "insensitive" };
    if (q)
      where.OR = [
        { note: { contains: q, mode: "insensitive" } },
        { category: { contains: q, mode: "insensitive" } },
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

    // Prepare totals
    const totalAmount = items.reduce(
      (sum: number, e: { amount: unknown }) => sum + Number(e.amount),
      0
    );

    if (format === "csv") {
      const header = ["Date", "Category", "Amount", "Note"]; 
      const rows = items.map((e: { createdAt: Date; category: string; amount: unknown; note?: string | null }) => [
        new Date(e.createdAt).toISOString(),
        e.category.replaceAll("\"", "'"),
        Number(e.amount).toFixed(2),
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

    return NextResponse.json({ items, totalAmount });
  } catch (err) {
    console.error("Error listing expenses:", err);
    return NextResponse.json(
      { error: "Failed to list expenses" },
      { status: 500 }
    );
  }
}
