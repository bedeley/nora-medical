import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

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

    const meta: {
      method: string;
      reference?: string;
      note?: string;
      status: string;
      location: string;
      creditBefore: number;
    } = {
      method,
      reference,
      note,
      status: "refund",
      location: "admin/customers:credit-payout",
      creditBefore: creditAvailable,
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

    return NextResponse.json({ paymentId: payment.id, creditRemaining: creditAvailable - amount });
  } catch (error) {
    console.error("Refund credit error", error);
    return NextResponse.json({ error: "Failed to record refund" }, { status: 500 });
  }
}
