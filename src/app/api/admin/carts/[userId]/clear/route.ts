import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// POST /api/admin/carts/[userId]/clear — clear a specific user's cart (admin only)
export async function POST(
  _req: Request,
  { params }: { params: { userId: string } }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const userId = params.userId;
    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

    const cart = await prisma.cart.findUnique({ where: { userId } });
    if (!cart) {
      return NextResponse.json({ success: true, message: "Cart already empty" });
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      // Optionally delete the cart record as well to keep things tidy
      await tx.cart.delete({ where: { id: cart.id } });
    });

    return NextResponse.json({ success: true, message: "Cart cleared" });
  } catch (error) {
    console.error("Admin clear cart error:", error);
    return NextResponse.json({ error: "Failed to clear cart" }, { status: 500 });
  }
}
