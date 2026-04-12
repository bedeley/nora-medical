import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canAccessAdminAudit } from "@/lib/admin-audit-access";

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !canAccessAdminAudit(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [actions, entityTypes, actorRows] = await Promise.all([
    prisma.auditLog.findMany({
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    }),
    prisma.auditLog.findMany({
      distinct: ["entityType"],
      select: { entityType: true },
      orderBy: { entityType: "asc" },
    }),
    prisma.auditLog.findMany({
      distinct: ["actorId"],
      select: { actorId: true },
      where: { actorId: { not: null } },
    }),
  ]);

  const actorIds = actorRows.map((row) => row.actorId).filter(Boolean) as string[];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true, role: true },
        orderBy: { name: "asc" },
      })
    : [];

  return NextResponse.json({
    actions: actions.map((a) => a.action).filter(Boolean),
    entityTypes: entityTypes.map((e) => e.entityType).filter(Boolean),
    actors,
  });
}
