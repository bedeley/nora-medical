import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/origin";
import { sendEmail } from "@/lib/email";
import { sendWhatsApp } from "@/lib/whatsapp";
import { sendSms } from "@/lib/sms";
import { PHONE_VERIFICATION_ENABLED } from "@/lib/config";
import { z } from "zod";
import bcrypt from "bcrypt";

const schema = z.object({
  identifier: z.string().min(3).optional(),
  email: z.string().optional(), // Backward compatibility
  channel: z.enum(["email", "whatsapp"]).optional(),
});

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function phoneVariants(value: string) {
  const variants = new Set<string>();
  const trimmed = value.trim();
  if (trimmed) variants.add(trimmed);
  const collapsed = trimmed.replace(/\s+/g, "");
  if (collapsed) variants.add(collapsed);
  const digits = collapsed.replace(/[^\d]/g, "");
  if (digits) {
    variants.add(digits);
    variants.add("+" + digits);
    if (collapsed.startsWith("+")) variants.add(collapsed.slice(1));
    // Try US default if 10 digits (no country code)
    if (digits.length === 10) {
      variants.add(`1${digits}`);
      variants.add(`+1${digits}`);
    }
    // Handle Ghana-style numbers (often 9 digits without country code or 10 digits with leading 0)
    if (digits.length === 9) {
      variants.add(`233${digits}`);
      variants.add(`+233${digits}`);
    }
    if (digits.length === 10 && digits.startsWith("0")) {
      const ghDigits = digits.slice(1);
      variants.add(`233${ghDigits}`);
      variants.add(`+233${ghDigits}`);
    }
  }
  return Array.from(variants).filter(Boolean);
}

async function findUserByPhone(identifier: string) {
  const variants = phoneVariants(identifier);
  if (!variants.length) return null;
  return prisma.user.findFirst({
    where: { phone: { in: variants } },
    select: { id: true, email: true, name: true, phone: true },
  });
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const limited = await rateLimit(req, "password-reset-request", 60_000, 5);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Enter a valid email or phone number" }, { status: 400 });
    }

    const requestedChannel = parsed.data.channel || "email";
    const channel =
      PHONE_VERIFICATION_ENABLED && requestedChannel === "whatsapp"
        ? "whatsapp"
        : "email";
    const rawIdentifier = (parsed.data.identifier ?? parsed.data.email ?? "").trim();
    if (!rawIdentifier) {
      return NextResponse.json({ error: channel === "whatsapp" ? "Enter the phone number on your account" : "Enter your account email" }, { status: 400 });
    }
    let user: { id: string; email: string | null; name: string | null; phone: string | null } | null =
      null;
    if (channel === "whatsapp" && !rawIdentifier.includes("@")) {
      user = await findUserByPhone(rawIdentifier);
      if (!user) {
        return NextResponse.json({ error: "No account found with that phone number" }, { status: 400 });
      }
    } else {
      if (!emailRegex.test(rawIdentifier.toLowerCase())) {
        return NextResponse.json({ error: "Enter a valid email" }, { status: 400 });
      }
      user = await prisma.user.findUnique({
        where: { email: rawIdentifier.toLowerCase() },
        select: { id: true, email: true, name: true, phone: true },
      });
      if (!user) {
        return NextResponse.json({ ok: true });
      }
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const hash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await prisma.userOtp.create({
      data: { userId: user.id, purpose: "password_reset", codeHash: hash, expiresAt },
    });

    if (channel === "email") {
      const subject = "Nora Hospital Supplies password reset";
      const text = [
        `Hi ${user.name || "there"},`,
        "",
        "We received a request to reset your password.",
        `Your reset code is: ${code}`,
        "",
        "Enter this code on the sign-in page to set a new password.",
        "If you didn't request this, you can ignore this email.",
        "",
        "— Nora Hospital Supplies",
      ].join("\n");
      const sent = await sendEmail(user.email || rawIdentifier, subject, text);
      if (!sent.ok) {
        return NextResponse.json({ error: sent.error || "Failed to send reset email" }, { status: 502 });
      }
    } else {
      if (!user.phone) {
        return NextResponse.json({ error: "No phone on file for WhatsApp reset. Use email instead." }, { status: 400 });
      }
      const message = `Nora Hospital Supplies password reset code: ${code}. Enter this on the login page within 15 minutes.`;
      const wa = await sendWhatsApp(user.phone, message).catch(() => ({ ok: false }));
      if (!wa?.ok) {
        const sms = await sendSms(user.phone, message);
        if (!sms.ok) {
          return NextResponse.json({ error: sms.error || "Failed to send code via WhatsApp/SMS" }, { status: 502 });
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "Failed to request reset";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
