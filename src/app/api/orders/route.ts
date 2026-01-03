import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { assertSameOrigin } from "@/lib/origin";
import { notifyOrderEvent } from "@/lib/notifications";
import { recomputeOrderTotalsFromPayments } from "@/lib/payments";
import { randomUUID } from "crypto";
import { computeReceiptHash } from "@/lib/receipt-hash";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

/**
 * ✅ GET /api/orders
 * Fetch user orders (or all orders if admin)
 */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = session.user as AuthenticatedUser;
  const isAdmin = user.role === "ADMIN";
  const url = new URL(req.url);
  const allParam = url.searchParams.get("all");
  const allowAll = isAdmin && allParam === "1"; // opt-in to all orders view
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const pageSize = Math.max(
    1,
    Math.min(100, Number(url.searchParams.get("pageSize") || 25)),
  );
  const filter = url.searchParams.get("filter");
  const deliveryFilter = url.searchParams.get("dFilter");
  const q = (url.searchParams.get("q") || "").trim();
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const minTotal = url.searchParams.get("minTotal");
  const maxTotal = url.searchParams.get("maxTotal");
  const paymentMethod = url.searchParams.get("paymentMethod");
  const userIdParam = url.searchParams.get("userId");
  const sortKey = url.searchParams.get("sortKey");
  const sortDir = url.searchParams.get("sortDir") === "asc" ? "asc" : "desc";

  try {
    const where: Prisma.OrderWhereInput = allowAll ? {} : { userId: user.id };

    if (allowAll && userIdParam) {
      where.userId = userIdParam;
    }
    if (filter && filter !== "ALL") {
      where.status = filter;
    }
    if (deliveryFilter && deliveryFilter !== "ALL") {
      where.deliveryStatus = deliveryFilter;
    }
    if (start || end) {
      where.createdAt = {};
      if (start) where.createdAt.gte = new Date(`${start}T00:00:00`);
      if (end) where.createdAt.lte = new Date(`${end}T23:59:59`);
    }
    if (minTotal || maxTotal) {
      where.total = {};
      if (minTotal) where.total.gte = Number(minTotal);
      if (maxTotal) where.total.lte = Number(maxTotal);
    }
    if (q) {
      where.OR = [
        { id: { contains: q } },
        { invoiceNumber: { contains: q, mode: "insensitive" } },
        { user: { name: { contains: q, mode: "insensitive" } } },
        { user: { email: { contains: q, mode: "insensitive" } } },
        { user: { phone: { contains: q, mode: "insensitive" } } },
      ];
    }
    if (paymentMethod && paymentMethod !== "ALL") {
      const token = `"method":"${paymentMethod}"`;
      where.payments = { some: { note: { contains: token } } };
    }

    const orderBy: Prisma.OrderOrderByWithRelationInput = (() => {
      switch (sortKey) {
        case "total":
          return { total: sortDir };
        case "amountPaid":
          return { amountPaid: sortDir };
        case "balance":
          return { balance: sortDir };
        case "createdAt":
          return { createdAt: sortDir };
        case "customer":
          return { user: { name: sortDir } };
        case "invoice":
          return { invoiceNumber: sortDir };
        default:
          return { createdAt: "desc" as const };
      }
    })();

    const [orders, total, aggregates] = await Promise.all([
      prisma.order.findMany({
        where,
        include: {
          items: { include: { product: true } },
          user: { select: { id: true, name: true, email: true, phone: true } },
        },
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.order.count({ where }),
      prisma.order.aggregate({
        where,
        _sum: { total: true, amountPaid: true, balance: true },
      }),
    ]);

    const safeOrders = orders.map((o) => {
      const total = Number(o.total);
      let amountPaid = Number(o.amountPaid ?? 0);
      const epsilon = 0.01;
      // Always recompute balance from total/amountPaid, then infer display status
      let balance = Math.max(0, total - amountPaid);
      let status = o.status as string;
      if (status !== "CANCELLED") {
        if (balance <= epsilon) {
          // Treat tiny balances as fully paid
          status = "PAID";
          amountPaid = total;
          balance = 0;
        } else if (amountPaid <= epsilon) {
          status = "UNPAID";
        } else if (status !== "PARTIALLY_PAID") {
          status = "PARTIALLY_PAID";
        }
      }
      return {
        id: o.id,
        userId: o.userId || null,
        status,
        deliveryStatus: o.deliveryStatus || "NOT_DELIVERED",
        deliveredAt: o.deliveredAt
          ? new Date(o.deliveredAt).toISOString()
          : null,
        total,
        amountPaid,
        balance,
        createdAt: o.createdAt.toISOString(),
        updatedAt: o.updatedAt.toISOString(),
        invoiceNumber: o.invoiceNumber || null,
        user: o.user,
        items: o.items.map((i) => ({
          id: i.id,
          quantity: i.quantity,
          price: Number(i.price),
          product: {
            id: i.product.id,
            name: i.product.name,
            imageUrl: i.product.imageUrl,
          },
        })),
      };
    });

    return NextResponse.json({
      items: safeOrders,
      total,
      page,
      pageSize,
      totals: {
        total: Number(aggregates._sum.total || 0),
        paid: Number(aggregates._sum.amountPaid || 0),
        balance: Number(aggregates._sum.balance || 0),
      },
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    return NextResponse.json(
      { error: "Failed to fetch orders" },
      { status: 500 }
    );
  }
}

/**
 * ✅ POST /api/orders
 * Create a new order from the current user’s cart
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req))
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const userId = (session.user as AuthenticatedUser).id;

  try {
    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: { include: { product: true } } },
    });

    if (!cart || cart.items.length === 0) {
      return NextResponse.json({ error: "Empty cart" }, { status: 400 });
    }

    // Validate stock and active products
    for (const ci of cart.items) {
      const p = ci.product;
      if (!p || p.archived) {
        return NextResponse.json(
          { error: `Product unavailable: ${p?.name || ci.productId}` },
          { status: 400 }
        );
      }
      if (typeof p.stock === "number" && p.stock < ci.quantity) {
        return NextResponse.json(
          { error: `Insufficient stock for ${p.name}. In stock: ${p.stock}` },
          { status: 400 }
        );
      }
    }

    const total = cart.items.reduce(
      (sum: number, it: { quantity: number; product: { price: unknown } }) =>
        sum + Number(it.product.price) * it.quantity,
      0
    );

    // ✅ All actions in one safe transaction
    const order = await prisma.$transaction(async (tx: TxClient) => {
      const newOrder = await tx.order.create({
        data: {
          userId,
          subtotal: total,
          taxRate: 0,
          taxAmount: 0,
          total,
          amountPaid: 0,
          balance: total,
          status: "UNPAID",
        },
      });

      await tx.orderItem.createMany({
        data: cart.items.map((ci: {
          productId: string;
          product: { price: unknown; cost: unknown };
          quantity: number;
        }) => ({
          orderId: newOrder.id,
          productId: ci.productId,
          price: Number(ci.product.price),
          costAtSale: Number(ci.product.cost ?? 0),
          quantity: ci.quantity,
        })),
      });

      const invoiceNumber = `INV-${newOrder.id}`;
      const receiptHash = computeReceiptHash({
        orderId: newOrder.id,
        invoiceNumber,
        subtotal: total,
        taxRate: 0,
        taxAmount: 0,
        total,
        createdAt: newOrder.createdAt.toISOString(),
        items: cart.items.map((ci: { productId: string; quantity: number; product: { price: unknown } }) => ({
          productId: ci.productId,
          quantity: ci.quantity,
          price: Number(ci.product.price),
        })),
      });
      await tx.order.update({
        where: { id: newOrder.id },
        data: { invoiceNumber, receiptHash },
      });

      // Decrement stock
      for (const ci of cart.items as Array<{
        productId: string;
        quantity: number;
      }>) {
        await tx.product.update({
          where: { id: ci.productId },
          data: { stock: { decrement: ci.quantity } },
        });
        // Log inventory movement for sale
        await tx.inventoryMovement.create({
          data: { productId: ci.productId, delta: -ci.quantity, reason: "SALE" },
        });
      }

      // Clear cart after checkout
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      // After creating order, automatically apply any available store credit
      // across all open orders (including this one) using the same rules as
      // the account/credit apply endpoint.
      const orders = await tx.order.findMany({
        where: { userId, NOT: { status: "CANCELLED" } },
        select: { id: true, total: true, amountPaid: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const payments = await tx.payment.findMany({
        where: {
          userId,
          NOT: {
            note: {
              contains: "\"reference\":\"AUTO_APPLY\"",
            },
          },
        },
        select: { amount: true },
      });

      const totalDue = orders.reduce(
        (s, o) => s + Number(o.total || 0),
        0,
      );
      const totalPaid = orders.reduce(
        (s, o) => s + Number(o.amountPaid || 0),
        0,
      );
      const paymentsTotal = payments.reduce(
        (s, p) => s + Number(p.amount || 0),
        0,
      );

      const balance = Math.max(0, totalDue - totalPaid);
      const credit = Math.max(0, paymentsTotal - totalPaid);

      if (balance > 0.005 && credit > 0.005) {
        const amountToApply = Math.min(balance, credit);

        // Snapshot totals BEFORE applying credit
        const beforeOrders = await tx.order.findMany({
          where: { userId, NOT: { status: "CANCELLED" } },
          select: { total: true, amountPaid: true },
        });
        const totalDueBefore = beforeOrders.reduce(
          (s: number, o: { total: unknown }) => s + Number(o.total || 0),
          0,
        );
        const totalPaidBefore = beforeOrders.reduce(
          (s: number, o: { amountPaid: unknown }) =>
            s + Number(o.amountPaid || 0),
          0,
        );
        const balanceBefore = Math.max(0, totalDueBefore - totalPaidBefore);

        const meta = {
          note: "Customer-applied store credit (auto during checkout)",
          method: "adjustment",
          reference: "AUTO_APPLY",
          receivedBy: "system",
          location: "orders/checkout",
          status: "normal",
          preTotals: {
            totalDue: totalDueBefore,
            totalPaid: totalPaidBefore,
            balance: balanceBefore,
          },
        };

        let remainingPayment = amountToApply;
        const applied: Array<{
          orderId: string;
          applied: number;
          newAmountPaid: number;
          newBalance: number;
          newStatus: string;
        }> = [];
        const batchId = randomUUID();
        const createdPaymentIds: string[] = [];

        for (const o of orders) {
          if (remainingPayment <= 0) break;
          const paid = Number(o.amountPaid ?? 0);
          const totalO = Number(o.total);
          const remainingO = Math.max(0, totalO - paid);
          if (remainingO <= 0) continue;
          const applyAmt = Math.min(remainingPayment, remainingO);
          const payment = await tx.payment.create({
            data: {
              userId,
              orderId: o.id,
              amount: applyAmt,
              note: JSON.stringify({
                ...meta,
                batchId,
                applied: [{ orderId: o.id, applied: applyAmt }],
              }),
              status: "NORMAL",
              refundDisposition: null,
            },
          });
          createdPaymentIds.push(payment.id);

          const updatedO = await recomputeOrderTotalsFromPayments(tx, o.id);
          applied.push({
            orderId: updatedO.id,
            applied: applyAmt,
            newAmountPaid: Number(updatedO.amountPaid ?? 0),
            newBalance: Number(updatedO.balance ?? 0),
            newStatus: String(updatedO.status),
          });
          remainingPayment -= applyAmt;
        }

        const afterOrders = await tx.order.findMany({
          where: { userId, NOT: { status: "CANCELLED" } },
          select: { total: true, amountPaid: true },
        });
        const totalDueAfter = afterOrders.reduce(
          (s: number, o: { total: unknown }) => s + Number(o.total || 0),
          0,
        );
        const totalPaidAfter = afterOrders.reduce(
          (s: number, o: { amountPaid: unknown }) =>
            s + Number(o.amountPaid || 0),
          0,
        );
        const balanceAfter = Math.max(0, totalDueAfter - totalPaidAfter);

        if (createdPaymentIds.length > 0) {
          try {
            const withApplied = {
              ...meta,
              batchId,
              applied,
              postTotals: {
                totalDue: totalDueAfter,
                totalPaid: totalPaidAfter,
                balance: balanceAfter,
              },
            };
            for (const id of createdPaymentIds) {
              await tx.payment.update({
                where: { id },
                data: { note: JSON.stringify(withApplied) },
              });
            }
          } catch {}
        }
      }

      return newOrder;
    });

    // Customer-facing notification: order confirmation
    try {
      await notifyOrderEvent({
        kind: "order_created",
        userId,
        orderId: order.id,
        total,
      });
    } catch (e) {
      console.warn("notifyOrderEvent (order_created) error:", e);
    }

    return NextResponse.json({
      success: true,
      message: "Order placed successfully.",
      orderId: order.id,
      total,
    });
  } catch (error) {
    console.error("Error creating order:", error);
    return NextResponse.json(
      { error: "Failed to create order" },
      { status: 500 }
    );
  }
}

