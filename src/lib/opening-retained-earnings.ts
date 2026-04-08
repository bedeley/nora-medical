export const OPENING_BALANCE_EQUITY_CODE = "3900";
export const RETAINED_EARNINGS_ACCOUNT_CODE = "3100";
export const OPENING_RETAINED_EARNINGS_SETTING_KEY = "accounting.openingRetainedEarnings";

export type OpeningRetainedEarningsValue = {
  amount: number;
  notes: string | null;
  entryDate: string;
  journalEntryId: string;
  configuredAt: string;
  configuredById: string | null;
  openingBalanceEquityCode: string;
  retainedEarningsAccountCode: string;
};

export function parseOpeningRetainedEarningsValue(value: unknown): OpeningRetainedEarningsValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const amount = Number(row.amount);
  const entryDate = String(row.entryDate || "").trim();
  const journalEntryId = String(row.journalEntryId || "").trim();
  const configuredAt = String(row.configuredAt || "").trim();
  const openingBalanceEquityCode = String(row.openingBalanceEquityCode || "").trim();
  const retainedEarningsAccountCode = String(row.retainedEarningsAccountCode || "").trim();
  if (!Number.isFinite(amount) || !entryDate || !journalEntryId || !configuredAt) return null;
  return {
    amount,
    notes: row.notes == null ? null : String(row.notes),
    entryDate,
    journalEntryId,
    configuredAt,
    configuredById: row.configuredById == null ? null : String(row.configuredById),
    openingBalanceEquityCode: openingBalanceEquityCode || OPENING_BALANCE_EQUITY_CODE,
    retainedEarningsAccountCode: retainedEarningsAccountCode || RETAINED_EARNINGS_ACCOUNT_CODE,
  };
}
