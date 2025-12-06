import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PaymentStatus, RefundDestination } from "@/lib/prisma-enums";

type UserSummary = {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  role: string;
  archived: boolean;
  phoneVerifiedAt: Date | null;
};

type CartItemSummary = {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
};

type CartSummary = {
  id: string;
  items: CartItemSummary[];
  total: number;
  totalItems: number;
  updatedAt: string | null;
};

type CustomerRow = {
  user: UserSummary;
  ordersTotal: number;
  paidTotal: number;
  paymentsTotal: number;
  storeCredit: number;
  delivery: { delivered: number; partial: number; pending: number };
  refundedCash: number;
  lastOrderAt: string | null;
  whatsappReady: boolean;
  phoneVerified: boolean;
  cart: CartSummary | null;
};

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const results = await Promise.allSettled([
      prisma.user.findMany({
        where: { OR: [{ role: "CUSTOMER" }, { role: "ADMIN" }, { role: "STAFF" }, { role: "ACCOUNTANT" }] },
        select: { id: true, email: true, name: true, phone: true, role: true, archived: true, phoneVerifiedAt: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.order.groupBy({
        by: ["userId"],
        where: { status: { not: "CANCELLED" } },
        _sum: { total: true, amountPaid: true },
      }),
      prisma.payment.groupBy({
        by: ["userId"],
        // Payments: all non-AUTO_APPLY payment rows (cash/MoMo, refunds,
        // credit issuance). We later subtract store-credit issuance so
        // the final "Payments" column reflects net cash/MoMo after refunds.
        where: {
          NOT: {
            note: {
              contains: "\"reference\":\"AUTO_APPLY\"",
            },
          },
        },
        _sum: { amount: true },
      }),
      prisma.payment.groupBy({
        by: ["userId"],
        where: {
          status: PaymentStatus.REFUND,
          refundDisposition: RefundDestination.CASH,
        },
        _sum: { amount: true },
      }),
      // Store credit issued via returns/adjustments
      prisma.payment.groupBy({
        by: ["userId"],
        where: {
          status: PaymentStatus.NORMAL,
          refundDisposition: RefundDestination.CREDIT,
        },
        _sum: { amount: true },
      }),
      // Store credit applied to orders (AUTO_APPLY adjustments)
      prisma.payment.groupBy({
        by: ["userId"],
        where: {
          note: {
            contains: "\"reference\":\"AUTO_APPLY\"",
          },
        },
        _sum: { amount: true },
      }),
      // Store credit refunded out as cash from the dedicated credit payout flow
      prisma.payment.groupBy({
        by: ["userId"],
        where: {
          status: PaymentStatus.REFUND,
          refundDisposition: RefundDestination.CASH,
          note: {
            contains: "\"location\":\"admin/customers:credit-payout\"",
          },
        },
        _sum: { amount: true },
      }),
      prisma.order.groupBy({
        by: ["userId", "deliveryStatus"],
        where: { status: { not: "CANCELLED" } },
        _count: { _all: true },
      }),
      prisma.order.groupBy({
        by: ["userId"],
        _max: { createdAt: true },
      }),
      prisma.cart.findMany({
        include: {
          items: {
            include: {
              product: { select: { id: true, name: true, price: true } },
            },
          },
        },
      }),
    ] as const);

    const usersRes = results[0];
    const ordersRes = results[1];
    const paymentsRes = results[2];
    const refundsRes = results[3];
    const creditIssuedRes = results[4];
    const creditAppliedRes = results[5];
    const creditRefundedRes = results[6];
    const deliveryRes = results[7];
    const lastRes = results[8];
    const cartsRes = results[9];

    const users: UserSummary[] =
      usersRes.status === "fulfilled" ? (usersRes.value as UserSummary[]) : [];
    const orderSums = ordersRes.status === "fulfilled" ? ordersRes.value : [];
    const paymentSums = paymentsRes.status === "fulfilled" ? paymentsRes.value : [];
    const deliveryGroups = deliveryRes.status === "fulfilled" ? deliveryRes.value : [];
    const lastOrders = lastRes.status === "fulfilled" ? lastRes.value : [];
    const carts = cartsRes.status === "fulfilled" ? cartsRes.value : [];

    const sumsByUser: Record<string, { ordersTotal: number; paidTotal: number }> = {};
    for (const s of orderSums) {
      if (!s.userId) continue;
      const ordersTotal = Number(s._sum.total ?? 0);
      const paidTotal = Number(s._sum.amountPaid ?? 0);
      sumsByUser[s.userId] = { ordersTotal, paidTotal };
    }

    const paymentsByUser: Record<string, { paymentsTotal: number }> = {};
    for (const p of paymentSums) {
      if (!p.userId) continue;
      paymentsByUser[p.userId] = {
        paymentsTotal: Number(p._sum.amount ?? 0),
      };
    }

    const refundsByUser: Record<string, number> = {};
    if (refundsRes.status === "fulfilled") {
      for (const r of refundsRes.value) {
        if (!r.userId) continue;
        const total = Math.abs(Number(r._sum.amount ?? 0));
        refundsByUser[r.userId] = total;
      }
    }

    const creditIssuedByUser: Record<string, number> = {};
    if (creditIssuedRes.status === "fulfilled") {
      for (const r of creditIssuedRes.value) {
        if (!r.userId) continue;
        creditIssuedByUser[r.userId] = Number(r._sum.amount ?? 0);
      }
    }

    const creditAppliedByUser: Record<string, number> = {};
    if (creditAppliedRes.status === "fulfilled") {
      for (const r of creditAppliedRes.value) {
        if (!r.userId) continue;
        creditAppliedByUser[r.userId] = Number(r._sum.amount ?? 0);
      }
    }

    const creditRefundedByUser: Record<string, number> = {};
    if (creditRefundedRes.status === "fulfilled") {
      for (const r of creditRefundedRes.value) {
        if (!r.userId) continue;
        creditRefundedByUser[r.userId] = Number(r._sum.amount ?? 0);
      }
    }

    const deliveryByUser: Record<string, { delivered: number; partial: number; pending: number }> = {};
    for (const g of deliveryGroups) {
      const key = g.userId;
      if (!key) continue;
      const status = g.deliveryStatus as string;
      const countSource = (g as unknown as { _count?: { _all?: number } | number })._count;
      const count = Number(
        typeof countSource === "number" ? countSource : countSource?._all ?? 0,
      );
      if (!deliveryByUser[key]) deliveryByUser[key] = { delivered: 0, partial: 0, pending: 0 };
      if (status === "DELIVERED") deliveryByUser[key].delivered += count;
      else if (status === "PARTIALLY_DELIVERED") deliveryByUser[key].partial += count;
      else deliveryByUser[key].pending += count; // NOT_DELIVERED or null
    }

    const lastOrderByUser: Record<string, string | null> = {};
    for (const lo of lastOrders) {
      const userId = lo.userId as string | null | undefined;
      if (!userId) continue;
      const d = lo._max?.createdAt as Date | null;
      lastOrderByUser[userId] = d ? d.toISOString() : null;
    }

    const cartByUser: Record<string, CartSummary> = {};
    for (const cart of carts) {
      const items = (cart.items || []).map((item: {
        id: string;
        productId: string;
        quantity: number;
        product?: { name?: string | null; price?: unknown } | null;
      }): CartItemSummary => {
        const price = Number(item.product?.price ?? 0);
        const subtotal = price * item.quantity;
        return {
          id: item.id,
          productId: item.productId,
          productName: item.product?.name || "Unknown product",
          quantity: item.quantity,
          unitPrice: price,
          subtotal,
        };
      });
      const total = items.reduce(
        (sum: number, item: { subtotal: number }) => sum + item.subtotal,
        0
      );
      const totalItems = items.reduce(
        (sum: number, item: { quantity: number }) => sum + item.quantity,
        0
      );
      cartByUser[cart.userId] = {
        id: cart.id,
        items,
        total,
        totalItems,
        updatedAt: cart.updatedAt ? cart.updatedAt.toISOString() : null,
      };
    }

    const allRows: CustomerRow[] = users.map((u: UserSummary) => {
      const ordersTotal = sumsByUser[u.id]?.ordersTotal ?? 0;
      const paidTotal = sumsByUser[u.id]?.paidTotal ?? 0;
      const rawPaymentsTotal = paymentsByUser[u.id]?.paymentsTotal ?? 0;
      const issued = creditIssuedByUser[u.id] ?? 0;
      const applied = creditAppliedByUser[u.id] ?? 0;
      const refundedCredit = creditRefundedByUser[u.id] ?? 0;
      // creditRefundedByUser values are negative amounts; adding them reduces credit.
      const storeCredit = Math.max(0, issued - applied + refundedCredit);
      // Net cash/MoMo payments = all non-AUTO_APPLY rows minus store-credit issuance.
      const paymentsTotal = Math.max(0, rawPaymentsTotal - issued);

      return {
        user: u,
        ordersTotal,
        paidTotal,
        paymentsTotal,
        storeCredit,
        delivery: deliveryByUser[u.id] || { delivered: 0, partial: 0, pending: 0 },
        refundedCash: refundsByUser[u.id] || 0,
        lastOrderAt: lastOrderByUser[u.id] || null,
        whatsappReady: !!(u.phone && String(u.phone).trim()),
        phoneVerified: !!u.phoneVerifiedAt,
        cart: cartByUser[u.id] || null,
      };
    });

    // Only include ADMIN users if they have any activity
    const rows = allRows.filter((r: CustomerRow) => {
      if (r.user.role !== "ADMIN") return true;
      return r.ordersTotal > 0 || r.paidTotal > 0 || r.paymentsTotal > 0;
    });

    const hadFailures = results.some((r) => r.status === "rejected");
    const isProd = (process.env.NODE_ENV || "development") === "production";
    const debug =
      hadFailures && !isProd
        ? {
            errors: [
              usersRes.status === "rejected"
                ? {
                    step: "users",
                    error: String(
                      (usersRes as { reason?: { message?: string } }).reason?.message ??
                        (usersRes as { reason?: unknown }).reason ??
                        "unknown"
                    ),
                  }
                : null,
              ordersRes.status === "rejected"
                ? {
                    step: "orderSums",
                    error: String(
                      (ordersRes as { reason?: { message?: string } }).reason?.message ??
                        (ordersRes as { reason?: unknown }).reason ??
                        "unknown"
                    ),
                  }
                : null,
              paymentsRes.status === "rejected"
                ? {
                    step: "paymentSums",
                    error: String(
                      (paymentsRes as { reason?: { message?: string } }).reason?.message ??
                        (paymentsRes as { reason?: unknown }).reason ??
                        "unknown"
                    ),
                  }
                : null,
              refundsRes.status === "rejected"
                ? {
                    step: "refundSums",
                    error: String(
                      (refundsRes as { reason?: { message?: string } }).reason?.message ??
                        (refundsRes as { reason?: unknown }).reason ??
                        "unknown"
                    ),
                  }
                : null,
              creditIssuedRes.status === "rejected"
                ? {
                    step: "creditIssued",
                    error: String(
                      (creditIssuedRes as { reason?: { message?: string } }).reason?.message ??
                        (creditIssuedRes as { reason?: unknown }).reason ??
                        "unknown"
                    ),
                  }
                : null,
              creditAppliedRes.status === "rejected"
                ? {
                    step: "creditApplied",
                    error: String(
                      (creditAppliedRes as { reason?: { message?: string } }).reason?.message ??
                        (creditAppliedRes as { reason?: unknown }).reason ??
                        "unknown"
                    ),
                  }
                : null,
              creditRefundedRes.status === "rejected"
                ? {
                    step: "creditRefunded",
                    error: String(
                      (creditRefundedRes as { reason?: { message?: string } }).reason?.message ??
                        (creditRefundedRes as { reason?: unknown }).reason ??
                        "unknown"
                    ),
                  }
                : null,
              deliveryRes.status === "rejected"
                ? {
                    step: "deliveryGroups",
                    error: String(
                      (deliveryRes as { reason?: { message?: string } }).reason?.message ??
                        (deliveryRes as { reason?: unknown }).reason ??
                        "unknown"
                    ),
                  }
                : null,
              lastRes.status === "rejected"
                ? {
                    step: "lastOrders",
                    error: String(
                      (lastRes as { reason?: { message?: string } }).reason?.message ??
                        (lastRes as { reason?: unknown }).reason ??
                        "unknown"
                    ),
                  }
                : null,
              cartsRes.status === "rejected"
                ? {
                    step: "carts",
                    error: String(
                      (cartsRes as { reason?: { message?: string } }).reason?.message ??
                        (cartsRes as { reason?: unknown }).reason ??
                        "unknown"
                    ),
                  }
                : null,
            ].filter(Boolean),
          }
        : undefined;
    return NextResponse.json({ rows, partial: hadFailures, ...(debug || {}) });
  } catch (err) {
    console.error("Failed to load customers:", err);
    return NextResponse.json(
      { error: "Failed to load customers" },
      { status: 500 }
    );
  }
}
