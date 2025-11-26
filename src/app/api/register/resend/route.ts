import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcrypt";
import { rateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/origin";
import { sendWhatsApp } from "@/lib/whatsapp";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";
import { PHONE_VERIFICATION_ENABLED } from "@/lib/config";

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const limited = await rateLimit(req, "register-resend", 60_000, 5);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = (await req
      .json()
      .catch(() => ({} as { userId?: unknown })));
    const userId = String(body?.userId ?? "").trim();
    if (!userId) {
      return NextResponse.json(
        { error: "User is required" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, email: true, name: true },
    });

    if (!user) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    if (!user.phone && !user.email) {
      return NextResponse.json(
        { error: "No phone or email available to send a code" },
        { status: 400 }
      );
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const hash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await prisma.userOtp.create({
      data: {
        userId: user.id,
        purpose: "phone_register",
        codeHash: hash,
        expiresAt,
      },
    });

    const message = `Nora Hospital Supplies verification code: ${code}. Enter this on the verification screen within 15 minutes to complete your registration.`;

    let otpSent = false;
    let otpChannel: string | undefined = undefined;

    if (PHONE_VERIFICATION_ENABLED && user.phone) {
      const wa = await sendWhatsApp(user.phone, message).catch(() => ({ ok: false }));
      if (wa?.ok) {
        otpSent = true;
        otpChannel = "whatsapp";
      } else {
        const sms = await sendSms(user.phone, message).catch(() => ({ ok: false }));
        if (sms?.ok) {
          otpSent = true;
          otpChannel = "sms";
        }
      }
    }

    if (!otpSent && user.email) {
      const subject = "Verify your Nora Hospital Supplies account";
      const text = [
        "Welcome to Nora Hospital Supplies.",
        "",
        `Your verification code is: ${code}`,
        "",
        "Enter this code on the verification page within 15 minutes to complete your registration.",
      ].join("\n");
      const emailResult = await sendEmail(user.email, subject, text);
      if (emailResult.ok) {
        otpSent = true;
        otpChannel = "email";
      }
    }

    if (!otpSent) {
      return NextResponse.json(
        { error: "Failed to send verification code. Try again later." },
        { status: 502 }
      );
    }

    return NextResponse.json({ otpSent, otpChannel });
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "Failed to resend code";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
