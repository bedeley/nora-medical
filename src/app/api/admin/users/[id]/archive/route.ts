import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { rateLimit } from "@/lib/rate-limit";

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return new Response("Forbidden", { status: 403 });
  }
  if (!assertSameOrigin(req)) {
    return new Response("Bad origin", { status: 403 });
  }
  const limited = await rateLimit(req, "admin-user-archive", 60_000, 60);
  if (!limited.ok) {
    return new Response(JSON.stringify({ error: "Too many requests" }), { status: 429 });
  }

  const params = await context.params;
  const userId = params.id;
  if (!userId) {
    return new Response("Missing user id", { status: 400 });
  }

  const body = await req.json().catch(() => null) as {
    archived?: boolean;
    reason?: string;
    sourcePage?: string;
  } | null;
  const archived = body?.archived ?? true;
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  const sourcePage = typeof body?.sourcePage === "string" ? body.sourcePage.trim() : "";

  try {
    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, archived: true },
    });
    if (!existing) {
      return new Response("User not found", { status: 404 });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { archived },
      select: { id: true, email: true, archived: true },
    });

    try {
      await recordAuditLog({
        actorId: user?.id,
        action: archived ? "USER_ARCHIVE" : "USER_UNARCHIVE",
        entityType: "USER",
        entityId: updated.id,
        request: req,
        meta: {
          actorId: user?.id ?? null,
          actorRole: user?.role ?? null,
          targetUserId: updated.id,
          targetUserRole: existing.role,
          email: updated.email,
          from: existing.archived,
          to: updated.archived,
          reason: reason || null,
          sourcePage: sourcePage || "admin/customers",
          sourceRoute: "/api/admin/users/[id]/archive",
        },
      });
    } catch {
      // best-effort
    }

    return new Response(JSON.stringify(updated), { status: 200 });
  } catch (e) {
    console.error("Archive user error", e);
    return new Response(
      JSON.stringify({ error: "Failed to update account archive status" }),
      { status: 500 },
    );
  }
}
