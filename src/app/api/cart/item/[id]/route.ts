import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";

/**
 * 🧾 Schema for updating quantity
 */
const updateQuantitySchema = z.object({
  quantity: z
    .number()
    .int()
    .positive("Quantity must be positive")
    .max(100, "Quantity too large"),
});

/**
 * ✅ PATCH /api/cart/item/[id]
 * Update a specific item's quantity
 */
export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const parsed = updateQuantitySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid quantity", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const params = await context.params;
    const itemId = params.id;
    const userId = (session.user as AuthenticatedUser).id;
    const item = await prisma.cartItem.findFirst({
      where: { id: itemId, cart: { userId } },
    });
    if (!item) {
      return NextResponse.json(
        { error: "Cart item not found" },
        { status: 404 }
      );
    }

    const result = await prisma.cartItem.updateMany({
      where: { id: itemId, cart: { userId } },
      data: { quantity: parsed.data.quantity },
    });
    if (result.count !== 1) {
      return NextResponse.json({ error: "Update failed" }, { status: 409 });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Error updating cart item:", error);
    return NextResponse.json(
      { error: "Failed to update item" },
      { status: 500 }
    );
  }
}

/**
 * ✅ DELETE /api/cart/item/[id]
 * Remove a specific item from the user's cart
 */
export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const params = await context.params;
    const itemId = params.id;
    const userId = (session.user as AuthenticatedUser).id;
    const existing = await prisma.cartItem.findFirst({
      where: { id: itemId, cart: { userId } },
    });
    if (!existing) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    const result = await prisma.cartItem.deleteMany({ where: { id: itemId, cart: { userId } } });
    if (result.count !== 1) {
      return NextResponse.json({ error: "Delete failed" }, { status: 409 });
    }

    return NextResponse.json({ success: true, deletedId: itemId });
  } catch (error) {
    console.error("Error deleting cart item:", error);
    return NextResponse.json(
      { error: "Failed to delete cart item" },
      { status: 500 }
    );
  }
}
