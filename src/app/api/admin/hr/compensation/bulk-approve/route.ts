import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { summarizeBulkApproveSkipReasons } from "@/lib/hr-compensation-utils";

const bulkApproveSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});
const onboardingCompensationTitle = "Compensation set";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

async function markCompensationOnboardingTask(employeeId: string) {
  const existing = await prisma.onboardingTask.findFirst({
    where: { employeeId, title: onboardingCompensationTitle },
  });
  if (existing) {
    if (existing.status !== "COMPLETE" || !existing.completedAt) {
      await prisma.onboardingTask.update({
        where: { id: existing.id },
        data: { status: "COMPLETE", completedAt: new Date() },
      });
    }
    return;
  }
  await prisma.onboardingTask.create({
    data: {
      employeeId,
      title: onboardingCompensationTitle,
      status: "COMPLETE",
      completedAt: new Date(),
    },
  });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = bulkApproveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const requestedIds = Array.from(new Set(parsed.data.ids));
  const beforeRows = await prisma.compensation.findMany({
    where: { id: { in: requestedIds } },
    select: { id: true, status: true, employeeId: true, approvedAt: true },
  });
  const pendingIds = beforeRows
    .filter((row) => row.status === "PENDING")
    .map((row) => row.id);

  if (pendingIds.length > 0) {
    await prisma.compensation.updateMany({
      where: { id: { in: pendingIds } },
      data: { status: "ACTIVE", approvedAt: new Date() },
    });
  }

  const afterRows = await prisma.compensation.findMany({
    where: { id: { in: requestedIds } },
    select: { id: true, status: true, employeeId: true, approvedAt: true },
  });

  const approvedRows = afterRows.filter((row) => row.status === "ACTIVE" && pendingIds.includes(row.id));
  const approvedIds = approvedRows.map((row) => row.id);
  const skipSummary = summarizeBulkApproveSkipReasons({
    requestedIds,
    beforeRows: beforeRows.map((row) => ({ id: row.id, status: row.status })),
    approvedIds,
  });
  const approvedEmployeeIds = Array.from(new Set(approvedRows.map((row) => row.employeeId)));

  for (const employeeId of approvedEmployeeIds) {
    try {
      await markCompensationOnboardingTask(employeeId);
    } catch {
      // best-effort
    }
  }

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "COMPENSATION_BULK_APPROVE",
      entityType: "COMPENSATION",
      entityId: approvedIds[0] ?? requestedIds[0] ?? null,
      meta: {
        sourcePage: "admin/hr/compensation",
        section: "compensation-records",
        operation: "bulk_approve_pending",
        before: {
          requestedCount: requestedIds.length,
          pendingCount: pendingIds.length,
          statusCounts: beforeRows.reduce<Record<string, number>>((acc, row) => {
            acc[row.status] = (acc[row.status] || 0) + 1;
            return acc;
          }, {}),
        },
        after: {
          approvedCount: approvedIds.length,
          skippedCount: skipSummary.skippedIds.length,
          approvedEmployeeCount: approvedEmployeeIds.length,
          skipReasonCounts: {
            notFound: skipSummary.notFoundIds.length,
            notPending: skipSummary.notPendingIds.length,
            alreadyActive: skipSummary.alreadyActiveIds.length,
            alreadyDraft: skipSummary.alreadyDraftIds.length,
          },
          statusCounts: afterRows.reduce<Record<string, number>>((acc, row) => {
            acc[row.status] = (acc[row.status] || 0) + 1;
            return acc;
          }, {}),
        },
        requestedIds,
        approvedIds,
        skippedIds: skipSummary.skippedIds,
        skippedBreakdown: {
          notFoundIds: skipSummary.notFoundIds,
          notPendingIds: skipSummary.notPendingIds,
          alreadyActiveIds: skipSummary.alreadyActiveIds,
          alreadyDraftIds: skipSummary.alreadyDraftIds,
        },
        status: "SUCCESS",
        resultSummary:
          approvedIds.length > 0
            ? `Approved ${approvedIds.length} pending compensation record(s).`
            : "No pending compensation records were approved.",
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({
    requestedCount: requestedIds.length,
    approvedCount: approvedIds.length,
    skippedCount: skipSummary.skippedIds.length,
    approvedIds,
    skippedIds: skipSummary.skippedIds,
    skippedBreakdown: {
      notFoundIds: skipSummary.notFoundIds,
      notPendingIds: skipSummary.notPendingIds,
      alreadyActiveIds: skipSummary.alreadyActiveIds,
      alreadyDraftIds: skipSummary.alreadyDraftIds,
    },
  });
}
