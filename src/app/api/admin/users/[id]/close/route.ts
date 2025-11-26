import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN")
    return new Response("Forbidden", { status: 403 });
  if (!assertSameOrigin(req)) return new Response("Bad origin", { status: 403 });
  const userId = params.id;
  // Prevent hard delete if user has real business history (orders or payments).
  // Allow deletion of brand-new / unused accounts even if a cart or balance row exists.
  const [orders, payments] = await Promise.all([
    prisma.order.count({ where: { userId } }),
    prisma.payment.count({ where: { userId } }),
  ]);
  if (orders > 0 || payments > 0) {
    return new Response(
      JSON.stringify({
        error:
          "User has order/payment history; deletion blocked. Set role to CUSTOMER and remove access instead.",
      }),
      { status: 400 }
    );
  }

  await prisma.$transaction(async (tx) => {
    const carts = await tx.cart.findMany({ where: { userId }, select: { id: true } });
    const cartIds = carts.map((c) => c.id);
    if (cartIds.length > 0) {
      await tx.cartItem.deleteMany({ where: { cartId: { in: cartIds } } });
      await tx.cart.deleteMany({ where: { id: { in: cartIds } } });
    }
    await tx.userOtp.deleteMany({ where: { userId } });
    await tx.balance.deleteMany({ where: { userId } });
    await tx.user.delete({ where: { id: userId } });
  });
  return new Response(null, { status: 204 });
}
