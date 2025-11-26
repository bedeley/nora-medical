import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { productSchema } from "../route";
import { z } from "zod";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

/**
 * ✅ GET /api/products/[id]
 * Fetch a single product by ID (public)
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const product = await prisma.product.findUnique({ where: { id: params.id } });

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    // ✅ Convert Decimal & Dates to primitives
    const safeProduct = {
      ...product,
      price: Number(product.price),
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
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
  .partial()
  .extend({
    imageUrl: urlOrPath.optional(),
    archived: z.boolean().optional(),
  });

/**
 * ✅ PATCH /api/products/[id]
 * Update a product (admin only)
 */
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);

  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = productUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updateData = parsed.data as Parameters<typeof prisma.product.update>[0]["data"];
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
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);

  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
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

    // Clean up any cart items referencing this product, then delete product
    await prisma.$transaction(async (tx: TxClient) => {
      await tx.cartItem.deleteMany({ where: { productId: params.id } });
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
