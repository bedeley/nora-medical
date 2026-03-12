import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT" || role === "STAFF";
}

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
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-inventory-planning", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const products = await prisma.product.findMany({
    where: { archived: false, deletedAt: null },
    select: {
      id: true,
      name: true,
      sku: true,
      stock: true,
      category: true,
      supplier: true,
      supplierId: true,
      supplierRef: { select: { name: true, leadTimeDays: true, leadTimeMinDays: true, leadTimeMaxDays: true, defaultMinOrderQty: true, defaultPackSize: true, status: true } },
      supplierLinks: {
        select: {
          supplierId: true,
          isPrimary: true,
          leadTimeDays: true,
          minOrderQty: true,
          packSize: true,
        },
      },
      inventoryPlan: true,
    },
    orderBy: { name: "asc" },
  });

  const suppliers = await prisma.supplier.findMany({
    select: { name: true, leadTimeDays: true },
  });
  const supplierLeadTimeByName = new Map(
    suppliers.map((s) => [s.name.toLowerCase(), s.leadTimeDays]),
  );

  const purchases = await prisma.purchase.findMany({
    where: {
      productId: { in: products.map((p) => p.id) },
      deletedAt: null,
      status: { in: ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"] },
    },
    select: { productId: true, quantity: true, orderedQuantity: true, receivedQuantity: true },
  });
  const onOrderMap = new Map<string, number>();
  for (const p of purchases) {
    const ordered = Number(p.orderedQuantity ?? p.quantity);
    const received = Number(p.receivedQuantity ?? 0);
    const remaining = Math.max(0, ordered - received);
    onOrderMap.set(p.productId, (onOrderMap.get(p.productId) ?? 0) + remaining);
  }

  const orderItems = await prisma.orderItem.findMany({
    where: {
      productId: { in: products.map((p) => p.id) },
      order: { status: { not: "CANCELLED" }, deletedAt: null },
    },
    select: {
      productId: true,
      quantity: true,
      deliveredQuantity: true,
      returnedQuantity: true,
    },
  });
  const reservedMap = new Map<string, number>();
  for (const item of orderItems) {
    const delivered = Number(item.deliveredQuantity ?? 0);
    const returned = Number(item.returnedQuantity ?? 0);
    const reserved = Math.max(0, item.quantity - delivered - returned);
    if (reserved <= 0) continue;
    reservedMap.set(item.productId, (reservedMap.get(item.productId) ?? 0) + reserved);
  }

  const snapshots = await prisma.demandSnapshot.findMany({
    where: { productId: { in: products.map((p) => p.id) } },
    orderBy: { createdAt: "desc" },
  });
  const latestSnapshot = new Map<string, typeof snapshots[number]>();
  for (const snap of snapshots) {
    if (!latestSnapshot.has(snap.productId)) {
      latestSnapshot.set(snap.productId, snap);
    }
  }

  const suggestions = await prisma.restockSuggestion.findMany({
    where: { status: "open", productId: { in: products.map((p) => p.id) } },
    orderBy: { createdAt: "desc" },
  });
  const suggestionMap = new Map<string, typeof suggestions[number]>();
  for (const s of suggestions) {
    if (!suggestionMap.has(s.productId)) suggestionMap.set(s.productId, s);
  }

  const defaultReorderPoint = await getDefaultReorderPoint();
  const rows = products.map((product) => {
    const plan = product.inventoryPlan;
    const snapshot = latestSnapshot.get(product.id);
    const suggestion = suggestionMap.get(product.id);
    const avgDailyDemand = snapshot ? Number(snapshot.avgDailyDemand) : 0;
    const primaryLink =
      product.supplierLinks.find((link) => link.isPrimary) ||
      product.supplierLinks.find((link) => link.supplierId === product.supplierId) ||
      product.supplierLinks[0];
    const nameLeadTime =
      product.supplier && supplierLeadTimeByName.get(product.supplier.toLowerCase());
    const supplierLeadTime = primaryLink?.leadTimeDays ?? product.supplierRef?.leadTimeDays ?? nameLeadTime;
    const leadTimeMinDaysRaw = product.supplierRef?.leadTimeMinDays ?? null;
    const leadTimeMaxDaysRaw = product.supplierRef?.leadTimeMaxDays ?? null;
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
    const autoMinOrderQty = primaryLink?.minOrderQty ?? product.supplierRef?.defaultMinOrderQty ?? 1;
    const autoPackSize = primaryLink?.packSize ?? product.supplierRef?.defaultPackSize ?? 1;
    const onOrder = onOrderMap.get(product.id) ?? 0;
    const reserved = reservedMap.get(product.id) ?? 0;
    const available = product.stock - reserved + onOrder;
    const effectivePlan = plan
      ? {
          reorderPoint:
            avgDailyDemand <= 0 && plan.fallbackReorderPoint != null
              ? plan.fallbackReorderPoint
              : plan.reorderPoint,
          safetyStock: plan.safetyStock,
          leadTimeDays: plan.leadTimeDays,
          reviewPeriodDays: plan.reviewPeriodDays,
          minOrderQty: plan.minOrderQty,
          approvalThresholdQty: plan.approvalThresholdQty ?? null,
          targetStock: plan.targetStock,
        }
      : {
          reorderPoint: autoReorderPoint,
          safetyStock: autoSafetyStock,
          leadTimeDays: autoLeadTime,
          reviewPeriodDays: 60,
          minOrderQty: autoMinOrderQty,
          approvalThresholdQty: null,
          targetStock: 0,
        };
    const roundStep = Math.max(1, autoPackSize);
    const suggestedQty =
      suggestion?.suggestedQty != null
        ? Number(suggestion.suggestedQty)
        : roundUpToStep(Math.max(0, effectivePlan.reorderPoint - available), roundStep);
    return {
      id: product.id,
      name: product.name,
      sku: product.sku,
      category: product.category,
      supplier: product.supplierRef?.name || product.supplier,
      stock: product.stock,
      reserved,
      onOrder,
      available,
      plan: plan
        ? {
            reorderPoint: plan.reorderPoint,
            fallbackReorderPoint: plan.fallbackReorderPoint ?? null,
            safetyStock: plan.safetyStock,
            leadTimeDays: plan.leadTimeDays,
            reviewPeriodDays: plan.reviewPeriodDays,
            minOrderQty: plan.minOrderQty,
            approvalThresholdQty: plan.approvalThresholdQty ?? null,
            targetStock: plan.targetStock,
          }
        : null,
      effectivePlan,
      planSource: plan ? "manual" : "auto",
      demand: snapshot
        ? {
            periodStart: snapshot.periodStart.toISOString(),
            periodEnd: snapshot.periodEnd.toISOString(),
            unitsSold: snapshot.unitsSold,
            avgDailyDemand: snapshot.avgDailyDemand.toString(),
          }
        : null,
      suggestion: suggestion
        ? {
            id: suggestion.id,
            suggestedQty: suggestion.suggestedQty,
            reason: suggestion.reason,
            createdAt: suggestion.createdAt.toISOString(),
          }
        : suggestedQty > 0
        ? {
            id: null,
            suggestedQty,
            reason: "Auto-calculated based on demand and lead time.",
            createdAt: null,
          }
        : null,
    };
  });

  return NextResponse.json({ rows });
}
