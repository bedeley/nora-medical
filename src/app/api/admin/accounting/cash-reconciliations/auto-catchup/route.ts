import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { buildUtcDayRange } from "@/lib/otc-shift-close";

const DEFAULT_CASH_CODE = "1000";
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const schema = z.object({
  cashAccountId: z.string().optional(),
  days: z.array(z.string().regex(YMD_RE)).min(1, "Select at least one day."),
  verifyZeroVariance: z.boolean(),
  verificationNote: z.string().min(10).max(500),
});

async function resolveCashAccount(codeOverride?: string | null) {
  const setting = await prisma.appSetting.findUnique({
    where: { key: "accounting.posting.accounts" },
  });
  const value = setting?.value && typeof setting.value === "object" ? setting.value : null;
  const cashCode = (value as Record<string, string> | null)?.CASH || codeOverride || DEFAULT_CASH_CODE;
  let account = await prisma.ledgerAccount.findUnique({ where: { code: cashCode } });
  if (!account) {
    account = await prisma.ledgerAccount.create({
      data: { code: cashCode, name: "Cash", type: "ASSET" },
    });
  }
  return account;
}

async function getDayNet(accountId: string, dayYmd: string) {
  const range = buildUtcDayRange(dayYmd);
  const totals = await prisma.journalLine.aggregate({
    where: {
      accountId,
      entry: {
        status: "POSTED",
        entryDate: {
          gte: range.from,
          lte: range.to,
        },
      },
    },
    _sum: { debit: true, credit: true },
  });
  const debit = Number(totals._sum.debit || 0);
  const credit = Number(totals._sum.credit || 0);
  return Number((debit - credit).toFixed(2));
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    if (!parsed.data.verifyZeroVariance) {
      return NextResponse.json(
        { error: "You must confirm that selected days were physically verified as zero variance." },
        { status: 400 },
      );
    }

    const cashAccount = parsed.data.cashAccountId
      ? await prisma.ledgerAccount.findUnique({ where: { id: parsed.data.cashAccountId } })
      : await resolveCashAccount();
    if (!cashAccount) {
      return NextResponse.json({ error: "Cash account not found" }, { status: 404 });
    }

    const note = parsed.data.verificationNote.trim();
    const days = Array.from(new Set(parsed.data.days)).sort();
    const created: Array<{ day: string; id: string; expectedAmount: number }> = [];
    const skipped: Array<{ day: string; reason: string }> = [];

    for (const day of days) {
      const range = buildUtcDayRange(day);
      const existing = await prisma.cashReconciliation.findFirst({
        where: {
          cashAccountId: cashAccount.id,
          countedAt: {
            gte: range.from,
            lte: range.to,
          },
        },
        select: { id: true },
      });
      if (existing) {
        skipped.push({ day, reason: "already_reconciled" });
        continue;
      }
      const expectedAmount = await getDayNet(cashAccount.id, day);
      const rec = await prisma.cashReconciliation.create({
        data: {
          cashAccountId: cashAccount.id,
          countedAt: range.to,
          expectedAmount,
          actualAmount: expectedAmount,
          variance: 0,
          notes: `[AUTO_CATCHUP_ZERO_VARIANCE] ${note}`,
          createdById: user.id,
          journalEntryId: null,
        },
        select: { id: true },
      });
      created.push({ day, id: rec.id, expectedAmount });
    }

    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: "CASH_RECONCILIATION_AUTO_CATCHUP",
        entityType: "CASH_RECONCILIATION",
        entityId: cashAccount.id,
        meta: JSON.stringify({
          cashAccountId: cashAccount.id,
          selectedDays: days,
          createdCount: created.length,
          skippedCount: skipped.length,
          verificationNote: note,
          created,
          skipped,
        }),
      },
    });

    return NextResponse.json({
      ok: true,
      cashAccountId: cashAccount.id,
      created,
      skipped,
    });
  } catch (error) {
    console.error("cash auto-catchup error:", error);
    return NextResponse.json({ error: "Failed to run auto catch-up" }, { status: 500 });
  }
}

