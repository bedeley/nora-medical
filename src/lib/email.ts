type EmailResult = {
  ok: boolean;
  simulated?: boolean;
  error?: string;
};

type EmailAttachment = {
  filename: string;
  content: string | Buffer;
  type?: string;
};

type EmailOptions = {
  attachments?: EmailAttachment[];
};

function toBase64(content: string | Buffer) {
  if (typeof content === "string") return Buffer.from(content).toString("base64");
  return content.toString("base64");
}

export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  html?: string,
  options?: EmailOptions
): Promise<EmailResult> {
  const sendgridKey = process.env.SENDGRID_API_KEY || "";
  const sendgridFrom = process.env.SENDGRID_FROM || process.env.EMAIL_FROM || "";
  const resendKey = process.env.RESEND_API_KEY || "";
  const resendFrom = process.env.RESEND_FROM || process.env.EMAIL_FROM || "";
  const isDev = (process.env.NODE_ENV || "development") !== "production";
  const simulateFlag = (process.env.EMAIL_SIMULATE_ONLY || "").toLowerCase();
  const simulateOverrideOn = simulateFlag === "1" || simulateFlag === "true" || simulateFlag === "yes";
  const simulateOverrideOff = simulateFlag === "0" || simulateFlag === "false" || simulateFlag === "no";
  const shouldSimulate = simulateOverrideOn || (!simulateOverrideOff && isDev);

  const looksUnconfigured = (v: string) => {
    const s = (v || "").trim().toLowerCase();
    if (!s) return true;
    return s.includes("xxxxx") || s.includes("yourdomain.com");
  };

  // By default, simulate in development to prevent provider 401/denied errors.
  // Set EMAIL_SIMULATE_ONLY=0 to send real emails even in dev.
  if (shouldSimulate) {
    try {
      console.info("[DEV] Simulated email send:", {
        to,
        subject,
        attachments: options?.attachments?.length || 0,
      });
      if (html) console.info("[DEV] Email HTML:\n", html);
      else if (text) console.info("[DEV] Email Text:\n", text);
    } catch {}
    return { ok: true, simulated: true };
  }

  try {
    if (sendgridKey && sendgridFrom) {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sendgridKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: sendgridFrom },
          subject,
          content: [{ type: html ? "text/html" : "text/plain", value: html || text }],
          ...(options?.attachments?.length
            ? {
                attachments: options.attachments.map((attachment) => ({
                  content: toBase64(attachment.content),
                  filename: attachment.filename,
                  type: attachment.type || "application/octet-stream",
                  disposition: "attachment",
                })),
              }
            : {}),
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, error: t || `SendGrid error ${res.status}` };
      }
      return { ok: true };
    }

    if (resendKey && resendFrom) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: resendFrom,
          to: [to],
          subject,
          text,
          html,
          ...(options?.attachments?.length
            ? {
                attachments: options.attachments.map((attachment) => ({
                  filename: attachment.filename,
                  content: toBase64(attachment.content),
                  type: attachment.type || "application/octet-stream",
                })),
              }
            : {}),
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, error: t || `Resend error ${res.status}` };
      }
      return { ok: true };
    }

    // When we reach here, either production or dev with simulation disabled.
    // Treat obviously placeholder values as unconfigured and fail clearly.
    if (
      looksUnconfigured(sendgridKey) ||
      looksUnconfigured(resendKey) ||
      looksUnconfigured(sendgridFrom) ||
      looksUnconfigured(resendFrom)
    ) {
      return { ok: false, error: "Email provider not configured" };
    }
    return { ok: false, error: "Email provider not configured" };
  } catch (e: unknown) {
    if (e instanceof Error) {
      return { ok: false, error: e.message || "Email error" };
    }
    return { ok: false, error: "Email error" };
  }
}
