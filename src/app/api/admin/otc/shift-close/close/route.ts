import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { buildUtcDayRange, getOtcShiftDayStatus, getOtcShiftSummary } from "@/lib/otc-shift-close";

const closeSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  actualCash: z.number(),
  actualBank: z.number(),
  note: z.string().max(500).optional(),
  allowUnpostedOverride: z.boolean().optional(),
  overrideReason: z.string().max(300).optional(),
});

async function ensureSettlementAccounts() {
  const cash = await prisma.ledgerAccount.upsert({
    where: { code: "1000" },
    update: { name: "Cash", type: "ASSET", isActive: true },
    create: { code: "1000", name: "Cash", type: "ASSET" },
  });
  const bank = await prisma.ledgerAccount.upsert({
    where: { code: "1010" },
    update: { name: "Bank", type: "ASSET", isActive: true },
    create: { code: "1010", name: "Bank", type: "ASSET" },
  });
  return { cash, bank };
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-otc-shift-close", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json();
    const parsed = closeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const {
      day,
      actualCash,
      actualBank,
      note,
      allowUnpostedOverride = false,
      overrideReason,
    } = parsed.data;
    const shiftStatus = await getOtcShiftDayStatus(day);
    if (shiftStatus.isClosed) {
      return NextResponse.json(
        {
          error: `Shift already closed for ${day}.`,
          code: "SHIFT_ALREADY_CLOSED",
          shiftCloseId: shiftStatus.closeEventId,
          closedAt: shiftStatus.closedAt,
        },
        { status: 409 },
      );
    }
    if (!shiftStatus.isOpen) {
      return NextResponse.json(
        {
          error: `Shift is not open for ${day}. Open shift before closing.`,
          code: "SHIFT_NOT_OPEN",
        },
        { status: 409 },
      );
    }
    const range = buildUtcDayRange(day);
    const summary = await getOtcShiftSummary(range);
    const normalizedOverrideReason = String(overrideReason || "").trim();
    if (summary.unpostedPaymentCount > 0 && !allowUnpostedOverride) {
      return NextResponse.json(
        {
          error:
            "Unposted OTC payments detected. Run accounting sync or provide an override reason to continue.",
          code: "UNPOSTED_PAYMENTS_BLOCK",
          unpostedPaymentCount: summary.unpostedPaymentCount,
        },
        { status: 400 },
      );
    }
    if (summary.unpostedPaymentCount > 0 && allowUnpostedOverride && normalizedOverrideReason.length < 10) {
      return NextResponse.json(
        {
          error: "Override reason is required (at least 10 characters).",
          code: "OVERRIDE_REASON_REQUIRED",
        },
        { status: 400 },
      );
    }
    const { cash, bank } = await ensureSettlementAccounts();
    const groupId = randomUUID();
    const marker = `[OTC_SHIFT_CLOSE:${groupId}]`;

    const result = await prisma.$transaction(async (tx) => {
      const cashRec = await tx.cashReconciliation.create({
        data: {
          cashAccountId: cash.id,
          countedAt: new Date(),
          expectedAmount: summary.expectedCash,
          actualAmount: actualCash,
          variance: actualCash - summary.expectedCash,
          notes: `${marker} channel=CASH day=${day}${note ? ` note=${note}` : ""}`,
          createdById: user?.id || null,
        },
      });
      const bankRec = await tx.cashReconciliation.create({
        data: {
          cashAccountId: bank.id,
          countedAt: new Date(),
          expectedAmount: summary.expectedBank,
          actualAmount: actualBank,
          variance: actualBank - summary.expectedBank,
          notes: `${marker} channel=BANK day=${day}${note ? ` note=${note}` : ""}`,
          createdById: user?.id || null,
        },
      });
      return { cashRec, bankRec };
    });

    await recordAuditLog({
      actorId: user?.id || null,
      action: "OTC_SHIFT_CLOSE",
      entityType: "OTC_SHIFT",
      entityId: groupId,
      meta: {
        day,
        range: {
          from: range.from.toISOString(),
          to: range.to.toISOString(),
        },
        expected: {
          cash: summary.expectedCash,
          bank: summary.expectedBank,
          total: summary.expectedTotal,
        },
        actual: {
          cash: actualCash,
          bank: actualBank,
          total: actualCash + actualBank,
        },
        variance: {
          cash: actualCash - summary.expectedCash,
          bank: actualBank - summary.expectedBank,
          total: actualCash + actualBank - summary.expectedTotal,
        },
        paymentCount: summary.paymentCount,
        walkInOrderCount: summary.walkInOrderCount,
        outstandingWalkInBalance: summary.outstandingWalkInBalance,
        unpostedPaymentCount: summary.unpostedPaymentCount,
        overrideUsed: summary.unpostedPaymentCount > 0 ? allowUnpostedOverride : false,
        overrideReason:
          summary.unpostedPaymentCount > 0 && allowUnpostedOverride
            ? normalizedOverrideReason
            : null,
        reconciliationIds: [result.cashRec.id, result.bankRec.id],
        note: note || null,
      },
    });

    return NextResponse.json({
      success: true,
      shiftCloseId: groupId,
      reconciliations: {
        cash: {
          id: result.cashRec.id,
          expected: summary.expectedCash,
          actual: actualCash,
          variance: actualCash - summary.expectedCash,
        },
        bank: {
          id: result.bankRec.id,
          expected: summary.expectedBank,
          actual: actualBank,
          variance: actualBank - summary.expectedBank,
        },
      },
      unpostedPaymentCount: summary.unpostedPaymentCount,
    });
  } catch (err) {
    console.error("OTC shift close error:", err);
    return NextResponse.json({ error: "Failed to close OTC shift" }, { status: 500 });
  }
}
