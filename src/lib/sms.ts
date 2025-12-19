export async function sendSms(to: string, body: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const alphanumericFrom = process.env.TWILIO_ALPHANUMERIC_SENDER_ID;
  const numericFrom = process.env.TWILIO_FROM_NUMBER;
  const from = alphanumericFrom || numericFrom;

  if (!sid || !token || !from) {
    return { ok: false, error: "SMS not configured (missing TWILIO env)" };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const params = new URLSearchParams();
  params.append("To", to);
  params.append("From", from);
  params.append("Body", body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: text || `Twilio error ${res.status}` };
  }

  return { ok: true };
}
