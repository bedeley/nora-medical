import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import {
  checkOtpLockout,
  clearOtpFailures,
  rateLimit,
  recordOtpFailure,
} from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/origin";

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const limited = await rateLimit(req, "register-verify", 60_000, 10);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = (await req
      .json()
      .catch(() => ({} as { userId?: unknown; code?: unknown })));
    const userId = String(body?.userId ?? "").trim();
    const code = String(body?.code ?? "").trim();

    if (!userId || !code) {
      return NextResponse.json(
        { error: "User and code are required" },
        { status: 400 }
      );
    }

    const lockout = await checkOtpLockout("phone_register", userId);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "Invalid or expired code" },
        { status: 400 }
      );
    }

    const otp = await prisma.userOtp.findFirst({
      where: { userId, purpose: "phone_register" },
      orderBy: { createdAt: "desc" },
    });

    if (!otp) {
      return NextResponse.json(
        { error: "Code not found or expired" },
        { status: 400 }
      );
    }

    if (otp.expiresAt && otp.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "Code has expired. Please register again." },
        { status: 400 }
      );
    }

    const valid = await bcrypt.compare(code, otp.codeHash);
    if (!valid) {
      await recordOtpFailure("phone_register", userId);
      return NextResponse.json(
        { error: "Invalid or expired code" },
        { status: 400 }
      );
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { phoneVerifiedAt: new Date() },
      }),
      prisma.userOtp.delete({ where: { id: otp.id } }),
    ]);
    await clearOtpFailures("phone_register", userId);

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "Failed to verify code";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
