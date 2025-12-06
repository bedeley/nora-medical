import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

/**
 * POST /api/cart/clear
 * Deletes all items for the current user's cart.
 */
export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const userId = (session.user as AuthenticatedUser).id;

    const cart = await prisma.cart.findUnique({ where: { userId } });
    if (!cart) {
      return NextResponse.json({ message: "Cart is already empty" });
    }

    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });

    return NextResponse.json({ message: "Cart cleared successfully" });
  } catch (error) {
    console.error("Error clearing cart:", error);
    return NextResponse.json(
      { error: "Failed to clear cart" },
      { status: 500 }
    );
  }
}
