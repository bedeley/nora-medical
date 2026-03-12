import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PaymentStatus } from "@/lib/prisma-enums";
import { recomputeOrderTotalsFromPayments } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/origin";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-health-backfill", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const paymentId = String(body?.paymentId || "");
  if (!paymentId) {
    return NextResponse.json({ error: "Missing paymentId" }, { status: 400 });
  }

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, orderId: true, amount: true, note: true, status: true },
  });
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  if (payment.orderId) {
    return NextResponse.json({ error: "Payment already linked to an order" }, { status: 400 });
  }

  const note = payment.note || "";
  let meta: { reference?: string; applied?: Array<{ orderId?: string; applied?: number }> } | null = null;
  try {
    meta = JSON.parse(note) as { reference?: string; applied?: Array<{ orderId?: string; applied?: number }> };
  } catch {
    meta = null;
  }

  if (!meta || meta.reference !== "AUTO_APPLY" || !Array.isArray(meta.applied)) {
    return NextResponse.json({ error: "Payment is not legacy AUTO_APPLY" }, { status: 400 });
  }

  const appliedRows = meta.applied.filter((a) => a?.orderId);
  if (appliedRows.length !== 1) {
    return NextResponse.json({ error: "Payment applies to multiple orders" }, { status: 400 });
  }

  const applied = appliedRows[0];
  const orderId = String(applied.orderId);
  const appliedAmount = Number(applied.applied || 0);
  if (!orderId || appliedAmount <= 0) {
    return NextResponse.json({ error: "Invalid applied data" }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx: TxClient) => {
    const nextNote = JSON.stringify({ ...meta, backfilled: true });
    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: {
        orderId,
        amount: appliedAmount,
        status: PaymentStatus.NORMAL,
        note: nextNote,
      },
      select: { id: true, orderId: true, amount: true },
    });
    await recomputeOrderTotalsFromPayments(tx, orderId);
    return updatedPayment;
  });

  return NextResponse.json({ ok: true, payment: updated });
}
