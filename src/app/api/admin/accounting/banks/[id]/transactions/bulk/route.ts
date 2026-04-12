import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAccountingBankAudit } from "@/lib/accounting-bank-audit";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function isAdmin(user?: AuthenticatedUser | null) {
  return user?.role === "ADMIN";
}

const bulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  action: z.enum(["SET_TYPE", "DELETE"]),
  type: z.enum(["DEBIT", "CREDIT"]).optional(),
});

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(actor)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const bankId = parts[parts.length - 3] || "";
  if (!bankId) {
    return NextResponse.json({ error: "Missing bank id" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = bulkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const ids = Array.from(new Set(parsed.data.ids));
  const rows = await prisma.bankTransaction.findMany({
    where: { id: { in: ids }, bankAccountId: bankId },
    select: { id: true, matched: true },
  });
  if (!rows.length) {
    return NextResponse.json({ error: "No matching transactions found." }, { status: 404 });
  }

  if (parsed.data.action === "SET_TYPE") {
    if (!parsed.data.type) {
      return NextResponse.json({ error: "type is required for SET_TYPE." }, { status: 400 });
    }
    const matchedLocked = rows.filter((row) => row.matched);
    if (matchedLocked.length > 0) {
      return NextResponse.json(
        {
          error: `Cannot change type of ${matchedLocked.length} matched transaction(s). Unmatch them first.`,
          matchedCount: matchedLocked.length,
        },
        { status: 400 },
      );
    }
    const result = await prisma.bankTransaction.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, bankAccountId: bankId },
      data: { type: parsed.data.type },
    });
    await recordAccountingBankAudit({
      req,
      actor,
      action: "BANK_TXN_BULK_SET_TYPE",
      entityType: "BANK_TRANSACTION",
      entityId: bankId,
      section: "transactions",
      operation: "bulk_set_type",
      resultSummary: `Updated type for ${result.count} bank transaction(s).`,
      meta: {
        bankAccountId: bankId,
        selectedIds: ids,
        touchedIds: rows.map((row) => row.id),
        nextType: parsed.data.type,
        updated: result.count,
      },
    });
    return NextResponse.json({ ok: true, updated: result.count });
  }

  if (!isAdmin(actor)) {
    return NextResponse.json({ error: "Only ADMIN can bulk delete transactions." }, { status: 403 });
  }

  const matchedCount = rows.filter((row) => row.matched).length;
  if (matchedCount > 0) {
    return NextResponse.json(
      { error: "Cannot delete matched transactions. Unmatch them first.", matchedCount },
      { status: 400 },
    );
  }
  const result = await prisma.bankTransaction.deleteMany({
    where: { id: { in: rows.map((row) => row.id) }, bankAccountId: bankId },
  });
  await recordAccountingBankAudit({
    req,
    actor,
    action: "BANK_TXN_BULK_DELETE",
    entityType: "BANK_TRANSACTION",
    entityId: bankId,
    section: "transactions",
    operation: "bulk_delete",
    resultSummary: `Deleted ${result.count} bank transaction(s).`,
    meta: {
      bankAccountId: bankId,
      selectedIds: ids,
      deletedIds: rows.map((row) => row.id),
      deleted: result.count,
    },
  });
  return NextResponse.json({ ok: true, deleted: result.count });
}
