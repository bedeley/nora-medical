import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-user-force-logout", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const params = await context.params;
  const userId = params.id;
  if (!userId) {
    return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  }

  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { sessionInvalidBefore: new Date() },
      select: { id: true, email: true },
    });

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "USER_FORCE_LOGOUT",
        entityType: "USER",
        entityId: updated.id,
        request: req,
        outcome: "SUCCESS",
        meta: { email: updated.email },
      });
      await recordAuditLog({
        action: "USER_SESSION_INVALIDATED",
        entityType: "USER",
        entityId: updated.id,
        request: req,
        outcome: "SUCCESS",
        meta: {
          email: updated.email,
          invalidatedByUserId: user.id,
          invalidatedByRole: user.role,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Force logout error:", error);
    return NextResponse.json({ error: "Failed to force logout" }, { status: 500 });
  }
}
