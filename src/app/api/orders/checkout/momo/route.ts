import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { initiateMomo, isValidPhone, normalizePhoneGH } from "@/lib/momo";
import { notifyOrderEvent, notifyPaymentEvent } from "@/lib/notifications";
import { computeReceiptHash } from "@/lib/receipt-hash";
import { recomputeOrderTotalsFromPayments } from "@/lib/payments";
import { randomUUID } from "crypto";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

const schema = z.object({
  phone: z.string().min(7),
  provider: z.enum(["mtn", "vodafone", "airteltigo"]).default("mtn"),
  amount: z.coerce.number().positive().optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  try {
    const body = await req.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

    const userId = (session.user as AuthenticatedUser).id;
    const phone = normalizePhoneGH(parsed.data.phone || "");
    const provider = parsed.data.provider;
    if (!isValidPhone(phone)) return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });

    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true } } },
    });
    if (!cart || cart.items.length === 0) return NextResponse.json({ error: "Empty cart" }, { status: 400 });

    // Compute total
    const total = cart.items.reduce(
      (s: number, it: { quantity: number; product: { price: unknown } }) => s + Number(it.product.price) * it.quantity,
      0
    );
    if (!(total > 0)) return NextResponse.json({ error: "Invalid total" }, { status: 400 });

    // Create order, items, update stock, clear cart, then auto-apply any
    // existing store credit across the customer's open orders (including this
    // new one), using the same rules as the standard checkout flow. Finally,
    // return the refreshed order with its updated balance after credit.
    const order = await prisma.$transaction(async (tx: TxClient) => {
      const o = await tx.order.create({
        data: {
          userId,
          subtotal: total,
          taxRate: 0,
          taxAmount: 0,
          total,
          amountPaid: 0,
          balance: total,
          status: "UNPAID",
        },
      });
      await tx.orderItem.createMany({
        data: cart.items.map(
          (ci: { productId: string; product: { price: unknown; cost: unknown }; quantity: number }) => ({
            orderId: o.id,
            productId: ci.productId,
            price: Number(ci.product.price),
            costAtSale: Number(ci.product.cost ?? 0),
            quantity: ci.quantity,
          })
        ),
      });
      for (const ci of cart.items as Array<{ productId: string; quantity: number }>) {
        await tx.product.update({ where: { id: ci.productId }, data: { stock: { decrement: ci.quantity } } });
        await tx.inventoryMovement.create({ data: { productId: ci.productId, delta: -ci.quantity, reason: "SALE" } });
      }
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      const invoiceNumber = `INV-${o.id}`;
      const receiptHash = computeReceiptHash({
        orderId: o.id,
        invoiceNumber,
        subtotal: total,
        taxRate: 0,
        taxAmount: 0,
        total,
        createdAt: o.createdAt.toISOString(),
        items: cart.items.map((ci: { productId: string; quantity: number; product: { price: unknown } }) => ({
          productId: ci.productId,
          quantity: ci.quantity,
          price: Number(ci.product.price),
        })),
      });
      await tx.order.update({
        where: { id: o.id },
        data: { invoiceNumber, receiptHash },
      });

      // Auto-apply store credit across open orders (oldest first), mirroring
      // the logic in /api/orders POST so behaviour is consistent regardless of
      // whether the customer pays via MoMo or by arranging payment later.
      const orders = await tx.order.findMany({
        where: { userId, NOT: { status: "CANCELLED" } },
        select: { id: true, total: true, amountPaid: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const payments = await tx.payment.findMany({
        where: {
          userId,
          NOT: {
            note: {
              contains: "\"reference\":\"AUTO_APPLY\"",
            },
          },
        },
        select: { amount: true },
      });

      const totalDue = orders.reduce(
        (s, o) => s + Number(o.total || 0),
        0,
      );
      const totalPaid = orders.reduce(
        (s, o) => s + Number(o.amountPaid || 0),
        0,
      );
      const paymentsTotal = payments.reduce(
        (s, p) => s + Number(p.amount || 0),
        0,
      );

      const balance = Math.max(0, totalDue - totalPaid);
      const credit = Math.max(0, paymentsTotal - totalPaid);

      if (balance > 0.005 && credit > 0.005) {
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
          note: "Customer-applied store credit (auto during MoMo checkout)",
          method: "adjustment",
          reference: "AUTO_APPLY",
          receivedBy: "system",
          location: "orders/checkout-momo",
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
        const createdPaymentIds: string[] = [];

        for (const ord of orders) {
          if (remainingPayment <= 0) break;
          const paid = Number(ord.amountPaid ?? 0);
          const totalO = Number(ord.total);
          const remainingO = Math.max(0, totalO - paid);
          if (remainingO <= 0) continue;
          const applyAmt = Math.min(remainingPayment, remainingO);
          const payment = await tx.payment.create({
            data: {
              userId,
              orderId: ord.id,
              amount: applyAmt,
              note: JSON.stringify({
                ...meta,
                batchId,
                applied: [{ orderId: ord.id, applied: applyAmt }],
              }),
              status: "NORMAL",
              refundDisposition: null,
            },
          });
          createdPaymentIds.push(payment.id);

          const updatedO = await recomputeOrderTotalsFromPayments(tx, ord.id);
          applied.push({
            orderId: updatedO.id,
            applied: applyAmt,
            newAmountPaid: Number(updatedO.amountPaid ?? 0),
            newBalance: Number(updatedO.balance ?? 0),
            newStatus: String(updatedO.status),
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

        if (createdPaymentIds.length > 0) {
          try {
            const withApplied = {
              ...meta,
              batchId,
              applied,
              postTotals: {
                totalDue: totalDueAfter,
                totalPaid: totalPaidAfter,
                balance: balanceAfter,
              },
            };
            for (const id of createdPaymentIds) {
              await tx.payment.update({
                where: { id },
                data: { note: JSON.stringify(withApplied) },
              });
            }
          } catch {}
        }
      }

      const refreshed = await tx.order.findUnique({
        where: { id: o.id },
        select: { id: true, total: true, amountPaid: true, balance: true, status: true },
      });

      return refreshed ?? o;
    });

    // Create pending payment (supports partial)
    const amountOverride = parsed.data.amount;
    const orderBalance = Math.max(
      0,
      Number((order as { balance?: unknown } | null | undefined)?.balance ?? total),
    );

    let chargeAmount = orderBalance;
    if (amountOverride != null) {
      const requested = Number(amountOverride);
      if (Number.isFinite(requested) && requested > 0) {
        chargeAmount = Math.min(orderBalance, requested);
      }
    }

    // If store credit (and/or previous payments) fully cover this order,
    // there is nothing left to charge via MoMo.
    if (!(chargeAmount > 0)) {
      try {
        await notifyOrderEvent({
          kind: "order_created",
          userId,
          orderId: order.id,
          total,
        });
      } catch (e) {
        console.warn("notifyOrderEvent (checkout-momo zero balance) error:", e);
      }
      return NextResponse.json({
        ok: true,
        applied: true,
        orderId: order.id,
        paymentId: null,
        simulated: false,
      });
    }

    chargeAmount = Math.max(0.01, chargeAmount);
    const meta = {
      method: "momo" as const,
      provider,
      status: "pending" as const,
      phone,
      orderId: order.id,
      purpose: "order_checkout" as const,
    };
    const payment = await prisma.payment.create({ data: { userId, orderId: order.id, amount: chargeAmount, note: JSON.stringify(meta) } });

    const init = await initiateMomo({
      provider,
      amount: chargeAmount,
      phone,
      externalId: payment.id,
      description: `Order ${order.id}`,
    });
    if (!init.ok) {
      try {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { deletedAt: new Date() },
        });
      } catch {}
      return NextResponse.json({ error: init.error || "MoMo failed", orderId: order.id }, { status: 502 });
    }

    // Local/dev: TEST- reference means apply immediately
    const isTestRef = String(init.reference || "").startsWith("TEST-");
    if (isTestRef) {
      await prisma.$transaction(async (tx: TxClient) => {
        const o = await tx.order.findUnique({ where: { id: order.id } });
        if (!o) throw new Error("Order not found");
        const total2 = Number(o.total || 0);
        const applyAmt = Math.min(chargeAmount, total2);
        const newPaid = Math.max(0, applyAmt);
        const epsilon = 0.01;
        const rawBalance = total2 - newPaid;
        const newBalance = rawBalance <= epsilon ? 0 : Math.max(0, rawBalance);
        const newStatus =
          newBalance <= 0
            ? "PAID"
            : newPaid > 0
            ? "PARTIALLY_PAID"
            : "UNPAID";
        await tx.order.update({
          where: { id: o.id },
          data: { amountPaid: newPaid, balance: newBalance, status: newStatus },
        });
        const note = {
          ...meta,
          status: "success" as const,
          providerRef: init.reference,
          applied: [
            {
              orderId: o.id,
              applied: applyAmt,
              newAmountPaid: newPaid,
              newBalance,
              newStatus,
            },
          ],
        };
        await tx.payment.update({
          where: { id: payment.id },
          data: { note: JSON.stringify(note) },
        });
      });
      try {
        await notifyPaymentEvent({
          kind: "payment_recorded",
          userId,
          amount: chargeAmount,
          orderId: order.id,
          subject: "Order Confirmation & Receipt",
        });
      } catch (e) {
        console.warn("notifyPaymentEvent (checkout-momo test) error:", e);
      }
      return NextResponse.json({
        ok: true,
        applied: true,
        orderId: order.id,
        paymentId: payment.id,
        simulated: true,
      });
    }

    // Store provider ref for polling
    try {
      const withRef = { ...meta, providerRef: init.reference };
      await prisma.payment.update({
        where: { id: payment.id },
        data: { note: JSON.stringify(withRef) },
      });
    } catch {}

    return NextResponse.json({ ok: true, orderId: order.id, paymentId: payment.id });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
