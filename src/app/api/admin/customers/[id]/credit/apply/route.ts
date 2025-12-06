import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PaymentStatus, RefundDestination } from "@/lib/prisma-enums";
import { assertSameOrigin } from "@/lib/origin";

type TxClient = Parameters<(typeof prisma)["$transaction"]>[0] extends (
  arg: infer A,
) => unknown
  ? A
  : never;

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as AuthenticatedUser;
  const role = user.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!isAdmin && !isAccountant) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = await context.params;
  const userId = params.id;

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

      // Store credit ledger: credits issued (NORMAL + CREDIT),
      // minus AUTO_APPLY applications and cash payouts of credit.
      let credit = 0;
      for (const p of payments as Array<{
        amount: unknown;
        status: string | null;
        refundDisposition: string | null;
        note: string | null;
      }>) {
        const amount = Number(p.amount || 0);
        const note = p.note || "";
        const isAutoApply = note.includes("\"reference\":\"AUTO_APPLY\"");
        const isCreditIssued =
          p.status === PaymentStatus.NORMAL &&
          p.refundDisposition === RefundDestination.CREDIT &&
          amount > 0;
        const isCreditCashPayout =
          p.status === PaymentStatus.REFUND &&
          p.refundDisposition === RefundDestination.CASH &&
          note.includes("\"location\":\"admin/customers:credit-payout\"");

        if (isCreditIssued) {
          credit += amount;
        } else if (isAutoApply) {
          credit -= amount;
        } else if (isCreditCashPayout) {
          // amount is negative; reduce credit
          credit += amount;
        }
      }
      credit = Math.max(0, credit);

      if (balance <= 0.005 || credit <= 0.005) {
        return {
          applied: 0,
          remainingBalance: balance,
          remainingCredit: credit,
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
        (s: number, o: { amountPaid: unknown }) =>
          s + Number(o.amountPaid || 0),
        0,
      );
      const balanceBefore = Math.max(0, totalDueBefore - totalPaidBefore);

      const meta = {
        note: "Admin-applied store credit",
        method: "adjustment",
        reference: "AUTO_APPLY",
        receivedBy: user.email || user.name || "admin",
        location: "admin/customers/credit/apply",
        status: "normal",
        preTotals: {
          totalDue: totalDueBefore,
          totalPaid: totalPaidBefore,
          balance: balanceBefore,
        },
      };

      const payment = await tx.payment.create({
        data: {
          userId,
          amount: amountToApply,
          note: JSON.stringify(meta),
          status: PaymentStatus.NORMAL,
          refundDisposition: null,
        },
      });

      let remainingPayment = amountToApply;
      const applied: Array<{
        orderId: string;
        applied: number;
        newAmountPaid: number;
        newBalance: number;
        newStatus: string;
      }> = [];

      for (const o of orders) {
        if (remainingPayment <= 0) break;
        const paid = Number(o.amountPaid ?? 0);
        const total = Number(o.total);
        const remaining = Math.max(0, total - paid);
        if (remaining <= 0) continue;
        const applyAmt = Math.min(remainingPayment, remaining);
        const newAmountPaid = paid + applyAmt;
        const newBalance = Math.max(0, total - newAmountPaid);
        const newStatus =
          newBalance <= 0
            ? "PAID"
            : newAmountPaid > 0
            ? "PARTIALLY_PAID"
            : "UNPAID";

        const updated = await tx.order.update({
          where: { id: o.id },
          data: {
            amountPaid: newAmountPaid,
            balance: newBalance,
            status: newStatus,
          },
        });

        applied.push({
          orderId: updated.id,
          applied: applyAmt,
          newAmountPaid,
          newBalance: newBalance,
          newStatus,
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
        (s: number, o: { amountPaid: unknown }) =>
          s + Number(o.amountPaid || 0),
        0,
      );
      const balanceAfter = Math.max(0, totalDueAfter - totalPaidAfter);

      try {
        const withApplied = {
          ...meta,
          applied,
          postTotals: {
            totalDue: totalDueAfter,
            totalPaid: totalPaidAfter,
            balance: balanceAfter,
          },
        };
        await tx.payment.update({
          where: { id: payment.id },
          data: { note: JSON.stringify(withApplied) },
        });
      } catch {
        // best-effort to enrich metadata
      }

      const remainingCredit = Math.max(0, credit - amountToApply);

      return {
        applied: amountToApply,
        remainingBalance: balanceAfter,
        remainingCredit,
      };
    });

    return NextResponse.json(result);
  } catch (e) {
    console.error("Admin apply credit error", e);
    return NextResponse.json(
      { error: "Failed to apply store credit" },
      { status: 500 },
    );
  }
}
