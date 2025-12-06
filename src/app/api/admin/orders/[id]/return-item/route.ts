import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { PaymentStatus, RefundDestination } from "@/lib/prisma-enums";
import { notifyPaymentEvent } from "@/lib/notifications";
import { recordAuditLog } from "@/lib/audit-log";
import { z } from "zod";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

const returnSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().positive(),
  refundMode: z.enum(["cash", "credit"]),
  // Whether returned units should be added back into stock.
  restock: z.boolean().optional(),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isAccountant)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const limited = await rateLimit(req, "admin-order-item-return", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const params = await context.params;
  const orderId = params.id;

  try {
    const body = await req.json();
    const parsed = returnSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid return payload" }, { status: 400 });
    }

    const { itemId, quantity, refundMode, restock } = parsed.data;
    const restockToStock = restock !== false;

    const result = await prisma.$transaction(async (tx: TxClient) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: true },
      });
      if (!order) {
        throw new Error("Order not found");
      }
      if (!order.userId) {
        throw new Error("Order has no customer");
      }
      if (order.status === "CANCELLED") {
        throw new Error("Cannot return items on a cancelled order");
      }
      const delivery = (order.deliveryStatus || "NOT_DELIVERED").toUpperCase();
      if (
        delivery !== "DELIVERED" &&
        delivery !== "PARTIALLY_DELIVERED" &&
        delivery !== "RETURNED"
      ) {
        throw new Error("Items can only be returned from delivered orders");
      }

      const item = order.items.find((it) => it.id === itemId);
      if (!item) {
        throw new Error("Order item not found");
      }

      const alreadyReturned = Number(item.returnedQuantity ?? 0);
      const deliveredQuantity = Number(
        (item as { deliveredQuantity?: unknown }).deliveredQuantity ?? 0,
      );
      const maxReturnable = Math.max(0, deliveredQuantity - alreadyReturned);
      if (maxReturnable <= 0) {
        throw new Error(
          "No delivered units are available to return for this item",
        );
      }
      if (quantity > maxReturnable) {
        throw new Error(
          `Cannot return more than ${maxReturnable} unit(s) for this item`,
        );
      }

      const unitPrice = Number(item.price);
      const requestedRefund = unitPrice * quantity;
      if (!Number.isFinite(requestedRefund) || requestedRefund <= 0) {
        throw new Error("Invalid refund amount");
      }

      const currentPaid = Number(order.amountPaid ?? 0);
      const EPSILON = 0.005;
      // We only refund the portion that exceeds outstanding balance. Ensure
      // we never refund more than has actually been paid on this order.
      if (currentPaid + EPSILON < requestedRefund) {
        throw new Error(
          "Cannot refund more than the amount paid on this order so far",
        );
      }

      const beforeOrders = await tx.order.findMany({
        where: { userId: order.userId, NOT: { status: "CANCELLED" } },
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

      const refundDispositionValue =
        refundMode === "credit"
          ? RefundDestination.CREDIT
          : RefundDestination.CASH;
      const meta = {
        note: `Item return for order ${orderId}`,
        method: refundMode === "cash" ? "cash" : "adjustment",
        reference: "ITEM_RETURN",
        receivedBy: user?.name || user?.email || "staff",
        location: "admin/orders",
        status: "refund",
        refundDisposition: refundMode,
        preTotals: {
          totalDue: totalDueBefore,
          totalPaid: totalPaidBefore,
          balance: balanceBefore,
        },
        item: {
          id: item.id,
          productId: item.productId,
          quantity,
          unitPrice,
          lineRefund: requestedRefund,
        },
      };

      // Apply the return value to outstanding balance first by reducing the
      // order's total, then treat any remainder as a refund (cash/credit).
      const orderTotal = Number(order.total ?? 0);
      const outstandingBefore = Math.max(0, orderTotal - currentPaid);
      const reduceTotalBy = Math.min(requestedRefund, outstandingBefore);
      const refundableRemainder = Math.max(0, requestedRefund - reduceTotalBy);

      const newTotal = orderTotal - reduceTotalBy;
      const newAmountPaid = currentPaid;
      const newBalance = Math.max(0, newTotal - newAmountPaid);
      const newStatus =
        newBalance <= 0
          ? "PAID"
          : newAmountPaid > 0
          ? "PARTIALLY_PAID"
          : "UNPAID";

      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: {
          total: newTotal,
          amountPaid: newAmountPaid,
          balance: newBalance,
          status: newStatus,
        },
      });

      await tx.orderItem.update({
        where: { id: item.id },
        data: {
          returnedQuantity: alreadyReturned + quantity,
        },
      });

      if (restockToStock) {
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { increment: quantity } },
        });
        await tx.inventoryMovement.create({
          data: {
            productId: item.productId,
            delta: quantity,
            reason: "RETURN_PARTIAL",
          },
        });
      }

      const afterOrders = await tx.order.findMany({
        where: { userId: order.userId, NOT: { status: "CANCELLED" } },
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

      const metaWithPostTotals = {
        ...meta,
        appliedToBalance: reduceTotalBy,
        restockToStock,
        postTotals: {
          totalDue: totalDueAfter,
          totalPaid: totalPaidAfter,
          balance: balanceAfter,
        },
      };

      let creditEntry: unknown = null;
      let primaryPayment: unknown = null;
      let actualRefund = 0;
      if (refundableRemainder > 0) {
        if (refundMode === "credit") {
          // Refund held as store credit — increase paymentsTotal so that
          // (paymentsTotal - totalPaid) reflects new credit.
          primaryPayment = await tx.payment.create({
            data: {
              userId: order.userId,
              amount: refundableRemainder,
              note: JSON.stringify({
                ...metaWithPostTotals,
                reason: "Refund held as store credit (item return)",
              }),
              status: PaymentStatus.NORMAL,
              refundDisposition: RefundDestination.CREDIT,
            },
          });
          creditEntry = primaryPayment;
          actualRefund = refundableRemainder;
        } else {
          // Cash/transfer refund for the remainder — negative payment with
          // REFUND status so it does not contribute to store credit.
          primaryPayment = await tx.payment.create({
            data: {
              userId: order.userId,
              orderId: order.id,
              amount: -refundableRemainder,
              note: JSON.stringify({
                ...metaWithPostTotals,
                reason: "Cash/transfer refund for returned item(s)",
              }),
              status: PaymentStatus.REFUND,
              refundDisposition: refundDispositionValue,
            },
          });
          actualRefund = refundableRemainder;
        }
      }

      return {
        order: updatedOrder,
        payment: primaryPayment,
        credit: creditEntry,
        refund: actualRefund,
        appliedToBalance: reduceTotalBy,
      };
    });

    try {
      if (result.refund > 0) {
        if (parsed.data.refundMode === "credit") {
          await notifyPaymentEvent({
            kind: "store_credit_issued",
            userId: result.order.userId!,
            amount: result.refund,
          });
        } else {
          await notifyPaymentEvent({
            kind: "payment_refunded",
            userId: result.order.userId!,
            amount: result.refund,
            method: "cash",
          });
        }
      }
    } catch (e) {
      console.warn("notifyPaymentEvent (item return) error:", e);
    }

    try {
      await recordAuditLog({
        actorId: user?.id,
        action: "ORDER_ITEM_RETURN",
        entityType: "ORDER",
        entityId: result.order.id,
        meta: {
          itemId: parsed.data.itemId,
          quantity: parsed.data.quantity,
          refundMode: parsed.data.refundMode,
          refundAmount: result.refund,
          appliedToBalance: result.appliedToBalance,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({
      success: true,
      refund: result.refund,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to process item return";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
