import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { notifyPaymentEvent } from "@/lib/notifications";
import { recomputeOrderTotalsFromPayments } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";
import { postPaymentEntry } from "@/lib/accounting-posting";
import { recordAuditLog } from "@/lib/audit-log";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

const paymentSchema = z.object({
  amount: z.number().positive("Amount must be greater than 0"),
  method: z.enum(["cash", "momo", "transfer", "card"]).default("cash"),
  note: z.string().max(500).optional(),
});

const PAYMENT_METHOD_LABELS: Record<"cash" | "momo" | "transfer" | "card", string> = {
  cash: "Cash",
  momo: "MoMo",
  transfer: "Bank Transfer",
  card: "Card",
};

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-order-payment", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = session.user as AuthenticatedUser;
  const role = user.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!isAdmin && !isStaff && !isAccountant)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const params = await context.params;
    const orderId = params.id;
    const body = await req.json();
    const parsed = paymentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payment payload" },
        { status: 400 }
      );
    }

    const { amount, method, note } = parsed.data;
    const externalReference =
      (method === "momo" || method === "transfer" || method === "card") && note?.trim()
        ? note.trim()
        : null;
    const idempotencyKey = req.headers.get("idempotency-key") || null;
    const requestId =
      req.headers.get("x-request-id") ||
      req.headers.get("x-correlation-id") ||
      null;

    const result = await prisma.$transaction(async (tx: TxClient) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new Error("Order not found");
      if (order.status === "CANCELLED") throw new Error("Cannot record payment for cancelled order");

      if (idempotencyKey) {
        const existingPayment = await tx.payment.findFirst({
          where: {
            orderId: order.id,
            deletedAt: null,
            note: { contains: `"idempotencyKey":"${idempotencyKey}"` },
          },
          orderBy: { createdAt: "desc" },
        });
        if (existingPayment) {
          const updated = await recomputeOrderTotalsFromPayments(tx, orderId);
          return {
            order: updated,
            paymentId: existingPayment.id,
            previousBalance: Number(order.balance || 0),
            previousOrderStatus: String(order.status || ""),
            deduped: true,
          };
        }
      }

      // Create a payment record linked to the order and user.
      // Store structured metadata so customer/admin views can summarize by method.
      const meta = {
        method,
        reference: "ADMIN_ORDER_PAYMENT" as const,
        location: "admin/orders",
        note: note || "Admin recorded payment",
        externalReference,
        idempotencyKey,
        requestId,
      };

      const payment = await tx.payment.create({
        data: {
          userId: order.userId,
          orderId: order.id,
          amount,
          note: JSON.stringify(meta),
        },
      });

      const updated = await recomputeOrderTotalsFromPayments(tx, orderId);
      return {
        order: updated,
        paymentId: payment.id,
        previousBalance: Number(order.balance || 0),
        previousOrderStatus: String(order.status || ""),
        deduped: false,
      };
    });

    if (!result.deduped) {
      try {
      if (result.order.userId) {
        await notifyPaymentEvent({
          kind: "payment_recorded",
          userId: result.order.userId,
          amount,
          orderId,
          subject: "Payment received — updated receipt",
        });
      }
      } catch (e) {
        console.warn("notifyPaymentEvent (admin order payment) error:", e);
      }
    }

    let postingResultId: string | null = null;
    if (!result.deduped) {
      try {
        const postingResult = await postPaymentEntry({ paymentId: result.paymentId });
        postingResultId = postingResult?.id || null;
      } catch (e) {
        console.warn("Accounting payment posting skipped:", e);
      }
    }
    if (!postingResultId) {
      const posted = await prisma.journalEntry.findFirst({
        where: {
          sourceType: "PAYMENT",
          status: "POSTED",
          OR: [
            { sourceId: result.paymentId },
            { sourceId: { startsWith: `${result.paymentId}:` } },
          ],
        },
        select: { id: true },
        orderBy: { createdAt: "desc" },
      });
      postingResultId = posted?.id || null;
    }

    const paymentCustomer = result.order.userId
      ? await prisma.user.findUnique({
          where: { id: result.order.userId },
          select: { name: true, email: true, phone: true },
        })
      : null;

    if (!result.deduped) {
      try {
        await recordAuditLog({
          actorId: user.id,
          action: "PAYMENT_CREATE",
          entityType: "PAYMENT",
          entityId: result.paymentId,
          meta: {
            actorType: "ADMIN",
            channel: "admin_orders",
            sourceRoute: `/api/orders/${orderId}/payment`,
            paymentId: result.paymentId,
            orderId,
            customerId: result.order.userId || null,
            customerName: paymentCustomer?.name || null,
            customerEmail: paymentCustomer?.email || null,
            customerPhone: paymentCustomer?.phone || null,
            recordedByName: user.name || user.email || null,
            recordedByRole: user.role || null,
            amount,
            method,
            paymentMethodLabel: PAYMENT_METHOD_LABELS[method],
            captureType: "ADMIN_MANUAL",
            externalReference,
            status: "NORMAL",
            invoiceNumber: result.order.invoiceNumber || null,
            remainingBalanceAfter: Number(result.order.balance || 0),
            orderStatusBefore: result.previousOrderStatus || null,
            orderStatusAfter: String(result.order.status || ""),
            reference: "ADMIN_ORDER_PAYMENT",
            paymentCount: 1,
            appliedCount: 1,
            appliedTotal: Number(amount || 0),
            orderCount: 1,
            orderIds: [orderId],
            appliedAllocations: [
              {
                orderId,
                amount: Number(amount || 0),
                remainingAfter: Number(result.order.balance || 0),
              },
            ],
            amountMode:
              Math.abs(Number(result.previousBalance || 0) - Number(amount || 0)) <= 0.0001
                ? "full"
                : "custom",
            operatorNotePresent: Boolean(note && note.trim()),
            postingStatus: postingResultId ? "POSTED" : "PENDING",
            journalEntryId: postingResultId,
            idempotencyKey,
            requestId,
            note: note || null,
          },
        });
      } catch {
        // best-effort
      }
    }

    return NextResponse.json({
      success: true,
      message: result.deduped ? "Payment already recorded." : "Payment recorded successfully.",
      order: result.order,
      duplicate: result.deduped,
    });
  } catch (error: unknown) {
    console.error("Error updating payment:", error);
    const message =
      error instanceof Error ? error.message : "Failed to record payment";
    const status = message.includes("cancelled")
      ? 400
      : message.includes("not found")
      ? 404
      : 500;
    return NextResponse.json(
      { error: message },
      { status }
    );
  }
}
