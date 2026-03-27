import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import {
  buildLeaveUpdateAuditMeta,
  isLeaveDateRangeValid,
  isValidLeaveStatusTransition,
  parseLeaveDateInput,
} from "@/lib/hr-leave-utils";
import {
  validateDecisionNoteForStatus,
  validateExpectedUpdatedAtConflict,
} from "@/lib/hr-leave-route-helpers";

const updateSchema = z.object({
  status: z.enum(["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
  type: z.enum(["ANNUAL", "SICK", "UNPAID", "OTHER"]).optional(),
  startDate: z.string().optional().or(z.literal("")),
  endDate: z.string().optional().or(z.literal("")),
  reason: z.string().optional().or(z.literal("")),
  decisionNote: z.string().optional().or(z.literal("")),
  expectedUpdatedAt: z.string().optional().or(z.literal("")),
  sourcePage: z.string().optional().or(z.literal("")),
  section: z.string().optional().or(z.literal("")),
  operation: z.string().optional().or(z.literal("")),
  resultSummary: z.string().optional().or(z.literal("")),
});

async function syncEmployeeStatusFromLeave(employeeId: string) {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, status: true },
  });
  if (!employee) return;
  if (employee.status === "SUSPENDED" || employee.status === "TERMINATED") return;

  const today = new Date();
  const activeApproved = await prisma.leaveRequest.findFirst({
    where: {
      employeeId,
      status: "APPROVED",
      startDate: { lte: today },
      endDate: { gte: today },
    },
    select: { id: true },
  });

  if (activeApproved && employee.status !== "ON_LEAVE") {
    await prisma.employee.update({
      where: { id: employeeId },
      data: { status: "ON_LEAVE" },
    });
    return;
  }

  if (!activeApproved && employee.status === "ON_LEAVE") {
    await prisma.employee.update({
      where: { id: employeeId },
      data: { status: "ACTIVE" },
    });
  }
}

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
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.status) data.status = parsed.data.status;
  if (parsed.data.type) data.type = parsed.data.type;
  if ("startDate" in parsed.data && parsed.data.startDate) {
    const nextStartDate = parseLeaveDateInput(parsed.data.startDate);
    if (!nextStartDate) {
      return NextResponse.json({ error: "Invalid start date." }, { status: 400 });
    }
    data.startDate = nextStartDate;
  }
  if ("endDate" in parsed.data && parsed.data.endDate) {
    const nextEndDate = parseLeaveDateInput(parsed.data.endDate);
    if (!nextEndDate) {
      return NextResponse.json({ error: "Invalid end date." }, { status: 400 });
    }
    data.endDate = nextEndDate;
  }
  if ("reason" in parsed.data) data.reason = parsed.data.reason?.trim() || null;
  if (parsed.data.status === "APPROVED") {
    data.approvedAt = new Date();
  }
  if (parsed.data.status && parsed.data.status !== "APPROVED") {
    data.approvedAt = null;
  }
  if (parsed.data.status === "CANCELLED") {
    data.cancelledAt = new Date();
  }
  if (parsed.data.status && parsed.data.status !== "CANCELLED") {
    data.cancelledAt = null;
  }

  try {
    const existing = await prisma.leaveRequest.findUnique({
      where: { id: resolvedParams.id },
      select: {
        id: true,
        employeeId: true,
        type: true,
        status: true,
        startDate: true,
        endDate: true,
        reason: true,
        approvedAt: true,
        cancelledAt: true,
        updatedAt: true,
      },
    });
    if (!existing) {
      return NextResponse.json({ error: "Leave request not found" }, { status: 404 });
    }

    const conflictCheck = validateExpectedUpdatedAtConflict(existing.updatedAt, parsed.data.expectedUpdatedAt);
    if (!conflictCheck.ok) {
      return NextResponse.json({ error: conflictCheck.error }, { status: conflictCheck.status });
    }

    const nextStatus = parsed.data.status ?? existing.status;
    if (parsed.data.status && !isValidLeaveStatusTransition(existing.status, parsed.data.status)) {
      return NextResponse.json(
        { error: `Invalid status transition from ${existing.status} to ${parsed.data.status}.` },
        { status: 400 },
      );
    }
    const decisionNoteCheck = validateDecisionNoteForStatus(parsed.data.status, parsed.data.decisionNote);
    if (!decisionNoteCheck.ok) {
      return NextResponse.json({ error: decisionNoteCheck.error }, { status: decisionNoteCheck.status });
    }
    const decisionNote = decisionNoteCheck.note;

    const nextStartDate = (data.startDate as Date | undefined) ?? existing.startDate;
    const nextEndDate = (data.endDate as Date | undefined) ?? existing.endDate;
    if (!isLeaveDateRangeValid(nextStartDate, nextEndDate)) {
      return NextResponse.json({ error: "End date must be after start date." }, { status: 400 });
    }

    if (nextStatus === "REQUESTED" || nextStatus === "APPROVED") {
      const overlappingLeave = await prisma.leaveRequest.findFirst({
        where: {
          id: { not: resolvedParams.id },
          employeeId: existing.employeeId,
          status: { in: ["REQUESTED", "APPROVED"] },
          startDate: { lte: nextEndDate },
          endDate: { gte: nextStartDate },
        },
        select: { id: true },
      });
      if (overlappingLeave) {
        return NextResponse.json(
          { error: "This leave overlaps another active leave request for the employee." },
          { status: 409 },
        );
      }
    }

    const leave = await prisma.leaveRequest.update({
      where: { id: resolvedParams.id },
      data,
      include: { employee: true },
    });
    try {
      await syncEmployeeStatusFromLeave(leave.employeeId);
    } catch (err) {
      console.error("Failed to sync employee leave status:", err);
    }
    const defaultOperation =
      parsed.data.status === "APPROVED"
        ? "approve_leave_request"
        : parsed.data.status === "REJECTED"
          ? "reject_leave_request"
          : parsed.data.status === "CANCELLED"
            ? "cancel_leave_request"
            : "update_leave_request";
    const operation = parsed.data.operation?.trim() || defaultOperation;
    const resultSummary =
      parsed.data.resultSummary?.trim() ||
      (decisionNote.length > 0
        ? `Leave request updated successfully. Decision note: ${decisionNote}`
        : "Leave request updated successfully.");
    const auditMeta = buildLeaveUpdateAuditMeta({
      actorId: user.id,
      actorRole: user.role,
      sourcePage: parsed.data.sourcePage?.trim() || "admin/hr/leave",
      section: parsed.data.section?.trim() || "leave-requests",
      operation,
      resultSummary,
      before: {
        employeeId: existing.employeeId,
        type: existing.type,
        status: existing.status,
        startDate: existing.startDate,
        endDate: existing.endDate,
        reason: existing.reason,
        approvedAt: existing.approvedAt,
        cancelledAt: existing.cancelledAt,
      },
      after: {
        employeeId: leave.employeeId,
        type: leave.type,
        status: leave.status,
        startDate: leave.startDate,
        endDate: leave.endDate,
        reason: leave.reason,
        approvedAt: leave.approvedAt,
        cancelledAt: leave.cancelledAt,
      },
    });
    if (decisionNote.length > 0) {
      (auditMeta as Record<string, unknown>).decisionNote = decisionNote;
    }
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_LEAVE_UPDATE",
        entityType: "LEAVE_REQUEST",
        entityId: leave.id,
        meta: auditMeta,
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(leave);
  } catch (err) {
    console.error("Error updating leave request:", err);
    return NextResponse.json({ error: "Failed to update leave request" }, { status: 500 });
  }
}
