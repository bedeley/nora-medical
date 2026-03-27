import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Role } from "@/lib/prisma-enums";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

function splitName(fullName: string) {
  const cleaned = String(fullName || "").trim();
  if (!cleaned) return { firstName: "Employee", lastName: "User" };
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: parts[0], lastName: "Employee" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "hr-employee-backfill-users", 60_000, 10);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const users = await prisma.user.findMany({
      where: {
        role: { in: [Role.ADMIN, Role.STAFF, Role.ACCOUNTANT] },
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        employeeProfile: { select: { id: true } },
      },
    });

    let created = 0;
    let linked = 0;
    let skipped = 0;

    for (const u of users) {
      if (u.employeeProfile?.id) {
        skipped += 1;
        continue;
      }
      const existingEmployee = await prisma.employee.findFirst({
        where: {
          OR: [
            u.email ? { email: u.email } : undefined,
            u.phone ? { phone: u.phone } : undefined,
          ].filter(Boolean) as { email?: string; phone?: string }[],
        },
        select: { id: true, userId: true },
      });
      if (existingEmployee) {
        if (!existingEmployee.userId) {
          await prisma.employee.update({
            where: { id: existingEmployee.id },
            data: { userId: u.id },
          });
          linked += 1;
        } else {
          skipped += 1;
        }
        continue;
      }

      const nameParts = splitName(u.name || "");
      await prisma.employee.create({
        data: {
          firstName: nameParts.firstName,
          lastName: nameParts.lastName,
          email: u.email,
          phone: u.phone,
          userId: u.id,
          status: "ACTIVE",
        },
      });
      created += 1;
    }

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_EMPLOYEE_BACKFILL",
        entityType: "Employee",
        entityId: "bulk",
        meta: {
          actor: { id: user.id, role: user.role },
          sourcePage: "admin/hr/staff",
          section: "employee-backfill",
          operation: "backfill_users_to_employees",
          before: { created: 0, linked: 0, skipped: users.length },
          after: { created, linked, skipped },
          resultSummary: `Employee backfill completed (created: ${created}, linked: ${linked}, skipped: ${skipped}).`,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ created, linked, skipped });
  } catch (error) {
    console.error("Employee backfill error:", error);
    return NextResponse.json({ error: "Failed to backfill employees" }, { status: 500 });
  }
}
