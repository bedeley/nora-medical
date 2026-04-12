import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { evaluateAuditRisk } from "@/lib/audit-risk";
import { getEffectiveAuditRiskSettings } from "@/lib/audit-risk-settings.server";
import { canAccessAdminAudit } from "@/lib/admin-audit-access";

type NotificationItem = {
  id: string;
  type: "overdue_review" | "overdue_task" | "archive_escalation";
  severity: "MEDIUM" | "HIGH" | "CRITICAL";
  createdAt: string;
  action: string;
  entityType: string;
  entityId: string;
  message: string;
};

function parseMeta(raw: string | null) {
  if (!raw) return {} as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function rank(item: NotificationItem) {
  const severityRank = item.severity === "CRITICAL" ? 3 : item.severity === "HIGH" ? 2 : 1;
  const typeRank = item.type === "overdue_task" ? 3 : item.type === "overdue_review" ? 2 : 1;
  return severityRank * 10 + typeRank;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !canAccessAdminAudit(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const limit = Math.max(1, Math.min(100, Number(searchParams.get("limit") || 30)));

  const rows = await prisma.auditLog.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 4000,
    select: { id: true, action: true, entityType: true, entityId: true, meta: true, createdAt: true },
  });
  const { settings } = await getEffectiveAuditRiskSettings();
  const retentionDays = Number(process.env.AUDIT_LOG_RETENTION_DAYS || 365);
  const nowMs = Date.now();
  const items: NotificationItem[] = [];

  for (const row of rows) {
    const meta = parseMeta(row.meta);
    const risk = evaluateAuditRisk({
      action: row.action,
      entityType: row.entityType,
      meta,
      settings,
    });
    if (risk.severity === "LOW" || risk.reviewed) continue;
    const severity = risk.severity as "MEDIUM" | "HIGH" | "CRITICAL";
    const createdAtMs = row.createdAt.getTime();
    const taskDueAt = String(meta.reviewTaskDueAt || "").trim();
    const taskDueMs = taskDueAt && !Number.isNaN(new Date(taskDueAt).getTime())
      ? new Date(taskDueAt).getTime()
      : null;
    const taskAssigneeId = String(meta.reviewTaskAssigneeId || "").trim();
    const slaHours =
      severity === "CRITICAL"
        ? settings.reviewSlaHours.critical
        : severity === "HIGH"
          ? settings.reviewSlaHours.high
          : settings.reviewSlaHours.medium;
    const reviewDueMs = createdAtMs + slaHours * 60 * 60 * 1000;
    const archiveAtMs = createdAtMs + retentionDays * 24 * 60 * 60 * 1000;
    const toArchiveMs = archiveAtMs - nowMs;

    if (taskDueMs && taskDueMs < nowMs) {
      items.push({
        id: `${row.id}-task`,
        type: "overdue_task",
        severity,
        createdAt: row.createdAt.toISOString(),
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        message: "Task due date has passed.",
      });
    }
    if (reviewDueMs < nowMs) {
      items.push({
        id: `${row.id}-review`,
        type: "overdue_review",
        severity,
        createdAt: row.createdAt.toISOString(),
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        message: "Review SLA has been breached.",
      });
    }
    if (
      toArchiveMs > 0 &&
      toArchiveMs <= settings.archiveWindowDays.escalation * 24 * 60 * 60 * 1000 &&
      !taskAssigneeId
    ) {
      items.push({
        id: `${row.id}-archive`,
        type: "archive_escalation",
        severity,
        createdAt: row.createdAt.toISOString(),
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        message: "Near archive window without assigned task owner.",
      });
    }
  }

  const sorted = items
    .sort((a, b) => rank(b) - rank(a) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
  return NextResponse.json({
    total: items.length,
    items: sorted,
    counts: {
      overdueReview: items.filter((item) => item.type === "overdue_review").length,
      overdueTask: items.filter((item) => item.type === "overdue_task").length,
      archiveEscalation: items.filter((item) => item.type === "archive_escalation").length,
    },
  });
}
