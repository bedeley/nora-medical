import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const taskSchema = z.object({
  employeeId: z.string().min(1),
  title: z.string().min(2),
  dueDate: z.string().datetime().optional().or(z.literal("")),
  sourcePage: z.string().optional().or(z.literal("")),
  section: z.string().optional().or(z.literal("")),
  operation: z.string().optional().or(z.literal("")),
  resultSummary: z.string().optional().or(z.literal("")),
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
  if (!employeeId) {
    return NextResponse.json({ error: "employeeId is required" }, { status: 400 });
  }

  const tasks = await prisma.onboardingTask.findMany({
    where: { employeeId },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ rows: tasks });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = taskSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const dueDate = parsed.data.dueDate ? new Date(parsed.data.dueDate) : null;

  const task = await prisma.onboardingTask.create({
    data: {
      employeeId: parsed.data.employeeId,
      title: parsed.data.title.trim(),
      dueDate,
      status: "PENDING",
    },
  });

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_ONBOARDING_CREATE",
      entityType: "ONBOARDING_TASK",
      entityId: task.id,
      meta: {
        actor: {
          id: user.id,
          role: user.role,
        },
        sourcePage: parsed.data.sourcePage?.trim() || "admin/hr/staff/[id]",
        section: parsed.data.section?.trim() || "onboarding-checklist",
        operation: parsed.data.operation?.trim() || "create_onboarding_task",
        before: null,
        after: {
          employeeId: task.employeeId,
          status: task.status,
          title: task.title,
          dueDate: task.dueDate?.toISOString?.() ?? null,
          completedAt: task.completedAt?.toISOString?.() ?? null,
        },
        status: "SUCCESS",
        resultSummary: parsed.data.resultSummary?.trim() || "Onboarding task created successfully.",
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json(task);
}
