import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { Prisma } from "@prisma/client";
import {
  normalizeReviewDate,
  periodsOverlap,
  validateReviewPeriod,
} from "@/lib/hr-reviews-utils";
import {
  buildReviewWorkflowKey,
  canTransitionReviewWorkflow,
  defaultReviewWorkflowState,
  parseReviewWorkflowState,
} from "@/lib/hr-review-workflow";

const updateSchema = z.object({
  rating: z.enum(["EXCEEDS", "MEETS", "NEEDS_IMPROVEMENT", "UNSATISFACTORY"]).optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  summary: z.string().optional().or(z.literal("")),
  strengths: z.string().optional().or(z.literal("")),
  improvements: z.string().optional().or(z.literal("")),
  goals: z.string().optional().or(z.literal("")),
  workflowStatus: z.enum(["DRAFT", "SUBMITTED", "ACKNOWLEDGED"]).optional(),
  acknowledge: z.boolean().optional(),
  archived: z.boolean().optional(),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Review id is required" }, { status: 400 });
  }
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.rating) data.rating = parsed.data.rating;
  if ("summary" in parsed.data) data.summary = parsed.data.summary?.trim() || null;
  if ("strengths" in parsed.data) data.strengths = parsed.data.strengths?.trim() || null;
  if ("improvements" in parsed.data) data.improvements = parsed.data.improvements?.trim() || null;
  if ("goals" in parsed.data) data.goals = parsed.data.goals?.trim() || null;

  try {
    const existing = await prisma.performanceReview.findUnique({
      where: { id: resolvedParams.id },
      select: {
        id: true,
        employeeId: true,
        reviewerId: true,
        rating: true,
        periodStart: true,
        periodEnd: true,
        summary: true,
        strengths: true,
        improvements: true,
        goals: true,
      },
    });
    if (!existing) {
      return NextResponse.json({ error: "Review not found" }, { status: 404 });
    }

    const workflowKey = buildReviewWorkflowKey(existing.id);
    const workflowSetting = await prisma.siteSetting.findUnique({
      where: { key: workflowKey },
      select: { value: true },
    });
    const beforeWorkflow = parseReviewWorkflowState(workflowSetting?.value || defaultReviewWorkflowState());

    const nextStart = "periodStart" in parsed.data
      ? normalizeReviewDate(parsed.data.periodStart)
      : existing.periodStart;
    const nextEnd = "periodEnd" in parsed.data
      ? normalizeReviewDate(parsed.data.periodEnd)
      : existing.periodEnd;
    if (!nextStart || !nextEnd) {
      return NextResponse.json({ error: "Invalid review period." }, { status: 400 });
    }
    const periodError = validateReviewPeriod(nextStart, nextEnd);
    if (periodError) {
      return NextResponse.json({ error: periodError }, { status: 400 });
    }

    if ("periodStart" in parsed.data) data.periodStart = nextStart;
    if ("periodEnd" in parsed.data) data.periodEnd = nextEnd;

    const overlap = await prisma.performanceReview.findFirst({
      where: {
        employeeId: existing.employeeId,
        id: { not: existing.id },
        periodStart: { lte: nextEnd },
        periodEnd: { gte: nextStart },
      },
      select: { periodStart: true, periodEnd: true },
    });
    if (overlap && periodsOverlap(nextStart, nextEnd, overlap.periodStart, overlap.periodEnd)) {
      return NextResponse.json(
        {
          error: `Review period overlaps an existing review (${overlap.periodStart.toISOString().slice(0, 10)} to ${overlap.periodEnd.toISOString().slice(0, 10)}).`,
        },
        { status: 409 },
      );
    }

    const nextWorkflow = { ...beforeWorkflow };
    if (parsed.data.workflowStatus) {
      if (!canTransitionReviewWorkflow(beforeWorkflow.status, parsed.data.workflowStatus)) {
        return NextResponse.json(
          { error: `Invalid workflow transition: ${beforeWorkflow.status} to ${parsed.data.workflowStatus}.` },
          { status: 400 },
        );
      }
      nextWorkflow.status = parsed.data.workflowStatus;
      if (parsed.data.workflowStatus !== "ACKNOWLEDGED") {
        nextWorkflow.acknowledgedAt = null;
        nextWorkflow.acknowledgedBy = null;
      }
    }
    if (parsed.data.acknowledge) {
      if (!canTransitionReviewWorkflow(beforeWorkflow.status, "ACKNOWLEDGED")) {
        return NextResponse.json(
          { error: "Review can only be acknowledged after it is submitted." },
          { status: 400 },
        );
      }
      nextWorkflow.status = "ACKNOWLEDGED";
      nextWorkflow.acknowledgedAt = new Date().toISOString();
      nextWorkflow.acknowledgedBy = user.id;
    }
    if (typeof parsed.data.archived === "boolean") {
      nextWorkflow.archived = parsed.data.archived;
    }

    const review = await prisma.performanceReview.update({
      where: { id: resolvedParams.id },
      data,
      include: { employee: true },
    });
    await prisma.siteSetting.upsert({
      where: { key: workflowKey },
      update: { value: nextWorkflow as Prisma.InputJsonValue },
      create: { key: workflowKey, value: nextWorkflow as Prisma.InputJsonValue },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_REVIEW_UPDATE",
        entityType: "PERFORMANCE_REVIEW",
        entityId: review.id,
        meta: {
          sourcePage: "admin/hr/reviews",
          section: "review-history",
          operation:
            parsed.data.acknowledge
              ? "acknowledge_review"
              : typeof parsed.data.archived === "boolean"
                ? parsed.data.archived
                  ? "archive_review"
                  : "unarchive_review"
                : parsed.data.workflowStatus
                  ? "update_review_workflow"
                  : "update_review",
          before: {
            employeeId: existing.employeeId,
            reviewerId: existing.reviewerId,
            rating: existing.rating,
            periodStart: existing.periodStart.toISOString(),
            periodEnd: existing.periodEnd.toISOString(),
            summaryLength: existing.summary?.length || 0,
            strengthsLength: existing.strengths?.length || 0,
            improvementsLength: existing.improvements?.length || 0,
            goalsLength: existing.goals?.length || 0,
            workflowStatus: beforeWorkflow.status,
            archived: beforeWorkflow.archived,
            acknowledgedAt: beforeWorkflow.acknowledgedAt,
            acknowledgedBy: beforeWorkflow.acknowledgedBy,
          },
          after: {
            employeeId: review.employeeId,
            reviewerId: review.reviewerId,
            rating: review.rating,
            periodStart: review.periodStart.toISOString(),
            periodEnd: review.periodEnd.toISOString(),
            summaryLength: review.summary?.length || 0,
            strengthsLength: review.strengths?.length || 0,
            improvementsLength: review.improvements?.length || 0,
            goalsLength: review.goals?.length || 0,
            workflowStatus: nextWorkflow.status,
            archived: nextWorkflow.archived,
            acknowledgedAt: nextWorkflow.acknowledgedAt,
            acknowledgedBy: nextWorkflow.acknowledgedBy,
          },
          status: "SUCCESS",
          resultSummary: "Performance review updated successfully.",
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json({
      ...review,
      workflowStatus: nextWorkflow.status,
      workflowArchived: nextWorkflow.archived,
      workflowAcknowledgedAt: nextWorkflow.acknowledgedAt,
      workflowAcknowledgedBy: nextWorkflow.acknowledgedBy,
    });
  } catch (err) {
    console.error("Error updating review:", err);
    return NextResponse.json({ error: "Failed to update review" }, { status: 500 });
  }
}
