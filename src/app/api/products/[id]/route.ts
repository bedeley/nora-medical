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
      price: Number(product.price),
      stock: product.stock,
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
      ...(includePrivate
        ? {
            cost: Number(product.cost),
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
  .omit({ cost: true })
  .partial()
  .extend({
    imageUrl: urlOrPath.optional(),
    archived: z.boolean().optional(),
    category: categorySchema.optional(),
    brand: z.string().min(2, { message: "Brand is required" }).optional(),
    supplier: z.string().min(2, { message: "Supplier is required" }).optional(),
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

    const { editReason, ...rawData } = parsed.data;
    const updateData =
      rawData as Parameters<typeof prisma.product.update>[0]["data"];
    if (
      !editReason &&
      (typeof updateData.name !== "undefined" ||
        typeof updateData.description !== "undefined" ||
        typeof updateData.imageUrl !== "undefined" ||
        typeof updateData.price !== "undefined" ||
        typeof updateData.category !== "undefined" ||
        typeof updateData.brand !== "undefined" ||
        typeof updateData.supplier !== "undefined" ||
        typeof updateData.stock !== "undefined")
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
        category: true,
        brand: true,
        supplier: true,
        createdAt: true,
      },
    });
    const oldStock = Number(existing?.stock ?? 0);
    const oldArchived = Boolean(existing?.archived);
    const oldPrice = Number(existing?.price ?? 0);
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

    const updated = await prisma.product.update({
      where: { id: params.id },
      data: updateData,
    });

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
          meta: {
            name: updated.name,
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
          meta: {
            name: updated.name,
            changes: nonStockChanges,
            reason: editReason || null,
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
    const product = await prisma.product.findUnique({
      where: { id: params.id },
      select: { id: true, name: true, price: true, stock: true },
    });

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    await prisma.$transaction(async (tx: TxClient) => {
      await tx.cartItem.deleteMany({ where: { productId: params.id } });
      await tx.stockAlert.updateMany({
        where: { productId: params.id },
        data: { deletedAt: new Date(), notifiedAt: new Date() },
      });
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
        meta: {
          name: product.name,
          price: Number(product.price),
          stock: product.stock,
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
      select: { id: true, name: true, deletedAt: true, archived: true },
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
        meta: { name: existing.name },
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
