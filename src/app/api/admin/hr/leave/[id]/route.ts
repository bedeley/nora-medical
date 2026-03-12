import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const updateSchema = z.object({
  status: z.enum(["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
  type: z.enum(["ANNUAL", "SICK", "UNPAID", "OTHER"]).optional(),
  startDate: z.string().optional().or(z.literal("")),
  endDate: z.string().optional().or(z.literal("")),
  reason: z.string().optional().or(z.literal("")),
});

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
  if ("startDate" in parsed.data && parsed.data.startDate) data.startDate = new Date(parsed.data.startDate);
  if ("endDate" in parsed.data && parsed.data.endDate) data.endDate = new Date(parsed.data.endDate);
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
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Leave request not found" }, { status: 404 });
    }

    const leave = await prisma.leaveRequest.update({
      where: { id: resolvedParams.id },
      data,
      include: { employee: true },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_LEAVE_UPDATE",
        entityType: "LEAVE_REQUEST",
        entityId: leave.id,
        meta: {
          employeeId: leave.employeeId,
          status: leave.status,
          type: leave.type,
        },
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
