import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { isLiveStage } from "@/lib/env";
import { recordAuditLog } from "@/lib/audit-log";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  if (!session || (role !== "ADMIN" && role !== "STAFF" && role !== "ACCOUNTANT")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  if (isLiveStage()) return NextResponse.json({ error: "Disabled in production." }, { status: 403 });
  if (process.env.MOMO_TEST_TOOLS_ENABLED !== "1") {
    return NextResponse.json({ error: "Simulation tools are disabled." }, { status: 403 });
  }

  const limited = await rateLimit(req, "admin-momo-simulate-late", 60_000, 40);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const params = await context.params;
    const payment = await prisma.payment.findUnique({
      where: { id: params.id },
      select: { id: true, note: true, userId: true, orderId: true, amount: true },
    });
    if (!payment) return NextResponse.json({ error: "Payment not found." }, { status: 404 });

    let meta: Record<string, unknown> | null = null;
    try {
      meta = payment.note ? (JSON.parse(payment.note) as Record<string, unknown>) : null;
    } catch {
      meta = null;
    }
    const method = String(meta?.method || "").toLowerCase();
    const providerRef = String(meta?.providerRef || "").trim();
    const currentStatus = String(meta?.status || "").toUpperCase();
    if (method !== "momo" || !providerRef) {
      return NextResponse.json({ error: "Only provider-linked MoMo payments are supported." }, { status: 400 });
    }
    if (currentStatus !== "CANCELLED_BY_STAFF") {
      return NextResponse.json(
        { error: `Payment must be CANCELLED_BY_STAFF first (current: ${currentStatus || "UNKNOWN"}).` },
        { status: 409 },
      );
    }

    const nextMeta = {
      ...(meta ?? {}),
      status: "late_success_after_cancel",
      providerStatus: "SUCCESSFUL",
      simulatedLateSuccessAt: new Date().toISOString(),
    };
    await prisma.payment.update({
      where: { id: payment.id },
      data: { note: JSON.stringify(nextMeta) },
    });

    await recordAuditLog({
      action: "MOMO_LATE_SUCCESS_SIMULATED",
      entityType: "PAYMENT",
      entityId: payment.id,
      actorId: user?.id ?? null,
      meta: {
        paymentId: payment.id,
        orderId: payment.orderId,
        userId: payment.userId,
        amount: Number(payment.amount || 0),
      },
    });

    return NextResponse.json({ ok: true, paymentId: payment.id, status: "late_success_after_cancel" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
