import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant))
    return new Response("Forbidden", { status: 403 });
  if (!assertSameOrigin(req)) return new Response("Bad origin", { status: 403 });
  const limited = await rateLimit(req, "admin-user-close", 60_000, 30);
  if (!limited.ok) return new Response("Too many requests", { status: 429 });
  const userId = params.id;
  const body = (await req.json().catch(() => null)) as { reason?: string } | null;
  const reason = body?.reason?.trim() || null;
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, archived: true },
  });
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
      meta: {
        email: existing?.email ?? null,
        name: existing?.name ?? null,
        reason,
        previouslyArchived: existing?.archived ?? null,
      },
    });
  } catch {
    // best-effort
  }
  return new Response(null, { status: 204 });
}
