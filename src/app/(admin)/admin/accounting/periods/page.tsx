"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { AppSettingSnapshot, fetchAppSetting, fetchJsonOrThrow, saveAppSetting } from "@/lib/app-settings-client";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type FiscalPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
};

type PeriodChecklist = {
  draftEntries: number;
  openReconciliations: number;
  cashReconciliations: number;
  vatFilings: number;
  arOpenBalances: number;
  inventoryDifference: number;
  negativeStockCount: number;
};

type MonthlyCloseRow = {
  month: string;
  closedAt: string;
  closedByName?: string | null;
  note?: string | null;
};
type MonthlyCloseChecklist = {
  month: string;
  isClosed: boolean;
  draftEntries: number;
  openReconciliations: number;
  blockers: number;
};
type InitializedYearRow = {
  year: number;
  initializedAt: string;
  initializedByName?: string | null;
};
type PeriodActivityRow = {
  id: string;
  createdAt: string;
  action: string;
  entityType: string;
  entityId: string;
  actor: { name: string | null; email: string | null; role: string | null } | null;
  meta: unknown;
};
type PeriodActivityResponse = {
  rows: PeriodActivityRow[];
  nextCursor: string | null;
  hasMore: boolean;
  daysBack: number;
  appliedFilters?: {
    action?: string | null;
    actor?: string | null;
    from?: string | null;
    to?: string | null;
  };
};
type AuditListResponse = {
  items: Array<{
    id: string;
    createdAt: string;
    actor?: { name?: string | null; email?: string | null } | null;
  }>;
};
type PeriodReadinessRow = {
  periodId: string;
  status: "READY" | "ATTENTION" | "BLOCKED";
  readyCount: number;
  totalChecks: number;
  draftEntries: number;
  openReconciliations: number;
  cashReconciliations: number;
  vatFilings: number;
  arOpenBalances: number;
  inventoryDifference: number;
  negativeStockCount: number;
};
type BatchAction = "close" | "open";
type BatchMonthBlockerRow = {
  month: string;
  draftEntries: number;
  openReconciliations: number;
  blockers: number;
};

type CloseChecklistState = {
  bankReviewed: boolean;
  cashReviewed: boolean;
  arApReviewed: boolean;
  inventoryReviewed: boolean;
  vatReviewed: boolean;
};

const DEFAULT_REMINDER_DAYS = 7;
const DEFAULT_ACTIVITY_DAYS_BACK = 90;
const ACTIVITY_PAGE_SIZE = 25;

const CLOSE_CHECKLIST_ITEMS: Array<{
  key: keyof CloseChecklistState;
  label: string;
  href: string;
  linkLabel: string;
}> = [
  {
    key: "bankReviewed",
    label: "Bank reconciliation reviewed for this period.",
    href: "/admin/accounting/reconcile",
    linkLabel: "Open Reconcile",
  },
  {
    key: "cashReviewed",
    label: "Cash reconciliation reviewed for this period.",
    href: "/admin/accounting/cash-reconciliations",
    linkLabel: "Open Cash Reconciliations",
  },
  {
    key: "arApReviewed",
    label: "AR/AP aging reviewed and exceptions noted.",
    href: "/admin/accounting/integrity",
    linkLabel: "Open Integrity",
  },
  {
    key: "inventoryReviewed",
    label: "Inventory valuation/integrity reviewed.",
    href: "/admin/accounting/integrity",
    linkLabel: "Open Integrity",
  },
  {
    key: "vatReviewed",
    label: "VAT report reviewed or marked not applicable.",
    href: "/admin/accounting/vat-filings",
    linkLabel: "Open VAT Filings",
  },
];

type ReadinessStatus = "ready" | "attention" | "blocked";
type ReadinessRow = {
  key: string;
  label: string;
  value: string;
  status: ReadinessStatus;
  href: string;
  actionLabel: string;
};

function endOfDay(dateText: string) {
  return new Date(`${dateText.slice(0, 10)}T23:59:59.999`);
}

function daysUntil(dateText: string) {
  const now = new Date();
  const target = endOfDay(dateText);
  return Math.ceil((target.getTime() - now.getTime()) / 86_400_000);
}

