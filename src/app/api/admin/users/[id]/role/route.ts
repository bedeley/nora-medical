import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Role } from "@/lib/prisma-enums";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { rateLimit } from "@/lib/rate-limit";

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  // Feature flag: disable role management unless explicitly enabled
  if ((process.env.ADMIN_ROLE_MANAGEMENT_ENABLED || "").trim() !== "1") {
    return NextResponse.json(
      { error: "Role management is temporarily disabled." },
      { status: 403 }
    );
  }

  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as AuthenticatedUser | undefined;
  if (!session || sessionUser?.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const protectedAdmins = String(process.env.PROTECTED_ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-user-role", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const params = await context.params;
  const id = params.id;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      role?: string;
    };
    const roleRaw = String(body?.role || "").toUpperCase();
    const allowedRoles = ["ADMIN", "CUSTOMER", "STAFF", "ACCOUNTANT", "DISPATCHER"];
    if (!roleRaw || !allowedRoles.includes(roleRaw)) {
      return NextResponse.json(
        { error: "Role must be one of ADMIN, STAFF, ACCOUNTANT, DISPATCHER, CUSTOMER" },
        { status: 400 }
      );
    }

    const targetRole = roleRaw as keyof typeof Role;

    // Prevent demoting yourself out of ADMIN
    const currentUserId = sessionUser.id;
    if (currentUserId === id && targetRole !== "ADMIN") {
      return NextResponse.json(
        { error: "You cannot remove your own admin access." },
        { status: 400 }
      );
    }

    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, role: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    if (
      existing.role === "ADMIN" &&
      existing.email &&
      protectedAdmins.includes(existing.email.toLowerCase()) &&
      targetRole !== "ADMIN"
    ) {
      return NextResponse.json(
        { error: "Protected admin roles cannot be changed." },
        { status: 400 },
      );
    }

    const user = await prisma.user.update({
      where: { id },
      data: { role: Role[targetRole] },
      select: { id: true, email: true, role: true },
    });

    try {
      await recordAuditLog({
        actorId: sessionUser.id,
        action: "USER_ROLE_UPDATE",
        entityType: "USER",
        entityId: user.id,
        meta: {
          email: user.email,
          from: existing.role,
          to: user.role,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ user });
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "Failed to update role";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
