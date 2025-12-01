import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { randomBase32, otpauthURL } from "@/lib/totp";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "2fa-setup", 60_000, 5);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const userId = user.id;
  const secret = randomBase32(20);
  await prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: secret } });
  const label = `admin:${user.email || userId}`;
  const issuer = "Noralls Medical Supplies";
  const url = otpauthURL({ secret, label, issuer });
  return NextResponse.json({ ok: true, secret, otpauth: url });
}
