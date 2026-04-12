import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { productSchema } from "../route";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { notifyBackInStock } from "@/lib/stock-alerts";
import { recordAuditLog } from "@/lib/audit-log";
import { rateLimit } from "@/lib/rate-limit";
import { PRODUCT_CATEGORIES } from "@/lib/product-categories";
import { getMarginGuardError } from "@/lib/margin-guard";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

/**
 * ✅ GET /api/products/[id]
 * Fetch a single product by ID (public)
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  try {
    const params = await context.params;
    const session = await getServerSession(authOptions);
    const user = session?.user as AuthenticatedUser | undefined;
    const role = user?.role;
    const includePrivate = ["ADMIN", "STAFF", "ACCOUNTANT"].includes(String(role || ""));
    const product = await prisma.product.findUnique({ where: { id: params.id } });

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    if (!includePrivate && product.archived) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    // ✅ Convert Decimal & Dates to primitives
    const safeProduct = {
      id: product.id,
      sku: product.sku ?? null,
      name: product.name,
      description: product.description,
      imageUrl: product.imageUrl,
      category: product.category ?? null,
      brand: product.brand ?? null,
      supplier: product.supplier ?? null,
      supplierId: (product as { supplierId?: string | null }).supplierId ?? null,
      requiresLotTracking: Boolean((product as { requiresLotTracking?: boolean | null }).requiresLotTracking),
      requiresExpiryDate: Boolean((product as { requiresExpiryDate?: boolean | null }).requiresExpiryDate),
      price: Number(product.price),
      stock: product.stock,
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
      ...(includePrivate
        ? {
            cost: Number(product.cost),
            minMarginPct: product.minMarginPct != null ? Number(product.minMarginPct) : null,
            archived: product.archived,
          }
        : {}),
    };

    return new NextResponse(JSON.stringify(safeProduct), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("❌ Error fetching product:", error);
    return NextResponse.json(
      { error: "Failed to fetch product" },
      { status: 500 }
    );
  }
}

/**
 * Partial schema for PATCH (all fields optional)
 * Accept absolute URLs or site-relative paths for imageUrl.
 */
const urlOrPath = z
  .string()
  .refine(
    (val) => {
      try {
        new URL(val);
        return true;
      } catch {
        return typeof val === "string" && val.startsWith("/");
      }
    },
    { message: "Invalid image URL or path" }
  );

const categorySchema = z.preprocess(
  (val) => (val == null ? "" : String(val)),
  z
    .string()
    .min(1, { message: "You must select a category." })
    .refine(
      (value) => PRODUCT_CATEGORIES.includes(value as (typeof PRODUCT_CATEGORIES)[number]),
      { message: "Please select a valid category." }
    )
);

const productUpdateSchema = productSchema
  .omit({ cost: true, receiveNow: true, paidOnReceipt: true, paymentMethod: true })
  .partial()
  .extend({
    imageUrl: urlOrPath.optional(),
    archived: z.boolean().optional(),
    category: categorySchema.optional(),
    brand: z.string().min(2, { message: "Brand is required" }).optional(),
    supplier: z.string().min(2, { message: "Supplier is required" }).optional(),
    supplierId: z.string().optional().nullable(),
    marginOverrideReason: z.string().min(5).optional(),
    requiresLotTracking: z.boolean().optional(),
    requiresExpiryDate: z.boolean().optional(),
    editReason: z.string().min(5).optional(),
  });

