import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

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
  const statusRaw = searchParams.get("status")?.trim() || "";
  const allowedStatuses = new Set(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]);
  const status = allowedStatuses.has(statusRaw) ? statusRaw : "";

  const issues = await prisma.staffIssue.findMany({
    where: {
      ...(employeeId ? { employeeId } : {}),
      ...(status ? { status: status as "OPEN" } : {}),
    },
    include: { employee: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ rows: issues });
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
    const issue = await prisma.staffIssue.create({
      data: {
        employeeId: parsed.data.employeeId,
        type: parsed.data.type.trim(),
        severity: parsed.data.severity ?? "LOW",
        status,
        description: parsed.data.description.trim(),
        resolution: normalizeOptional(parsed.data.resolution),
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
          employeeId: issue.employeeId,
          status: issue.status,
          severity: issue.severity,
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
