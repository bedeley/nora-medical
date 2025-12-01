export const metadata = {
  title: "Terms of Service | Noralls Medical Supplies",
  description:
    "The terms that govern your use of Noralls Medical Supplies and purchases made on our site.",
};

export default function TermsPage() {
  return (
    <section className="container mx-auto py-12 space-y-8">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-semibold">Terms of Service</h1>
        <p className="text-muted-foreground mt-2">
          Please read these terms carefully. By using this site or placing an order with Noralls Medical Supplies, you
          agree to the terms set out below.
        </p>
      </header>

      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>1. Accounts</h2>
        <p>
          To place and track orders, you may create an account with accurate contact details. You are responsible for
          maintaining the confidentiality of your login credentials and for all activity that occurs under your account.
          Notify us promptly if you believe your account has been compromised.
        </p>

        <h2>2. Orders &amp; Pricing</h2>
        <ul>
          <li>Prices are displayed in local currency and may change without prior notice.</li>
          <li>
            An order is considered accepted when it appears as confirmed in your account or when we issue an order
            confirmation by email or SMS.
          </li>
          <li>
            Promotions, discounts, or special pricing may be subject to additional conditions and limited timelines.
          </li>
        </ul>

        <h2>3. Payments &amp; Balances</h2>
        <ul>
          <li>
            We accept the payment methods indicated during checkout (for example, cash, Mobile Money, or approved
            transfer options).
          </li>
          <li>
            Your account history reflects amounts billed, amounts paid, outstanding balances, and any store credit or
            refunds applied.
          </li>
          <li>
            You agree to pay all amounts due for orders according to the payment terms agreed with Noralls Medical
            Supplies.
          </li>
        </ul>

        <h2>4. Shipping &amp; Delivery</h2>
        <p>
          Delivery estimates are provided in good faith and may vary based on product availability, location, and
          courier performance. We will communicate material delays where possible and work to minimize disruption, but
          specific delivery dates are not guaranteed unless expressly agreed in writing.
        </p>

        <h2>5. Returns, Store Credit &amp; Warranty</h2>
        <p>
          Return eligibility depends on product type, condition, and applicable regulations. In general, opened
          consumables and products that cannot be safely restocked may be non‑returnable.
        </p>
        <ul>
          <li>
            Faulty or damaged items will be assessed and, where appropriate, repaired, replaced, or refunded in line
            with the manufacturer&apos;s or supplier&apos;s warranty.
          </li>
          <li>
            Where refunds or adjustments are issued as store credit, that credit can be applied to future eligible
            purchases according to our store credit rules.
          </li>
        </ul>

        <h2>6. Acceptable Use</h2>
        <p>
          You agree not to misuse this site, interfere with its security or normal operation, attempt unauthorized
          access to other accounts or systems, or use the platform in any way that could harm Noralls Medical Supplies
          or other users.
        </p>

        <h2>7. Limitation of Liability</h2>
        <p>
          To the maximum extent permitted by law, Noralls Medical Supplies is not liable for any indirect, incidental,
          special, or consequential damages arising from your use of this site or the products supplied. Our aggregate
          liability for any claim related to an order is, in all cases, limited to the amount paid for the relevant
          order.
        </p>

        <h2>8. Changes to These Terms</h2>
        <p>
          We may update these terms from time to time to reflect changes in our services or applicable requirements.
          When we do so, we will update the effective date on this page. Continued use of the site after changes take
          effect constitutes acceptance of the updated terms.
        </p>

        <h2>9. Governing Law</h2>
        <p>
          These terms, and any dispute or claim arising out of or in connection with them, are governed by the laws of
          the Republic of Ghana. Where a matter cannot be resolved amicably, it may be brought before the competent
          courts of Ghana.
        </p>

        <h2>10. Contact</h2>
        <p>
          If you have questions about these terms or how they apply to your account or orders, please visit our{" "}
          <a href="/contact">Contact</a> page and we will be happy to assist.
        </p>
      </article>
    </section>
  );
}
