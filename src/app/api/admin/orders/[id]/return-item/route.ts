import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { PaymentStatus, RefundDestination } from "@/lib/prisma-enums";
import { notifyPaymentEvent } from "@/lib/notifications";
import { recordAuditLog } from "@/lib/audit-log";
import { postPaymentEntry, postReturnEntry } from "@/lib/accounting-posting";
import { recomputeOrderTotalsFromPayments } from "@/lib/payments";
import { hasPermission } from "@/lib/permissions";
import { z } from "zod";
import { randomUUID } from "crypto";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

const returnSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().positive(),
  refundMode: z.enum(["cash", "credit"]),
  // Whether returned units should be added back into stock.
  restock: z.boolean().optional(),
  disposition: z.enum(["RESTOCK", "SCRAP", "RETURN_TO_SUPPLIER"]).optional(),
  reason: z
    .enum([
      "DAMAGED",
      "EXPIRED",
      "WRONG_ITEM",
      "QUALITY_ISSUE",
      "CUSTOMER_CHANGED_MIND",
      "OTHER",
    ])
    .optional(),
  reasonNote: z.string().max(200).optional(),
  skipAutoApplyCredit: z.boolean().optional(),
});

async function autoApplyStoreCreditOldestFirst(
  tx: TxClient,
  userId: string,
  opts: { receivedBy: string; location: string },
) {
  const orders = await tx.order.findMany({
    where: { userId, NOT: { status: "CANCELLED" } },
    select: { id: true, total: true, amountPaid: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const payments = await tx.payment.findMany({
    where: { userId },
    select: { amount: true, status: true, refundDisposition: true, note: true },
  });

  const totalDue = orders.reduce((s, o) => s + Number(o.total || 0), 0);
  const totalPaid = orders.reduce((s, o) => s + Number(o.amountPaid || 0), 0);
  const balance = Math.max(0, totalDue - totalPaid);

  let credit = 0;
  for (const p of payments) {
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

    if (isCreditIssued) credit += amount;
    else if (isAutoApply) credit -= amount;
    else if (isCreditCashPayout) credit += amount;
  }
  credit = Math.max(0, credit);

  if (balance <= 0.005 || credit <= 0.005) {
    return { paymentIds: [], appliedTotal: 0 };
  }

  const amountToApply = Math.min(balance, credit);
  let remainingPayment = amountToApply;
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
          note: "Auto-applied store credit after return",
          method: "adjustment",
          reference: "AUTO_APPLY",
          receivedBy: opts.receivedBy,
          location: opts.location,
          status: "normal",
          batchId,
          applied: [{ orderId: o.id, applied: applyAmt }],
        }),
        status: PaymentStatus.NORMAL,
        refundDisposition: null,
      },
    });
    createdPayments.push({ id: payment.id, orderId: o.id, applied: applyAmt });
    await recomputeOrderTotalsFromPayments(tx, o.id);
    remainingPayment -= applyAmt;
  }

  if (createdPayments.length > 0) {
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

    for (const row of createdPayments) {
      await tx.payment.update({
        where: { id: row.id },
        data: {
          note: JSON.stringify({
            note: "Auto-applied store credit after return",
            method: "adjustment",
            reference: "AUTO_APPLY",
            receivedBy: opts.receivedBy,
            location: opts.location,
            status: "normal",
            batchId,
            batchAppliedTotal: amountToApply,
            batchAppliedCount: createdPayments.length,
            applied: [{ orderId: row.orderId, applied: row.applied }],
            postTotals: {
              totalDue: totalDueAfter,
              totalPaid: totalPaidAfter,
              balance: balanceAfter,
            },
          }),
        },
      });
    }
  }

  return {
    paymentIds: createdPayments.map((p) => p.id),
    appliedTotal: amountToApply - Math.max(0, remainingPayment),
  };
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const canReturn = hasPermission(role, "orders.return");
  if (!session || !canReturn) {
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

    const {
      itemId,
      quantity,
      refundMode,
      restock,
      disposition,
      reason,
      reasonNote,
      skipAutoApplyCredit,
    } = parsed.data;
    const resolvedDisposition = disposition || (restock === false ? "SCRAP" : "RESTOCK");
    const restockToStock = resolvedDisposition === "RESTOCK";

    const result = await prisma.$transaction(async (tx: TxClient) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          items: {
            include: { product: { select: { name: true, cost: true } } },
          },
        },
      });
      if (!order) {
        throw new Error("Order not found");
      }
      if (!order.userId && order.customerType !== "WALK_IN") {
        throw new Error("Order has no customer");
      }
      if (order.customerType === "WALK_IN" && refundMode !== "cash") {
        throw new Error("OTC returns must be refunded as cash/transfer.");
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
      const itemName = item.product?.name || "Item";

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
      // Align inventory ledger with valuation: use current product cost.
      const unitCost = Number(item.product?.cost ?? 0);

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
        disposition: resolvedDisposition,
        reason,
        reasonNote: reasonNote?.trim() || undefined,
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

      // First, ensure the order totals/balance reflect all payments to avoid
      // applying returns to a stale outstanding balance.
      const refreshed = await recomputeOrderTotalsFromPayments(tx, order.id);
      const paidAfterRecalc = Number(refreshed.amountPaid ?? 0);

      // Apply the return value to outstanding balance first by reducing the
      // order's total, then treat any remainder as a refund (cash/credit).
      // Because requestedRefund can never exceed the order's total for this
      // line, the refundable remainder is always <= currentPaid.
      const orderTotal = Number(order.total ?? 0);
      const orderSubtotal = Number((order as { subtotal?: unknown }).subtotal ?? 0);
      const orderTaxRate = Number((order as { taxRate?: unknown }).taxRate ?? 0);
      const orderTaxAmount = Number((order as { taxAmount?: unknown }).taxAmount ?? 0);
      // Use the stored balance as the authoritative outstanding amount so
      // rounding/previous adjustments match what the UI shows.
      const storedBalance = Number(refreshed.balance ?? Math.max(0, orderTotal - paidAfterRecalc));
      const outstandingBefore = Math.max(0, storedBalance);
      const reduceTotalBy = Math.min(requestedRefund, outstandingBefore);
      const refundableRemainder = Math.max(0, requestedRefund - reduceTotalBy);

      const newSubtotal = Math.max(0, orderSubtotal - requestedRefund);
      const newTaxAmount =
        orderTaxRate > 0
          ? (newSubtotal * orderTaxRate) / 100
          : orderSubtotal > 0
          ? (orderTaxAmount * newSubtotal) / orderSubtotal
          : 0;
      const newTotal = newSubtotal + newTaxAmount;
      const newAmountPaid =
        refundMode === "cash"
          ? Math.max(0, paidAfterRecalc - refundableRemainder)
          : paidAfterRecalc;
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
          subtotal: newSubtotal,
          taxAmount: newTaxAmount,
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
            note: [
              "RMA",
              resolvedDisposition,
              reason,
              reasonNote?.trim(),
            ]
              .filter(Boolean)
              .join(" · "),
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
        orderId,
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
      let autoApplyPaymentIds: string[] = [];
      let autoAppliedAmount = 0;
      if (reduceTotalBy > 0) {
        await tx.payment.create({
          data: {
            userId: order.userId,
            orderId: order.id,
            amount: 0,
            note: JSON.stringify({
              ...metaWithPostTotals,
              balanceAdjustment: true,
              adjustmentAmount: reduceTotalBy,
              reason: "Return applied to outstanding balance",
            }),
            status: PaymentStatus.NORMAL,
            refundDisposition: refundDispositionValue,
          },
        });
      }
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
          if (order.userId && !skipAutoApplyCredit) {
            const autoApply = await autoApplyStoreCreditOldestFirst(tx, order.userId, {
              receivedBy: user?.name || user?.email || "staff",
              location: "admin/orders:return-item:auto-apply",
            });
            autoApplyPaymentIds = autoApply.paymentIds;
            autoAppliedAmount = autoApply.appliedTotal;
          }
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
      const paymentId =
        primaryPayment && typeof primaryPayment === "object" && "id" in primaryPayment
          ? (primaryPayment as { id?: string }).id ?? null
          : null;

      return {
        order: updatedOrder,
        payment: primaryPayment,
        paymentId,
        credit: creditEntry,
        refund: actualRefund,
        refundTotal: requestedRefund,
        appliedToBalance: reduceTotalBy,
        itemName,
        quantity,
        restockToStock,
        refundMode,
        cogsAmount: restockToStock ? unitCost * quantity : 0,
        autoApplyPaymentIds,
        autoAppliedAmount,
      };
    });
    for (const paymentId of result.autoApplyPaymentIds) {
      try {
        await postPaymentEntry({ paymentId });
      } catch (e) {
        console.warn("postPaymentEntry (auto-apply after return) error:", e);
      }
    }

    try {
      if (result.refundTotal > 0) {
        await postReturnEntry({
          sourceType: "ORDER",
          sourceId: result.order.id,
          entryDate: new Date(),
          orderId: result.order.id,
          itemLabel: result.itemName,
          refundAmount: result.refundTotal,
          appliedToBalance: result.appliedToBalance,
          refundMode: result.refundMode,
          restock: result.restockToStock,
          cogsAmount: result.cogsAmount,
        });
      }
    } catch (e) {
      console.warn("postReturnEntry error:", e);
      try {
        await recordAuditLog({
          actorId: user?.id,
          action: "RETURN_POSTING_FAILED",
          entityType: "ORDER",
          entityId: result.order.id,
          meta: {
            itemId: parsed.data.itemId,
            quantity: parsed.data.quantity,
            refundMode: parsed.data.refundMode,
            refundTotal: result.refundTotal,
            appliedToBalance: result.appliedToBalance,
            error: String(e),
          },
        });
      } catch {
        // best-effort
      }
    }

    try {
      if (result.refund > 0 && result.order.userId) {
        if (parsed.data.refundMode === "credit") {
          await notifyPaymentEvent({
            kind: "store_credit_issued",
            userId: result.order.userId,
            amount: result.refund,
            orderId: result.order.id,
            itemName: result.itemName,
            quantity: result.quantity,
          });
        } else {
          await notifyPaymentEvent({
            kind: "payment_refunded",
            userId: result.order.userId,
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
          disposition: resolvedDisposition,
          reason,
          reasonNote: reasonNote?.trim() || undefined,
          refundAmount: result.refund,
          appliedToBalance: result.appliedToBalance,
          autoAppliedAmount: result.autoAppliedAmount,
          skipAutoApplyCredit: Boolean(skipAutoApplyCredit),
        },
      });
      } catch {
        // best-effort
      }

      return NextResponse.json({
        success: true,
        refund: result.refund,
        autoAppliedAmount: result.autoAppliedAmount,
      });
    } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to process item return";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
