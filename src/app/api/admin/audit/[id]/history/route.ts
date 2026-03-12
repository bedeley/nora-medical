import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "STAFF" || role === "ACCOUNTANT";
}

function parseMeta(raw: string | null) {
  if (!raw) return {} as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function summaryFromRow(row: {
  action: string;
  meta: string | null;
  actor: { name: string | null; email: string | null } | null;
}) {
  const meta = parseMeta(row.meta);
  if (row.action === "AUDIT_REVIEW_MARKED") {
    return `Marked reviewed by ${String(meta.appliedReviewedByName || row.actor?.name || row.actor?.email || "-")}. Note: ${String(meta.note || "-")}`;
  }
  if (row.action === "AUDIT_REVIEW_CLEARED") {
    return `Review cleared. Reason: ${String(meta.note || "-")}`;
  }
  if (row.action === "AUDIT_REVIEW_BULK_MARKED" || row.action === "AUDIT_REVIEW_BULK_CLEARED") {
    return `Bulk review change for ${Number(meta.count || 0)} row(s).`;
  }
  if (row.action === "AUDIT_REVIEW_TASK_UPDATED") {
    return `Task ${String(meta.taskStatusFrom || "OPEN")} -> ${String(meta.taskStatusTo || "OPEN")}. Due: ${meta.taskDueAtTo ? new Date(String(meta.taskDueAtTo)).toLocaleDateString() : "Not set"}.`;
  }
  if (row.action === "AUDIT_REVIEW_TASK_BULK_UPDATED") {
    return `Bulk task update for ${Number(meta.count || 0)} row(s). Status: ${String(meta.taskStatusTo || "-")}.`;
  }
  return "Audit review event.";
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !isAuthorized(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const needle = `"${id}"`;

  const raw = await prisma.auditLog.findMany({
    where: {
      deletedAt: null,
      entityType: "AUDIT_LOG",
      OR: [{ entityId: id }, { meta: { contains: needle } }],
    },
    orderBy: { createdAt: "desc" },
    take: 120,
    include: {
      actor: { select: { id: true, name: true, email: true, role: true } },
    },
  });

  const allowedActions = new Set([
    "AUDIT_REVIEW_MARKED",
    "AUDIT_REVIEW_CLEARED",
    "AUDIT_REVIEW_BULK_MARKED",
    "AUDIT_REVIEW_BULK_CLEARED",
    "AUDIT_REVIEW_TASK_UPDATED",
    "AUDIT_REVIEW_TASK_BULK_UPDATED",
  ]);

  const items = raw
    .filter((row) => {
      if (!allowedActions.has(row.action)) return false;
      if (row.entityId === id) return true;
      const meta = parseMeta(row.meta);
      const targetId = String(meta.targetAuditLogId || "").trim();
      if (targetId === id) return true;
      const targetIds = Array.isArray(meta.targetIds) ? (meta.targetIds as unknown[]) : [];
      if (targetIds.some((v) => String(v) === id)) return true;
      const sampleTargets = Array.isArray(meta.sampleTargets) ? (meta.sampleTargets as unknown[]) : [];
      return sampleTargets.some((v) => String((v as { id?: unknown })?.id || "") === id);
    })
    .map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      action: row.action,
      actor: row.actor,
      summary: summaryFromRow(row),
    }));

  return NextResponse.json({ items });
}
