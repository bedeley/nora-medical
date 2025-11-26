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
  const [loading, setLoading] = useState(false);
  const [createdUser, setCreatedUser] = useState<CreatedUserState | null>(null);
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpLoading, setOtpLoading] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const payload = Object.fromEntries(formData);
    const parsed = registerSchema.safeParse(payload);
    if (!parsed.success) {
      setErr("Please check your inputs (email or username is required).");
      setLoading(false);
      return;
    }
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
      <Input name="name" placeholder="Full name" required />
      <Input name="email" type="email" placeholder="Email (optional if using username)" />
      <Input
        name="username"
        placeholder="Username (optional if using email)"
        autoComplete="username"
      />
      <Input
        name="phone"
        placeholder="Phone (for WhatsApp/SMS verification)"
        inputMode="tel"
        required
        title="Enter your phone number"
      />
      <Input
        name="password"
        type="password"
        placeholder="Password (min 6)"
        required
      />
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
