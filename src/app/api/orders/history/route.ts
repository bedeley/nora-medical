import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";

const normalizeBalance = (value: number) => (Math.abs(value) < 0.01 ? 0 : value);

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const me = session.user as AuthenticatedUser;
  const url = new URL(req.url);
  const format = url.searchParams.get("format") || "";
  const reqUrlUserId = url.searchParams.get("userId") || "";
  const isPrivileged = me.role === "ADMIN" || me.role === "STAFF" || me.role === "ACCOUNTANT";
  const userId = isPrivileged && reqUrlUserId ? reqUrlUserId : me.id;

  const orders = await prisma.order.findMany({
    where: { userId },
    include: {
      payments: true,
      items: {
        include: {
          product: { select: { id: true, name: true, imageUrl: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Include AUTO_APPLY credit adjustment payments for this user so that
  // order summaries can show how much store credit was applied to each order,
  // even though those adjustment entries are not tied to a single orderId.
  const autoApplyPayments = await prisma.payment.findMany({
    where: {
      userId,
      note: {
        contains: "\"reference\":\"AUTO_APPLY\"",
      },
    },
  });

  // Normalize numeric fields and include computed balance consistently
  const data = orders.map((o: typeof orders[number]) => {
    const total = Number(o.total);
    const amountPaid = Number(o.amountPaid ?? 0);
    const rawBalance = Number(o.balance ?? 0);
    const computedBalance = Math.max(0, total - amountPaid);
    const balance = normalizeBalance(rawBalance === 0 ? computedBalance : rawBalance);
    // Merge per-order payments with AUTO_APPLY credit entries for this user
    // (deduplicated by id).
    const mergedPayments = (() => {
      if (!autoApplyPayments.length) return o.payments || [];
      const map = new Map<string, (typeof o.payments)[number]>();
      for (const p of o.payments || []) {
        map.set(p.id, p);
      }
      for (const p of autoApplyPayments) {
        if (!map.has(p.id)) map.set(p.id, p as (typeof o.payments)[number]);
      }
      return Array.from(map.values());
    })();

    return {
      id: o.id,
      status: o.status,
      deliveryStatus: o.deliveryStatus,
      deliveredAt: o.deliveredAt ? o.deliveredAt.toISOString() : null,
      createdAt: o.createdAt.toISOString(),
      subtotal: Number(o.subtotal ?? o.total ?? 0),
      taxAmount: Number(o.taxAmount ?? 0),
      total,
      discountAmount: Math.max(
        0,
        Number(o.subtotal ?? o.total ?? 0) + Number(o.taxAmount ?? 0) - total,
      ),
      amountPaid,
      balance,
      payments: mergedPayments.map((p: typeof mergedPayments[number]) => ({
        id: p.id,
        amount: Number(p.amount),
        note: p.note,
        status: p.status || null,
        refundDisposition: p.refundDisposition || null,
        createdAt: p.createdAt.toISOString(),
      })),
      items: (o.items || []).map((it: typeof o.items[number]) => ({
        id: it.id,
        quantity: it.quantity,
        price: Number(it.price),
        deliveredQuantity: Number(
          (it as { deliveredQuantity?: unknown }).deliveredQuantity ?? 0,
        ),
        returnedQuantity: Number(
          (it as { returnedQuantity?: unknown }).returnedQuantity ?? 0,
        ),
        product: it.product
          ? {
              id: it.product.id,
              name: it.product.name,
              imageUrl: it.product.imageUrl,
            }
          : null,
      })),
    };
  });

  if (format.toLowerCase() === "csv") {
    const escapeCsv = (value: string | number | null | undefined) => {
      const text = value === null || value === undefined ? "" : String(value);
      if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
        return `"${text.replace(/\"/g, "\"\"")}"`;
      }
      return text;
    };
    const header = [
      "Order ID",
      "Date",
      "Status",
      "Delivery Status",
      "Taxable Subtotal",
      "Tax",
      "Discount",
      "Invoice Total",
      "Paid",
      "Balance",
    ];
    const rows = data.map((o) => [
      escapeCsv(o.id),
      escapeCsv(o.createdAt),
      escapeCsv(o.status),
      escapeCsv(o.deliveryStatus ?? ""),
      escapeCsv(o.subtotal),
      escapeCsv(o.taxAmount),
      escapeCsv(o.discountAmount),
      escapeCsv(o.total),
      escapeCsv(o.amountPaid),
      escapeCsv(o.balance),
    ]);
    const csv = [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"orders-statement.csv\"",
      },
    });
  }

  return Response.json({ orders: data });
}

