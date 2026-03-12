import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PaymentStatus } from "@/lib/prisma-enums";
import { assertSameOrigin } from "@/lib/origin";
import { recomputeOrderTotalsFromPayments } from "@/lib/payments";
import { postPaymentEntry } from "@/lib/accounting-posting";
import { randomUUID } from "crypto";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (
  arg: infer A,
) => unknown
  ? A
  : never;

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as AuthenticatedUser;
  const userId = user.id;

  try {
    const result = await prisma.$transaction(async (tx: TxClient) => {
      const orders = await tx.order.findMany({
        where: { userId, NOT: { status: "CANCELLED" } },
        select: { id: true, total: true, amountPaid: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const payments = await tx.payment.findMany({
        where: {
          userId,
        },
        select: { amount: true, status: true, refundDisposition: true, note: true },
      });

      const totalDue = orders.reduce(
        (s, o) => s + Number(o.total || 0),
        0,
      );
      const totalPaid = orders.reduce(
        (s, o) => s + Number(o.amountPaid || 0),
        0,
      );
      const balance = Math.max(0, totalDue - totalPaid);

      // Store credit: credits from returns/adjustments, minus AUTO_APPLY
      // applications and prior cash payouts of credit.
      let credit = 0;
      for (const p of payments as Array<{
        amount: unknown;
        status: unknown;
        refundDisposition: unknown;
        note: string | null;
      }>) {
        const amount = Number(p.amount || 0);
        const note = p.note || "";
        const isAutoApply = note.includes("\"reference\":\"AUTO_APPLY\"");
        const isCreditIssued =
          p.status === PaymentStatus.NORMAL &&
          p.refundDisposition === "CREDIT" &&
          amount > 0;
        const isCreditCashPayout =
          p.status === PaymentStatus.REFUND &&
          p.refundDisposition === "CASH" &&
          note.includes("\"location\":\"admin/customers:credit-payout\"");

        if (isCreditIssued) {
          credit += amount;
        } else if (isAutoApply) {
          credit -= amount;
        } else if (isCreditCashPayout) {
          // negative amount reduces credit
          credit += amount;
        }
      }
      credit = Math.max(0, credit);

      if (balance <= 0.005 || credit <= 0.005) {
        return {
          applied: 0,
          remainingBalance: balance,
          remainingCredit: credit,
          createdPaymentIds: [],
        };
      }

      const amountToApply = Math.min(balance, credit);

      const beforeOrders = await tx.order.findMany({
        where: { userId, NOT: { status: "CANCELLED" } },
        select: { total: true, amountPaid: true },
      });
      const totalDueBefore = beforeOrders.reduce(
        (s: number, o: { total: unknown }) => s + Number(o.total || 0),
        0,
      );
      const totalPaidBefore = beforeOrders.reduce(
        (s: number, o: { amountPaid: unknown }) => s + Number(o.amountPaid || 0),
        0,
      );
      const balanceBefore = Math.max(0, totalDueBefore - totalPaidBefore);

      const meta = {
        note: "Customer-applied store credit",
        method: "adjustment",
        reference: "AUTO_APPLY",
        receivedBy: "system",
        location: "account/apply-credit",
        status: "normal",
        preTotals: {
          totalDue: totalDueBefore,
          totalPaid: totalPaidBefore,
          balance: balanceBefore,
        },
      };

      let remainingPayment = amountToApply;
      const applied: Array<{
        orderId: string;
        applied: number;
        newAmountPaid: number;
        newBalance: number;
        newStatus: string;
      }> = [];
      const batchId = randomUUID();
      const createdPayments: Array<{ id: string; orderId: string; applied: number }> = [];

      for (const o of orders) {
        if (remainingPayment <= 0) break;
        const paid = Number(o.amountPaid ?? 0);
        const total = Number(o.total);
        const remaining = Math.max(0, total - paid);
        if (remaining <= 0) continue;
        const applyAmt = Math.min(remainingPayment, remaining);
        const payment = await tx.payment.create({
          data: {
            userId,
            orderId: o.id,
            amount: applyAmt,
            note: JSON.stringify({
              ...meta,
              batchId,
              applied: [{ orderId: o.id, applied: applyAmt }],
            }),
            status: PaymentStatus.NORMAL,
            refundDisposition: null,
          },
        });
        createdPayments.push({ id: payment.id, orderId: o.id, applied: applyAmt });

        const updated = await recomputeOrderTotalsFromPayments(tx, o.id);
        applied.push({
          orderId: updated.id,
          applied: applyAmt,
          newAmountPaid: Number(updated.amountPaid ?? 0),
          newBalance: Number(updated.balance ?? 0),
          newStatus: String(updated.status),
        });
        remainingPayment -= applyAmt;
      }

      const afterOrders = await tx.order.findMany({
        where: { userId, NOT: { status: "CANCELLED" } },
        select: { total: true, amountPaid: true },
      });
      const totalDueAfter = afterOrders.reduce(
        (s: number, o: { total: unknown }) => s + Number(o.total || 0),
        0,
      );
      const totalPaidAfter = afterOrders.reduce(
        (s: number, o: { amountPaid: unknown }) => s + Number(o.amountPaid || 0),
        0,
      );
      const balanceAfter = Math.max(0, totalDueAfter - totalPaidAfter);

      if (createdPayments.length > 0) {
        try {
          const withAppliedBase = {
            ...meta,
            batchId,
            batchAppliedTotal: amountToApply,
            batchAppliedCount: createdPayments.length,
            postTotals: {
              totalDue: totalDueAfter,
              totalPaid: totalPaidAfter,
              balance: balanceAfter,
            },
          };
          for (const row of createdPayments) {
            await tx.payment.update({
              where: { id: row.id },
              data: {
                note: JSON.stringify({
                  ...withAppliedBase,
                  applied: [{ orderId: row.orderId, applied: row.applied }],
                }),
              },
            });
          }
        } catch {}
      }

      const remainingCredit = Math.max(
        0,
        credit - amountToApply,
      );

      return {
        applied: amountToApply,
        remainingBalance: balanceAfter,
        remainingCredit,
        createdPaymentIds: createdPayments.map((p) => p.id),
      };
    });

    for (const paymentId of result.createdPaymentIds) {
      await postPaymentEntry({ paymentId });
    }

    return NextResponse.json({
      applied: result.applied,
      remainingBalance: result.remainingBalance,
      remainingCredit: result.remainingCredit,
    });
  } catch (e) {
    console.error("apply credit error", e);
    return NextResponse.json(
      { error: "Failed to apply store credit" },
      { status: 500 },
    );
  }
}
