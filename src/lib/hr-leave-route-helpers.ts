import { normalizeLeavePagination, parseLeaveDateInput, shouldRequireDecisionNote } from "@/lib/hr-leave-utils";

type LeaveStatus = "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED";
type LeaveType = "ANNUAL" | "SICK" | "UNPAID" | "OTHER";

export function normalizeLeaveListFilters(params: URLSearchParams, now = new Date()) {
  const employeeId = params.get("employeeId")?.trim() || "";
  const statusRaw = params.get("status")?.trim() || "";
  const typeRaw = params.get("type")?.trim() || "";
  const activeTodayRaw = params.get("activeToday")?.trim() || "";
  const activeToday = activeTodayRaw === "1" || activeTodayRaw.toLowerCase() === "true";
  const allowedStatus = new Set<LeaveStatus>(["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"]);
  const allowedType = new Set<LeaveType>(["ANNUAL", "SICK", "UNPAID", "OTHER"]);
  const status = allowedStatus.has(statusRaw as LeaveStatus) ? (statusRaw as LeaveStatus) : "";
  const type = allowedType.has(typeRaw as LeaveType) ? (typeRaw as LeaveType) : "";
  const paging = normalizeLeavePagination(params.get("page"), params.get("pageSize"));

  const where = {
    ...(employeeId ? { employeeId } : {}),
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(activeToday
      ? {
          status: "APPROVED" as const,
          startDate: { lte: now },
          endDate: { gte: now },
        }
      : {}),
  };

  return {
    employeeId,
    status,
    type,
    activeToday,
    where,
    ...paging,
  };
}

export function validateExpectedUpdatedAtConflict(existingUpdatedAt: Date, expectedUpdatedAt?: string) {
  const normalized = expectedUpdatedAt?.trim() || "";
  if (!normalized) return { ok: true as const };

  const parsedExpected = parseLeaveDateInput(normalized);
  if (!parsedExpected) {
    return {
      ok: false as const,
      status: 400,
      error: "Invalid expectedUpdatedAt value.",
    };
  }
  if (existingUpdatedAt.getTime() !== parsedExpected.getTime()) {
    return {
      ok: false as const,
      status: 409,
      error: "This leave request was changed by another admin. Refresh and try again.",
    };
  }
  return { ok: true as const };
}

export function validateDecisionNoteForStatus(nextStatus?: LeaveStatus, decisionNote?: string) {
  const note = decisionNote?.trim() || "";
  if (nextStatus && shouldRequireDecisionNote(nextStatus) && note.length < 3) {
    return {
      ok: false as const,
      status: 400,
      error: "A short decision note is required when rejecting or cancelling leave.",
      note,
    };
  }
  return { ok: true as const, note };
}
