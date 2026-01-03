"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

type ContactFormState = {
  name: string;
  email: string;
  phone: string;
  subject: string;
  message: string;
};

const initialState: ContactFormState = {
  name: "",
  email: "",
  phone: "",
  subject: "",
  message: "",
};

export default function ContactForm() {
  const [form, setForm] = useState<ContactFormState>(initialState);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof ContactFormState | "contact", string>>>({});

  const handleChange = (field: keyof ContactFormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    if (errors[field] || (field === "email" || field === "phone")) {
      setErrors((prev) => ({
        ...prev,
        [field]: "",
        contact: field === "email" || field === "phone" ? "" : prev.contact || "",
      }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors: Partial<Record<keyof ContactFormState | "contact", string>> = {};
    if (!form.name.trim() || !form.message.trim()) {
      if (!form.name.trim()) nextErrors.name = "Name is required.";
      if (!form.message.trim()) nextErrors.message = "Message is required.";
    }
    if (!form.email.trim() && !form.phone.trim()) {
      nextErrors.contact = "Please provide an email or phone number so we can respond.";
    }
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to send message.");
      }
      toast.success("Message sent. We will reply shortly.");
      setForm(initialState);
      setErrors({});
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Failed to send message.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={form.name}
            onChange={handleChange("name")}
            placeholder="Full name"
            required
            aria-invalid={!!errors.name}
            className={errors.name ? "border-red-500" : ""}
          />
          {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name}</p>}
        </div>
        <div>
          <Label htmlFor="subject">Subject</Label>
          <Input id="subject" value={form.subject} onChange={handleChange("subject")} placeholder="Order status, bulk request" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={form.email}
            onChange={handleChange("email")}
            placeholder="you@example.com"
            aria-invalid={!!errors.contact}
            className={errors.contact ? "border-red-500" : ""}
          />
        </div>
        <div>
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            value={form.phone}
            onChange={handleChange("phone")}
            placeholder="+233…"
            aria-invalid={!!errors.contact}
            className={errors.contact ? "border-red-500" : ""}
          />
        </div>
      </div>
      {errors.contact && <p className="text-xs text-red-600">{errors.contact}</p>}
      <div>
        <Label htmlFor="message">Message</Label>
        <Textarea
          id="message"
          value={form.message}
          onChange={handleChange("message")}
          placeholder="Tell us what you need, including item name, quantity, and timeline."
          rows={5}
          required
          aria-invalid={!!errors.message}
          className={errors.message ? "border-red-500" : ""}
        />
        {errors.message && <p className="mt-1 text-xs text-red-600">{errors.message}</p>}
      </div>
      <Button type="submit" disabled={loading} className="w-full sm:w-auto">
        {loading ? "Sending..." : "Send Message"}
      </Button>
    </form>
  );
}
