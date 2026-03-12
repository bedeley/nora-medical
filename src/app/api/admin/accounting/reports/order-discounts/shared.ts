import { prisma } from "@/lib/prisma";
import type { AuthenticatedUser } from "@/lib/auth";
import { parseDateRange } from "../utils";

export type OrderDiscountRow = {
  orderId: string;
  invoiceNumber: string | null;
  createdAt: string;
  customerName: string;
  customerType: "REGISTERED" | "WALK_IN";
  createdBy: string;
  status: string;
  subtotal: number;
  taxAmount: number;
  grossAmount: number;
  total: number;
  discountAmount: number;
  discountPct: number;
  discountReason: string | null;
};

export type OrderDiscountSummary = {
  discountedOrders: number;
  totalGross: number;
  totalDiscount: number;
  totalNet: number;
  discountRatePct: number;
};

export function canViewOrderDiscountReport(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function parseDiscountReason(metaRaw?: string | null) {
  if (!metaRaw) return null;
  try {
    const meta = JSON.parse(metaRaw) as { discountReason?: string | null };
    const value = String(meta?.discountReason || "").trim();
    return value || null;
  } catch {
    return null;
  }
}

export async function loadOrderDiscountReport(opts: {
  start?: string | null;
  end?: string | null;
  customerType?: string | null;
}) {
  const { start, end, customerType } = opts;
  const createdAt = parseDateRange(start || undefined, end || undefined);

  const orders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      ...(createdAt.gte || createdAt.lte ? { createdAt } : {}),
      ...(customerType && customerType !== "ALL"
        ? { customerType: customerType as "REGISTERED" | "WALK_IN" }
        : {}),
    },
    select: {
      id: true,
      invoiceNumber: true,
      createdAt: true,
      customerType: true,
      walkInName: true,
      status: true,
      subtotal: true,
      taxAmount: true,
      total: true,
      user: { select: { name: true, email: true } },
      placedBy: { select: { name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const orderIds = orders.map((o) => o.id);
  const auditRows = orderIds.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "ORDER",
          action: "ORDER_CREATE_ADMIN",
          entityId: { in: orderIds },
        },
        select: { entityId: true, meta: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const reasonByOrderId = new Map<string, string | null>();
  for (const row of auditRows) {
    if (reasonByOrderId.has(row.entityId)) continue;
    reasonByOrderId.set(row.entityId, parseDiscountReason(row.meta));
  }

  const rows: OrderDiscountRow[] = orders
    .map((order) => {
      const subtotal = Number(order.subtotal || 0);
      const taxAmount = Number(order.taxAmount || 0);
      const grossAmount = subtotal + taxAmount;
      const total = Number(order.total || 0);
      const discountAmount = Math.max(0, grossAmount - total);
      if (!(discountAmount > 0.0001)) return null;
      const customerName =
        order.customerType === "WALK_IN"
          ? String(order.walkInName || "").trim() || "Walk-in"
          : String(order.user?.name || order.user?.email || "Unknown");
      const createdBy = String(order.placedBy?.name || order.placedBy?.email || "System");
      const discountPct = grossAmount > 0 ? (discountAmount / grossAmount) * 100 : 0;
      return {
        orderId: order.id,
        invoiceNumber: order.invoiceNumber || null,
        createdAt: order.createdAt.toISOString(),
        customerName,
        customerType: order.customerType,
        createdBy,
        status: String(order.status || ""),
        subtotal,
        taxAmount,
        grossAmount,
        total,
        discountAmount,
        discountPct,
        discountReason: reasonByOrderId.get(order.id) || null,
      };
    })
    .filter((row): row is OrderDiscountRow => row !== null);

  const summary: OrderDiscountSummary = {
    discountedOrders: rows.length,
    totalGross: rows.reduce((sum, row) => sum + row.grossAmount, 0),
    totalDiscount: rows.reduce((sum, row) => sum + row.discountAmount, 0),
    totalNet: rows.reduce((sum, row) => sum + row.total, 0),
    discountRatePct: 0,
  };
  summary.discountRatePct =
    summary.totalGross > 0 ? (summary.totalDiscount / summary.totalGross) * 100 : 0;

  return {
    range: { start: start || null, end: end || null },
    filters: { customerType: customerType || "ALL" },
    summary,
    rows,
  };
}
