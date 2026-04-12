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
import { recordAuditLog } from "@/lib/audit-log";

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

const normalizeBalance = (value: number) => (Math.abs(value) < 0.01 ? 0 : value);

function formatReceiptText(order: OrderForReceipt) {
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
  const rawBalance = Math.max(
    0,
    Number(order.total ?? subtotal + taxAmount) - Number(order.amountPaid ?? 0),
  );
  const balance = formatCurrency(normalizeBalance(rawBalance));
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
  return lines.join("\n");
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "order-sms-receipt", 60_000, 4);
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

    const body = formatReceiptText(order as unknown as OrderForReceipt);
    const total = Number(order.total ?? 0);
    const amountPaid = Number(order.amountPaid ?? 0);
    const balance = normalizeBalance(Math.max(0, total - amountPaid));
    const receiptMetaBase = {
      orderId: order.id,
      invoiceNumber: order.invoiceNumber ?? null,
      orderStatus: order.status,
      customerId: order.userId ?? null,
      customerName: order.user?.name ?? null,
      customerEmail: order.user?.email ?? null,
      recipientPhone: phone,
      receiptEmailFallback: order.user?.email ?? null,
      total,
      amountPaid,
      balance,
      requestedByName: user.name || user.email || null,
      requestedByEmail: user.email || null,
      requestedByRole: user.role || null,
      sourcePage: isAdmin ? "/admin/orders/[id]" : "/orders/[id]",
      sourceRoute: `/api/orders/${order.id}/receipt/sms`,
    };
    // Try WhatsApp first
    const wa = await sendWhatsApp(
      phone.startsWith("whatsapp:")
        ? phone
        : `+${phone.replace(/[^\d]/g, "")}`,
      body,
    ).catch(() => ({ ok: false } as { ok: boolean; error?: string }));
    if (wa?.ok) {
      await recordAuditLog({
        actorId: user.id,
        action: "ORDER_RECEIPT_SEND",
        entityType: "ORDER",
        entityId: order.id,
        request: req,
        outcome: "SUCCESS",
        meta: {
          ...receiptMetaBase,
          channel: "whatsapp",
          attemptedChannels: ["whatsapp"],
          failedChannels: [],
        },
      });
      return NextResponse.json({ success: true, channel: "whatsapp" });
    }
    // Fallback to SMS
    const sms = await sendSms(phone, body);
    if (sms.ok) {
      await recordAuditLog({
        actorId: user.id,
        action: "ORDER_RECEIPT_SEND",
        entityType: "ORDER",
        entityId: order.id,
        request: req,
        outcome: "SUCCESS",
        meta: {
          ...receiptMetaBase,
          channel: "sms",
          attemptedChannels: ["whatsapp", "sms"],
          failedChannels: ["whatsapp"],
          providerErrors: {
            whatsapp: wa?.error || null,
          },
        },
      });
      return NextResponse.json({ success: true, channel: "sms" });
    }
    // Fallback to email if available
    const email = order.user?.email || "";
    if (email) {
      const em = await sendEmail(email, `Receipt for order ${order.id}`, body);
      if (em.ok) {
        await recordAuditLog({
          actorId: user.id,
          action: "ORDER_RECEIPT_SEND",
          entityType: "ORDER",
          entityId: order.id,
          request: req,
          outcome: "SUCCESS",
          meta: {
            ...receiptMetaBase,
            channel: "email",
            attemptedChannels: ["whatsapp", "sms", "email"],
            failedChannels: ["whatsapp", "sms"],
            providerErrors: {
              whatsapp: wa?.error || null,
              sms: sms.error || null,
            },
          },
        });
        return NextResponse.json({ success: true, channel: "email" });
      }
    }
    await recordAuditLog({
      actorId: user.id,
      action: "ORDER_RECEIPT_SEND",
      entityType: "ORDER",
      entityId: order.id,
      request: req,
      outcome: "FAILED",
      meta: {
        ...receiptMetaBase,
        channel: null,
        attemptedChannels: email ? ["whatsapp", "sms", "email"] : ["whatsapp", "sms"],
        failedChannels: email ? ["whatsapp", "sms", "email"] : ["whatsapp", "sms"],
        providerErrors: {
          whatsapp: wa?.error || null,
          sms: sms.error || null,
        },
      },
    });
    return NextResponse.json({ error: wa?.error || sms?.error || "Failed to send" }, { status: 502 });
  } catch (err) {
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "ORDER_RECEIPT_SEND",
        entityType: "ORDER",
        entityId: params.id,
        request: req,
        outcome: "FAILED",
        meta: {
          requestedByName: user.name || user.email || null,
          requestedByEmail: user.email || null,
          requestedByRole: user.role || null,
          sourcePage: isAdmin ? "/admin/orders/[id]" : "/orders/[id]",
          sourceRoute: `/api/orders/${params.id}/receipt/sms`,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } catch {
      // best-effort
    }
    console.error("send receipt sms error:", err);
    return NextResponse.json({ error: "Failed to send SMS" }, { status: 500 });
  }
}
