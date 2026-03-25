import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

type Body = {
  start?: string | null;
  end?: string | null;
  useYtd?: boolean;
};

function isAdmin(user?: AuthenticatedUser | null) {
  return user?.role === "ADMIN";
}

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Playwright helper is disabled in production." }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAdmin(actor)) {
    return NextResponse.json({ error: "Only admins can request Playwright checks." }, { status: 403 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-accounting-pl-playwright-helper", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const start = typeof body.start === "string" ? body.start : null;
  const end = typeof body.end === "string" ? body.end : null;
  const useYtd = Boolean(body.useYtd);
  const command = "pnpm -C nora-hospital-supply e2e -- e2e/pl-report.spec.js";

  await recordAuditLog({
    actorId: actor?.id || null,
    action: "report.pl.playwright.helper.request",
    entityType: "AccountingReport",
    entityId: "profit-loss",
    meta: {
      sourcePage: "admin/accounting/reports/pl",
      start,
      end,
      useYtd,
      command,
      actorRole: actor?.role || null,
      actorEmail: actor?.email || null,
    },
  });

  return NextResponse.json({
    message: "Playwright helper request logged. Run the command in your terminal.",
    command,
  });
}
