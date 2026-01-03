import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendSms } from "@/lib/sms";
import { sendWhatsApp } from "@/lib/whatsapp";
import { sendEmail } from "@/lib/email";
import { formatCurrency, formatDateTimeGH } from "@/lib/currency";
import { formatIdReadable, formatInvoiceNumber } from "@/lib/utils";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";

type OrderItemWithProduct = {
  product: { name: string } | null;
  quantity: number;
  price: unknown;
};

type OrderForReceipt = {
  id: string;
  invoiceNumber?: string | null;
  subtotal?: unknown;
  taxRate?: unknown;
  taxAmount?: unknown;
  createdAt: Date;
  user: { name: string | null; phone: string | null; email: string | null } | null;
  items: OrderItemWithProduct[];
  total: unknown;
  amountPaid?: unknown;
  status: string;
  receiptHash?: string | null;
};

function formatReceiptText(order: OrderForReceipt, receiptUrl?: string) {
  const lines: string[] = [];
  lines.push(`Noralls Medical Supplies`);
  const invoiceDisplay = formatInvoiceNumber(order.invoiceNumber);
  lines.push(invoiceDisplay ? `INV: ${invoiceDisplay}` : `Order ${formatIdReadable(order.id)}`);
  lines.push(`Date: ${formatDateTimeGH(order.createdAt)}`);
  const customerName = order.user?.name || "";
  lines.push(`Customer: ${customerName}`);
  lines.push(`-----------------------------`);
  for (const it of order.items || []) {
    const name = it.product?.name || "Item";
    const qty = it.quantity;
    const price = formatCurrency(Number(it.price));
    const lineTotal = formatCurrency(Number(it.price) * qty);
    lines.push(`${name} x${qty} @ ${price} = ${lineTotal}`);
  }
  lines.push(`-----------------------------`);
  const subtotal = Number(order.subtotal ?? order.total ?? 0);
  const taxAmount = Number(order.taxAmount ?? 0);
  const taxRate = Number(order.taxRate ?? 0);
  const total = formatCurrency(Number(order.total ?? subtotal + taxAmount));
  const paid = formatCurrency(Number(order.amountPaid ?? 0));
  const balance = formatCurrency(
    Math.max(0, Number(order.total ?? subtotal + taxAmount) - Number(order.amountPaid ?? 0)),
  );
  lines.push(`Subtotal: ${formatCurrency(subtotal)}`);
  if (taxAmount > 0) {
    lines.push(`Tax${taxRate ? ` (${taxRate}%)` : ""}: ${formatCurrency(taxAmount)}`);
  }
  lines.push(`Total: ${total}`);
  lines.push(`Paid: ${paid}`);
  lines.push(`Balance: ${balance}`);
  lines.push(`Status: ${order.status}`);
  if (order.receiptHash) {
    lines.push(`Receipt hash: ${order.receiptHash}`);
  }
  if (receiptUrl) {
    lines.push(`Receipt: ${receiptUrl}`);
  }
  return lines.join("\n");
}

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(_req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(_req, "order-sms-receipt", 60_000, 4);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const user = session.user as AuthenticatedUser;
  const isAdmin = user.role === "ADMIN";

  try {
    const order = await prisma.order.findFirst({
      where: isAdmin ? { id: params.id } : { id: params.id, userId: user.id },
      include: { items: { include: { product: true } }, user: { select: { name: true, phone: true, email: true } } },
    });
    if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Determine phone; use order.user.phone only
    const phone = order.user?.phone?.trim?.() ?? "";
    if (!phone) {
      return NextResponse.json({ error: "No phone number on file for this order" }, { status: 400 });
    }

    const url = new URL(_req.url);
    const base = process.env.NEXT_PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;
    const receiptToken = order.receiptHash ? `?receipt=${encodeURIComponent(order.receiptHash)}` : "";
    const receiptUrl = `${base}/orders/${order.id}/receipt${receiptToken}`;
    const body = formatReceiptText(order as unknown as OrderForReceipt, receiptUrl);
    // Try WhatsApp first
    const wa = await sendWhatsApp(
      phone.startsWith("whatsapp:")
        ? phone
        : `+${phone.replace(/[^\d]/g, "")}`,
      body,
    ).catch(() => ({ ok: false } as { ok: boolean; error?: string }));
    if (wa?.ok) return NextResponse.json({ success: true, channel: 'whatsapp' });
    // Fallback to SMS
    const sms = await sendSms(phone, body);
    if (sms.ok) return NextResponse.json({ success: true, channel: 'sms' });
    // Fallback to email if available
    const email = order.user?.email || "";
    if (email) {
      const em = await sendEmail(email, `Receipt for order ${order.id}`, body);
      if (em.ok) return NextResponse.json({ success: true, channel: 'email' });
    }
    return NextResponse.json({ error: wa?.error || sms?.error || "Failed to send" }, { status: 502 });
  } catch (err) {
    console.error("send receipt sms error:", err);
    return NextResponse.json({ error: "Failed to send SMS" }, { status: 500 });
  }
}
