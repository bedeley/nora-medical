import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { canAccessAdminAudit } from "@/lib/admin-audit-access";

type Meta = Record<string, unknown>;
type TaskStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED";

function parseMeta(raw: string | null): Meta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Meta;
    }
  } catch {
    // ignore malformed meta
  }
  return {};
}

function parseStatus(value: unknown): TaskStatus | null {
  const text = String(value || "").trim().toUpperCase();
  if (text === "OPEN" || text === "IN_PROGRESS" || text === "RESOLVED") return text;
  return null;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !canAccessAdminAudit(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-audit-task-update", 60_000, 120);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { assigneeId?: unknown; dueAt?: unknown; status?: unknown; note?: unknown; evidence?: unknown }
    | null;
  const hasAssigneeField = !!body && Object.prototype.hasOwnProperty.call(body, "assigneeId");
  const hasDueAtField = !!body && Object.prototype.hasOwnProperty.call(body, "dueAt");
  const requestedAssigneeId = hasAssigneeField ? String(body?.assigneeId || "").trim() : null;
  const dueAtRaw = hasDueAtField ? String(body?.dueAt || "").trim() : null;
  const status = parseStatus(body?.status);
  const note = String(body?.note || "").trim().slice(0, 300);
  const evidence = Array.isArray(body?.evidence)
    ? (body?.evidence as Array<Record<string, unknown>>)
        .slice(0, 10)
        .map((item) => ({
          url: String(item?.url || "").trim(),
          name: String(item?.name || "").trim() || "Evidence",
          type: String(item?.type || "").trim() || "image/*",
          size: Number(item?.size || 0),
          uploadedAt: String(item?.uploadedAt || new Date().toISOString()),
        }))
        .filter((item) => item.url)
    : null;
  if (!status) {
    return NextResponse.json({ error: "Invalid task status." }, { status: 400 });
  }

  const row = await prisma.auditLog.findUnique({
    where: { id },
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      createdAt: true,
      meta: true,
    },
  });
  if (!row) return NextResponse.json({ error: "Audit row not found." }, { status: 404 });

  let assignee:
    | { id: string; name: string | null; email: string | null; role: string }
    | null = null;
  if (requestedAssigneeId) {
    assignee = await prisma.user.findUnique({
      where: { id: requestedAssigneeId },
      select: { id: true, name: true, email: true, role: true },
    });
    if (!assignee || assignee.role !== "ADMIN") {
      return NextResponse.json(
        { error: "Assignee must be an ADMIN user." },
        { status: 400 },
      );
    }
  }

  let dueAtIso: string | null = null;
  if (dueAtRaw) {
    const dueAt = new Date(dueAtRaw);
    if (Number.isNaN(dueAt.getTime())) {
      return NextResponse.json({ error: "Invalid due date." }, { status: 400 });
    }
    dueAtIso = dueAt.toISOString();
  }

  const prev = parseMeta(row.meta);
  const prevAssigneeId = String(prev.reviewTaskAssigneeId || "").trim() || null;
  const nextAssigneeId = requestedAssigneeId !== null ? requestedAssigneeId || null : prevAssigneeId;
  if ((status === "IN_PROGRESS" || status === "RESOLVED") && !nextAssigneeId) {
    return NextResponse.json(
      { error: "Assign an owner before setting this task status." },
      { status: 400 },
    );
  }

  const next: Meta = { ...prev };
  if (requestedAssigneeId) {
    next.reviewTaskAssigneeId = assignee?.id || null;
    next.reviewTaskAssigneeName = assignee?.name || null;
    next.reviewTaskAssigneeEmail = assignee?.email || null;
  } else if (requestedAssigneeId === "") {
    delete next.reviewTaskAssigneeId;
    delete next.reviewTaskAssigneeName;
    delete next.reviewTaskAssigneeEmail;
  }
  if (dueAtRaw) {
    next.reviewTaskDueAt = dueAtIso;
  } else if (dueAtRaw === "") {
    delete next.reviewTaskDueAt;
  }
  next.reviewTaskStatus = status;
  next.reviewTaskNote = note || null;
  if (evidence) next.reviewTaskEvidence = evidence;
  next.reviewTaskUpdatedAt = new Date().toISOString();
  next.reviewTaskUpdatedById = user?.id || null;
  next.reviewTaskUpdatedByName = user?.name || null;
  next.reviewTaskUpdatedByEmail = user?.email || null;

  await prisma.auditLog.update({
    where: { id },
    data: { meta: JSON.stringify(next) },
  });

  await recordAuditLog({
    actorId: user?.id || null,
    action: "AUDIT_REVIEW_TASK_UPDATED",
    entityType: "AUDIT_LOG",
    entityId: id,
    meta: {
      targetAuditLogId: row.id,
      targetAction: row.action,
      targetEntityType: row.entityType,
      targetEntityId: row.entityId,
      targetCreatedAt: row.createdAt.toISOString(),
      taskStatusFrom: String(prev.reviewTaskStatus || "OPEN"),
      taskStatusTo: status,
      taskAssigneeFrom: prevAssigneeId,
      taskAssigneeTo: String(next.reviewTaskAssigneeId || ""),
      taskDueAtFrom: String(prev.reviewTaskDueAt || "") || null,
      taskDueAtTo: String(next.reviewTaskDueAt || "") || null,
      taskNote: note || null,
      evidenceCount: Array.isArray(next.reviewTaskEvidence) ? next.reviewTaskEvidence.length : 0,
    },
  });

  return NextResponse.json({ ok: true });
}
