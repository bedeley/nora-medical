export const metadata = {
  title: "About Nora’ Hospital Supply",
  description:
    "Learn about Nora’ Hospital Supply — serving hospitals and clinics with reliable medical supplies for over a decade.",
};

export default function AboutPage() {
  return (
    <section className="container mx-auto py-12">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-semibold">About Nora’ Hospital Supply</h1>
        <p className="text-muted-foreground mt-2">
          Trusted partner to hospitals, clinics, and practitioners — delivering essential medical supplies with speed,
          transparency, and care.
        </p>
      </header>

      <div className="grid gap-8 md:grid-cols-3 mt-8">
        <div className="rounded-xl border bg-card text-card-foreground p-6">
          <p className="text-sm text-muted-foreground">Founded</p>
          <p className="text-2xl font-semibold">2013</p>
          <p className="text-xs text-muted-foreground mt-1">Over 10 years of service</p>
        </div>
        <div className="rounded-xl border bg-card text-card-foreground p-6">
          <p className="text-sm text-muted-foreground">Customers</p>
          <p className="text-2xl font-semibold">Hospitals & Clinics</p>
          <p className="text-xs text-muted-foreground mt-1">Public and private sector</p>
        </div>
        <div className="rounded-xl border bg-card text-card-foreground p-6">
          <p className="text-sm text-muted-foreground">Commitment</p>
          <p className="text-2xl font-semibold">Quality & Availability</p>
          <p className="text-xs text-muted-foreground mt-1">Rigorous sourcing, fast fulfillment</p>
        </div>
      </div>

      <article className="prose prose-slate dark:prose-invert mt-10 max-w-3xl">
        <h2 className="mb-2">Our Story</h2>
        <p>
          Nora’ Hospital Supply began in 2013 with a simple promise: make essential medical supplies easier to access for
          the providers who need them most. From a small, service‑first team, we grew by listening closely to clinical
          staff, procurement leads, and administrators — learning where delays happen, what quality truly means at the
          bedside, and how every delivery impacts real patient outcomes.
        </p>
        <p>
          Over the past decade, we’ve expanded our catalog, built dependable vendor relationships, and refined our
          logistics to prioritize accuracy and speed. Today, we serve hospitals, clinics, labs, and private practices
          with reliable sourcing, competitive pricing, and responsive local support. The core principle remains unchanged:
          do the important things consistently well — from verified products and clear ETAs to proactive communication.
        </p>

        <h2 className="mb-2">What We Stand For</h2>
        <ul>
          <li><strong>Integrity in sourcing.</strong> We partner with trusted manufacturers and distributors only.</li>
          <li><strong>Availability and speed.</strong> We maintain stock on high‑velocity essentials and communicate lead times clearly.</li>
          <li><strong>Support that cares.</strong> Our team understands the pressures of care delivery and responds accordingly.</li>
        </ul>

        <h2 className="mb-2">Looking Ahead</h2>
        <p>
          As we enter our second decade, we’re investing in smarter inventory planning, transparent order tracking, and
          a streamlined purchasing experience — so your teams can spend less time on logistics and more on patient care.
        </p>
      </article>

      <div className="mt-10 rounded-lg border border-primary/20 bg-primary/10 p-4">
        <p className="text-sm text-primary">
          Questions or bulk requests? We’re happy to help. Visit our products catalog or reach out through the phone link
          in the header.
        </p>
      </div>
    </section>
  );
}

