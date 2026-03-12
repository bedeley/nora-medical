import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";

type InventoryPurchase = {
  quantity: number | null;
  unitCost: number | null;
  createdAt: Date;
  supplier: string | null;
  note: string | null;
};

function roundUpToStep(value: number, step: number) {
  if (step <= 1) return Math.ceil(value);
  return Math.ceil(value / step) * step;
}

async function getDefaultReorderPoint() {
  const setting = await prisma.appSetting.findUnique({
    where: { key: "inventoryPlanning.defaultReorderPoint" },
    select: { value: true },
  });
  const raw = typeof setting?.value === "number" ? setting.value : Number(setting?.value);
  return Number.isFinite(raw) && raw >= 0 ? Number(raw) : 10;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return new Response("Forbidden", { status: 403 });
  }
  const { searchParams } = new URL(req.url);
  const includeArchived = searchParams.get("includeArchived") === "1";
  const lookbackDays = 30;
  const since = new Date();
  since.setDate(since.getDate() - lookbackDays);
  since.setHours(0, 0, 0, 0);

  const orderItemSums = await prisma.orderItem.groupBy({
    by: ["productId"],
    where: {
      createdAt: { gte: since },
      order: { status: { not: "CANCELLED" } },
    },
    _sum: { quantity: true },
  });
  const salesByProduct = new Map<string, number>();
  for (const row of orderItemSums) {
    if (!row.productId) continue;
    salesByProduct.set(row.productId, Number(row._sum.quantity ?? 0));
  }

  const suppliers = await prisma.supplier.findMany({
    select: { name: true, leadTimeDays: true },
  });
  const supplierLeadTimeByName = new Map(
    suppliers.map((s) => [s.name.toLowerCase(), s.leadTimeDays]),
  );
  const defaultReorderPoint = await getDefaultReorderPoint();

  const products = await prisma.product.findMany({
    where: includeArchived ? undefined : { archived: false },
    orderBy: { updatedAt: "desc" },
    include: {
      purchases: {
        where: { status: "RECEIVED" },
        orderBy: { createdAt: "desc" },
        select: { quantity: true, unitCost: true, createdAt: true, supplier: true, note: true },
      },
      inventoryPlan: true,
      supplierRef: {
        select: {
          name: true,
          leadTimeDays: true,
          leadTimeMinDays: true,
          leadTimeMaxDays: true,
          defaultMinOrderQty: true,
          defaultPackSize: true,
        },
      },
      supplierLinks: {
        select: {
          supplierId: true,
          isPrimary: true,
          leadTimeDays: true,
          minOrderQty: true,
          packSize: true,
        },
      },
    },
  });
  const productIds = products.map((p) => p.id);
  const snapshots = await prisma.demandSnapshot.findMany({
    where: { productId: { in: productIds } },
    orderBy: { createdAt: "desc" },
  });
  const latestSnapshot = new Map<string, typeof snapshots[number]>();
  for (const snap of snapshots) {
    if (!latestSnapshot.has(snap.productId)) {
      latestSnapshot.set(snap.productId, snap);
    }
  }
  const suggestions = await prisma.restockSuggestion.findMany({
    where: { status: "open", productId: { in: productIds } },
    orderBy: { createdAt: "desc" },
  });
  const suggestionMap = new Map<string, typeof suggestions[number]>();
  for (const s of suggestions) {
    if (!suggestionMap.has(s.productId)) suggestionMap.set(s.productId, s);
  }
  const openPurchases = await prisma.purchase.findMany({
    where: {
      productId: { in: productIds },
      deletedAt: null,
      status: { in: ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"] },
    },
    select: { productId: true, quantity: true, orderedQuantity: true, receivedQuantity: true },
  });
  const onOrderMap = new Map<string, number>();
  for (const p of openPurchases) {
    const ordered = Number(p.orderedQuantity ?? p.quantity);
    const received = Number(p.receivedQuantity ?? 0);
    const remaining = Math.max(0, ordered - received);
    onOrderMap.set(p.productId, (onOrderMap.get(p.productId) ?? 0) + remaining);
  }
  const openOrderItems = await prisma.orderItem.findMany({
    where: {
      productId: { in: productIds },
      order: { status: { not: "CANCELLED" }, deletedAt: null },
    },
    select: { productId: true, quantity: true, deliveredQuantity: true, returnedQuantity: true },
  });
  const reservedMap = new Map<string, number>();
  for (const item of openOrderItems) {
    const delivered = Number(item.deliveredQuantity ?? 0);
    const returned = Number(item.returnedQuantity ?? 0);
    const reserved = Math.max(0, item.quantity - delivered - returned);
    if (reserved <= 0) continue;
    reservedMap.set(item.productId, (reservedMap.get(item.productId) ?? 0) + reserved);
  }
  const rows = products.map((p: (typeof products)[number]) => {
    const purchases = (p.purchases || []) as unknown as InventoryPurchase[];
    // Ignore zero/negative or invalid unit costs when computing averages
    const validPurchases = purchases.filter((pu) => {
      const q = Number(pu.quantity ?? 0);
      const c = Number(pu.unitCost ?? 0);
      return Number.isFinite(q) && q > 0 && Number.isFinite(c) && c > 0;
    });
    const last = validPurchases[0] || null;
    // Weighted average unit cost across all valid purchases
    let avgPurchaseCost: number | null = null;
    if (validPurchases.length > 0) {
      let totalQty = 0;
      let totalCost = 0;
      for (const pu of validPurchases) {
        const q = Number(pu.quantity || 0);
        const c = Number(pu.unitCost || 0);
        if (q > 0 && !Number.isNaN(c)) {
          totalQty += q;
          totalCost += q * c;
        }
      }
      if (totalQty > 0) avgPurchaseCost = totalCost / totalQty;
    }
    const baseCost = Number(p.cost ?? 0);

    let lastPurchaseCost: number | null = null;
    let lastPurchaseDate: string | null = null;
    let lastPurchaseSupplier: string | null = null;
    let lastPurchaseNote: string | null = null;

    if (last) {
      lastPurchaseCost = Number(last.unitCost);
      lastPurchaseDate = (last.createdAt as Date).toISOString();
      lastPurchaseSupplier = last.supplier ?? null;
      lastPurchaseNote = last.note ?? null;
    } else if (baseCost > 0) {
      // Fallback: if there are no valid purchases yet but the product
      // has a positive cost set, surface that as the last unit cost
      lastPurchaseCost = baseCost;
    }

    const soldLast30 = salesByProduct.get(p.id) ?? 0;
    const avgDailySales = soldLast30 > 0 ? soldLast30 / lookbackDays : 0;
    const daysOfStock = avgDailySales > 0 ? Number(p.stock || 0) / avgDailySales : null;
    const weeksCover = daysOfStock !== null ? daysOfStock / 7 : null;
    const snapshot = latestSnapshot.get(p.id);
    const avgDailyDemand = snapshot ? Number(snapshot.avgDailyDemand) : 0;
    const primaryLink =
      p.supplierLinks.find((link) => link.isPrimary) ||
      p.supplierLinks.find((link) => link.supplierId === p.supplierId) ||
      p.supplierLinks[0];
    const nameLeadTime = p.supplier && supplierLeadTimeByName.get(p.supplier.toLowerCase());
    const supplierLeadTime = primaryLink?.leadTimeDays ?? p.supplierRef?.leadTimeDays ?? nameLeadTime;
    const leadTimeMinDaysRaw = p.supplierRef?.leadTimeMinDays ?? null;
    const leadTimeMaxDaysRaw = p.supplierRef?.leadTimeMaxDays ?? null;
    const autoLeadTime = Number(supplierLeadTime ?? 14);
    const leadTimeMinDays = leadTimeMinDaysRaw == null ? null : Number(leadTimeMinDaysRaw);
    const leadTimeMaxDays = leadTimeMaxDaysRaw == null ? null : Number(leadTimeMaxDaysRaw);
    const variabilityDays =
      leadTimeMinDays != null && leadTimeMaxDays != null
        ? Math.max(0, (leadTimeMaxDays - leadTimeMinDays) / 2)
        : 0;
    const fallbackReorderPoint = defaultReorderPoint;
    const autoSafetyStock =
      avgDailyDemand > 0 ? Math.ceil(avgDailyDemand * autoLeadTime * 0.5 + avgDailyDemand * variabilityDays) : 0;
    const autoReorderPoint =
      avgDailyDemand > 0 ? Math.ceil(avgDailyDemand * autoLeadTime) + autoSafetyStock : fallbackReorderPoint;
    const autoPackSize = primaryLink?.packSize ?? p.supplierRef?.defaultPackSize ?? 1;
    const onOrder = onOrderMap.get(p.id) ?? 0;
    const reserved = reservedMap.get(p.id) ?? 0;
    const available = p.stock - reserved + onOrder;
    const effectiveReorderPoint =
      avgDailyDemand <= 0 && p.inventoryPlan?.fallbackReorderPoint != null
        ? p.inventoryPlan.fallbackReorderPoint
        : p.inventoryPlan?.reorderPoint ?? autoReorderPoint;
    const suggestion = suggestionMap.get(p.id);
    const suggestedQty =
      suggestion?.suggestedQty != null
        ? Number(suggestion.suggestedQty)
        : roundUpToStep(Math.max(0, effectiveReorderPoint - available), Math.max(1, autoPackSize));

    return {
      id: p.id,
      sku: p.sku ?? null,
      name: p.name,
      requiresLotTracking: Boolean(p.requiresLotTracking),
      requiresExpiryDate: Boolean(p.requiresExpiryDate),
      price: Number(p.price),
      cost: baseCost,
      stock: p.stock,
      totalValue: Number(p.price) * p.stock,
      lastPurchaseCost,
      lastPurchaseDate,
      lastPurchaseSupplier,
      lastPurchaseNote,
      avgPurchaseCost,
      soldLast30,
      avgDailySales,
      daysOfStock,
      weeksCover,
      reorderPoint: effectiveReorderPoint,
      suggestedReorder: suggestedQty > 0 ? suggestedQty : null,
    };
  });
  return Response.json({ rows });
}
