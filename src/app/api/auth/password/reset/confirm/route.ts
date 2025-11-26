import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import bcrypt from "bcrypt";
import { z } from "zod";

const schema = z.object({
  identifier: z.string().min(3).optional(),
  email: z.string().optional(), // backward compatibility
  code: z.string().min(4),
  password: z.string().min(6),
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
    if (digits.length === 10) {
      variants.add(`1${digits}`);
      variants.add(`+1${digits}`);
    }
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

async function findUserByIdentifier(identifier: string) {
  if (identifier.includes("@") && emailRegex.test(identifier.toLowerCase())) {
    return prisma.user.findUnique({
      where: { email: identifier.toLowerCase() },
      select: { id: true },
    });
  }
  const variants = phoneVariants(identifier);
  if (!variants.length) return null;
  return prisma.user.findFirst({
    where: { phone: { in: variants } },
    select: { id: true },
  });
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const limited = await rateLimit(req, "password-reset-confirm", 60_000, 6);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const identifier = (parsed.data.identifier ?? parsed.data.email ?? "").trim();
    if (!identifier) {
      return NextResponse.json({ error: "Enter the email or phone linked to your account" }, { status: 400 });
    }

    const code = parsed.data.code.trim();
    const password = parsed.data.password;

    const user = await findUserByIdentifier(identifier);
    if (!user) {
      return NextResponse.json({ error: "Invalid code" }, { status: 400 });
    }

    const now = new Date();
    const otp = await prisma.userOtp.findFirst({
      where: {
        userId: user.id,
        purpose: "password_reset",
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
    });
    if (!otp) {
      return NextResponse.json({ error: "Invalid or expired code" }, { status: 400 });
    }

    const ok = await bcrypt.compare(code, otp.codeHash);
    if (!ok) {
      return NextResponse.json({ error: "Invalid or expired code" }, { status: 400 });
    }

    const hashed = await bcrypt.hash(password, 10);
    await prisma.$transaction(async (tx: TxClient) => {
      await tx.user.update({ where: { id: user.id }, data: { password: hashed } });
      await tx.userOtp.deleteMany({ where: { userId: user.id, purpose: "password_reset" } });
    });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "Failed to reset password";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
