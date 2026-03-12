import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { sendWhatsApp } from "@/lib/whatsapp";
import { sendSms } from "@/lib/sms";

export type ProcurementRequestSnapshot = {
  id: string;
  customerId: string;
  requestType: "QUOTE" | "PO_UPLOAD" | "RECURRING_REORDER";
  status: "SUBMITTED" | "IN_REVIEW" | "QUOTED" | "APPROVED" | "REJECTED" | "CLOSED";
  clinicName: string;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  notes: string | null;
  poDocumentUrl: string | null;
  templateId: string | null;
  itemsText: string | null;
  accountManagerId: string | null;
  createdAt: string;
  updatedAt: string;
};

type NotifyResult = {
  attempted: boolean;
  channel: "email" | "whatsapp" | "sms" | "none";
  ok: boolean;
  detail?: string;
};

function statusLabel(status: ProcurementRequestSnapshot["status"]) {
  switch (status) {
    case "IN_REVIEW":
      return "In Review";
    case "QUOTED":
      return "Quoted";
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
    case "CLOSED":
      return "Closed";
    default:
      return "Submitted";
  }
}

function cleanPhone(value?: string | null) {
  return (value || "").trim();
}

export async function notifyCustomerProcurementAssigned(
  snapshot: ProcurementRequestSnapshot,
  assignedByName?: string | null,
  managerName?: string | null,
): Promise<NotifyResult> {
  const user = await prisma.user.findUnique({
    where: { id: snapshot.customerId },
    select: { email: true, phone: true, name: true },
  });
  const emailTo = (user?.email || snapshot.contactEmail || "").trim();
  const phoneTo = cleanPhone(user?.phone || snapshot.contactPhone);
  const customerName = user?.name || snapshot.contactName || "Customer";

  const subject = `Procurement request assigned (${snapshot.id})`;
  const text = [
    `Hi ${customerName},`,
    "",
    `Your procurement request for ${snapshot.clinicName} has been assigned to our account management team.`,
    managerName ? `Assigned manager: ${managerName}.` : "Assigned manager: Team member.",
    `Current status: ${statusLabel(snapshot.status)}.`,
    assignedByName ? `Updated by: ${assignedByName}.` : "",
    "",
    "You can view updates in your account procurement portal.",
  ]
    .filter(Boolean)
    .join("\n");

  if (emailTo) {
    const sent = await sendEmail(emailTo, subject, text);
    if (sent.ok) return { attempted: true, channel: "email", ok: true };
  }

  if (phoneTo) {
    const wa = await sendWhatsApp(phoneTo, text).catch(() => ({ ok: false }));
    if (wa.ok) return { attempted: true, channel: "whatsapp", ok: true };
    const sms = await sendSms(phoneTo, text).catch(() => ({ ok: false }));
    if (sms.ok) return { attempted: true, channel: "sms", ok: true };
    return { attempted: true, channel: "none", ok: false, detail: "WhatsApp/SMS delivery failed" };
  }

  return { attempted: false, channel: "none", ok: false, detail: "No customer contact channel available" };
}

export async function notifyCustomerProcurementStatusUpdated(
  snapshot: ProcurementRequestSnapshot,
  previousStatus: ProcurementRequestSnapshot["status"],
  updatedByName?: string | null,
): Promise<NotifyResult> {
  const user = await prisma.user.findUnique({
    where: { id: snapshot.customerId },
    select: { email: true, phone: true, name: true },
  });
  const emailTo = (user?.email || snapshot.contactEmail || "").trim();
  const phoneTo = cleanPhone(user?.phone || snapshot.contactPhone);
  const customerName = user?.name || snapshot.contactName || "Customer";

  const subject = `Procurement request update (${snapshot.id})`;
  const text = [
    `Hi ${customerName},`,
    "",
    `Your procurement request for ${snapshot.clinicName} was updated.`,
    `Status: ${statusLabel(previousStatus)} -> ${statusLabel(snapshot.status)}.`,
    updatedByName ? `Updated by: ${updatedByName}.` : "",
    "",
    "You can view updates in your account procurement portal.",
  ]
    .filter(Boolean)
    .join("\n");

  if (emailTo) {
    const sent = await sendEmail(emailTo, subject, text);
    if (sent.ok) return { attempted: true, channel: "email", ok: true };
  }

  if (phoneTo) {
    const wa = await sendWhatsApp(phoneTo, text).catch(() => ({ ok: false }));
    if (wa.ok) return { attempted: true, channel: "whatsapp", ok: true };
    const sms = await sendSms(phoneTo, text).catch(() => ({ ok: false }));
    if (sms.ok) return { attempted: true, channel: "sms", ok: true };
    return { attempted: true, channel: "none", ok: false, detail: "WhatsApp/SMS delivery failed" };
  }

  return { attempted: false, channel: "none", ok: false, detail: "No customer contact channel available" };
}
