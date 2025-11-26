import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";

function collectMissing(vars: Record<string, string | undefined>) {
  const missing: string[] = [];
  for (const [k, v] of Object.entries(vars)) if (!v || !String(v).trim()) missing.push(k);
  return missing;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const smsMissing = collectMissing({
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
  });
  const whatsappMissing = collectMissing({
    TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_FROM: process.env.TWILIO_WHATSAPP_FROM,
  });
  const sendgridMissing = collectMissing({
    SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
    SENDGRID_FROM: process.env.SENDGRID_FROM || process.env.EMAIL_FROM,
  });
  const resendMissing = collectMissing({
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM: process.env.RESEND_FROM || process.env.EMAIL_FROM,
  });

  const emailProvider = !sendgridMissing.length
    ? "sendgrid"
    : !resendMissing.length
    ? "resend"
    : null;
  const emailMissing = emailProvider === "sendgrid" ? sendgridMissing : emailProvider === "resend" ? resendMissing : ["SENDGRID_* or RESEND_*"];

  return NextResponse.json({
    sms: { ready: smsMissing.length === 0, missing: smsMissing },
    whatsapp: { ready: whatsappMissing.length === 0, missing: whatsappMissing },
    email: { ready: !!emailProvider, provider: emailProvider, missing: emailMissing },
  });
}
