import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { initiateMomo } from "@/lib/momo";
import { rateLimit } from "@/lib/rate-limit";

const schema = z.object({
  orderId: z.string().cuid(),
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
    const { orderId, phone, provider } = parsed.data;
    const amountOverride = parsed.data.amount;

    const order = await prisma.order.findFirst({ where: { id: orderId, userId, status: { not: "CANCELLED" } } });
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

    const total = Number(order.total || 0);
    const paid = Number(order.amountPaid || 0);
    const balance = Math.max(0, total - paid);
    if (balance <= 0) return NextResponse.json({ error: "Order already paid" }, { status: 400 });

    const amount = Math.max(0.01, Math.min(balance, Number(amountOverride || balance)));

    // Create a pending payment record with metadata
    const meta = {
      method: "momo",
      provider,
      status: "pending",
      phone,
      orderId,
    };

    const payment = await prisma.payment.create({
      data: {
        userId,
        orderId,
        amount,
        note: JSON.stringify(meta),
      },
    });

    const init = await initiateMomo({
      provider,
      amount,
      phone,
      externalId: payment.id,
      description: `Order ${order.id}`,
    });

    if (!init.ok) {
      // Cleanup the pending record to avoid confusion
      try { await prisma.payment.delete({ where: { id: payment.id } }); } catch {}
      return NextResponse.json({ error: init.error }, { status: 502 });
    }

    // If running in local/sandbox without provider keys, our momo lib returns
    // a TEST- reference. In that case, apply the payment immediately so the
    // customer flow works without polling.
    const isTestRef = String(init.reference || "").startsWith("TEST-");
    if (isTestRef) {
      await prisma.$transaction(async (tx) => {
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
        }
        const withRef = { ...meta, providerRef: init.reference, status: "success", applied };
        await tx.payment.update({ where: { id: payment.id }, data: { note: JSON.stringify(withRef) } });
      });
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

    return NextResponse.json({ ok: true, paymentId: payment.id, reference: init.reference });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to initiate MoMo";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
