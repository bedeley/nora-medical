import { evaluateAuditRisk } from "@/lib/audit-risk";
import type { AuditRiskSettings } from "@/lib/audit-risk-config";

const ACTIONS_REQUIRING_TASK = new Set([
  "PRODUCT_DELETE",
  "APP-SETTING.UPDATE",
  "SUPPLIER_PRICE_CHANGE",
  "JOURNAL.ARCHIVE.RUN",
  "JOURNAL.ARCHIVE.CRON.RUN",
  "JOURNAL.ARCHIVE.DRY_RUN",
  "JOURNAL.ARCHIVE.CRON.DRY_RUN",
]);

function asText(value: unknown) {
  return String(value || "").trim();
}

export function requiresReviewTask(params: {
  action: string;
  entityType: string;
  meta: Record<string, unknown> | null;
  settings?: AuditRiskSettings;
}) {
  const action = asText(params.action).toUpperCase();
  const risk = evaluateAuditRisk({
    action,
    entityType: params.entityType,
    meta: params.meta,
    settings: params.settings,
  });
  if (risk.severity === "HIGH" || risk.severity === "CRITICAL") return true;
  return ACTIONS_REQUIRING_TASK.has(action);
}

export function getMissingTaskRequirement(meta: Record<string, unknown> | null) {
  const taskAssigneeId = asText(meta?.reviewTaskAssigneeId);
  const taskDueAt = asText(meta?.reviewTaskDueAt);
  if (!taskAssigneeId) return "Assign a task owner before marking reviewed.";
  if (!taskDueAt) return "Set a due date before marking reviewed.";
  return "";
}
