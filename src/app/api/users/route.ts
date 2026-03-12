import { prisma } from "@/lib/prisma";
import { registerSchema } from "@/lib/validation";
import bcrypt from "bcrypt";
import { Role } from "@/lib/prisma-enums";
import { assertSameOrigin } from "@/lib/origin";
import { clearOtpFailures, rateLimit } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email";
import { sendWhatsApp } from "@/lib/whatsapp";
import { sendSms } from "@/lib/sms";
import { PHONE_VERIFICATION_ENABLED } from "@/lib/config";

export async function POST(req: Request) {
  try {
    if (!assertSameOrigin(req)) return new Response("Bad origin", { status: 403 });
    const limited = await rateLimit(req, "register", 60_000, 5);
    if (!limited.ok) return new Response("Too many requests", { status: 429 });

    let data: unknown;
    try {
      data = await req.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    const parsed = registerSchema.safeParse(data);
    if (!parsed.success) return new Response("Invalid", { status: 400 });
    const { name, email, username, password, phone } = parsed.data;
    const normalizedEmail = email ? email.toLowerCase().trim() : undefined;
    const normalizedUsername = username ? username.toLowerCase().trim() : undefined;
    const normalizedPhone = (phone || "").trim();

    const titleCase = (s: string) =>
      String(s || "").replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    if (normalizedEmail) {
      const exists = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (exists) return new Response("Email in use", { status: 409 });
    }
    if (normalizedUsername) {
      const existsUsername = await prisma.user.findUnique({ where: { username: normalizedUsername } });
      if (existsUsername) return new Response("Username in use", { status: 409 });
    }
    if (normalizedPhone) {
      const existsPhone = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
      if (existsPhone) return new Response("Phone in use", { status: 409 });
    }

    // First registered user can become ADMIN only with bootstrap secret; otherwise CUSTOMER
    const userCount = await prisma.user.count();
    const bootstrapSecret = (process.env.ADMIN_BOOTSTRAP_SECRET || "").trim();
    const providedSecret = (req.headers.get("x-admin-bootstrap") || "").trim();
    const makeAdmin = userCount === 0 && bootstrapSecret && providedSecret && bootstrapSecret === providedSecret;

    const user = await prisma.user.create({
      data: {
        name: titleCase(name),
        phone: normalizedPhone,
        password: await bcrypt.hash(password, 10),
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
        ...(normalizedUsername ? { username: normalizedUsername } : {}),
        ...(makeAdmin ? { role: Role.ADMIN } : {}),
      },
    });

    // Send registration verification code.
    // When PHONE_VERIFICATION_ENABLED is on, prefer WhatsApp/SMS to phone with email fallback.
    // When off, send via email only.
    try {
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
      await clearOtpFailures("phone_register", user.id);

      let otpSent = false;
      let otpChannel: string | undefined = undefined;

      const message = `Noralls Medical Supplies verification code: ${code}. Enter this on the verification screen within 15 minutes to complete your registration.`;

      if (PHONE_VERIFICATION_ENABLED && normalizedPhone) {
        const wa = await sendWhatsApp(normalizedPhone, message).catch(() => ({ ok: false }));
        if (wa?.ok) {
          otpSent = true;
          otpChannel = "whatsapp";
        } else {
          const sms = await sendSms(normalizedPhone, message).catch(() => ({ ok: false }));
          if (sms?.ok) {
            otpSent = true;
            otpChannel = "sms";
          }
        }
      }

      if (!otpSent && normalizedEmail) {
        const subject = "Verify your Noralls Medical Supplies account";
        const text = [
          "Welcome to Noralls Medical Supplies.",
          "",
          `Your verification code is: ${code}`,
          "",
          "Enter this code on the verification page within 15 minutes to complete your registration.",
        ].join("\n");
        const emailResult = await sendEmail(normalizedEmail, subject, text);
        if (emailResult.ok) {
          otpSent = true;
          otpChannel = "email";
        }
      }

      return Response.json({ id: user.id, otpSent, otpChannel });
    } catch (e) {
      console.error("Registration OTP send failed:", e);
      // Still return user id so the flow can continue, but indicate OTP failure
      return Response.json({ id: user.id, otpSent: false }, { status: 201 });
    }
  } catch (error) {
    console.error("User registration failed:", error);
    const isDev = process.env.NODE_ENV !== "production";
    const message = isDev && error instanceof Error ? error.message : "Registration failed";
    return new Response(message, { status: 500 });
  }
}
