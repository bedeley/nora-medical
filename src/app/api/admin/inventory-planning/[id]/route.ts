import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import {
  computeInventoryPlanning,
  type InventoryPlanningPlanInput,
} from "@/lib/inventory-planning";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

function getSourcePage(req: Request, fallback: string) {
  const value = String(new URL(req.url).searchParams.get("sourcePage") || "").trim();
  return value || fallback;
}

const patchSchema = z.object({
  reorderPoint: z.number().int().min(0).optional(),
  fallbackReorderPoint: z.number().int().min(0).optional().nullable(),
  safetyStock: z.number().int().min(0).optional(),
  leadTimeDays: z.number().int().min(1).max(365).optional(),
  reviewPeriodDays: z.number().int().min(1).max(365).optional(),
  minOrderQty: z.number().int().min(1).optional(),
  approvalThresholdQty: z.number().int().min(1).optional().nullable(),
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
  const autoMinOrderQty = primaryLink?.minOrderQty ?? product.supplierRef?.defaultMinOrderQty ?? 1;
  const autoPackSize = primaryLink?.packSize ?? product.supplierRef?.defaultPackSize ?? 1;
  const plan = product.inventoryPlan as InventoryPlanningPlanInput | null;
  const computed = computeInventoryPlanning({
    stock: product.stock,
    reserved,
    onOrder,
    avgDailyDemand,
    defaultReorderPoint: await getDefaultReorderPoint(),
    supplierLeadTimeDays: autoLeadTime,
    leadTimeVariabilityDays: variabilityDays,
    autoMinOrderQty,
    autoPackSize,
    plan,
  });

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
      available: computed.available,
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
      effectivePlan: computed.effectivePlan,
      planSource: plan ? "manual" : "auto",
      demand: snapshot
        ? {
            periodStart: snapshot.periodStart.toISOString(),
            periodEnd: snapshot.periodEnd.toISOString(),
            capturedAt: snapshot.createdAt.toISOString(),
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
        : computed.shouldSuggest
        ? {
            id: null,
            suggestedQty: computed.suggestedQty,
            reason: computed.reason,
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
  const sourcePage = getSourcePage(req, "admin/inventory-planning/[id]");
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
      select: {
        id: true,
        name: true,
        inventoryPlan: {
          select: {
            reorderPoint: true,
            fallbackReorderPoint: true,
            safetyStock: true,
            leadTimeDays: true,
            reviewPeriodDays: true,
            minOrderQty: true,
            approvalThresholdQty: true,
            targetStock: true,
            notes: true,
          },
        },
      },
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
      const previousPlan = product.inventoryPlan;
      const nextPlanSnapshot = {
        reorderPoint: plan.reorderPoint,
        fallbackReorderPoint: plan.fallbackReorderPoint,
        safetyStock: plan.safetyStock,
        leadTimeDays: plan.leadTimeDays,
        reviewPeriodDays: plan.reviewPeriodDays,
        minOrderQty: plan.minOrderQty,
        approvalThresholdQty: plan.approvalThresholdQty,
        targetStock: plan.targetStock,
        notes: plan.notes,
      };
      const changedFields = Object.keys(nextPlanSnapshot).filter((key) => {
        const previousValue = previousPlan ? (previousPlan as Record<string, unknown>)[key] ?? null : null;
        const nextValue = (nextPlanSnapshot as Record<string, unknown>)[key] ?? null;
        return JSON.stringify(previousValue) !== JSON.stringify(nextValue);
      });
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: "INVENTORY_PLAN_UPDATE",
        entityType: "PRODUCT",
        entityId: product.id,
        request: req,
        meta: {
          planId: plan.id,
          name: product.name,
          sourcePage,
          changedFields,
          previousPlan: previousPlan
            ? {
                reorderPoint: previousPlan.reorderPoint,
                fallbackReorderPoint: previousPlan.fallbackReorderPoint,
                safetyStock: previousPlan.safetyStock,
                leadTimeDays: previousPlan.leadTimeDays,
                reviewPeriodDays: previousPlan.reviewPeriodDays,
                minOrderQty: previousPlan.minOrderQty,
                approvalThresholdQty: previousPlan.approvalThresholdQty,
                targetStock: previousPlan.targetStock,
              }
            : null,
          updatedPlan: nextPlanSnapshot,
          resultSummary: `Updated inventory plan for ${product.name}.`,
        },
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

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const sourcePage = getSourcePage(req, "admin/inventory-planning/[id]");
  const session = await getServerSession(authOptions);
  if (!session || !canEdit(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-inventory-plan-reset", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const product = await prisma.product.findUnique({
      where: { id: resolvedParams.id },
      select: {
        id: true,
        name: true,
        inventoryPlan: {
          select: {
            id: true,
            reorderPoint: true,
            fallbackReorderPoint: true,
            safetyStock: true,
            leadTimeDays: true,
            reviewPeriodDays: true,
            minOrderQty: true,
            approvalThresholdQty: true,
            targetStock: true,
            notes: true,
          },
        },
      },
    });
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    if (!product.inventoryPlan) {
      return NextResponse.json({ ok: true, reset: false, message: "Plan already uses auto mode." });
    }

    const previousPlan = product.inventoryPlan;
    await prisma.inventoryPlan.delete({
      where: { productId: product.id },
    });

    try {
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: "INVENTORY_PLAN_RESET",
        entityType: "PRODUCT",
        entityId: product.id,
        request: req,
        meta: {
          sourcePage,
          previousPlan: {
            reorderPoint: previousPlan.reorderPoint,
            fallbackReorderPoint: previousPlan.fallbackReorderPoint,
            safetyStock: previousPlan.safetyStock,
            leadTimeDays: previousPlan.leadTimeDays,
            reviewPeriodDays: previousPlan.reviewPeriodDays,
            minOrderQty: previousPlan.minOrderQty,
            approvalThresholdQty: previousPlan.approvalThresholdQty,
            targetStock: previousPlan.targetStock,
            notes: previousPlan.notes,
          },
          resultSummary: `Reset inventory plan for ${product.name} to auto mode.`,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ ok: true, reset: true });
  } catch (error) {
    console.error("Inventory plan reset error:", error);
    return NextResponse.json({ error: "Failed to reset inventory plan" }, { status: 500 });
  }
}
