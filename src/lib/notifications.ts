"use server";

import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { formatCurrency } from "@/lib/currency";
import { isFeatureEnabled } from "@/lib/features";
import { ADMIN_PHONE } from "@/lib/config";
import { formatInvoiceNumber } from "@/lib/utils";

const normalizeBalance = (value: number) => (Math.abs(value) < 0.01 ? 0 : value);
const formatReceiptDate = (value: Date) =>
  new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);

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
      id: true,
      invoiceNumber: true,
      updatedAt: true,
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
  let pendingItemCount = 0;
  let pendingUnitCount = 0;

  for (const item of order.items) {
    const name = item.product?.name || "Item";
    const delivered = Number(item.deliveredQuantity ?? 0);
    const qty = Number(item.quantity ?? 0);
    if (delivered > 0) {
      deliveredLines.push(`${name}: ${delivered}/${qty} delivered`);
    }
    if (delivered < qty) {
      const remaining = qty - delivered;
      pendingItemCount += 1;
      pendingUnitCount += remaining;
      pendingLines.push(
        `${name}: ${delivered}/${qty} delivered (${remaining} remaining)`
      );
    }
  }

  return {
    orderId: order.id,
    invoiceNumber: order.invoiceNumber,
    updatedAt: order.updatedAt,
    deliveredLines,
    pendingLines,
    pendingItemCount,
    pendingUnitCount,
  };
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
  const rawBalance = Number(order.balance ?? Math.max(0, total - paid));
  const balance = normalizeBalance(rawBalance);
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

  const hasAppliedPayment = typeof appliedAmount === "number" && Number.isFinite(appliedAmount);
  const normalizedApplied = hasAppliedPayment ? Math.max(0, Number(appliedAmount || 0)) : 0;
  const previousBalance = hasAppliedPayment ? normalizeBalance(summary.balance + normalizedApplied) : null;
  const lines = [
    name ? `Hi ${name},` : "Hi,",
    "",
    "Thanks for your order at Noralls Medical Supplies.",
    `Order: ${summary.orderId}.`,
    `Date: ${formatReceiptDate(summary.createdAt)}.`,
    `Order total: ${formatCurrency(summary.total)}.`,
    "",
    "Items:",
  ];
  for (const row of summary.rows) {
    lines.push(`- ${row.name}: ${row.quantity} x ${formatCurrency(row.price)}`);
  }
  lines.push(
    "",
    `Delivery: ${summary.deliveryLabel}.`,
    "Delivery summary:",
    ...summary.deliveryLines.map((line) => `- ${line}`),
    "",
    ...(hasAppliedPayment ? [`This payment applied: ${formatCurrency(normalizedApplied)}.`] : []),
    ...(hasAppliedPayment ? [`Previous balance: ${formatCurrency(previousBalance || 0)}.`] : []),
    `Total paid to date: ${formatCurrency(summary.paid)}.`,
    `New balance: ${formatCurrency(summary.balance)}.`,
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
        <div style="text-align:center;font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#6b7280;margin-bottom:10px;">Receipt</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td style="width:42%;vertical-align:top;">
              <div style="font-size:14px;font-weight:700;letter-spacing:0.2px;">Noralls Medical Supplies</div>
              <div style="font-size:12px;color:#6b7280;line-height:1.5;">Tel: ${ADMIN_PHONE}</div>
            </td>
            <td align="right" style="width:58%;vertical-align:top;">
              <div style="font-size:14px;font-weight:600;line-height:1.4;">Order ${safeOrderId}</div>
              <div style="font-size:12px;color:#6b7280;line-height:1.5;">${formatReceiptDate(summary.createdAt)}</div>
            </td>
          </tr>
        </table>
        <div style="margin-top:16px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr>
              <td style="width:50%;padding-right:12px;vertical-align:top;">
                <div style="font-size:11px;letter-spacing:1px;color:#4b5563;font-weight:600;text-transform:uppercase;">Customer</div>
                <div style="font-weight:600;margin-top:2px;">${name || "Customer"}</div>
                <div style="color:#6b7280;line-height:1.45;margin-top:4px;">${email || ""}</div>
              </td>
              <td style="width:50%;padding-left:12px;vertical-align:top;text-align:right;">
                <div style="font-size:11px;letter-spacing:1px;color:#4b5563;font-weight:600;text-transform:uppercase;">Order status</div>
                <div style="font-weight:600;margin-top:2px;">${escapeHtml(summary.status)}</div>
                <div style="color:#6b7280;line-height:1.45;margin-top:4px;">Delivery: ${escapeHtml(summary.deliveryLabel)}</div>
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
            <tbody>${itemRows}</tbody>
          </table>
        </div>

        <div style="margin-top:12px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
          <div style="font-size:11px;letter-spacing:1px;color:#4b5563;font-weight:600;text-transform:uppercase;margin-bottom:6px;">Delivery</div>
          <div style="font-weight:600;">${summary.deliveryLabel}</div>
          <ul style="padding-left:16px;margin:8px 0 0;color:#111827;">
            ${deliveryList}
          </ul>
        </div>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;border-collapse:collapse;">
          <tr>
            <td style="width:100%;padding-right:0;" align="right">
              <div style="width:340px;max-width:100%;border:1px solid #e6e8eb;border-radius:8px;padding:14px;background:#f9fafb;font-size:13px;display:inline-block;text-align:left;">
            <div style="font-size:11px;letter-spacing:1px;color:#4b5563;font-weight:600;text-transform:uppercase;margin-bottom:4px;">Summary</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <tr>
                <td style="padding:8px 0;border-bottom:1px solid #eceff3;font-weight:600;">Invoice total</td>
                <td align="right" style="padding:8px 0;border-bottom:1px solid #eceff3;font-weight:700;">${formatCurrency(summary.total)}</td>
              </tr>
              ${
                hasAppliedPayment
                  ? `
              <tr>
                <td style="padding:8px 0;color:#4b5563;border-bottom:1px solid #eceff3;">Previous balance</td>
                <td align="right" style="padding:8px 0;border-bottom:1px solid #eceff3;font-weight:600;">${formatCurrency(previousBalance || 0)}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;color:#4b5563;border-bottom:1px solid #eceff3;">This payment</td>
                <td align="right" style="padding:8px 0;border-bottom:1px solid #eceff3;font-weight:600;">${formatCurrency(normalizedApplied)}</td>
              </tr>`
                  : ""
              }
              <tr>
                <td style="padding:8px 0;color:#4b5563;border-bottom:1px solid #eceff3;">Total paid to date</td>
                <td align="right" style="padding:8px 0;border-bottom:1px solid #eceff3;font-weight:600;">${formatCurrency(summary.paid)}</td>
              </tr>
              <tr>
                <td style="padding:10px 0 0;font-weight:700;">New balance</td>
                <td align="right" style="padding:10px 0 0;font-weight:700;">${formatCurrency(summary.balance)}</td>
              </tr>
            </table>
              </div>
            </td>
          </tr>
        </table>

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
        typeof event.amountPaid === "number" ? event.amountPaid : undefined,
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
    await maybeSendSms(
      phone,
      `Noralls: order received. Total ${prettyTotal}${
        prettyPaid ? `; paid so far ${prettyPaid}` : ""
      }. Pay via MoMo or call ${ADMIN_PHONE} if needed.`,
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
      const invoiceRef = formatInvoiceNumber(summary.invoiceNumber);
      lines.push(
        `${invoiceRef ? `INV: ${invoiceRef}` : `Order: ${summary.orderId}`}`,
        `Updated at: ${formatReceiptDate(summary.updatedAt)}`,
      );
      if (event.deliveryStatus === "PARTIALLY_DELIVERED" && summary.pendingUnitCount > 0) {
        lines.push(
          `Remaining items: ${summary.pendingItemCount} line(s), ${summary.pendingUnitCount} unit(s) still pending.`,
        );
      }
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
    const invoiceRef = summary ? formatInvoiceNumber(summary.invoiceNumber) : null;
    const orderRefLabel = invoiceRef ? "INV" : "Order";
    const orderRefValue = invoiceRef || (summary ? summary.orderId : event.orderId);
    const statusLabel = String(event.deliveryStatus || "NOT_DELIVERED")
      .toUpperCase()
      .replace(/_/g, " ");
    const remainingSummary =
      event.deliveryStatus === "PARTIALLY_DELIVERED" &&
      summary &&
      summary.pendingUnitCount > 0
        ? `Remaining items: ${summary.pendingItemCount} line(s), ${summary.pendingUnitCount} unit(s) still pending.`
        : "";
    const updateAtLabel = summary
      ? formatReceiptDate(summary.updatedAt)
      : formatReceiptDate(new Date());
    const html = `
      <div style="margin:0;padding:24px;background-color:#f6f7f9;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e6e8eb;border-radius:12px;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
          <div style="text-align:center;font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#6b7280;margin-bottom:10px;">Delivery update</div>
          <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr>
              <td style="width:50%;vertical-align:top;">
                <div style="font-size:14px;font-weight:700;letter-spacing:0.2px;">Noralls Medical Supplies</div>
                <div style="font-size:12px;color:#6b7280;">Tel: ${ADMIN_PHONE}</div>
              </td>
              <td style="width:50%;vertical-align:top;text-align:right;">
                <div style="font-size:14px;font-weight:600;">${orderRefLabel}: ${escapeHtml(orderRefValue)}</div>
                <div style="font-size:12px;color:#6b7280;">Updated: ${escapeHtml(updateAtLabel)}</div>
              </td>
            </tr>
          </table>

          <div style="margin-top:10px;font-size:14px;font-weight:600;color:#111827;">Status: ${escapeHtml(statusLabel)}</div>
          ${
            remainingSummary
              ? `<div style="margin-top:4px;font-size:12px;color:#6b7280;">${escapeHtml(remainingSummary)}</div>`
              : ""
          }

          <div style="margin-top:16px;border:1px solid #e6e8eb;border-radius:8px;padding:12px;background:#f9fafb;font-size:13px;">
            <div style="font-size:11px;letter-spacing:1px;color:#4b5563;font-weight:600;text-transform:uppercase;">Customer</div>
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
        event.amount,
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
    await maybeSendSms(
      phone,
      `Noralls Medical Supplies: payment received and applied to your account.`,
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
            <div style="font-size:11px;letter-spacing:1px;color:#4b5563;font-weight:600;text-transform:uppercase;">Customer</div>
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
