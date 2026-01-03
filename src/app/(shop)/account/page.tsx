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
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/currency";
import { chipToneBorderClass, chipToneClass, deliveryStatusTone, orderStatusTone } from "@/lib/status-chips";

type AccountMe = {
  id: string;
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  phoneVerifiedAt?: string | null;
  createdAt?: string | null;
  lastLoginAt?: string | null;
};

type OrderHistoryItem = {
  id: string;
  status: string;
  deliveryStatus?: string | null;
  total: number | string;
  amountPaid?: number | string;
  balance?: number | string;
  createdAt: string | Date;
  payments?: Array<{ amount: number | string }>;
};

type BalanceSummary = {
  totalDue: number;
  totalPaid: number;
  balance: number;
  unappliedFunds?: number;
  updatedAt: string | Date;
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
  const recentOrders = (data?.orders || []).slice(0, 3);
  const { data: me } = useQuery<AccountMe>({
    queryKey: ["account", "me"],
    queryFn: () => fetcher("/api/account/me"),
    enabled: !!session,
    refetchInterval: 15000,
  });
  const { data: balance } = useQuery<BalanceSummary>({
    queryKey: ["balance", "self", "account"],
    queryFn: () => fetcher("/api/balance?self=1"),
    enabled: !!session,
    refetchInterval: 30000,
  });
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState(""); // phone verification code
  const [verifying, setVerifying] = useState(false); // phone verification flag
  const [phoneError, setPhoneError] = useState("");
  const [otpError, setOtpError] = useState("");
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
  const normalizePhone = (input: string) => (input || "").trim().replace(/[^\d+]/g, "");
  const isValidPhone = (input: string) => /^\+?\d{10,15}$/.test(normalizePhone(input));

  if (session)
    return (
      <section className="container mx-auto py-12">
        <h1 className="text-2xl font-semibold mb-2">Account</h1>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <Card className="border">
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Signed in as</p>
              <p className="font-semibold">{me?.name || session.user?.email}</p>
              <p className="text-sm text-muted-foreground">{session.user?.email}</p>
            </CardContent>
          </Card>
          <Card className="border">
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Last login</p>
              <p className="font-semibold">
                {me?.lastLoginAt ? new Date(me.lastLoginAt).toLocaleString() : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Customer since</p>
              <p className="text-sm text-muted-foreground">
                {me?.createdAt ? new Date(me.createdAt).toLocaleDateString() : "—"}
              </p>
            </CardContent>
          </Card>
          <Card className="border">
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Email verification</p>
              {isEmailVerified ? (
                <p className="font-semibold text-green-600">Verified</p>
              ) : (
                <p className="font-semibold text-red-600">Not verified</p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Keep your email verified for account security.
              </p>
            </CardContent>
          </Card>
        </div>
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
          <div className={`mt-3 rounded-md border p-3 text-sm ${chipToneClass("warning")} ${chipToneBorderClass("warning")}`}>
            Your account is not fully verified yet. Please verify your email address using the link sent to your inbox.
          </div>
        )}
        {hasOutstanding && isEmailVerified && (
          <div className={`mt-3 rounded-md border p-3 text-sm ${chipToneClass("warning")} ${chipToneBorderClass("warning")}`}>
            You have unpaid orders. Please call <a href={ADMIN_PHONE_TEL} className="underline font-medium">{ADMIN_PHONE}</a> to complete payment.
          </div>
        )}
        {balance && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Card className="border">
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Outstanding balance</p>
                <p className={balance.balance > 0 ? "text-lg font-semibold text-red-600" : "text-lg font-semibold text-green-700"}>
                  {balance.balance > 0 ? formatCurrency(balance.balance) : "None"}
                </p>
              </CardContent>
            </Card>
            <Card className="border">
              <CardContent className="pt-4">
                <p className="text-xs text-muted-foreground">Store credit</p>
                <p className="text-lg font-semibold text-emerald-700">
                  {typeof balance.unappliedFunds === "number" && balance.unappliedFunds > 0
                    ? formatCurrency(balance.unappliedFunds)
                    : "None"}
                </p>
              </CardContent>
            </Card>
          </div>
        )}
        <div className="mt-4 max-w-md">
          <p className="text-sm text-muted-foreground">
            For detailed order history or balance details, use the buttons below.
          </p>
        </div>
        {isEmailVerified && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/orders" className="inline-flex">
              <Button variant="default">Order history</Button>
            </Link>
            <Link href="/account/balance" className="inline-flex">
              <Button variant="outline">My balance</Button>
            </Link>
          </div>
        )}

        {recentOrders.length > 0 && (
          <div className="mt-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Recent Orders</h2>
              <Link href="/orders" className="text-sm text-primary underline">
                View all
              </Link>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {recentOrders.map((order) => {
                const delivery = String(order.deliveryStatus || "").replaceAll("_", " ");
                const status = String(order.status || "").replaceAll("_", " ");
                const deliveryKey = String(order.deliveryStatus || "");
                const statusKey = String(order.status || "");
                const deliveryClass = chipToneClass(deliveryStatusTone(deliveryKey));
                const statusClass = chipToneClass(orderStatusTone(statusKey));
                return (
                  <Card key={order.id} className="border">
                    <CardContent className="pt-4 space-y-1">
                      <p className="text-xs text-muted-foreground">
                        {new Date(order.createdAt).toLocaleString()}
                      </p>
                      <p className="font-semibold">Order {order.id.slice(0, 8)}</p>
                      <p className="text-sm text-muted-foreground">
                        Total {formatCurrency(Number(order.total || 0))}
                      </p>
                      <div className="flex flex-wrap gap-2 text-xs">
                        <span className={`rounded-full px-2 py-0.5 ${deliveryClass}`}>
                          {delivery || "Delivery —"}
                        </span>
                        <span className={`rounded-full px-2 py-0.5 ${statusClass}`}>
                          {status || "Status —"}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-8 max-w-md">
          <h2 className="text-lg font-semibold mb-2">Contact Phone</h2>
          <p className="text-sm text-muted-foreground mb-2">
            Why we need your phone: we use it to confirm orders and send receipts.
          </p>
          <div className="flex items-center gap-2">
            <Input
              id="phone-input"
              placeholder="Enter your phone"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                if (phoneError) setPhoneError("");
              }}
              aria-invalid={!!phoneError}
              className={phoneError ? "border-red-500" : undefined}
            />
            <Button
              onClick={async () => {
                if (savingRef.current) return;
                if (!phone.trim() || !isValidPhone(phone)) {
                  setPhoneError("Enter a valid phone number.");
                  return;
                }
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
          {phoneError && <p className="mt-1 text-xs text-red-600">{phoneError}</p>}
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
                      if (!phone.trim() || !isValidPhone(phone)) {
                        setPhoneError("Enter a valid phone number.");
                        return;
                      }
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
                  onChange={(e) => {
                    setOtp(e.target.value.replace(/\D+/g, '').slice(0, 6));
                    if (otpError) setOtpError("");
                  }}
                  className={`max-w-[140px] ${otpError ? "border-red-500" : ""}`}
                  aria-invalid={!!otpError}
                />
                {otpError && <p className="text-xs text-red-600">{otpError}</p>}
                <Button
                  onClick={async () => {
                    try {
                      if (otp.trim().length < 4) {
                        setOtpError("Enter the verification code.");
                        return;
                      }
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
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const nextErrors: { current?: string; next?: string; confirm?: string } = {};
    if (!currentPassword) nextErrors.current = "Current password is required.";
    if (!newPassword) nextErrors.next = "New password is required.";
    if (!confirmPassword) nextErrors.confirm = "Confirm your new password.";
    if (newPassword && newPassword.length < 6) {
      nextErrors.next = "New password must be at least 6 characters.";
    }
    if (newPassword && confirmPassword && newPassword !== confirmPassword) {
      nextErrors.confirm = "New passwords do not match.";
    }
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      return;
    }
    setLoading(true);
    try {
      setErrors({});
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
      setErrors({});
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
          onChange={(e) => {
            setCurrentPassword(e.target.value);
            if (errors.current) setErrors((prev) => ({ ...prev, current: "" }));
          }}
          aria-invalid={!!errors.current}
          className={errors.current ? "border-red-500" : undefined}
        />
        {errors.current && <p className="text-xs text-red-600">{errors.current}</p>}
      </div>
      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">New password</label>
        <Input
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
            if (errors.next) setErrors((prev) => ({ ...prev, next: "" }));
          }}
          aria-invalid={!!errors.next}
          className={errors.next ? "border-red-500" : undefined}
        />
        {errors.next && <p className="text-xs text-red-600">{errors.next}</p>}
      </div>
      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">Confirm new password</label>
        <Input
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => {
            setConfirmPassword(e.target.value);
            if (errors.confirm) setErrors((prev) => ({ ...prev, confirm: "" }));
          }}
          aria-invalid={!!errors.confirm}
          className={errors.confirm ? "border-red-500" : undefined}
        />
        {errors.confirm && <p className="text-xs text-red-600">{errors.confirm}</p>}
      </div>
      <Button type="submit" disabled={loading}>
        {loading ? "Updating..." : "Update password"}
      </Button>
    </form>
  );
}
