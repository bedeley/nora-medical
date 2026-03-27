import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { canTransitionIssueStatus, statusRequiresResolution } from "@/lib/hr-issues-utils";

const issueSchema = z.object({
  employeeId: z.string().min(1),
  type: z.string().min(2),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
  description: z.string().min(3),
  resolution: z.string().optional().or(z.literal("")),
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

export async function GET(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const employeeId = searchParams.get("employeeId")?.trim() || "";
  const q = searchParams.get("q")?.trim() || "";
  const severityRaw = searchParams.get("severity")?.trim() || "";
  const statusRaw = searchParams.get("status")?.trim() || "";
  const fromRaw = searchParams.get("from")?.trim() || "";
  const toRaw = searchParams.get("to")?.trim() || "";
  const sortRaw = (searchParams.get("sort")?.trim() || "createdAt_desc").toLowerCase();
  const pageRaw = Number(searchParams.get("page") || 1);
  const pageSizeRaw = Number(searchParams.get("pageSize") || 25);

  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.max(10, Math.min(100, Math.floor(pageSizeRaw)))
    : 25;
  const skip = (page - 1) * pageSize;

  const fromDate = fromRaw ? new Date(fromRaw) : null;
  const toDate = toRaw ? new Date(toRaw) : null;
  if (fromRaw && (!fromDate || Number.isNaN(fromDate.getTime()))) {
    return NextResponse.json({ error: "Invalid from date." }, { status: 400 });
  }
  if (toRaw && (!toDate || Number.isNaN(toDate.getTime()))) {
    return NextResponse.json({ error: "Invalid to date." }, { status: 400 });
  }
  if (fromDate && toDate && toDate.getTime() < fromDate.getTime()) {
    return NextResponse.json({ error: "To date must be on or after from date." }, { status: 400 });
  }

  const allowedSorts = new Set([
    "createdat_desc",
    "createdat_asc",
    "severity_desc",
    "severity_asc",
    "status_asc",
    "status_desc",
  ]);
  const sort = allowedSorts.has(sortRaw) ? sortRaw : "createdat_desc";

  const severityMap: Record<string, "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"> = {
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    HIGH: "HIGH",
    CRITICAL: "CRITICAL",
  };
  const severity = severityMap[severityRaw.toUpperCase()] || "";
  const allowedStatuses = new Set(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]);
  const status = allowedStatuses.has(statusRaw) ? statusRaw : "";

  const where = {
    ...(employeeId ? { employeeId } : {}),
    ...(status ? { status: status as "OPEN" } : {}),
    ...(severity ? { severity } : {}),
    ...(fromDate || toDate
      ? {
          createdAt: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate
              ? {
                  lte: new Date(
                    Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth(), toDate.getUTCDate(), 23, 59, 59, 999),
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { type: { contains: q, mode: "insensitive" as const } },
            { description: { contains: q, mode: "insensitive" as const } },
            { resolution: { contains: q, mode: "insensitive" as const } },
            { employee: { is: { firstName: { contains: q, mode: "insensitive" as const } } } },
            { employee: { is: { lastName: { contains: q, mode: "insensitive" as const } } } },
          ],
        }
      : {}),
  };

  const orderBy =
    sort === "createdat_asc"
      ? { createdAt: "asc" as const }
      : sort === "severity_desc"
        ? { severity: "desc" as const }
        : sort === "severity_asc"
          ? { severity: "asc" as const }
          : sort === "status_asc"
            ? { status: "asc" as const }
            : sort === "status_desc"
              ? { status: "desc" as const }
              : { createdAt: "desc" as const };

  const [rows, total] = await Promise.all([
    prisma.staffIssue.findMany({
      where,
      include: { employee: true },
      orderBy,
      skip,
      take: pageSize,
    }),
    prisma.staffIssue.count({ where }),
  ]);

  return NextResponse.json({
    rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

export async function POST(req: Request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = issueSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const status = parsed.data.status ?? "OPEN";
    const resolution = normalizeOptional(parsed.data.resolution);
    if (statusRequiresResolution(status) && !resolution) {
      return NextResponse.json(
        { error: "Resolution note is required when creating a resolved or closed issue." },
        { status: 400 },
      );
    }
    if (!canTransitionIssueStatus("OPEN", status)) {
      return NextResponse.json(
        { error: `Invalid initial status ${status}. New issues can start as OPEN, IN_PROGRESS, or RESOLVED.` },
        { status: 400 },
      );
    }

    const issue = await prisma.staffIssue.create({
      data: {
        employeeId: parsed.data.employeeId,
        type: parsed.data.type.trim(),
        severity: parsed.data.severity ?? "LOW",
        status,
        description: parsed.data.description.trim(),
        resolution,
        openedAt: parsed.data.openedAt ? new Date(parsed.data.openedAt) : undefined,
        closedAt:
          parsed.data.closedAt
            ? new Date(parsed.data.closedAt)
            : status === "RESOLVED" || status === "CLOSED"
              ? new Date()
              : null,
      },
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_ISSUE_CREATE",
        entityType: "STAFF_ISSUE",
        entityId: issue.id,
        meta: {
          sourcePage: "admin/hr/issues",
          section: "issue-create",
          operation: "create_issue",
          before: null,
          after: {
            employeeId: issue.employeeId,
            type: issue.type,
            severity: issue.severity,
            status: issue.status,
            descriptionLength: issue.description.length,
            resolutionLength: issue.resolution?.length || 0,
            openedAt: issue.openedAt?.toISOString() || null,
            closedAt: issue.closedAt?.toISOString() || null,
          },
          status: "SUCCESS",
          resultSummary: "Staff issue created successfully.",
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(issue);
  } catch (err) {
    console.error("Error creating staff issue:", err);
    return NextResponse.json({ error: "Failed to create staff issue" }, { status: 500 });
  }
}

