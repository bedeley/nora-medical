import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { formatInvoiceNumber } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";

const schema = z.object({ to: z.string().email().optional() });
const normalizeBalance = (value: number) => (Math.abs(value) < 0.01 ? 0 : value);
const formatReceiptDate = (value: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const params = await context.params;
    const url = new URL(req.url);
    const queryId = (url.searchParams.get("id") || "").trim();
    let orderId = (params?.id || "").trim();
    let body: unknown = {};
    try {
      body = await req.json().catch(() => ({}));
    } catch {
      body = {};
    }
    const parsed = schema.safeParse(body);
    if (!orderId) {
      const bodyWithId = (body || {}) as { id?: string; orderId?: string };
      orderId = String(bodyWithId.orderId || bodyWithId.id || queryId || "").trim();
    }
    if (!orderId) {
      return NextResponse.json({ error: "Missing order id" }, { status: 400 });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: { include: { product: true } },
        user: { select: { email: true, name: true } },
      },
    });
    if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const user = session.user as AuthenticatedUser;
    const isAdmin = user.role === "ADMIN";
    const isOwner = order.userId ? order.userId === user.id : false;
    if (!isAdmin && !isOwner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const to =
      (parsed.success && parsed.data.to) ||
      order.user?.email ||
      user.email ||
      "";
    if (!to) return NextResponse.json({ error: "No email available" }, { status: 400 });

    const subtotal = Number((order as { subtotal?: unknown }).subtotal ?? order.total ?? 0);
    const taxAmount = Number((order as { taxAmount?: unknown }).taxAmount ?? 0);
    const taxRate = Number((order as { taxRate?: unknown }).taxRate ?? 0);
    const total = Number(order.total ?? subtotal + taxAmount);
    const paid = Number(order.amountPaid || 0);
    const discountAmount = Math.max(0, subtotal + taxAmount - total);
    const rawBalance = Math.max(0, total - paid);
    const balance = normalizeBalance(rawBalance);
    const deliveryLabel = (() => {
      const raw = String(order.deliveryStatus || "NOT_DELIVERED").toUpperCase();
      if (raw === "DELIVERED") return "Delivered";
      if (raw === "PARTIALLY_DELIVERED") return "Partially delivered";
      if (raw === "RETURNED") return "Returned";
      return "Not delivered";
    })();

    const rows = (order.items || [])
      .map((i: { product?: { name?: string | null } | null; quantity: number; price: unknown }) => (
        `<tr>
          <td style="padding:8px 12px;border-top:1px solid #e6e8eb;">${i.product?.name || "Item"}</td>
          <td align="right" style="padding:8px 12px;border-top:1px solid #e6e8eb;">${i.quantity}</td>
          <td align="right" style="padding:8px 12px;border-top:1px solid #e6e8eb;">${formatCurrency(Number(i.price))}</td>
          <td align="right" style="padding:8px 12px;border-top:1px solid #e6e8eb;">${formatCurrency(Number(i.price) * i.quantity)}</td>
        </tr>`
      ))
      .join("");
    const deliveryLines = (order.items || []).map((i: { product?: { name?: string | null } | null; quantity: number; deliveredQuantity?: number | null }) => {
      const name = i.product?.name || "Item";
      const qty = Number(i.quantity || 0);
      const delivered = Number((i as { deliveredQuantity?: unknown }).deliveredQuantity ?? 0);
      const remaining = Math.max(0, qty - delivered);
      return `${name}: ${delivered}/${qty} delivered (${remaining} remaining)`;
    });
    const html = `
      <div style="margin:0;padding:24px;background-color:#f6f7f9;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e6e8eb;border-radius:12px;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
          <div style="text-align:center;font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#6b7280;margin-bottom:10px;">Receipt</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr>
              <td style="width:42%;vertical-align:top;">
                <div style="font-size:14px;font-weight:700;letter-spacing:0.2px;">Noralls Medical Supplies</div>
                <div style="font-size:12px;color:#6b7280;line-height:1.5;">Tel: ${process.env.NEXT_PUBLIC_ADMIN_PHONE || "N/A"}</div>
              </td>
              <td align="right" style="width:58%;vertical-align:top;">
                <div style="font-size:14px;font-weight:600;line-height:1.4;">${(() => {
                  const formatted = formatInvoiceNumber((order as { invoiceNumber?: string | null }).invoiceNumber);
                  return formatted ? `INV: ${formatted}` : `Order ${order.id}`;
                })()}</div>
                <div style="font-size:12px;color:#6b7280;line-height:1.5;">${formatReceiptDate(order.createdAt)}</div>
              </td>
            </tr>
          </table>

          <div style="margin-top:16px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <tr>
                <td style="width:50%;padding-right:12px;vertical-align:top;">
                  <div style="font-size:11px;letter-spacing:1px;color:#4b5563;font-weight:600;text-transform:uppercase;">Customer</div>
                  <div style="font-weight:600;margin-top:2px;">${order.user?.name || "—"}</div>
                  <div style="color:#6b7280;line-height:1.45;margin-top:4px;">${order.user?.email || ""}</div>
                </td>
                <td style="width:50%;padding-left:12px;vertical-align:top;text-align:right;">
                  <div style="font-size:11px;letter-spacing:1px;color:#4b5563;font-weight:600;text-transform:uppercase;">Order status</div>
                  <div style="font-weight:600;margin-top:2px;">${order.status}</div>
                  <div style="color:#6b7280;line-height:1.45;margin-top:4px;">Delivery: ${deliveryLabel}</div>
                </td>
              </tr>
            </table>
          </div>

          <div style="margin-top:16px;border:1px solid #e6e8eb;border-radius:8px;overflow:hidden;">
            <table width="100%" cellspacing="0" cellpadding="8" style="border-collapse:collapse;font-size:13px;">
              <thead style="background:#f3f4f6;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:1px;">
                <tr>
                  <th align="left" style="padding:10px 12px;">Item</th>
                  <th align="right" style="padding:10px 12px;">Qty</th>
                  <th align="right" style="padding:10px 12px;">Price</th>
                  <th align="right" style="padding:10px 12px;">Total</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>

          <div style="margin-top:16px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
            <div style="font-size:11px;letter-spacing:1px;color:#4b5563;font-weight:600;text-transform:uppercase;margin-bottom:6px;">Delivery summary</div>
            <ul style="padding-left:16px;margin:0;color:#111827;">
              ${deliveryLines.map((line) => `<li style="margin:4px 0;">${line}</li>`).join("")}
            </ul>
          </div>

          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;border-collapse:collapse;">
            <tr>
              <td style="width:100%;padding-right:0;" align="right">
                <div style="width:340px;max-width:100%;border:1px solid #e6e8eb;border-radius:8px;padding:14px;background:#f9fafb;font-size:13px;display:inline-block;text-align:left;">
              <div style="font-size:11px;letter-spacing:1px;color:#4b5563;font-weight:600;text-transform:uppercase;margin-bottom:4px;">Summary</div>
              <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                ${Math.abs(subtotal - total) > 0.005 || taxAmount > 0 || discountAmount > 0 ? `
                <tr>
                  <td style="padding:6px 0;color:#4b5563;border-bottom:1px solid #eceff3;">Subtotal</td>
                  <td align="right" style="padding:6px 0;border-bottom:1px solid #eceff3;font-weight:600;">${formatCurrency(subtotal)}</td>
                </tr>
                ` : ""}
                ${taxAmount > 0 ? `
                <tr>
                  <td style="padding:6px 0;color:#4b5563;border-bottom:1px solid #eceff3;">Tax ${taxRate ? `(${taxRate}%)` : ""}</td>
                  <td align="right" style="padding:6px 0;border-bottom:1px solid #eceff3;font-weight:600;">${formatCurrency(taxAmount)}</td>
                </tr>` : ""}
                ${discountAmount > 0 ? `
                <tr>
                  <td style="padding:6px 0;color:#92400e;border-bottom:1px solid #eceff3;">Discount</td>
                  <td align="right" style="padding:6px 0;color:#92400e;border-bottom:1px solid #eceff3;font-weight:600;">-${formatCurrency(discountAmount)}</td>
                </tr>` : ""}
                <tr>
                  <td style="padding:8px 0;border-bottom:1px solid #eceff3;font-weight:600;">Invoice total</td>
                  <td align="right" style="padding:8px 0;border-bottom:1px solid #eceff3;font-weight:700;">${formatCurrency(total)}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#4b5563;border-bottom:1px solid #eceff3;">Total paid to date</td>
                  <td align="right" style="padding:8px 0;border-bottom:1px solid #eceff3;font-weight:600;">${formatCurrency(paid)}</td>
                </tr>
                <tr>
                  <td style="padding:10px 0 0;font-weight:700;">New balance</td>
                  <td align="right" style="padding:10px 0 0;font-weight:700;">${formatCurrency(balance)}</td>
                </tr>
              </table>
                </div>
              </td>
            </tr>
          </table>
          ${(order as { receiptHash?: string | null }).receiptHash ? `
          <p style="margin-top:12px;margin-bottom:10px;font-size:10px;color:#9ca3af;">
            Receipt hash: ${(order as { receiptHash?: string | null }).receiptHash}
          </p>` : ""}
          <p style="margin-top:16px;font-size:12px;color:#6b7280;">
            Thank you for your business. If you have any questions about this order, reply to this email or call us.
          </p>
        </div>
      </div>`;

    const text = `Receipt for order ${order.id}. Total paid to date: ${formatCurrency(paid)}. New balance: ${formatCurrency(balance)}.`;
    const res = await sendEmail(
      to,
      `Receipt for Order ${order.id}`,
      text,
      html,
    );
    if (!res.ok)
      return NextResponse.json(
        { error: res.error || "Email failed" },
        { status: 502 },
      );
    return NextResponse.json({
      ok: true,
      simulated: (res as { simulated?: boolean }).simulated === true,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
