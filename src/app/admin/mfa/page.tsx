"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { toast } from "sonner";

export default function AdminMfaPage() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function onVerify() {
    if (code.length !== 6) {
      setError("Enter the 6-digit code.");
      return;
    }
    try {
      setLoading(true);
      setError("");
      const r = await fetch("/api/auth/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const j = (await r.json().catch(() => ({} as { error?: string })));
      if (!r.ok) throw new Error(j?.error || "Verification failed");
      toast.success("2FA verified");
      // Navigate back to dashboard
      window.location.href = "/admin/dashboard";
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Verification failed";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container mx-auto py-10 max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>Two-Factor Authentication</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-sm text-muted-foreground">Enter the 6-digit code from your authenticator app to continue.</p>
          <Input
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D+/g, "").slice(0, 6));
              if (error) setError("");
            }}
            aria-invalid={!!error}
            className={error ? "border-red-500" : ""}
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <Button onClick={onVerify} disabled={loading || code.length !== 6}>Verify</Button>
        </CardContent>
      </Card>
    </div>
  );
}
