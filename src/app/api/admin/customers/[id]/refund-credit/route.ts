import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { initiateMomoPayout } from "@/lib/momo";
import { notifyPaymentEvent } from "@/lib/notifications";

const refundSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(["cash", "transfer"]),
  reference: z.string().optional(),
  note: z.string().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = params.id;
  if (!userId) {
    return NextResponse.json({ error: "Missing customer id" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = refundSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid refund payload" }, { status: 400 });
  }

  const { amount, method, reference, note } = parsed.data;

  try {
    const [orders, payments] = await Promise.all([
      prisma.order.findMany({
        where: { userId, status: { not: "CANCELLED" } },
        select: { total: true, amountPaid: true },
      }),
      prisma.payment.findMany({
        where: { userId },
        select: { amount: true },
      }),
    ]);

    const totalPaid = orders.reduce(
      (sum: number, o: { amountPaid: unknown }) => sum + Number(o.amountPaid || 0),
      0
    );
    const paymentsTotal = payments.reduce(
      (sum: number, p: { amount: unknown }) => sum + Number(p.amount || 0),
      0
    );
    const creditAvailable = Math.max(0, paymentsTotal - totalPaid);

    if (amount > creditAvailable + 0.0001) {
      return NextResponse.json(
        {
          error: `Cannot refund more than the customer's unapplied funds (${creditAvailable.toFixed(2)})`,
        },
        { status: 400 }
      );
    }

    const isMomoTransfer = method === "transfer";
    const momoPayoutEnabled = process.env.MOMO_PAYOUTS_ENABLED === "1";

    // If MoMo payouts are enabled in config and the admin selected the
    // MoMo transfer option, attempt to trigger a payout to the customer's
    // saved phone number. This is fully gated by the env flag so it is
    // effectively "off" until an integration is configured.
    if (isMomoTransfer && momoPayoutEnabled) {
      const userRecord = await prisma.user.findUnique({
        where: { id: userId },
        select: { phone: true },
      });
      const phone = (userRecord?.phone || "").trim();
      if (!phone) {
        return NextResponse.json(
          { error: "Customer has no phone number on file for MoMo refund." },
          { status: 400 },
        );
      }

      const payout = await initiateMomoPayout({
        provider: "mtn",
        amount,
        phone,
        externalId: `refund-${userId}-${Date.now()}`,
        description: note || "Store credit refund",
      });
      if (!payout.ok) {
        return NextResponse.json(
          { error: payout.error || "Failed to initiate MoMo payout" },
          { status: 502 },
        );
      }
    }

    const meta: {
      method: string;
      reference?: string;
      note?: string;
      status: string;
      location: string;
      creditBefore: number;
      channel?: "cash" | "momo_transfer";
      momoPayoutEnabled?: boolean;
    } = {
      method,
      reference,
      note,
      status: "refund",
      location: "admin/customers:credit-payout",
      creditBefore: creditAvailable,
      channel: isMomoTransfer ? "momo_transfer" : "cash",
      momoPayoutEnabled,
    };

    const payment = await prisma.payment.create({
      data: {
        userId,
        amount: -amount,
        note: JSON.stringify(meta),
        status: "REFUND",
        refundDisposition: "CASH",
      },
    });

    try {
      await notifyPaymentEvent({
        kind: "store_credit_refunded",
        userId,
        amount,
        method,
      });
    } catch (e) {
      console.warn("notifyPaymentEvent (credit refund) error:", e);
    }

    return NextResponse.json({ paymentId: payment.id, creditRemaining: creditAvailable - amount });
  } catch (error) {
    console.error("Refund credit error", error);
    return NextResponse.json({ error: "Failed to record refund" }, { status: 500 });
  }
}
