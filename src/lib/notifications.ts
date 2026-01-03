"use server";

import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { formatCurrency } from "@/lib/currency";
import { isFeatureEnabled } from "@/lib/features";
import { ADMIN_PHONE } from "@/lib/config";

function buildOrderReceiptUrl(orderId: string, receiptHash?: string | null) {
  const base =
    (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/$/, "") ||
    (process.env.NEXTAUTH_URL || "").replace(/\/$/, "");
  if (!base) return "";
  const token = receiptHash ? `?receipt=${encodeURIComponent(receiptHash)}` : "";
  return `${base}/orders/${orderId}/receipt${token}`;
}

const SMS_NOTIFICATIONS_ENABLED =
  (process.env.SMS_NOTIFICATIONS_ENABLED || "").toLowerCase() === "1";

type OrderEvent =
  | {
      kind: "order_created";
      userId: string;
      orderId: string;
      total: number;
      amountPaid?: number;
    }
  | {
      kind: "order_cancelled";
      userId: string;
      orderId: string;
      total: number;
      amountPaid: number;
    }
  | {
      kind: "order_delivery_updated";
      userId: string;
      orderId: string;
      deliveryStatus: "DELIVERED" | "PARTIALLY_DELIVERED" | "RETURNED";
    };

type PaymentEvent =
  | {
      kind: "payment_recorded";
      userId: string;
      amount: number;
      orderId?: string;
      subject?: string;
    }
  | {
      kind: "payment_refunded";
      userId: string;
      amount: number;
      method: "cash" | "transfer";
    }
  | {
      kind: "store_credit_issued";
      userId: string;
      amount: number;
      orderId?: string;
      itemName?: string;
      quantity?: number;
    }
  | {
      kind: "store_credit_refunded";
      userId: string;
      amount: number;
      method: "cash" | "transfer";
    };

async function getUserContact(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, phone: true, name: true },
  });
  if (!user) return null;
  const name = user.name || undefined;
  const email = user.email || undefined;
  const phone = (user.phone || "").trim() || undefined;
  if (!email && !phone) return null;
  return { name, email, phone };
}

async function maybeSendSms(to: string | undefined, body: string) {
  const allowed = await isFeatureEnabled("sms_notifications", SMS_NOTIFICATIONS_ENABLED);
  if (!allowed || !to) return;
  try {
    const r = await sendSms(to, body);
    if (!r.ok) {
      console.warn("SMS notification failed:", r.error);
    }
  } catch (e) {
    console.warn("SMS notification error:", e);
  }
}

async function maybeSendEmail(
  to: string | undefined,
  subject: string,
  text: string,
  html?: string,
) {
  if (!to) return;
  try {
    const r = await sendEmail(to, subject, text, html);
    if (!r.ok) {
      console.warn("Email notification failed:", r.error);
    }
  } catch (e) {
    console.warn("Email notification error:", e);
  }
}

async function getOrderDeliverySummary(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      items: {
        select: {
          quantity: true,
          deliveredQuantity: true,
          product: { select: { name: true } },
        },
      },
    },
  });
  if (!order) return null;

  const deliveredLines: string[] = [];
  const pendingLines: string[] = [];

  for (const item of order.items) {
    const name = item.product?.name || "Item";
    const delivered = Number(item.deliveredQuantity ?? 0);
    const qty = Number(item.quantity ?? 0);
    if (delivered > 0) {
      deliveredLines.push(`${name}: ${delivered}/${qty} delivered`);
    }
    if (delivered < qty) {
      const remaining = qty - delivered;
      pendingLines.push(
        `${name}: ${delivered}/${qty} delivered (${remaining} remaining)`
      );
    }
  }

  return { deliveredLines, pendingLines };
}

async function getOrderReceiptSummary(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      receiptHash: true,
      total: true,
      amountPaid: true,
      balance: true,
      status: true,
      deliveryStatus: true,
      createdAt: true,
      items: {
        select: {
          quantity: true,
          price: true,
          deliveredQuantity: true,
          product: { select: { name: true } },
        },
      },
    },
  });
  if (!order) return null;

  const total = Number(order.total || 0);
  const paid = Number(order.amountPaid || 0);
  const balance = Number(
    order.balance ?? Math.max(0, total - paid),
  );
  const deliveryLabel = (() => {
    const raw = String(order.deliveryStatus || "NOT_DELIVERED").toUpperCase();
    if (raw === "DELIVERED") return "Delivered";
    if (raw === "PARTIALLY_DELIVERED") return "Partially delivered";
    if (raw === "RETURNED") return "Returned";
    return "Not delivered";
  })();

  const rows = order.items.map((i) => ({
    name: i.product?.name || "Item",
    quantity: Number(i.quantity || 0),
    price: Number(i.price || 0),
    deliveredQuantity: Number(i.deliveredQuantity ?? 0),
  }));

  const deliveryLines = rows.map((item) => {
    const remaining = Math.max(0, item.quantity - item.deliveredQuantity);
    return `${item.name}: ${item.deliveredQuantity}/${item.quantity} delivered (${remaining} remaining)`;
  });

  return {
    orderId: order.id,
    receiptHash: order.receiptHash || null,
    createdAt: order.createdAt,
    total,
    paid,
    balance,
    status: order.status,
    deliveryLabel,
    rows,
    deliveryLines,
  };
}

