import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin, getAllowedOriginFromEnv } from "@/lib/origin";
import { clearOtpFailures, rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { sendWhatsApp } from "@/lib/whatsapp";

const resendSchema = z.object({
  userId: z.string().min(1),
});

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await rateLimit(req, "employee-invite-resend", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json();
    const parsed = resendSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const target = await prisma.user.findUnique({
      where: { id: parsed.data.userId },
      select: { id: true, email: true, phone: true, role: true, archived: true },
    });
    if (!target) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    if (target.archived) {
      return NextResponse.json({ error: "User is archived" }, { status: 400 });
    }
    if (!target.phone || !target.email) {
      return NextResponse.json({ error: "Phone and email are required" }, { status: 400 });
    }

    const recentInvite = await prisma.userOtp.findFirst({
      where: { userId: target.id, purpose: "employee_invite" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (recentInvite) {
      const minWaitMs = 5 * 60 * 1000;
      if (Date.now() - recentInvite.createdAt.getTime() < minWaitMs) {
        return NextResponse.json(
          { error: "Invite was sent recently. Please wait a few minutes before resending." },
          { status: 429 },
        );
      }
    }

    const inviteCode = String(Math.floor(100000 + Math.random() * 900000));
    const inviteHash = await bcrypt.hash(inviteCode, 10);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.userOtp.deleteMany({
      where: { userId: target.id, purpose: "employee_invite" },
    });

    await prisma.userOtp.create({
      data: {
        userId: target.id,
        purpose: "employee_invite",
        codeHash: inviteHash,
        expiresAt,
      },
    });
    await clearOtpFailures("employee_invite", target.id);

    const origin = getAllowedOriginFromEnv(req.url) || "http://localhost:3000";
    const inviteUrl = `${origin}/invite?userId=${target.id}`;
    const subject = "Your Noralls employee invite";
    const message = [
      `Hi ${target.email},`,
      "",
      "Your employee invite has been re-sent.",
      "",
      `Invite link: ${inviteUrl}`,
      `Verification code: ${inviteCode}`,
      "",
      "Enter the code within 24 hours to set your password.",
    ].join("\n");

    let channel: "email" | "sms" | "whatsapp" | "none" = "none";
    const emailResult = await sendEmail(target.email, subject, message);
    if (emailResult.ok) {
      channel = "email";
    } else {
      const smsResult = await sendSms(target.phone, message).catch(() => ({ ok: false }));
      if (smsResult?.ok) {
        channel = "sms";
      } else {
        const waResult = await sendWhatsApp(target.phone, message).catch(() => ({ ok: false }));
        if (waResult?.ok) {
          channel = "whatsapp";
        } else {
          const retryEmail = await sendEmail(target.email, subject, message);
          if (retryEmail.ok) channel = "email";
        }
      }
    }

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "USER_INVITE_RESEND",
        entityType: "User",
        entityId: target.id,
        meta: { role: target.role, email: target.email },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ ok: true, inviteUrl, channel });
  } catch (error) {
    console.error("Employee invite resend error:", error);
    return NextResponse.json({ error: "Failed to resend invite" }, { status: 500 });
  }
}
