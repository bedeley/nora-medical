import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";

function getExpiryDate(updatedAt: Date, validityDays: number) {
  const base = new Date(updatedAt);
  base.setUTCDate(base.getUTCDate() + Math.max(0, Number(validityDays || 0)));
  return base;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-b2b-tender-reminder", 60_000, 20);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const params = await context.params;
  const tender = await prisma.tender.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      tenderNumber: true,
      buyerName: true,
      buyerEmail: true,
      currency: true,
      total: true,
      status: true,
      updatedAt: true,
      validityDays: true,
      sentAt: true,
      recipients: {
        where: { recipientType: "TO", deliveryChannel: "EMAIL" },
        orderBy: { lastSentAt: "desc" },
        take: 1,
        select: { email: true },
      },
    },
  });
  if (!tender) return NextResponse.json({ error: "Tender not found" }, { status: 404 });
  if (!["SUBMITTED", "SENT"].includes(tender.status)) {
    return NextResponse.json({ error: "Reminder is only available for SUBMITTED/SENT tenders." }, { status: 409 });
  }

  const recipient = tender.recipients[0]?.email || tender.buyerEmail || "";
  if (!recipient) {
    return NextResponse.json({ error: "No recipient email found for reminder." }, { status: 409 });
  }

  const expiryDate = getExpiryDate(tender.sentAt || tender.updatedAt, tender.validityDays);
  const daysToExpiry = Math.ceil((expiryDate.getTime() - Date.now()) / (24 * 3600 * 1000));
  const subject = `Reminder: Tender ${tender.tenderNumber} expires in ${Math.max(0, daysToExpiry)} day(s)`;
  const text = [
    `Dear ${tender.buyerName},`,
    "",
    `This is a reminder for Tender ${tender.tenderNumber}.`,
    `Total: ${tender.currency} ${Number(tender.total || 0).toFixed(2)}`,
    `Expiry date: ${expiryDate.toISOString().slice(0, 10)}`,
    "",
    "Please let us know if you need any clarification.",
    "",
    "Regards,",
    "Noralls Medical Supplies",
  ].join("\n");
  const html = text.replace(/\n/g, "<br/>");
  const sent = await sendEmail(recipient, subject, text, html);
  if (!sent.ok) {
    return NextResponse.json({ error: sent.error || "Failed to send reminder" }, { status: 500 });
  }

  const now = new Date();
  await prisma.tenderRecipient.create({
    data: {
      tenderId: tender.id,
      recipientType: "TO",
      email: recipient,
      deliveryChannel: "EMAIL",
      deliveryStatus: "SENT",
      lastSentAt: now,
      sentById: user?.id || null,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: "B2B_TENDER_REMINDER_SENT",
      entityType: "B2B_TENDER",
      entityId: tender.id,
      outcome: "SUCCESS",
      meta: JSON.stringify({
        sourcePage: "admin/b2b/tenders",
        operation: "send_reminder",
        tenderNumber: tender.tenderNumber,
        buyerName: tender.buyerName,
        recipient,
        daysToExpiry,
        expiryDate: expiryDate.toISOString(),
        actor: { id: user?.id || null, email: user?.email || null, name: user?.name || null },
      }),
    },
  });

  return NextResponse.json({
    ok: true,
    recipient,
    daysToExpiry,
    expiryDate: expiryDate.toISOString(),
  });
}

