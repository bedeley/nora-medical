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
  type ApplicationStage,
} from "@/lib/hr-hiring-utils";
import { getEmployeeOnboardingState } from "@/lib/hr-onboarding-status";

const applicationSchema = z.object({
  applicantId: z.string().min(1),
  jobPostingId: z.string().min(1),
  stage: z.enum(["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED", "WITHDRAWN"]).optional(),
  notes: z.string().optional().or(z.literal("")),
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

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() || "";
  const jobPostingId = searchParams.get("jobPostingId")?.trim() || "";
  const stageRaw = searchParams.get("stage")?.trim() || "";
  const showHired = searchParams.get("showHired") === "1";
  const allowedStages = new Set(["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED", "WITHDRAWN"]);
  const stage = allowedStages.has(stageRaw) ? stageRaw : "";
  const where: Prisma.ApplicationWhereInput = {
    ...(jobPostingId ? { jobPostingId } : {}),
    ...(stage ? { stage: stage as "APPLIED" } : {}),
    ...(!showHired && !stage ? { stage: { not: "HIRED" } } : {}),
    ...(q
      ? {
          OR: [
            { applicant: { firstName: { contains: q, mode: "insensitive" } } },
            { applicant: { lastName: { contains: q, mode: "insensitive" } } },
            { applicant: { email: { contains: q, mode: "insensitive" } } },
            { applicant: { phone: { contains: q, mode: "insensitive" } } },
            { jobPosting: { title: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [applications, total, groupedByStage, latestUpdated] = await Promise.all([
    prisma.application.findMany({
      where,
      include: {
        applicant: true,
        jobPosting: true,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: 200,
    }),
    prisma.application.count({ where }),
    prisma.application.groupBy({
      by: ["stage"],
      where,
      _count: { _all: true },
    }),
    prisma.application.findFirst({
      where,
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
  ]);

  const stageCounts = Object.fromEntries(
    groupedByStage.map((row) => [row.stage, row._count._all]),
  ) as Partial<Record<ApplicationStage, number>>;
  const activeCount =
    Number(stageCounts.APPLIED || 0) +
    Number(stageCounts.SCREENING || 0) +
    Number(stageCounts.INTERVIEW || 0) +
    Number(stageCounts.OFFER || 0);

  const hiredApplications = applications.filter((application) => application.stage === "HIRED");
  const hiredEmails = Array.from(
    new Set(
      hiredApplications
        .map((application) => String(application.applicant.email || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const hiredPhones = Array.from(
    new Set(
      hiredApplications
        .map((application) => String(application.applicant.phone || "").trim())
        .filter(Boolean),
    ),
  );
  const employeeCandidates =
    hiredEmails.length || hiredPhones.length
      ? await prisma.employee.findMany({
          where: {
            OR: [
              ...(hiredEmails.length ? [{ email: { in: hiredEmails } }] : []),
              ...(hiredPhones.length ? [{ phone: { in: hiredPhones } }] : []),
            ],
          },
          select: {
            id: true,
            email: true,
            phone: true,
            department: true,
            position: true,
            hireDate: true,
            notes: true,
          },
          take: 200,
        })
      : [];

  const rows = applications.map((application) => {
    if (application.stage !== "HIRED") {
      return {
        ...application,
        employeeId: null,
        onboarding: null,
      };
    }

    const candidateMatches = employeeCandidates.filter((candidate) => {
      const email = String(application.applicant.email || "").trim().toLowerCase();
      const phone = String(application.applicant.phone || "").trim();
      return (
        (email && String(candidate.email || "").trim().toLowerCase() === email) ||
        (phone && String(candidate.phone || "").trim() === phone)
      );
    });
    const matchDecision = selectEmployeeMatchForApplicant(
      candidateMatches,
      application.applicant.email,
      application.applicant.phone,
    );
    if (!matchDecision.ok || !matchDecision.match) {
      return {
        ...application,
        employeeId: null,
        onboarding: {
          status: "pending",
          summary: "Employee record could not be matched. Review the hire before resuming onboarding.",
        },
      };
    }

    const onboarding = getEmployeeOnboardingState({
      email: matchDecision.match.email,
      phone: matchDecision.match.phone,
      department: matchDecision.match.department,
      position: matchDecision.match.position,
      hireDate: matchDecision.match.hireDate,
      notes: matchDecision.match.notes,
    });

    return {
      ...application,
      employeeId: matchDecision.match.id,
      onboarding,
    };
  });

  return NextResponse.json({
    rows,
    total,
    lastUpdatedAt: latestUpdated?.updatedAt?.toISOString?.() ?? null,
    summary: {
      total,
      active: activeCount,
      applied: Number(stageCounts.APPLIED || 0),
      screening: Number(stageCounts.SCREENING || 0),
      interview: Number(stageCounts.INTERVIEW || 0),
      offer: Number(stageCounts.OFFER || 0),
      hired: Number(stageCounts.HIRED || 0),
      rejected: Number(stageCounts.REJECTED || 0),
      withdrawn: Number(stageCounts.WITHDRAWN || 0),
    },
  });
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

  const nextStage = (parsed.data.stage ?? "APPLIED") as ApplicationStage;
  if (requiresApplicationDecisionNote(nextStage) && !normalizeOptional(parsed.data.notes)) {
    return NextResponse.json(
      { error: "A short note is required when stage is Rejected or Withdrawn." },
      { status: 400 },
    );
  }

  try {
    const { application, employeeResult } = await prisma.$transaction(async (tx) => {
      const application = await tx.application.create({
        data: {
          applicantId: parsed.data.applicantId,
          jobPostingId: parsed.data.jobPostingId,
          stage: parsed.data.stage ?? "APPLIED",
          notes: normalizeOptional(parsed.data.notes),
        },
      });
      let employeeResult: Awaited<ReturnType<typeof ensureEmployeeForHire>> | null = null;
      if (application.stage === "HIRED") {
        employeeResult = await ensureEmployeeForHire(tx, application, {
          id: user.id,
          role: user.role,
        });
      }
      return { application, employeeResult };
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_APPLICATION_CREATE",
        entityType: "APPLICATION",
        entityId: application.id,
        meta: {
          actor: { id: user.id, role: user.role },
          sourcePage: normalizeAuditText(parsed.data.sourcePage, "admin/hr/hiring"),
          section: normalizeAuditText(parsed.data.section, "applications"),
          operation: normalizeAuditText(parsed.data.operation, "create_application"),
          before: null,
          after: {
            applicantId: application.applicantId,
            jobPostingId: application.jobPostingId,
            stage: application.stage,
            notes: application.notes,
          },
          status: "SUCCESS",
          resultSummary: normalizeAuditText(parsed.data.resultSummary, "Application created successfully."),
          employeeAction: employeeResult?.action || null,
          employeeId: employeeResult?.employeeId || null,
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json({
      ...application,
      employeeAction: employeeResult?.action || null,
      employeeId: employeeResult?.employeeId || null,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Ambiguous applicant match")) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("Error creating application:", err);
    return NextResponse.json({ error: "Failed to create application" }, { status: 500 });
  }
}
