"use server";

import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { formatCurrency } from "@/lib/currency";
import { isFeatureEnabled } from "@/lib/features";
import { ADMIN_PHONE } from "@/lib/config";

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
) {
  if (!to) return;
  try {
    const r = await sendEmail(to, subject, text);
    if (!r.ok) {
      console.warn("Email notification failed:", r.error);
    }
  } catch (e) {
    console.warn("Email notification error:", e);
  }
}

export async function notifyOrderEvent(event: OrderEvent) {
  const contact = await getUserContact(event.userId);
  if (!contact) return;

  if (event.kind === "order_created") {
    const { email, phone, name } = contact;
    const prettyTotal = formatCurrency(event.total || 0);
    const prettyPaid =
      typeof event.amountPaid === "number" && event.amountPaid > 0
        ? formatCurrency(event.amountPaid)
        : null;

    const subject = "We’ve received your order";
    const lines = [
      name ? `Hi ${name},` : "Hi,",
      "",
      "We have received your order at Noralls Medical Supplies.",
      `Order total: ${prettyTotal}.`,
    ];
    if (prettyPaid) {
      lines.push(`Payment recorded so far: ${prettyPaid}.`);
    }
    lines.push(
      "",
      "You can pay your outstanding balance via Mobile Money (MoMo) or arrange payment by phone with our team.",
      `If you have questions about payment, please call ${ADMIN_PHONE}.`,
      "",
      "Any store credit on your account can be applied to your unpaid orders, starting with the oldest balance.",
      "Our team will contact you if we need any additional details about delivery or payment.",
      "",
      "Thank you for choosing Noralls.",
    );
    const text = lines.join("\n");

    await maybeSendEmail(email, subject, text);
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
    const lines = [
      name ? `Hi ${name},` : "Hi,",
      "",
      `The delivery status of your order has been updated to: ${humanStatus}.`,
      "",
      "If you have any questions about this delivery, please contact Noralls Medical Supplies.",
    ];
    const text = lines.join("\n");

    await maybeSendEmail(email, subject, text);
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
    await maybeSendSms(
      phone,
      `Noralls Medical Supplies: payment of ${prettyAmount} received and applied to your outstanding orders.`,
    );
    return;
  }

  if (event.kind === "store_credit_issued") {
    const prettyAmount = formatCurrency(event.amount);
    const subject = "Store credit issued to your account";
    const lines = [
      name ? `Hi ${name},` : "Hi,",
      "",
      `Store credit of ${prettyAmount} has been added to your account.`,
      "This credit can be applied to future or existing orders and will be used on your oldest balance first.",
      "",
      "Thank you.",
    ];
    const text = lines.join("\n");
    await maybeSendEmail(email, subject, text);
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
