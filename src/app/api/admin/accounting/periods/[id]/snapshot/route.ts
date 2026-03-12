import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/origin";
import { buildPeriodSnapshot } from "@/lib/accounting-snapshots";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const snapshot = await prisma.periodCloseSnapshot.findFirst({
    where: { periodId: params.id },
    orderBy: { createdAt: "desc" },
  });
  if (!snapshot) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const existing = await prisma.periodCloseSnapshot.findFirst({
      where: { periodId: params.id },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      return NextResponse.json(existing);
    }

    const snapshotData = await buildPeriodSnapshot(params.id);
    if (!snapshotData) {
      return NextResponse.json({ error: "Period not found" }, { status: 404 });
    }

    const snapshot = await prisma.periodCloseSnapshot.create({
      data: {
        periodId: params.id,
        data: snapshotData,
      },
    });

    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: "period.snapshot",
      entityType: "FiscalPeriod",
      entityId: params.id,
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    console.error("Period snapshot error:", error);
    return NextResponse.json({ error: "Failed to create snapshot" }, { status: 500 });
  }
}
