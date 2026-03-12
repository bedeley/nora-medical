import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { postPaymentEntry } from "@/lib/accounting-posting";

function parseMeta(note: string | null) {
  if (!note) return null;
  try {
    return JSON.parse(note) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-momo-resolve-late", 60_000, 40);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const params = await context.params;
  const payment = await prisma.payment.findUnique({ where: { id: params.id } });
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  const meta = parseMeta(payment.note);
  const method = String(meta?.method || "").toLowerCase();
  const status = String(meta?.status || "").toUpperCase();
  if (method !== "momo") {
    return NextResponse.json({ error: "Only MoMo payments are supported." }, { status: 400 });
  }
  if (status !== "LATE_SUCCESS_AFTER_CANCEL") {
    return NextResponse.json(
      { error: "Only late-success-after-cancel payments can be resolved with this action." },
      { status: 409 },
    );
  }

  const resolvedMeta = {
    ...(meta || {}),
    status: "resolved_to_credit",
    reference: "LATE_MOMO_SUCCESS_AFTER_CANCEL",
    resolvedAt: new Date().toISOString(),
    resolvedBy: {
      id: user?.id || null,
      name: user?.name || null,
      role: user?.role || null,
    },
    resolutionNote: "Late MoMo success captured as store credit liability",
  };

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      note: JSON.stringify(resolvedMeta),
      refundDisposition: "CREDIT",
    },
  });

  let posted = false;
  let postingError: string | null = null;
  try {
    const entry = await postPaymentEntry({ paymentId: payment.id });
    posted = Boolean(entry?.id);
  } catch (error) {
    postingError = error instanceof Error ? error.message : "Failed to post late MoMo resolution";
  }

  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: "MOMO_LATE_SUCCESS_RESOLVED_TO_CREDIT",
      entityType: "PAYMENT",
      entityId: payment.id,
      meta: JSON.stringify({
        orderId: payment.orderId || null,
        userId: payment.userId || null,
        amount: Number(payment.amount || 0),
        resolvedBy: "MANUAL_RESOLVE",
        posted,
        postingError,
      }),
    },
  });

  return NextResponse.json({
    ok: true,
    posted,
    postingError,
    userId: payment.userId || null,
  });
}
