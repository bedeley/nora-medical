export const metadata = {
  title: "Contact Nora’ Hospital Supply",
  description: "Get in touch with Nora’ Hospital Supply for orders, support, and inquiries.",
};

import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";

export default function ContactPage() {
  return (
    <section className="container mx-auto py-12">
      <h1 className="text-3xl font-semibold">Contact Us</h1>
      <p className="text-muted-foreground mt-2 max-w-prose">
        We’re here to help with product availability, bulk requests, order status, and account questions.
      </p>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <div className="rounded-xl border bg-card text-card-foreground p-6">
          <h2 className="text-lg font-semibold">Phone</h2>
          <p className="mt-2">
            <a href={ADMIN_PHONE_TEL} className="font-medium">{ADMIN_PHONE}</a>
          </p>
          <p className="text-sm text-muted-foreground mt-1">Mon–Fri, 9am–5pm</p>
        </div>

        <div className="rounded-xl border bg-card text-card-foreground p-6">
          <h2 className="text-lg font-semibold">Response Time</h2>
          <p className="text-sm text-muted-foreground mt-2">
            Most inquiries receive a response within one business day. For urgent requests, please call.
          </p>
        </div>
      </div>

      <div className="mt-8 rounded-lg border border-primary/20 bg-primary/10 p-4">
        <p className="text-sm text-primary">
          Looking for a specific item? Share manufacturer, SKU, and quantity — we’ll confirm availability and lead time.
        </p>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Messages sent to us are handled confidentially and used only to respond to your inquiry and improve our service.
      </p>
    </section>
  );
}
