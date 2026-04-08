import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";

function isAuthorizedCron(req: Request) {
  return verifyCronSecret(req, "HEALTH_INCIDENT_ESCALATION_CRON_SECRET");
}

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secret = String(
    process.env.HEALTH_INCIDENT_ESCALATION_CRON_SECRET || process.env.CRON_SECRET || "",
  ).trim();
  const origin = new URL(req.url).origin;
  const res = await fetch(`${origin}/api/admin/health/ops`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
      "x-cron-secret": secret,
    },
    body: JSON.stringify({ action: "run_escalation_check" }),
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json(
      { error: body?.error || "Escalation check failed", details: body || null },
      { status: res.status || 500 },
    );
  }
  return NextResponse.json({ ok: true, result: body });
}
