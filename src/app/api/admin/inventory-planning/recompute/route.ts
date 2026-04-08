import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { verifyCronSecret } from "@/lib/cron-auth";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
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

function isCronAuthorized(req: Request) {
  return verifyCronSecret(req);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const cronAuth = isCronAuthorized(req);
  if (!session && !cronAuth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session && !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!cronAuth && !assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-inventory-plan-recompute", 60_000, 5);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  if (cronAuth) {
    const settings = await prisma.appSetting.findMany({
      where: {
        key: { in: ["inventoryPlanning.autoRecompute", "inventoryPlanning.lastRecomputeAt"] },
      },
      select: { key: true, value: true },
    });
    const autoSetting = settings.find((s) => s.key === "inventoryPlanning.autoRecompute");
    const lastSetting = settings.find((s) => s.key === "inventoryPlanning.lastRecomputeAt");
    const autoValue = typeof autoSetting?.value === "string" ? autoSetting.value : "off";
    if (autoValue !== "daily" && autoValue !== "weekly") {
      return NextResponse.json({ ok: true, skipped: true, reason: "auto_recompute_disabled" });
    }
    const lastValue = typeof lastSetting?.value === "string" ? lastSetting.value : null;
    const lastRun = lastValue ? new Date(lastValue) : null;
    const now = new Date();
    const minMs = autoValue === "weekly" ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    if (lastRun && Number.isFinite(lastRun.getTime()) && now.getTime() - lastRun.getTime() < minMs) {
      return NextResponse.json({ ok: true, skipped: true, reason: "not_due", lastRun });
    }
  }

  const periodDays = 60;
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - periodDays * 24 * 60 * 60 * 1000);

  const defaultReorderPoint = await getDefaultReorderPoint();
  const products = await prisma.product.findMany({
    where: { archived: false, deletedAt: null },
    select: {
      id: true,
      name: true,
      stock: true,
      supplier: true,
      supplierId: true,
      supplierRef: { select: { leadTimeDays: true, leadTimeMinDays: true, leadTimeMaxDays: true, name: true, defaultMinOrderQty: true, defaultPackSize: true } },
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
  if (!products.length) {
    return NextResponse.json({ ok: true, message: "No products to recompute" });
  }

  const orderItems = await prisma.orderItem.findMany({
    where: {
      createdAt: { gte: periodStart, lte: periodEnd },
      order: { status: { not: "CANCELLED" } },
      productId: { in: products.map((p) => p.id) },
    },
    select: { productId: true, quantity: true },
  });

  const unitsSoldMap = new Map<string, number>();
  for (const item of orderItems) {
    unitsSoldMap.set(item.productId, (unitsSoldMap.get(item.productId) ?? 0) + item.quantity);
  }

  const plans = await prisma.inventoryPlan.findMany({
    where: { productId: { in: products.map((p) => p.id) } },
  });
  const planMap = new Map(plans.map((plan) => [plan.productId, plan]));

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

  const openOrderItems = await prisma.orderItem.findMany({
    where: {
      productId: { in: products.map((p) => p.id) },
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

  const snapshots: Prisma.DemandSnapshotCreateManyInput[] = [];
  const suggestions: Prisma.RestockSuggestionCreateManyInput[] = [];

  for (const product of products) {
    const unitsSold = unitsSoldMap.get(product.id) ?? 0;
    const avgDaily = unitsSold / periodDays;
    snapshots.push({
      productId: product.id,
      periodStart,
      periodEnd,
      unitsSold,
      avgDailyDemand: new Prisma.Decimal(avgDaily.toFixed(4)),
      source: "orders",
    });

    const plan = planMap.get(product.id);
    const primaryLink =
      product.supplierLinks.find((link) => link.isPrimary) ||
      product.supplierLinks.find((link) => link.supplierId === product.supplierId) ||
      product.supplierLinks[0];
    const nameLeadTime =
      product.supplier && supplierLeadTimeByName.get(product.supplier.toLowerCase());
    const leadTimeDaysRaw =
      plan?.leadTimeDays ?? primaryLink?.leadTimeDays ?? product.supplierRef?.leadTimeDays ?? nameLeadTime ?? 14;
    const leadTimeDays = Number(leadTimeDaysRaw);
    const leadTimeMinDaysRaw = product.supplierRef?.leadTimeMinDays ?? null;
    const leadTimeMaxDaysRaw = product.supplierRef?.leadTimeMaxDays ?? null;
    const leadTimeMinDays = leadTimeMinDaysRaw == null ? null : Number(leadTimeMinDaysRaw);
    const leadTimeMaxDays = leadTimeMaxDaysRaw == null ? null : Number(leadTimeMaxDaysRaw);
    const variabilityDays =
      leadTimeMinDays != null && leadTimeMaxDays != null
        ? Math.max(0, (leadTimeMaxDays - leadTimeMinDays) / 2)
        : 0;
    const reviewPeriodDays = plan?.reviewPeriodDays ?? 60;
    const minOrderQty = plan?.minOrderQty ?? primaryLink?.minOrderQty ?? product.supplierRef?.defaultMinOrderQty ?? 1;
    const packSize = primaryLink?.packSize ?? product.supplierRef?.defaultPackSize ?? 1;
    const fallbackReorderPoint = defaultReorderPoint;
    const autoSafetyStock =
      avgDaily > 0 ? Math.ceil(avgDaily * leadTimeDays * 0.5 + avgDaily * variabilityDays) : 0;
    const autoReorderPoint =
      avgDaily > 0 ? Math.ceil(avgDaily * leadTimeDays) + autoSafetyStock : fallbackReorderPoint;
    const safetyStock = plan?.safetyStock ?? autoSafetyStock;
    const reorderPoint =
      avgDaily <= 0 && plan?.fallbackReorderPoint != null
        ? plan.fallbackReorderPoint
        : plan?.reorderPoint ?? autoReorderPoint;
    const targetStock = plan?.targetStock ?? 0;

    const demandDuringLeadTime = avgDaily * leadTimeDays;
    const onOrder = onOrderMap.get(product.id) ?? 0;
    const reserved = reservedMap.get(product.id) ?? 0;
    const available = product.stock - reserved + onOrder;
    const baseSuggested =
      avgDaily > 0
        ? Math.max(0, safetyStock + demandDuringLeadTime - available)
        : Math.max(0, reorderPoint - available);
    const targetSuggested = targetStock > 0 ? Math.max(0, targetStock - available) : 0;
    const rawSuggested = targetStock > 0 ? Math.max(baseSuggested, targetSuggested) : baseSuggested;
    const packRounded = roundUpToStep(rawSuggested, packSize);
    const suggestedQty = Math.max(packRounded, minOrderQty);
    const shouldSuggest = suggestedQty > 0 && available <= reorderPoint;

    if (shouldSuggest) {
      const reason = [
        `Available ${available} below reorder ${reorderPoint}`,
        `Lead time ${leadTimeDays}d demand ${demandDuringLeadTime.toFixed(2)}`,
        `Review window ${reviewPeriodDays}d`,
      ].join(" · ");
      suggestions.push({
        productId: product.id,
        suggestedQty,
        reason,
        status: "open",
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.demandSnapshot.createMany({ data: snapshots });
    await tx.restockSuggestion.deleteMany({
      where: { status: "open", productId: { in: products.map((p) => p.id) } },
    });
    if (suggestions.length) {
      await tx.restockSuggestion.createMany({ data: suggestions });
    }
  });

  try {
    await recordAuditLog({
      actorId: session ? (session.user as AuthenticatedUser).id : null,
      action: "INVENTORY_PLAN_RECOMPUTE",
      entityType: "INVENTORY_PLANNING",
      entityId: "batch",
      meta: {
        periodDays,
        productCount: products.length,
        snapshotCount: snapshots.length,
        suggestionCount: suggestions.length,
        mode: cronAuth ? "cron" : "manual",
      },
    });
  } catch {
    // best-effort
  }

  await prisma.appSetting.upsert({
    where: { key: "inventoryPlanning.lastRecomputeAt" },
    update: { value: new Date().toISOString() },
    create: { key: "inventoryPlanning.lastRecomputeAt", value: new Date().toISOString() },
  });

  return NextResponse.json({
    ok: true,
    periodDays,
    snapshots: snapshots.length,
    suggestions: suggestions.length,
  });
}
