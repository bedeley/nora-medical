import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { canAccessAdminAudit } from "@/lib/admin-audit-access";

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !canAccessAdminAudit(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const currentUser = user as AuthenticatedUser;
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-audit-saved-filter-delete-one", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;
  const ownerId = currentUser.id;
  const existing = await prisma.auditSavedFilter.findUnique({
    where: { id },
    select: { id: true, ownerId: true, name: true },
  });
  if (!existing || existing.ownerId !== ownerId) {
    return NextResponse.json({ error: "Filter not found." }, { status: 404 });
  }

  await prisma.auditSavedFilter.delete({ where: { id } });
  await recordAuditLog({
    actorId: ownerId,
    action: "AUDIT_FILTER_REMOVE",
    entityType: "AUDIT_SAVED_FILTER",
    entityId: id,
    meta: { name: existing.name },
  });
  return NextResponse.json({ ok: true });
}
