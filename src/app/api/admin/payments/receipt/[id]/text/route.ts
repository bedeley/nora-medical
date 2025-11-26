import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendSms } from "@/lib/sms";
import { sendWhatsApp } from "@/lib/whatsapp";
import { sendEmail } from "@/lib/email";
import { formatCurrency } from "@/lib/currency";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-sms-receipt", 60_000, 10);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    const body = (await req.json().catch(() => ({}))) as {
      to?: string;
    };
    const explicitTo = (body.to || "").toString().trim();

    const payment = await prisma.payment.findUnique({
      where: { id: params.id },
      include: { user: { select: { id: true, name: true, email: true, phone: true } } },
    });
    if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

    const to = explicitTo || payment.user?.phone || "";
    if (!to) return NextResponse.json({ error: "No destination phone number provided" }, { status: 400 });

    // Determine origin for receipt URL
    const url = new URL(req.url);
    const base = process.env.NEXT_PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;
    const receiptUrl = `${base}/admin/payments/receipt/${payment.id}`;

    // Build short message
    let meta: Record<string, unknown> | null = null;
    if (payment.note) {
      try {
        meta = JSON.parse(payment.note) as Record<string, unknown>;
      } catch {
        meta = null;
      }
    }
    const method = meta && meta.method ? ` via ${String(meta.method)}` : "";
    const amount = formatCurrency(Number(payment.amount || 0));
    const msg = `Nora Hospital Supplies: Payment of ${amount}${method} received. View receipt: ${receiptUrl}`;

    // Try WhatsApp first
    const toPhone = to.replace(/[^\d+]/g, "");
    const wa = await sendWhatsApp(toPhone, msg).catch(
      () => ({ ok: false } as { ok: boolean; error?: string }),
    );
    if (wa?.ok) return NextResponse.json({ ok: true, channel: 'whatsapp' });
    // Fallback to SMS
    const sms = await sendSms(to, msg);
    if (sms.ok) return NextResponse.json({ ok: true, channel: 'sms' });
    // Fallback to email
    const emailAddr = payment.user?.email || "";
    if (emailAddr) {
      const em = await sendEmail(
        emailAddr,
        `Payment receipt ${payment.id}`,
        msg,
        `<p>${msg}</p>`,
      );
      if (em.ok) return NextResponse.json({ ok: true, channel: "email" });
    }
    return NextResponse.json(
      { error: wa?.error || sms?.error || "Failed to send" },
      { status: 500 },
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to send";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
