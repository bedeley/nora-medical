import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { assertSameOrigin } from "@/lib/origin";
import { passwordSchema } from "@/lib/validation";
import { recordAuditLog } from "@/lib/audit-log";

export async function PATCH(req: Request) {
  // Feature flag: disable password change unless explicitly enabled
  if ((process.env.ACCOUNT_PASSWORD_CHANGE_ENABLED || "").trim() !== "1") {
    return NextResponse.json(
      { error: "Password change is temporarily disabled." },
      { status: 403 }
    );
  }

  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req
      .json()
      .catch(() => ({} as { currentPassword?: unknown; newPassword?: unknown }));
    const currentPassword = String(body?.currentPassword || "");
    const newPassword = String(body?.newPassword || "");

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: "Current password and new password are required" },
        { status: 400 }
      );
    }

    const pwResult = passwordSchema.safeParse(newPassword);
    if (!pwResult.success) {
      const msg = pwResult.error.issues[0]?.message || "Password does not meet requirements";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const userId = (session.user as AuthenticatedUser).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true },
    });

    if (!user || !user.password) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      await recordAuditLog({
        actorId: user.id,
        action: "USER_PASSWORD_CHANGE_FAILED",
        entityType: "USER",
        entityId: user.id,
        request: req,
        outcome: "FAILED",
        meta: { reason: "current_password_incorrect" },
      });
      return NextResponse.json(
        { error: "Current password is incorrect" },
        { status: 400 }
      );
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashed },
    });
    await recordAuditLog({
      actorId: user.id,
      action: "USER_PASSWORD_CHANGED",
      entityType: "USER",
      entityId: user.id,
      request: req,
      outcome: "SUCCESS",
      meta: { method: "account_settings" },
    });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to change password";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
