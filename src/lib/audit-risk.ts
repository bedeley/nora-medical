import {
  defaultAuditRiskSettingsFromEnv,
  type AuditRiskSettings,
} from "@/lib/audit-risk-config";

export type AuditRiskSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type AuditRiskMode = "all" | "exceptions" | "critical" | "needs_review";

export type AuditRiskResult = {
  severity: AuditRiskSeverity;
  reasons: string[];
  reviewed: boolean;
  reviewedAt: string | null;
  reviewedByName: string | null;
};

function asNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function asBool(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return false;
}

function pickHighest(current: AuditRiskSeverity, next: AuditRiskSeverity) {
  const rank: Record<AuditRiskSeverity, number> = {
    LOW: 0,
    MEDIUM: 1,
    HIGH: 2,
    CRITICAL: 3,
  };
  return rank[next] > rank[current] ? next : current;
}

export function evaluateAuditRisk(params: {
  action: string;
  entityType: string;
  meta: Record<string, unknown> | null;
  settings?: AuditRiskSettings;
}): AuditRiskResult {
  const action = String(params.action || "").toUpperCase();
  const entityType = String(params.entityType || "").toUpperCase();
  const meta = (params.meta || {}) as Record<string, unknown>;
  const settings = params.settings || defaultAuditRiskSettingsFromEnv();

  let severity: AuditRiskSeverity = "LOW";
  const reasons: string[] = [];
  const add = (next: AuditRiskSeverity, reason: string) => {
    severity = pickHighest(severity, next);
    reasons.push(reason);
  };

  if (action === "PAYMENT_REFUND") {
    const amount = asNumber(meta.amount);
    if (amount >= settings.refundCriticalAmount) add("CRITICAL", `High-value refund (${amount.toFixed(2)}).`);
    else if (amount >= settings.refundHighAmount) add("HIGH", `Large refund (${amount.toFixed(2)}).`);
    else if (amount > 0) add("MEDIUM", `Refund posted (${amount.toFixed(2)}).`);
  }

  if (action === "PAYMENT_VOID") {
    const amount = asNumber(meta.amount);
    if (amount >= settings.paymentVoidHighAmount) add("HIGH", `High-value voided payment (${amount.toFixed(2)}).`);
    else add("MEDIUM", "Payment was voided.");
  }

  if (action === "ORDER_CANCEL" && settings.actionRules.orderCancelHigh) {
    add("HIGH", "Order was cancelled.");
  }
  if (action.includes("DELETE") && settings.actionRules.deleteHigh) {
    add("HIGH", "Delete action recorded.");
  }

  if (entityType === "OTC_SHIFT" && action === "OTC_SHIFT_CLOSE") {
    if (asBool(meta.overrideUsed) && settings.actionRules.otcShiftOverrideHigh) {
      add("HIGH", "Manual shift-close override used.");
    }
    const unposted = asNumber(meta.unpostedPaymentCount);
    if (unposted >= settings.otcShiftUnpostedHighCount) add("HIGH", `${unposted} payments not yet posted to accounts.`);
    else if (unposted > 0) add("MEDIUM", `${unposted} payment(s) not yet posted to accounts.`);
  }

  if (
    entityType === "B2B_PROCUREMENT_REQUEST" &&
    action === "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED"
  ) {
    const notification = (meta.notification || {}) as Record<string, unknown>;
    if (
      settings.actionRules.b2bNotificationFailureMedium &&
      asBool(notification.attempted) &&
      notification.ok === false
    ) {
      add("MEDIUM", "Customer notification failed.");
    }
  }

  if (action === "JOURNAL.ARCHIVE.UNDO" && settings.actionRules.journalArchiveUndoMedium) {
    add("MEDIUM", "Journal archive batch was undone.");
  }

  const reviewedAtRaw = String(meta.reviewedAt || "").trim();
  const reviewed = Boolean(reviewedAtRaw);

  return {
    severity,
    reasons,
    reviewed,
    reviewedAt: reviewed ? reviewedAtRaw : null,
    reviewedByName: String(meta.reviewedByName || "").trim() || null,
  };
}

export function matchesRiskMode(result: AuditRiskResult, mode: AuditRiskMode) {
  if (mode === "all") return true;
  if (mode === "critical") return result.severity === "CRITICAL";
  if (mode === "exceptions") return result.severity !== "LOW";
  if (mode === "needs_review") return result.severity !== "LOW" && !result.reviewed;
  return true;
}
