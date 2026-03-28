import { prisma } from "@/lib/prisma";
import { getPaystubDetailData } from "@/lib/hr-paystub-detail";
import {
  buildReviewWorkflowKey,
  defaultReviewWorkflowState,
  parseReviewWorkflowState,
} from "@/lib/hr-review-workflow";

export const EMPLOYEE_PORTAL_HOME_PAGE = "account/employee";
export const EMPLOYEE_PORTAL_PAYSTUB_PAGE = "account/employee/paystubs/[id]";
export const EMPLOYEE_PORTAL_PAYSTUBS_PAGE = "account/employee/paystubs";
export const EMPLOYEE_PORTAL_DOCUMENTS_PAGE = "account/employee/documents";
export const EMPLOYEE_PORTAL_LEAVE_PAGE = "account/employee/leave";
export const EMPLOYEE_PORTAL_REVIEWS_PAGE = "account/employee/reviews";

type PortalAcknowledgementState = {
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedByUserId: string | null;
};

type PortalContactRequestState = {
  requestedEmail: string | null;
  requestedPhone: string | null;
  reason: string | null;
  status: "PENDING";
  requestedAt: string;
  requestedByUserId: string;
};

type PortalLeaveType = "ANNUAL" | "SICK" | "UNPAID" | "OTHER";

type PortalLeaveRow = {
  type: PortalLeaveType;
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";
  startDate: Date;
  endDate: Date;
  cancelledAt: Date | null;
};

function envFlagEnabled(value: string | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function employeePortalReviewsEnabled() {
  return envFlagEnabled(process.env.EMPLOYEE_PORTAL_SHOW_REVIEW_SUMMARIES);
}

export function normalizeEmployeePortalSourcePage(
  value: string | null | undefined,
):
  | typeof EMPLOYEE_PORTAL_HOME_PAGE
  | typeof EMPLOYEE_PORTAL_PAYSTUB_PAGE
  | typeof EMPLOYEE_PORTAL_PAYSTUBS_PAGE
  | typeof EMPLOYEE_PORTAL_DOCUMENTS_PAGE
  | typeof EMPLOYEE_PORTAL_LEAVE_PAGE
  | typeof EMPLOYEE_PORTAL_REVIEWS_PAGE {
  const normalized = String(value || "").trim().replace(/^\/+/, "");
  if (normalized === EMPLOYEE_PORTAL_PAYSTUB_PAGE) {
    return EMPLOYEE_PORTAL_PAYSTUB_PAGE;
  }
  if (normalized === EMPLOYEE_PORTAL_PAYSTUBS_PAGE) {
    return EMPLOYEE_PORTAL_PAYSTUBS_PAGE;
  }
  if (normalized === EMPLOYEE_PORTAL_DOCUMENTS_PAGE) {
    return EMPLOYEE_PORTAL_DOCUMENTS_PAGE;
  }
  if (normalized === EMPLOYEE_PORTAL_LEAVE_PAGE) {
    return EMPLOYEE_PORTAL_LEAVE_PAGE;
  }
  if (normalized === EMPLOYEE_PORTAL_REVIEWS_PAGE) {
    return EMPLOYEE_PORTAL_REVIEWS_PAGE;
  }
  return EMPLOYEE_PORTAL_HOME_PAGE;
}

export function buildEmployeePortalDocumentAcknowledgementKey(documentId: string, userId: string) {
  return `employee.portal.document_ack.${documentId}.${userId}`;
}

export function buildEmployeePortalReviewAcknowledgementKey(reviewId: string, userId: string) {
  return `employee.portal.review_ack.${reviewId}.${userId}`;
}

export function buildEmployeePortalContactRequestKey(employeeId: string) {
  return `employee.portal.contact_request.${employeeId}`;
}

export function parsePortalAcknowledgementState(raw: unknown): PortalAcknowledgementState {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    acknowledged: Boolean(source.acknowledged),
    acknowledgedAt: source.acknowledgedAt ? String(source.acknowledgedAt) : null,
    acknowledgedByUserId: source.acknowledgedByUserId ? String(source.acknowledgedByUserId) : null,
  };
}

export function parsePortalContactRequestState(raw: unknown): PortalContactRequestState | null {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!source?.requestedAt || !source?.requestedByUserId) return null;
  return {
    requestedEmail: source.requestedEmail ? String(source.requestedEmail) : null,
    requestedPhone: source.requestedPhone ? String(source.requestedPhone) : null,
    reason: source.reason ? String(source.reason) : null,
    status: "PENDING",
    requestedAt: String(source.requestedAt),
    requestedByUserId: String(source.requestedByUserId),
  };
}

