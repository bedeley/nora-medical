import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

const actionSchema = z.object({
  action: z.enum([
    "accounting.reconcile.refresh",
    "accounting.reconcile.export",
    "accounting.reconcile.drilldown",
  ]),
  meta: z.record(z.string(), z.unknown()).optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-accounting-reconcile-actions", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const start = String(parsed.data.meta?.start || "");
  const end = String(parsed.data.meta?.end || "");
  const periodScope = `${start || "all"}..${end || "all"}`;

  await recordAuditLog({
    actorId: user?.id || null,
    action: parsed.data.action,
    entityType: "AccountingReconcile",
    entityId: periodScope,
    meta: {
      route: "/admin/accounting/reconcile",
      actorRole: user?.role || null,
      ...parsed.data.meta,
    },
  });

  return NextResponse.json({ ok: true });
}

