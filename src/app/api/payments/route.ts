import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { paymentSchema } from "@/lib/validation";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { PaymentStatus, RefundDestination } from "@/lib/prisma-enums";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-payment-create", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const data = await req.json();
    const parsed = paymentSchema.safeParse(data);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payment payload" },
        { status: 400 }
      );
    }

    const {
      userId,
      orderId,
      amount,
      note,
      method,
      reference,
      receivedBy,
      location,
      status,
      refundDisposition,
    } = parsed.data;

    const normalizedStatus = (status || "normal").toUpperCase() as keyof typeof PaymentStatus;
    if (!Object.prototype.hasOwnProperty.call(PaymentStatus, normalizedStatus)) {
      return NextResponse.json({ error: "Invalid payment status" }, { status: 400 });
    }

    const isRefund = normalizedStatus === "REFUND";
    const refundMode = isRefund
      ? ((refundDisposition || "cash").toUpperCase() as keyof typeof RefundDestination)
      : undefined;
    if (isRefund && !Object.prototype.hasOwnProperty.call(RefundDestination, refundMode!)) {
      return NextResponse.json({ error: "Select how to handle the refund" }, { status: 400 });
    }

    // Validate user exists
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // If provided, validate order exists and belongs to user (defensive)
    if (orderId) {
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order) {
        return NextResponse.json({ error: "Order not found" }, { status: 404 });
      }
      if (order.userId !== userId) {
        return NextResponse.json(
          { error: "Order does not belong to this user" },
          { status: 400 }
        );
      }
    }

    const baseAmount = Number(amount);
    if (!Number.isFinite(baseAmount)) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }
    if (!isRefund && baseAmount <= 0) {
      return NextResponse.json({ error: "Amount must be greater than zero" }, { status: 400 });
    }
    if (isRefund && !orderId) {
      return NextResponse.json({ error: "Select an order to refund" }, { status: 400 });
    }

    const normalizedAmount = isRefund ? -Math.abs(baseAmount) : baseAmount;

    const result = await prisma.$transaction(async (tx) => {
      // Snapshot totals BEFORE applying payment
      const beforeOrders = await tx.order.findMany({
        where: { userId, NOT: { status: "CANCELLED" } },
        select: { total: true, amountPaid: true },
      });
      const totalDueBefore = beforeOrders.reduce((s, o) => s + Number(o.total || 0), 0);
      const totalPaidBefore = beforeOrders.reduce(
        (s, o) => s + Number(o.amountPaid || 0),
        0,
      );
      const balanceBefore = Math.max(0, totalDueBefore - totalPaidBefore);

      // Create the payment record first
      const meta = {
        note: note || undefined,
        method,
        reference,
        receivedBy,
        location,
        status,
        preTotals: { totalDue: totalDueBefore, totalPaid: totalPaidBefore, balance: balanceBefore },
      };
      const refundDispositionValue =
        isRefund && refundMode ? RefundDestination[refundMode] : null;

      const payment = await tx.payment.create({
        data: {
          userId,
          orderId,
          amount: normalizedAmount,
          note: JSON.stringify({
            ...meta,
            refundDisposition: refundDisposition || undefined,
          }),
          status: PaymentStatus[normalizedStatus],
          refundDisposition: refundDispositionValue || null,
        },
      });

      // Apply payment either to a single order or spread across open orders
      const applied: Array<{
        orderId: string;
        applied: number;
        newAmountPaid: number;
        newBalance: number;
        newStatus: string;
      }> = [];

      if (orderId) {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order) throw new Error("Order not found after payment create");
        if (order.status === "CANCELLED") throw new Error("Cannot apply payment to cancelled order");
        const currentPaid = Number(order.amountPaid ?? 0);
        const total = Number(order.total);
        let applyAmt = 0;
        if (normalizedAmount >= 0) {
          const remaining = Math.max(0, total - currentPaid);
          applyAmt = Math.min(normalizedAmount, remaining);
        } else {
          const refundable = Math.min(currentPaid, Math.abs(normalizedAmount));
          applyAmt = -refundable; // negative application reduces amountPaid
        }

        const newAmountPaid = Math.max(0, currentPaid + applyAmt);
        const newBalance = Math.max(0, total - newAmountPaid);
        const newStatus = newBalance <= 0 ? "PAID" : newAmountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";

        const updated = await tx.order.update({
          where: { id: orderId },
          data: {
            amountPaid: newAmountPaid,
            balance: newBalance,
            status: newStatus,
          },
        });

        applied.push({ orderId: updated.id, applied: applyAmt, newAmountPaid, newBalance, newStatus });
      } else {
        if (normalizedAmount < 0) {
          throw new Error("Negative payments require selecting an Order ID");
        }
        // Spread payment across user's open orders by oldest first
        let remainingPayment = normalizedAmount;
        const openOrders = await tx.order.findMany({
          where: {
            userId,
            NOT: { status: "CANCELLED" },
            OR: [{ status: "UNPAID" }, { status: "PARTIALLY_PAID" }, { status: "PENDING_PAYMENT" }],
          },
          orderBy: { createdAt: "asc" },
          select: { id: true, total: true, amountPaid: true },
        });

        for (const o of openOrders) {
          if (remainingPayment <= 0) break;
          const paid = Number(o.amountPaid ?? 0);
          const total = Number(o.total);
          const remaining = Math.max(0, total - paid);
          if (remaining <= 0) continue;
          const applyAmt = Math.min(remainingPayment, remaining);
          const newAmountPaid = paid + applyAmt;
          const newBalance = Math.max(0, total - newAmountPaid);
          const newStatus = newBalance <= 0 ? "PAID" : newAmountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";

          const updated = await tx.order.update({
            where: { id: o.id },
            data: {
              amountPaid: newAmountPaid,
              balance: newBalance,
              status: newStatus,
            },
          });
          applied.push({ orderId: updated.id, applied: applyAmt, newAmountPaid, newBalance, newStatus });
          remainingPayment -= applyAmt;
        }
      }

      // Snapshot totals AFTER applying payment to reflect new balance
      const afterOrders = await tx.order.findMany({
        where: { userId, NOT: { status: "CANCELLED" } },
        select: { total: true, amountPaid: true },
      });
      const totalDueAfter = afterOrders.reduce((s, o) => s + Number(o.total || 0), 0);
      const totalPaidAfter = afterOrders.reduce(
        (s, o) => s + Number(o.amountPaid || 0),
        0,
      );
      const balanceAfter = Math.max(0, totalDueAfter - totalPaidAfter);

      // Persist applied breakdown and pre/post totals on the payment note for auditing/receipts
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
      } catch {}

      let creditEntry: unknown = null;
      if (isRefund && refundDispositionValue === RefundDestination.CREDIT) {
        const creditNote = {
          sourceRefundId: payment.id,
          method: "adjustment",
          reason: "Refund held as credit",
          status: "normal",
        };
        creditEntry = await tx.payment.create({
          data: {
            userId,
            amount: Math.abs(normalizedAmount),
            note: JSON.stringify(creditNote),
            status: PaymentStatus.NORMAL,
          },
        });
      }

      return { payment, applied, credit: creditEntry };
    });

    return NextResponse.json(result);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to create payment";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
