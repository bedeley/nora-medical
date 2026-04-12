import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

type PaymentMeta = {
  applied?: Array<{ orderId?: unknown }>;
};

function parseOrderIdsFromPayment(payment: { orderId: string | null; note: string | null }) {
  const ids = new Set<string>();
  if (payment.orderId) ids.add(payment.orderId);
  if (!payment.note) return ids;
  try {
    const meta = JSON.parse(payment.note) as PaymentMeta;
    for (const row of meta.applied || []) {
      const orderId = String(row?.orderId || "").trim();
      if (orderId) ids.add(orderId);
    }
  } catch {
    // ignore malformed legacy metadata
  }
  return ids;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  if (!session || (role !== "ADMIN" && role !== "ACCOUNTANT")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await rateLimit(req, "admin-customer-backfill-orders", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const params = await context.params;
  const customerId = params.id;
  if (!customerId) {
    return NextResponse.json({ error: "Missing customer id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { orderIds?: unknown };
  const manualTokens = Array.isArray(body.orderIds)
    ? body.orderIds.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  try {
    const [customer, payments] = await Promise.all([
      prisma.user.findUnique({
        where: { id: customerId },
        select: { id: true, email: true, name: true },
      }),
      prisma.payment.findMany({
        where: { userId: customerId },
        select: { orderId: true, note: true },
      }),
    ]);

    if (!customer) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    const inferredOrderIds = new Set<string>();
    for (const payment of payments) {
      for (const orderId of parseOrderIdsFromPayment(payment)) {
        inferredOrderIds.add(orderId);
      }
    }

    const tokens = manualTokens.length ? manualTokens : Array.from(inferredOrderIds);
    if (tokens.length === 0) {
      return NextResponse.json({
        linked: 0,
        alreadyLinked: 0,
        skippedDifferentUser: 0,
        missingOrders: 0,
        message: "No order references found for this customer.",
      });
    }

    const orders = await prisma.order.findMany({
      where: {
        OR: [
          { id: { in: tokens } },
          { invoiceNumber: { in: tokens } },
        ],
      },
      select: { id: true, invoiceNumber: true, userId: true },
    });

    const foundTokenValues = new Set<string>();
    for (const order of orders) {
      foundTokenValues.add(order.id);
      if (order.invoiceNumber) foundTokenValues.add(order.invoiceNumber);
    }

    const missingOrders = manualTokens.length
      ? tokens.filter((token) => !foundTokenValues.has(token)).length
      : 0;
    const toLink = orders.filter((order) => !order.userId);
    const alreadyLinked = orders.filter((order) => order.userId === customerId).length;
    const skippedDifferentUser = orders.filter(
      (order) => order.userId && order.userId !== customerId,
    ).length;

    if (toLink.length > 0) {
      await prisma.$transaction(
        toLink.map((order) =>
          prisma.order.update({
            where: { id: order.id },
            data: { userId: customerId },
          }),
        ),
      );
    }

    try {
      await recordAuditLog({
        actorId: user?.id,
        action: "CUSTOMER_ORDER_LINK_BACKFILL",
        entityType: "USER",
        entityId: customerId,
        request: req,
        outcome: skippedDifferentUser > 0 || missingOrders > 0 ? "PARTIAL" : "SUCCESS",
        meta: {
          customerId,
          customerEmail: customer.email ?? null,
          customerName: customer.name ?? null,
          sourcePage: "admin/customers",
          sourceRoute: `/api/admin/customers/${customerId}/backfill-orders`,
          mode: manualTokens.length ? "manual" : "inferred_from_payments",
          requestedReferences: tokens,
          linkedOrderIds: toLink.map((order) => order.id),
          alreadyLinked,
          skippedDifferentUser,
          missingOrders,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({
      linked: toLink.length,
      alreadyLinked,
      skippedDifferentUser,
      missingOrders,
      linkedOrderIds: toLink.map((order) => order.id),
    });
  } catch (error) {
    console.error("Customer order link backfill error:", error);
    return NextResponse.json({ error: "Failed to backfill order links" }, { status: 500 });
  }
}
