import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { Prisma } from "@prisma/client";

const applicationSchema = z.object({
  applicantId: z.string().min(1),
  jobPostingId: z.string().min(1),
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

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const jobPostingId = searchParams.get("jobPostingId")?.trim() || "";
  const stageRaw = searchParams.get("stage")?.trim() || "";
  const allowedStages = new Set(["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED", "WITHDRAWN"]);
  const stage = allowedStages.has(stageRaw) ? stageRaw : "";

  const applications = await prisma.application.findMany({
    where: {
      ...(jobPostingId ? { jobPostingId } : {}),
      ...(stage ? { stage: stage as "APPLIED" } : {}),
    },
    include: {
      applicant: true,
      jobPosting: true,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ rows: applications });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = applicationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const { application, employeeAction } = await prisma.$transaction(async (tx) => {
      const application = await tx.application.create({
        data: {
          applicantId: parsed.data.applicantId,
          jobPostingId: parsed.data.jobPostingId,
          stage: parsed.data.stage ?? "APPLIED",
          notes: normalizeOptional(parsed.data.notes),
        },
      });
      let employeeAction: string | null = null;
      if (application.stage === "HIRED") {
        employeeAction = await ensureEmployeeForHire(tx, application, user.id);
      }
      return { application, employeeAction };
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_APPLICATION_CREATE",
        entityType: "APPLICATION",
        entityId: application.id,
        meta: {
          applicantId: application.applicantId,
          jobPostingId: application.jobPostingId,
          stage: application.stage,
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json({ ...application, employeeAction });
  } catch (err) {
    console.error("Error creating application:", err);
    return NextResponse.json({ error: "Failed to create application" }, { status: 500 });
  }
}
