export const metadata = {
  title: "Privacy Policy | Noralls Medical Supplies",
  description: "How Noralls Medical Supplies collects, uses, and protects your information.",
};

export default function PrivacyPage() {
  return (
    <section className="container mx-auto py-12 space-y-8">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-semibold">Privacy Policy</h1>
        <p className="text-muted-foreground mt-2">
          Your trust matters. This policy explains what we collect, how we use it, and the steps we take to protect
          your information when you use Noralls Medical Supplies.
        </p>
      </header>

      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2>1. Information We Collect</h2>
        <ul>
          <li>
            <strong>Account details.</strong> Name, email address, and optional phone number so we can create and manage
            your account and communicate with you.
          </li>
          <li>
            <strong>Order and payment information.</strong> Order history, delivery details, and payment records needed
            to fulfil purchases, manage returns, and keep accurate financial records.
          </li>
          <li>
            <strong>Usage information.</strong> Basic technical data (such as device, browser, and pages visited) used
            to keep the site reliable and improve performance.
          </li>
        </ul>

        <h2>2. How We Use Your Information</h2>
        <ul>
          <li>To process and deliver orders, manage returns, and provide customer support.</li>
          <li>To maintain accurate account history, billing, and inventory records.</li>
          <li>To improve our catalog, logistics, and overall customer experience.</li>
          <li>To send essential service messages about orders, payments, and account security.</li>
        </ul>

        <h2>3. Data Sharing</h2>
        <p>
          We do <strong>not</strong> sell your personal information. We may share limited information with trusted
          service providers strictly for:
        </p>
        <ul>
          <li>Payment processing and fraud prevention.</li>
          <li>Order delivery and logistics.</li>
          <li>Email, SMS, or other communication services you have agreed to receive.</li>
        </ul>
        <p>
          These providers are required to protect your data and use it only for the specific services they perform on
          our behalf.
        </p>

        <h2>4. Security</h2>
        <p>
          We use industry‑standard security measures and access controls to protect personal data, and we limit access
          to team members who need it to perform their roles. While no system is perfectly secure, we continuously
          review and improve our safeguards.
        </p>

        <h2>5. Data Retention</h2>
        <p>
          We retain your information only as long as necessary to meet legal, tax, and operational requirements (for
          example, financial records and order history). When data is no longer needed, we delete it or anonymize it in
          line with our retention practices.
        </p>

        <h2>6. Your Choices and Rights</h2>
        <ul>
          <li>
            <strong>Access and updates.</strong> You can view and update key account details from your account pages.
          </li>
          <li>
            <strong>Deletion requests.</strong> You may contact us to request deletion of certain information, subject
            to our legal and record‑keeping obligations.
          </li>
          <li>
            <strong>Communication preferences.</strong> You can opt out of non‑essential marketing or update
            notification preferences where those options are provided.
          </li>
        </ul>

        <h2>7. Contact</h2>
        <p>
          If you have questions about this policy or how we handle your information, please visit our{" "}
          <a href="/contact">Contact</a> page and we will be glad to assist.
        </p>
      </article>
    </section>
  );
}
