import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { notifyPaymentEvent } from "@/lib/notifications";
import { recomputeOrderTotalsFromPayments } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

const paymentSchema = z.object({
  amount: z.number().positive("Amount must be greater than 0"),
  note: z.string().max(200).optional(),
});

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

    const { amount, note } = parsed.data;

    const result = await prisma.$transaction(async (tx: TxClient) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new Error("Order not found");
      if (order.status === "CANCELLED") throw new Error("Cannot record payment for cancelled order");

      // Create a payment record linked to the order and user.
      // Store structured metadata so customer/admin views can summarize by method.
      const meta = {
        method: "cash" as const,
        reference: "ADMIN_ORDER_PAYMENT" as const,
        location: "admin/orders",
        note: note || "Admin recorded payment",
      };

      await tx.payment.create({
        data: {
          userId: order.userId,
          orderId: order.id,
          amount,
          note: JSON.stringify(meta),
        },
      });

      const updated = await recomputeOrderTotalsFromPayments(tx, orderId);
      return updated;
    });

    try {
      if (result.userId) {
        await notifyPaymentEvent({
          kind: "payment_recorded",
          userId: result.userId,
          amount,
          orderId,
          subject: "Payment received — updated receipt",
        });
      }
    } catch (e) {
      console.warn("notifyPaymentEvent (admin order payment) error:", e);
    }

    return NextResponse.json({
      success: true,
      message: "Payment recorded successfully.",
      order: result,
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
