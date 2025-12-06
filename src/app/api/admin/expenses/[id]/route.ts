import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

const expenseUpdateSchema = z.object({
  category: z.string().min(2).optional(),
  amount: z.number().positive().optional(),
  note: z.string().optional(),
});

export async function PATCH(_req: Request, { params }: { params: { id: string } }) {
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
  const limited = await rateLimit(_req, "admin-expense-update", 60_000, 120);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const body = await _req.json();
    const parsed = expenseUpdateSchema.safeParse({
      ...body,
      amount: body.amount === undefined ? undefined : Number(body.amount),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await prisma.expense.update({
      where: { id: params.id },
      data: parsed.data,
    });

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "EXPENSE_UPDATE",
        entityType: "EXPENSE",
        entityId: params.id,
        meta: parsed.data,
      });
    } catch {
      // best-effort
    }

    return NextResponse.json(updated);
  } catch (err) {
    console.error("Error updating expense:", err);
    return NextResponse.json(
      { error: "Failed to update expense" },
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
    await prisma.expense.delete({ where: { id: params.id } });

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
