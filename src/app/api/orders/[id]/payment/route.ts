import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const paymentSchema = z.object({
  amount: z.number().positive("Amount must be greater than 0"),
  note: z.string().max(200).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN")
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const body = await req.json();
    const parsed = paymentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payment payload" },
        { status: 400 }
      );
    }

    const { amount, note } = parsed.data;

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: params.id } });
      if (!order) throw new Error("Order not found");
      if (order.status === "CANCELLED") throw new Error("Cannot record payment for cancelled order");

      // Create a payment record linked to the order and user
      await tx.payment.create({
        data: {
          userId: order.userId,
          orderId: order.id,
          amount,
          note: note || "Admin recorded payment",
        },
      });

      const newAmountPaid = Number(order.amountPaid) + amount;
      const newBalance = Math.max(0, Number(order.total) - newAmountPaid);

      const updated = await tx.order.update({
        where: { id: params.id },
        data: {
          amountPaid: newAmountPaid,
          balance: newBalance,
          status: newBalance <= 0 ? "PAID" : "PARTIALLY_PAID",
        },
      });

      return updated;
    });

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
