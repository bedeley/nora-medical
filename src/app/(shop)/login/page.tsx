"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import Link from "next/link";

function LoginContent() {
  const router = useRouter();
  const params = useSearchParams();
  const callbackUrl = params.get("callbackUrl") || "/";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [loginErrors, setLoginErrors] = useState<{ email?: string; password?: string }>({});
  const [loading, setLoading] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetIdentifier, setResetIdentifier] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [requestingReset, setRequestingReset] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetFieldErrors, setResetFieldErrors] = useState<{ identifier?: string; code?: string; password?: string }>({});
  const [codeRequested, setCodeRequested] = useState(false);
  const phoneVerificationEnabled =
    (process.env.NEXT_PUBLIC_PHONE_VERIFICATION_ENABLED || "").toLowerCase() ===
      "1" ||
    (process.env.NEXT_PUBLIC_PHONE_VERIFICATION_ENABLED || "").toLowerCase() ===
      "true" ||
    (process.env.NEXT_PUBLIC_PHONE_VERIFICATION_ENABLED || "").toLowerCase() ===
      "yes";
  const [resetChannel, setResetChannel] = useState<"email" | "whatsapp">(
    "email",
  );

  const reason = params.get("reason");
  const initialReasonMessage =
    reason === "session-expired"
      ? "Your admin session timed out for security. Please sign in again."
      : null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const nextErrors: { email?: string; password?: string } = {};
    if (!email.trim()) nextErrors.email = "Email or username is required.";
    if (!password.trim()) nextErrors.password = "Password is required.";
    if (Object.values(nextErrors).some(Boolean)) {
      setLoginErrors(nextErrors);
      return;
    }
    setLoginErrors({});
    setLoading(true);
    const res = await signIn("credentials", {
      redirect: false,
      identifier: email,
      password,
      callbackUrl,
    });
    setLoading(false);
    if (!res || res.error) {
      setErr("Invalid email or password.");
      return;
    }
    const target = res.url || callbackUrl;
    // After a successful sign-in, route customers through the Account page
    // so they see verification status and can request a new code.
    if (!target || target === "/" || target === "/login") {
      router.push("/account?verify=1");
    } else {
      router.push(target);
    }
  }

  async function requestResetCode() {
    setResetError(null);
    setResetMessage(null);
    setResetFieldErrors({});
    const effectiveChannel =
      phoneVerificationEnabled && resetChannel === "whatsapp"
        ? "whatsapp"
        : "email";
    const identifier = (
      resetIdentifier || (effectiveChannel === "email" ? email : "")
    ).trim();
    if (!identifier) {
      setResetFieldErrors((prev) => ({
        ...prev,
        identifier:
          effectiveChannel === "whatsapp"
            ? "Enter the phone number associated with your account."
            : "Enter the email associated with your account.",
      }));
      setResetError(
        effectiveChannel === "whatsapp"
          ? "Enter the phone number associated with your account."
          : "Enter the email associated with your account.",
      );
      return;
    }
    setRequestingReset(true);
    try {
      const res = await fetch("/api/auth/password/reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, channel: effectiveChannel }),
      });
      const data = await res
        .json()
        .catch(() => ({} as { error?: string }));
      if (!res.ok) {
        throw new Error(data?.error || "Failed to request reset code");
      }
      setCodeRequested(true);
      setResetMessage(
        effectiveChannel === "email"
          ? "If that email is registered, a reset code has been emailed."
          : "If that account phone number is on file, a reset code has been sent via WhatsApp/SMS.",
      );
      setResetError(null);
    } catch (error: unknown) {
      setResetError(
        error instanceof Error
          ? error.message
          : "Failed to request reset code"
      );
    } finally {
      setRequestingReset(false);
    }
  }

  async function confirmReset() {
    setResetError(null);
    setResetMessage(null);
    setResetFieldErrors({});
    if (!codeRequested) {
      setResetError("Request a reset code first.");
      return;
    }
    if (!resetCode.trim() || !newPassword.trim()) {
      setResetFieldErrors((prev) => ({
        ...prev,
        code: !resetCode.trim() ? "Enter the reset code." : "",
        password: !newPassword.trim() ? "Enter a new password." : "",
      }));
      setResetError("Enter the code and a new password.");
      return;
    }
    const effectiveChannel =
      phoneVerificationEnabled && resetChannel === "whatsapp"
        ? "whatsapp"
        : "email";
    const identifier = (
      resetIdentifier || (effectiveChannel === "email" ? email : "")
    ).trim();
    if (!identifier) {
      setResetFieldErrors((prev) => ({
        ...prev,
        identifier:
          effectiveChannel === "whatsapp"
            ? "Enter the phone number associated with your account."
            : "Enter the email associated with your account.",
      }));
      setResetError(
        effectiveChannel === "whatsapp"
          ? "Enter the phone number associated with your account."
          : "Enter the email associated with your account.",
      );
      return;
    }
    setConfirmingReset(true);
    try {
      const res = await fetch("/api/auth/password/reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier,
          code: resetCode.trim(),
          password: newPassword,
        }),
      });
      const data = await res
        .json()
        .catch(() => ({} as { error?: string }));
      if (!res.ok) {
        throw new Error(data?.error || "Failed to reset password");
      }
      setResetMessage("Password updated. You can now sign in with your new password.");
      setResetError(null);
      setCodeRequested(false);
      setResetCode("");
      setNewPassword("");
      setShowReset(false);
      if (identifier.includes("@")) {
        setEmail(identifier);
      }
      setPassword("");
    } catch (error: unknown) {
      setResetError(
        error instanceof Error ? error.message : "Failed to reset password"
      );
    } finally {
      setConfirmingReset(false);
    }
  }

  return (
    <section className="container mx-auto max-w-sm py-12">
      <h1 className="text-2xl font-semibold mb-6">Sign in</h1>
      <form onSubmit={onSubmit} className="grid gap-3">
        <Input
          type="text"
          placeholder="Email or username"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (loginErrors.email) setLoginErrors((prev) => ({ ...prev, email: "" }));
          }}
          autoComplete="username"
          required
          aria-invalid={!!loginErrors.email}
          className={loginErrors.email ? "border-red-500" : undefined}
        />
        {loginErrors.email && <p className="text-xs text-red-600">{loginErrors.email}</p>}
        <Input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (loginErrors.password) setLoginErrors((prev) => ({ ...prev, password: "" }));
          }}
          autoComplete="current-password"
          required
          aria-invalid={!!loginErrors.password}
          className={loginErrors.password ? "border-red-500" : undefined}
        />
        {loginErrors.password && <p className="text-xs text-red-600">{loginErrors.password}</p>}
        {(err || initialReasonMessage) && (
          <p className="text-sm text-red-600">
            {err || initialReasonMessage}
          </p>
        )}
        <Button type="submit" disabled={loading}>
          {loading ? "Signing in..." : "Sign In"}
        </Button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">
        On phones with Face ID or fingerprint unlock, you can save this login to your device&apos;s password manager. On your next visit, your phone may ask for your biometrics to autofill and sign you in.
      </p>
      <div className="mt-6 border-t pt-4">
        <button
          type="button"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          onClick={() => setShowReset((v) => !v)}
        >
          Forgot your password?
        </button>
        {showReset && (
          <div className="mt-4 space-y-3 text-sm">
            <p className="text-muted-foreground">
              {phoneVerificationEnabled
                ? "Request a reset code via email or WhatsApp, then enter it below to set a new password."
                : "Request a reset code via email, then enter it below to set a new password."}
            </p>
            {phoneVerificationEnabled ? (
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    checked={resetChannel === "email"}
                    onChange={() => setResetChannel("email")}
                  />
                  Email
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    checked={resetChannel === "whatsapp"}
                    onChange={() => setResetChannel("whatsapp")}
                  />
                  WhatsApp / SMS
                </label>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Reset codes are sent to the email saved on your account.
              </p>
            )}
            {phoneVerificationEnabled && resetChannel === "whatsapp" && (
              <p className="text-xs text-muted-foreground">
                Codes are sent to the phone number saved on your account. If no phone is on file, use email.
              </p>
            )}
            <Input
              type="text"
              placeholder={
                phoneVerificationEnabled && resetChannel === "whatsapp"
                  ? "Account phone number"
                  : "Account email"
              }
              value={resetIdentifier}
              onChange={(e) => {
                setResetIdentifier(e.target.value);
                if (resetFieldErrors.identifier) {
                  setResetFieldErrors((prev) => ({ ...prev, identifier: "" }));
                }
              }}
              aria-invalid={!!resetFieldErrors.identifier}
              className={resetFieldErrors.identifier ? "border-red-500" : undefined}
            />
            {resetFieldErrors.identifier && (
              <p className="text-xs text-red-600">{resetFieldErrors.identifier}</p>
            )}
            <Button type="button" variant="outline" onClick={requestResetCode} disabled={requestingReset}>
              {requestingReset
                ? "Sending..."
                : `Request code (${
                    phoneVerificationEnabled && resetChannel === "whatsapp"
                      ? "WhatsApp"
                      : "Email"
                  })`}
            </Button>
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                placeholder="Reset code"
                value={resetCode}
                onChange={(e) => {
                  setResetCode(e.target.value.replace(/\s+/g, "").slice(0, 6));
                  if (resetFieldErrors.code) setResetFieldErrors((prev) => ({ ...prev, code: "" }));
                }}
                aria-invalid={!!resetFieldErrors.code}
                className={resetFieldErrors.code ? "border-red-500" : undefined}
              />
              <Input
                type="password"
                placeholder="New password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                  if (resetFieldErrors.password) {
                    setResetFieldErrors((prev) => ({ ...prev, password: "" }));
                  }
                }}
                aria-invalid={!!resetFieldErrors.password}
                className={resetFieldErrors.password ? "border-red-500" : undefined}
              />
            </div>
            {(resetFieldErrors.code || resetFieldErrors.password) && (
              <div className="grid gap-1 sm:grid-cols-2">
                <div>
                  {resetFieldErrors.code && (
                    <p className="text-xs text-red-600">{resetFieldErrors.code}</p>
                  )}
                </div>
                <div>
                  {resetFieldErrors.password && (
                    <p className="text-xs text-red-600">{resetFieldErrors.password}</p>
                  )}
                </div>
              </div>
            )}
            <Button type="button" onClick={confirmReset} disabled={confirmingReset || !codeRequested}>
              {confirmingReset ? "Updating..." : "Update password"}
            </Button>
            {resetMessage && <p className="text-green-700">{resetMessage}</p>}
            {resetError && <p className="text-red-600">{resetError}</p>}
          </div>
        )}
      </div>
      <p className="text-sm text-muted-foreground mt-4">
        Don&apos;t have an account? {" "}
        <Link href="/register" className="underline">Create one</Link>
      </p>
    </section>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <section className="container mx-auto max-w-sm py-12">
          <h1 className="text-2xl font-semibold mb-6">Sign in</h1>
          <p className="text-sm text-muted-foreground">Loading login…</p>
        </section>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
