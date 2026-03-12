import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
    const products = await prisma.product.findMany({
      where: { archived: false, deletedAt: null },
      orderBy: { stock: "asc" },
      select: {
        id: true,
        name: true,
        price: true,
        stock: true,
        updatedAt: true,
        inventoryPlan: { select: { reorderPoint: true } },
        supplierRef: { select: { status: true, leadTimeDays: true, leadTimeMinDays: true, leadTimeMaxDays: true } },
      },
    });

    const snapshots = await prisma.demandSnapshot.findMany({
      where: { productId: { in: products.map((p) => p.id) } },
      orderBy: { createdAt: "desc" },
      select: { productId: true, avgDailyDemand: true, unitsSold: true },
    });

    const latestTwo = new Map<string, { latest?: typeof snapshots[number]; prev?: typeof snapshots[number] }>();
    for (const snap of snapshots) {
      const current = latestTwo.get(snap.productId);
      if (!current) {
        latestTwo.set(snap.productId, { latest: snap });
      } else if (!current.prev) {
        current.prev = snap;
      }
    }

    const alerts = products.flatMap((p) => {
      const items: Array<{
        id: string;
        productId: string;
        name: string;
        price: number | string;
        stock: number;
        updatedAt: string | Date;
        type: string;
        severity: "critical" | "warning";
        message: string;
      }> = [];
      const reorderPoint = p.inventoryPlan?.reorderPoint ?? 10;
      if (p.stock <= reorderPoint) {
        items.push({
          id: `${p.id}-low-stock`,
          productId: p.id,
          name: p.name,
          price: Number(p.price),
          stock: p.stock,
          updatedAt: p.updatedAt,
          type: "LOW_STOCK",
          severity: p.stock <= 3 ? "critical" : "warning",
          message: `Stock ${p.stock} at/below reorder ${reorderPoint}.`,
        });
      }
      if (p.supplierRef?.status && p.supplierRef.status !== "ACTIVE") {
        items.push({
          id: `${p.id}-supplier-inactive`,
          productId: p.id,
          name: p.name,
          price: Number(p.price),
          stock: p.stock,
          updatedAt: p.updatedAt,
          type: "SUPPLIER_INACTIVE",
          severity: "warning",
          message: `Supplier status: ${p.supplierRef.status}.`,
        });
      }
      const leadTimeMissing =
        p.supplierRef == null ||
        (p.supplierRef.leadTimeDays == null &&
          p.supplierRef.leadTimeMinDays == null &&
          p.supplierRef.leadTimeMaxDays == null);
      if (leadTimeMissing) {
        items.push({
          id: `${p.id}-leadtime-missing`,
          productId: p.id,
          name: p.name,
          price: Number(p.price),
          stock: p.stock,
          updatedAt: p.updatedAt,
          type: "LEAD_TIME_MISSING",
          severity: "warning",
          message: "Lead time not configured.",
        });
      }
      const snap = latestTwo.get(p.id);
      const latest = snap?.latest;
      const prev = snap?.prev;
      if (latest && prev) {
        const latestAvg = Number(latest.avgDailyDemand || 0);
        const prevAvg = Number(prev.avgDailyDemand || 0);
        if (prevAvg > 0 && latestAvg >= prevAvg * 1.5 && Number(latest.unitsSold || 0) >= 5) {
          items.push({
            id: `${p.id}-demand-spike`,
            productId: p.id,
            name: p.name,
            price: Number(p.price),
            stock: p.stock,
            updatedAt: p.updatedAt,
            type: "DEMAND_SPIKE",
            severity: "warning",
            message: `Demand spike: ${latestAvg.toFixed(2)} vs ${prevAvg.toFixed(2)} avg/day.`,
          });
        }
      }
      return items;
    });

    return NextResponse.json(alerts);
  } catch (err) {
    console.error("Error fetching inventory alerts:", err);
    return NextResponse.json(
      { error: "Failed to fetch inventory alerts" },
      { status: 500 },
    );
  }
}
