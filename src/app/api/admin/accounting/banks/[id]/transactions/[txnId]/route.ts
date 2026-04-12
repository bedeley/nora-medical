import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { findClosedPeriod } from "@/lib/accounting-periods";
import { recordAccountingBankAudit } from "@/lib/accounting-bank-audit";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

const patchSchema = z.object({
  postedAt: z.string().optional(),
  amount: z.number().optional(),
  description: z.string().max(255).optional().nullable(),
  reference: z.string().max(120).optional().nullable(),
  type: z.enum(["DEBIT", "CREDIT"]).optional(),
  overrideEditLock: z.boolean().optional(),
  overrideReason: z.string().max(300).optional(),
});

function dayBounds(date: Date) {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
  const end = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999),
  );
  return { start, end };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; txnId: string }> },
) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const { id: bankId, txnId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse({
    ...body,
    amount: body?.amount === undefined ? undefined : Number(body.amount),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.bankTransaction.findFirst({
    where: { id: txnId, bankAccountId: bankId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Transaction not found." }, { status: 404 });
  }
  if (existing.matched) {
    return NextResponse.json({ error: "Matched transactions are locked. Unmatch first." }, { status: 400 });
  }

  const closedPeriod = await findClosedPeriod(existing.postedAt);
  if (closedPeriod) {
    return NextResponse.json(
      {
        error: `Transaction date is in closed period "${closedPeriod.name}". Editing is locked.`,
        code: "EDIT_LOCKED_CLOSED_PERIOD",
      },
      { status: 423 },
    );
  }

  const windowSetting = await prisma.appSetting.findUnique({
    where: { key: "accounting.bankTransactions.editWindowDays" },
    select: { value: true },
  });
  const configuredWindow = Number(
    typeof windowSetting?.value === "number"
      ? windowSetting.value
      : typeof windowSetting?.value === "string"
        ? windowSetting.value
        : 7,
  );
  const editWindowDays = Number.isFinite(configuredWindow)
    ? Math.min(365, Math.max(0, Math.floor(configuredWindow)))
    : 7;
  const txnUtcStart = new Date(
    Date.UTC(
      existing.postedAt.getUTCFullYear(),
      existing.postedAt.getUTCMonth(),
      existing.postedAt.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  const now = new Date();
  const todayUtcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const ageDays = Math.floor((todayUtcStart.getTime() - txnUtcStart.getTime()) / 86_400_000);
  const requiresAdminOverride = ageDays > editWindowDays;
  const overrideReason = String(parsed.data.overrideReason || "").trim();
  const overrideProvided = Boolean(parsed.data.overrideEditLock);
  const isAdmin = actor?.role === "ADMIN";
  if (requiresAdminOverride && (!isAdmin || !overrideProvided || overrideReason.length < 8)) {
    return NextResponse.json(
      {
        error: isAdmin
          ? `This transaction is ${ageDays} day(s) old and outside the ${editWindowDays}-day edit window. Admin override reason is required.`
          : `This transaction is ${ageDays} day(s) old and outside the ${editWindowDays}-day edit window. ADMIN override is required.`,
        code: "EDIT_LOCKED_AGE_WINDOW",
        requiresOverride: isAdmin,
        canSelfOverride: isAdmin,
        windowDays: editWindowDays,
        ageDays,
      },
      { status: 423 },
    );
  }

  const nextPostedAt = parsed.data.postedAt ? new Date(parsed.data.postedAt) : existing.postedAt;
  if (Number.isNaN(nextPostedAt.getTime())) {
    return NextResponse.json({ error: "Invalid postedAt date." }, { status: 400 });
  }
  const nextAmount = parsed.data.amount ?? Number(existing.amount);
  const nextReference =
    parsed.data.reference === undefined ? existing.reference ?? null : parsed.data.reference ?? null;
  const { start, end } = dayBounds(nextPostedAt);
  const duplicate = await prisma.bankTransaction.findFirst({
    where: {
      id: { not: existing.id },
      bankAccountId: bankId,
      postedAt: { gte: start, lte: end },
      amount: nextAmount,
      reference: nextReference,
    },
    select: { id: true },
  });
  if (duplicate) {
    return NextResponse.json(
      { error: "Potential duplicate transaction exists for same date, amount, and reference." },
      { status: 409 },
    );
  }

  const updated = await prisma.bankTransaction.update({
    where: { id: existing.id },
    data: {
      ...(parsed.data.postedAt ? { postedAt: nextPostedAt } : {}),
      ...(parsed.data.amount !== undefined ? { amount: nextAmount } : {}),
      ...(parsed.data.type ? { type: parsed.data.type } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.reference !== undefined ? { reference: parsed.data.reference } : {}),
    },
  });
  try {
    await recordAccountingBankAudit({
      req,
      actor,
      action: "BANK_TXN_UPDATED",
      entityType: "BANK_TRANSACTION",
      entityId: updated.id,
      section: "transactions",
      operation: "update",
      resultSummary: `Updated bank transaction ${updated.id}.`,
      meta: {
        bankAccountId: bankId,
        before: {
          postedAt: existing.postedAt.toISOString(),
          amount: Number(existing.amount),
          type: existing.type,
          description: existing.description ?? null,
          reference: existing.reference ?? null,
        },
        after: {
          postedAt: updated.postedAt.toISOString(),
          amount: Number(updated.amount),
          type: updated.type,
          description: updated.description ?? null,
          reference: updated.reference ?? null,
        },
        lockPolicy: {
          editWindowDays,
          ageDays,
          overrideApplied: requiresAdminOverride,
          overrideReason: requiresAdminOverride ? overrideReason : null,
        },
      },
    });
  } catch (auditError) {
    console.error("Accounting bank transaction update audit error:", auditError);
  }
  return NextResponse.json(updated);
}
