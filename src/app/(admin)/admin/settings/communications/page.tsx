"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";

type CommStatus = {
  whatsapp?: { ready?: boolean; missing?: string[] };
  sms?: { ready?: boolean; missing?: string[] };
  email?: { ready?: boolean; provider?: string; missing?: string[] };
};

export default function CommunicationsSettingsPage() {
  const [whatsappTo, setWhatsappTo] = useState("");
  const [smsTo, setSmsTo] = useState("");
  const [emailTo, setEmailTo] = useState("");
  const [message, setMessage] = useState("Hello from Noralls Medical Supplies");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<CommStatus | null>(null);
  const [errors, setErrors] = useState<{ whatsappTo?: string; smsTo?: string; emailTo?: string; message?: string }>({});

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/admin/comm/status");
        const j = (await r.json().catch(() => ({} as CommStatus)));
        if (r.ok) setStatus(j);
      } catch {
        // ignore status load errors; page will just show "Not Configured"
      }
    })();
  }, []);

  async function sendTest() {
    const nextErrors: { whatsappTo?: string; smsTo?: string; emailTo?: string; message?: string } = {};
    if (!whatsappTo.trim() && !smsTo.trim() && !emailTo.trim()) {
      const msg = "Provide at least one recipient.";
      nextErrors.whatsappTo = msg;
      nextErrors.smsTo = msg;
      nextErrors.emailTo = msg;
    }
    if (!message.trim()) nextErrors.message = "Message is required.";
    if (Object.values(nextErrors).some(Boolean)) {
      setErrors(nextErrors);
      return;
    }
    try {
      setLoading(true);
      setErrors({});
      const res = await fetch("/api/admin/comm/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ whatsappTo, smsTo, emailTo, message }),
      });
      const j = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) throw new Error(j?.error || "Failed");
      toast.success("Test sent");
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Failed to send test";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container mx-auto py-8 max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Communications</h1>
        <p className="text-sm text-muted-foreground">
          Check provider readiness and send test messages.
        </p>
      </header>
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Comms Status</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div className="flex items-center justify-between">
            <span>WhatsApp</span>
            {status?.whatsapp?.ready ? (
              <Badge className="bg-emerald-600">Ready</Badge>
            ) : (
              <Badge variant="secondary">Not Configured</Badge>
            )}
          </div>
          {!status?.whatsapp?.ready && status?.whatsapp?.missing?.length ? (
            <p className="text-xs text-muted-foreground">Missing: {status.whatsapp.missing.join(', ')}</p>
          ) : null}
          <div className="flex items-center justify-between">
            <span>SMS</span>
            {status?.sms?.ready ? (
              <Badge className="bg-emerald-600">Ready</Badge>
            ) : (
              <Badge variant="secondary">Not Configured</Badge>
            )}
          </div>
          {!status?.sms?.ready && status?.sms?.missing?.length ? (
            <p className="text-xs text-muted-foreground">Missing: {status.sms.missing.join(', ')}</p>
          ) : null}
          <div className="flex items-center justify-between">
            <span>Email {status?.email?.provider ? `(${String(status.email.provider).toUpperCase()})` : ''}</span>
            {status?.email?.ready ? (
              <Badge className="bg-emerald-600">Ready</Badge>
            ) : (
              <Badge variant="secondary">Not Configured</Badge>
            )}
          </div>
          {!status?.email?.ready && status?.email?.missing?.length ? (
            <p className="text-xs text-muted-foreground">Missing: {status.email.missing.join(', ')}</p>
          ) : null}
        </CardContent>
      </Card>
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Health Check Alerts</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <p>
            Use the Admin Health Check to catch data issues early. Start with a weekly review,
            then move to daily once you have steady order volume.
          </p>
          <p>
            If mismatches appear, run <strong>Run Fix</strong> or <strong>Backfill</strong>,
            then re-check until the alert clears.
          </p>
          <p>
            Auto alerts are enabled via the admin banner and email once cron is configured.
          </p>
        </CardContent>
      </Card>
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Setup Guides</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <a
                href="https://www.twilio.com/docs/whatsapp/sandbox"
                target="_blank"
                rel="noreferrer noopener"
                className="underline"
              >
                Twilio WhatsApp Sandbox Onboarding
              </a>
              <span className="text-muted-foreground"> — connect a WhatsApp sender to start sending messages.</span>
            </li>
            <li>
              <a
                href="https://www.twilio.com/docs/sms"
                target="_blank"
                rel="noreferrer noopener"
                className="underline"
              >
                Twilio SMS Documentation
              </a>
              <span className="text-muted-foreground"> — provision an SMS number or register an Alphanumeric Sender ID and obtain credentials.</span>
            </li>
            <li>
              <a
                href="https://momodeveloper.mtn.com/"
                target="_blank"
                rel="noreferrer noopener"
                className="underline"
              >
                MTN MoMo Developer Portal
              </a>
              <span className="text-muted-foreground"> — create a collection app, get subscription key and API user/key.</span>
            </li>
            <li>
              <a
                href="https://docs.sendgrid.com/for-developers/sending-email/quickstart-nodejs"
                target="_blank"
                rel="noreferrer noopener"
                className="underline"
              >
                SendGrid Quickstart (Node.js)
              </a>
              <span className="text-muted-foreground"> — set API key and sender (from) address.</span>
            </li>
            <li>
              <a
                href="https://resend.com/docs/send-with-nodejs"
                target="_blank"
                rel="noreferrer noopener"
                className="underline"
              >
                Resend: Send with Node.js
              </a>
              <span className="text-muted-foreground"> — create an API key and a from address/domain.</span>
            </li>
          </ul>
        </CardContent>
      </Card>
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Communications Test</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-1">
            <label className="text-sm">WhatsApp To (e.g., +233241234567)</label>
            <Input
              value={whatsappTo}
              onChange={(e) => {
                setWhatsappTo(e.target.value);
                if (errors.whatsappTo) setErrors((prev) => ({ ...prev, whatsappTo: "" }));
              }}
              placeholder="+233..."
              aria-invalid={!!errors.whatsappTo}
              className={errors.whatsappTo ? "border-red-500" : undefined}
            />
            {errors.whatsappTo && <p className="text-xs text-red-600">{errors.whatsappTo}</p>}
          </div>
          <div className="grid gap-1">
            <label className="text-sm">SMS To</label>
            <Input
              value={smsTo}
              onChange={(e) => {
                setSmsTo(e.target.value);
                if (errors.smsTo) setErrors((prev) => ({ ...prev, smsTo: "" }));
              }}
              placeholder="+233..."
              aria-invalid={!!errors.smsTo}
              className={errors.smsTo ? "border-red-500" : undefined}
            />
            {errors.smsTo && <p className="text-xs text-red-600">{errors.smsTo}</p>}
          </div>
          <div className="grid gap-1">
            <label className="text-sm">Email To</label>
            <Input
              value={emailTo}
              onChange={(e) => {
                setEmailTo(e.target.value);
                if (errors.emailTo) setErrors((prev) => ({ ...prev, emailTo: "" }));
              }}
              placeholder="person@example.com"
              aria-invalid={!!errors.emailTo}
              className={errors.emailTo ? "border-red-500" : undefined}
            />
            {errors.emailTo && <p className="text-xs text-red-600">{errors.emailTo}</p>}
          </div>
          <div className="grid gap-1">
            <label className="text-sm">Message</label>
            <Input
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                if (errors.message) setErrors((prev) => ({ ...prev, message: "" }));
              }}
              aria-invalid={!!errors.message}
              className={errors.message ? "border-red-500" : undefined}
            />
            {errors.message && <p className="text-xs text-red-600">{errors.message}</p>}
          </div>
          <div className="flex justify-end">
            <Button onClick={sendTest} disabled={loading}>Send Test</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
