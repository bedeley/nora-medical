"use client";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

type AccountMe = {
  id: string;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  phoneVerifiedAt?: string | null;
};

type OrderHistoryItem = {
  id: string;
  status: string;
  total: number | string;
  amountPaid?: number | string;
  balance?: number | string;
  createdAt: string | Date;
  payments?: Array<{ amount: number | string }>;
};

function AccountContent() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const fetcher = (url: string) => fetch(url).then((r) => r.json());
  const { data } = useQuery<{ orders: OrderHistoryItem[] }>({
    queryKey: ["orders", "history"],
    queryFn: () => fetcher("/api/orders/history"),
    enabled: !!session,
    refetchInterval: 15000,
  });
  const { data: me } = useQuery<AccountMe>({
    queryKey: ["account", "me"],
    queryFn: () => fetcher("/api/account/me"),
    enabled: !!session,
    refetchInterval: 15000,
  });
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState(""); // phone verification code
  const [verifying, setVerifying] = useState(false); // phone verification flag
  const [emailOtp, setEmailOtp] = useState("");
  const [emailOtpError, setEmailOtpError] = useState<string | null>(null);
  const [emailVerifying, setEmailVerifying] = useState(false);
  const [resendingEmail, setResendingEmail] = useState(false);
  const savingRef = useRef(false);
  const focusPhone = searchParams?.get("phone") === "1";
  const phoneVerificationEnabled =
    (process.env.NEXT_PUBLIC_PHONE_VERIFICATION_ENABLED || "").toLowerCase() ===
      "1" ||
    (process.env.NEXT_PUBLIC_PHONE_VERIFICATION_ENABLED || "").toLowerCase() ===
      "true" ||
    (process.env.NEXT_PUBLIC_PHONE_VERIFICATION_ENABLED || "").toLowerCase() ===
      "yes";

  useEffect(() => {
    if (me?.phone) setPhone(me.phone);
    if (focusPhone) {
      setTimeout(() => {
        const el = document.getElementById("phone-input");
        (el as HTMLInputElement | null)?.focus();
      }, 0);
    }
  }, [me, focusPhone]);
  const hasOutstanding = (data?.orders || []).some((o) => {
    const totalPaid = (o.payments || []).reduce(
      (sum, p) => sum + Number(p.amount),
      0
    );
    const balance = Number(o.total) - totalPaid;
    return balance > 0;
  });

  // Treat phoneVerifiedAt as the generic "account verified via code" flag,
  // regardless of whether the code arrived via email or phone.
  const isEmailVerified = Boolean(me?.phoneVerifiedAt);

  if (session)
    return (
      <section className="container mx-auto py-12">
        <h1 className="text-2xl font-semibold mb-2">Account</h1>
        <p className="text-muted-foreground">Signed in as {session.user?.email}</p>
        <p className="mt-1 text-sm">
          Email verification:{" "}
          {isEmailVerified ? (
            <span className="text-green-600 font-medium">Verified</span>
          ) : (
            <span className="text-red-600 font-medium">Not verified</span>
          )}
        </p>
        {!isEmailVerified && me?.id && (
          <div className="mt-2 space-y-2 max-w-md">
            <div className="flex flex-wrap gap-2 items-center">
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  if (!me?.id || resendingEmail) return;
                  try {
                    setResendingEmail(true);
                    const res = await fetch("/api/register/resend", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ userId: me.id }),
                    });
                    const j = await res
                      .json()
                      .catch(() => ({} as { error?: string; otpChannel?: string }));
                    if (!res.ok) {
                      throw new Error(j?.error || "Failed to resend verification email");
                    }
                    const channel = j?.otpChannel || "email";
                    toast.success(
                      channel === "email"
                        ? "Verification email sent. Please check your inbox."
                        : "Verification code sent.",
                    );
                  } catch (e: unknown) {
                    const message =
                      e instanceof Error ? e.message : "Failed to resend verification email";
                    toast.error(message);
                  } finally {
                    setResendingEmail(false);
                  }
                }}
                disabled={resendingEmail}
              >
                {resendingEmail ? "Sending…" : "Resend verification email"}
              </Button>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                Enter the 6‑digit code from your email to verify your account. If you don&apos;t see it, check your spam/junk folder or wait a minute before requesting again.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  placeholder="Email code"
                  value={emailOtp}
                  onChange={(e) =>
                    setEmailOtp(e.target.value.replace(/\s+/g, "").slice(0, 6))
                  }
                  className="max-w-[140px]"
                />
                <Button
                  size="sm"
                  onClick={async () => {
                    if (!me?.id) return;
                    if (!emailOtp.trim()) {
                      setEmailOtpError("Enter the code you received.");
                      return;
                    }
                    setEmailOtpError(null);
                    try {
                      setEmailVerifying(true);
                      const res = await fetch("/api/register/verify", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          userId: me.id,
                          code: emailOtp.trim(),
                        }),
                      });
                      const j = await res
                        .json()
                        .catch(() => ({} as { error?: string }));
                      if (!res.ok) {
                        throw new Error(j?.error || "Invalid or expired code");
                      }
                      toast.success("Email verified successfully.");
                      setEmailOtp("");
                      await queryClient.invalidateQueries({
                        queryKey: ["account", "me"],
                      });
                    } catch (e: unknown) {
                      const message =
                        e instanceof Error ? e.message : "Failed to verify code.";
                      setEmailOtpError(message);
                    } finally {
                      setEmailVerifying(false);
                    }
                  }}
                  disabled={emailVerifying || emailOtp.length < 4}
                >
                  {emailVerifying ? "Verifying…" : "Verify email"}
                </Button>
              </div>
              {emailOtpError && (
                <p className="text-xs text-red-600">{emailOtpError}</p>
              )}
            </div>
          </div>
        )}
        {searchParams?.get("verify") === "1" && !isEmailVerified && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 text-amber-900 p-3 text-sm">
            Your account is not fully verified yet. Please verify your email address using the link sent to your inbox.
          </div>
        )}
        {hasOutstanding && isEmailVerified && (
          <div className="mt-3 rounded-md border border-primary/20 bg-primary/10 text-primary p-3 text-sm">
            You have unpaid orders. Please call <a href={ADMIN_PHONE_TEL} className="underline font-medium">{ADMIN_PHONE}</a> to complete payment.
          </div>
        )}
        {isEmailVerified && (
          <div className="mt-4 flex gap-3">
            <Link href="/orders" className="hidden sm:inline underline">
              Order history
            </Link>
            <Link href="/account/balance" className="hidden sm:inline underline">
              My balance
            </Link>
          </div>
        )}

        <div className="mt-8 max-w-md">
          <h2 className="text-lg font-semibold mb-2">Contact Phone</h2>
          <p className="text-sm text-muted-foreground mb-2">We use your phone to confirm orders and send receipts.</p>
          <div className="flex items-center gap-2">
            <Input id="phone-input" placeholder="Enter your phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <Button
              onClick={async () => {
                if (savingRef.current) return;
                savingRef.current = true;
                try {
                  const res = await fetch("/api/account/phone", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ phone }),
                  });
                  if (!res.ok) {
                    const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
                    throw new Error(j?.error || "Failed to update phone");
                  }
                  toast.success("Phone updated");
                  queryClient.invalidateQueries({ queryKey: ["account", "me"] });
                } catch (e: unknown) {
                  const message =
                    e instanceof Error ? e.message : "Failed to update phone";
                  toast.error(message);
                } finally {
                  savingRef.current = false;
                }
              }}
            >Save</Button>
          </div>
          <div className="mt-3 text-sm">
            <p>
              Verification status:{" "}
              {me?.phoneVerifiedAt ? (
                <span className="text-green-600">Verified</span>
              ) : (
                <span className="text-red-600">Not verified</span>
              )}
            </p>
            <p className="text-muted-foreground mt-1">
              {phoneVerificationEnabled
                ? "You can verify your number via WhatsApp/SMS to help us reach you about orders."
                : "Phone verification via WhatsApp/SMS is currently disabled. Your email verification still secures your account."}
            </p>
            {!me?.phoneVerifiedAt && phoneVerificationEnabled && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      setVerifying(true);
                      const r = await fetch("/api/account/phone/verify/request", { method: "POST" });
                      const j = await r.json().catch(() => ({} as { error?: string; channel?: string }));
                      if (!r.ok) throw new Error(j?.error || "Failed to send code");
                      toast.success(j?.channel === "whatsapp" ? "Code sent via WhatsApp" : "Code sent via SMS");
                    } catch (e: unknown) {
                      const message =
                        e instanceof Error ? e.message : "Failed to send code";
                      toast.error(message);
                    } finally {
                      setVerifying(false);
                    }
                  }}
                  disabled={verifying || !phone}
                >
                  Request Code
                </Button>
                <Input
                  placeholder="Enter code"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D+/g, '').slice(0, 6))}
                  className="max-w-[140px]"
                />
                <Button
                  onClick={async () => {
                    try {
                      setVerifying(true);
                      const r = await fetch("/api/account/phone/verify/confirm", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ code: otp }),
                      });
                      const j = await r.json().catch(() => ({} as { error?: string }));
                      if (!r.ok) throw new Error(j?.error || "Invalid code");
                      toast.success("Phone verified");
                      queryClient.invalidateQueries({ queryKey: ["account", "me"] });
                    } catch (e: unknown) {
                      const message =
                        e instanceof Error ? e.message : "Verification failed";
                      toast.error(message);
                    } finally {
                      setVerifying(false);
                    }
                  }}
                  disabled={verifying || otp.length < 4}
                >
                  Verify
                </Button>
              </div>
            )}
          </div>
        </div>

        {process.env.NEXT_PUBLIC_ACCOUNT_PASSWORD_CHANGE_ENABLED === "1" && isEmailVerified && (
          <div className="mt-10 max-w-md">
            <h2 className="text-lg font-semibold mb-2">Change Password</h2>
            <p className="text-sm text-muted-foreground mb-3">
              Update your account password. You&apos;ll use this to sign in next time.
            </p>
            <ChangePasswordForm />
          </div>
        )}
      </section>
    );
  return (
    <section className="container mx-auto py-12">
      <h1 className="text-2xl font-semibold mb-4">Account</h1>
      <p className="text-muted-foreground">You&apos;re not signed in.</p>
      <div className="mt-4 flex gap-3">
        <Link href="/login" className="underline">Sign in</Link>
        <Link href="/register" className="underline">Create account</Link>
      </div>
    </section>
  );
}

export default function AccountPage() {
  return (
    <Suspense
      fallback={
        <section className="container mx-auto py-12">
          <h1 className="text-2xl font-semibold mb-4">Account</h1>
          <p className="text-sm text-muted-foreground">Loading account…</p>
        </section>
      }
    >
      <AccountContent />
    </Suspense>
  );
}

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast.error("Fill in all password fields.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New passwords do not match.");
      return;
    }
    if (newPassword.length < 6) {
      toast.error("New password must be at least 6 characters.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(j?.error || "Failed to change password");
      }
      toast.success("Password updated successfully.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to change password";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">Current password</label>
        <Input
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">New password</label>
        <Input
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">Confirm new password</label>
        <Input
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={loading}>
        {loading ? "Updating..." : "Update password"}
      </Button>
    </form>
  );
}
