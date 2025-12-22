import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { sendSms } from "@/lib/sms";
import { isFeatureEnabled } from "@/lib/features";
import { formatCurrency } from "@/lib/currency";

const SMS_NOTIFICATIONS_ENABLED =
  (process.env.SMS_NOTIFICATIONS_ENABLED || "").toLowerCase() === "1";

function getBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.NEXTAUTH_URL ||
    "http://localhost:3000"
  );
}

export async function notifyBackInStock(productId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, price: true, stock: true },
  });
  if (!product) return;
  if (Number(product.stock || 0) <= 0) return;

  const subs = await prisma.stockAlert.findMany({
    where: { productId, notifiedAt: null },
    select: {
      id: true,
      email: true,
      phone: true,
      user: { select: { name: true } },
    },
  });
  if (subs.length === 0) return;

  const baseUrl = getBaseUrl();
  const productUrl = `${baseUrl}/products/${product.id}`;
  const subject = `Back in stock: ${product.name}`;
  const prettyPrice = formatCurrency(Number(product.price || 0));

  const smsAllowed = await isFeatureEnabled(
    "sms_notifications",
    SMS_NOTIFICATIONS_ENABLED,
  );

  const sentIds: string[] = [];
  for (const sub of subs) {
    const name = sub.user?.name || undefined;
    const greeting = name ? `Hi ${name},` : "Hi,";
    const text = [
      greeting,
      "",
      `Good news — ${product.name} is back in stock.`,
      `Price: ${prettyPrice}.`,
      `Shop now: ${productUrl}`,
      "",
      "If you no longer want these alerts, simply ignore this message.",
    ].join("\n");

    const html = `
      <div style="margin:0;padding:24px;background-color:#f6f7f9;">
        <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e6e8eb;border-radius:12px;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
          <div style="font-size:14px;font-weight:700;letter-spacing:0.2px;">Noralls Medical Supplies</div>
          <p style="margin:16px 0 0;font-size:14px;">${greeting}</p>
          <p style="margin:8px 0 0;font-size:14px;">Good news — <strong>${product.name}</strong> is back in stock.</p>
          <p style="margin:8px 0 0;font-size:14px;">Price: <strong>${prettyPrice}</strong></p>
          <div style="margin-top:16px;">
            <a href="${productUrl}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;">View product</a>
          </div>
          <p style="margin-top:16px;font-size:12px;color:#6b7280;">
            If you no longer want these alerts, simply ignore this message.
          </p>
        </div>
      </div>`;

    let sent = false;
    if (sub.email) {
      try {
        const res = await sendEmail(sub.email, subject, text, html);
        if (res.ok) sent = true;
      } catch (e) {
        console.warn("Back-in-stock email error:", e);
      }
    }
    if (smsAllowed && sub.phone) {
      try {
        const res = await sendSms(
          sub.phone,
          `Noralls: ${product.name} is back in stock. ${productUrl}`,
        );
        if (res.ok) sent = true;
      } catch (e) {
        console.warn("Back-in-stock SMS error:", e);
      }
    }
    if (sent) sentIds.push(sub.id);
  }

  if (sentIds.length > 0) {
    await prisma.stockAlert.updateMany({
      where: { id: { in: sentIds } },
      data: { notifiedAt: new Date() },
    });
  }
}
