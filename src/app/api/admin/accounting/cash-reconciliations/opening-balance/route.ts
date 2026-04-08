/**
 * POST /api/admin/accounting/cash-reconciliations/opening-balance
 *
 * Option 5 — Opening Balance Anchor.
 *
 * Records a one-time verified physical count as the authoritative starting
 * point for the cash account.  If the GL balance differs from the verified
 * count, a journal entry is posted to bring the ledger in sync, and a
 * CashReconciliation record marked isOpeningBalance=true is created with
 * zero variance (expected = actual = verifiedCount).
 *
 * After this anchor:
 *   • Future Operational (scope=all) expectedAmount = GL delta from this point.
 *   • Future Ledger expectedAmount = GL cumulative from this point.
 *   • Both modes converge on the same authoritative baseline.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { findClosedPeriod } from "@/lib/accounting-periods";
import { buildUtcDayRange } from "@/lib/otc-shift-close";

const DEFAULT_CASH_CODE = "1000";
const DEFAULT_OB_EQUITY_CODE = "3900";
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const schema = z.object({
  /** The verified physical cash count (what is actually in the drawer). */
  verifiedCount: z.number().finite(),
  /** Optional: specific cash account id. Defaults to system cash account. */
  cashAccountId: z.string().optional(),
  /**
   * Date for the opening balance. Defaults to today.
   * Accepts YYYY-MM-DD or ISO date string.
   */
  date: z.string().optional(),
  /** Optional notes explaining the opening balance. */
  notes: z.string().max(500).optional(),
  /**
   * Whether to post a GL adjustment entry when verifiedCount ≠ current GL balance.
   * Defaults to true. Set to false to record the anchor without touching the GL
   * (useful when the GL is already correct and you just want the reconciliation record).
   */
  postGlAdjustment: z.boolean().optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  return user?.role === "ADMIN" || user?.role === "ACCOUNTANT";
}

async function loadCashBalance(accountId: string, asOf?: Date) {
  const totals = await prisma.journalLine.aggregate({
    where: {
      accountId,
      entry: {
        status: "POSTED",
        entryDate: asOf ? { lte: asOf } : undefined,
      },
    },
    _sum: { debit: true, credit: true },
  });
  return Number((Number(totals._sum.debit || 0) - Number(totals._sum.credit || 0)).toFixed(2));
}

async function resolveCashAccount(idOrCode?: string | null) {
  if (idOrCode && idOrCode.length > 6) {
    // looks like a cuid — treat as id
    const byId = await prisma.ledgerAccount.findUnique({ where: { id: idOrCode } });
    if (byId) return byId;
  }
  const setting = await prisma.appSetting.findUnique({
    where: { key: "accounting.posting.accounts" },
  });
  const value = setting?.value && typeof setting.value === "object" ? setting.value : null;
  const cashCode = (value as Record<string, string> | null)?.CASH || DEFAULT_CASH_CODE;
  let account = await prisma.ledgerAccount.findUnique({ where: { code: cashCode } });
  if (!account) {
    account = await prisma.ledgerAccount.create({
      data: { code: cashCode, name: "Cash", type: "ASSET" },
    });
  }
  return account;
}

