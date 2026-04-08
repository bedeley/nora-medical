"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { toast } from "sonner";

export default function InviteClient() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") || "";

  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const [codeError, setCodeError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [confirmError, setConfirmError] = useState("");

  const submitInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setCodeError("");
    setPasswordError("");
    setConfirmError("");
    let hasError = false;
    if (!code.trim()) {
      setCodeError("Enter the 6-digit verification code.");
      hasError = true;
    }
    if (password.length < 10) {
      setPasswordError("Password must be at least 10 characters.");
      hasError = true;
    }
    if (password !== confirm) {
      setConfirmError("Passwords do not match.");
      hasError = true;
    }
    if (hasError) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/users/invite/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          code: code.trim(),
          password,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to accept invite.");
      }
      toast.success("Invite accepted. You can now sign in.");
      setSuccess(true);
      setCode("");
      setPassword("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept invite.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-muted/40 flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <h1 className="text-lg font-semibold">Employee invite</h1>
        </CardHeader>
        <CardContent>
          {!userId ? (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                This invite link is missing a user id. Please request a new invite.
              </p>
              <Link href="/login" className="underline">
                Go to sign in
              </Link>
            </div>
          ) : success ? (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                Invite accepted. You can now sign in with your email address and the new password.
              </p>
              <Button asChild className="w-full">
                <Link href="/login">Go to sign in</Link>
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                If you reached this page by mistake, ask your admin for a new invite.
              </p>
            </div>
          ) : (
            <form className="space-y-3" onSubmit={submitInvite} autoComplete="off">
              <p className="text-sm text-muted-foreground">
                Enter the verification code sent to your email and phone. If SMS failed,
                check WhatsApp.
              </p>
              <p className="text-xs text-muted-foreground">
                No username is required — this invite is tied to your account.
              </p>
              <div>
                <label className="text-xs text-muted-foreground">Verification code</label>
                <Input
                  name="invite-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="e.g., 123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {codeError ? <p className="text-xs text-red-600">{codeError}</p> : null}
              </div>
              <div>
                <label className="text-xs text-muted-foreground">New password</label>
                <Input
                  type="password"
                  name="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 10 characters"
                  autoComplete="new-password"
                />
                {passwordError ? <p className="text-xs text-red-600">{passwordError}</p> : null}
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Confirm password</label>
                <Input
                  type="password"
                  name="confirm-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Re-enter password"
                  autoComplete="new-password"
                />
                {confirmError ? <p className="text-xs text-red-600">{confirmError}</p> : null}
              </div>
              {error ? <p className="text-xs text-red-600">{error}</p> : null}
              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? "Submitting..." : "Accept invite"}
              </Button>
              <Link href="/login" className="block text-center text-xs underline">
                Back to sign in
              </Link>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
