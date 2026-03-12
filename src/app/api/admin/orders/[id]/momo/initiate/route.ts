import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { initiateMomo } from "@/lib/momo";
import { rateLimit } from "@/lib/rate-limit";
import { isLiveStage } from "@/lib/env";
import { postPaymentEntry } from "@/lib/accounting-posting";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

const schema = z.object({
  phone: z.string().min(7),
  provider: z.enum(["mtn", "vodafone", "airteltigo"]).default("mtn"),
  amount: z.coerce.number().positive().optional(),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-momo-initiate", 60_000, 20);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const params = await context.params;
    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const { phone, provider } = parsed.data;
    const amountOverride = parsed.data.amount;
    const orderId = params.id;

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    if (order.status === "CANCELLED") {
      return NextResponse.json({ error: "Cannot initiate MoMo for cancelled order" }, { status: 400 });
    }

    const total = Number(order.total || 0);
    const paid = Number(order.amountPaid || 0);
    const balance = Math.max(0, total - paid);
    if (balance <= 0) return NextResponse.json({ error: "Order already paid" }, { status: 400 });

    const amount = Math.max(0.01, Math.min(balance, Number(amountOverride || balance)));
    const forcePendingForTest = process.env.MOMO_FORCE_PENDING_FOR_TEST === "1";

    const meta = {
      method: "momo",
      provider,
      status: "pending",
      phone,
      orderId,
      purpose: "admin_otc_collect",
      forcePendingForTest,
    };

    const payment = await prisma.payment.create({
      data: {
        userId: order.userId,
        orderId: order.id,
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
      try {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { deletedAt: new Date() },
        });
      } catch {
        // best effort
      }
      return NextResponse.json({ error: init.error }, { status: 502 });
    }

    const isTestRef = String(init.reference || "").startsWith("TEST-");
    const sandboxAutoApplyEnabled = process.env.MOMO_SANDBOX_AUTO_APPLY !== "0";
    if (isTestRef && !isLiveStage() && sandboxAutoApplyEnabled) {
      await prisma.$transaction(async (tx: TxClient) => {
        const o = await tx.order.findUnique({ where: { id: orderId } });
        if (!o) throw new Error("Order not found");
        if (o.status === "CANCELLED") throw new Error("Cannot apply to cancelled order");
        const currentPaid = Number(o.amountPaid || 0);
        const totalAmount = Number(o.total || 0);
        const remaining = Math.max(0, totalAmount - currentPaid);
        const applyAmt = Math.min(amount, remaining);
        const newAmountPaid = Math.max(0, currentPaid + applyAmt);
        const newBalance = Math.max(0, totalAmount - newAmountPaid);
        const newStatus = newBalance <= 0 ? "PAID" : newAmountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";

        await tx.order.update({
          where: { id: o.id },
          data: {
            amountPaid: newAmountPaid,
            balance: newBalance,
            status: newStatus,
          },
        });

        const withRef = {
          ...meta,
          providerRef: init.reference,
          status: "success" as const,
          applied: [
            {
              orderId: o.id,
              applied: applyAmt,
              newAmountPaid,
              newBalance,
              newStatus,
            },
          ],
        };
        await tx.payment.update({
          where: { id: payment.id },
          data: { note: JSON.stringify(withRef) },
        });
      });
      try {
        await postPaymentEntry({ paymentId: payment.id });
      } catch (e) {
        console.warn("admin momo initiate (simulated) payment posting skipped:", e);
      }
      return NextResponse.json({
        ok: true,
        paymentId: payment.id,
        reference: init.reference,
        applied: true,
        simulated: true,
      });
    }

    try {
      const withRef = { ...meta, providerRef: init.reference };
      await prisma.payment.update({ where: { id: payment.id }, data: { note: JSON.stringify(withRef) } });
      try {
        await postPaymentEntry({ paymentId: payment.id });
      } catch (e) {
        console.warn("Accounting pending MoMo posting skipped:", e);
      }
    } catch {
      // best effort
    }

    if (isTestRef && isLiveStage()) {
      return NextResponse.json({ error: "MoMo test reference not allowed in production" }, { status: 502 });
    }

    return NextResponse.json({ ok: true, paymentId: payment.id, reference: init.reference });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to initiate MoMo";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