function buildReceiptEmail(
  summary: NonNullable<Awaited<ReturnType<typeof getOrderReceiptSummary>>>,
  name?: string,
  email?: string,
  appliedAmount?: number,
) {
  const escapeHtml = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const safeOrderId = escapeHtml(summary.orderId);

  const lines = [
    name ? `Hi ${name},` : "Hi,",
    "",
    "Thanks for your order at Noralls Medical Supplies.",
    `Order total: ${formatCurrency(summary.total)}.`,
    "",
    "Items:",
  ];
  for (const row of summary.rows) {
    lines.push(`- ${row.name}: ${row.quantity} x ${formatCurrency(row.price)}`);
  }
  const receiptUrl = buildOrderReceiptUrl(
    summary.orderId,
    summary.receiptHash,
  );
  if (receiptUrl) {
    lines.push("", `View receipt: ${receiptUrl}`);
  }
  lines.push(
    "",
    `Delivery: ${summary.deliveryLabel}.`,
    "Delivery summary:",
    ...summary.deliveryLines.map((line) => `- ${line}`),
    "",
    ...(appliedAmount != null
      ? [`Applied this payment: ${formatCurrency(appliedAmount)}.`]
      : []),
    `Paid: ${formatCurrency(summary.paid)}.`,
    `Balance: ${formatCurrency(summary.balance)}.`,
    "",
    "If you have any questions about this order, please contact Noralls Medical Supplies.",
  );
  const text = lines.join("\n");

  const itemRows = summary.rows
    .map(
      (row) => `
      <tr>
        <td style="padding:8px 12px;border-top:1px solid #e6e8eb;">${escapeHtml(row.name)}</td>
        <td align="right" style="padding:8px 12px;border-top:1px solid #e6e8eb;">${row.quantity}</td>
        <td align="right" style="padding:8px 12px;border-top:1px solid #e6e8eb;">${formatCurrency(row.price)}</td>
        <td align="right" style="padding:8px 12px;border-top:1px solid #e6e8eb;">${formatCurrency(row.price * row.quantity)}</td>
      </tr>`
    )
    .join("");
  const deliveryList = summary.deliveryLines
    .map((line) => `<li style="margin:4px 0;">${escapeHtml(line)}</li>`)
    .join("");

  const html = `
    <div style="margin:0;padding:24px;background-color:#f6f7f9;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e6e8eb;border-radius:12px;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
        <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;">
            <div>
              <div style="font-size:14px;font-weight:700;letter-spacing:0.2px;">Noralls Medical Supplies</div>
              <div style="font-size:12px;color:#6b7280;">Tel: ${ADMIN_PHONE}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#6b7280;">Receipt</div>
              <div style="font-size:14px;font-weight:600;">Order ${safeOrderId}</div>
              <div style="font-size:12px;color:#6b7280;">${summary.createdAt.toISOString()}</div>
            </div>
          </div>

        ${
          receiptUrl
            ? `
        <div style="margin-top:16px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
          <div style="font-size:11px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;">Receipt link</div>
          <a href="${receiptUrl}" style="display:block;margin-top:6px;color:#0f766e;word-break:break-all;">${receiptUrl}</a>
        </div>`
            : ""
        }
        <div style="margin-top:16px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
          <div style="font-size:11px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;">Customer</div>
          <div style="font-weight:600;">${name || "Customer"}</div>
          <div style="color:#6b7280;">${email || ""}</div>
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
            <tbody>${itemRows}</tbody>
          </table>
        </div>

        <div style="margin-top:12px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
          <div style="font-size:11px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;margin-bottom:6px;">Delivery</div>
          <div style="font-weight:600;">${summary.deliveryLabel}</div>
          <ul style="padding-left:16px;margin:8px 0 0;color:#111827;">
            ${deliveryList}
          </ul>
        </div>

        <div style="margin-top:16px;display:flex;justify-content:flex-end;">
          <div style="min-width:220px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span>Total</span>
              <strong>${formatCurrency(summary.total)}</strong>
            </div>
            ${
              appliedAmount != null
                ? `
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span>Applied this payment</span>
              <strong>${formatCurrency(appliedAmount)}</strong>
            </div>`
                : ""
            }
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span>Paid</span>
              <strong>${formatCurrency(summary.paid)}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;font-weight:700;">
              <span>Balance</span>
              <span>${formatCurrency(summary.balance)}</span>
            </div>
          </div>
        </div>

        <p style="margin-top:16px;font-size:12px;color:#6b7280;">
          If you have any questions about this order, please contact Noralls Medical Supplies.
        </p>
      </div>
    </div>`;

  return { text, html };
}