/**
 * ✅ PATCH /api/products/[id]
 * Update a product (admin only)
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  if (!assertSameOrigin(request)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(request, "admin-product-update", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await getServerSession(authOptions);

  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");
  const isAdmin = role === "ADMIN";
  const canEdit = ["ADMIN", "STAFF", "ACCOUNTANT"].includes(role);
  if (!session || !canEdit) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const body = await request.json();
    const parsed = productUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { editReason, marginOverrideReason, ...rawData } = parsed.data;
    const updateData =
      rawData as Parameters<typeof prisma.product.update>[0]["data"];
    if (typeof updateData.requiresExpiryDate !== "undefined") {
      updateData.requiresLotTracking =
        Boolean(updateData.requiresLotTracking) || Boolean(updateData.requiresExpiryDate);
    }
    if (typeof updateData.supplierId !== "undefined") {
      let supplierId = updateData.supplierId as string | null;
      if (supplierId) {
        const supplier = await prisma.supplier.findUnique({
          where: { id: supplierId },
          select: { name: true },
        });
        if (supplier?.name) {
          updateData.supplier = supplier.name;
        } else {
          supplierId = null;
        }
      }
      updateData.supplierId = supplierId;
    }
    if (!updateData.supplierId && typeof updateData.supplier === "string") {
      const supplierName = updateData.supplier.trim();
      if (supplierName) {
        const supplier = await prisma.supplier.upsert({
          where: { name: supplierName },
          create: { name: supplierName },
          update: {},
          select: { id: true },
        });
        updateData.supplierId = supplier.id;
        updateData.supplier = supplierName;
      }
    }
    if (
      !editReason &&
      (typeof updateData.name !== "undefined" ||
        typeof updateData.description !== "undefined" ||
        typeof updateData.imageUrl !== "undefined" ||
        typeof updateData.price !== "undefined" ||
        typeof updateData.minMarginPct !== "undefined" ||
        typeof updateData.category !== "undefined" ||
        typeof updateData.brand !== "undefined" ||
        typeof updateData.supplier !== "undefined" ||
        typeof updateData.stock !== "undefined" ||
        typeof updateData.archived !== "undefined" ||
        typeof updateData.requiresLotTracking !== "undefined" ||
        typeof updateData.requiresExpiryDate !== "undefined")
    ) {
      return NextResponse.json(
        { error: "Please add a brief reason for this change." },
        { status: 400 },
      );
    }
    const existing = await prisma.product.findUnique({
      where: { id: params.id },
      select: {
        stock: true,
        archived: true,
        name: true,
        description: true,
        imageUrl: true,
        price: true,
        cost: true,
        minMarginPct: true,
        category: true,
        brand: true,
        supplier: true,
        supplierId: true,
        createdAt: true,
        requiresLotTracking: true,
        requiresExpiryDate: true,
      },
    });
    const supplierChanging =
      (typeof updateData.supplierId !== "undefined" && updateData.supplierId !== existing?.supplierId) ||
      (typeof updateData.supplier !== "undefined" && updateData.supplier !== existing?.supplier);
    if (supplierChanging && !isAdmin) {
      return NextResponse.json(
        { error: "Supplier changes require admin approval." },
        { status: 403 },
      );
    }
    const nextSupplierId =
      typeof updateData.supplierId !== "undefined" ? updateData.supplierId : existing?.supplierId ?? null;
    const nextSupplier =
      typeof updateData.supplier !== "undefined" ? updateData.supplier : existing?.supplier ?? null;
    if (!nextSupplierId && !nextSupplier) {
      return NextResponse.json(
        { error: "Supplier is required." },
        { status: 400 },
      );
    }
    const oldStock = Number(existing?.stock ?? 0);
    const oldArchived = Boolean(existing?.archived);
    const oldPrice = Number(existing?.price ?? 0);
    const oldCost = Number(existing?.cost ?? 0);
    const priceChanging =
      typeof updateData.price !== "undefined" && Number(updateData.price) !== oldPrice;
    const stockChanging =
      typeof updateData.stock !== "undefined" && Number(updateData.stock) !== oldStock;
    if (!isAdmin && (priceChanging || stockChanging)) {
      const ageMs = Date.now() - new Date(existing?.createdAt ?? 0).getTime();
      const limitMs = 48 * 60 * 60 * 1000;
      if (ageMs > limitMs) {
        return NextResponse.json(
          { error: "Price/stock edits are locked after 48 hours for non-admin roles." },
          { status: 403 }
        );
      }
    }
    if (updateData.archived === true) {
      const stockToCheck =
        typeof updateData.stock !== "undefined"
          ? Number(updateData.stock)
          : oldStock;
      if (Number(stockToCheck || 0) > 0) {
        return NextResponse.json(
          { error: "Cannot archive a product with stock greater than 0." },
          { status: 400 },
        );
      }
    }
    const nextPrice =
      typeof updateData.price !== "undefined" ? Number(updateData.price) : oldPrice;
    const nextMinMargin =
      typeof updateData.minMarginPct !== "undefined"
        ? updateData.minMarginPct == null
          ? null
          : Number(updateData.minMarginPct)
        : existing?.minMarginPct != null
        ? Number(existing.minMarginPct)
        : null;
    const marginError = getMarginGuardError({
      price: nextPrice,
      cost: oldCost,
      minMarginPct: nextMinMargin,
    });
    if (marginError) {
      const reason = marginOverrideReason?.trim();
      if (!isAdmin || !reason || reason.length < 5) {
        return NextResponse.json({ error: marginError }, { status: 400 });
      }
    }

    if (
      stockChanging &&
      typeof updateData.stock !== "undefined" &&
      oldStock > 0 &&
      Number(updateData.stock) <= 0
    ) {
      updateData.lastStockoutAt = new Date();
    }

    const updated = await prisma.product.update({
      where: { id: params.id },
      data: updateData,
    });

    if (supplierChanging) {
      const nextSupplierId = (updated as { supplierId?: string | null }).supplierId ?? null;
      if (nextSupplierId) {
        try {
          await prisma.$transaction(async (tx: TxClient) => {
            await tx.productSupplier.updateMany({
              where: { productId: updated.id },
              data: { isPrimary: false },
            });
            await tx.productSupplier.upsert({
              where: { productId_supplierId: { productId: updated.id, supplierId: nextSupplierId } },
              create: {
                productId: updated.id,
                supplierId: nextSupplierId,
                isPrimary: true,
              },
              update: { isPrimary: true },
            });
          });
        } catch (e) {
          console.warn("Failed to update product supplier link", updated.id, e);
        }
      }
    }

    const safeProduct = {
      ...updated,
      price: Number(updated.price),
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };

    const newStock = Number(updated.stock ?? 0);
    const reason = String(editReason || "").trim().slice(0, 140);

    try {
      if (typeof updateData.stock !== "undefined") {
        const delta = newStock - oldStock;
        if (delta !== 0) {
          await prisma.inventoryMovement.create({
            data: {
              productId: updated.id,
              delta,
              reason: `ADJUSTMENT: ${reason || "Admin update"}`,
            },
          });
        }
      }
      if (typeof updateData.stock !== "undefined" && oldStock <= 0 && newStock > 0) {
        await notifyBackInStock(updated.id);
      }
    } catch (e) {
      console.warn("Back-in-stock notification error:", e);
    }

    try {
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const nonStockChanges: Record<string, { from: unknown; to: unknown }> = {};
      if (typeof updateData.name !== "undefined" && updateData.name !== existing?.name) {
        changes.name = { from: existing?.name ?? null, to: updated.name };
        nonStockChanges.name = changes.name;
      }
      if (typeof updateData.description !== "undefined" && updateData.description !== existing?.description) {
        changes.description = { from: existing?.description ?? null, to: updated.description };
        nonStockChanges.description = changes.description;
      }
      if (typeof updateData.imageUrl !== "undefined" && updateData.imageUrl !== existing?.imageUrl) {
        changes.imageUrl = { from: existing?.imageUrl ?? null, to: updated.imageUrl };
        nonStockChanges.imageUrl = changes.imageUrl;
      }
      if (typeof updateData.price !== "undefined" && Number(updateData.price) !== oldPrice) {
        changes.price = { from: oldPrice, to: Number(updated.price) };
        nonStockChanges.price = changes.price;
      }
      if (typeof updateData.category !== "undefined" && updateData.category !== existing?.category) {
        changes.category = { from: existing?.category ?? null, to: updated.category ?? null };
        nonStockChanges.category = changes.category;
      }
      if (typeof updateData.brand !== "undefined" && updateData.brand !== existing?.brand) {
        changes.brand = { from: existing?.brand ?? null, to: updated.brand ?? null };
        nonStockChanges.brand = changes.brand;
      }
      const oldMinMarginPct =
        existing?.minMarginPct != null ? Number(existing.minMarginPct) : null;
      const updatedMinMarginPct =
        updated.minMarginPct != null ? Number(updated.minMarginPct) : null;
      if (typeof updateData.minMarginPct !== "undefined" && updatedMinMarginPct !== oldMinMarginPct) {
        changes.minMarginPct = { from: oldMinMarginPct, to: updatedMinMarginPct };
        nonStockChanges.minMarginPct = changes.minMarginPct;
      }
      if (typeof updateData.requiresLotTracking !== "undefined" && Boolean(updateData.requiresLotTracking) !== Boolean(existing?.requiresLotTracking)) {
        changes.requiresLotTracking = { from: Boolean(existing?.requiresLotTracking), to: Boolean(updated.requiresLotTracking) };
        nonStockChanges.requiresLotTracking = changes.requiresLotTracking;
      }
      if (typeof updateData.requiresExpiryDate !== "undefined" && Boolean(updateData.requiresExpiryDate) !== Boolean(existing?.requiresExpiryDate)) {
        changes.requiresExpiryDate = { from: Boolean(existing?.requiresExpiryDate), to: Boolean(updated.requiresExpiryDate) };
        nonStockChanges.requiresExpiryDate = changes.requiresExpiryDate;
      }
      if (typeof updateData.supplier !== "undefined" && updateData.supplier !== existing?.supplier) {
        changes.supplier = { from: existing?.supplier ?? null, to: updated.supplier ?? null };
        nonStockChanges.supplier = changes.supplier;
      }
      if (typeof updateData.stock !== "undefined" && newStock !== oldStock) {
        changes.stock = { from: oldStock, to: newStock };
      }
      if (typeof updateData.archived !== "undefined" && updated.archived !== oldArchived) {
        changes.archived = { from: oldArchived, to: Boolean(updated.archived) };
        nonStockChanges.archived = changes.archived;
      }
      if (changes.stock) {
        await recordAuditLog({
          actorId: user?.id,
          action: "PRODUCT_STOCK_UPDATE",
          entityType: "PRODUCT",
          entityId: updated.id,
          request,
          meta: {
            name: updated.name,
            sku: updated.sku ?? null,
            from: oldStock,
            to: newStock,
            delta: newStock - oldStock,
            reason: editReason || null,
          },
        });
      }
      if (Object.keys(nonStockChanges).length > 0) {
        await recordAuditLog({
          actorId: user?.id,
          action: "PRODUCT_UPDATE",
          entityType: "PRODUCT",
          entityId: updated.id,
          request,
          meta: {
            name: updated.name,
            sku: updated.sku ?? null,
            changes: nonStockChanges,
            reason: editReason || null,
          },
        });
      }
      const reason = marginOverrideReason?.trim();
      if (marginError && reason) {
        await recordAuditLog({
          actorId: user?.id,
          action: "PRICE_MARGIN_OVERRIDE",
          entityType: "PRODUCT",
          entityId: updated.id,
          request,
          meta: {
            name: updated.name,
            sku: updated.sku ?? null,
            reason,
            price: Number(updated.price),
            cost: Number(updated.cost),
            minMarginPct: updateData.minMarginPct ?? null,
          },
        });
      }
    } catch {
      // best-effort audit logging
    }

    return NextResponse.json({ success: true, data: safeProduct });
  } catch (error) {
    console.error("❌ Error updating product:", error);
    return NextResponse.json(
      { error: "Failed to update product" },
      { status: 500 }
    );
  }
}

/**
 * ✅ DELETE /api/products/[id]
 * Remove a product (admin only)
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  if (!assertSameOrigin(request)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(request, "admin-product-delete", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await getServerSession(authOptions);

  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const requestBody = (await request.json().catch(() => ({}))) as { reason?: unknown; note?: unknown };
    const deleteReason = String(requestBody.reason || requestBody.note || "").trim().slice(0, 280);
    if (deleteReason.length < 5) {
      return NextResponse.json(
        { error: "Please provide a brief delete reason." },
        { status: 400 },
      );
    }
    const product = await prisma.product.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        name: true,
        sku: true,
        category: true,
        brand: true,
        supplier: true,
        supplierId: true,
        price: true,
        cost: true,
        stock: true,
        archived: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    let removedCartItems = 0;
    let updatedStockAlerts = 0;
    let softDeletedDraftPurchases = 0;
    let orderHistoryCount = 0;
    await prisma.$transaction(async (tx: TxClient) => {
      const cartDeleteResult = await tx.cartItem.deleteMany({ where: { productId: params.id } });
      removedCartItems = cartDeleteResult.count;
      const stockAlertResult = await tx.stockAlert.updateMany({
        where: { productId: params.id },
        data: { deletedAt: new Date(), notifiedAt: new Date() },
      });
      updatedStockAlerts = stockAlertResult.count;
      orderHistoryCount = await tx.orderItem.count({
        where: { productId: params.id },
      });
      if (orderHistoryCount === 0) {
        const purgeCandidates = await tx.purchase.findMany({
          where: {
            productId: params.id,
            deletedAt: null,
            receivedQuantity: { lte: 0 },
            status: { in: ["PENDING_APPROVAL", "APPROVED", "ORDERED", "CANCELLED"] },
            movements: { none: {} },
            lots: { none: {} },
            supplierPayments: { none: {} },
          },
          select: { id: true },
        });
        if (purgeCandidates.length > 0) {
          const purgeResult = await tx.purchase.updateMany({
            where: { id: { in: purgeCandidates.map((p) => p.id) } },
            data: { deletedAt: new Date() },
          });
          softDeletedDraftPurchases = purgeResult.count;
        }
      }
      const currentStock = Number(product.stock || 0);
      if (currentStock > 0) {
        await tx.inventoryMovement.create({
          data: {
            productId: params.id,
            delta: -currentStock,
            reason: "DELETE",
          },
        });
      }
      await tx.product.update({
        where: { id: params.id },
        data: { deletedAt: new Date(), archived: true, stock: 0 },
      });
    });

    try {
      await recordAuditLog({
        actorId: user?.id,
        action: "PRODUCT_DELETE",
        entityType: "PRODUCT",
        entityId: product.id,
        request,
        meta: {
          name: product.name,
          sku: product.sku ?? null,
          category: product.category ?? null,
          brand: product.brand ?? null,
          supplier: product.supplier ?? null,
          supplierId: product.supplierId ?? null,
          price: Number(product.price),
          cost: Number(product.cost),
          stock: product.stock,
          archivedBeforeDelete: Boolean(product.archived),
          removedCartItems,
          updatedStockAlerts,
          orderHistoryCount,
          softDeletedDraftPurchases,
          deletedAt: new Date().toISOString(),
          productCreatedAt: product.createdAt.toISOString(),
          productUpdatedAt: product.updatedAt.toISOString(),
          deleteReason: deleteReason || null,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ success: true, deletedId: params.id });
  } catch (error) {
    console.error("❌ Error deleting product:", error);
    return NextResponse.json(
      { error: "Failed to delete product" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  if (!assertSameOrigin(request)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(request, "admin-product-restore", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const existing = await prisma.product.findUnique({
      where: { id: params.id },
      select: { id: true, name: true, sku: true, deletedAt: true, archived: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    if (!existing.deletedAt && !existing.archived) {
      return NextResponse.json({ error: "Product is not deleted" }, { status: 400 });
    }

    await prisma.$transaction(async (tx: TxClient) => {
      await tx.product.update({
        where: { id: params.id },
        data: { deletedAt: null, archived: false },
      });
      await tx.stockAlert.updateMany({
        where: { productId: params.id },
        data: { deletedAt: null, notifiedAt: null },
      });
    });

    try {
      await recordAuditLog({
        actorId: user?.id,
        action: "PRODUCT_RESTORE",
        entityType: "PRODUCT",
        entityId: existing.id,
        request,
        meta: {
          name: existing.name,
          sku: existing.sku ?? null,
          previouslyArchived: Boolean(existing.archived),
          restoreSource: "product-delete-undo",
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ success: true, restoredId: params.id });
  } catch (error) {
    console.error("❌ Error restoring product:", error);
    return NextResponse.json(
      { error: "Failed to restore product" },
      { status: 500 }
    );
  }
}
