import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type SupplierStats = {
  supplierId: string | null;
  supplierName: string;
  status: string;
  leadTimeDays: number | null;
  purchases: number;
  qtyOrdered: number;
  qtyReceived: number;
  totalSpend: number;
  leadTimeCount: number;
  leadTimeSum: number;
  varianceCount: number;
  varianceSum: number;
  onTimeCount: number;
  onTimeTotal: number;
  lastPurchaseAt: Date | null;
};

function diffDays(start: Date, end: Date) {
  const ms = end.getTime() - start.getTime();
  return Math.max(0, Math.round(ms / (1000 * 60 * 60 * 24)));
}

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const q = String(searchParams.get("q") || "").trim().toLowerCase();
    const status = String(searchParams.get("status") || "").toUpperCase();

    const where: {
      deletedAt?: null;
      createdAt?: { gte?: Date; lte?: Date };
    } = {
      deletedAt: null,
    };

    if (start || end) {
      where.createdAt = {};
      if (start) where.createdAt.gte = new Date(start);
      if (end) {
        const dt = new Date(end);
        dt.setHours(23, 59, 59, 999);
        where.createdAt.lte = dt;
      }
    }

    const purchases = await prisma.purchase.findMany({
      where,
      include: {
        supplierRef: {
          select: {
            id: true,
            name: true,
            status: true,
            leadTimeDays: true,
          },
        },
        movements: {
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const stats = new Map<string, SupplierStats>();

    for (const purchase of purchases) {
      const supplierName =
        purchase.supplierRef?.name || purchase.supplier || "Unassigned";
      const supplierKey = purchase.supplierRef?.id || `name:${supplierName}`;
      const supplierStatus = purchase.supplierRef?.status || "UNASSIGNED";

      if (status && status !== "ALL" && supplierStatus !== status) {
        continue;
      }

      if (q && !supplierName.toLowerCase().includes(q)) {
        continue;
      }

      const entry =
        stats.get(supplierKey) ||
        ({
          supplierId: purchase.supplierRef?.id || null,
          supplierName,
          status: supplierStatus,
          leadTimeDays: purchase.supplierRef?.leadTimeDays ?? null,
          purchases: 0,
          qtyOrdered: 0,
          qtyReceived: 0,
          totalSpend: 0,
          leadTimeCount: 0,
          leadTimeSum: 0,
          varianceCount: 0,
          varianceSum: 0,
          onTimeCount: 0,
          onTimeTotal: 0,
          lastPurchaseAt: null,
        } satisfies SupplierStats);

      const orderedQty = Number(purchase.orderedQuantity ?? purchase.quantity ?? 0);
      const receivedQty = Number(purchase.receivedQuantity ?? 0);
      const unitCost = Number(purchase.unitCost || 0);
      const receivedAt = purchase.movements?.[0]?.createdAt || null;

      entry.purchases += 1;
      entry.qtyOrdered += orderedQty;
      entry.qtyReceived += receivedQty;
      entry.totalSpend += receivedQty * unitCost;
      if (!entry.lastPurchaseAt || purchase.createdAt > entry.lastPurchaseAt) {
        entry.lastPurchaseAt = purchase.createdAt;
      }

      if (receivedAt) {
        const actualLead = diffDays(purchase.createdAt, receivedAt);
        entry.leadTimeCount += 1;
        entry.leadTimeSum += actualLead;

        let expectedLead: number | null = null;
        if (purchase.expectedAt) {
          expectedLead = diffDays(purchase.createdAt, purchase.expectedAt);
        } else if (entry.leadTimeDays != null) {
          expectedLead = entry.leadTimeDays;
        }

        if (expectedLead != null) {
          entry.varianceCount += 1;
          entry.varianceSum += actualLead - expectedLead;
          entry.onTimeTotal += 1;
          entry.onTimeCount += actualLead <= expectedLead ? 1 : 0;
        }
      }

      stats.set(supplierKey, entry);
    }

    const rows = Array.from(stats.values()).sort((a, b) =>
      a.supplierName.localeCompare(b.supplierName)
    );

    const totals = rows.reduce(
      (acc, row) => {
        acc.suppliers += 1;
        acc.totalSpend += row.totalSpend;
        acc.totalOrdered += row.qtyOrdered;
        acc.totalReceived += row.qtyReceived;
        acc.leadTimeSum += row.leadTimeSum;
        acc.leadTimeCount += row.leadTimeCount;
        acc.onTimeCount += row.onTimeCount;
        acc.onTimeTotal += row.onTimeTotal;
        acc.varianceSum += row.varianceSum;
        acc.varianceCount += row.varianceCount;
        return acc;
      },
      {
        suppliers: 0,
        totalSpend: 0,
        totalOrdered: 0,
        totalReceived: 0,
        leadTimeSum: 0,
        leadTimeCount: 0,
        onTimeCount: 0,
        onTimeTotal: 0,
        varianceSum: 0,
        varianceCount: 0,
      }
    );

    return NextResponse.json({
      rows,
      totals,
    });
  } catch (error) {
    console.error("Supplier performance error:", error);
    return NextResponse.json({ error: "Failed to load supplier performance" }, { status: 500 });
  }
}
