import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

const txnSchema = z.object({
  postedAt: z.string().min(1),
  amount: z.number(),
  description: z.string().max(255).optional(),
  reference: z.string().max(120).optional(),
  type: z.enum(["DEBIT", "CREDIT"]),
  allowDuplicate: z.boolean().optional(),
  duplicateReason: z.string().max(300).optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(
  req: Request,
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const bankId = new URL(req.url).pathname.split("/").filter(Boolean).at(-2);
  if (!bankId) {
    return NextResponse.json({ error: "Missing bank id" }, { status: 400 });
  }
  const txns = await prisma.bankTransaction.findMany({
    where: { bankAccountId: bankId },
    orderBy: [{ postedAt: "desc" }],
  });
  return NextResponse.json(txns);
}

export async function POST(
  req: Request,
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const bankId = new URL(req.url).pathname.split("/").filter(Boolean).at(-2);
  if (!bankId) {
    return NextResponse.json({ error: "Missing bank id" }, { status: 400 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  try {
    const body = await req.json();
    const parsed = txnSchema.safeParse({
      ...body,
      amount: Number(body.amount),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const postedAt = new Date(parsed.data.postedAt);
    if (Number.isNaN(postedAt.getTime())) {
      return NextResponse.json({ error: "Invalid postedAt date." }, { status: 400 });
    }
    const utcDayStart = new Date(
      Date.UTC(
        postedAt.getUTCFullYear(),
        postedAt.getUTCMonth(),
        postedAt.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    const utcDayEnd = new Date(
      Date.UTC(
        postedAt.getUTCFullYear(),
        postedAt.getUTCMonth(),
        postedAt.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );
    const duplicate = await prisma.bankTransaction.findFirst({
      where: {
        bankAccountId: bankId,
        postedAt: { gte: utcDayStart, lte: utcDayEnd },
        amount: parsed.data.amount,
        reference: parsed.data.reference ?? null,
      },
      select: { id: true },
    });
    if (duplicate && !parsed.data.allowDuplicate) {
      return NextResponse.json(
        {
          error:
            "Potential duplicate transaction (same date, amount, and reference) already exists for this bank.",
          duplicateId: duplicate.id,
        },
        { status: 409 },
      );
    }
    if (duplicate && parsed.data.allowDuplicate) {
      const reason = (parsed.data.duplicateReason || "").trim();
      if (reason.length < 8) {
        return NextResponse.json(
          { error: "Duplicate reason is required (at least 8 characters)." },
          { status: 400 },
        );
      }
    }

    const txn = await prisma.bankTransaction.create({
      data: {
        bankAccountId: bankId,
        postedAt,
        amount: parsed.data.amount,
        description: parsed.data.description,
        reference: parsed.data.reference,
        type: parsed.data.type,
      },
    });
    if (duplicate && parsed.data.allowDuplicate) {
      const actor = session.user as AuthenticatedUser;
      await prisma.auditLog.create({
        data: {
          actorId: actor?.id || null,
          action: "BANK_TXN_DUPLICATE_OVERRIDE",
          entityType: "BANK_TRANSACTION",
          entityId: txn.id,
          meta: JSON.stringify({
            bankAccountId: bankId,
            duplicateOfId: duplicate.id,
            reason: (parsed.data.duplicateReason || "").trim(),
            postedAt: parsed.data.postedAt,
            amount: parsed.data.amount,
            reference: parsed.data.reference ?? null,
            type: parsed.data.type,
          }),
        },
      });
    } else {
      const actor = session.user as AuthenticatedUser;
      await prisma.auditLog.create({
        data: {
          actorId: actor?.id || null,
          action: "BANK_TXN_CREATED",
          entityType: "BANK_TRANSACTION",
          entityId: txn.id,
          meta: JSON.stringify({
            bankAccountId: bankId,
            postedAt: parsed.data.postedAt,
            amount: parsed.data.amount,
            type: parsed.data.type,
            reference: parsed.data.reference ?? null,
            description: parsed.data.description ?? null,
          }),
        },
      });
    }
    return NextResponse.json(txn);
  } catch (error) {
    console.error("Accounting bank transaction create error:", error);
    return NextResponse.json({ error: "Failed to create transaction" }, { status: 500 });
  }
}
