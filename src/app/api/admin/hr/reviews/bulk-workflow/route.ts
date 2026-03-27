import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import {
  buildReviewWorkflowKey,
  canTransitionReviewWorkflow,
  defaultReviewWorkflowState,
  parseReviewWorkflowState,
} from "@/lib/hr-review-workflow";

const bulkWorkflowSchema = z.object({
  reviewIds: z.array(z.string().min(1)).min(1).max(200),
  operation: z.enum(["SUBMIT", "ACKNOWLEDGE", "ARCHIVE", "UNARCHIVE"]),
});

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

  const parsed = bulkWorkflowSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const reviewIds = Array.from(new Set(parsed.data.reviewIds));
  const operation = parsed.data.operation;
  const successes: Array<{
    reviewId: string;
    beforeStatus: string;
    afterStatus: string;
    beforeArchived: boolean;
    afterArchived: boolean;
  }> = [];
  const failures: Array<{ reviewId: string; reason: string }> = [];

  for (const reviewId of reviewIds) {
    const review = await prisma.performanceReview.findUnique({
      where: { id: reviewId },
      select: { id: true },
    });
    if (!review) {
      failures.push({ reviewId, reason: "Review not found." });
      continue;
    }

    const key = buildReviewWorkflowKey(review.id);
    const existingWorkflowSetting = await prisma.siteSetting.findUnique({
      where: { key },
      select: { value: true },
    });
    const beforeWorkflow = parseReviewWorkflowState(
      existingWorkflowSetting?.value || defaultReviewWorkflowState(),
    );
    const nextWorkflow = { ...beforeWorkflow };

    if (operation === "SUBMIT") {
      if (!canTransitionReviewWorkflow(beforeWorkflow.status, "SUBMITTED")) {
        failures.push({
          reviewId,
          reason: `Cannot submit from ${beforeWorkflow.status}.`,
        });
        continue;
      }
      nextWorkflow.status = "SUBMITTED";
      nextWorkflow.acknowledgedAt = null;
      nextWorkflow.acknowledgedBy = null;
    } else if (operation === "ACKNOWLEDGE") {
      if (!canTransitionReviewWorkflow(beforeWorkflow.status, "ACKNOWLEDGED")) {
        failures.push({
          reviewId,
          reason: `Cannot acknowledge from ${beforeWorkflow.status}.`,
        });
        continue;
      }
      nextWorkflow.status = "ACKNOWLEDGED";
      nextWorkflow.acknowledgedAt = new Date().toISOString();
      nextWorkflow.acknowledgedBy = user.id;
    } else if (operation === "ARCHIVE") {
      nextWorkflow.archived = true;
    } else {
      nextWorkflow.archived = false;
    }

    await prisma.siteSetting.upsert({
      where: { key },
      update: { value: nextWorkflow as Prisma.InputJsonValue },
      create: { key, value: nextWorkflow as Prisma.InputJsonValue },
    });
    successes.push({
      reviewId,
      beforeStatus: beforeWorkflow.status,
      afterStatus: nextWorkflow.status,
      beforeArchived: beforeWorkflow.archived,
      afterArchived: nextWorkflow.archived,
    });
  }

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_REVIEW_BULK_WORKFLOW_UPDATE",
      entityType: "PERFORMANCE_REVIEW",
      entityId: "BULK",
      meta: {
        sourcePage: "admin/hr/reviews",
        section: "review-history",
        operation: `bulk_${operation.toLowerCase()}`,
        attemptedReviewIds: reviewIds,
        affectedReviewIds: successes.map((item) => item.reviewId),
        before: successes.map((item) => ({
          reviewId: item.reviewId,
          workflowStatus: item.beforeStatus,
          archived: item.beforeArchived,
        })),
        after: successes.map((item) => ({
          reviewId: item.reviewId,
          workflowStatus: item.afterStatus,
          archived: item.afterArchived,
        })),
        failureCount: failures.length,
        failures,
        status: failures.length > 0 ? "PARTIAL_SUCCESS" : "SUCCESS",
        resultSummary: `Bulk workflow operation ${operation.toLowerCase()} completed.`,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({
    successCount: successes.length,
    failureCount: failures.length,
    updatedReviewIds: successes.map((item) => item.reviewId),
    failures,
  });
}
