import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payment = await prisma.payment.findUnique({
      where: { id: params.id },
      include: { user: { select: { id: true, name: true, email: true, phone: true } }, order: { select: { id: true } } },
    });
    if (!payment) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Parse metadata (method, reference, receivedBy, location, status, note, applied[])
    let meta: Record<string, unknown> | null = null;
    if (payment.note) {
      try {
        meta = JSON.parse(payment.note) as Record<string, unknown>;
      } catch {
        meta = null;
      }
    }

    // Current customer totals (post-payment)
    const orders = await prisma.order.findMany({
      where: { userId: payment.userId, NOT: { status: "CANCELLED" } },
      select: { total: true, amountPaid: true },
    });
    const totalDue = orders.reduce(
      (s: number, o: { total: unknown }) => s + Number(o.total || 0),
      0
    );
    const totalPaid = orders.reduce(
      (s: number, o: { amountPaid: unknown }) => s + Number(o.amountPaid || 0),
      0,
    );
    const balance = Math.max(0, totalDue - totalPaid);

    // Determine payment result text
    let settlement: "FULL" | "PARTIAL" | "REFUND" | "VOID" = "PARTIAL";
    const metaStatus =
      (meta?.status as string | undefined)?.toLowerCase() ?? "";
    if (metaStatus === "void") settlement = "VOID";
    else if (metaStatus === "refund" || Number(payment.amount) < 0)
      settlement = "REFUND";
    else if (balance <= 0) settlement = "FULL";

    // If tied to a specific order, include its delivery status snapshot
    let delivery:
      | {
          orderId: string | null;
          deliveryStatus?: string;
          deliveredAt?: Date | null;
        }
      | null = null;
    if (payment.orderId) {
      const ord = await prisma.order.findUnique({
        where: { id: payment.orderId },
        select: { id: true, deliveryStatus: true, deliveredAt: true },
      });
      if (ord) {
        delivery = {
          orderId: ord.id,
          deliveryStatus: ord.deliveryStatus ?? undefined,
          deliveredAt: ord.deliveredAt ?? null,
        };
      } else {
        delivery = { orderId: payment.orderId, deliveryStatus: undefined, deliveredAt: null };
      }
    }

    return NextResponse.json({
      payment: {
        id: payment.id,
        userId: payment.userId,
        user: payment.user,
        orderId: payment.orderId,
        amount: Number(payment.amount),
        createdAt: payment.createdAt,
      },
      meta,
      applied: Array.isArray(meta?.applied)
        ? (meta.applied as unknown[])
        : [],
      totalsBefore: (meta?.preTotals as unknown) ?? null,
      totals: { totalDue, totalPaid, balance },
      settlement,
      delivery,
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Failed to load receipt" }, { status: 500 });
  }
}
