import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Bucket = "0-30" | "31-60" | "61-90" | "90+";

function resolveBucket(days: number): Bucket {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

function daysBetween(start: Date, end: Date) {
  const diff = end.getTime() - start.getTime();
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function resolvePayableQuantity(purchase: {
  status: string;
  quantity?: number | null;
  orderedQuantity?: number | null;
  receivedQuantity?: number | null;
}) {
  const receivedQty = Number(purchase.receivedQuantity ?? 0);
  const orderedQty = Number(purchase.orderedQuantity ?? purchase.quantity ?? 0);
  const fallbackQty = orderedQty > 0 ? orderedQty : Number(purchase.quantity ?? 0);
  const includeWithoutReceipt = purchase.status === "RECEIVED" || purchase.status === "PARTIALLY_RECEIVED";
  const baseQty =
    receivedQty > 0
      ? receivedQty
      : includeWithoutReceipt
      ? fallbackQty
      : 0;
  const excludeUnreceived =
    receivedQty <= 0 &&
    !includeWithoutReceipt &&
    !["RECEIVED", "PARTIALLY_RECEIVED"].includes(purchase.status);
  const exclude = purchase.status === "CANCELLED" && receivedQty <= 0;
  return { qty: Math.max(0, baseQty), exclude: exclude || excludeUnreceived };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const type = String(searchParams.get("type") || "ar").toLowerCase();
    const q = String(searchParams.get("q") || "").trim().toLowerCase();
    const asOf = searchParams.get("asOf");
    const asOfDate = asOf ? new Date(asOf) : new Date();
    asOfDate.setHours(23, 59, 59, 999);

    if (type === "ap") {
      const purchases = await prisma.purchase.findMany({
        where: { deletedAt: null },
        include: {
          supplierRef: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      const purchaseIds = purchases.map((p) => p.id);
      const paymentSums = purchaseIds.length
        ? await prisma.supplierPayment.groupBy({
            by: ["purchaseId"],
            where: { deletedAt: null, status: "NORMAL", purchaseId: { in: purchaseIds } },
            _sum: { amount: true },
          })
        : [];
      const paidByPurchase = new Map(
        paymentSums
          .filter((row) => row.purchaseId)
          .map((row) => [row.purchaseId as string, Number(row._sum.amount || 0)]),
      );

      const rowsMap = new Map<string, {
        supplierId: string | null;
        supplierName: string;
        buckets: Record<Bucket, number>;
        total: number;
        lastPurchaseAt: Date | null;
      }>();

      for (const purchase of purchases) {
        const payable = resolvePayableQuantity({
          status: purchase.status,
          quantity: purchase.quantity,
          orderedQuantity: purchase.orderedQuantity,
          receivedQuantity: purchase.receivedQuantity,
        });
        if (payable.exclude || payable.qty <= 0) {
          continue;
        }
        const supplierName = purchase.supplierRef?.name || purchase.supplier || "Unassigned";
        if (q && !supplierName.toLowerCase().includes(q)) {
          continue;
        }
        const total = Number(purchase.unitCost || 0) * payable.qty;
        const paid = paidByPurchase.get(purchase.id) || 0;
        const outstanding = Math.max(0, total - paid);
        if (outstanding <= 0.01) continue;

        const key = purchase.supplierRef?.id || `name:${supplierName}`;
        const row = rowsMap.get(key) || {
          supplierId: purchase.supplierRef?.id || null,
          supplierName,
          buckets: { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 },
          total: 0,
          lastPurchaseAt: null,
        };
        const age = daysBetween(purchase.createdAt, asOfDate);
        const bucket = resolveBucket(age);
        row.buckets[bucket] += outstanding;
        row.total += outstanding;
        if (!row.lastPurchaseAt || purchase.createdAt > row.lastPurchaseAt) {
          row.lastPurchaseAt = purchase.createdAt;
        }
        rowsMap.set(key, row);
      }

      const rows = Array.from(rowsMap.values()).sort((a, b) =>
        a.supplierName.localeCompare(b.supplierName)
      );
      const totals = rows.reduce(
        (acc, row) => {
          acc.total += row.total;
          (Object.keys(row.buckets) as Bucket[]).forEach((bucket) => {
            acc.buckets[bucket] += row.buckets[bucket];
          });
          return acc;
        },
        { total: 0, buckets: { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 } }
      );

      return NextResponse.json({ type: "ap", asOf: asOfDate, rows, totals });
    }

    const orders = await prisma.order.findMany({
      where: {
        deletedAt: null,
        balance: { gt: 0 },
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const userIds = Array.from(
      new Set(
        orders
          .map((order) => order.user?.id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const paymentLastByUser = userIds.length
      ? await prisma.payment.groupBy({
          by: ["userId"],
          where: {
            deletedAt: null,
            status: "NORMAL",
            userId: { in: userIds },
          },
          _max: { createdAt: true },
        })
      : [];
    const lastPaymentAtMap = new Map(
      paymentLastByUser
        .filter((row) => row.userId)
        .map((row) => [row.userId as string, row._max.createdAt || null]),
    );

    const rowsMap = new Map<string, {
      customerId: string | null;
      customerName: string;
      customerEmail: string | null;
      buckets: Record<Bucket, number>;
      total: number;
      lastOrderAt: Date | null;
      lastPaymentAt: Date | null;
    }>();

    for (const order of orders) {
      const name = order.user?.name || "Guest customer";
      const email = order.user?.email || null;
      const searchable = `${name} ${email || ""} ${order.invoiceNumber || ""} ${order.id}`.toLowerCase();
      if (q && !searchable.includes(q)) {
        continue;
      }
      const outstanding = Number(order.balance || 0);
      if (outstanding <= 0.01) continue;
      const key = order.user?.id || `guest:${order.id}`;
      const row = rowsMap.get(key) || {
        customerId: order.user?.id || null,
        customerName: name,
        customerEmail: email,
        buckets: { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 },
        total: 0,
        lastOrderAt: null,
        lastPaymentAt: order.user?.id ? (lastPaymentAtMap.get(order.user.id) || null) : null,
      };
      const age = daysBetween(order.createdAt, asOfDate);
      const bucket = resolveBucket(age);
      row.buckets[bucket] += outstanding;
      row.total += outstanding;
      if (!row.lastOrderAt || order.createdAt > row.lastOrderAt) {
        row.lastOrderAt = order.createdAt;
      }
      rowsMap.set(key, row);
    }

    const rows = Array.from(rowsMap.values()).sort((a, b) =>
      a.customerName.localeCompare(b.customerName)
    );
    const totals = rows.reduce(
      (acc, row) => {
        acc.total += row.total;
        (Object.keys(row.buckets) as Bucket[]).forEach((bucket) => {
          acc.buckets[bucket] += row.buckets[bucket];
        });
        return acc;
      },
      { total: 0, buckets: { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 } }
    );

    return NextResponse.json({ type: "ar", asOf: asOfDate, rows, totals });
  } catch (error) {
    console.error("Aging report error:", error);
    return NextResponse.json({ error: "Failed to load aging report" }, { status: 500 });
  }
}
