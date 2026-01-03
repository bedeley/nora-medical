import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { initiateMomoPayout } from "@/lib/momo";
import { notifyPaymentEvent } from "@/lib/notifications";
import { recordAuditLog } from "@/lib/audit-log";
import { isFeatureEnabled } from "@/lib/features";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";

const refundSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(["cash", "transfer"]),
  reference: z.string().optional(),
  note: z.string().min(5, "Please provide a brief reason.").optional(),
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as AuthenticatedUser;
  const role = user.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!isAdmin && !isAccountant) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-refund-credit", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => null) as { userId?: string } | null;
  const userId = String(params.id || body?.userId || "").trim();
  if (!userId) {
    return NextResponse.json({ error: "Missing customer id" }, { status: 400 });
  }

  const parsed = refundSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid refund payload" }, { status: 400 });
  }

  const { amount, method, reference, note } = parsed.data;

  try {
    const payments = await prisma.payment.findMany({
      where: { userId },
      select: { amount: true, status: true, refundDisposition: true, note: true },
    });
    const customer = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });

    // Compute store credit using the same semantics as /api/balance:
    // credit from returns/adjustments, minus AUTO_APPLY applications and
    // prior cash payouts of store credit.
    let creditAvailable = 0;
    for (const p of payments) {
      const amount = Number(p.amount || 0);
      const note = p.note || "";
      const isAutoApply = note.includes("\"reference\":\"AUTO_APPLY\"");
      const isCreditIssued =
        p.status === "NORMAL" &&
        p.refundDisposition === "CREDIT" &&
        amount > 0;
      const isCreditCashPayout =
        p.status === "REFUND" &&
        p.refundDisposition === "CASH" &&
        note.includes("\"location\":\"admin/customers:credit-payout\"");

      if (isCreditIssued) {
        creditAvailable += amount;
      } else if (isAutoApply) {
        creditAvailable -= amount;
      } else if (isCreditCashPayout) {
        creditAvailable += amount;
      }
    }
    creditAvailable = Math.max(0, creditAvailable);

    if (amount > creditAvailable + 0.0001) {
      return NextResponse.json(
        {
          error: `Cannot refund more than the customer's unapplied funds (${creditAvailable.toFixed(2)})`,
        },
        { status: 400 }
      );
    }

    const isMomoTransfer = method === "transfer";
    const momoPayoutEnvEnabled = process.env.MOMO_PAYOUTS_ENABLED === "1";
    const momoPayoutEnabled = await isFeatureEnabled("momo_payouts", momoPayoutEnvEnabled);

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

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "STORE_CREDIT_REFUND",
        entityType: "PAYMENT",
        entityId: payment.id,
        meta: {
          customerName: customer?.name ?? null,
          customerEmail: customer?.email ?? null,
          customerId: userId,
          amount,
          method,
          reference,
          note: note || null,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ paymentId: payment.id, creditRemaining: creditAvailable - amount });
  } catch (error) {
    console.error("Refund credit error", error);
    return NextResponse.json({ error: "Failed to record refund" }, { status: 500 });
  }
}
