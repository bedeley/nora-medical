import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { findClosedPeriod } from "@/lib/accounting-periods";
import {
  OPENING_BALANCE_EQUITY_CODE,
  OPENING_RETAINED_EARNINGS_SETTING_KEY,
  RETAINED_EARNINGS_ACCOUNT_CODE,
  type OpeningRetainedEarningsValue,
  parseOpeningRetainedEarningsValue,
} from "@/lib/opening-retained-earnings";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const schema = z.object({
  amount: z.number().positive(),
  entryDate: z.string().regex(YMD_RE, "Entry date must be YYYY-MM-DD."),
  notes: z.string().max(500).optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

async function resolveOpeningBalanceEquityAccountTx(tx: typeof prisma) {
  let account = await tx.ledgerAccount.findUnique({ where: { code: OPENING_BALANCE_EQUITY_CODE } });
  if (!account) {
    account = await tx.ledgerAccount.create({
      data: {
        code: OPENING_BALANCE_EQUITY_CODE,
        name: "Opening Balance Equity",
        type: "EQUITY",
        description: "Auto-created counter-account for opening balance adjustments.",
      },
    });
  }
  return account;
}

async function resolveRetainedEarningsAccountTx(tx: typeof prisma) {
  let account = await tx.ledgerAccount.findUnique({ where: { code: RETAINED_EARNINGS_ACCOUNT_CODE } });
  if (!account) {
    account = await tx.ledgerAccount.create({
      data: {
        code: RETAINED_EARNINGS_ACCOUNT_CODE,
        name: "Retained Earnings",
        type: "EQUITY",
        description: "Opening retained earnings carried into the system at go-live.",
      },
    });
  }
  return account;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const limited = await rateLimit(req, "admin-opening-retained-earnings", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse({
    ...body,
    amount: Number(body?.amount),
    entryDate: String(body?.entryDate || "").trim(),
    notes: typeof body?.notes === "string" ? body.notes.trim() : undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.appSetting.findUnique({
    where: { key: OPENING_RETAINED_EARNINGS_SETTING_KEY },
    select: { value: true, updatedAt: true },
  });
  if (existing) {
    return NextResponse.json(
      {
        error: "Opening retained earnings has already been configured.",
        code: "OPENING_RETAINED_EARNINGS_EXISTS",
        existing: parseOpeningRetainedEarningsValue(existing.value) ?? {
          configuredAt: existing.updatedAt.toISOString(),
        },
      },
      { status: 409 },
    );
  }

  const { amount, entryDate, notes } = parsed.data;
  const entryDateValue = new Date(`${entryDate}T00:00:00.000Z`);
  const closedPeriod = await findClosedPeriod(entryDateValue);
  if (closedPeriod) {
    return NextResponse.json(
      { error: `Cannot post opening retained earnings in closed period "${closedPeriod.name}".` },
      { status: 400 },
    );
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const obEquity = await resolveOpeningBalanceEquityAccountTx(tx as typeof prisma);
      const retainedEarnings = await resolveRetainedEarningsAccountTx(tx as typeof prisma);
      const memoBase = "Opening retained earnings setup";
      const memo = notes ? `${memoBase} - ${notes}` : memoBase;

      const journal = await tx.journalEntry.create({
        data: {
          entryDate: entryDateValue,
          memo,
          sourceType: "MANUAL",
          status: "POSTED",
          approvedById: user?.id ?? null,
          approvedAt: new Date(),
          lines: {
            create: [
              {
                accountId: obEquity.id,
                debit: amount,
                credit: 0,
                description: "Opening retained earnings reclassification",
              },
              {
                accountId: retainedEarnings.id,
                debit: 0,
                credit: amount,
                description: "Opening retained earnings",
              },
            ],
          },
        },
      });

      const value: OpeningRetainedEarningsValue = {
        amount,
        notes: notes || null,
        entryDate,
        journalEntryId: journal.id,
        configuredAt: new Date().toISOString(),
        configuredById: user?.id ?? null,
        openingBalanceEquityCode: OPENING_BALANCE_EQUITY_CODE,
        retainedEarningsAccountCode: RETAINED_EARNINGS_ACCOUNT_CODE,
      };

      await tx.appSetting.create({
        data: {
          key: OPENING_RETAINED_EARNINGS_SETTING_KEY,
          value: value as Prisma.InputJsonValue,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: user?.id ?? null,
          action: "OPENING_RETAINED_EARNINGS_SET",
          entityType: "AppSetting",
          entityId: OPENING_RETAINED_EARNINGS_SETTING_KEY,
          meta: JSON.stringify({
            amount,
            entryDate,
            journalEntryId: journal.id,
            openingBalanceEquityCode: OPENING_BALANCE_EQUITY_CODE,
            retainedEarningsAccountCode: RETAINED_EARNINGS_ACCOUNT_CODE,
            sourcePage: "admin/accounting",
          }),
        },
      });

      return { journalEntryId: journal.id, configured: value };
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        { error: "Opening retained earnings has already been configured.", code: "OPENING_RETAINED_EARNINGS_EXISTS" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save opening retained earnings." },
      { status: 500 },
    );
  }
}
