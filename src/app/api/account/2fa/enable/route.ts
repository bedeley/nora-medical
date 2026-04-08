import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { verifyTotp } from "@/lib/totp";
import { recordAuditLog } from "@/lib/audit-log";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "2fa-enable", 60_000, 10);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const userId = user.id;
  const { code } = await req.json().catch(() => ({} as { code?: unknown }));
  if (!code) return NextResponse.json({ error: "Code required" }, { status: 400 });
  const dbUser = await prisma.user.findUnique({ where: { id: userId }, select: { twoFactorSecret: true } });
  const secret = dbUser?.twoFactorSecret || "";
  if (!secret) return NextResponse.json({ error: "Setup required" }, { status: 400 });
  const ok = verifyTotp(String(code), secret, 1);
  if (!ok) {
    await recordAuditLog({
      actorId: userId,
      action: "USER_2FA_ENABLE_FAILED",
      entityType: "USER",
      entityId: userId,
      request: req,
      outcome: "FAILED",
      meta: { reason: "invalid_code" },
    });
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }
  await prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
  await recordAuditLog({
    actorId: userId,
    action: "USER_2FA_ENABLED",
    entityType: "USER",
    entityId: userId,
    request: req,
    outcome: "SUCCESS",
  });
  return NextResponse.json({ ok: true });
}
