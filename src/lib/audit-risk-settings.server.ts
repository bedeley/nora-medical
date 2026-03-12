import "server-only";

import { prisma } from "@/lib/prisma";
import {
  defaultAuditRiskSettingsFromEnv,
  getAuditSettingsModeFromEnv,
  normalizeAuditRiskSettings,
  type AuditRiskSettings,
  type AuditSettingsMode,
} from "@/lib/audit-risk-config";

const AUDIT_RISK_SETTINGS_KEY = "audit.risk.settings";

export async function getEffectiveAuditRiskSettings(): Promise<{
  mode: AuditSettingsMode;
  editable: boolean;
  settings: AuditRiskSettings;
}> {
  const mode = getAuditSettingsModeFromEnv();
  const defaults = defaultAuditRiskSettingsFromEnv();

  if (mode === "env_only") {
    return {
      mode,
      editable: false,
      settings: defaults,
    };
  }

  const row = await prisma.appSetting.findUnique({
    where: { key: AUDIT_RISK_SETTINGS_KEY },
    select: { value: true },
  });

  return {
    mode,
    editable: mode === "editable",
    settings: normalizeAuditRiskSettings(row?.value, defaults),
  };
}

export { AUDIT_RISK_SETTINGS_KEY };
