import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

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
  const employeeId = searchParams.get("employeeId")?.trim() || "";
  const statusRaw = searchParams.get("status")?.trim() || "";
  const typeRaw = searchParams.get("type")?.trim() || "";
  const allowedStatus = new Set(["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"]);
  const allowedType = new Set(["ANNUAL", "SICK", "UNPAID", "OTHER"]);
  const status = allowedStatus.has(statusRaw) ? statusRaw : "";
  const type = allowedType.has(typeRaw) ? typeRaw : "";

  const rows = await prisma.leaveRequest.findMany({
    where: {
      ...(employeeId ? { employeeId } : {}),
      ...(status ? { status: status as "REQUESTED" } : {}),
      ...(type ? { type: type as "ANNUAL" } : {}),
    },
    include: { employee: true },
    orderBy: { startDate: "desc" },
    take: 200,
  });

  return NextResponse.json({ rows });
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

  const startDate = new Date(parsed.data.startDate);
  const endDate = new Date(parsed.data.endDate);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return NextResponse.json({ error: "Invalid leave dates." }, { status: 400 });
  }
  if (endDate < startDate) {
    return NextResponse.json({ error: "End date must be after start date." }, { status: 400 });
  }

  try {
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
        meta: {
          employeeId: leave.employeeId,
          type: leave.type,
          status: leave.status,
          startDate: leave.startDate.toISOString(),
          endDate: leave.endDate.toISOString(),
        },
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
