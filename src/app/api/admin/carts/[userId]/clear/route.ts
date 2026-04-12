import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/admin/carts/[userId]/clear — clear a specific user's cart (admin only)
export async function POST(
  req: Request,
  context: { params: Promise<{ userId: string }> | { userId: string } }
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as AuthenticatedUser;
  const role = user.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!isAdmin && !isStaff) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-cart-clear", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const params = await context.params;
    const userId = params.userId;
    if (!userId) {
      return NextResponse.json({ error: "Missing userId" }, { status: 400 });
    }

    const [cart, customer] = await Promise.all([
      prisma.cart.findUnique({
        where: { userId },
        include: { items: { select: { id: true, quantity: true } } },
      }),
      prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } }),
    ]);
    if (!cart) {
      return NextResponse.json({ success: true, message: "Cart already empty" });
    }

    const itemCount = cart.items.length;
    const totalQty = cart.items.reduce((s, i) => s + i.quantity, 0);

    await prisma.$transaction([
      prisma.cartItem.deleteMany({ where: { cartId: cart.id } }),
      // Optionally delete the cart record as well to keep things tidy
      prisma.cart.delete({ where: { id: cart.id } }),
    ]);

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "CART_CLEAR",
        entityType: "CART",
        entityId: cart.id,
        request: req,
        outcome: "SUCCESS",
        meta: {
          customerId: userId,
          customerEmail: customer?.email ?? null,
          customerName: customer?.name ?? null,
          uniqueItemCount: itemCount,
          totalQuantity: totalQty,
          sourcePage: "admin/customers",
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ success: true, message: "Cart cleared" });
  } catch (error) {
    console.error("Admin clear cart error:", error);
    return NextResponse.json({ error: "Failed to clear cart" }, { status: 500 });
  }
}
