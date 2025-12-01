export const metadata = {
  title: "About Noralls Medical Supplies",
  description:
    "Learn about Noralls Medical Supplies — a dependable partner for hospitals, clinics, and practitioners, focused on quality, availability, and service.",
};

export default function AboutPage() {
  return (
    <section className="container mx-auto py-12 space-y-10">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-semibold">About Noralls Medical Supplies</h1>
        <p className="text-muted-foreground mt-2">
          Trusted partner to hospitals, clinics, and practitioners — delivering essential medical supplies with speed,
          transparency, and care.
        </p>
      </header>

      <div className="grid gap-6 md:grid-cols-3">
        <div className="rounded-xl bg-card text-card-foreground shadow-sm p-6">
          <p className="text-sm text-muted-foreground">Founded</p>
          <p className="text-2xl font-semibold">2013</p>
          <p className="text-xs text-muted-foreground mt-1">Over a decade of continuous service.</p>
        </div>
        <div className="rounded-xl bg-card text-card-foreground shadow-sm p-6">
          <p className="text-sm text-muted-foreground">Who We Serve</p>
          <p className="text-2xl font-semibold">Hospitals &amp; Clinics</p>
          <p className="text-xs text-muted-foreground mt-1">Public, private, and community facilities.</p>
        </div>
        <div className="rounded-xl bg-card text-card-foreground shadow-sm p-6">
          <p className="text-sm text-muted-foreground">Commitment</p>
          <p className="text-2xl font-semibold">Quality &amp; Availability</p>
          <p className="text-xs text-muted-foreground mt-1">Carefully sourced products, reliable fulfillment.</p>
        </div>
      </div>

      {/* Our story spans full content width on larger screens */}
      <article className="prose prose-slate dark:prose-invert max-w-none">
        <h2 className="mb-2">Our Story</h2>
        <p>
          Noralls Medical Supplies began in 2013 with a simple promise: make essential medical supplies easier to access for
          the providers who need them most. What started as a small, service‑first team has grown into a trusted partner
          for hospitals, clinics, and practices that need dependable products and clear communication.
        </p>
        <p>
          From the beginning, we chose to build the business around listening. We spoke with nurses, physicians,
          procurement leads, and administrators to understand where delays occur, what “quality” really means at the
          bedside, and how every stock‑out or late delivery can affect real patients. Those conversations shaped how we
          select our suppliers, how we price our products, and how we design our ordering and follow‑up processes.
        </p>
        <p>
          Over the past decade, we have expanded our catalog, built strong vendor relationships, and refined our
          logistics so that accuracy and responsiveness are non‑negotiable. Today, Noralls Medical Supplies supports
          hospitals, clinics, laboratories, and private practices with:
        </p>
        <ul>
          <li>Consistently available core items and clearly communicated lead times for specialised products.</li>
          <li>Transparent pricing designed to support long‑term partnership, not one‑off transactions.</li>
          <li>Local, responsive support when you need to clarify an order or solve a problem quickly.</li>
        </ul>

        <h2 className="mb-2">How We Work</h2>
        <p>
          We focus on doing the essentials reliably well. That means verified products, clear documentation, and
          predictable delivery windows. Orders are tracked from confirmation through to dispatch, and we proactively
          communicate when there are changes or constraints, so your team is never left guessing.
        </p>
        <p>
          Behind the scenes, we continuously review usage patterns and feedback to adjust our stocking levels and product
          mix. This allows us to keep fast‑moving essentials on hand, while still giving you access to a broader range of
          specialised and higher‑acuity items when needed.
        </p>

        <h2 className="mb-2">Looking Ahead</h2>
        <p>
          As healthcare evolves, so does our responsibility as a supply partner. We are investing in smarter inventory
          planning, more transparent order tracking, and a smoother online experience from cart to delivery. Our goal is
          simple: to reduce the time and effort your team spends managing supplies, so you can focus more fully on
          patient care.
        </p>
      </article>

      <div className="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-4">
        <p className="text-sm text-primary">
          If you would like to discuss contract supply, standing orders, or a tailored product list for your facility,
          we&apos;d be glad to talk. Visit the Products page to explore our range, or use the phone link in the header to
          reach us directly.
        </p>
      </div>
    </section>
  );
}
