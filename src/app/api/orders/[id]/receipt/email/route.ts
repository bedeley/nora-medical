import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { formatInvoiceNumber } from "@/lib/utils";

const schema = z.object({ to: z.string().email().optional() });

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
    const balance = Math.max(0, total - paid);
    const base = process.env.NEXT_PUBLIC_BASE_URL || `${url.protocol}//${url.host}`;
    const receiptToken = (order as { receiptHash?: string | null }).receiptHash;
    const receiptUrl = receiptToken
      ? `${base}/orders/${order.id}/receipt?receipt=${encodeURIComponent(receiptToken)}`
      : `${base}/login?callbackUrl=${encodeURIComponent(`/orders/${order.id}/receipt`)}`;
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
          <td align="right" style="padding:8px 12px;border-top:1px solid #e6e8eb;">${Number(i.price).toFixed(2)}</td>
          <td align="right" style="padding:8px 12px;border-top:1px solid #e6e8eb;">${(Number(i.price) * i.quantity).toFixed(2)}</td>
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
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr>
              <td style="vertical-align:top;">
                <div style="font-size:14px;font-weight:700;letter-spacing:0.2px;">Noralls Medical Supplies</div>
                <div style="font-size:12px;color:#6b7280;line-height:1.5;">Tel: ${process.env.NEXT_PUBLIC_ADMIN_PHONE || "N/A"}</div>
              </td>
              <td align="right" style="vertical-align:top;">
                <div style="font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#6b7280;">Receipt</div>
                <div style="font-size:14px;font-weight:600;line-height:1.4;">${(() => {
                  const formatted = formatInvoiceNumber((order as { invoiceNumber?: string | null }).invoiceNumber);
                  return formatted ? `INV: ${formatted}` : `Order ${order.id}`;
                })()}</div>
                <div style="font-size:12px;color:#6b7280;line-height:1.5;">${order.createdAt.toISOString()}</div>
              </td>
            </tr>
          </table>

          <div style="margin-top:16px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;display:flex;justify-content:space-between;gap:12px;">
            <div>
              <div style="font-size:11px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;">Customer</div>
              <div style="font-weight:600;">${order.user?.name || "—"}</div>
              <div style="color:#6b7280;">${order.user?.email || ""}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:11px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;">Order Status</div>
              <div style="font-weight:600;">${order.status}</div>
              <div style="color:#6b7280;">Delivery: ${deliveryLabel}</div>
            </div>
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
            <div style="font-size:11px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;margin-bottom:6px;">Delivery summary</div>
            <ul style="padding-left:16px;margin:0;color:#111827;">
              ${deliveryLines.map((line) => `<li style="margin:4px 0;">${line}</li>`).join("")}
            </ul>
          </div>

          <div style="margin-top:16px;display:flex;justify-content:flex-end;">
            <div style="min-width:220px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                <span>Subtotal</span>
                <strong>${subtotal.toFixed(2)}</strong>
              </div>
              ${taxAmount > 0 ? `
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                <span>Tax ${taxRate ? `(${taxRate}%)` : ""}</span>
                <strong>${taxAmount.toFixed(2)}</strong>
              </div>` : ""}
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                <span>Total</span>
                <strong>${total.toFixed(2)}</strong>
              </div>
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                <span>Paid</span>
                <strong>${paid.toFixed(2)}</strong>
              </div>
              <div style="display:flex;justify-content:space-between;font-weight:700;">
                <span>Balance</span>
                <span>${balance.toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div style="margin-top:12px;font-size:12px;color:#0f766e;">
            <a href="${receiptUrl}" style="color:#0f766e;word-break:break-all;">View receipt</a>
          </div>
          ${(order as { receiptHash?: string | null }).receiptHash ? `
          <p style="margin-top:12px;font-size:11px;color:#6b7280;">
            Receipt hash: ${(order as { receiptHash?: string | null }).receiptHash}
          </p>` : ""}
          <p style="margin-top:16px;font-size:12px;color:#6b7280;">
            Thank you for your business. If you have any questions about this order, reply to this email or call us.
          </p>
        </div>
      </div>`;

    const text = `Receipt for order ${order.id}. View receipt: ${receiptUrl}`;
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
