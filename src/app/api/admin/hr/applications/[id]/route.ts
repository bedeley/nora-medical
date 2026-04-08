import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { Prisma } from "@prisma/client";
import {
  normalizeAuditText,
  requiresApplicationDecisionNote,
  selectEmployeeMatchForApplicant,
  validateApplicationStageTransition,
  validateHiringConflict,
  type ApplicationStage,
} from "@/lib/hr-hiring-utils";
import { parseInterviewFromNotes } from "@/lib/hr-hiring-interview-meta";

const updateSchema = z.object({
  stage: z.enum(["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED", "WITHDRAWN"]).optional(),
  notes: z.string().optional().or(z.literal("")),
  expectedUpdatedAt: z.string().optional().or(z.literal("")),
  sourcePage: z.string().optional().or(z.literal("")),
  section: z.string().optional().or(z.literal("")),
  operation: z.string().optional().or(z.literal("")),
  resultSummary: z.string().optional().or(z.literal("")),
});

const defaultOnboardingTasks = [
  "Signed offer letter",
  "Bank details collected",
  "Tax ID verified",
  "Compensation set",
  "Pension enrollment",
  "Orientation completed",
];

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

async function ensureEmployeeForHire(
  tx: Prisma.TransactionClient,
  application: { applicantId: string; jobPostingId: string },
  actor: { id: string; role: string }
) {
  const [applicant, job] = await Promise.all([
    tx.applicant.findUnique({ where: { id: application.applicantId } }),
    tx.jobPosting.findUnique({ where: { id: application.jobPostingId } }),
  ]);
  if (!applicant || !job) return null;

  const lookup: Prisma.EmployeeWhereInput[] = [];
  if (applicant.email) lookup.push({ email: applicant.email });
  if (applicant.phone) lookup.push({ phone: applicant.phone });
  const existingMatches = lookup.length
    ? await tx.employee.findMany({
        where: { OR: lookup },
        select: {
          id: true,
          email: true,
          phone: true,
          status: true,
          department: true,
          position: true,
          hireDate: true,
        },
        orderBy: { createdAt: "asc" },
        take: 5,
      })
    : [];
  const matchDecision = selectEmployeeMatchForApplicant(
    existingMatches,
    applicant.email,
    applicant.phone,
  );
  if (!matchDecision.ok) {
    throw new Error(matchDecision.error);
  }
  const existing = matchDecision.match;

  if (existing) {
    const updateData: Prisma.EmployeeUpdateInput = {
      status: "ACTIVE",
      terminationDate: null,
    };
    if (!existing.department && job.department) updateData.department = job.department;
    if (!existing.position) updateData.position = job.title;
    if (!existing.hireDate) updateData.hireDate = new Date();
    const updated = await tx.employee.update({
      where: { id: existing.id },
      data: updateData,
    });
    try {
      await recordAuditLog({
        actorId: actor.id,
        action: "HR_EMPLOYEE_UPDATE",
        entityType: "EMPLOYEE",
        entityId: updated.id,
        meta: {
          actor: { id: actor.id, role: actor.role },
          sourcePage: "admin/hr/hiring",
          section: "applications",
          operation: "hire_reactivate_employee",
          before: {
            status: existing.status,
            department: existing.department,
            position: existing.position,
            hireDate: existing.hireDate?.toISOString?.() ?? null,
            terminationDate: null,
          },
          after: {
            status: updated.status,
            department: updated.department,
            position: updated.position,
            hireDate: updated.hireDate?.toISOString?.() ?? null,
            terminationDate: updated.terminationDate?.toISOString?.() ?? null,
          },
          status: "SUCCESS",
          resultSummary: "Existing employee reactivated from hiring pipeline.",
        },
      });
    } catch {
      // best-effort
    }
    return { action: "reactivated" as const, employeeId: updated.id };
  }

  const employee = await tx.employee.create({
    data: {
      firstName: applicant.firstName,
      lastName: applicant.lastName,
      email: applicant.email,
      phone: applicant.phone,
      department: job.department,
      position: job.title,
      status: "ACTIVE",
      hireDate: new Date(),
      notes: "Auto-created from hiring pipeline",
    },
  });
  await tx.onboardingTask.createMany({
    data: defaultOnboardingTasks.map((title) => ({
      employeeId: employee.id,
      title,
    })),
  });
  try {
    await recordAuditLog({
      actorId: actor.id,
      action: "HR_EMPLOYEE_CREATE",
      entityType: "EMPLOYEE",
      entityId: employee.id,
      meta: {
        actor: { id: actor.id, role: actor.role },
        sourcePage: "admin/hr/hiring",
        section: "applications",
        operation: "hire_create_employee",
        before: null,
        after: {
          status: employee.status,
          department: employee.department,
          position: employee.position,
          hireDate: employee.hireDate?.toISOString?.() ?? null,
        },
        status: "SUCCESS",
        resultSummary: "Employee created from hiring pipeline.",
      },
    });
  } catch {
    // best-effort
  }

  return { action: "created" as const, employeeId: employee.id };
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
  const normalizedNotes = "notes" in parsed.data ? normalizeOptional(parsed.data.notes) : undefined;
  if ("notes" in parsed.data) data.notes = normalizedNotes;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.application.findUnique({
        where: { id: resolvedParams.id },
        select: {
          id: true,
          stage: true,
          notes: true,
          applicantId: true,
          jobPostingId: true,
          updatedAt: true,
        },
      });
      if (!existing) return null;
      const conflictCheck = validateHiringConflict(existing.updatedAt, parsed.data.expectedUpdatedAt);
      if (!conflictCheck.ok) {
        return { conflict: conflictCheck, existing } as const;
      }

      const nextStage = (parsed.data.stage ?? existing.stage) as ApplicationStage;
      const transitionCheck = validateApplicationStageTransition(existing.stage as ApplicationStage, nextStage);
      if (!transitionCheck.ok) {
        return { transitionError: transitionCheck.error, existing } as const;
      }
      if (requiresApplicationDecisionNote(nextStage) && !normalizedNotes) {
        return {
          transitionError: "A short note is required when stage is Rejected or Withdrawn.",
          existing,
        } as const;
      }
      if (parsed.data.stage) data.stage = parsed.data.stage;

      const application = await tx.application.update({
        where: { id: resolvedParams.id },
        data,
      });

      let employeeResult: Awaited<ReturnType<typeof ensureEmployeeForHire>> | null = null;
      if (application.stage === "HIRED" && existing.stage !== "HIRED") {
        employeeResult = await ensureEmployeeForHire(tx, application, {
          id: user.id,
          role: user.role,
        });
      }

      return { application, employeeResult, existing } as const;
    });
    if (!result) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if ("conflict" in result && result.conflict) {
      return NextResponse.json(
        { error: result.conflict.error },
        { status: result.conflict.status },
      );
    }
    if ("transitionError" in result) {
      return NextResponse.json({ error: result.transitionError }, { status: 400 });
    }
    const application = result.application;
    try {
      const operation = normalizeAuditText(parsed.data.operation, "update_application_stage");
      const beforeInterview = parseInterviewFromNotes(result.existing.notes);
      const afterInterview = parseInterviewFromNotes(application.notes);
      await recordAuditLog({
        actorId: user.id,
        action: "HR_APPLICATION_UPDATE",
        entityType: "APPLICATION",
        entityId: application.id,
        meta: {
          actor: { id: user.id, role: user.role },
          sourcePage: normalizeAuditText(parsed.data.sourcePage, "admin/hr/hiring"),
          section: normalizeAuditText(parsed.data.section, "applications"),
          operation,
          before: {
            stage: result.existing.stage,
            notes: result.existing.notes,
            interview: {
              scheduledAt: beforeInterview.meta?.scheduledAt || null,
              interviewer: beforeInterview.meta?.interviewer || null,
              outcome: beforeInterview.meta?.outcome || null,
            },
          },
          after: {
            stage: application.stage,
            notes: application.notes,
            interview: {
              scheduledAt: afterInterview.meta?.scheduledAt || null,
              interviewer: afterInterview.meta?.interviewer || null,
              outcome: afterInterview.meta?.outcome || null,
            },
          },
          status: "SUCCESS",
          resultSummary: normalizeAuditText(parsed.data.resultSummary, "Application stage updated successfully."),
          employeeAction: result.employeeResult?.action || null,
          employeeId: result.employeeResult?.employeeId || null,
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json({
      ...application,
      employeeAction: result.employeeResult?.action || null,
      employeeId: result.employeeResult?.employeeId || null,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Ambiguous applicant match")) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("Error updating application:", err);
    return NextResponse.json({ error: "Failed to update application" }, { status: 500 });
  }
}
