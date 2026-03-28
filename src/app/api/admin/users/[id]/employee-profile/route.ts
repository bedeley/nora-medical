import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { ensureEmployeeProfileForUser } from "@/lib/hr-user-employee-profile";

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  const actor = session?.user as AuthenticatedUser | undefined;
  if (!session || actor?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await rateLimit(req, "admin-user-employee-profile", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const params = await context.params;
  const userId = String(params.id || "").trim();
  if (!userId) {
    return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  }

  try {
    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        employeeProfile: { select: { id: true } },
      },
    });

    if (!targetUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (!["ADMIN", "STAFF", "ACCOUNTANT", "DISPATCHER"].includes(targetUser.role)) {
      return NextResponse.json(
        { error: "Only back-office users can have an HR profile." },
        { status: 400 },
      );
    }

    const result = await ensureEmployeeProfileForUser(prisma, {
      userId: targetUser.id,
      name: targetUser.name,
      email: targetUser.email,
      phone: targetUser.phone,
      status: "ACTIVE",
    });

    try {
      await recordAuditLog({
        actorId: actor.id,
        action: "HR_EMPLOYEE_PROFILE_ENSURE",
        entityType: "EMPLOYEE",
        entityId: result.employeeId,
        meta: {
          actor: { id: actor.id, role: actor.role },
          page: "admin/users",
          sourcePage: "admin/users",
          section: "employee-profile",
          operation: "ensure_hr_profile",
          before: {
            userId: targetUser.id,
            employeeId: targetUser.employeeProfile?.id ?? null,
            role: targetUser.role,
          },
          after: {
            userId: targetUser.id,
            employeeId: result.employeeId,
            outcome: result.outcome,
            matchedBy: result.matchedBy,
          },
          resultSummary:
            result.outcome === "created"
              ? "HR profile created successfully."
              : result.outcome === "linked"
                ? "Existing HR profile linked successfully."
                : "HR profile was already linked.",
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create or link the HR profile.";
    const status =
      error instanceof Error && /already linked to another user/i.test(error.message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
