import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { normalizeAuditText } from "@/lib/hr-hiring-utils";

const jobSchema = z.object({
  title: z.string().min(2),
  department: z.string().optional().or(z.literal("")),
  location: z.string().optional().or(z.literal("")),
  status: z.enum(["OPEN", "PAUSED", "CLOSED"]).optional(),
  description: z.string().optional().or(z.literal("")),
  requirements: z.string().optional().or(z.literal("")),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
  openedAt: z.string().datetime().optional().or(z.literal("")),
  closedAt: z.string().datetime().optional().or(z.literal("")),
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

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() || "";
  const statusRaw = searchParams.get("status")?.trim() || "";
  const allowedStatuses = new Set(["OPEN", "PAUSED", "CLOSED"]);
  const status = allowedStatuses.has(statusRaw) ? statusRaw : "";

  const jobs = await prisma.jobPosting.findMany({
    where: {
      ...(status ? { status: status as "OPEN" } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { department: { contains: q, mode: "insensitive" } },
              { location: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ rows: jobs });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = jobSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const job = await prisma.jobPosting.create({
      data: {
        title: parsed.data.title.trim(),
        department: normalizeOptional(parsed.data.department),
        location: normalizeOptional(parsed.data.location),
        status: parsed.data.status ?? "OPEN",
        description: normalizeOptional(parsed.data.description),
        requirements: normalizeOptional(parsed.data.requirements),
        salaryMin: typeof parsed.data.salaryMin === "number" ? parsed.data.salaryMin : null,
        salaryMax: typeof parsed.data.salaryMax === "number" ? parsed.data.salaryMax : null,
        openedAt: parsed.data.openedAt ? new Date(parsed.data.openedAt) : undefined,
        closedAt: parsed.data.closedAt ? new Date(parsed.data.closedAt) : null,
      },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_JOB_CREATE",
        entityType: "JOB_POSTING",
        entityId: job.id,
        meta: {
          actor: { id: user.id, role: user.role },
          sourcePage: normalizeAuditText(parsed.data.sourcePage, "admin/hr/hiring"),
          section: normalizeAuditText(parsed.data.section, "job-postings"),
          operation: normalizeAuditText(parsed.data.operation, "create_job_posting"),
          before: null,
          after: {
            title: job.title,
            department: job.department,
            location: job.location,
            status: job.status,
          },
          status: "SUCCESS",
          resultSummary: normalizeAuditText(parsed.data.resultSummary, "Job posting created successfully."),
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(job);
  } catch (err) {
    console.error("Error creating job posting:", err);
    return NextResponse.json({ error: "Failed to create job posting" }, { status: 500 });
  }
}
