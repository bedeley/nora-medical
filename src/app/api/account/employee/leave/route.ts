import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import {
  buildLeaveCreateAuditMeta,
  isLeaveDateRangeValid,
  parseLeaveDateInput,
} from "@/lib/hr-leave-utils";
import { EMPLOYEE_PORTAL_HOME_PAGE } from "@/lib/employee-portal";

const createSchema = z.object({
  type: z.enum(["ANNUAL", "SICK", "UNPAID", "OTHER"]),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  reason: z.string().optional().or(z.literal("")),
});

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

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const context = await requireEmployeePortalUser();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const startDate = parseLeaveDateInput(parsed.data.startDate);
  const endDate = parseLeaveDateInput(parsed.data.endDate);
  if (!startDate || !endDate) {
    return NextResponse.json({ error: "Enter valid leave dates." }, { status: 400 });
  }
  if (!isLeaveDateRangeValid(startDate, endDate)) {
    return NextResponse.json({ error: "End date must be on or after the start date." }, { status: 400 });
  }

  const overlappingLeave = await prisma.leaveRequest.findFirst({
    where: {
      employeeId: context.employee.id,
      status: { in: ["REQUESTED", "APPROVED"] },
      startDate: { lte: endDate },
      endDate: { gte: startDate },
    },
    select: { id: true },
  });
  if (overlappingLeave) {
    return NextResponse.json(
      { error: "This leave overlaps another active leave request on your profile." },
      { status: 409 },
    );
  }

  try {
    const leave = await prisma.leaveRequest.create({
      data: {
        employeeId: context.employee.id,
        type: parsed.data.type,
        startDate,
        endDate,
        reason: parsed.data.reason?.trim() || null,
      },
    });

    try {
      await recordAuditLog({
        actorId: context.user.id,
        action: "HR_LEAVE_CREATE",
        entityType: "LEAVE_REQUEST",
        entityId: leave.id,
        meta: buildLeaveCreateAuditMeta({
          actorId: context.user.id,
          actorRole: context.user.role,
          sourcePage: EMPLOYEE_PORTAL_HOME_PAGE,
          section: "employee-portal-leave",
          operation: "request_leave",
          resultSummary: "Leave request submitted successfully.",
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
        }),
      });
    } catch {
      // best-effort
    }

    return NextResponse.json(leave);
  } catch (error) {
    console.error("Employee leave request error:", error);
    return NextResponse.json({ error: "Failed to submit leave request." }, { status: 500 });
  }
}
