import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const updateSchema = z.object({
  type: z.string().min(2).optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
  description: z.string().min(3).optional(),
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
  if (typeof parsed.data.type === "string") data.type = parsed.data.type.trim();
  if (parsed.data.severity) data.severity = parsed.data.severity;
  if (parsed.data.status) data.status = parsed.data.status;
  if (typeof parsed.data.description === "string") data.description = parsed.data.description.trim();
  if ("resolution" in parsed.data) data.resolution = normalizeOptional(parsed.data.resolution);
  if ("openedAt" in parsed.data) data.openedAt = parsed.data.openedAt ? new Date(parsed.data.openedAt) : null;
  if ("closedAt" in parsed.data) data.closedAt = parsed.data.closedAt ? new Date(parsed.data.closedAt) : null;
  if (
    parsed.data.status &&
    !("closedAt" in parsed.data) &&
    (parsed.data.status === "RESOLVED" || parsed.data.status === "CLOSED")
  ) {
    data.closedAt = new Date();
  }
  if (
    parsed.data.status &&
    !("closedAt" in parsed.data) &&
    (parsed.data.status === "OPEN" || parsed.data.status === "IN_PROGRESS")
  ) {
    data.closedAt = null;
  }

  try {
    const issue = await prisma.staffIssue.update({
      where: { id: resolvedParams.id },
      data,
    });
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "HR_ISSUE_UPDATE",
        entityType: "STAFF_ISSUE",
        entityId: issue.id,
        meta: {
          status: issue.status,
          severity: issue.severity,
        },
      });
    } catch {
      // best-effort
    }
    return NextResponse.json(issue);
  } catch (err) {
    console.error("Error updating staff issue:", err);
    return NextResponse.json({ error: "Failed to update staff issue" }, { status: 500 });
  }
}
