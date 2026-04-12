import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PaymentStatus, RefundDestination } from "@/lib/prisma-enums";

type SupportedRole = "CUSTOMER" | "ADMIN" | "STAFF" | "ACCOUNTANT";

type UserSummary = {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  role: string;
  archived: boolean;
  phoneVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
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
  creditLimit: number;
  lastOrderAt: string | null;
  whatsappReady: boolean;
  phoneVerified: boolean;
  cart: CartSummary | null;
};

export async function GET(req: Request) {
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
    const { searchParams } = new URL(req.url);
    const includeArchived = searchParams.get("includeArchived") === "1";
    const q = String(searchParams.get("q") || "").trim();
    const customerLedgerScope = searchParams.get("scope") === "customer-ledger";
    const ids = String(searchParams.get("ids") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const requestedRoles = String(searchParams.get("roles") || "")
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter((value): value is SupportedRole =>
        ["CUSTOMER", "ADMIN", "STAFF", "ACCOUNTANT"].includes(value),
      );
    const scopedRoles = requestedRoles.length
      ? requestedRoles
      : (["CUSTOMER", "ADMIN", "STAFF", "ACCOUNTANT"] as SupportedRole[]);
    const rawPage = Number(searchParams.get("page") || 1);
    const rawPageSize = Number(searchParams.get("pageSize") || 20);
    const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;
    const pageSize = Number.isFinite(rawPageSize)
      ? Math.min(50, Math.max(1, Math.floor(rawPageSize)))
      : 20;
    const applyPagination =
      ids.length > 0 || q.length > 0 || searchParams.has("page") || searchParams.has("pageSize");
    const phoneDigits = q.replace(/\D/g, "");
    const phoneTail = phoneDigits.length >= 7 ? phoneDigits.slice(-7) : "";
    const scopeOr: Prisma.UserWhereInput[] = customerLedgerScope && !requestedRoles.length
      ? [
          { role: "CUSTOMER" },
          { orders: { some: {} } },
          { payments: { some: {} } },
          { cart: { isNot: null } },
          { balance: { isNot: null } },
        ]
      : scopedRoles.map((role) => ({ role }));
    const searchOr: Prisma.UserWhereInput[] = q
      ? [
          { id: { contains: q } },
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          ...(phoneDigits ? [{ phone: { contains: phoneDigits } }] : []),
          ...(phoneTail && phoneTail !== phoneDigits ? [{ phone: { contains: phoneTail } }] : []),
        ]
      : [];
    const userWhere: Prisma.UserWhereInput = {
      archived: includeArchived ? undefined : false,
      AND: [
        { OR: scopeOr },
        ...(ids.length ? [{ id: { in: ids } }] : []),
        ...(searchOr.length ? [{ OR: searchOr }] : []),
      ],
    };
    const usersQuery = prisma.user.findMany({
      where: userWhere,
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        archived: true,
        phoneVerifiedAt: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      ...(applyPagination
        ? {
            skip: (page - 1) * pageSize,
            take: pageSize,
          }
        : {}),
    });
    const totalQuery = applyPagination ? prisma.user.count({ where: userWhere }) : Promise.resolve(null);
    const [selectedUsers, total] = await Promise.all([usersQuery, totalQuery]);
    const userIds = selectedUsers.map((row) => row.id);
    if (!userIds.length) {
      return NextResponse.json({
        rows: [],
        partial: false,
        total: Number(total || 0),
        page,
        pageSize: applyPagination ? pageSize : 0,
      });
    }
    const results = await Promise.allSettled([
      Promise.resolve(selectedUsers),
      prisma.order.groupBy({
        by: ["userId"],
        where: { status: { not: "CANCELLED" }, userId: { in: userIds } },
        _sum: { total: true, amountPaid: true },
      }),
      prisma.payment.groupBy({
        by: ["userId"],
        // Payments: all non-AUTO_APPLY payment rows (cash/MoMo, refunds,
        // credit issuance). We later subtract store-credit issuance so
        // the final "Payments" column reflects net cash/MoMo after refunds.
        where: {
          userId: { in: userIds },
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
          userId: { in: userIds },
          status: PaymentStatus.REFUND,
          refundDisposition: RefundDestination.CASH,
        },
        _sum: { amount: true },
      }),
      // Store credit issued via returns/adjustments
      prisma.order.groupBy({
        by: ["userId", "deliveryStatus"],
        where: { status: { not: "CANCELLED" }, userId: { in: userIds } },
        _count: { _all: true },
      }),
      prisma.order.groupBy({
        by: ["userId"],
        where: { userId: { in: userIds } },
        _max: { createdAt: true },
      }),
      prisma.cart.findMany({
        where: { userId: { in: userIds } },
        include: {
          items: {
            include: {
              product: { select: { id: true, name: true, price: true } },
            },
          },
        },
      }),
      // Full payment ledger for store-credit computation — runs in parallel with other queries
      prisma.payment.findMany({
        where: { userId: { in: userIds } },
        select: {
          userId: true,
          amount: true,
          status: true,
          refundDisposition: true,
          note: true,
        },
      }),
      prisma.balance.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, creditLimit: true },
      }),
    ] as const);

    const usersRes = results[0];
    const ordersRes = results[1];
    const paymentsRes = results[2];
    const refundsRes = results[3];
    const deliveryRes = results[4];
    const lastRes = results[5];
    const cartsRes = results[6];
    const paymentsLedgerRes = results[7];
    const balanceRowsRes = results[8];

    const users: UserSummary[] =
      usersRes.status === "fulfilled" ? (usersRes.value as UserSummary[]) : [];
    const orderSums = ordersRes.status === "fulfilled" ? ordersRes.value : [];
    const paymentSums = paymentsRes.status === "fulfilled" ? paymentsRes.value : [];
    const deliveryGroups = deliveryRes.status === "fulfilled" ? deliveryRes.value : [];
    const lastOrders = lastRes.status === "fulfilled" ? lastRes.value : [];
    const carts = cartsRes.status === "fulfilled" ? cartsRes.value : [];
    const paymentsLedger = paymentsLedgerRes.status === "fulfilled" ? paymentsLedgerRes.value : [];
    const balanceRows = balanceRowsRes.status === "fulfilled" ? balanceRowsRes.value : [];

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

    // Build a per-user store credit ledger using the same semantics as
    // /api/admin/customers/[id]/balance so values stay consistent.
    // (paymentsLedger and balanceRows are fetched in parallel above)
    const creditLimitByUser: Record<string, number> = {};
    for (const row of balanceRows) {
      creditLimitByUser[row.userId] = Number(row.creditLimit || 0);
    }

    const creditIssuedByUser: Record<string, number> = {};
    const creditAppliedByUser: Record<string, number> = {};
    const creditRefundedByUser: Record<string, number> = {};
    const storeCreditByUser: Record<string, number> = {};

    for (const p of paymentsLedger as Array<{
      userId: string | null;
      amount: unknown;
      status: unknown;
      refundDisposition: unknown;
      note: string | null;
    }>) {
      if (!p.userId) continue;
      const userId = p.userId;
      const amount = Number(p.amount || 0);
      const note = p.note || "";
      let meta: {
        reference?: string;
        location?: string;
        refundDisposition?: string;
        method?: string;
      } = {};
      try {
        meta = note ? (JSON.parse(note) as typeof meta) : {};
      } catch {
        // ignore malformed meta
      }
      const isAutoApply =
        meta.reference === "AUTO_APPLY" ||
        note.includes("\"reference\":\"AUTO_APPLY\"");
      const topLevelDisposition =
        typeof p.refundDisposition === "string"
          ? (p.refundDisposition as string).toUpperCase()
          : null;
      const metaDisposition = meta.refundDisposition
        ? meta.refundDisposition.toUpperCase()
        : null;
      const isCreditDestination =
        topLevelDisposition === RefundDestination.CREDIT ||
        metaDisposition === "CREDIT";
      const isCashDestination =
        topLevelDisposition === RefundDestination.CASH ||
        metaDisposition === "CASH";
      const isAdjustment =
        (meta.method || "").toLowerCase() === "adjustment";
      const isCreditIssued =
        p.status === PaymentStatus.NORMAL &&
        amount > 0 &&
        (isCreditDestination || (isAdjustment && !isAutoApply));
      const isCreditCashPayout =
        p.status === PaymentStatus.REFUND &&
        isCashDestination &&
        (meta.location === "admin/customers:credit-payout" ||
          note.includes("\"location\":\"admin/customers:credit-payout\""));

      if (isCreditIssued) {
        creditIssuedByUser[userId] = (creditIssuedByUser[userId] || 0) + amount;
      } else if (isAutoApply) {
        creditAppliedByUser[userId] =
          (creditAppliedByUser[userId] || 0) + amount;
      } else if (isCreditCashPayout) {
        creditRefundedByUser[userId] =
          (creditRefundedByUser[userId] || 0) + amount;
      }
    }

    for (const userId of Object.keys(creditIssuedByUser)) {
      const issued = creditIssuedByUser[userId] ?? 0;
      const applied = creditAppliedByUser[userId] ?? 0;
      const refundedCredit = creditRefundedByUser[userId] ?? 0;
      storeCreditByUser[userId] = Math.max(0, issued - applied + refundedCredit);
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
      const storeCredit = storeCreditByUser[u.id] ?? 0;
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
        creditLimit: creditLimitByUser[u.id] ?? 0,
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
              paymentsLedgerRes.status === "rejected"
                ? {
                    step: "paymentsLedger",
                    error: String(
                      (paymentsLedgerRes as { reason?: { message?: string } }).reason?.message ??
                        (paymentsLedgerRes as { reason?: unknown }).reason ??
                        "unknown"
                    ),
                  }
                : null,
              balanceRowsRes.status === "rejected"
                ? {
                    step: "balanceRows",
                    error: String(
                      (balanceRowsRes as { reason?: { message?: string } }).reason?.message ??
                        (balanceRowsRes as { reason?: unknown }).reason ??
                        "unknown"
                    ),
                  }
                : null,
            ].filter(Boolean),
          }
        : undefined;
    return NextResponse.json({
      rows,
      partial: hadFailures,
      total: applyPagination ? Number(total || 0) : rows.length,
      page,
      pageSize: applyPagination ? pageSize : rows.length,
      ...(debug || {}),
    });
  } catch (err) {
    console.error("Failed to load customers:", err);
    return NextResponse.json(
      { error: "Failed to load customers" },
      { status: 500 }
    );
  }
}
