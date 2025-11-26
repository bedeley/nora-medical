import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { sendWhatsApp } from "@/lib/whatsapp";
import { sendSms } from "@/lib/sms";
import { sendEmail } from "@/lib/email";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-comm-test", 60_000, 10);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as {
    whatsappTo?: string;
    smsTo?: string;
    emailTo?: string;
    message?: string;
  };
  const { whatsappTo, smsTo, emailTo, message } = body;
  const msg = message || "Test from Nora Hospital Supplies";
  const result: {
    whatsapp?: unknown;
    sms?: unknown;
    email?: unknown;
  } = {};
  if (whatsappTo) {
    try {
      const r = await sendWhatsApp(whatsappTo, msg);
      result.whatsapp = r;
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "error";
      result.whatsapp = { ok: false, error: message };
    }
  }
  if (smsTo) {
    try {
      const r = await sendSms(smsTo, msg);
      result.sms = r;
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "error";
      result.sms = { ok: false, error: message };
    }
  }
  if (emailTo) {
    try {
      const r = await sendEmail(
        emailTo,
        "Test Message",
        msg,
        `<p>${msg}</p>`,
      );
      result.email = r;
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "error";
      result.email = { ok: false, error: message };
    }
  }
  return NextResponse.json({ ok: true, result });
}
