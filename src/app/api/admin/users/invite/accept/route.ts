import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import {
  checkOtpLockout,
  clearOtpFailures,
  rateLimit,
  recordOtpFailure,
} from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { passwordSchema } from "@/lib/validation";

const acceptSchema = z.object({
  userId: z.string().min(1),
  code: z.string().min(4),
  password: passwordSchema,
});

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const limited = await rateLimit(req, "employee-invite-accept", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json();
    const parsed = acceptSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const { userId, code, password } = parsed.data;

    const lockout = await checkOtpLockout("employee_invite", userId);
    if (lockout.locked) {
      return NextResponse.json(
        { error: "Invalid or expired code" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, archived: true },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    if (user.archived) {
      return NextResponse.json({ error: "User is archived" }, { status: 400 });
    }
    if (!user.phone) {
      return NextResponse.json({ error: "Phone number required" }, { status: 400 });
    }

    const otp = await prisma.userOtp.findFirst({
      where: { userId, purpose: "employee_invite" },
      orderBy: { createdAt: "desc" },
    });
    if (!otp) {
      return NextResponse.json({ error: "Invite not found or expired" }, { status: 400 });
    }
    if (otp.expiresAt && otp.expiresAt < new Date()) {
      return NextResponse.json({ error: "Invite has expired" }, { status: 400 });
    }

    const valid = await bcrypt.compare(code, otp.codeHash);
    if (!valid) {
      await recordOtpFailure("employee_invite", userId);
      return NextResponse.json({ error: "Invalid or expired code" }, { status: 400 });
    }

    const hashed = await bcrypt.hash(password, 10);
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          password: hashed,
          phoneVerifiedAt: new Date(),
        },
      }),
      prisma.userOtp.delete({ where: { id: otp.id } }),
    ]);
    await clearOtpFailures("employee_invite", userId);

    try {
      await recordAuditLog({
        actorId: userId,
        action: "USER_INVITE_ACCEPT",
        entityType: "User",
        entityId: userId,
        meta: { method: "employee_invite" },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Employee invite accept error:", error);
    return NextResponse.json({ error: "Failed to accept invite" }, { status: 500 });
  }
}
