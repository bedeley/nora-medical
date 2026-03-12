import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { postOrderEntry, postPaymentEntry } from "@/lib/accounting-posting";
import { PaymentStatus } from "@/lib/prisma-enums";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-order-post-retry", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const orderId = params.id;
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true },
  });
  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  let orderPostingStatus: "POSTED" | "FAILED" | "SKIPPED" = "SKIPPED";
  let orderPostingError: string | null = null;
  let postedPaymentCount = 0;
  const paymentErrors: Array<{ paymentId: string; error: string }> = [];

  try {
    const postedOrder = await postOrderEntry({ orderId });
    orderPostingStatus = postedOrder?.id ? "POSTED" : "SKIPPED";
  } catch (error) {
    orderPostingStatus = "FAILED";
    orderPostingError =
      error instanceof Error ? error.message : "Failed to post order journal entry";
  }

  const payments = await prisma.payment.findMany({
    where: {
      orderId,
      deletedAt: null,
      amount: { gt: 0 },
      status: { notIn: [PaymentStatus.REFUND, PaymentStatus.VOID] },
    },
    select: { id: true },
  });

  const paymentIds = payments.map((p) => p.id);
  const alreadyPosted = paymentIds.length
    ? await prisma.journalEntry.findMany({
        where: {
          sourceType: "PAYMENT",
          sourceId: { in: paymentIds },
          status: "POSTED",
        },
        select: { sourceId: true },
      })
    : [];
  const postedSet = new Set(alreadyPosted.map((entry) => entry.sourceId).filter(Boolean));
  const toRetry = paymentIds.filter((id) => !postedSet.has(id));

  for (const paymentId of toRetry) {
    try {
      const posted = await postPaymentEntry({ paymentId });
      if (posted?.id) postedPaymentCount += 1;
    } catch (error) {
      paymentErrors.push({
        paymentId,
        error:
          error instanceof Error ? error.message : "Failed to post payment journal entry",
      });
    }
  }

  await recordAuditLog({
    actorId: user?.id || null,
    action: "ORDER_ACCOUNTING_POST_RETRY",
    entityType: "ORDER",
    entityId: orderId,
    meta: {
      orderPostingStatus,
      orderPostingError,
      paymentRetryCount: toRetry.length,
      paymentPostedCount: postedPaymentCount,
      paymentErrors,
    },
  });

  return NextResponse.json({
    ok: true,
    orderPostingStatus,
    orderPostingError,
    paymentRetryCount: toRetry.length,
    paymentPostedCount: postedPaymentCount,
    paymentErrors,
  });
}
