import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";

/**
 * 🧾 Zod schema for cart item input
 */
const cartItemSchema = z.object({
  // Product ids are Prisma cuid(), not UUID
  productId: z.string().cuid().or(z.string().min(1)),
  quantity: z
    .union([z.number(), z.string()])
    .transform((v) => Number(v))
    .refine((v) => Number.isInteger(v) && v > 0 && v <= 100, {
      message: "Invalid quantity",
    })
    .default(1),
});

/**
 * ✅ GET /api/cart
 * Fetch the current user's cart with product details
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ items: [], total: 0 });
  }

  const userId = (session.user as AuthenticatedUser).id;

  try {
    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: { product: true },
          orderBy: { updatedAt: "desc" }, // most recently updated items first
        },
      },
    });

    if (!cart) return NextResponse.json({ items: [], total: 0 });

    const items = cart.items.map((item: {
      id: string;
      quantity: number;
      product: { id: string; name: string; imageUrl: string | null; price: unknown; stock: number };
      updatedAt?: unknown;
    }) => {
      const updatedAtRaw = (item as { updatedAt?: unknown }).updatedAt;
      const updatedAt =
        typeof updatedAtRaw === "string"
          ? updatedAtRaw
          : updatedAtRaw && typeof (updatedAtRaw as { toISOString?: () => string }).toISOString === "function"
          ? (updatedAtRaw as { toISOString: () => string }).toISOString()
          : null;

      return {
        id: item.id,
        quantity: item.quantity,
        updatedAt,
        product: {
          id: item.product.id,
          name: item.product.name,
          imageUrl: item.product.imageUrl,
          price: Number(item.product.price),
          stock: item.product.stock,
        },
      };
    });

    const total = items.reduce(
      (sum: number, item: { quantity: number; product: { price: number } }) => sum + item.quantity * item.product.price,
      0
    );

    return NextResponse.json({ items, total });
  } catch (error) {
    console.error("Error fetching cart:", error);
    return NextResponse.json(
      { error: "Failed to fetch cart" },
      { status: 500 }
    );
  }
}

/**
 * ✅ POST /api/cart
 * Add an item to the cart or increment existing quantity
 */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const userId = (session.user as AuthenticatedUser).id;

  try {
    const body = await req.json();
    const parsed = cartItemSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { productId, quantity } = parsed.data;

    // Ensure product exists
    const product = await prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    const cart = await prisma.cart.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });

    // Merge or create cart item
    await prisma.cartItem.upsert({
      where: {
        cartId_productId: {
          cartId: cart.id,
          productId,
        },
      },
      update: {
        quantity: { increment: quantity },
      },
      create: {
        cartId: cart.id,
        productId,
        quantity,
      },
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    console.error("Error adding item to cart:", error);
    return NextResponse.json(
      { error: "Failed to add item to cart" },
      { status: 500 }
    );
  }
}

/**
 * ✅ PATCH /api/cart
 * Update item quantity
 */
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const userId = (session.user as AuthenticatedUser).id;

  try {
    const body = await req.json();
    const parsed = cartItemSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { productId, quantity } = parsed.data;

    const cart = await prisma.cart.findUnique({
      where: { userId },
      include: { items: true },
    });

    if (!cart) {
      return NextResponse.json({ error: "Cart not found" }, { status: 404 });
    }

    const item = cart.items.find((i) => i.productId === productId);
    if (!item) {
      return NextResponse.json({ error: "Item not in cart" }, { status: 404 });
    }

    await prisma.cartItem.update({
      where: { id: item.id },
      data: { quantity },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error updating cart item:", error);
    return NextResponse.json(
      { error: "Failed to update cart" },
      { status: 500 }
    );
  }
}

/**
 * ✅ DELETE /api/cart
 * Clear the user's cart completely
 */
export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const userId = (session.user as AuthenticatedUser).id;

  try {
    await prisma.cart.deleteMany({ where: { userId } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error clearing cart:", error);
    return NextResponse.json(
      { error: "Failed to clear cart" },
      { status: 500 }
    );
  }
}
