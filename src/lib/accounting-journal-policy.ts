import { prisma } from "@/lib/prisma";

export type AccountingJournalPolicy = {
  recentWindowDays: number;
  manualEntryAllowPnl: boolean;
  archiveAfterMonths: number;
  archiveCronDryRun: boolean;
  largeAmountAnomalyThreshold: number;
};

const DEFAULTS: AccountingJournalPolicy = {
  recentWindowDays: 90,
  manualEntryAllowPnl: false,
  archiveAfterMonths: 18,
  archiveCronDryRun: false,
  largeAmountAnomalyThreshold: 25000,
};

function parseBoolean(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function envDefaults(): AccountingJournalPolicy {
  return {
    recentWindowDays: clampInt(process.env.JOURNAL_RECENT_WINDOW_DAYS, DEFAULTS.recentWindowDays, 1, 3660),
    manualEntryAllowPnl: parseBoolean(process.env.ACCOUNTING_MANUAL_ENTRY_ALLOW_PNL, DEFAULTS.manualEntryAllowPnl),
    archiveAfterMonths: clampInt(process.env.JOURNAL_ARCHIVE_AFTER_MONTHS, DEFAULTS.archiveAfterMonths, 1, 120),
    archiveCronDryRun: parseBoolean(process.env.JOURNAL_ARCHIVE_CRON_DRY_RUN, DEFAULTS.archiveCronDryRun),
    largeAmountAnomalyThreshold: clampInt(process.env.JOURNAL_LARGE_AMOUNT_ANOMALY_THRESHOLD, DEFAULTS.largeAmountAnomalyThreshold, 0, 1_000_000_000),
  };
}

export async function loadAccountingJournalPolicy(): Promise<AccountingJournalPolicy> {
  const fallback = envDefaults();
  const row = await prisma.appSetting.findUnique({
    where: { key: "accounting.journal.policy" },
    select: { value: true },
  });
  const raw = row?.value && typeof row.value === "object" ? (row.value as Record<string, unknown>) : null;
  if (!raw) return fallback;
  return {
    recentWindowDays: clampInt(raw.recentWindowDays, fallback.recentWindowDays, 1, 3660),
    manualEntryAllowPnl: parseBoolean(raw.manualEntryAllowPnl, fallback.manualEntryAllowPnl),
    archiveAfterMonths: clampInt(raw.archiveAfterMonths, fallback.archiveAfterMonths, 1, 120),
    archiveCronDryRun: parseBoolean(raw.archiveCronDryRun, fallback.archiveCronDryRun),
    largeAmountAnomalyThreshold: clampInt(raw.largeAmountAnomalyThreshold, fallback.largeAmountAnomalyThreshold, 0, 1_000_000_000),
  };
}
