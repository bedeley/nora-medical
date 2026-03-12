import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const updateSchema = z.object({
  title: z.string().min(2).optional(),
  department: z.string().optional().or(z.literal("")),
  location: z.string().optional().or(z.literal("")),
  status: z.enum(["OPEN", "PAUSED", "CLOSED"]).optional(),
  description: z.string().optional().or(z.literal("")),
  requirements: z.string().optional().or(z.literal("")),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
  openedAt: z.string().datetime().optional().or(z.literal("")),
  closedAt: z.string().datetime().optional().or(z.literal("")),
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

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const job = await prisma.jobPosting.findUnique({
    where: { id: resolvedParams.id },
    include: {
      applications: {
        include: { applicant: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(job);
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
  if ("department" in parsed.data) data.department = normalizeOptional(parsed.data.department);
  if ("location" in parsed.data) data.location = normalizeOptional(parsed.data.location);
  if (parsed.data.status) data.status = parsed.data.status;
  if ("description" in parsed.data) data.description = normalizeOptional(parsed.data.description);
  if ("requirements" in parsed.data) data.requirements = normalizeOptional(parsed.data.requirements);
  if (typeof parsed.data.salaryMin === "number") data.salaryMin = parsed.data.salaryMin;
  if (typeof parsed.data.salaryMax === "number") data.salaryMax = parsed.data.salaryMax;
  if ("openedAt" in parsed.data) {
    data.openedAt = parsed.data.openedAt ? new Date(parsed.data.openedAt) : null;
  }
  if ("closedAt" in parsed.data) {
    data.closedAt = parsed.data.closedAt ? new Date(parsed.data.closedAt) : null;
  }
  if (parsed.data.status === "CLOSED" && !("closedAt" in parsed.data)) {
    data.closedAt = new Date();
  }
  if (
    parsed.data.status &&
    parsed.data.status !== "CLOSED" &&
    !("closedAt" in parsed.data)
  ) {
    data.closedAt = null;
  }
  if (parsed.data.status === "OPEN" && !("openedAt" in parsed.data)) {
    data.openedAt = new Date();
  }

  try {
    const job = await prisma.jobPosting.update({
      where: { id: resolvedParams.id },
      data,
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_JOB_UPDATE",
        entityType: "JOB_POSTING",
        entityId: job.id,
        meta: {
          status: job.status,
          department: job.department,
          title: job.title,
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(job);
  } catch (err) {
    console.error("Error updating job posting:", err);
    return NextResponse.json({ error: "Failed to update job posting" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  try {
    const job = await prisma.jobPosting.update({
      where: { id: resolvedParams.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
      },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_JOB_CLOSE",
        entityType: "JOB_POSTING",
        entityId: job.id,
        meta: {
          status: job.status,
          closedAt: job.closedAt,
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(job);
  } catch (err) {
    console.error("Error closing job posting:", err);
    return NextResponse.json({ error: "Failed to close job posting" }, { status: 500 });
  }
}