export async function notifyOrderEvent(event: OrderEvent) {
  const contact = await getUserContact(event.userId);
  if (!contact) return;

  if (event.kind === "order_created") {
    const { email, phone, name } = contact;
    const prettyTotal = formatCurrency(event.total || 0);
    const prettyPaid = event.amountPaid ? formatCurrency(event.amountPaid) : "";
    const summary = await getOrderReceiptSummary(event.orderId);
    if (summary) {
      const subject = "Order Confirmation & Receipt";
      const { text, html } = buildReceiptEmail(
        summary,
        name,
        email || undefined,
        typeof event.amountPaid === "number" ? event.amountPaid : undefined
      );
      await maybeSendEmail(email, subject, text, html);
    } else {
      const subject = "We’ve received your order";
      const text = [
        name ? `Hi ${name},` : "Hi,",
        "",
        "We have received your order at Noralls Medical Supplies.",
        `Order total: ${prettyTotal}.`,
        "",
        "You can pay your outstanding balance via Mobile Money (MoMo) or arrange payment by phone with our team.",
        `If you have questions about payment, please call ${ADMIN_PHONE}.`,
        "",
        "Thank you for choosing Noralls.",
      ].join("\n");
      await maybeSendEmail(email, subject, text);
    }
    const receiptUrl = buildOrderReceiptUrl(event.orderId, summary?.receiptHash);
    await maybeSendSms(
      phone,
      `Noralls: order received. Total ${prettyTotal}${
        prettyPaid ? `; paid so far ${prettyPaid}` : ""
      }.${receiptUrl ? ` Receipt: ${receiptUrl}` : ""} Pay via MoMo or call ${ADMIN_PHONE} if needed.`,
    );
    return;
  }

  if (event.kind === "order_cancelled") {
    const { email, phone, name } = contact;
    const subject = "Your order has been cancelled";
    const prettyAmount = formatCurrency(event.amountPaid || 0);
    const lines = [
      name ? `Hi ${name},` : "Hi,",
      "",
      "Your order has been cancelled by Noralls Medical Supplies.",
    ];
    if (event.amountPaid > 0) {
      lines.push(
        `We have ${prettyAmount} recorded against this order. Any applicable store credit or refunds will be reflected on your account statement.`,
      );
    }
    lines.push(
      "",
      "If this cancellation is unexpected, please contact us so we can review it with you.",
    );
    const text = lines.join("\n");

    await maybeSendEmail(email, subject, text);
    await maybeSendSms(
      phone,
      `Noralls Medical Supplies: your order has been cancelled.${
        event.amountPaid > 0
          ? ` We have ${prettyAmount} recorded; any credit or refund will appear on your account.`
          : ""
      }`,
    );
    return;
  }

  if (event.kind === "order_delivery_updated") {
    const { email, phone, name } = contact;
    let humanStatus = "updated";
    if (event.deliveryStatus === "DELIVERED") humanStatus = "delivered";
    else if (event.deliveryStatus === "PARTIALLY_DELIVERED")
      humanStatus = "partially delivered";
    else if (event.deliveryStatus === "RETURNED") humanStatus = "returned";

    const subject = `Your order delivery status is now ${humanStatus}`;
    let summary: Awaited<ReturnType<typeof getOrderDeliverySummary>> | null = null;
    try {
      summary = await getOrderDeliverySummary(event.orderId);
    } catch (e) {
      console.warn("Delivery summary lookup failed:", e);
    }
    const lines = [
      name ? `Hi ${name},` : "Hi,",
      "",
      `The delivery status of your order has been updated to: ${humanStatus}.`,
    ];
    if (summary) {
      if (summary.deliveredLines.length > 0) {
        lines.push("", "Items delivered so far:");
        lines.push(...summary.deliveredLines.map((line) => `- ${line}`));
      }
      if (summary.pendingLines.length > 0) {
        lines.push("", "Items still pending delivery:");
        lines.push(...summary.pendingLines.map((line) => `- ${line}`));
      }
    }
    lines.push(
      "",
      "If you have any questions about this delivery, please contact Noralls Medical Supplies.",
    );
    const text = lines.join("\n");
    const escapeHtml = (value: string) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const safeName = escapeHtml(name || "Customer");
    const safeEmail = escapeHtml(email || "");
    const html = `
      <div style="margin:0;padding:24px;background-color:#f6f7f9;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e6e8eb;border-radius:12px;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
          <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;">
            <div>
              <div style="font-size:14px;font-weight:700;letter-spacing:0.2px;">Noralls Medical Supplies</div>
              <div style="font-size:12px;color:#6b7280;">Tel: ${ADMIN_PHONE}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#6b7280;">Delivery update</div>
              <div style="font-size:14px;font-weight:600;">Status: ${humanStatus}</div>
            </div>
          </div>

          <div style="margin-top:16px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
            <div style="font-size:11px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;">Customer</div>
            <div style="font-weight:600;">${safeName}</div>
            <div style="color:#6b7280;">${safeEmail}</div>
          </div>
    `;

    const deliveredHtml =
      summary && summary.deliveredLines.length > 0
        ? `
          <div style="margin-top:16px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
            <div style="font-size:11px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;margin-bottom:6px;">Items delivered so far</div>
            <ul style="padding-left:16px;margin:0;color:#111827;">
              ${summary.deliveredLines
                .map((line) => `<li style="margin:4px 0;">${escapeHtml(line)}</li>`)
                .join("")}
            </ul>
          </div>
        `
        : "";
    const pendingHtml =
      summary && summary.pendingLines.length > 0
        ? `
          <div style="margin-top:12px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
            <div style="font-size:11px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;margin-bottom:6px;">Items still pending delivery</div>
            <ul style="padding-left:16px;margin:0;color:#111827;">
              ${summary.pendingLines
                .map((line) => `<li style="margin:4px 0;">${escapeHtml(line)}</li>`)
                .join("")}
            </ul>
          </div>
        `
        : "";

    const htmlTail = `
          ${deliveredHtml}
          ${pendingHtml}
          <p style="margin-top:16px;font-size:12px;color:#6b7280;">
            If you have any questions about this delivery, please contact Noralls Medical Supplies.
          </p>
        </div>
      </div>`;

    await maybeSendEmail(email, subject, text, html + htmlTail);
    await maybeSendSms(
      phone,
      `Noralls Medical Supplies: your order delivery status is now ${humanStatus}.`,
    );
    return;
  }
}

