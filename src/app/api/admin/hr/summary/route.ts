import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { summarizeMissingBankDetails } from "@/lib/hr-payslip-utils";
import { parseReviewWorkflowState, REVIEW_WORKFLOW_KEY_PREFIX } from "@/lib/hr-review-workflow";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (user.role !== "ADMIN") return null;
  return user;
}

const missingProfileWhere: Prisma.EmployeeWhereInput = {
  OR: [
    { email: null },
    { email: "" },
    { phone: null },
    { phone: "" },
    { department: null },
    { department: "" },
    { position: null },
    { position: "" },
    { hireDate: null },
  ],
};

export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [
    totalEmployees,
    activeEmployees,
    onLeaveEmployees,
    missingProfiles,
    linkedEmployees,
    openRoles,
    openIssues,
    pendingLeaveRequests,
    latestRun,
    visiblePortalDocuments,
    reviewWorkflowSettings,
    recentActivityLogs,
  ] = await Promise.all([
    prisma.employee.count(),
    prisma.employee.count({ where: { status: "ACTIVE" } }),
    prisma.employee.count({ where: { status: "ON_LEAVE" } }),
    prisma.employee.count({ where: missingProfileWhere }),
    prisma.employee.count({ where: { userId: { not: null } } }),
    prisma.jobPosting.count({ where: { status: "OPEN" } }),
    prisma.staffIssue.count({ where: { status: "OPEN" } }),
    prisma.leaveRequest.count({ where: { status: "REQUESTED" } }),
    prisma.payrollRun.findFirst({
      where: { status: { not: "CANCELLED" } },
      orderBy: { periodStart: "desc" },
      include: {
        expense: {
          select: { id: true },
        },
        _count: {
          select: { payslips: true },
        },
        payslips: {
          select: {
            employeeId: true,
            employee: {
              select: {
                id: true,
                bankName: true,
                bankAccountName: true,
                bankAccountNumber: true,
                bankCode: true,
                bankBranch: true,
              },
            },
          },
        },
      },
    }),
    prisma.employeeDocument.count({ where: { employeeVisible: true } }),
    prisma.siteSetting.findMany({
      where: {
        key: {
          startsWith: REVIEW_WORKFLOW_KEY_PREFIX,
        },
      },
      select: { value: true },
    }),
    prisma.auditLog.findMany({
      where: {
        deletedAt: null,
        OR: [
          { meta: { contains: "\"sourcePage\":\"admin/hr" } },
          { meta: { contains: "\"sourcePage\":\"/admin/hr" } },
          { meta: { contains: "\"page\":\"admin/hr" } },
          { meta: { contains: "\"page\":\"/admin/hr" } },
        ],
      },
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
  ]);

  let visiblePortalReviews = 0;
  let awaitingPortalVisibility = 0;
  for (const row of reviewWorkflowSettings) {
    const workflow = parseReviewWorkflowState(row.value);
    if (workflow.archived || workflow.status === "DRAFT") continue;
    if (workflow.employeeVisible) {
      visiblePortalReviews += 1;
    } else if (workflow.status === "SUBMITTED") {
      awaitingPortalVisibility += 1;
    }
  }

  const latestRunMissingBankSummary = latestRun ? summarizeMissingBankDetails(latestRun.payslips) : null;

  return NextResponse.json({
    people: {
      total: totalEmployees,
      active: activeEmployees,
      onLeave: onLeaveEmployees,
      missingProfiles,
      linkedEmployees,
      unlinkedEmployees: Math.max(0, totalEmployees - linkedEmployees),
    },
    hiring: {
      openRoles,
    },
    issues: {
      open: openIssues,
    },
    leave: {
      pendingRequests: pendingLeaveRequests,
    },
    payroll: latestRun
      ? {
          latestRun: {
            id: latestRun.id,
            status: latestRun.status,
            runType: latestRun.runType,
            periodStart: latestRun.periodStart.toISOString(),
            periodEnd: latestRun.periodEnd.toISOString(),
            payslipCount: latestRun._count.payslips,
            missingBankDetailsCount: latestRunMissingBankSummary?.count ?? 0,
            hasExpenseEntry: Boolean(latestRun.expense?.id),
          },
        }
      : {
          latestRun: null,
        },
    portal: {
      linkedEmployees,
      visibleDocuments: visiblePortalDocuments,
      visibleReviewSummaries: visiblePortalReviews,
      awaitingVisibilityReviewSummaries: awaitingPortalVisibility,
    },
    recentActivity: recentActivityLogs.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      createdAt: row.createdAt.toISOString(),
      actor: row.actor
        ? {
            id: row.actor.id,
            name: row.actor.name,
            email: row.actor.email,
            role: row.actor.role,
          }
        : null,
      meta: row.meta,
    })),
  });
}