function monthRange(monthKey: string) {
  const [yearText, monthText] = monthKey.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function parseMetaObject(meta: unknown): Record<string, unknown> | null {
  if (!meta) return null;
  if (typeof meta === "object" && !Array.isArray(meta)) return meta as Record<string, unknown>;
  if (typeof meta !== "string") return null;
  const text = meta.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function summarizeActivityMeta(action: string, meta: unknown) {
  const parsed = parseMetaObject(meta);
  if (!parsed) return typeof meta === "string" ? meta : "";

  if (action === "fiscal-month.close" || action === "fiscal-month.open") {
    const month = String(parsed.month || "");
    const blockers = (parsed.blockers as Record<string, unknown> | null) || null;
    const drafts = Number(blockers?.draftEntries || 0);
    const openRecs = Number(blockers?.openReconciliations || 0);
    const note = String(parsed.note || "");
    const override = String(parsed.overrideReason || "");
    const parts = [
      `${action.endsWith(".close") ? "Month closed" : "Month reopened"}: ${month || "unknown month"}.`,
      `Draft journals: ${drafts}. Open reconciliations: ${openRecs}.`,
    ];
    if (note) parts.push(`Note: ${note}.`);
    if (override) parts.push(`Override reason: ${override}.`);
    return parts.join(" ");
  }

  if (action === "fiscal-month.batch.close" || action === "fiscal-month.batch.open") {
    const months = Array.isArray(parsed.months) ? parsed.months.map((m) => String(m)).join(", ") : "";
    const count = Number(parsed.count || 0);
    const note = String(parsed.note || "");
    return `${action.endsWith(".close") ? "Batch close" : "Batch reopen"} affected ${count} month(s)${
      months ? `: ${months}` : ""
    }.${note ? ` Note: ${note}.` : ""}`;
  }

  if (action === "fiscal-period.create" || action === "fiscal-period.close" || action === "fiscal-period.open") {
    const name = String(parsed.name || "");
    const reason = String(parsed.overrideReason || "");
    if (action.endsWith(".create")) return `Fiscal period created${name ? `: ${name}` : ""}.`;
    return `${action.endsWith(".close") ? "Fiscal period closed" : "Fiscal period reopened"}${
      name ? `: ${name}` : ""
    }.${reason ? ` Reason: ${reason}.` : ""}`;
  }

  if (action === "fiscal-month.calendar.initialize") {
    const year = String(parsed.year || "");
    const already = Boolean(parsed.alreadyInitialized);
    return already
      ? `Monthly operational calendar for ${year || "selected year"} was already initialized.`
      : `Monthly operational calendar initialized for ${year || "selected year"}.`;
  }

  if (action === "fiscal-period.prior_adjustment.note") {
    const journalEntryId = String(parsed.journalEntryId || "");
    const memo = String(parsed.memo || "");
    return `Prior-period adjustment documented${journalEntryId ? ` (journal ${journalEntryId.slice(0, 12)}...)` : ""}${
      memo ? `: ${memo}` : "."
    }`;
  }

  return JSON.stringify(parsed);
}

function formatActivityActionLabel(action: string) {
  const labels: Record<string, string> = {
    "fiscal-period.create": "Fiscal period created",
    "fiscal-period.close": "Fiscal period closed",
    "fiscal-period.open": "Fiscal period reopened",
    "fiscal-month.close": "Monthly close applied",
    "fiscal-month.open": "Monthly close reopened",
    "fiscal-month.batch.close": "Batch monthly close applied",
    "fiscal-month.batch.open": "Batch monthly close reopened",
    "fiscal-month.calendar.initialize": "Monthly operational calendar initialized",
    "fiscal-period.auto_generate.cron.run": "Monthly calendar auto-generation (cron)",
    "fiscal-period.auto_generate.manual.run": "Monthly calendar auto-generation (manual)",
    "fiscal-period.prior_adjustment.note": "Prior-period adjustment note recorded",
  };
  return labels[action] || action.replaceAll(".", " ");
}

export default function AccountingPeriodsPage() {
  const queryClient = useQueryClient();
  const [monthlyCloseMonth, setMonthlyCloseMonth] = useState(() => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  });
  const { data } = useClientQuery<FiscalPeriod[]>({
    queryKey: ["accounting", "periods"],
    queryFn: () => fetch("/api/admin/accounting/periods").then((r) => r.json()),
  });
  const { data: snapshotData } = useClientQuery<{ periodId: string }[]>({
    queryKey: ["accounting", "period-snapshots"],
    queryFn: () => fetch("/api/admin/accounting/periods/snapshots").then((r) => r.json()),
  });
  const { data: reminderData } = useClientQuery<AppSettingSnapshot<number>>({
    queryKey: ["app-setting", "accounting.periodClose.reminderDays"],
    queryFn: () => fetchAppSetting<number>("accounting.periodClose.reminderDays"),
  });
  const { data: monthlyReopenWindowData } = useClientQuery<AppSettingSnapshot<number>>({
    queryKey: ["app-setting", "accounting.reopen.monthlyWindowDays"],
    queryFn: () => fetchAppSetting<number>("accounting.reopen.monthlyWindowDays"),
  });
  const { data: fiscalReopenWindowData } = useClientQuery<AppSettingSnapshot<number>>({
    queryKey: ["app-setting", "accounting.reopen.fiscalWindowDays"],
    queryFn: () => fetchAppSetting<number>("accounting.reopen.fiscalWindowDays"),
  });
  const { data: enforceFinalizedLockData } = useClientQuery<AppSettingSnapshot<boolean | string>>({
    queryKey: ["app-setting", "accounting.reopen.enforceFinalizedYearLock"],
    queryFn: () => fetchAppSetting<boolean | string>("accounting.reopen.enforceFinalizedYearLock"),
  });
  const { data: finalizedFiscalYearsData } = useClientQuery<AppSettingSnapshot<number[]>>({
    queryKey: ["app-setting", "accounting.reopen.finalizedFiscalYears"],
    queryFn: () => fetchAppSetting<number[]>("accounting.reopen.finalizedFiscalYears"),
  });
  const { data: reminderAuditData } = useClientQuery<AuditListResponse>({
    queryKey: ["audit", "periods-reminder-setting-latest"],
    queryFn: async () => {
      const res = await fetch(
        "/api/admin/audit?action=app-setting.update&entityId=accounting.periodClose.reminderDays&paginate=1&page=1&pageSize=1",
      );
      return fetchJsonOrThrow<AuditListResponse>(res, "Failed to load reminder setting audit.");
    },
  });
  const { data: monthlyCloseData } = useClientQuery<{ rows: MonthlyCloseRow[] }>({
    queryKey: ["accounting", "periods", "monthly-close"],
    queryFn: () => fetch("/api/admin/accounting/periods/monthly-close").then((r) => r.json()),
  });
  const { data: monthlyChecklistData, refetch: refetchMonthlyChecklist } = useClientQuery<MonthlyCloseChecklist>({
    queryKey: ["accounting", "periods", "monthly-close", "checklist", monthlyCloseMonth],
    queryFn: () => fetch(`/api/admin/accounting/periods/monthly-close/checklist?month=${encodeURIComponent(monthlyCloseMonth)}`).then((r) => r.json()),
    enabled: /^\d{4}-(0[1-9]|1[0-2])$/.test(monthlyCloseMonth),
  });
  const { data: monthlyCalendarData } = useClientQuery<{ initializedYears: InitializedYearRow[] }>({
    queryKey: ["accounting", "periods", "monthly-calendar"],
    queryFn: () => fetch("/api/admin/accounting/periods/generate-monthly").then((r) => r.json()),
  });
  const { data: periodReadinessData } = useClientQuery<{ rows: PeriodReadinessRow[] }>({
    queryKey: ["accounting", "periods", "readiness"],
    queryFn: () => fetch("/api/admin/accounting/periods/readiness").then((r) => r.json()),
  });

  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [closePeriod, setClosePeriod] = useState<FiscalPeriod | null>(null);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenPeriod, setReopenPeriod] = useState<FiscalPeriod | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const [checklist, setChecklist] = useState<PeriodChecklist | null>(null);
  const [closing, setClosing] = useState(false);
  const [checklistState, setChecklistState] = useState<CloseChecklistState>({
    bankReviewed: false,
    cashReviewed: false,
    arApReviewed: false,
    inventoryReviewed: false,
    vatReviewed: false,
  });
  const [allowOverride, setAllowOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [savingReminder, setSavingReminder] = useState(false);
  const [reminderDaysInput, setReminderDaysInput] = useState(String(DEFAULT_REMINDER_DAYS));
  const [monthlyCloseNote, setMonthlyCloseNote] = useState("");
  const [monthlyCloseBusy, setMonthlyCloseBusy] = useState(false);
  const [monthlyForceClose, setMonthlyForceClose] = useState(false);
  const [monthlyOverrideReason, setMonthlyOverrideReason] = useState("");
  const [batchMonthsInput, setBatchMonthsInput] = useState("");
  const [batchMonthPicker, setBatchMonthPicker] = useState("");
  const [batchNote, setBatchNote] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [showMonthlyDetails, setShowMonthlyDetails] = useState(false);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [batchAction, setBatchAction] = useState<BatchAction>("close");
  const [batchMonthsResolved, setBatchMonthsResolved] = useState<string[]>([]);
  const [batchCloseBlockers, setBatchCloseBlockers] = useState<BatchMonthBlockerRow[]>([]);
  const [generatorYear, setGeneratorYear] = useState(String(new Date().getUTCFullYear()));
  const [generatorBusy, setGeneratorBusy] = useState(false);
  const [periodActivityRows, setPeriodActivityRows] = useState<PeriodActivityRow[]>([]);
  const [periodActivityNextCursor, setPeriodActivityNextCursor] = useState<string | null>(null);
  const [periodActivityHasMore, setPeriodActivityHasMore] = useState(false);
  const [periodActivityFilterEcho, setPeriodActivityFilterEcho] = useState<{
    action: string | null;
    actor: string | null;
    from: string | null;
    to: string | null;
  }>({ action: null, actor: null, from: null, to: null });
  const [periodActivityLoading, setPeriodActivityLoading] = useState(false);
  const [periodActivityLoadingMore, setPeriodActivityLoadingMore] = useState(false);
  const [activityActionFilter, setActivityActionFilter] = useState("");
  const [activityActorFilter, setActivityActorFilter] = useState("");
  const [activityFromDate, setActivityFromDate] = useState(() => {
    const from = new Date(Date.now() - DEFAULT_ACTIVITY_DAYS_BACK * 86_400_000);
    return from.toISOString().slice(0, 10);
  });
  const [activityToDate, setActivityToDate] = useState("");
  const [showBlockedOnly, setShowBlockedOnly] = useState(false);

  const periods = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const monthlyClosedRows = useMemo(
    () => (Array.isArray(monthlyCloseData?.rows) ? monthlyCloseData.rows : []),
    [monthlyCloseData?.rows],
  );
  const snapshots = Array.isArray(snapshotData) ? snapshotData : [];
  const snapshotIds = new Set(snapshots.map((s) => s.periodId));
  const reminderDays = Math.max(
    1,
    Number(
      typeof reminderData?.value === "number"
        ? reminderData.value
        : Number(reminderData?.value ?? DEFAULT_REMINDER_DAYS),
    ) || DEFAULT_REMINDER_DAYS,
  );
  const monthlyReopenWindowDays = Math.max(
    0,
    Number(
      typeof monthlyReopenWindowData?.value === "number"
        ? monthlyReopenWindowData.value
        : Number(monthlyReopenWindowData?.value ?? 7),
    ) || 7,
  );
  const fiscalReopenWindowDays = Math.max(
    0,
    Number(
      typeof fiscalReopenWindowData?.value === "number"
        ? fiscalReopenWindowData.value
        : Number(fiscalReopenWindowData?.value ?? 30),
    ) || 30,
  );
  const currentEnforceFinalizedYearLock =
    typeof enforceFinalizedLockData?.value === "boolean"
      ? enforceFinalizedLockData.value
      : String(enforceFinalizedLockData?.value ?? "")
          .trim()
          .toLowerCase() === "true";
  const currentFinalizedFiscalYears = useMemo(
    () =>
      Array.isArray(finalizedFiscalYearsData?.value)
        ? Array.from(
            new Set(
              finalizedFiscalYearsData.value
                .map((v) => Number(v))
                .filter((n) => Number.isInteger(n) && n >= 2000 && n <= 2100),
            ),
          ).sort((a, b) => a - b)
        : [],
    [finalizedFiscalYearsData?.value],
  );
  const reminderSettingAuditSummary = useMemo(() => {
    const row = Array.isArray(reminderAuditData?.items) ? reminderAuditData.items[0] : null;
    if (!row) return "No recent reminder-setting audit entry.";
    const actor = row.actor?.name || row.actor?.email || "System";
    return `Last reminder-setting update: ${new Date(row.createdAt).toLocaleString()} by ${actor}.`;
  }, [reminderAuditData?.items]);
  const openPeriods = useMemo(
    () =>
      periods
        .filter((period) => period.status === "OPEN")
        .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()),
    [periods],
  );
  const nextOpenPeriod = openPeriods[0] || null;
  const daysToPeriodEnd = nextOpenPeriod ? daysUntil(nextOpenPeriod.endDate) : null;
  const showReminder =
    nextOpenPeriod !== null &&
    daysToPeriodEnd !== null &&
    daysToPeriodEnd <= reminderDays &&
    daysToPeriodEnd >= 0;
  const checklistComplete = CLOSE_CHECKLIST_ITEMS.every((item) => checklistState[item.key]);
  const checklistCompletedCount = CLOSE_CHECKLIST_ITEMS.filter((item) => checklistState[item.key]).length;
  const readinessRows = useMemo<ReadinessRow[]>(() => {
    if (!closePeriod || !checklist) return [];
    const start = new Date(closePeriod.startDate).toISOString().slice(0, 10);
    const end = new Date(closePeriod.endDate).toISOString().slice(0, 10);
    const absInventoryDiff = Math.abs(Number(checklist.inventoryDifference || 0));
    return [
      {
        key: "draft-journals",
        label: "Draft journal entries",
        value: String(checklist.draftEntries),
        status: checklist.draftEntries === 0 ? "ready" : "blocked",
        href: `/admin/accounting/journal?start=${start}&end=${end}&status=DRAFT`,
        actionLabel: "Open Journal",
      },
      {
        key: "open-reconciliations",
        label: "Open reconciliations",
        value: String(checklist.openReconciliations),
        status: checklist.openReconciliations === 0 ? "ready" : "attention",
        href: `/admin/accounting/reconcile?start=${start}&end=${end}`,
        actionLabel: "Open Reconcile",
      },
      {
        key: "cash-reconciliations",
        label: "Cash reconciliation runs",
        value: String(checklist.cashReconciliations),
        status: checklist.cashReconciliations > 0 ? "ready" : "attention",
        href: `/admin/accounting/cash-reconciliations?start=${start}&end=${end}`,
        actionLabel: "Open Cash Reconciliations",
      },
      {
        key: "vat-filings",
        label: "VAT filing runs",
        value: String(checklist.vatFilings),
        status: checklist.vatFilings > 0 ? "ready" : "attention",
        href: `/admin/accounting/vat-filings?start=${start}&end=${end}`,
        actionLabel: "Open VAT Filings",
      },
      {
        key: "ar-open-balances",
        label: "AR open customer balances",
        value: String(checklist.arOpenBalances),
        status: checklist.arOpenBalances === 0 ? "ready" : "attention",
        href: `/admin/accounting/integrity?asOf=${end}`,
        actionLabel: "Open Integrity",
      },
      {
        key: "inventory-difference",
        label: "Inventory valuation difference",
        value: absInventoryDiff.toFixed(2),
        status: absInventoryDiff <= 0.01 ? "ready" : "attention",
        href: `/admin/accounting/integrity?asOf=${end}`,
        actionLabel: "Open Integrity",
      },
      {
        key: "negative-stock",
        label: "Products with negative stock",
        value: String(checklist.negativeStockCount),
        status: checklist.negativeStockCount === 0 ? "ready" : "blocked",
        href: `/admin/accounting/integrity?asOf=${end}`,
        actionLabel: "Open Integrity",
      },
    ];
  }, [closePeriod, checklist]);
  const systemControlRows = readinessRows.filter(
    (row) => row.key === "inventory-difference" || row.key === "negative-stock",
  );
  const systemControlReadyCount = systemControlRows.filter((row) => row.status === "ready").length;
  const systemControlBlockedCount = systemControlRows.filter((row) => row.status === "blocked").length;
  const closePeriodIsEarly = closePeriod ? new Date(closePeriod.endDate).getTime() > Date.now() : false;
  const checklistOverrideMissing = !checklistComplete && (!allowOverride || !overrideReason.trim());
  const earlyCloseOverrideMissing = closePeriodIsEarly && (!allowOverride || overrideReason.trim().length < 20);
  const closePeriodBlockedByDrafts = (checklist?.draftEntries ?? 0) > 0;
  const closePeriodButtonDisabled =
    closing || closePeriodBlockedByDrafts || checklistOverrideMissing || earlyCloseOverrideMissing;
  const closePeriodDisableReason = closing
    ? "Close action is running."
    : closePeriodBlockedByDrafts
      ? "Close is blocked because draft journal entries still exist. Post or void drafts first."
      : checklistOverrideMissing
        ? "Complete checklist items or enable override and enter a reason."
        : earlyCloseOverrideMissing
          ? "Early close requires override enabled with a reason of at least 20 characters."
          : "";

  const refreshPeriodActivity = useCallback(async () => {
    try {
      setPeriodActivityLoading(true);
      const params = new URLSearchParams();
      params.set("limit", String(ACTIVITY_PAGE_SIZE));
      params.set("daysBack", String(DEFAULT_ACTIVITY_DAYS_BACK));
      if (activityActionFilter) params.set("action", activityActionFilter);
      if (activityActorFilter.trim()) params.set("actor", activityActorFilter.trim());
      if (activityFromDate) params.set("from", activityFromDate);
      if (activityToDate) params.set("to", activityToDate);
      const res = await fetch(`/api/admin/accounting/periods/activity?${params.toString()}`);
      const j = (await res.json().catch(() => ({}))) as Partial<PeriodActivityResponse> & { error?: string };
      if (!res.ok) throw new Error(j.error || "Failed to load close activity timeline.");
      const rows = Array.isArray(j.rows) ? j.rows : [];
      setPeriodActivityRows(rows);
      setPeriodActivityNextCursor(typeof j.nextCursor === "string" ? j.nextCursor : null);
      setPeriodActivityHasMore(Boolean(j.hasMore));
      setPeriodActivityFilterEcho({
        action: j.appliedFilters?.action || null,
        actor: j.appliedFilters?.actor || null,
        from: j.appliedFilters?.from || null,
        to: j.appliedFilters?.to || null,
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load close activity timeline.");
      setPeriodActivityRows([]);
      setPeriodActivityNextCursor(null);
      setPeriodActivityHasMore(false);
    } finally {
      setPeriodActivityLoading(false);
    }
  }, [activityActionFilter, activityActorFilter, activityFromDate, activityToDate]);

  const loadMorePeriodActivity = useCallback(async () => {
    if (!periodActivityHasMore || !periodActivityNextCursor || periodActivityLoadingMore) return;
    try {
      setPeriodActivityLoadingMore(true);
      const params = new URLSearchParams();
      params.set("limit", String(ACTIVITY_PAGE_SIZE));
      params.set("daysBack", String(DEFAULT_ACTIVITY_DAYS_BACK));
      params.set("cursor", periodActivityNextCursor);
      if (activityActionFilter) params.set("action", activityActionFilter);
      if (activityActorFilter.trim()) params.set("actor", activityActorFilter.trim());
      if (activityFromDate) params.set("from", activityFromDate);
      if (activityToDate) params.set("to", activityToDate);
      const res = await fetch(`/api/admin/accounting/periods/activity?${params.toString()}`);
      const j = (await res.json().catch(() => ({}))) as Partial<PeriodActivityResponse> & { error?: string };
      if (!res.ok) throw new Error(j.error || "Failed to load more timeline rows.");
      const rows = Array.isArray(j.rows) ? j.rows : [];
      setPeriodActivityRows((prev) => {
        const existing = new Set(prev.map((row) => row.id));
        return prev.concat(rows.filter((row) => !existing.has(row.id)));
      });
      setPeriodActivityNextCursor(typeof j.nextCursor === "string" ? j.nextCursor : null);
      setPeriodActivityHasMore(Boolean(j.hasMore));
      setPeriodActivityFilterEcho({
        action: j.appliedFilters?.action || null,
        actor: j.appliedFilters?.actor || null,
        from: j.appliedFilters?.from || null,
        to: j.appliedFilters?.to || null,
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load more timeline rows.");
    } finally {
      setPeriodActivityLoadingMore(false);
    }
  }, [
    periodActivityHasMore,
    periodActivityNextCursor,
    periodActivityLoadingMore,
    activityActionFilter,
    activityActorFilter,
    activityFromDate,
    activityToDate,
  ]);

  useEffect(() => {
    void refreshPeriodActivity();
  }, [refreshPeriodActivity]);

  const activityRows = periodActivityRows;
  const activeActivityFilterCount = useMemo(() => {
    let count = 0;
    if (activityActionFilter) count += 1;
    if (activityActorFilter.trim()) count += 1;
    if (activityFromDate) count += 1;
    if (activityToDate) count += 1;
    return count;
  }, [activityActionFilter, activityActorFilter, activityFromDate, activityToDate]);
  const activityFilterEchoText = useMemo(() => {
    const parts: string[] = [];
    if (periodActivityFilterEcho.action) parts.push(`Action: ${formatActivityActionLabel(periodActivityFilterEcho.action)}`);
    if (periodActivityFilterEcho.actor) parts.push(`Actor: ${periodActivityFilterEcho.actor}`);
    if (periodActivityFilterEcho.from) parts.push(`From: ${periodActivityFilterEcho.from}`);
    if (periodActivityFilterEcho.to) parts.push(`To: ${periodActivityFilterEcho.to}`);
    return parts.join(" | ");
  }, [periodActivityFilterEcho]);
  const initializedYears = useMemo(
    () => (Array.isArray(monthlyCalendarData?.initializedYears) ? monthlyCalendarData.initializedYears : []),
    [monthlyCalendarData?.initializedYears],
  );
  const selectedCalendarYear = Number(generatorYear);
  const calendarMonthRows = useMemo(() => {
    if (!Number.isInteger(selectedCalendarYear) || selectedCalendarYear < 2000 || selectedCalendarYear > 2100) return [];
    const closedSet = new Set(monthlyClosedRows.map((row) => row.month));
    return Array.from({ length: 12 }, (_, idx) => {
      const month = String(idx + 1).padStart(2, "0");
      const monthKey = `${selectedCalendarYear}-${month}`;
      return {
        monthKey,
        label: new Date(Date.UTC(selectedCalendarYear, idx, 1)).toLocaleString("en-US", {
          month: "short",
          timeZone: "UTC",
        }),
        isClosed: closedSet.has(monthKey),
      };
    });
  }, [selectedCalendarYear, monthlyClosedRows]);
  const selectedYearInitRow = useMemo(
    () => initializedYears.find((row) => row.year === selectedCalendarYear) || null,
    [initializedYears, selectedCalendarYear],
  );
  const activityActions = useMemo(() => {
    const rows = periodActivityRows;
    return Array.from(new Set(rows.map((row) => row.action))).sort();
  }, [periodActivityRows]);
  const readinessByPeriodId = useMemo(() => {
    const rows = Array.isArray(periodReadinessData?.rows) ? periodReadinessData.rows : [];
    return new Map(rows.map((row) => [row.periodId, row]));
  }, [periodReadinessData?.rows]);
  const historyPeriods = useMemo(() => {
    if (!showBlockedOnly) return periods;
    return periods.filter((period) => {
      if (period.status !== "OPEN") return false;
      const readiness = readinessByPeriodId.get(period.id);
      return readiness?.status === "BLOCKED";
    });
  }, [periods, readinessByPeriodId, showBlockedOnly]);

  useEffect(() => {
    setReminderDaysInput(String(reminderDays));
  }, [reminderDays]);

  const createPeriod = async () => {
    if (!name || !startDate || !endDate) {
      toast.error("Provide name and dates.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch("/api/admin/accounting/periods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, startDate, endDate }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to create period.");
      toast.success("Fiscal period created.");
      setName("");
      setStartDate("");
      setEndDate("");
      queryClient.invalidateQueries({ queryKey: ["accounting", "periods"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create period.");
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (period: FiscalPeriod, status: "OPEN" | "CLOSED", reason?: string) => {
    try {
      const res = await fetch(`/api/admin/accounting/periods/${period.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, overrideReason: reason || undefined }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update period.");
      toast.success(`Period ${status === "CLOSED" ? "closed" : "reopened"}.`);
      queryClient.invalidateQueries({ queryKey: ["accounting", "periods"] });
      refreshPeriodActivity();
      return true;
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update period.");
      return false;
    }
  };

  const openCloseDialog = async (period: FiscalPeriod) => {
    setClosePeriod(period);
    setCloseOpen(true);
    setAllowOverride(false);
    setOverrideReason("");
    setChecklistState({
      bankReviewed: false,
      cashReviewed: false,
      arApReviewed: false,
      inventoryReviewed: false,
      vatReviewed: false,
    });
    try {
      const res = await fetch(`/api/admin/accounting/periods/${period.id}/checklist`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to load checklist.");
      setChecklist({
        draftEntries: Number(j.draftEntries || 0),
        openReconciliations: Number(j.openReconciliations || 0),
        cashReconciliations: Number(j.cashReconciliations || 0),
        vatFilings: Number(j.vatFilings || 0),
        arOpenBalances: Number(j.arOpenBalances || 0),
        inventoryDifference: Number(j.inventoryDifference || 0),
        negativeStockCount: Number(j.negativeStockCount || 0),
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load checklist.");
    }
  };

  const openReopenDialog = (period: FiscalPeriod) => {
    setReopenPeriod(period);
    setReopenReason("");
    setReopenOpen(true);
  };

  const handleReopen = async () => {
    if (!reopenPeriod) return;
    const reason = reopenReason.trim();
    if (reason.length < 8) {
      toast.error("Provide a reopen reason of at least 8 characters.");
      return;
    }
    const ok = await updateStatus(reopenPeriod, "OPEN", reason);
    if (ok) {
      setReopenOpen(false);
      setReopenPeriod(null);
      setReopenReason("");
    }
  };

  const handleClose = async () => {
    if (!closePeriod) return;
    const normalizedOverride = overrideReason.trim();
    if (!checklistComplete && (!allowOverride || !normalizedOverride)) {
      toast.error("Complete checklist or provide an override reason.");
      return;
    }
    try {
      setClosing(true);
      const res = await fetch(`/api/admin/accounting/periods/${closePeriod.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "CLOSED",
          checklistConfirmed: checklistComplete,
          overrideReason: checklistComplete ? undefined : normalizedOverride,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to close period.");
      toast.success("Period closed.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "periods"] });
      const ok = true;
      if (ok) {
        setCloseOpen(false);
        setChecklist(null);
        setClosePeriod(null);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to close period.");
    } finally {
      setClosing(false);
    }
  };

  const saveReminderThreshold = async () => {
    const parsed = Number(reminderDaysInput);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60) {
      toast.error("Reminder days must be between 1 and 60.");
      return;
    }
    try {
      setSavingReminder(true);
      await saveAppSetting(
        {
          key: "accounting.periodClose.reminderDays",
          value: Math.trunc(parsed),
          expectedUpdatedAt: reminderData?.updatedAt ?? null,
          audit: {
            sourcePage: "admin/accounting/periods",
            section: "period-close-reminder-days",
            operation: "save",
          },
        },
        "Failed to save reminder setting.",
      );
      toast.success("Reminder threshold saved.");
      queryClient.invalidateQueries({
        queryKey: ["app-setting", "accounting.periodClose.reminderDays"],
      });
      queryClient.invalidateQueries({
        queryKey: ["audit", "periods-reminder-setting-latest"],
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save reminder setting.");
    } finally {
      setSavingReminder(false);
    }
  };

  const parseBatchMonths = () =>
    Array.from(
      new Set(
        batchMonthsInput
          .split(/[,\s]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    );

  const addBatchMonthSelection = () => {
    const month = batchMonthPicker.trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      toast.error("Select a valid month (YYYY-MM).");
      return;
    }
    const merged = Array.from(new Set([...parseBatchMonths(), month])).sort();
    setBatchMonthsInput(merged.join(", "));
    setBatchMonthPicker("");
  };

  const openBatchConfirm = async (action: BatchAction) => {
    const months = parseBatchMonths();
    if (months.length === 0) {
      toast.error("Enter at least one month (YYYY-MM).");
      return;
    }
    if (action === "close") {
      const now = new Date();
      const earlyMonths = months.filter((month) => {
        const [yearText, monthText] = month.split("-");
        const year = Number(yearText);
        const monthIndex = Number(monthText) - 1;
        const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
        return monthEnd.getTime() > now.getTime();
      });
      if (earlyMonths.length > 0) {
        toast.error(`Batch close cannot include current/future months: ${earlyMonths.join(", ")}`);
        return;
      }
      try {
        const rows = await Promise.all(
          months.map(async (month) => {
            const res = await fetch(`/api/admin/accounting/periods/monthly-close/checklist?month=${encodeURIComponent(month)}`);
            const j = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(j?.error || "Failed to load monthly blockers.");
            return {
              month,
              draftEntries: Number(j.draftEntries || 0),
              openReconciliations: Number(j.openReconciliations || 0),
              blockers: Number(j.blockers || 0),
            } as BatchMonthBlockerRow;
          }),
        );
        setBatchCloseBlockers(rows.filter((row) => row.blockers > 0));
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Failed to load batch blockers.");
        return;
      }
    } else {
      const now = new Date();
      const expiredMonths = months.filter((month) => {
        const [yearText, monthText] = month.split("-");
        const year = Number(yearText);
        const monthIndex = Number(monthText) - 1;
        const monthEnd = new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
        const reopenDeadline = new Date(monthEnd.getTime() + monthlyReopenWindowDays * 86_400_000);
        return now.getTime() > reopenDeadline.getTime();
      });
      if (expiredMonths.length > 0) {
        toast.error(
          `Batch reopen window expired (${monthlyReopenWindowDays} day(s) after month-end) for: ${expiredMonths.join(", ")}`,
        );
        return;
      }
      setBatchCloseBlockers([]);
    }
    setBatchAction(action);
    setBatchMonthsResolved(months);
    setBatchConfirmOpen(true);
  };

  const batchMonthlyClose = async (action: BatchAction, months: string[]) => {
    try {
      setBatchBusy(true);
      const res = await fetch("/api/admin/accounting/periods/monthly-close/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          months,
          action,
          note: batchNote.trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (action === "close" && Array.isArray(j?.blockers)) {
          setBatchCloseBlockers(
            j.blockers.map((row: unknown) => {
              const r = row as Record<string, unknown>;
              return {
                month: String(r.month || ""),
                draftEntries: Number(r.draftEntries || 0),
                openReconciliations: Number(r.openReconciliations || 0),
                blockers: Number(r.blockers || 0),
              } as BatchMonthBlockerRow;
            }),
          );
        }
        throw new Error(j?.error || "Batch monthly close action failed.");
      }
      toast.success(`${action === "close" ? "Closed" : "Reopened"} ${Number(j?.affected?.length || 0)} month(s).`);
      setBatchMonthsInput("");
      setBatchNote("");
      setBatchConfirmOpen(false);
      setBatchMonthsResolved([]);
      setBatchCloseBlockers([]);
      queryClient.invalidateQueries({ queryKey: ["accounting", "periods", "monthly-close"] });
      refreshPeriodActivity();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Batch monthly close action failed.";
      toast.error(message);
    } finally {
      setBatchBusy(false);
    }
  };

  const generateMonthlyPeriods = async () => {
    const year = Number(generatorYear);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      toast.error("Enter a valid year (2000-2100).");
      return;
    }
    try {
      setGeneratorBusy(true);
      const res = await fetch("/api/admin/accounting/periods/generate-monthly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to initialize monthly operational calendar.");
      const yearText = String(j?.year || generatorYear);
      if (j?.alreadyInitialized) {
        toast.success(`Monthly operational calendar for ${yearText} is already initialized.`);
      } else {
        toast.success(`Monthly operational calendar initialized for ${yearText}.`);
      }
      queryClient.invalidateQueries({ queryKey: ["accounting", "periods", "monthly-calendar"] });
      refreshPeriodActivity();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to initialize monthly operational calendar.");
    } finally {
      setGeneratorBusy(false);
    }
  };

  const exportCloseStatusCsv = () => {
    const lines: string[] = [];
    lines.push("Section,Key,Status,Start,End,Note");
    for (const period of periods) {
      lines.push([
        "FiscalPeriod",
        period.name,
        period.status,
        new Date(period.startDate).toISOString().slice(0, 10),
        new Date(period.endDate).toISOString().slice(0, 10),
        snapshotIds.has(period.id) ? "snapshot_saved" : "",
      ].map((v) => `"${String(v ?? "").replace(/"/g, "\"\"")}"`).join(","));
    }
    for (const row of monthlyClosedRows) {
      lines.push([
        "MonthlyClose",
        row.month,
        "CLOSED",
        `${row.month}-01`,
        row.month,
        row.note || "",
      ].map((v) => `"${String(v ?? "").replace(/"/g, "\"\"")}"`).join(","));
    }
    const blob = new Blob(["\uFEFF", lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `accounting-close-status-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("Close status CSV exported.");
  };

  const setMonthlyCloseState = async (action: "close" | "open", month: string) => {
    if (action === "open" && monthlyCloseNote.trim().length < 8) {
      toast.error("Provide a reopen reason of at least 8 characters in the note field.");
      return;
    }
    try {
      setMonthlyCloseBusy(true);
      const res = await fetch("/api/admin/accounting/periods/monthly-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          action,
          note: monthlyCloseNote.trim() || undefined,
          force: action === "close" ? monthlyForceClose : undefined,
          overrideReason:
            action === "close" ? (monthlyOverrideReason.trim() || undefined) : undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update monthly close.");
      toast.success(action === "close" ? `Month ${month} closed.` : `Month ${month} reopened.`);
      setMonthlyCloseNote("");
      setMonthlyOverrideReason("");
      setMonthlyForceClose(false);
      queryClient.invalidateQueries({ queryKey: ["accounting", "periods", "monthly-close"] });
      refetchMonthlyChecklist();
      refreshPeriodActivity();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update monthly close.");
    } finally {
      setMonthlyCloseBusy(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Fiscal Periods</h1>
        <p className="text-sm text-muted-foreground">
          Manage monthly operational closes and fiscal-period statutory closes in one place.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={exportCloseStatusCsv}>
          Export close status CSV
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Period-end reminder</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Show reminder when open period end is within this many days.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              min={1}
              max={60}
              className="w-28"
              value={reminderDaysInput}
              onChange={(e) => setReminderDaysInput(e.target.value)}
            />
            <Button onClick={saveReminderThreshold} disabled={savingReminder}>
              {savingReminder ? "Saving..." : "Save reminder days"}
            </Button>
            <Button asChild variant="outline">
              <Link href="/admin/audit?scope=accounting_settings&sourcePage=admin/accounting/periods&settingSection=period-close-reminder-days&action=app-setting.update&entityId=accounting.periodClose.reminderDays">
                Open reminder audit
              </Link>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{reminderSettingAuditSummary}</p>
          {showReminder && nextOpenPeriod ? (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              Period <span className="font-medium">{nextOpenPeriod.name}</span> ends in{" "}
              <span className="font-medium">{daysToPeriodEnd}</span> day(s) on{" "}
              <span className="font-medium">{new Date(nextOpenPeriod.endDate).toLocaleDateString()}</span>.
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reopen policy</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Reopen governance is managed in Accounting Settings. This summary is read-only for operational context.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded border px-3 py-2">
              <div className="text-xs text-muted-foreground">Monthly reopen window</div>
              <div className="font-medium">{monthlyReopenWindowDays} day(s) after month-end</div>
            </div>
            <div className="rounded border px-3 py-2">
              <div className="text-xs text-muted-foreground">Fiscal reopen window</div>
              <div className="font-medium">{fiscalReopenWindowDays} day(s) after period-end</div>
            </div>
          </div>
          <div className="rounded border px-3 py-2">
            <div className="text-xs text-muted-foreground">Finalized fiscal year hard lock</div>
            <div className="font-medium">{currentEnforceFinalizedYearLock ? "Enabled" : "Disabled"}</div>
            <div className="text-xs text-muted-foreground">
              Finalized years: {currentFinalizedFiscalYears.length > 0 ? currentFinalizedFiscalYears.join(", ") : "none"}
            </div>
          </div>
          <div>
            <Button asChild variant="outline">
              <Link href="/admin/accounting/settings#reopen-policy">Manage in Settings</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Monthly close control</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Close a month to block accounting postings in that month while keeping annual fiscal periods for statutory close.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs text-muted-foreground">
              <span>Month (YYYY-MM)</span>
              <Input
                type="month"
                value={monthlyCloseMonth}
                onChange={(e) => setMonthlyCloseMonth(e.target.value)}
                className="w-36"
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground min-w-[280px]">
              <span>Note (optional)</span>
              <Input
                placeholder="Reason for monthly close"
                value={monthlyCloseNote}
                onChange={(e) => setMonthlyCloseNote(e.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground min-w-[280px]">
              <span>Override reason (required if force close with blockers)</span>
              <Input
                placeholder="Override reason"
                value={monthlyOverrideReason}
                onChange={(e) => setMonthlyOverrideReason(e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 rounded border px-2 py-1 text-xs">
              <input
                type="checkbox"
                checked={monthlyForceClose}
                onChange={(e) => setMonthlyForceClose(e.target.checked)}
              />
              Force close with blockers
            </label>
            <Button onClick={() => setMonthlyCloseState("close", monthlyCloseMonth)} disabled={monthlyCloseBusy}>
              Close month
            </Button>
            <Button variant="outline" onClick={() => setMonthlyCloseState("open", monthlyCloseMonth)} disabled={monthlyCloseBusy}>
              Reopen month
            </Button>
          </div>
          <div className="rounded border bg-muted/20 px-3 py-2 text-xs">
            <div className="font-medium mb-1">Impact preview ({monthlyChecklistData?.month || monthlyCloseMonth})</div>
            <div>Draft journals: {Number(monthlyChecklistData?.draftEntries || 0)}</div>
            <div>Open reconciliations: {Number(monthlyChecklistData?.openReconciliations || 0)}</div>
            <div>Total blockers: {Number(monthlyChecklistData?.blockers || 0)}</div>
            <div>Current monthly status: {monthlyChecklistData?.isClosed ? "Closed" : "Open"}</div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2">
            <div className="text-sm">
              <span className="font-medium">Monthly details</span>{" "}
              <span className="text-muted-foreground">({monthlyClosedRows.length} month(s) currently closed)</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => setShowMonthlyDetails((prev) => !prev)}>
              {showMonthlyDetails ? "Hide details" : "Show details"}
            </Button>
          </div>
          {showMonthlyDetails ? (
            <>
              <div className="rounded border p-3 space-y-2">
                <div className="font-medium text-sm">Monthly close actions</div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="month"
                    className="w-44"
                    value={batchMonthPicker}
                    onChange={(e) => setBatchMonthPicker(e.target.value)}
                  />
                  <Button size="sm" variant="outline" onClick={addBatchMonthSelection}>
                    Add month
                  </Button>
                </div>
                <Input
                  placeholder="Months list (YYYY-MM), comma or space separated"
                  value={batchMonthsInput}
                  onChange={(e) => setBatchMonthsInput(e.target.value)}
                />
                <Input
                  placeholder="Batch note/reopen reason"
                  value={batchNote}
                  onChange={(e) => setBatchNote(e.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => openBatchConfirm("close")} disabled={batchBusy}>
                    Batch close
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openBatchConfirm("open")} disabled={batchBusy}>
                    Batch reopen
                  </Button>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                {monthlyClosedRows.length === 0 ? (
                  <p className="text-muted-foreground">No closed months configured.</p>
                ) : (
                  monthlyClosedRows.map((row) => {
                    const range = monthRange(row.month);
                    const start = range?.start || `${row.month}-01`;
                    const end = range?.end || `${row.month}-31`;
                    return (
                      <div key={row.month} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2">
                      <div>
                        <div className="font-medium">{row.month} <span className="rounded bg-rose-100 px-2 py-0.5 text-[10px] text-rose-700">Closed</span></div>
                        <div className="text-xs text-muted-foreground">
                          Closed at {new Date(row.closedAt).toLocaleString()}
                          {row.closedByName ? ` by ${row.closedByName}` : ""}
                          {row.note ? ` - ${row.note}` : ""}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <a className="text-xs underline" href={`/admin/accounting/journal?start=${start}&end=${end}`}>
                          Journal
                        </a>
                        <a className="text-xs underline" href={`/admin/accounting/reconcile?start=${start}&end=${end}`}>
                          Reconcile
                        </a>
                        <Button size="sm" variant="ghost" onClick={() => setMonthlyCloseState("open", row.month)} disabled={monthlyCloseBusy}>
                          Reopen
                        </Button>
                      </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pre-close checklist</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            This checklist is enforced when you click <span className="font-medium">Close period</span>.
          </p>
          <ul className="list-disc pl-5 space-y-1">
            {CLOSE_CHECKLIST_ITEMS.map((item) => (
              <li key={item.key} className="flex flex-wrap items-center gap-2">
                <span>{item.label}</span>
                <Link className="text-xs underline" href={item.href}>
                  {item.linkLabel}
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Readiness progress and blocker status are shown in the close dialog for the selected period.
          </p>
          <p className="text-xs text-muted-foreground">
            If any item is not complete, use override and provide reason in the close dialog.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create period</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Input placeholder="Period name (e.g. Jan 2025)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          <div className="sm:col-span-2 lg:col-span-3">
            <Button className="w-full sm:w-auto" onClick={createPeriod} disabled={saving}>
              {saving ? "Saving..." : "Create period"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Monthly operational calendar</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            Initialize monthly operational months for a year without creating overlapping fiscal-period rows.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-32"
              placeholder="Year"
              value={generatorYear}
              onChange={(e) => setGeneratorYear(e.target.value)}
            />
            <Button onClick={generateMonthlyPeriods} disabled={generatorBusy}>
              {generatorBusy ? "Initializing..." : "Initialize operational calendar"}
            </Button>
          </div>
          <div className="rounded border bg-muted/20 p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">Calendar view ({generatorYear})</span>
              <span className="text-xs text-muted-foreground">
                {selectedYearInitRow
                  ? `Initialized ${new Date(selectedYearInitRow.initializedAt).toLocaleString()}${selectedYearInitRow.initializedByName ? ` by ${selectedYearInitRow.initializedByName}` : ""}`
                  : "Not initialized yet"}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {calendarMonthRows.map((row) => (
                <div key={row.monthKey} className="rounded border px-2 py-1.5">
                  <div className="font-medium">{row.label}</div>
                  <div className="text-xs text-muted-foreground">{row.monthKey}</div>
                  <div className="mt-1">
                    {row.isClosed ? (
                      <span className="rounded bg-rose-100 px-2 py-0.5 text-[10px] text-rose-700">Closed</span>
                    ) : (
                      <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-700">Open</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span>History</span>
            <Tooltip
              content={
                <span>
                  PASS = all system controls passed. PASS WITH WARNINGS = close allowed but review exceptions.
                  BLOCKED = close should not proceed until blockers are resolved.
                </span>
              }
            >
              <span className="cursor-help rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">Status legend</span>
            </Tooltip>
            <Button
              size="sm"
              variant={showBlockedOnly ? "default" : "outline"}
              onClick={() => setShowBlockedOnly((prev) => !prev)}
            >
              {showBlockedOnly ? "Showing blockers only" : "View blockers only"}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          {historyPeriods.length === 0 ? (
            <p className="text-muted-foreground">
              {showBlockedOnly ? "No blocked open periods." : "No fiscal periods yet."}
            </p>
          ) : (
            historyPeriods.map((period) => {
              const readiness = readinessByPeriodId.get(period.id);
              return (
              <div key={period.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2">
                <div>
                  <div className="font-medium">
                    {period.name}{" "}
                    {period.status === "OPEN" ? (
                      <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-700">Open</span>
                    ) : (
                      <span className="rounded bg-rose-100 px-2 py-0.5 text-[10px] text-rose-700">Closed</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(period.startDate).toLocaleDateString()} - {new Date(period.endDate).toLocaleDateString()}
                  </div>
                  {period.status === "OPEN" && readiness ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <span
                        className={
                          readiness.status === "READY"
                            ? "rounded bg-emerald-100 px-2 py-0.5 text-emerald-700"
                            : readiness.status === "BLOCKED"
                              ? "rounded bg-rose-100 px-2 py-0.5 text-rose-700"
                              : "rounded bg-amber-100 px-2 py-0.5 text-amber-700"
                        }
                      >
                        System Controls: {readiness.status === "READY" ? "PASS" : readiness.status === "ATTENTION" ? "PASS WITH WARNINGS" : "BLOCKED"}
                      </span>
                      <span className="text-muted-foreground">
                        System controls: {readiness.readyCount}/{readiness.totalChecks}
                      </span>
                      <span className="text-muted-foreground">
                        Checklist + approvals still required before close.
                      </span>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => openCloseDialog(period)}>
                        Open close checklist
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  <span className="text-xs">{period.status}</span>
                  {snapshotIds.has(period.id) ? (
                    <span className="text-[11px] rounded bg-emerald-100 px-2 py-1 text-emerald-700">
                      Snapshot saved
                    </span>
                  ) : null}
                  {period.status === "OPEN" ? (
                    <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => openCloseDialog(period)}>
                      Close period
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" className="w-full sm:w-auto" onClick={() => openReopenDialog(period)}>
                      Reopen
                    </Button>
                  )}
                  <a
                    className="text-xs underline"
                    href={`/admin/accounting/journal?start=${new Date(period.startDate).toISOString().slice(0, 10)}&end=${new Date(period.endDate).toISOString().slice(0, 10)}`}
                  >
                    Journal
                  </a>
                  <a
                    className="text-xs underline"
                    href={`/admin/accounting/reconcile?start=${new Date(period.startDate).toISOString().slice(0, 10)}&end=${new Date(period.endDate).toISOString().slice(0, 10)}`}
                  >
                    Reconcile
                  </a>
                  <a
                    className="text-xs underline"
                    href={`/admin/accounting/integrity?asOf=${new Date(period.endDate).toISOString().slice(0, 10)}`}
                  >
                    Integrity
                  </a>
                  <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
                    <a href={`/admin/accounting/periods/${period.id}/snapshot`}>Close report</a>
                  </Button>
                </div>
              </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Close activity timeline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <span>Showing recent close/reopen activity (default last {DEFAULT_ACTIVITY_DAYS_BACK} days).</span>
              {activeActivityFilterCount > 0 ? (
                <span className="rounded bg-blue-100 px-2 py-0.5 text-blue-800">
                  {activeActivityFilterCount} filter(s) active
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => void refreshPeriodActivity()} disabled={periodActivityLoading}>
                {periodActivityLoading ? "Refreshing..." : "Refresh"}
              </Button>
              <Button asChild type="button" size="sm" variant="outline">
                <Link href="/admin/audit?scope=accounting_periods&sourcePage=admin/accounting/periods">Open audit page</Link>
              </Button>
            </div>
          </div>
          {activityFilterEchoText ? (
            <p className="text-xs text-muted-foreground">Server-applied filters: {activityFilterEchoText}</p>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={activityActionFilter}
              onChange={(e) => setActivityActionFilter(e.target.value)}
            >
              <option value="">All actions</option>
              {activityActions.map((action) => (
                <option key={action} value={action}>
                  {formatActivityActionLabel(action)}
                </option>
              ))}
            </select>
            <Input
              placeholder="Filter actor name/email"
              value={activityActorFilter}
              onChange={(e) => setActivityActorFilter(e.target.value)}
            />
            <Input type="date" value={activityFromDate} onChange={(e) => setActivityFromDate(e.target.value)} />
            <Input type="date" value={activityToDate} onChange={(e) => setActivityToDate(e.target.value)} />
            <Button
              variant="outline"
              onClick={() => {
                setActivityActionFilter("");
                setActivityActorFilter("");
                setActivityFromDate(new Date(Date.now() - DEFAULT_ACTIVITY_DAYS_BACK * 86_400_000).toISOString().slice(0, 10));
                setActivityToDate("");
              }}
            >
              Clear filters
            </Button>
          </div>
          {periodActivityLoading ? <p className="text-muted-foreground">Loading timeline…</p> : null}
          {activityRows.length > 0 ? (
            <>
              {activityRows.map((row) => (
                <div key={row.id} className="rounded border px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">{formatActivityActionLabel(row.action)}</div>
                    <div className="text-xs text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {row.entityType} - {row.entityId} - {row.actor?.name || row.actor?.email || "System"}
                  </div>
                  {row.meta ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {summarizeActivityMeta(row.action, row.meta)}
                    </div>
                  ) : null}
                </div>
              ))}
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  Showing {activityRows.length} row(s){periodActivityHasMore ? " (more available)" : ""}.
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void loadMorePeriodActivity()}
                  disabled={!periodActivityHasMore || periodActivityLoadingMore}
                >
                  {periodActivityLoadingMore ? "Loading..." : periodActivityHasMore ? "Load more" : "No more rows"}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">No close activity for current filters.</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Close period</DialogTitle>
          </DialogHeader>
          <div className="text-sm space-y-2">
            <p className="text-muted-foreground">
              Review this checklist before closing {closePeriod?.name || "the period"}.
            </p>
            {closePeriodIsEarly ? (
              <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                Early close detected: this period has not ended yet. Admin override with reason (min 20 characters) is required.
              </p>
            ) : null}
            <div className="rounded border p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase text-muted-foreground">System controls</span>
                <span className="text-xs">
                  {systemControlReadyCount}/{systemControlRows.length || 0} ready
                </span>
              </div>
              <div className="h-2 w-full rounded bg-muted">
                <div
                  className="h-2 rounded bg-emerald-600"
                  style={{
                    width:
                      systemControlRows.length > 0
                        ? `${Math.round((systemControlReadyCount / systemControlRows.length) * 100)}%`
                        : "0%",
                  }}
                />
              </div>
              {systemControlBlockedCount > 0 ? (
                <p className="text-xs text-rose-700">
                  {systemControlBlockedCount} blocker{systemControlBlockedCount === 1 ? "" : "s"} detected.
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Manual checklist completion is tracked separately below.
              </p>
              <div className="space-y-2">
                {readinessRows.map((row) => {
                  const badgeClass =
                    row.status === "ready"
                      ? "bg-emerald-100 text-emerald-700"
                      : row.status === "blocked"
                        ? "bg-rose-100 text-rose-700"
                        : "bg-amber-100 text-amber-700";
                  const badgeText = row.status === "ready" ? "Ready" : row.status === "blocked" ? "Blocked" : "Attention";
                  return (
                    <div key={row.key} className="rounded border px-2 py-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>{row.label}</span>
                        <span className="font-medium">{row.value}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                        <span className={`rounded px-2 py-0.5 text-[10px] ${badgeClass}`}>{badgeText}</span>
                        <Link className="text-xs underline" href={row.href}>
                          {row.actionLabel}
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="border rounded p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase text-muted-foreground">Required checklist</p>
                <span className="text-xs text-muted-foreground">
                  Checklist completion: {checklistCompletedCount}/{CLOSE_CHECKLIST_ITEMS.length}
                </span>
              </div>
              {CLOSE_CHECKLIST_ITEMS.map((item) => (
                <label key={item.key} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={checklistState[item.key]}
                    onChange={(e) =>
                      setChecklistState((prev) => ({
                        ...prev,
                        [item.key]: e.target.checked,
                      }))
                    }
                  />
                  <span>
                    {item.label}{" "}
                    <Link className="text-xs underline" href={item.href}>
                      {item.linkLabel}
                    </Link>
                  </span>
                </label>
              ))}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={allowOverride}
                  onChange={(e) => setAllowOverride(e.target.checked)}
                />
                <span>Allow override (admin/accountant must provide reason).</span>
              </label>
              {allowOverride ? (
                <Input
                  placeholder="Override reason (required if checklist not complete)"
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
              ) : null}
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setCloseOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleClose}
              disabled={closePeriodButtonDisabled}
            >
              {closing ? "Closing..." : "Close period"}
            </Button>
          </DialogFooter>
          {closePeriodButtonDisabled ? (
            <p className="text-xs text-amber-700">{closePeriodDisableReason}</p>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={reopenOpen} onOpenChange={setReopenOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reopen period</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Reopening period {reopenPeriod?.name || ""} requires an auditable reason.
            </p>
            <Input
              placeholder="Reason (min 8 characters)"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleReopen} disabled={reopenReason.trim().length < 8}>
              Reopen period
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={batchConfirmOpen} onOpenChange={setBatchConfirmOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{batchAction === "close" ? "Confirm batch close" : "Confirm batch reopen"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              This will {batchAction} {batchMonthsResolved.length} month(s).
            </p>
            <div className="max-h-48 overflow-auto rounded border p-2 text-xs">
              {batchMonthsResolved.map((month) => (
                <div key={month}>{month}</div>
              ))}
            </div>
            {batchAction === "close" && batchCloseBlockers.length > 0 ? (
              <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800 space-y-1">
                <p className="font-medium">
                  Batch close blocked for {batchCloseBlockers.length} month(s) with blockers.
                </p>
                <div className="max-h-24 overflow-auto">
                  {batchCloseBlockers.map((row) => (
                    <div key={row.month}>
                      {row.month}: {row.draftEntries} draft journal(s), {row.openReconciliations} open reconciliation(s)
                    </div>
                  ))}
                </div>
                <p>Resolve blockers first, or close month-by-month using force close with override reason.</p>
              </div>
            ) : null}
            {batchAction === "open" ? (
              <p className="text-xs text-amber-700">Batch reopen requires a reason (at least 8 chars).</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBatchConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => batchMonthlyClose(batchAction, batchMonthsResolved)}
              disabled={
                batchBusy ||
                (batchAction === "open" && batchNote.trim().length < 8) ||
                (batchAction === "close" && batchCloseBlockers.length > 0)
              }
            >
              {batchBusy ? "Running..." : batchAction === "close" ? "Confirm close" : "Confirm reopen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