export async function notifyPaymentEvent(event: PaymentEvent) {
  const contact = await getUserContact(event.userId);
  if (!contact) return;
  const { email, phone, name } = contact;

  if (event.kind === "payment_recorded") {
    const summary = event.orderId
      ? await getOrderReceiptSummary(event.orderId)
      : null;
    if (summary) {
      const subject = event.subject || "Order Confirmation & Receipt";
      const { text, html } = buildReceiptEmail(
        summary,
        name,
        email || undefined,
        event.amount
      );
      await maybeSendEmail(email, subject, text, html);
    } else {
      const prettyAmount = formatCurrency(event.amount);
      const subject = "Payment received on your account";
      const lines = [
        name ? `Hi ${name},` : "Hi,",
        "",
        `We have recorded a payment of ${prettyAmount} on your account.`,
        "This payment has been applied to your outstanding orders, starting from the oldest balance.",
        "",
        "Thank you for your prompt payment.",
      ];
      const text = lines.join("\n");
      await maybeSendEmail(email, subject, text);
    }
    const receiptUrl = event.orderId
      ? buildOrderReceiptUrl(event.orderId, summary?.receiptHash)
      : "";
    await maybeSendSms(
      phone,
      `Noralls Medical Supplies: payment received and applied to your account.${receiptUrl ? ` Receipt: ${receiptUrl}` : ""}`,
    );
    return;
  }

  if (event.kind === "store_credit_issued") {
    const prettyAmount = formatCurrency(event.amount);
    const escapeHtml = (value: string) =>
      value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const safeName = escapeHtml(name || "Customer");
    const safeOrderId = escapeHtml(event.orderId || "");
    const safeItemName = escapeHtml(event.itemName || "");
    const quantity = Number(event.quantity || 0);
    const subject = "Return processed — store credit issued";
    const lines = [
      name ? `Hi ${name},` : "Hi,",
      "",
      `We processed your return and issued store credit of ${prettyAmount}.`,
    ];
    if (event.orderId) {
      lines.push(`Order: ${event.orderId}.`);
    }
    if (event.itemName && quantity > 0) {
      lines.push(`Item returned: ${event.itemName} (Qty ${quantity}).`);
    }
    lines.push(
      "Refund method: Store credit.",
      "",
      "This credit can be applied to future or existing orders and will be used on your oldest balance first.",
      "",
      "If you have any questions about this return, please contact Noralls Medical Supplies.",
    );
    const text = lines.join("\n");
    const orderLine = event.orderId
      ? `
          <div style="display:flex;justify-content:space-between;">
            <span>Order</span>
            <span>${safeOrderId}</span>
          </div>
        `
      : "";
    const itemLine =
      event.itemName && quantity > 0
        ? `
          <div style="display:flex;justify-content:space-between;margin-top:6px;">
            <span>Item returned</span>
            <span>${safeItemName} × ${quantity}</span>
          </div>
        `
        : "";
    const html = `
      <div style="margin:0;padding:24px;background-color:#f6f7f9;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e6e8eb;border-radius:12px;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
          <div style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;">
            <div>
              <div style="font-size:14px;font-weight:700;letter-spacing:0.2px;">Noralls Medical Supplies</div>
              <div style="font-size:12px;color:#6b7280;">Tel: ${ADMIN_PHONE}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#6b7280;">Return update</div>
              <div style="font-size:14px;font-weight:600;">Store credit issued</div>
            </div>
          </div>

          <div style="margin-top:16px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
            <div style="font-size:11px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;">Customer</div>
            <div style="font-weight:600;">${safeName}</div>
            <div style="color:#6b7280;">${escapeHtml(email || "")}</div>
          </div>

          <div style="margin-top:16px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
            <div style="font-size:11px;letter-spacing:1px;color:#6b7280;text-transform:uppercase;margin-bottom:6px;">Return details</div>
            ${orderLine}
            ${itemLine}
            <div style="display:flex;justify-content:space-between;margin-top:6px;">
              <span>Refund method</span>
              <span>Store credit</span>
            </div>
          </div>

          <div style="margin-top:16px;display:flex;justify-content:flex-end;">
            <div style="min-width:220px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
              <div style="display:flex;justify-content:space-between;font-weight:700;">
                <span>Store credit issued</span>
                <span>${prettyAmount}</span>
              </div>
            </div>
          </div>

          <p style="margin-top:16px;font-size:12px;color:#6b7280;">
            This credit can be applied to future or existing orders and will be used on your oldest balance first.
          </p>
          <p style="margin-top:6px;font-size:12px;color:#6b7280;">
            If you have any questions about this return, please contact Noralls Medical Supplies.
          </p>
        </div>
      </div>`;
    await maybeSendEmail(email, subject, text, html);
    await maybeSendSms(
      phone,
      `Noralls Medical Supplies: store credit of ${prettyAmount} has been added to your account.`,
    );
    return;
  }

  if (event.kind === "store_credit_refunded") {
    const prettyAmount = formatCurrency(event.amount);
    const channel =
      event.method === "transfer" ? "MoMo transfer" : "cash refund";
    const subject = "Store credit refunded";
    const lines = [
      name ? `Hi ${name},` : "Hi,",
      "",
      `We have refunded ${prettyAmount} of your store credit via ${channel}.`,
      "",
      "If this looks incorrect, please contact Noralls Medical Supplies so we can investigate.",
    ];
    const text = lines.join("\n");
    await maybeSendEmail(email, subject, text);
    await maybeSendSms(
      phone,
      `Noralls Medical Supplies: ${prettyAmount} of your store credit has been refunded via ${channel}.`,
    );
    return;
  }

  if (event.kind === "payment_refunded") {
    const prettyAmount = formatCurrency(event.amount);
    const channel =
      event.method === "transfer" ? "MoMo transfer" : "cash refund";
    const subject = "Refund processed on your account";
    const lines = [
      name ? `Hi ${name},` : "Hi,",
      "",
      `We have processed a refund of ${prettyAmount} via ${channel} for returned item(s) on your order.`,
      "",
      "If this looks incorrect, please contact Noralls Medical Supplies so we can investigate.",
    ];
    const text = lines.join("\n");
    await maybeSendEmail(email, subject, text);
    await maybeSendSms(
      phone,
      `Noralls Medical Supplies: refund of ${prettyAmount} has been processed via ${channel} for returned item(s) on your order.`,
    );
    return;
  }
}
