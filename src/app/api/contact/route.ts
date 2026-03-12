import { NextResponse } from "next/server";
import { z } from "zod";
import { sendEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/origin";

const contactSchema = z
  .object({
    name: z.string().min(2),
    email: z.string().email().optional().or(z.literal("")),
    phone: z.string().optional().or(z.literal("")),
    subject: z.string().optional().or(z.literal("")),
    message: z.string().min(10),
  })
  .superRefine((data, ctx) => {
    if (!data.email && !data.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["email"],
        message: "Provide an email or phone number.",
      });
    }
  });

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "contact-form", 60_000, 15);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  try {
    const body = await req.json();
    const parsed = contactSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { name, email, phone, subject, message } = parsed.data;
    const to = "norallsmedser@gmail.com";
    const safeSubject = (subject || "Contact form message").trim();
    const text = [
      `New contact form message`,
      `Name: ${name}`,
      `Email: ${email || "(not provided)"}`,
      `Phone: ${phone || "(not provided)"}`,
      `Subject: ${safeSubject}`,
      "",
      message,
    ].join("\n");

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email || "(not provided)");
    const safePhone = escapeHtml(phone || "(not provided)");
    const safeSubjectHtml = escapeHtml(safeSubject);
    const safeMessage = escapeHtml(message);

    const html = `
      <p><strong>New contact form message</strong></p>
      <p><strong>Name:</strong> ${safeName}</p>
      <p><strong>Email:</strong> ${safeEmail}</p>
      <p><strong>Phone:</strong> ${safePhone}</p>
      <p><strong>Subject:</strong> ${safeSubjectHtml}</p>
      <pre style="white-space:pre-wrap;font-family:inherit;">${safeMessage}</pre>
    `;

    const res = await sendEmail(to, `Contact: ${safeSubject}`, text, html);
    if (!res.ok) {
      return NextResponse.json({ error: res.error || "Failed to send email" }, { status: 502 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Contact form error:", err);
    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }
}
