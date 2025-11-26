export const metadata = {
  title: "Terms of Service | Nora&#39; Hospital Supply",
  description:
    "The terms that govern your use of Nora&#39; Hospital Supply and purchases made on our site.",
};

export default function TermsPage() {
  return (
    <section className="container mx-auto py-12">
      <h1 className="text-3xl font-semibold">Terms of Service</h1>
      <p className="text-muted-foreground mt-2 max-w-prose">
        Please read these terms carefully. By using this site or placing an order, you agree to the following terms.
      </p>

      <article className="prose prose-slate dark:prose-invert mt-8 max-w-3xl">
        <h2>Accounts</h2>
        <p>
          You are responsible for maintaining the confidentiality of your account and for all activities under your
          account. Keep your contact details accurate for order updates and receipts.
        </p>

        <h2>Orders & Payment</h2>
        <ul>
          <li>Prices are shown in local currency and may change without notice.</li>
          <li>Orders are confirmed when accepted and scheduled for fulfillment.</li>
          <li>Payments and balances are reflected in your account history.</li>
        </ul>

        <h2>Shipping & Delivery</h2>
        <p>
          Delivery estimates are provided in good faith. We communicate delays promptly and work to minimize disruption.
        </p>

        <h2>Returns & Warranty</h2>
        <p>
          Return eligibility depends on product type and condition. Consumables may be non-returnable if opened. For
          faulty items, we will repair, replace, or refund according to supplier warranty.
        </p>

        <h2>Acceptable Use</h2>
        <p>Do not misuse the site or interfere with other users’ access or security.</p>

        <h2>Limitation of Liability</h2>
        <p>
          To the maximum extent permitted by law, Nora&#39; Hospital Supply is not liable for indirect or consequential
          damages arising from your use of the site or products.
        </p>

        <h2>Changes</h2>
        <p>We may update these terms. Continued use constitutes acceptance of any changes.</p>

        <h2>Contact</h2>
        <p>
          Questions about these terms? Visit our <a href="/contact">Contact</a> page.
        </p>
      </article>
    </section>
  );
}
