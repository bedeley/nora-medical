import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { sendSms } from "@/lib/sms";
import { sendWhatsApp } from "@/lib/whatsapp";
import bcrypt from "bcrypt";
import { PHONE_VERIFICATION_ENABLED } from "@/lib/config";

export async function POST(req: Request) {
  if (!PHONE_VERIFICATION_ENABLED) {
    return NextResponse.json(
      { error: "Phone verification via WhatsApp/SMS is temporarily disabled. Please use email verification." },
      { status: 503 },
    );
  }

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "phone-otp-request", 60_000, 3);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const userId = (session.user as AuthenticatedUser).id;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    const phone = typeof user?.phone === "string" ? user.phone.trim() : "";
    if (!phone) return NextResponse.json({ error: "No phone on file" }, { status: 400 });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const hash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await prisma.userOtp.create({ data: { userId, purpose: "phone_verification", codeHash: hash, expiresAt } });

  const msg = `Noralls Medical Supplies: Your verification code is ${code}. It expires in 10 minutes.`;
    const wa = await sendWhatsApp(phone, msg).catch(
      () => ({ ok: false } as { ok: boolean })
    );
    if (wa.ok) return NextResponse.json({ ok: true, channel: "whatsapp" });
    const res = await sendSms(phone, msg);
    if (!res.ok) return NextResponse.json({ error: res.error || "Failed to send" }, { status: 502 });
    return NextResponse.json({ ok: true, channel: "sms" });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
