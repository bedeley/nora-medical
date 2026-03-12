import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recomputeOrderTotalsFromPayments } from "@/lib/payments";
import { postPaymentEntry } from "@/lib/accounting-posting";
import { notifyPaymentEvent } from "@/lib/notifications";
import { recordAuditLog } from "@/lib/audit-log";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

const confirmSchema = z.object({
  amount: z.number().positive("Amount must be greater than 0"),
  method: z.enum(["cash", "momo", "transfer", "card"]).default("cash"),
  reference: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
  claimCreatedAt: z.string().datetime().optional(),
});

function parseMeta(raw?: string | null) {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-dispatch-collection-confirm", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = confirmSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const payload = parsed.data;
  if (payload.method !== "cash" && !String(payload.reference || "").trim()) {
    return NextResponse.json(
      { error: "Payment reference is required for MoMo, transfer, or card confirmations." },
      { status: 400 },
    );
  }

  const params = await context.params;
  const orderId = params.id;
  const latestClaim = await prisma.auditLog.findFirst({
    where: {
      entityType: "ORDER",
      entityId: orderId,
      action: "ORDER_DELIVERY_COLLECTION_RECORDED",
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, meta: true, actorId: true },
  });
  const latestConfirm = await prisma.auditLog.findFirst({
    where: {
      entityType: "ORDER",
      entityId: orderId,
      action: "ORDER_DELIVERY_COLLECTION_CONFIRMED",
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!latestClaim || (latestConfirm && latestConfirm.createdAt >= latestClaim.createdAt)) {
    return NextResponse.json({ error: "No pending dispatcher collection claim found for this order." }, { status: 409 });
  }
  if (payload.claimCreatedAt && new Date(payload.claimCreatedAt).toISOString() !== latestClaim.createdAt.toISOString()) {
    return NextResponse.json(
      { error: "Collection claim changed. Refresh and confirm the latest claim." },
      { status: 409 },
    );
  }

  const claimMeta = parseMeta(latestClaim.meta);
  const result = await prisma.$transaction(async (tx: TxClient) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, status: true, balance: true },
    });
    if (!order) throw new Error("Order not found");
    if (order.status === "CANCELLED") throw new Error("Cannot record payment for cancelled order");
    const balance = Number(order.balance || 0);
    const amount = Number(payload.amount || 0);
    if (amount > balance + 0.01) {
      throw new Error("Amount cannot exceed current order balance.");
    }

    const meta = {
      method: payload.method,
      reference:
        payload.method === "cash"
          ? "DISPATCH_COLLECTION_CONFIRM"
          : String(payload.reference || "").trim() || "DISPATCH_COLLECTION_CONFIRM",
      location: "admin/delivery/dispatch",
      note: String(payload.note || "").trim() || "Dispatcher collection confirmed by admin/staff",
      source: "dispatcher-collection-confirmation",
      claimCollectedAt: String(claimMeta?.collectedAt || ""),
      claimCollectorId: String(claimMeta?.collectorId || ""),
      claimCollectorName: String(claimMeta?.collectorName || ""),
      claimMethod: String(claimMeta?.method || ""),
      claimAmount: Number(claimMeta?.amount || 0),
    };

    const payment = await tx.payment.create({
      data: {
        userId: order.userId,
        orderId: order.id,
        amount,
        note: JSON.stringify(meta),
      },
    });

    const updatedOrder = await recomputeOrderTotalsFromPayments(tx, order.id);
    return { paymentId: payment.id, order: updatedOrder };
  });

  let paymentPostingStatus: "POSTED" | "FAILED" | "SKIPPED" = "SKIPPED";
  let paymentPostingError: string | null = null;
  try {
    const postedPayment = await postPaymentEntry({ paymentId: result.paymentId });
    paymentPostingStatus = postedPayment?.id ? "POSTED" : "SKIPPED";
  } catch (e) {
    paymentPostingStatus = "FAILED";
    paymentPostingError = e instanceof Error ? e.message : "Failed to post payment journal entry";
    console.warn("dispatch collection confirm posting error:", e);
  }

  try {
    if (result.order.userId) {
      await notifyPaymentEvent({
        kind: "payment_recorded",
        userId: result.order.userId,
        amount: Number(payload.amount || 0),
        orderId,
        subject: "Payment received - updated receipt",
      });
    }
  } catch (e) {
    console.warn("notifyPaymentEvent (dispatch confirm) error:", e);
  }

  await recordAuditLog({
    actorId: user?.id,
    action: "ORDER_DELIVERY_COLLECTION_CONFIRMED",
    entityType: "ORDER",
    entityId: orderId,
    meta: {
      amount: Number(payload.amount || 0),
      method: payload.method,
      reference: String(payload.reference || "").trim() || null,
      note: String(payload.note || "").trim() || null,
      claimCreatedAt: latestClaim.createdAt.toISOString(),
      claimCollectorId: String(claimMeta?.collectorId || "") || null,
      claimCollectorName: String(claimMeta?.collectorName || "") || null,
      claimAmount: Number(claimMeta?.amount || 0) || null,
      claimMethod: String(claimMeta?.method || "") || null,
      paymentId: result.paymentId,
      paymentPostingStatus,
      paymentPostingError,
    },
  });

  return NextResponse.json({
    ok: true,
    paymentId: result.paymentId,
    paymentPostingStatus,
    paymentPostingError,
    order: result.order,
  });
}

