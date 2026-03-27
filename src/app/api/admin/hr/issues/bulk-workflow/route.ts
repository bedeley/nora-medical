import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { canTransitionIssueStatus, statusRequiresResolution } from "@/lib/hr-issues-utils";

const bulkSchema = z.object({
  issueIds: z.array(z.string().min(1)).min(1).max(200),
  targetStatus: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]),
  resolution: z.string().optional().or(z.literal("")),
});

function normalizeOptional(value?: string) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const parsed = bulkSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const issueIds = Array.from(new Set(parsed.data.issueIds));
  const targetStatus = parsed.data.targetStatus;
  const resolution = normalizeOptional(parsed.data.resolution);
  if (statusRequiresResolution(targetStatus) && !resolution) {
    return NextResponse.json(
      { error: "Resolution note is required when resolving or closing issues." },
      { status: 400 },
    );
  }

  const successes: Array<{ issueId: string; beforeStatus: string; afterStatus: string }> = [];
  const failures: Array<{ issueId: string; reason: string }> = [];

  for (const issueId of issueIds) {
    const existing = await prisma.staffIssue.findUnique({ where: { id: issueId } });
    if (!existing) {
      failures.push({ issueId, reason: "Issue not found." });
      continue;
    }
    if (!canTransitionIssueStatus(existing.status, targetStatus)) {
      failures.push({
        issueId,
        reason: `Invalid transition from ${existing.status} to ${targetStatus}.`,
      });
      continue;
    }

    const updated = await prisma.staffIssue.update({
      where: { id: issueId },
      data: {
        status: targetStatus,
        ...(statusRequiresResolution(targetStatus)
          ? {
              resolution: resolution ?? existing.resolution,
              closedAt: existing.closedAt || new Date(),
            }
          : {
              closedAt: null,
            }),
      },
    });
    successes.push({
      issueId: updated.id,
      beforeStatus: existing.status,
      afterStatus: updated.status,
    });
  }

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_ISSUE_BULK_STATUS_UPDATE",
      entityType: "STAFF_ISSUE",
      entityId: "BULK",
      meta: {
        sourcePage: "admin/hr/issues",
        section: "issue-list",
        operation: `bulk_set_status_${targetStatus.toLowerCase()}`,
        attemptedIssueIds: issueIds,
        affectedIssueIds: successes.map((item) => item.issueId),
        before: successes.map((item) => ({
          issueId: item.issueId,
          status: item.beforeStatus,
        })),
        after: successes.map((item) => ({
          issueId: item.issueId,
          status: item.afterStatus,
        })),
        failureCount: failures.length,
        failures,
        status: failures.length > 0 ? "PARTIAL_SUCCESS" : "SUCCESS",
        resultSummary: "Bulk issue status update completed.",
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({
    successCount: successes.length,
    failureCount: failures.length,
    updatedIssueIds: successes.map((item) => item.issueId),
    failures,
  });
}

