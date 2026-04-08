import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import bcrypt from "bcryptjs";

type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "phone-otp-confirm", 60_000, 6);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const { code } = await req.json().catch(() => ({} as { code?: unknown }));
    if (!code || String(code).length < 4) return NextResponse.json({ error: "Invalid code" }, { status: 400 });
    const userId = (session.user as AuthenticatedUser).id;
    const now = new Date();
    const otp = await prisma.userOtp.findFirst({
      where: { userId, purpose: "phone_verification", expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
    });
    if (!otp) return NextResponse.json({ error: "No valid code found" }, { status: 400 });
    const ok = await bcrypt.compare(String(code), otp.codeHash);
    if (!ok) return NextResponse.json({ error: "Incorrect code" }, { status: 400 });
    await prisma.$transaction(async (tx: TxClient) => {
      await tx.user.update({
        where: { id: userId },
        data: { phoneVerifiedAt: new Date() },
      });
      await tx.userOtp.deleteMany({ where: { userId, purpose: "phone_verification" } });
    });
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
