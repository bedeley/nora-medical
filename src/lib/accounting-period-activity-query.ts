export const PERIOD_ACTIVITY_ACTIONS = [
  "fiscal-period.create",
  "fiscal-period.close",
  "fiscal-period.open",
  "fiscal-month.close",
  "fiscal-month.open",
  "fiscal-month.batch.close",
  "fiscal-month.batch.open",
  "fiscal-month.calendar.initialize",
  "fiscal-period.auto_generate.cron.run",
  "fiscal-period.auto_generate.manual.run",
  "fiscal-period.prior_adjustment.note",
] as const;

export type PeriodActivityFilters = {
  action: string | null;
  actor: string;
  from: string | null;
  to: string | null;
  effectiveFromDate: Date;
  toDate: Date | null;
};

function parseDateBoundary(value: string | null, endOfDay = false) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }
  return date;
}

export function normalizePeriodActivityFilters(input: {
  action?: string | null;
  actor?: string | null;
  from?: string | null;
  to?: string | null;
  daysBack: number;
}) {
  const actionRaw = String(input.action || "").trim();
  const action = PERIOD_ACTIVITY_ACTIONS.includes(actionRaw as (typeof PERIOD_ACTIVITY_ACTIONS)[number])
    ? actionRaw
    : null;
  const actor = String(input.actor || "").trim();
  const fromRaw = String(input.from || "").trim() || null;
  const toRaw = String(input.to || "").trim() || null;
  const fromDateFilter = parseDateBoundary(fromRaw, false);
  const toDate = parseDateBoundary(toRaw, true);
  if (fromDateFilter && toDate && fromDateFilter.getTime() > toDate.getTime()) {
    return { ok: false as const, error: "From date cannot be after to date." };
  }
  const baselineFromDate = new Date(Date.now() - input.daysBack * 86_400_000);
  const effectiveFromDate =
    fromDateFilter && fromDateFilter.getTime() > baselineFromDate.getTime()
      ? fromDateFilter
      : baselineFromDate;

  const normalized: PeriodActivityFilters = {
    action,
    actor,
    from: fromRaw,
    to: toRaw,
    effectiveFromDate,
    toDate,
  };
  return { ok: true as const, filters: normalized };
}
