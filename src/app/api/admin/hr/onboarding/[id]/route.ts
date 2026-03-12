import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const updateSchema = z.object({
  title: z.string().min(2).optional(),
  status: z.enum(["PENDING", "COMPLETE"]).optional(),
  dueDate: z.string().datetime().optional().or(z.literal("")),
});

function normalizeOptional(value?: string) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  if (typeof parsed.data.title === "string") data.title = parsed.data.title.trim();
  if (parsed.data.status) {
    data.status = parsed.data.status;
    data.completedAt = parsed.data.status === "COMPLETE" ? new Date() : null;
  }
  if ("dueDate" in parsed.data) {
    const dueDate = normalizeOptional(parsed.data.dueDate);
    data.dueDate = dueDate ? new Date(dueDate) : null;
  }

  const task = await prisma.onboardingTask.update({
    where: { id: resolvedParams.id },
    data,
  });

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_ONBOARDING_UPDATE",
      entityType: "ONBOARDING_TASK",
      entityId: task.id,
      meta: {
        employeeId: task.employeeId,
        status: task.status,
        title: task.title,
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json(task);
}