async function resolveOpeningBalanceEquityAccount() {
  let account = await prisma.ledgerAccount.findUnique({ where: { code: DEFAULT_OB_EQUITY_CODE } });
  if (!account) {
    account = await prisma.ledgerAccount.create({
      data: {
        code: DEFAULT_OB_EQUITY_CODE,
        name: "Opening Balance Equity",
        type: "EQUITY",
        description: "Auto-created counter-account for opening balance adjustments.",
      },
    });
  }
  return account;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const parsed = schema.safeParse({
      ...body,
      verifiedCount: Number(body.verifiedCount),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { verifiedCount, notes, postGlAdjustment = true } = parsed.data;
    const cashAccount = await resolveCashAccount(parsed.data.cashAccountId);

    // Resolve the anchor date
    const rawDate = String(parsed.data.date || "").trim();
    let dayYmd: string;
    if (YMD_RE.test(rawDate)) {
      dayYmd = rawDate;
    } else if (rawDate) {
      const parsed2 = new Date(rawDate);
      dayYmd = Number.isNaN(parsed2.getTime())
        ? new Date().toISOString().slice(0, 10)
        : parsed2.toISOString().slice(0, 10);
    } else {
      dayYmd = new Date().toISOString().slice(0, 10);
    }
    const dayRange = buildUtcDayRange(dayYmd);
    const anchorDate = dayRange.to; // end-of-day timestamp for the anchor

    // Check the period isn't closed (if we need to post an adjustment)
    if (postGlAdjustment) {
      const closedPeriod = await findClosedPeriod(anchorDate);
      if (closedPeriod) {
        return NextResponse.json(
          { error: `Cannot post GL adjustment in closed period "${closedPeriod.name}".` },
          { status: 400 },
        );
      }
    }

    // Check no opening balance already exists for this account+day
    const existingOB = await prisma.cashReconciliation.findFirst({
      where: {
        cashAccountId: cashAccount.id,
        isOpeningBalance: true,
      },
      select: { id: true, countedAt: true },
    });
    if (existingOB) {
      return NextResponse.json(
        {
          error: "An opening balance anchor already exists for this account.",
          code: "OPENING_BALANCE_EXISTS",
          existing: {
            id: existingOB.id,
            date: existingOB.countedAt.toISOString().slice(0, 10),
          },
        },
        { status: 409 },
      );
    }

    // Get current GL balance at end of anchor day
    const currentGlBalance = await loadCashBalance(cashAccount.id, anchorDate);
    const adjustment = Number((verifiedCount - currentGlBalance).toFixed(2));

    let journalEntryId: string | null = null;

    if (postGlAdjustment && adjustment !== 0) {
      const obEquity = await resolveOpeningBalanceEquityAccount();
      const absAdj = Math.abs(adjustment);

      // adjustment > 0: GL is understated → debit Cash, credit Opening Balance Equity
      // adjustment < 0: GL is overstated  → debit Opening Balance Equity, credit Cash
      const lines =
        adjustment > 0
          ? [
              { accountId: cashAccount.id, debit: absAdj, credit: 0, description: "Opening balance cash adjustment" },
              { accountId: obEquity.id, debit: 0, credit: absAdj, description: "Opening balance equity offset" },
            ]
          : [
              { accountId: obEquity.id, debit: absAdj, credit: 0, description: "Opening balance equity offset" },
              { accountId: cashAccount.id, debit: 0, credit: absAdj, description: "Opening balance cash adjustment" },
            ];

      const entry = await prisma.journalEntry.create({
        data: {
          entryDate: anchorDate,
          memo: `Opening balance anchor — cash account ${cashAccount.code}`,
          sourceType: "MANUAL",
          status: "POSTED",
          approvedById: session.user?.id,
          approvedAt: new Date(),
          lines: { create: lines },
        },
      });
      journalEntryId = entry.id;
    }

    // Create the anchor reconciliation record
    const rec = await prisma.cashReconciliation.create({
      data: {
        cashAccountId: cashAccount.id,
        countedAt: anchorDate,
        expectedAmount: verifiedCount,
        actualAmount: verifiedCount,
        variance: 0,
        reconcileMode: "opening_balance",
        isOpeningBalance: true,
        notes: notes
          ? `[OPENING_BALANCE] ${notes.trim()}`
          : `[OPENING_BALANCE] GL adjusted by ${adjustment >= 0 ? "+" : ""}${adjustment.toFixed(2)} to match verified count of ${verifiedCount.toFixed(2)}`,
        createdById: session.user?.id,
        journalEntryId,
      },
      include: {
        cashAccount: true,
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user?.id || null,
        action: "CASH_OPENING_BALANCE_SET",
        entityType: "CASH_RECONCILIATION",
        entityId: rec.id,
        meta: JSON.stringify({
          cashAccountId: cashAccount.id,
          cashAccountCode: cashAccount.code,
          anchorDate: anchorDate.toISOString(),
          verifiedCount,
          previousGlBalance: currentGlBalance,
          glAdjustment: adjustment,
          adjustmentPosted: postGlAdjustment && adjustment !== 0,
          journalEntryId,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      id: rec.id,
      date: dayYmd,
      cashAccountCode: cashAccount.code,
      verifiedCount,
      previousGlBalance: currentGlBalance,
      glAdjustment: adjustment,
      adjustmentPosted: postGlAdjustment && adjustment !== 0,
      journalEntryId,
    });
  } catch (error) {
    console.error("Opening balance error:", error);
    return NextResponse.json({ error: "Failed to set opening balance" }, { status: 500 });
  }
}
