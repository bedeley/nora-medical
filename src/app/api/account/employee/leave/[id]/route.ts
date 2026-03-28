import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { buildLeaveUpdateAuditMeta } from "@/lib/hr-leave-utils";
import { EMPLOYEE_PORTAL_HOME_PAGE } from "@/lib/employee-portal";

async function requireEmployeePortalUser() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) return null;

  const employee = await prisma.employee.findFirst({
    where: { userId: user.id },
    select: {
      id: true,
      firstName: true,
      lastName: true,
    },
  });
  if (!employee) return null;

  return { user, employee };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const context = await requireEmployeePortalUser();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolvedParams = await params;
  const leaveId = String(resolvedParams?.id || "").trim();
  if (!leaveId) {
    return NextResponse.json({ error: "Leave request id is required." }, { status: 400 });
  }

  const leave = await prisma.leaveRequest.findFirst({
    where: {
      id: leaveId,
      employeeId: context.employee.id,
    },
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
    },
  });

  if (!leave) {
    return NextResponse.json({ error: "Leave request not found." }, { status: 404 });
  }

  if (leave.status !== "REQUESTED") {
    return NextResponse.json(
      { error: "Only pending leave requests can be cancelled from the employee portal." },
      { status: 409 },
    );
  }

  try {
    const updated = await prisma.leaveRequest.update({
      where: { id: leave.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        approvedAt: null,
      },
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
      },
    });

    try {
      await recordAuditLog({
        actorId: context.user.id,
        action: "HR_LEAVE_UPDATE",
        entityType: "LEAVE_REQUEST",
        entityId: updated.id,
        meta: buildLeaveUpdateAuditMeta({
          actorId: context.user.id,
          actorRole: context.user.role,
          sourcePage: EMPLOYEE_PORTAL_HOME_PAGE,
          section: "employee-portal-leave",
          operation: "cancel_leave_request",
          resultSummary: "Leave request cancelled successfully.",
          before: {
            employeeId: leave.employeeId,
            type: leave.type,
            status: leave.status,
            startDate: leave.startDate,
            endDate: leave.endDate,
            reason: leave.reason,
            approvedAt: leave.approvedAt,
            cancelledAt: leave.cancelledAt,
          },
          after: {
            employeeId: updated.employeeId,
            type: updated.type,
            status: updated.status,
            startDate: updated.startDate,
            endDate: updated.endDate,
            reason: updated.reason,
            approvedAt: updated.approvedAt,
            cancelledAt: updated.cancelledAt,
          },
        }),
      });
    } catch {
      // best-effort
    }

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Employee leave cancel error:", error);
    return NextResponse.json({ error: "Failed to cancel leave request." }, { status: 500 });
  }
}
