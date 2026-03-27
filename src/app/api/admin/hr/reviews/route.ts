import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { Prisma } from "@prisma/client";
import {
  compareReviewRatings,
  normalizeReviewDate,
  normalizeReviewsPaging,
  normalizeReviewsSort,
  periodsOverlap,
  validateReviewPeriod,
  type ReviewRating,
} from "@/lib/hr-reviews-utils";
import {
  buildReviewWorkflowKey,
  defaultReviewWorkflowState,
  parseReviewWorkflowState,
  type ReviewWorkflowStatus,
} from "@/lib/hr-review-workflow";

const createSchema = z.object({
  employeeId: z.string().min(1),
  rating: z.enum(["EXCEEDS", "MEETS", "NEEDS_IMPROVEMENT", "UNSATISFACTORY"]).optional(),
  periodStart: z.string().min(1),
  periodEnd: z.string().min(1),
  summary: z.string().optional().or(z.literal("")),
  strengths: z.string().optional().or(z.literal("")),
  improvements: z.string().optional().or(z.literal("")),
  goals: z.string().optional().or(z.literal("")),
});

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const employeeId = searchParams.get("employeeId")?.trim() || "";
  const rating = (searchParams.get("rating")?.trim() || "").toUpperCase();
  const reviewStatus = (searchParams.get("reviewStatus")?.trim() || "").toUpperCase();
  const includeArchived = searchParams.get("includeArchived") === "1";
  const q = searchParams.get("q")?.trim() || "";
  const from = normalizeReviewDate(searchParams.get("from"));
  const to = normalizeReviewDate(searchParams.get("to"));
  const sort = normalizeReviewsSort(searchParams.get("sort"));
  const { page, pageSize, skip, take } = normalizeReviewsPaging(
    searchParams.get("page"),
    searchParams.get("pageSize"),
  );

  if ((searchParams.get("from") && !from) || (searchParams.get("to") && !to)) {
    return NextResponse.json({ error: "Invalid date filter." }, { status: 400 });
  }
  if (rating && !["EXCEEDS", "MEETS", "NEEDS_IMPROVEMENT", "UNSATISFACTORY"].includes(rating)) {
    return NextResponse.json({ error: "Invalid rating filter." }, { status: 400 });
  }
  if (reviewStatus && !["DRAFT", "SUBMITTED", "ACKNOWLEDGED"].includes(reviewStatus)) {
    return NextResponse.json({ error: "Invalid review status filter." }, { status: 400 });
  }
  if (from && to && to.getTime() < from.getTime()) {
    return NextResponse.json({ error: "To date must be on or after from date." }, { status: 400 });
  }

  const where: Prisma.PerformanceReviewWhereInput = {
    ...(employeeId ? { employeeId } : {}),
    ...(rating ? { rating: rating as ReviewRating } : {}),
    ...(from ? { periodEnd: { gte: from } } : {}),
    ...(to ? { periodStart: { lte: to } } : {}),
    ...(q
      ? {
          OR: [
            { employee: { is: { firstName: { contains: q, mode: "insensitive" } } } },
            { employee: { is: { lastName: { contains: q, mode: "insensitive" } } } },
            { summary: { contains: q, mode: "insensitive" as const } },
            { strengths: { contains: q, mode: "insensitive" as const } },
            { improvements: { contains: q, mode: "insensitive" as const } },
            { goals: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const rawRows = await prisma.performanceReview.findMany({
      where,
      include: { employee: true },
      orderBy:
        sort === "periodEnd_asc"
          ? { periodEnd: "asc" }
          : sort === "periodEnd_desc"
            ? { periodEnd: "desc" }
            : { createdAt: "desc" },
      take: 1000,
    });

  const workflowKeys = rawRows.map((row) => buildReviewWorkflowKey(row.id));
  const workflowSettings = workflowKeys.length
    ? await prisma.siteSetting.findMany({
        where: { key: { in: workflowKeys } },
        select: { key: true, value: true },
      })
    : [];
  const workflowMap = new Map<string, ReturnType<typeof parseReviewWorkflowState>>();
  workflowSettings.forEach((item) => {
    workflowMap.set(item.key, parseReviewWorkflowState(item.value));
  });

  const enrichedRows = rawRows.map((row) => {
    const workflow = workflowMap.get(buildReviewWorkflowKey(row.id)) || defaultReviewWorkflowState();
    return {
      ...row,
      workflowStatus: workflow.status,
      workflowArchived: workflow.archived,
      workflowAcknowledgedAt: workflow.acknowledgedAt,
      workflowAcknowledgedBy: workflow.acknowledgedBy,
    };
  });

  const filteredByWorkflow = enrichedRows.filter((row) => {
    if (!includeArchived && row.workflowArchived) return false;
    if (reviewStatus && row.workflowStatus !== reviewStatus) return false;
    return true;
  });

  const sortedRows =
    sort === "rating_asc" || sort === "rating_desc"
      ? [...filteredByWorkflow].sort((left, right) =>
          compareReviewRatings(
            left.rating as ReviewRating,
            right.rating as ReviewRating,
            sort === "rating_asc" ? "asc" : "desc",
          ),
        )
      : filteredByWorkflow;

  const total = sortedRows.length;
  const rows = sortedRows.slice(skip, skip + take);

  return NextResponse.json({
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const periodStart = normalizeReviewDate(parsed.data.periodStart);
  const periodEnd = normalizeReviewDate(parsed.data.periodEnd);
  if (!periodStart || !periodEnd) {
    return NextResponse.json({ error: "Invalid review period." }, { status: 400 });
  }
  const periodError = validateReviewPeriod(periodStart, periodEnd);
  if (periodError) {
    return NextResponse.json({ error: periodError }, { status: 400 });
  }

  const overlaps = await prisma.performanceReview.findFirst({
    where: {
      employeeId: parsed.data.employeeId,
      periodStart: { lte: periodEnd },
      periodEnd: { gte: periodStart },
    },
    select: { id: true, periodStart: true, periodEnd: true },
  });
  if (
    overlaps &&
    periodsOverlap(periodStart, periodEnd, overlaps.periodStart, overlaps.periodEnd)
  ) {
    return NextResponse.json(
      {
        error: `Review period overlaps an existing review (${overlaps.periodStart.toISOString().slice(0, 10)} to ${overlaps.periodEnd.toISOString().slice(0, 10)}).`,
      },
      { status: 409 },
    );
  }

  try {
    const review = await prisma.performanceReview.create({
      data: {
        employeeId: parsed.data.employeeId,
        reviewerId: user.id,
        rating: parsed.data.rating ?? "MEETS",
        periodStart,
        periodEnd,
        summary: parsed.data.summary?.trim() || null,
        strengths: parsed.data.strengths?.trim() || null,
        improvements: parsed.data.improvements?.trim() || null,
        goals: parsed.data.goals?.trim() || null,
      },
      include: { employee: true },
    });

    const workflow = defaultReviewWorkflowState();
    await prisma.siteSetting.upsert({
      where: { key: buildReviewWorkflowKey(review.id) },
      update: { value: workflow as Prisma.InputJsonValue },
      create: {
        key: buildReviewWorkflowKey(review.id),
        value: workflow as Prisma.InputJsonValue,
      },
    });

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_REVIEW_CREATE",
        entityType: "PERFORMANCE_REVIEW",
        entityId: review.id,
        meta: {
          sourcePage: "admin/hr/reviews",
          section: "review-create",
          operation: "create_review",
          before: null,
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
          },
          status: "SUCCESS",
          resultSummary: "Performance review created successfully.",
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json({
      ...review,
      workflowStatus: workflow.status as ReviewWorkflowStatus,
      workflowArchived: workflow.archived,
      workflowAcknowledgedAt: workflow.acknowledgedAt,
      workflowAcknowledgedBy: workflow.acknowledgedBy,
    });
  } catch (err) {
    console.error("Error creating review:", err);
    return NextResponse.json({ error: "Failed to create review" }, { status: 500 });
  }
}
