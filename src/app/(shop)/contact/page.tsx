export const metadata = {
  title: "Contact Noralls Medical Supplies",
  description: "Get in touch with Noralls Medical Supplies for orders, support, and inquiries.",
};

import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";
import ContactForm from "./ContactForm";
import { chipToneBorderClass, chipToneClass } from "@/lib/status-chips";

export default function ContactPage() {
  const SUPPORT_EMAIL = "norallsmedser@gmail.com";
  const whatsappLink = `https://wa.me/${ADMIN_PHONE.replace(/[^\d]/g, "")}`;
  const whatsappEnabled = process.env.NEXT_PUBLIC_WHATSAPP_ENABLED === "true";
  return (
    <section className="container mx-auto py-12">
      <h1 className="text-3xl font-semibold">Contact Us</h1>
      <p className="text-muted-foreground mt-2 max-w-prose">
        We’re here to help with product availability, bulk requests, order status, and account questions.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-3">
        <div className="rounded-xl border bg-card text-card-foreground p-6 space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Phone</h2>
            <p className="mt-2">
              <a href={ADMIN_PHONE_TEL} className="font-medium">{ADMIN_PHONE}</a>
            </p>
            <p className="text-sm text-muted-foreground mt-1">Mon–Fri, 9am–5pm</p>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Email</h3>
            <a className="text-sm text-primary underline" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
          </div>
          {whatsappEnabled ? (
            <div>
              <h3 className="text-sm font-semibold">WhatsApp</h3>
              <a className="text-sm text-primary underline" href={whatsappLink} target="_blank" rel="noreferrer">
                Chat on WhatsApp
              </a>
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border bg-card text-card-foreground p-6 space-y-3">
          <div>
            <h2 className="text-lg font-semibold">Response Time</h2>
            <p className="text-sm text-muted-foreground mt-2">
              Most inquiries receive a response within one business day. For urgent requests, please call.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Service Area</h3>
            <p className="text-sm text-muted-foreground mt-1">Ghana nationwide delivery</p>
          </div>
          <div>
            <h3 className="text-sm font-semibold">Bulk / Institutional Orders</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Share your facility name, item list, and expected volumes.
            </p>
          </div>
        </div>

        <div className="rounded-xl border bg-card text-card-foreground p-6">
          <h2 className="text-lg font-semibold">Send a Message</h2>
          <p className="text-sm text-muted-foreground mt-2">
            This form sends directly to {SUPPORT_EMAIL}. We usually reply within one business day.
          </p>
          <div className="mt-4">
            <ContactForm />
          </div>
        </div>
      </div>

      <div className={`mt-8 rounded-lg border p-4 ${chipToneClass("info")} ${chipToneBorderClass("info")}`}>
        <p className="text-sm">
          Looking for a specific item? Share manufacturer, item name, and quantity — we’ll confirm availability and lead time.
        </p>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Messages sent to us are handled confidentially and used only to respond to your inquiry and improve our service.
      </p>
    </section>
  );
}
