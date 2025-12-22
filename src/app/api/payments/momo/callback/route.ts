import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notifyPaymentEvent } from "@/lib/notifications";
import { parseMomoCallbackBody, verifyMomoSignature } from "@/lib/momo";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    if (!verifyMomoSignature(rawBody, req.headers)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }
    const parsed = parseMomoCallbackBody(rawBody);
    if (!parsed.valid || !parsed.externalId) {
      return NextResponse.json({ error: "Invalid callback" }, { status: 400 });
    }

    const paymentId = parsed.externalId;
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

    // Idempotency: if already marked success in note, return 200
    let note: Record<string, unknown> | null = null;
    if (payment.note) {
      try {
        note = JSON.parse(payment.note) as Record<string, unknown>;
      } catch {
        note = null;
      }
    }
    const alreadyDone = (note as { status?: string } | null)?.status === "success";
    if (alreadyDone) return NextResponse.json({ ok: true });

    const amount = Number(payment.amount || 0);

    if ((parsed.status || "").toUpperCase() !== "SUCCESSFUL") {
      // Mark as failed in note; keep record for audit
      const meta = {
        ...(note ?? {}),
        status: "failed" as const,
        providerStatus: parsed.status,
      };
      await prisma.payment.update({ where: { id: payment.id }, data: { note: JSON.stringify(meta) } });
      return NextResponse.json({ ok: true });
    }

    // Apply to order balances, similar to admin payments route
    const userIdForNotification = payment.userId || undefined;

    await prisma.$transaction(async (tx: TxClient) => {
      const fresh = await tx.payment.findUnique({ where: { id: payment.id } });
      if (!fresh) throw new Error("Payment disappeared");

      const userId = fresh.userId || undefined;
      const orderId = fresh.orderId || undefined;
      if (!userId) throw new Error("Payment missing userId");

      const beforeOrders = await tx.order.findMany({
        where: { userId, NOT: { status: "CANCELLED" } },
        select: { id: true, total: true, amountPaid: true, status: true },
        orderBy: { createdAt: "asc" },
      });
      const totalDueBefore = beforeOrders.reduce(
        (s: number, o: { total: unknown }) => s + Number(o.total || 0),
        0
      );
      const totalPaidBefore = beforeOrders.reduce(
        (s: number, o: { amountPaid: unknown }) => s + Number(o.amountPaid || 0),
        0
      );

      const applied: Array<{
        orderId: string;
        applied: number;
        newAmountPaid: number;
        newBalance: number;
        newStatus: string;
      }> = [];

      if (orderId) {
        const o = await tx.order.findUnique({ where: { id: orderId } });
        if (!o) throw new Error("Order not found");
        if (o.status === "CANCELLED") throw new Error("Cannot apply to cancelled order");
        const currentPaid = Number(o.amountPaid || 0);
        const total = Number(o.total);
        const remaining = Math.max(0, total - currentPaid);
        const applyAmt = Math.min(amount, remaining);
        const newAmountPaid = Math.max(0, currentPaid + applyAmt);
        const newBalance = Math.max(0, total - newAmountPaid);
        const newStatus = newBalance <= 0 ? "PAID" : newAmountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";
        const updated = await tx.order.update({ where: { id: o.id }, data: { amountPaid: newAmountPaid, balance: newBalance, status: newStatus } });
        applied.push({ orderId: updated.id, applied: applyAmt, newAmountPaid, newBalance, newStatus });
      } else {
        // Spread across open orders
        let remainingPayment = amount;
        for (const o of beforeOrders) {
          if (remainingPayment <= 0) break;
          if (o.status === "CANCELLED") continue;
          const paid = Number(o.amountPaid || 0);
          const total = Number(o.total);
          const remaining = Math.max(0, total - paid);
          if (remaining <= 0) continue;
          const applyAmt = Math.min(remainingPayment, remaining);
          const newAmountPaid = paid + applyAmt;
          const newBalance = Math.max(0, total - newAmountPaid);
          const newStatus = newBalance <= 0 ? "PAID" : newAmountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";
          const updated = await tx.order.update({ where: { id: o.id }, data: { amountPaid: newAmountPaid, balance: newBalance, status: newStatus } });
          applied.push({ orderId: updated.id, applied: applyAmt, newAmountPaid, newBalance, newStatus });
          remainingPayment -= applyAmt;
        }
      }

      const afterOrders = await tx.order.findMany({
        where: { userId, NOT: { status: "CANCELLED" } },
        select: { total: true, amountPaid: true },
      });
      const totalDueAfter = afterOrders.reduce(
        (s: number, o: { total: unknown }) => s + Number(o.total || 0),
        0
      );
      const totalPaidAfter = afterOrders.reduce(
        (s: number, o: { amountPaid: unknown }) => s + Number(o.amountPaid || 0),
        0
      );
      const balanceAfter = Math.max(0, totalDueAfter - totalPaidAfter);

      const meta = {
        ...(note ?? {}),
        status: "success" as const,
        applied,
        preTotals: {
          totalDue: totalDueBefore,
          totalPaid: totalPaidBefore,
        },
        postTotals: {
          totalDue: totalDueAfter,
          totalPaid: totalPaidAfter,
          balance: balanceAfter,
        },
      };
      await tx.payment.update({ where: { id: payment.id }, data: { note: JSON.stringify(meta) } });
    });

    // Notify customer about successful MoMo payment
    try {
      if (userIdForNotification) {
        const purpose = String((note?.purpose as string | undefined) ?? "");
        const subject =
          purpose === "order_checkout"
            ? "Order Confirmation & Receipt"
            : "Payment received — updated receipt";
        await notifyPaymentEvent({
          kind: "payment_recorded",
          userId: userIdForNotification,
          amount,
          orderId: payment.orderId || undefined,
          subject,
        });
      }
    } catch (e) {
      console.warn("notifyPaymentEvent (momo callback) error:", e);
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Callback error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
