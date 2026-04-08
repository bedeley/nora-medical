"use client";

import { useState, type FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { registerSchema } from "@/lib/validation";

type CreatedUserState = {
  id: string;
  phone: string;
  otpChannel?: string;
};

export default function RegisterForm({ onSuccess }: { onSuccess?: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [createdUser, setCreatedUser] = useState<CreatedUserState | null>(null);
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpLoading, setOtpLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    setFieldErrors({});

    const formData = new FormData(e.currentTarget);
    const payload = Object.fromEntries(formData);
    const parsed = registerSchema.safeParse(payload);
    if (!parsed.success) {
      const flattened = parsed.error.flatten().fieldErrors;
      const nextErrors: Record<string, string> = {};
      if (flattened.name?.[0]) nextErrors.name = flattened.name[0];
      if (flattened.email?.[0]) nextErrors.email = flattened.email[0];
      if (flattened.username?.[0]) nextErrors.username = flattened.username[0];
      if (flattened.email?.[0] && !String(payload.username || "").trim()) {
        nextErrors.username = flattened.email[0];
      }
      if (flattened.phone?.[0]) nextErrors.phone = flattened.phone[0];
      if (flattened.password?.[0]) nextErrors.password = flattened.password[0];
      setFieldErrors(nextErrors);
      setErr("Please check the highlighted fields.");
      return;
    }
    setLoading(true);
    try {
      const r = await fetch("/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(parsed.data),
      });
      if (!r.ok) {
        const message = await extractErrorMessage(r);
        const statusLabel = r.status ? `${r.status} ` : "";
        throw new Error(`${statusLabel}${message || r.statusText || "Registration failed"}`.trim());
      }
      const body = (await r.json().catch(() => ({} as unknown))) as { id?: unknown; otpChannel?: string };
      const id = typeof body.id === "string" || typeof body.id === "number" ? String(body.id) : "";
      if (!id) {
        throw new Error("Registration successful but no user id returned.");
      }
      setCreatedUser({
        id,
        phone: String(parsed.data.phone || ""),
        otpChannel: body?.otpChannel,
      });
      setOtp("");
      setOtpError(null);
      setFieldErrors({});
      const form = e.currentTarget;
      form?.reset();
    } catch (error) {
      console.error("Register error:", error);
      setErr(error instanceof Error ? error.message : "Could not create account.");
    } finally {
      setLoading(false);
    }
  }

  async function onVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!createdUser) return;
    setOtpError(null);
    if (!otp.trim()) {
      setOtpError("Enter the code you received.");
      return;
    }
    setOtpLoading(true);
    try {
      const res = await fetch("/api/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: createdUser.id, code: otp.trim() }),
      });
      const j = (await res.json().catch(() => ({} as unknown))) as { error?: string };
      if (!res.ok) {
        throw new Error(j?.error || "Invalid or expired code");
      }
      if (onSuccess) onSuccess();
    } catch (error: unknown) {
      setOtpError(error instanceof Error ? error.message : "Failed to verify code.");
    } finally {
      setOtpLoading(false);
    }
  }

  if (createdUser) {
    return (
      <form key="verify" onSubmit={onVerify} className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          {createdUser.otpChannel === "email"
            ? "We sent a verification code to your email. Enter it below to complete your registration."
            : createdUser.otpChannel === "sms"
            ? `We sent a verification code via SMS to your phone (${createdUser.phone}). Enter it below to complete your registration.`
            : "We sent a verification code via WhatsApp to your phone. Enter it below to complete your registration."}
        </p>
        <Input
          aria-label="Verification code"
          placeholder="Verification code"
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\s+/g, "").slice(0, 6))}
        />
        {otpError && <p className="text-sm text-red-600">{otpError}</p>}
        <div className="flex gap-2">
          <Button type="submit" disabled={otpLoading}>
            {otpLoading ? "Verifying..." : "Verify & complete"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setCreatedUser(null);
              setOtp("");
              setOtpError(null);
            }}
          >
            Back
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={otpLoading}
            onClick={async () => {
              if (!createdUser) return;
              setOtpError(null);
              try {
                const res = await fetch("/api/register/resend", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ userId: createdUser.id }),
                });
                const j = (await res.json().catch(() => ({} as unknown))) as { error?: string; otpChannel?: string };
                if (!res.ok) {
                  throw new Error(j?.error || "Failed to resend code");
                }
                setCreatedUser((prev) =>
                  prev
                    ? {
                        ...prev,
                        otpChannel: j?.otpChannel || prev.otpChannel,
                      }
                    : prev,
                );
              } catch (error: unknown) {
                setOtpError(error instanceof Error ? error.message : "Failed to resend code.");
              }
            }}
          >
            Resend code
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form key="register" onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-1">
        <Input
          name="name"
          aria-label="Full name"
          placeholder="Full name"
          required
          aria-invalid={!!fieldErrors.name}
          className={fieldErrors.name ? "border-red-500" : undefined}
        />
        {fieldErrors.name && <p className="text-xs text-red-600">{fieldErrors.name}</p>}
      </div>
      <div className="grid gap-1">
        <Input
          name="email"
          type="email"
          aria-label="Email address"
          placeholder="Email (optional if using username)"
          aria-invalid={!!fieldErrors.email}
          className={fieldErrors.email ? "border-red-500" : undefined}
        />
        {fieldErrors.email && <p className="text-xs text-red-600">{fieldErrors.email}</p>}
      </div>
      <div className="grid gap-1">
        <Input
          name="username"
          aria-label="Username"
          placeholder="Username (optional if using email)"
          autoComplete="username"
          aria-invalid={!!fieldErrors.username}
          className={fieldErrors.username ? "border-red-500" : undefined}
          onChange={() => {
            if (fieldErrors.username) {
              setFieldErrors((prev) => {
                const next = { ...prev };
                delete next.username;
                return next;
              });
            }
          }}
        />
        {fieldErrors.username && <p className="text-xs text-red-600">{fieldErrors.username}</p>}
      </div>
      <div className="grid gap-1">
        <Input
          name="phone"
          aria-label="Phone number"
          placeholder="Phone (for WhatsApp/SMS verification)"
          inputMode="tel"
          required
          title="Enter your phone number"
          aria-invalid={!!fieldErrors.phone}
          className={fieldErrors.phone ? "border-red-500" : undefined}
        />
        {fieldErrors.phone && <p className="text-xs text-red-600">{fieldErrors.phone}</p>}
      </div>
      <div className="grid gap-1">
        <Input
          name="password"
          type="password"
          aria-label="Password"
          placeholder="Password (min 6)"
          required
          aria-invalid={!!fieldErrors.password}
          className={fieldErrors.password ? "border-red-500" : undefined}
        />
        {fieldErrors.password && <p className="text-xs text-red-600">{fieldErrors.password}</p>}
      </div>
      <p className="text-xs text-muted-foreground">
        We use your contact details only to manage your account and orders. We do not sell your data.
      </p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <Button type="submit" disabled={loading}>
        {loading ? "Registering..." : "Register"}
      </Button>
    </form>
  );
}

async function extractErrorMessage(r: Response) {
  const contentType = r.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      const data = (await r.clone().json()) as unknown;
      if (typeof data === "string") return data;
      if (data && typeof data === "object") {
        const maybeObj = data as { error?: unknown; message?: unknown };
        if (maybeObj.error) return String(maybeObj.error);
        if (maybeObj.message) return String(maybeObj.message);
      }
    } catch {
      // ignore JSON parse errors
    }
  }
  try {
    const text = await r.text();
    return text.trim();
  } catch {
    return "";
  }
}
