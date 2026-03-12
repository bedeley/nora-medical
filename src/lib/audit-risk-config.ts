export type AuditSettingsMode = "editable" | "read_only" | "env_only";

export type AuditRiskSettings = {
  refundCriticalAmount: number;
  refundHighAmount: number;
  paymentVoidHighAmount: number;
  otcShiftUnpostedHighCount: number;
  reviewSlaHours: {
    critical: number;
    high: number;
    medium: number;
  };
  archiveWindowDays: {
    reminder: number;
    escalation: number;
  };
  actionRules: {
    orderCancelHigh: boolean;
    deleteHigh: boolean;
    journalArchiveUndoMedium: boolean;
    b2bNotificationFailureMedium: boolean;
    otcShiftOverrideHigh: boolean;
  };
};

function parsePositiveInt(value: string | undefined, fallback: number) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parsePositiveNumber(value: unknown, fallback: number) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseMode(value: string | undefined): AuditSettingsMode {
  const normalized = String(value || "editable").trim().toLowerCase();
  if (normalized === "read_only") return "read_only";
  if (normalized === "env_only") return "env_only";
  return "editable";
}

function asBool(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

export function getAuditSettingsModeFromEnv() {
  return parseMode(process.env.AUDIT_SETTINGS_MODE);
}

export function defaultAuditRiskSettingsFromEnv(): AuditRiskSettings {
  return {
    refundCriticalAmount: parsePositiveInt(process.env.AUDIT_RISK_REFUND_CRITICAL_AMOUNT, 5000),
    refundHighAmount: parsePositiveInt(process.env.AUDIT_RISK_REFUND_HIGH_AMOUNT, 1000),
    paymentVoidHighAmount: parsePositiveInt(process.env.AUDIT_RISK_VOID_HIGH_AMOUNT, 1000),
    otcShiftUnpostedHighCount: parsePositiveInt(process.env.AUDIT_RISK_OTC_UNPOSTED_HIGH_COUNT, 5),
    reviewSlaHours: {
      critical: parsePositiveInt(process.env.AUDIT_REVIEW_SLA_CRITICAL_HOURS, 24),
      high: parsePositiveInt(process.env.AUDIT_REVIEW_SLA_HIGH_HOURS, 72),
      medium: parsePositiveInt(process.env.AUDIT_REVIEW_SLA_MEDIUM_HOURS, 168),
    },
    archiveWindowDays: {
      reminder: parsePositiveInt(process.env.AUDIT_REVIEW_ARCHIVE_REMINDER_DAYS, 14),
      escalation: parsePositiveInt(process.env.AUDIT_REVIEW_ARCHIVE_ESCALATION_DAYS, 3),
    },
    actionRules: {
      orderCancelHigh: asBool(process.env.AUDIT_RISK_RULE_ORDER_CANCEL_HIGH, true),
      deleteHigh: asBool(process.env.AUDIT_RISK_RULE_DELETE_HIGH, true),
      journalArchiveUndoMedium: asBool(process.env.AUDIT_RISK_RULE_JOURNAL_UNDO_MEDIUM, true),
      b2bNotificationFailureMedium: asBool(process.env.AUDIT_RISK_RULE_B2B_NOTIFY_FAIL_MEDIUM, true),
      otcShiftOverrideHigh: asBool(process.env.AUDIT_RISK_RULE_OTC_OVERRIDE_HIGH, true),
    },
  };
}

export function normalizeAuditRiskSettings(
  input: unknown,
  fallback: AuditRiskSettings = defaultAuditRiskSettingsFromEnv(),
): AuditRiskSettings {
  const value = (input || {}) as Record<string, unknown>;
  const reviewSla = (value.reviewSlaHours || {}) as Record<string, unknown>;
  const archive = (value.archiveWindowDays || {}) as Record<string, unknown>;
  const actionRules = (value.actionRules || {}) as Record<string, unknown>;

  const refundCriticalAmount = parsePositiveNumber(value.refundCriticalAmount, fallback.refundCriticalAmount);
  const refundHighAmountRaw = parsePositiveNumber(value.refundHighAmount, fallback.refundHighAmount);
  const refundHighAmount = Math.min(refundHighAmountRaw, refundCriticalAmount);

  return {
    refundCriticalAmount,
    refundHighAmount,
    paymentVoidHighAmount: parsePositiveNumber(value.paymentVoidHighAmount, fallback.paymentVoidHighAmount),
    otcShiftUnpostedHighCount: Math.max(
      1,
      Math.floor(parsePositiveNumber(value.otcShiftUnpostedHighCount, fallback.otcShiftUnpostedHighCount)),
    ),
    reviewSlaHours: {
      critical: Math.max(1, Math.floor(parsePositiveNumber(reviewSla.critical, fallback.reviewSlaHours.critical))),
      high: Math.max(1, Math.floor(parsePositiveNumber(reviewSla.high, fallback.reviewSlaHours.high))),
      medium: Math.max(1, Math.floor(parsePositiveNumber(reviewSla.medium, fallback.reviewSlaHours.medium))),
    },
    archiveWindowDays: {
      reminder: Math.max(1, Math.floor(parsePositiveNumber(archive.reminder, fallback.archiveWindowDays.reminder))),
      escalation: Math.max(1, Math.floor(parsePositiveNumber(archive.escalation, fallback.archiveWindowDays.escalation))),
    },
    actionRules: {
      orderCancelHigh: asBool(actionRules.orderCancelHigh, fallback.actionRules.orderCancelHigh),
      deleteHigh: asBool(actionRules.deleteHigh, fallback.actionRules.deleteHigh),
      journalArchiveUndoMedium: asBool(
        actionRules.journalArchiveUndoMedium,
        fallback.actionRules.journalArchiveUndoMedium,
      ),
      b2bNotificationFailureMedium: asBool(
        actionRules.b2bNotificationFailureMedium,
        fallback.actionRules.b2bNotificationFailureMedium,
      ),
      otcShiftOverrideHigh: asBool(
        actionRules.otcShiftOverrideHigh,
        fallback.actionRules.otcShiftOverrideHigh,
      ),
    },
  };
}
