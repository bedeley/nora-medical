import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
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
import { normalizeLeaveListFilters } from "@/lib/hr-leave-route-helpers";

const createSchema = z.object({
  employeeId: z.string().min(1),
  type: z.enum(["ANNUAL", "SICK", "UNPAID", "OTHER"]).optional(),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  reason: z.string().optional().or(z.literal("")),
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
  const { page, pageSize, skip, take, where } = normalizeLeaveListFilters(searchParams);

  const [rows, total] = await prisma.$transaction([
    prisma.leaveRequest.findMany({
      where,
      include: { employee: true },
      orderBy: { startDate: "desc" },
      skip,
      take,
    }),
    prisma.leaveRequest.count({ where }),
  ]);

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

  const startDate = parseLeaveDateInput(parsed.data.startDate);
  const endDate = parseLeaveDateInput(parsed.data.endDate);
  if (!startDate || !endDate) {
    return NextResponse.json({ error: "Invalid leave dates." }, { status: 400 });
  }
  if (!isLeaveDateRangeValid(startDate, endDate)) {
    return NextResponse.json({ error: "End date must be after start date." }, { status: 400 });
  }

  try {
    const employeeExists = await prisma.employee.findUnique({
      where: { id: parsed.data.employeeId },
      select: { id: true },
    });
    if (!employeeExists) {
      return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    }

    const overlappingLeave = await prisma.leaveRequest.findFirst({
      where: {
        employeeId: parsed.data.employeeId,
        status: { in: ["REQUESTED", "APPROVED"] },
        startDate: { lte: endDate },
        endDate: { gte: startDate },
      },
      select: { id: true },
    });
    if (overlappingLeave) {
      return NextResponse.json(
        { error: "This leave overlaps another active leave request for the employee." },
        { status: 409 },
      );
    }

    const leave = await prisma.leaveRequest.create({
      data: {
        employeeId: parsed.data.employeeId,
        type: parsed.data.type ?? "ANNUAL",
        startDate,
        endDate,
        reason: parsed.data.reason?.trim() || null,
      },
      include: { employee: true },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_LEAVE_CREATE",
        entityType: "LEAVE_REQUEST",
        entityId: leave.id,
        meta: buildLeaveCreateAuditMeta({
          actorId: user.id,
          actorRole: user.role,
          sourcePage: "admin/hr/leave",
          section: "leave-requests",
          operation: "create_leave_request",
          resultSummary: "Leave request created successfully.",
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
  } catch (err) {
    console.error("Error creating leave request:", err);
    return NextResponse.json({ error: "Failed to create leave request" }, { status: 500 });
  }
}
