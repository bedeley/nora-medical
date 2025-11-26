import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { initiateMomo, isValidPhone, normalizePhoneGH } from "@/lib/momo";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => any ? A : never;

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
    const total = cart.items.reduce((s, it) => s + Number(it.product.price) * it.quantity, 0);
    if (!(total > 0)) return NextResponse.json({ error: "Invalid total" }, { status: 400 });

    // Create order, items, update stock, clear cart
    const order = await prisma.$transaction(async (tx: TxClient) => {
      const o = await tx.order.create({
        data: { userId, total, amountPaid: 0, balance: total, status: "UNPAID" },
      });
      await tx.orderItem.createMany({
        data: cart.items.map((ci) => ({
          orderId: o.id,
          productId: ci.productId,
          price: Number(ci.product.price),
          costAtSale: Number(ci.product.cost ?? 0),
          quantity: ci.quantity,
        })),
      });
      for (const ci of cart.items) {
        await tx.product.update({ where: { id: ci.productId }, data: { stock: { decrement: ci.quantity } } });
        await tx.inventoryMovement.create({ data: { productId: ci.productId, delta: -ci.quantity, reason: "SALE" } });
      }
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      return o;
    });

    // Create pending payment (supports partial)
    const amountOverride = parsed.data.amount;
    const chargeAmount = Math.max(
      0.01,
      Math.min(total, Number(amountOverride ?? total)),
    );
    const meta = {
      method: "momo" as const,
      provider,
      status: "pending" as const,
      phone,
      orderId: order.id,
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
      try { await prisma.payment.delete({ where: { id: payment.id } }); } catch {}
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
