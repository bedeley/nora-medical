import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { initiateMomo } from "@/lib/momo";
import { rateLimit } from "@/lib/rate-limit";
import { isLiveStage } from "@/lib/env";
import { recordAuditLog } from "@/lib/audit-log";
import { postPaymentEntry } from "@/lib/accounting-posting";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;
function maskProviderRef(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.length <= 8) return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
}

const schema = z.object({
  orderId: z.string().cuid().optional(),
  phone: z.string().min(7),
  provider: z.enum(["mtn", "vodafone", "airteltigo"]).default("mtn"),
  amount: z.coerce.number().positive().optional(), // optional partial payment
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "momo-initiate", 60_000, 10);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const userId = (session.user as AuthenticatedUser).id;
    const customerProfile = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, phone: true },
    });
    const { orderId, phone, provider } = parsed.data;
    const amountOverride = parsed.data.amount;

    const order = orderId
      ? await prisma.order.findFirst({
          where: { id: orderId, userId, status: { not: "CANCELLED" } },
        })
      : null;
    if (orderId && !order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const outstandingOrders = order
      ? [order]
      : await prisma.order.findMany({
          where: {
            userId,
            status: { not: "CANCELLED" },
            OR: [{ status: "UNPAID" }, { status: "PARTIALLY_PAID" }, { status: "PENDING_PAYMENT" }],
          },
          orderBy: { createdAt: "asc" },
          select: { id: true, total: true, amountPaid: true, status: true, balance: true },
        });
    const balance = outstandingOrders.reduce((sum, row) => {
      const total = Number(row.total || 0);
      const paid = Number(row.amountPaid || 0);
      const raw = Number(row.balance ?? Math.max(0, total - paid));
      return sum + Math.max(0, raw);
    }, 0);
    if (balance <= 0) return NextResponse.json({ error: "Order already paid" }, { status: 400 });

    const amount = Math.max(0.01, Math.min(balance, Number(amountOverride || balance)));

    // Create a pending payment record with metadata
    const meta = {
      method: "momo",
      provider,
      status: "pending",
      phone,
      orderId,
      purpose: "balance_payment",
      allocationScope: orderId ? "single_order" : "all_open_orders_oldest_first",
      ordersAffected: outstandingOrders.map((o) => o.id),
      orderCount: outstandingOrders.length,
      orderCountOpen: outstandingOrders.length,
      outstandingBefore: balance,
    };

    const payment = await prisma.payment.create({
      data: {
        userId,
        orderId,
        amount,
        note: JSON.stringify(meta),
      },
    });
    try {
      await recordAuditLog({
        actorId: userId,
        action: "PAYMENT_CREATE",
        entityType: "PAYMENT",
        entityId: payment.id,
        meta: {
          paymentId: payment.id,
          initiatedAt: payment.createdAt.toISOString(),
          actorType: "CUSTOMER",
          channel: "portal",
          sourceRoute: "/api/payments/momo/initiate",
          customerId: userId,
          customerName: customerProfile?.name || null,
          customerEmail: customerProfile?.email || null,
          customerPhone: customerProfile?.phone || null,
          orderId: orderId || null,
          invoiceNumber: order ? order.invoiceNumber || `INV-${order.id}` : null,
          orderStatusBefore: order ? String(order.status || "UNPAID") : null,
          remainingBalanceBefore: balance,
          amount,
          method: "momo",
          paymentMethodLabel: "MoMo",
          provider,
          captureMode: "provider_request",
          allocationScope: orderId ? "single_order" : "all_open_orders_oldest_first",
          ordersAffected: outstandingOrders.map((o) => o.id),
          orderCount: outstandingOrders.length,
          orderCountOpen: outstandingOrders.length,
          providerRefMasked: null,
          status: "PENDING",
        },
      });
    } catch {}

    const init = await initiateMomo({
      provider,
      amount,
      phone,
      externalId: payment.id,
      description: orderId ? `Order ${orderId}` : `Customer balance ${userId}`,
    });

    if (!init.ok) {
      // Cleanup the pending record to avoid confusion
      try {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { deletedAt: new Date() },
        });
      } catch {}
      try {
        await recordAuditLog({
          actorId: userId,
          action: "PAYMENT_FAILED",
          entityType: "PAYMENT",
          entityId: payment.id,
          meta: {
            actorType: "CUSTOMER",
            channel: "portal",
            resolvedBy: "INITIATE",
            customerId: userId,
            orderId,
            amount,
            method: "momo",
            provider,
            providerRef: null,
            error: init.error || "Failed to initiate MoMo",
          },
        });
      } catch {}
      return NextResponse.json({ error: init.error }, { status: 502 });
    }

    // If running in local/sandbox without provider keys, our momo lib returns
    // a TEST- reference. In that case, apply the payment immediately so the
    // customer flow works without polling.
    const isTestRef = String(init.reference || "").startsWith("TEST-");
    if (isTestRef && !isLiveStage()) {
      await prisma.$transaction(async (tx: TxClient) => {
        const fresh = await tx.payment.findUnique({ where: { id: payment.id } });
        if (!fresh) throw new Error('Payment disappeared');
        const userId2 = fresh.userId || undefined;
        const orderId2 = fresh.orderId || undefined;
        if (!userId2) throw new Error("Payment missing userId");
        const amount2 = Number(fresh.amount || 0);
        const applied: Array<{
          orderId: string;
          applied: number;
          newAmountPaid: number;
          newBalance: number;
          newStatus: string;
        }> = [];
        if (orderId2) {
          const o = await tx.order.findUnique({ where: { id: orderId2 } });
          if (!o) throw new Error("Order not found");
          if (o.status !== "CANCELLED") {
            const paid = Number(o.amountPaid || 0);
            const total = Number(o.total);
            const remaining = Math.max(0, total - paid);
            const applyAmt = Math.min(amount2, remaining);
            const newPaid = Math.max(0, paid + applyAmt);
            const newBalance = Math.max(0, total - newPaid);
            const newStatus = newBalance <= 0 ? "PAID" : newPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";
            const updated = await tx.order.update({ where: { id: o.id }, data: { amountPaid: newPaid, balance: newBalance, status: newStatus } });
            applied.push({ orderId: updated.id, applied: applyAmt, newAmountPaid: newPaid, newBalance, newStatus });
          }
        } else {
          let remainingPayment = amount2;
          const openOrders = await tx.order.findMany({
            where: {
              userId: userId2,
              NOT: { status: "CANCELLED" },
              OR: [{ status: "UNPAID" }, { status: "PARTIALLY_PAID" }, { status: "PENDING_PAYMENT" }],
            },
            orderBy: { createdAt: "asc" },
          });
          for (const o of openOrders) {
            if (remainingPayment <= 0) break;
            const paid = Number(o.amountPaid || 0);
            const total = Number(o.total || 0);
            const remaining = Math.max(0, total - paid);
            if (remaining <= 0) continue;
            const applyAmt = Math.min(remainingPayment, remaining);
            const newPaid = Math.max(0, paid + applyAmt);
            const newBalance = Math.max(0, total - newPaid);
            const newStatus = newBalance <= 0 ? "PAID" : newPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";
            const updated = await tx.order.update({
              where: { id: o.id },
              data: { amountPaid: newPaid, balance: newBalance, status: newStatus },
            });
            applied.push({ orderId: updated.id, applied: applyAmt, newAmountPaid: newPaid, newBalance, newStatus });
            remainingPayment -= applyAmt;
          }
        }
        const withRef = { ...meta, providerRef: init.reference, status: "success", applied };
        await tx.payment.update({ where: { id: payment.id }, data: { note: JSON.stringify(withRef) } });
      });
      let postingJournalEntryId: string | null = null;
      try {
        const posted = await postPaymentEntry({ paymentId: payment.id });
        postingJournalEntryId = posted?.id || null;
      } catch (e) {
        console.warn("Accounting payment posting skipped (momo initiate simulated):", e);
      }
      if (!postingJournalEntryId) {
        const existingPosted = await prisma.journalEntry.findFirst({
          where: {
            sourceType: "PAYMENT",
            status: "POSTED",
            OR: [
              { sourceId: payment.id },
              { sourceId: { startsWith: `${payment.id}:` } },
            ],
          },
          select: { id: true },
          orderBy: { createdAt: "desc" },
        });
        postingJournalEntryId = existingPosted?.id || null;
      }
      const orderBalanceAfter = orderId
        ? (
            await prisma.order.findUnique({
              where: { id: orderId },
              select: { balance: true },
            })
          )?.balance
        : null;
      try {
        const paymentAfter = await prisma.payment.findUnique({
          where: { id: payment.id },
          select: { note: true },
        });
        const parsedAfter = (() => {
          try {
            return paymentAfter?.note
              ? (JSON.parse(paymentAfter.note) as Record<string, unknown>)
              : null;
          } catch {
            return null;
          }
        })();
        const appliedRaw = Array.isArray(parsedAfter?.applied)
          ? (parsedAfter?.applied as Array<Record<string, unknown>>)
          : [];
        const appliedAllocations = appliedRaw
          .map((row) => {
            const allocOrderId = String(row.orderId || "").trim();
            const allocAmount = Number(row.applied || 0);
            const remainingAfter = Number(row.newBalance);
            if (!allocOrderId || !Number.isFinite(allocAmount) || allocAmount <= 0) return null;
            return {
              orderId: allocOrderId,
              amount: allocAmount,
              remainingAfter: Number.isFinite(remainingAfter) ? remainingAfter : null,
            };
          })
          .filter(
            (row): row is { orderId: string; amount: number; remainingAfter: number | null } =>
              Boolean(row),
          );
        const appliedTotal = appliedAllocations.reduce((s, row) => s + row.amount, 0);
        const postTotals = (parsedAfter?.postTotals as Record<string, unknown> | undefined) || null;
        await recordAuditLog({
          actorId: userId,
          action: "PAYMENT_SUCCESS",
          entityType: "PAYMENT",
          entityId: payment.id,
          meta: {
            actorType: "CUSTOMER",
            channel: "portal",
            resolvedBy: "INITIATE",
            customerId: userId,
            orderId,
            paymentId: payment.id,
            amount,
            method: "momo",
            paymentMethodLabel: "MoMo",
            provider,
            providerRef: maskProviderRef(init.reference),
            source: "TEST_REFERENCE_AUTO_APPLY",
            allocationScope: orderId ? "single_order" : "all_open_orders_oldest_first",
            ordersAffected: appliedAllocations.map((row) => row.orderId),
            orderCount: appliedAllocations.length,
            appliedAllocations,
            appliedTotal,
            remainingBalanceBefore: balance,
            remainingBalanceAfter:
              postTotals && Number.isFinite(Number(postTotals.balance))
                ? Number(postTotals.balance)
                : null,
            postingStatus: postingJournalEntryId ? "POSTED" : "PENDING",
            journalEntryId: postingJournalEntryId,
            balanceAfter:
              orderBalanceAfter == null ? null : Number(orderBalanceAfter),
          },
        });
      } catch {}
      return NextResponse.json({
        ok: true,
        paymentId: payment.id,
        reference: init.reference,
        applied: true,
        simulated: true,
      });
    }

    // Store provider reference for later polling
    try {
      const withRef = { ...meta, providerRef: init.reference };
      await prisma.payment.update({ where: { id: payment.id }, data: { note: JSON.stringify(withRef) } });
    } catch {}

    if (isTestRef && isLiveStage()) {
      // Defensive: shouldn't happen because initiateMomo fails closed in live stage
      return NextResponse.json({ error: "MoMo test reference not allowed in production" }, { status: 502 });
    }

    return NextResponse.json({ ok: true, paymentId: payment.id, reference: init.reference });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to initiate MoMo";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
