import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getMomoStatus, type MomoProvider } from "@/lib/momo";
import { notifyPaymentEvent } from "@/lib/notifications";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await context.params;

  try {
    const payment = await prisma.payment.findUnique({ where: { id: params.id } });
    if (!payment) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const user = session.user as AuthenticatedUser;
    const isAdmin = user.role === "ADMIN";
    const isOwner = payment.userId && payment.userId === user.id;
    if (!isAdmin && !isOwner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    let meta: Record<string, unknown> | null = null;
    if (payment.note) {
      try {
        meta = JSON.parse(payment.note) as Record<string, unknown>;
      } catch {
        meta = null;
      }
    }
    const provider = String((meta?.provider as string | undefined) ?? "mtn") as MomoProvider;
    const ref = String((meta?.providerRef as string | undefined) ?? "");
    if (!ref) return NextResponse.json({ error: "No provider reference" }, { status: 400 });

    const status = await getMomoStatus(provider, ref);
    if (!status.ok) return NextResponse.json({ error: status.error || "Status error" }, { status: 502 });

    let appliedNow = false;
    if (String(status.status).toUpperCase() === "SUCCESSFUL") {
      // Apply to order balances if not already applied (idempotent)
      await prisma.$transaction(async (tx: TxClient) => {
        const fresh = await tx.payment.findUnique({ where: { id: payment.id } });
        if (!fresh) throw new Error("Payment disappeared");
        let currentMeta: Record<string, unknown> | null = null;
        if (fresh.note) {
          try {
            currentMeta = JSON.parse(fresh.note) as Record<string, unknown>;
          } catch {
            currentMeta = null;
          }
        }
        if ((currentMeta as { status?: string } | null)?.status === "success") return; // already applied
        const userId = fresh.userId || undefined;
        const orderId = fresh.orderId || undefined;
        if (!userId) throw new Error("Payment missing userId");

        const beforeOrders = await tx.order.findMany({
          where: { userId, NOT: { status: "CANCELLED" } },
          orderBy: { createdAt: "asc" },
          select: { id: true, status: true, total: true, amountPaid: true },
        });
        const amount = Number(fresh.amount || 0);
        const applied: Array<{
          orderId: string;
          applied: number;
          newAmountPaid: number;
          newBalance: number;
          newStatus: string;
        }> = [];
        const epsilon = 0.01; // treat very small balances as fully paid
        if (orderId) {
          const o = await tx.order.findUnique({ where: { id: orderId } });
          if (!o) throw new Error("Order not found");
          if (o.status !== "CANCELLED") {
            const paid = Number(o.amountPaid || 0);
            const total = Number(o.total);
            const remaining = Math.max(0, total - paid);
            const applyAmt = Math.min(amount, remaining);
            const newPaid = Math.max(0, paid + applyAmt);
            const rawBalance = total - newPaid;
            const newBalance = rawBalance <= epsilon ? 0 : Math.max(0, rawBalance);
            const newStatus =
              newBalance <= 0 ? "PAID" : newPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";
            const updated = await tx.order.update({ where: { id: o.id }, data: { amountPaid: newPaid, balance: newBalance, status: newStatus } });
            applied.push({ orderId: updated.id, applied: applyAmt, newAmountPaid: newPaid, newBalance, newStatus });
          }
        } else {
          let remainingPayment = amount;
          for (const o of beforeOrders) {
            if (remainingPayment <= 0) break;
            if (o.status === "CANCELLED") continue;
            const paid = Number(o.amountPaid || 0);
            const total = Number(o.total);
            const remaining = Math.max(0, total - paid);
            if (remaining <= 0) continue;
            const applyAmt = Math.min(remainingPayment, remaining);
            const newPaid = paid + applyAmt;
            const rawBalance = total - newPaid;
            const newBalance = rawBalance <= epsilon ? 0 : Math.max(0, rawBalance);
            const newStatus =
              newBalance <= 0 ? "PAID" : newPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";
            const updated = await tx.order.update({ where: { id: o.id }, data: { amountPaid: newPaid, balance: newBalance, status: newStatus } });
            applied.push({ orderId: updated.id, applied: applyAmt, newAmountPaid: newPaid, newBalance, newStatus });
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
        const newMeta = {
          ...(currentMeta ?? {}),
          status: "success" as const,
          applied,
          postTotals: {
            totalDue: totalDueAfter,
            totalPaid: totalPaidAfter,
            balance: balanceAfter,
          },
        };
        await tx.payment.update({
          where: { id: payment.id },
          data: { note: JSON.stringify(newMeta) },
        });
        appliedNow = true;
      });
    }

    if (appliedNow && payment.userId) {
      try {
        const purpose = String((meta?.purpose as string | undefined) ?? "");
        const subject =
          purpose === "order_checkout"
            ? "Order Confirmation & Receipt"
            : "Payment received — updated receipt";
        await notifyPaymentEvent({
          kind: "payment_recorded",
          userId: payment.userId,
          amount: Number(payment.amount || 0),
          orderId: payment.orderId || undefined,
          subject,
        });
      } catch (e) {
        console.warn("notifyPaymentEvent (momo status) error:", e);
      }
    }

    return NextResponse.json({ ok: true, status: status.status });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