function countWorkingDays(start: Date, end: Date) {
  const current = new Date(start);
  const finish = new Date(end);
  current.setHours(0, 0, 0, 0);
  finish.setHours(0, 0, 0, 0);
  let count = 0;
  while (current <= finish) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count += 1;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

function computeUsedDays(leave: PortalLeaveRow) {
  if (leave.status !== "APPROVED" && leave.status !== "CANCELLED") return 0;
  const today = new Date();
  const endLimit =
    leave.status === "CANCELLED" && leave.cancelledAt ? new Date(leave.cancelledAt) : today;
  const cappedEnd = endLimit < leave.endDate ? endLimit : leave.endDate;
  if (cappedEnd < leave.startDate) return 0;
  const approved = countWorkingDays(leave.startDate, leave.endDate);
  const used = countWorkingDays(leave.startDate, cappedEnd);
  return Math.min(approved, used);
}

function computePortalLeaveSummary(leaveRequests: PortalLeaveRow[]) {
  const approvedTotals = { ANNUAL: 0, SICK: 0, UNPAID: 0, OTHER: 0 };
  const usedTotals = { ANNUAL: 0, SICK: 0, UNPAID: 0, OTHER: 0 };
  let pending = 0;
  const today = new Date();
  const yearStart = new Date(today.getFullYear(), 0, 1);
  const yearEnd = new Date(today.getFullYear(), 11, 31, 23, 59, 59, 999);

  leaveRequests.forEach((leave) => {
    if (leave.status === "REQUESTED") pending += 1;
    if (leave.status !== "APPROVED" && leave.status !== "CANCELLED") return;
    if (leave.endDate < yearStart || leave.startDate > yearEnd) return;
    const overlapStart = leave.startDate < yearStart ? yearStart : leave.startDate;
    const overlapEnd = leave.endDate > yearEnd ? yearEnd : leave.endDate;
    const approvedDays = countWorkingDays(overlapStart, overlapEnd);
    approvedTotals[leave.type] += approvedDays;
    usedTotals[leave.type] += computeUsedDays(leave);
  });

  const activeApprovedLeave =
    leaveRequests.find((leave) => {
      if (leave.status !== "APPROVED") return false;
      return today >= leave.startDate && today <= leave.endDate;
    }) || null;

  return {
    approvedTotals,
    usedTotals,
    pending,
    activeApprovedLeave,
  };
}

export async function getEmployeePortalData(userId: string) {
  const employee = await prisma.employee.findFirst({
    where: { userId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      department: true,
      position: true,
      status: true,
      hireDate: true,
      terminationDate: true,
      updatedAt: true,
      manager: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          department: true,
          position: true,
          status: true,
        },
      },
      compensations: {
        orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
        take: 12,
        select: {
          id: true,
          baseSalary: true,
          allowances: true,
          deductions: true,
          bonus: true,
          currency: true,
          effectiveDate: true,
          note: true,
          status: true,
        },
      },
      payslips: {
        orderBy: [{ createdAt: "desc" }],
        select: {
          id: true,
          grossPay: true,
          netPay: true,
          createdAt: true,
          payrollRunId: true,
          payrollRun: {
            select: {
              id: true,
              periodStart: true,
              periodEnd: true,
              status: true,
              runType: true,
            },
          },
        },
      },
      leaveRequests: {
        orderBy: [{ startDate: "desc" }],
        select: {
          id: true,
          type: true,
          status: true,
          startDate: true,
          endDate: true,
          reason: true,
          approvedAt: true,
          cancelledAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      onboardingTasks: {
        orderBy: [{ status: "asc" }, { dueDate: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          status: true,
          dueDate: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      documents: {
        where: { employeeVisible: true },
        orderBy: [{ uploadedAt: "desc" }],
        select: {
          id: true,
          title: true,
          fileType: true,
          employeeVisible: true,
          uploadedAt: true,
          updatedAt: true,
        },
      },
      reviews: employeePortalReviewsEnabled()
        ? {
            orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
            select: {
              id: true,
              rating: true,
              periodStart: true,
              periodEnd: true,
              summary: true,
              strengths: true,
              improvements: true,
              goals: true,
              createdAt: true,
              updatedAt: true,
            },
          }
        : false,
    },
  });

  if (!employee) return null;

  const documentAckKeys = employee.documents.map((doc) =>
    buildEmployeePortalDocumentAcknowledgementKey(doc.id, userId),
  );
  const reviewAckKeys =
    Array.isArray(employee.reviews) && employee.reviews.length > 0
      ? employee.reviews.map((review) => buildEmployeePortalReviewAcknowledgementKey(review.id, userId))
      : [];
  const workflowKeys =
    Array.isArray(employee.reviews) && employee.reviews.length > 0
      ? employee.reviews.map((review) => buildReviewWorkflowKey(review.id))
      : [];
  const settings = await prisma.siteSetting.findMany({
    where: {
      key: {
        in: [...documentAckKeys, ...reviewAckKeys, ...workflowKeys, buildEmployeePortalContactRequestKey(employee.id)],
      },
    },
    select: { key: true, value: true },
  });
  const settingMap = new Map(settings.map((row) => [row.key, row.value]));

  const documentsWithAck = employee.documents.map((doc) => {
    const ack = parsePortalAcknowledgementState(
      settingMap.get(buildEmployeePortalDocumentAcknowledgementKey(doc.id, userId)),
    );
    return {
      ...doc,
      acknowledged: ack.acknowledged,
      acknowledgedAt: ack.acknowledgedAt,
    };
  });

  let visibleReviews: Array<{
    id: string;
    rating: string;
    periodStart: Date;
    periodEnd: Date;
    summary: string | null;
    strengths: string | null;
    improvements: string | null;
    goals: string | null;
    createdAt: Date;
    updatedAt: Date;
    workflowStatus: string;
    workflowEmployeeVisible: boolean;
    acknowledged: boolean;
    acknowledgedAt: string | null;
  }> = [];

  if (employeePortalReviewsEnabled() && Array.isArray(employee.reviews) && employee.reviews.length > 0) {
    const workflowByKey = new Map(
      workflowKeys.map((key) => [key, parseReviewWorkflowState(settingMap.get(key) || defaultReviewWorkflowState())]),
    );
    visibleReviews = employee.reviews
      .map((review) => {
        const workflow =
          workflowByKey.get(buildReviewWorkflowKey(review.id)) || defaultReviewWorkflowState();
        const ack = parsePortalAcknowledgementState(
          settingMap.get(buildEmployeePortalReviewAcknowledgementKey(review.id, userId)),
        );
        return {
          ...review,
          workflowStatus: workflow.status,
          workflowEmployeeVisible: workflow.employeeVisible,
          acknowledged: ack.acknowledged,
          acknowledgedAt: ack.acknowledgedAt,
          archived: workflow.archived,
        };
      })
      .filter(
        (review) =>
          !review.archived && review.workflowStatus !== "DRAFT" && review.workflowEmployeeVisible,
      )
      .map((review) => {
        const { archived, ...rest } = review;
        void archived;
        return rest;
      });
  }

  const leaveSummary = computePortalLeaveSummary(
    employee.leaveRequests.map((leave) => ({
      type: leave.type,
      status: leave.status,
      startDate: leave.startDate,
      endDate: leave.endDate,
      cancelledAt: leave.cancelledAt,
    })),
  );

  const latestCompensation =
    employee.compensations.find((row) => row.status === "ACTIVE") || employee.compensations[0] || null;
  const latestPayslip = employee.payslips[0] || null;
  const pendingOnboardingCount = employee.onboardingTasks.filter((task) => task.status === "PENDING").length;

  return {
    employee: {
      ...employee,
      documents: documentsWithAck,
    },
    latestCompensation,
    latestPayslip,
    pendingOnboardingCount,
    leaveSummary,
    reviewsVisible: employeePortalReviewsEnabled(),
    reviews: visibleReviews,
    contactUpdateRequest: parsePortalContactRequestState(
      settingMap.get(buildEmployeePortalContactRequestKey(employee.id)),
    ),
  };
}

export async function getEmployeePortalPaystubData(userId: string, payslipId: string) {
  const employee = await prisma.employee.findFirst({
    where: { userId },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!employee) return null;

  const payload = await getPaystubDetailData(payslipId);
  if (!payload || payload.payslip.employeeId !== employee.id) {
    return null;
  }

  return {
    employee,
    ...payload,
  };
}

export async function getEmployeePortalDocument(userId: string, documentId: string) {
  return prisma.employeeDocument.findFirst({
    where: {
      id: documentId,
      employee: {
        userId,
      },
    },
    select: {
      id: true,
      employeeId: true,
      title: true,
      fileType: true,
      fileUrl: true,
      employeeVisible: true,
      uploadedAt: true,
    },
  });
}
