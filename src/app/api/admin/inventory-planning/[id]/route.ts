import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

const patchSchema = z.object({
  reorderPoint: z.number().int().min(0).optional(),
  fallbackReorderPoint: z.number().int().min(0).optional(),
  safetyStock: z.number().int().min(0).optional(),
  leadTimeDays: z.number().int().min(1).max(365).optional(),
  reviewPeriodDays: z.number().int().min(1).max(365).optional(),
  minOrderQty: z.number().int().min(1).optional(),
  approvalThresholdQty: z.number().int().min(1).optional(),
  targetStock: z.number().int().min(0).optional(),
  notes: z.string().max(500).optional().nullable(),
});

function canView(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT" || role === "STAFF";
}

function canEdit(user?: AuthenticatedUser | null) {
  return user?.role === "ADMIN";
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

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const session = await getServerSession(authOptions);
  if (!session || !canView(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-inventory-plan-detail", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const product = await prisma.product.findUnique({
    where: { id: resolvedParams.id, deletedAt: null },
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
  });
  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  const supplierLeadTimes = await prisma.supplier.findMany({
    select: { name: true, leadTimeDays: true },
  });
  const supplierLeadTimeByName = new Map(
    supplierLeadTimes.map((s) => [s.name.toLowerCase(), s.leadTimeDays]),
  );

  const purchases = await prisma.purchase.findMany({
    where: {
      productId: product.id,
      deletedAt: null,
      status: { in: ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"] },
    },
    select: { quantity: true, orderedQuantity: true, receivedQuantity: true },
  });
  const onOrder = purchases.reduce((sum, p) => {
    const ordered = Number(p.orderedQuantity ?? p.quantity);
    const received = Number(p.receivedQuantity ?? 0);
    return sum + Math.max(0, ordered - received);
  }, 0);

  const openItems = await prisma.orderItem.findMany({
    where: {
      productId: product.id,
      order: { status: { not: "CANCELLED" }, deletedAt: null },
    },
    select: { quantity: true, deliveredQuantity: true, returnedQuantity: true },
  });
  const reserved = openItems.reduce((sum, item) => {
    const delivered = Number(item.deliveredQuantity ?? 0);
    const returned = Number(item.returnedQuantity ?? 0);
    return sum + Math.max(0, item.quantity - delivered - returned);
  }, 0);

  const snapshot = await prisma.demandSnapshot.findFirst({
    where: { productId: product.id },
    orderBy: { createdAt: "desc" },
  });
  const suggestion = await prisma.restockSuggestion.findFirst({
    where: { status: "open", productId: product.id },
    orderBy: { createdAt: "desc" },
  });

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
  const fallbackReorderPoint = await getDefaultReorderPoint();
  const autoSafetyStock =
    avgDailyDemand > 0 ? Math.ceil(avgDailyDemand * autoLeadTime * 0.5 + avgDailyDemand * variabilityDays) : 0;
  const autoReorderPoint =
    avgDailyDemand > 0 ? Math.ceil(avgDailyDemand * autoLeadTime) + autoSafetyStock : fallbackReorderPoint;
  const autoMinOrderQty = primaryLink?.minOrderQty ?? product.supplierRef?.defaultMinOrderQty ?? 1;
  const autoPackSize = primaryLink?.packSize ?? product.supplierRef?.defaultPackSize ?? 1;
  const available = product.stock - reserved + onOrder;
  const plan = product.inventoryPlan;
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

  return NextResponse.json({
    row: {
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
    },
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const session = await getServerSession(authOptions);
  if (!session || !canEdit(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-inventory-plan-update", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const product = await prisma.product.findUnique({
      where: { id: resolvedParams.id },
      select: { id: true, name: true },
    });
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    const plan = await prisma.inventoryPlan.upsert({
      where: { productId: product.id },
      create: {
        productId: product.id,
        reorderPoint: parsed.data.reorderPoint ?? 0,
        fallbackReorderPoint: parsed.data.fallbackReorderPoint ?? null,
        safetyStock: parsed.data.safetyStock ?? 0,
        leadTimeDays: parsed.data.leadTimeDays ?? 14,
        reviewPeriodDays: parsed.data.reviewPeriodDays ?? 60,
        minOrderQty: parsed.data.minOrderQty ?? 1,
        approvalThresholdQty: parsed.data.approvalThresholdQty ?? null,
        targetStock: parsed.data.targetStock ?? 0,
        notes: parsed.data.notes ?? null,
        updatedBy: (session.user as AuthenticatedUser).id,
      },
      update: {
        ...parsed.data,
        updatedBy: (session.user as AuthenticatedUser).id,
      },
    });

    try {
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: "INVENTORY_PLAN_UPDATE",
        entityType: "PRODUCT",
        entityId: product.id,
        meta: { planId: plan.id, name: product.name },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json(plan);
  } catch (error) {
    console.error("Inventory plan update error:", error);
    return NextResponse.json({ error: "Failed to update inventory plan" }, { status: 500 });
  }
}
