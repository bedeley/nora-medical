import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { evaluateAuditRisk } from "@/lib/audit-risk";
import { sendEmail } from "@/lib/email";
import { recordAuditLog } from "@/lib/audit-log";
import { getEffectiveAuditRiskSettings } from "@/lib/audit-risk-settings.server";
import { verifyCronSecret } from "@/lib/cron-auth";

function parsePositiveInt(value: string | undefined, fallback: number) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

const RETENTION_DAYS = parsePositiveInt(process.env.AUDIT_LOG_RETENTION_DAYS, 365);

function isAuthorizedCron(req: Request) {
  return verifyCronSecret(req, "AUDIT_REVIEW_CRON_SECRET");
}

function parseMeta(raw: string | null) {
  if (!raw) return {} as Record<string, unknown>;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

export async function GET(req: Request) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await prisma.auditLog.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 5000,
    select: { id: true, action: true, entityType: true, entityId: true, meta: true, createdAt: true },
  });

  const nowMs = Date.now();
  let criticalUnreviewed = 0;
  let highUnreviewed = 0;
  let overdueReviews = 0;
  let archiveNeedsAssignment = 0;
  let overdueTasks = 0;
  const { settings } = await getEffectiveAuditRiskSettings();

  for (const row of rows) {
    const meta = parseMeta(row.meta);
    const risk = evaluateAuditRisk({ action: row.action, entityType: row.entityType, meta, settings });
    if (risk.severity === "LOW" || risk.reviewed) continue;
    if (risk.severity === "CRITICAL") criticalUnreviewed += 1;
    if (risk.severity === "HIGH") highUnreviewed += 1;
    const slaHours =
      risk.severity === "CRITICAL"
        ? settings.reviewSlaHours.critical
        : risk.severity === "HIGH"
          ? settings.reviewSlaHours.high
          : settings.reviewSlaHours.medium;
    if (nowMs > row.createdAt.getTime() + slaHours * 60 * 60 * 1000) overdueReviews += 1;
    const taskDueAt = String(meta.reviewTaskDueAt || "").trim();
    const taskAssigneeId = String(meta.reviewTaskAssigneeId || "").trim();
    if (taskDueAt && !Number.isNaN(new Date(taskDueAt).getTime()) && new Date(taskDueAt).getTime() < nowMs) {
      overdueTasks += 1;
    }
    const remainingMs = row.createdAt.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000 - nowMs;
    if (
      remainingMs > 0 &&
      remainingMs <= settings.archiveWindowDays.escalation * 24 * 60 * 60 * 1000 &&
      !taskAssigneeId
    ) {
      archiveNeedsAssignment += 1;
    }
  }

  const configuredTo = String(process.env.AUDIT_REVIEW_ALERT_TO || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const fallbackRecipients =
    configuredTo.length > 0
      ? configuredTo
      : (
          await prisma.user.findMany({
            where: { role: "ADMIN", deletedAt: null },
            select: { email: true },
            take: 50,
          })
        )
          .map((row) => String(row.email || "").trim())
          .filter(Boolean);
  const recipients = [...new Set(fallbackRecipients)];
  if (recipients.length === 0) {
    return NextResponse.json({ error: "No recipients configured." }, { status: 400 });
  }

  const subject = "Audit Escalation Digest (Scheduled)";
  const text = [
    "Scheduled audit escalation summary:",
    `Critical unreviewed: ${criticalUnreviewed}`,
    `High unreviewed: ${highUnreviewed}`,
    `Overdue reviews: ${overdueReviews}`,
    `Needs assignment (archive window): ${archiveNeedsAssignment}`,
    `Overdue tasks: ${overdueTasks}`,
    "",
    "Open /admin/audit and use queue presets for triage.",
  ].join("\n");
  const html = text.replace(/\n/g, "<br/>");

  let simulated = false;
  for (const email of recipients) {
    const sent = await sendEmail(email, subject, text, html);
    if (!sent.ok) {
      return NextResponse.json({ error: sent.error || "Failed to send notification" }, { status: 500 });
    }
    if (sent.simulated) simulated = true;
  }

  await recordAuditLog({
    actorId: null,
    action: "AUDIT_ESCALATION_NOTIFICATION_CRON_SENT",
    entityType: "AUDIT_LOG",
    entityId: "ESCALATION",
    meta: {
      recipients,
      recipientCount: recipients.length,
      criticalUnreviewed,
      highUnreviewed,
      overdueReviews,
      archiveNeedsAssignment,
      overdueTasks,
      simulated,
      triggeredBy: "cron",
    },
  });

  return NextResponse.json({ ok: true, recipientCount: recipients.length, simulated });
}
