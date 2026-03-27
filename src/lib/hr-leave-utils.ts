type LeaveStatus = "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";
type LeaveType = "ANNUAL" | "SICK" | "UNPAID" | "OTHER";

export type LeaveAuditSnapshot = {
  employeeId: string;
  type: LeaveType;
  status: LeaveStatus;
  startDate: string;
  endDate: string;
  reason: string | null;
  approvedAt: string | null;
  cancelledAt: string | null;
};

const transitionMap: Record<LeaveStatus, LeaveStatus[]> = {
  REQUESTED: ["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["APPROVED", "CANCELLED"],
  REJECTED: ["REJECTED"],
  CANCELLED: ["CANCELLED"],
};

export function isValidLeaveStatusTransition(from: LeaveStatus, to: LeaveStatus) {
  return transitionMap[from].includes(to);
}

export function parseLeaveDateInput(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function isLeaveDateRangeValid(startDate: Date, endDate: Date) {
  return endDate.getTime() >= startDate.getTime();
}

export function normalizeLeavePagination(pageRaw: string | null, pageSizeRaw: string | null) {
  const parsedPage = Number(pageRaw);
  const parsedPageSize = Number(pageSizeRaw);
  const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;
  const pageSize =
    Number.isFinite(parsedPageSize) && parsedPageSize >= 1
      ? Math.min(200, Math.floor(parsedPageSize))
      : 50;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function isLeaveActiveOnDate(params: {
  status: LeaveStatus;
  startDate: Date;
  endDate: Date;
  date?: Date;
}) {
  if (params.status !== "APPROVED") return false;
  const targetDate = params.date ? new Date(params.date) : new Date();
  const start = new Date(params.startDate);
  const end = new Date(params.endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  targetDate.setHours(12, 0, 0, 0);
  return targetDate >= start && targetDate <= end;
}

export function shouldRequireDecisionNote(status: LeaveStatus) {
  return status === "REJECTED" || status === "CANCELLED";
}

export function humanizeLeaveType(type: LeaveType) {
  switch (type) {
    case "ANNUAL":
      return "Annual leave";
    case "SICK":
      return "Sick leave";
    case "UNPAID":
      return "Unpaid leave";
    case "OTHER":
      return "Other leave";
    default:
      return type;
  }
}

export function humanizeLeaveStatus(status: LeaveStatus) {
  switch (status) {
    case "REQUESTED":
      return "Requested";
    case "APPROVED":
      return "Approved";
    case "REJECTED":
      return "Rejected";
    case "CANCELLED":
      return "Cancelled";
    default:
      return status;
  }
}

function buildLeaveAuditSnapshot(input: {
  employeeId: string;
  type: LeaveType;
  status: LeaveStatus;
  startDate: Date;
  endDate: Date;
  reason?: string | null;
  approvedAt?: Date | null;
  cancelledAt?: Date | null;
}): LeaveAuditSnapshot {
  return {
    employeeId: input.employeeId,
    type: input.type,
    status: input.status,
    startDate: input.startDate.toISOString(),
    endDate: input.endDate.toISOString(),
    reason: input.reason ?? null,
    approvedAt: input.approvedAt?.toISOString() ?? null,
    cancelledAt: input.cancelledAt?.toISOString() ?? null,
  };
}

export function buildLeaveCreateAuditMeta(params: {
  actorId: string;
  actorRole?: string;
  sourcePage: string;
  section: string;
  operation: string;
  resultSummary: string;
  after: {
    employeeId: string;
    type: LeaveType;
    status: LeaveStatus;
    startDate: Date;
    endDate: Date;
    reason?: string | null;
    approvedAt?: Date | null;
    cancelledAt?: Date | null;
  };
}) {
  return {
    actor: {
      id: params.actorId,
      role: params.actorRole ?? "UNKNOWN",
    },
    sourcePage: params.sourcePage,
    section: params.section,
    operation: params.operation,
    before: null,
    after: buildLeaveAuditSnapshot(params.after),
    status: "SUCCESS",
    resultSummary: params.resultSummary,
  };
}

export function buildLeaveUpdateAuditMeta(params: {
  actorId: string;
  actorRole?: string;
  sourcePage: string;
  section: string;
  operation: string;
  resultSummary: string;
  before: {
    employeeId: string;
    type: LeaveType;
    status: LeaveStatus;
    startDate: Date;
    endDate: Date;
    reason?: string | null;
    approvedAt?: Date | null;
    cancelledAt?: Date | null;
  };
  after: {
    employeeId: string;
    type: LeaveType;
    status: LeaveStatus;
    startDate: Date;
    endDate: Date;
    reason?: string | null;
    approvedAt?: Date | null;
    cancelledAt?: Date | null;
  };
}) {
  return {
    actor: {
      id: params.actorId,
      role: params.actorRole ?? "UNKNOWN",
    },
    sourcePage: params.sourcePage,
    section: params.section,
    operation: params.operation,
    before: buildLeaveAuditSnapshot(params.before),
    after: buildLeaveAuditSnapshot(params.after),
    status: "SUCCESS",
    resultSummary: params.resultSummary,
  };
}
