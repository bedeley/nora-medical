import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return new Response(JSON.stringify({ error: "Only ADMIN can close customer accounts." }), { status: 403 });
  }
  if (!assertSameOrigin(req)) return new Response("Bad origin", { status: 403 });
  const limited = await rateLimit(req, "admin-user-close", 60_000, 30);
  if (!limited.ok) return new Response("Too many requests", { status: 429 });
  const params = await context.params;
  const userId = params.id;
  if (!userId) {
    return new Response(JSON.stringify({ error: "Missing user id" }), { status: 400 });
  }
  const body = (await req.json().catch(() => null)) as {
    reason?: string;
    sourcePage?: string;
  } | null;
  const reason = body?.reason?.trim() || null;
  const sourcePage = body?.sourcePage?.trim() || "admin/customers";
  if (!reason || reason.length < 5) {
    return new Response(JSON.stringify({ error: "Closure reason is required." }), { status: 400 });
  }
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, archived: true },
  });
  if (!existing) {
    return new Response(JSON.stringify({ error: "User not found" }), { status: 404 });
  }

  const [ordersCount, paymentsCount, cart, savedCartItemsCount, balance] =
    await Promise.all([
      prisma.order.count({ where: { userId } }),
      prisma.payment.count({ where: { userId } }),
      prisma.cart.findUnique({
        where: { userId },
        select: { id: true, items: { select: { id: true }, take: 1 } },
      }),
      prisma.savedCartItem.count({ where: { userId } }),
      prisma.balance.findUnique({
        where: { userId },
        select: { totalDue: true, totalPaid: true, balance: true, creditLimit: true },
      }),
    ]);
  const hasMeaningfulBalance = Boolean(
    balance &&
      (Math.abs(Number(balance.totalDue || 0)) > 0.005 ||
        Math.abs(Number(balance.totalPaid || 0)) > 0.005 ||
        Math.abs(Number(balance.balance || 0)) > 0.005 ||
        Math.abs(Number(balance.creditLimit || 0)) > 0.005),
  );
  const blockers = [
    existing.role !== "CUSTOMER" ? "employee_role" : null,
    ordersCount > 0 ? "orders" : null,
    paymentsCount > 0 ? "payments" : null,
    cart ? "cart" : null,
    savedCartItemsCount > 0 ? "saved_cart" : null,
    hasMeaningfulBalance ? "balance" : null,
  ].filter((value): value is string => Boolean(value));

  if (blockers.length > 0) {
    await recordAuditLog({
      actorId: user?.id,
      action: "USER_CLOSE_DENIED",
      entityType: "USER",
      entityId: userId,
      request: req,
      outcome: "FAILED",
      meta: {
        actorId: user?.id ?? null,
        actorRole: user?.role ?? null,
        targetUserId: userId,
        targetUserRole: existing.role,
        email: existing.email,
        name: existing.name,
        reason,
        sourcePage,
        sourceRoute: "/api/admin/users/[id]/close",
        blockers,
        counts: {
          orders: ordersCount,
          payments: paymentsCount,
          cartItems: cart?.items?.length ? 1 : 0,
          savedCartItems: savedCartItemsCount,
        },
        balance,
      },
    });
    return new Response(
      JSON.stringify({
        error: "Account cannot be closed while customer history or lifecycle blockers exist. Archive it instead.",
        blockers,
      }),
      { status: 409 },
    );
  }

  await prisma.$transaction(async (tx: TxClient) => {
    const carts = await tx.cart.findMany({ where: { userId }, select: { id: true } });
    const cartIds = carts.map((c: { id: string }) => c.id);
    if (cartIds.length > 0) {
      await tx.cartItem.deleteMany({ where: { cartId: { in: cartIds } } });
      await tx.cart.deleteMany({ where: { id: { in: cartIds } } });
    }
    await tx.userOtp.deleteMany({ where: { userId } });
    await tx.balance.deleteMany({ where: { userId } });
    await tx.user.update({
      where: { id: userId },
      data: { deletedAt: new Date(), archived: true },
    });
  });
  try {
    await recordAuditLog({
      actorId: user?.id,
      action: "USER_CLOSE",
      entityType: "USER",
      entityId: userId,
      request: req,
      meta: {
        actorId: user?.id ?? null,
        actorRole: user?.role ?? null,
        targetUserId: userId,
        targetUserRole: existing.role,
        email: existing?.email ?? null,
        name: existing?.name ?? null,
        reason,
        sourcePage,
        sourceRoute: "/api/admin/users/[id]/close",
        previouslyArchived: existing?.archived ?? null,
      },
    });
  } catch {
    // best-effort
  }
  return new Response(null, { status: 204 });
}
