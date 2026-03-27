import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { validateExpectedUpdatedAt } from "@/lib/hr-staff-profile-utils";
import {
  buildOnboardingDeleteAuditMeta,
  validateOnboardingDeleteConflict,
} from "@/lib/hr-onboarding-audit-utils";

const updateSchema = z.object({
  title: z.string().min(2).optional(),
  status: z.enum(["PENDING", "COMPLETE"]).optional(),
  dueDate: z.string().datetime().optional().or(z.literal("")),
  expectedUpdatedAt: z.string().optional().or(z.literal("")),
  sourcePage: z.string().optional().or(z.literal("")),
  section: z.string().optional().or(z.literal("")),
  operation: z.string().optional().or(z.literal("")),
  resultSummary: z.string().optional().or(z.literal("")),
});
const deleteSchema = z.object({
  expectedUpdatedAt: z.string().optional().or(z.literal("")),
  sourcePage: z.string().optional().or(z.literal("")),
  section: z.string().optional().or(z.literal("")),
  operation: z.string().optional().or(z.literal("")),
  resultSummary: z.string().optional().or(z.literal("")),
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

  const existing = await prisma.onboardingTask.findUnique({
    where: { id: resolvedParams.id },
    select: {
      id: true,
      employeeId: true,
      title: true,
      status: true,
      dueDate: true,
      completedAt: true,
      updatedAt: true,
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "Onboarding task not found." }, { status: 404 });
  }
  const conflictCheck = validateOnboardingDeleteConflict(existing.updatedAt, parsed.data.expectedUpdatedAt);
  if (!conflictCheck.ok) {
    return NextResponse.json({ error: conflictCheck.error }, { status: conflictCheck.status });
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
        actor: {
          id: user.id,
          role: user.role,
        },
        sourcePage: parsed.data.sourcePage?.trim() || "admin/hr/staff/[id]",
        section: parsed.data.section?.trim() || "onboarding-checklist",
        operation: parsed.data.operation?.trim() || "update_onboarding_task",
        before: {
          employeeId: existing.employeeId,
          title: existing.title,
          status: existing.status,
          dueDate: existing.dueDate?.toISOString?.() ?? null,
          completedAt: existing.completedAt?.toISOString?.() ?? null,
        },
        after: {
          employeeId: task.employeeId,
          title: task.title,
          status: task.status,
          dueDate: task.dueDate?.toISOString?.() ?? null,
          completedAt: task.completedAt?.toISOString?.() ?? null,
        },
        status: "SUCCESS",
        resultSummary: parsed.data.resultSummary?.trim() || "Onboarding task updated successfully.",
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json(task);
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await prisma.onboardingTask.findUnique({
    where: { id: resolvedParams.id },
    select: {
      id: true,
      employeeId: true,
      title: true,
      status: true,
      dueDate: true,
      completedAt: true,
      updatedAt: true,
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "Onboarding task not found." }, { status: 404 });
  }
  const conflictCheck = validateExpectedUpdatedAt(existing.updatedAt, parsed.data.expectedUpdatedAt);
  if (!conflictCheck.ok) {
    return NextResponse.json({ error: conflictCheck.error }, { status: conflictCheck.status });
  }

  await prisma.onboardingTask.delete({
    where: { id: resolvedParams.id },
  });

  try {
    await recordAuditLog({
      actorId: user.id,
      action: "HR_ONBOARDING_DELETE",
      entityType: "ONBOARDING_TASK",
      entityId: existing.id,
      meta: {
        ...buildOnboardingDeleteAuditMeta({
          actorId: user.id,
          actorRole: user.role,
          sourcePage: parsed.data.sourcePage?.trim() || "admin/hr/staff/[id]",
          section: parsed.data.section?.trim() || "onboarding-checklist",
          operation: parsed.data.operation?.trim() || "delete_onboarding_task",
          resultSummary:
            parsed.data.resultSummary?.trim() || "Onboarding task removed successfully.",
          before: {
            employeeId: existing.employeeId,
            title: existing.title,
            status: existing.status,
            dueDate: existing.dueDate,
            completedAt: existing.completedAt,
          },
        }),
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ ok: true });
}
