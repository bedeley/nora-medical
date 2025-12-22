import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verifyTotp } from "@/lib/totp";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { signMfaCookie } from "@/lib/mfa";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "mfa-verify", 60_000, 10);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const userId = user.id;
  const { code } = await req.json().catch(() => ({}));
  if (!code) return NextResponse.json({ error: "Code required" }, { status: 400 });
  const mfaUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorEnabled: true, twoFactorSecret: true },
  });
  if (!mfaUser || !mfaUser.twoFactorEnabled || !mfaUser.twoFactorSecret) {
    return NextResponse.json({ error: "2FA not enabled" }, { status: 400 });
  }
  const ok = verifyTotp(String(code), mfaUser.twoFactorSecret, 1);
  if (!ok) return NextResponse.json({ error: "Invalid code" }, { status: 400 });

  const res = NextResponse.json({ ok: true });
  const maxAge = 60 * 60 * 8; // 8 hours
  const token = await signMfaCookie(userId, Date.now() + maxAge * 1000);
  if (!token) {
    return NextResponse.json(
      { error: "MFA cookie secret not configured" },
      { status: 500 }
    );
  }
  res.headers.append(
    "Set-Cookie",
    `mfa=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
  );
  return res;
}
