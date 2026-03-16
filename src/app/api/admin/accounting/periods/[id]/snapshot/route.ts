import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/origin";
import { buildPeriodSnapshot } from "@/lib/accounting-snapshots";
import { extractAuditTrace, hashAuditState } from "@/lib/accounting-period-audit";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const resolvedParams = await Promise.resolve(params);
  const periodId = String(resolvedParams?.id || "").trim();
  if (!periodId) {
    return NextResponse.json({ error: "Missing period id." }, { status: 400 });
  }

  const snapshot = await prisma.periodCloseSnapshot.findFirst({
    where: { periodId },
    orderBy: { createdAt: "desc" },
  });
  if (!snapshot) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } | Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const resolvedParams = await Promise.resolve(params);
  const periodId = String(resolvedParams?.id || "").trim();
  if (!periodId) {
    return NextResponse.json({ error: "Missing period id." }, { status: 400 });
  }

  try {
    const trace = extractAuditTrace(req);
    const period = await prisma.fiscalPeriod.findUnique({
      where: { id: periodId },
      select: { id: true, status: true },
    });
    if (!period) {
      return NextResponse.json({ error: "Period not found." }, { status: 404 });
    }
    if (period.status !== "CLOSED") {
      return NextResponse.json(
        { error: "Close the fiscal period before generating a close snapshot." },
        { status: 400 },
      );
    }

    const existing = await prisma.periodCloseSnapshot.findFirst({
      where: { periodId },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      return NextResponse.json(existing);
    }

    const snapshotData = await buildPeriodSnapshot(periodId);
    if (!snapshotData) {
      return NextResponse.json({ error: "Period not found" }, { status: 404 });
    }

    const snapshot = await prisma.periodCloseSnapshot.create({
      data: {
        periodId,
        data: snapshotData,
      },
    });

    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: "period.snapshot",
      entityType: "FiscalPeriod",
      entityId: periodId,
      meta: {
        reasonCode: "MANUAL_CLOSE_REPORT_SNAPSHOT",
        traceId: trace.traceId,
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        requestPath: trace.requestPath,
        requestMethod: trace.requestMethod,
        snapshotHash: hashAuditState(snapshotData),
        periodStatus: period.status,
      },
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    console.error("Period snapshot error:", error);
    return NextResponse.json({ error: "Failed to create snapshot" }, { status: 500 });
  }
}
