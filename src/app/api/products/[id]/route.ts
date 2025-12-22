import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { productSchema } from "../route";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { notifyBackInStock } from "@/lib/stock-alerts";

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
      name: product.name,
      description: product.description,
      imageUrl: product.imageUrl,
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

const productUpdateSchema = productSchema
  .omit({ cost: true })
  .partial()
  .extend({
    imageUrl: urlOrPath.optional(),
    archived: z.boolean().optional(),
    editReason: z.string().min(5),
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

  const session = await getServerSession(authOptions);

  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
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
    const existing = await prisma.product.findUnique({
      where: { id: params.id },
      select: { stock: true },
    });
    const oldStock = Number(existing?.stock ?? 0);
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

    try {
      const newStock = Number(updated.stock ?? 0);
      const reason = String(editReason || "").trim().slice(0, 140);
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

  const session = await getServerSession(authOptions);

  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const params = await context.params;
    const product = await prisma.product.findUnique({
      where: { id: params.id },
    });

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    // Prevent deleting products that have been part of any order
    const usage = await prisma.orderItem.count({ where: { productId: params.id } });
    if (usage > 0) {
      return NextResponse.json(
        { error: "Cannot delete product with order history. Set stock to 0 instead." },
        { status: 400 }
      );
    }

    // Clean up related records, then delete product
    await prisma.$transaction(async (tx: TxClient) => {
      await tx.cartItem.deleteMany({ where: { productId: params.id } });
      await tx.inventoryMovement.deleteMany({ where: { productId: params.id } });
      await tx.purchase.deleteMany({ where: { productId: params.id } });
      await tx.stockAlert.deleteMany({ where: { productId: params.id } });
      await tx.product.delete({ where: { id: params.id } });
    });

    return NextResponse.json({ success: true, deletedId: params.id });
  } catch (error) {
    console.error("❌ Error deleting product:", error);
    return NextResponse.json(
      { error: "Failed to delete product" },
      { status: 500 }
    );
  }
}
