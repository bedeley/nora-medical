import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-accounting-reconciliation-open-log", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const recId = String(params?.id || "").trim();
  if (!recId) {
    return NextResponse.json({ error: "Missing reconciliation id" }, { status: 400 });
  }

  await recordAuditLog({
    actorId: user?.id || null,
    action: "reconciliation.workspace.open",
    entityType: "Reconciliation",
    entityId: recId,
    meta: {
      route: "/admin/accounting/reconciliations/[id]",
      actorRole: user?.role || null,
    },
  });

  return NextResponse.json({ ok: true });
}
