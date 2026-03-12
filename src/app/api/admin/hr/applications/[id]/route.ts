import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { Prisma } from "@prisma/client";

const updateSchema = z.object({
  stage: z.enum(["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED", "WITHDRAWN"]).optional(),
  notes: z.string().optional().or(z.literal("")),
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
  actorId: string
) {
  const [applicant, job] = await Promise.all([
    tx.applicant.findUnique({ where: { id: application.applicantId } }),
    tx.jobPosting.findUnique({ where: { id: application.jobPostingId } }),
  ]);
  if (!applicant || !job) return null;

  const lookup: Prisma.EmployeeWhereInput[] = [];
  if (applicant.email) lookup.push({ email: applicant.email });
  if (applicant.phone) lookup.push({ phone: applicant.phone });
  const existing = lookup.length
    ? await tx.employee.findFirst({ where: { OR: lookup } })
    : null;

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
        actorId,
        action: "HR_EMPLOYEE_UPDATE",
        entityType: "EMPLOYEE",
        entityId: updated.id,
        meta: {
          status: updated.status,
          department: updated.department,
          position: updated.position,
        },
      });
    } catch {
      // best-effort
    }
    return "reactivated";
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
      actorId,
      action: "HR_EMPLOYEE_CREATE",
      entityType: "EMPLOYEE",
      entityId: employee.id,
      meta: {
        status: employee.status,
        department: employee.department,
        position: employee.position,
      },
    });
  } catch {
    // best-effort
  }

  return "created";
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
  if (parsed.data.stage) data.stage = parsed.data.stage;
  if ("notes" in parsed.data) data.notes = normalizeOptional(parsed.data.notes);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.application.findUnique({
        where: { id: resolvedParams.id },
        select: { id: true, stage: true, applicantId: true, jobPostingId: true },
      });
      if (!existing) return null;

      const application = await tx.application.update({
        where: { id: resolvedParams.id },
        data,
      });

      let employeeAction: string | null = null;
      if (application.stage === "HIRED" && existing.stage !== "HIRED") {
        employeeAction = await ensureEmployeeForHire(tx, application, user.id);
      }

      return { application, employeeAction };
    });
    if (!result) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const application = result.application;
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_APPLICATION_UPDATE",
        entityType: "APPLICATION",
        entityId: application.id,
        meta: {
          stage: application.stage,
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json({ ...application, employeeAction: result.employeeAction });
  } catch (err) {
    console.error("Error updating application:", err);
    return NextResponse.json({ error: "Failed to update application" }, { status: 500 });
  }
}
