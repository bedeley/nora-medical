export const metadata = {
  title: "Privacy Policy | Nora’ Hospital Supply",
  description: "How Nora’ Hospital Supply collects, uses, and protects your information.",
};

export default function PrivacyPage() {
  return (
    <section className="container mx-auto py-12">
      <h1 className="text-3xl font-semibold">Privacy Policy</h1>
      <p className="text-muted-foreground mt-2 max-w-prose">
        Your privacy matters. This policy explains what we collect, why we collect it, and how we safeguard your data.
      </p>

      <article className="prose prose-slate dark:prose-invert mt-8 max-w-3xl">
        <h2>Information We Collect</h2>
        <ul>
          <li>Account details: name, email, optional phone.</li>
          <li>Order and payment records for purchase fulfillment.</li>
          <li>Usage data to improve site performance and reliability.</li>
        </ul>

        <h2>How We Use Your Information</h2>
        <ul>
          <li>Process and deliver orders, manage returns, and provide support.</li>
          <li>Maintain accurate account history and billing records.</li>
          <li>Improve our catalog, logistics, and customer experience.</li>
        </ul>

        <h2>Data Sharing</h2>
        <p>
          We do not sell personal information. We may share limited data with service providers strictly to fulfill
          orders (e.g., payment processing, logistics), bound by confidentiality.
        </p>

        <h2>Security</h2>
        <p>
          We use industry‑standard safeguards and access controls to protect personal data. While no system is perfectly
          secure, we continuously improve our controls.
        </p>

        <h2>Retention</h2>
        <p>
          We retain records only as long as necessary for legal, tax, and operational purposes, after which we delete or
          anonymize them.
        </p>

        <h2>Your Choices</h2>
        <ul>
          <li>Access or update your information via your account page.</li>
          <li>Contact us to request data deletion where applicable.</li>
          <li>Opt out of non‑essential communications.</li>
        </ul>

        <h2>Contact</h2>
        <p>
          Questions about this policy? Visit our <a href="/contact">Contact</a> page.
        </p>
      </article>
    </section>
  );
}

