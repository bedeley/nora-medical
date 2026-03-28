import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import {
  buildEmployeePortalReviewAcknowledgementKey,
  EMPLOYEE_PORTAL_REVIEWS_PAGE,
  employeePortalReviewsEnabled,
} from "@/lib/employee-portal";
import { buildReviewWorkflowKey, parseReviewWorkflowState } from "@/lib/hr-review-workflow";
import { prisma } from "@/lib/prisma";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolvedParams = await params;
  if (!resolvedParams?.id) {
    return NextResponse.json({ error: "Review id is required." }, { status: 400 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  if (!employeePortalReviewsEnabled()) {
    return NextResponse.json({ error: "Review summaries are not available." }, { status: 404 });
  }

  const employee = await prisma.employee.findFirst({
    where: { userId: user.id },
    select: { id: true },
  });
  if (!employee) {
    return NextResponse.json({ error: "Employee profile not found." }, { status: 404 });
  }

  const review = await prisma.performanceReview.findFirst({
    where: { id: resolvedParams.id, employeeId: employee.id },
    select: { id: true, summary: true, rating: true, periodStart: true, periodEnd: true },
  });
  if (!review) {
    return NextResponse.json({ error: "Review not found." }, { status: 404 });
  }

  const workflow = parseReviewWorkflowState(
    (
      await prisma.siteSetting.findUnique({
        where: { key: buildReviewWorkflowKey(review.id) },
        select: { value: true },
      })
    )?.value,
  );
  if (!workflow.employeeVisible || workflow.archived || workflow.status === "DRAFT") {
    return NextResponse.json({ error: "Review summary not available." }, { status: 404 });
  }

  const key = buildEmployeePortalReviewAcknowledgementKey(review.id, user.id);
  const acknowledgedAt = new Date().toISOString();
  await prisma.siteSetting.upsert({
    where: { key },
    update: {
      value: {
        acknowledged: true,
        acknowledgedAt,
        acknowledgedByUserId: user.id,
      } as Prisma.InputJsonValue,
    },
    create: {
      key,
      value: {
        acknowledged: true,
        acknowledgedAt,
        acknowledgedByUserId: user.id,
      } as Prisma.InputJsonValue,
    },
  });

  await recordAuditLog({
    actorId: user.id,
    action: "HR_REVIEW_ACKNOWLEDGE",
    entityType: "PERFORMANCE_REVIEW",
    entityId: review.id,
    meta: {
      page: EMPLOYEE_PORTAL_REVIEWS_PAGE,
      sourcePage: EMPLOYEE_PORTAL_REVIEWS_PAGE,
      section: "employee-portal-reviews",
      operation: "acknowledge_review_summary",
      before: { acknowledged: false },
      after: {
        acknowledged: true,
        acknowledgedAt,
        rating: review.rating,
        periodStart: review.periodStart.toISOString(),
        periodEnd: review.periodEnd.toISOString(),
      },
      status: "SUCCESS",
      resultSummary: "Review summary acknowledged successfully.",
    },
  });

  return NextResponse.json({ ok: true, acknowledgedAt });
}
