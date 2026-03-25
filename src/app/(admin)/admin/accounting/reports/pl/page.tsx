"use client";

import { type MouseEvent as ReactMouseEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useClientQuery } from "@/hooks/use-client-query";
import { useUnsavedChangesGuard } from "@/hooks/use-unsaved-changes-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";
import { formatSignedCurrency, formatSignedPercent } from "@/lib/accounting-report-format";
import { AppSettingSnapshot, fetchAppSetting, fetchJsonOrThrow, saveAppSetting } from "@/lib/app-settings-client";
import { toast } from "sonner";

type AccountRow = {
  accountId: string;
  code: string;
  name: string;
  debit: number;
  credit: number;
};

type PLResponse = {
  range?: { start: string | null; end: string | null };
  income: AccountRow[];
  expenses: AccountRow[];
  incomeTotal: number;
  expenseTotal: number;
  netProfit: number;
};

type ExportJobResponse = {
  jobId: string;
  status: "QUEUED" | "READY" | "FAILED";
  downloadUrl: string;
  expiresAt: number;
  failReason?: string | null;
};

type ExportJobListItem = {
  id: string;
  type: "pl_csv" | "reporting_pack_csv";
  status: "QUEUED" | "READY" | "FAILED";
  downloadUrl: string;
  failReason?: string | null;
  rangeSummary?: string | null;
  start?: string | null;
  end?: string | null;
  requestedBy?: string | null;
  createdAt: number;
  expiresAt: number;
};

type ExportJobsStats = {
  lastSuccessfulAt: number | null;
  topRangeSummary: string | null;
  topRangeCount: number;
  jobsInLast30Days: number;
};

type FiscalPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
};

const DEFAULT_VARIANCE_THRESHOLD_PCT = 10;

function toDateLabel(date: Date) {
  return date.toISOString().slice(0, 10);
}

function parseDateInput(value: string) {
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseIsoDateParts(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() + 1 !== month || utc.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function getPreviousRange(start: string, end: string) {
  const startParts = parseIsoDateParts(start);
  const endParts = parseIsoDateParts(end);
  if (!startParts || !endParts) return null;

  const startUtcMs = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
  const endUtcMs = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
  if (endUtcMs < startUtcMs) return null;

  const isMonthToDateStyle =
    startParts.day === 1 && startParts.year === endParts.year && startParts.month === endParts.month;
  if (isMonthToDateStyle) {
    const previousMonth = startParts.month === 1 ? 12 : startParts.month - 1;
    const previousYear = startParts.month === 1 ? startParts.year - 1 : startParts.year;
    const previousMonthLastDay = new Date(Date.UTC(previousYear, previousMonth, 0)).getUTCDate();
    const previousEndDay = Math.min(endParts.day, previousMonthLastDay);
    return {
      start: `${previousYear}-${pad2(previousMonth)}-01`,
      end: `${previousYear}-${pad2(previousMonth)}-${pad2(previousEndDay)}`,
    };
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const spanDays = Math.floor((endUtcMs - startUtcMs) / dayMs) + 1;
  const prevEnd = new Date(startUtcMs - dayMs);
  const prevStart = new Date(prevEnd.getTime() - (spanDays - 1) * dayMs);
  return { start: toDateLabel(prevStart), end: toDateLabel(prevEnd) };
}

function percentChange(current: number, prior: number) {
  if (Math.abs(prior) < 0.0001) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

function getYtdRange(end: string) {
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(endDate.getTime())) return null;
  return { start: `${endDate.getFullYear()}-01-01`, end };
}

function getPriorYtdRange(end: string) {
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(endDate.getTime())) return null;
  const priorEnd = new Date(endDate);
  priorEnd.setFullYear(priorEnd.getFullYear() - 1);
  return { start: `${priorEnd.getFullYear()}-01-01`, end: toDateLabel(priorEnd) };
}

function parseThreshold(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_VARIANCE_THRESHOLD_PCT;
  return n;
}

function getExportJobStatusPresentation(status: "QUEUED" | "READY" | "FAILED") {
  if (status === "READY") {
    return { label: "Ready", className: "bg-emerald-100 text-emerald-800 border-emerald-200" };
  }
  if (status === "FAILED") {
    return { label: "Failed", className: "bg-amber-100 text-amber-800 border-amber-200" };
  }
  return { label: "Queued", className: "bg-slate-100 text-slate-700 border-slate-200" };
}

type FiltersCardProps = {
  start: string;
  end: string;
  useYtd: boolean;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onYtdChange: (checked: boolean) => void;
  onPresetToday: () => void;
  onPresetMonthToDate: () => void;
  onPresetYtd: () => void;
  onPresetOpenPeriod: () => void;
  openPeriodDisabled: boolean;
  exportDisabled: boolean;
  exportQuery: string;
  onExportClick: (event: ReactMouseEvent<HTMLAnchorElement>, label: string) => void;
  onCopyReportLink: () => void;
  copyLinkDisabled: boolean;
  showNoRowsHint: boolean;
  thresholdInput: string;
  onThresholdInputChange: (value: string) => void;
  onSaveThreshold: () => void;
  savingThreshold: boolean;
  thresholdEditable: boolean;
  thresholdErrorText: string | null;
  thresholdAuditMessage: string | null;
  thresholdAuditLink: string | null;
  startInputRef: RefObject<HTMLInputElement | null>;
  endInputRef: RefObject<HTMLInputElement | null>;
  startLockedByYtd: boolean;
};

function FiltersCard(props: FiltersCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Filters</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Report start date"
            className="w-full sm:w-auto"
            type="date"
            ref={props.startInputRef}
            max={props.end || undefined}
            disabled={props.startLockedByYtd}
            value={props.start}
            onChange={(e) => props.onStartChange(e.target.value)}
          />
          <Input
            aria-label="Report end date"
            className="w-full sm:w-auto"
            type="date"
            ref={props.endInputRef}
            min={props.start || undefined}
            value={props.end}
            onChange={(e) => props.onEndChange(e.target.value)}
          />
          <label className="inline-flex items-center gap-2 text-sm">
            <input aria-label="Year to date toggle" type="checkbox" checked={props.useYtd} onChange={(e) => props.onYtdChange(e.target.checked)} />
            YTD
          </label>
        </div>
        {props.startLockedByYtd ? <p className="text-xs text-muted-foreground">YTD mode locks start date to January 1 of the selected end year.</p> : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={props.onPresetToday}>
            Today
          </Button>
          <Button size="sm" variant="outline" onClick={props.onPresetMonthToDate}>
            Month to date
          </Button>
          <Button size="sm" variant="outline" onClick={props.onPresetYtd}>
            Year to date
          </Button>
          <Button size="sm" variant="outline" onClick={props.onPresetOpenPeriod} disabled={props.openPeriodDisabled}>
            Open period (default)
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto" disabled={props.exportDisabled}>
            <a href={`/api/admin/accounting/reports/pl/export?${props.exportQuery}`} onClick={(event) => props.onExportClick(event, "P&L CSV")}>
              Export CSV
            </a>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto" disabled={props.exportDisabled}>
            <a href={`/api/admin/accounting/reports/pack/export?${props.exportQuery}`} onClick={(event) => props.onExportClick(event, "reporting pack")}>
              Export reporting pack
            </a>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <Link href="/admin/accounting/periods">Open Fiscal Periods</Link>
          </Button>
          <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={props.onCopyReportLink} disabled={props.copyLinkDisabled}>
            Copy report link
          </Button>
        </div>
        {props.showNoRowsHint ? (
          <p className="text-xs text-amber-700">No report rows found for this range. Export is disabled until the range has data.</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="pl-variance-threshold" className="text-muted-foreground">
            Variance alert threshold (%)
          </label>
          <Input
            id="pl-variance-threshold"
            className="w-28"
            inputMode="decimal"
            value={props.thresholdInput}
            onChange={(e) => props.onThresholdInputChange(e.target.value)}
            disabled={!props.thresholdEditable}
            aria-label="Variance alert threshold percent"
          />
          <Button size="sm" variant="outline" onClick={props.onSaveThreshold} disabled={props.savingThreshold || !props.thresholdEditable}>
            {props.savingThreshold ? "Saving..." : "Save threshold"}
          </Button>
          {!props.thresholdEditable ? <span className="text-xs text-muted-foreground">Only admins can edit threshold.</span> : null}
          {props.thresholdErrorText ? <span className="text-xs text-amber-700">{props.thresholdErrorText}</span> : null}
          {props.thresholdAuditMessage ? (
            <span className="text-xs text-emerald-700">
              {props.thresholdAuditMessage}{" "}
              {props.thresholdAuditLink ? (
                <Link className="underline underline-offset-2" href={props.thresholdAuditLink}>
                  View audit log
                </Link>
              ) : null}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

type VarianceNoteCardProps = {
  profitChange: number | null;
  varianceThreshold: number;
  notesErrorText: string | null;
  noteConflictMessage: string | null;
  varianceNote: string;
  onVarianceNoteChange: (value: string) => void;
  onReloadLatest: () => void;
  onSave: () => void;
  savingNote: boolean;
  hasUnsavedVarianceNote: boolean;
  noteSaveDisabled: boolean;
  noteLengthHint: string | null;
  noteAuditMessage: string | null;
  noteAuditLink: string | null;
};

function VarianceNoteCard(props: VarianceNoteCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Variance note</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {props.profitChange === null ? (
          <p className="text-xs text-muted-foreground">
            Percent change is not available because the prior comparison period is zero or missing. Add a note for audit context.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Net profit moved by {props.profitChange.toFixed(2)}% versus prior comparison period. Threshold: {props.varianceThreshold}%.
          </p>
        )}
        {props.notesErrorText ? <p className="text-xs text-amber-700">{props.notesErrorText}</p> : null}
        {props.noteConflictMessage ? (
          <p className="text-xs text-amber-700">
            {props.noteConflictMessage}{" "}
            <button type="button" className="underline underline-offset-2" onClick={props.onReloadLatest}>
              Reload latest note
            </button>
          </p>
        ) : null}
        <textarea
          className="w-full min-h-[84px] rounded-md border bg-background p-2 text-sm"
          value={props.varianceNote}
          onChange={(e) => props.onVarianceNoteChange(e.target.value)}
          placeholder="Explain major movement (price, volume, one-off expense, etc.)"
          aria-label="Variance explanation note"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={props.onSave} disabled={props.savingNote || props.noteSaveDisabled}>
            {props.savingNote ? "Saving..." : "Save note"}
          </Button>
          {props.hasUnsavedVarianceNote ? <span className="text-xs text-amber-700">You have unsaved note changes.</span> : null}
          {props.noteLengthHint ? <span className="text-xs text-amber-700">{props.noteLengthHint}</span> : null}
          {props.noteAuditMessage ? (
            <span className="text-xs text-emerald-700">
              {props.noteAuditMessage}{" "}
              {props.noteAuditLink ? (
                <Link className="underline underline-offset-2" href={props.noteAuditLink}>
                  View audit log
                </Link>
              ) : null}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

type ComparisonCardProps = {
  currentProfit: number;
  priorProfit: number;
  profitDelta: number;
  profitChange: number | null;
  comparisonQuality: string;
  comparisonHint: string | null;
  comparisonRangeLabel: string;
};

function ComparisonCard(props: ComparisonCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Comparison</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">Comparison quality: {props.comparisonQuality}</p>
        <p className="text-xs text-muted-foreground">{props.comparisonRangeLabel}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Current net profit</div>
            <div className="font-semibold">{formatCurrency(props.currentProfit)}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Prior net profit</div>
            <div className="font-semibold">{formatCurrency(props.priorProfit)}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Delta</div>
            <div className="font-semibold">
              {formatSignedCurrency(props.profitDelta)}
            </div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">% change</div>
            <div className="font-semibold">
              {props.profitChange === null
                ? "Not available (prior period is zero)"
                : formatSignedPercent(props.profitChange)}
            </div>
          </div>
        </div>
        {props.comparisonHint ? <p className="text-xs text-amber-700">{props.comparisonHint}</p> : null}
      </CardContent>
    </Card>
  );
}

export default function ProfitLossReportPage() {
  const { data: session } = useSession();
  const isAdmin = String((session?.user as { role?: string } | undefined)?.role || "") === "ADMIN";
  const isProduction = process.env.NODE_ENV === "production";
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [useYtd, setUseYtd] = useState(false);
  const [varianceNote, setVarianceNote] = useState("");
  const [noteDirty, setNoteDirty] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [noteConflictMessage, setNoteConflictMessage] = useState<string | null>(null);
  const [noteAuditMessage, setNoteAuditMessage] = useState<string | null>(null);
  const [thresholdInput, setThresholdInput] = useState(String(DEFAULT_VARIANCE_THRESHOLD_PCT));
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [thresholdAuditMessage, setThresholdAuditMessage] = useState<string | null>(null);
  const [exportJobMessage, setExportJobMessage] = useState<string | null>(null);
  const [exportJobLoading, setExportJobLoading] = useState(false);
  const [currentExportJobId, setCurrentExportJobId] = useState<string | null>(null);
  const [selectedHistoryJobId, setSelectedHistoryJobId] = useState<string | null>(null);
  const [playwrightHelperLoading, setPlaywrightHelperLoading] = useState(false);
  const [playwrightCommand, setPlaywrightCommand] = useState<string | null>(null);
  const [playwrightHelperMessage, setPlaywrightHelperMessage] = useState<string | null>(null);
  const hasUserEdited = useRef(false);
  const lastHydratedNoteKey = useRef("");
  const dateInputStateRef = useRef({ start: "", end: "" });
  const lastValidDateRangeRef = useRef({ start: "", end: "" });
  const lastEditedDateFieldRef = useRef<"start" | "end" | null>(null);
  const startDateInputRef = useRef<HTMLInputElement | null>(null);
  const endDateInputRef = useRef<HTMLInputElement | null>(null);

  const {
    data: periodsData,
    error: periodsError,
  } = useClientQuery<FiscalPeriod[]>({
    queryKey: ["accounting", "periods"],
    queryFn: async () => {
      const res = await fetch("/api/admin/accounting/periods");
      return fetchJsonOrThrow<FiscalPeriod[]>(res, "Failed to load fiscal periods.");
    },
  });
  const periods = useMemo(() => (Array.isArray(periodsData) ? periodsData : []), [periodsData]);

  const {
    data: notesData,
    error: notesError,
    refetch: refetchNotes,
  } = useClientQuery<AppSettingSnapshot<Record<string, string>>>({
    queryKey: ["app-setting", "accounting.reports.pl.varianceNotes"],
    queryFn: () => fetchAppSetting<Record<string, string>>("accounting.reports.pl.varianceNotes"),
  });

  const {
    data: thresholdData,
    error: thresholdError,
    refetch: refetchThreshold,
  } = useClientQuery<AppSettingSnapshot<number | string>>({
    queryKey: ["app-setting", "accounting.reports.pl.varianceThresholdPct"],
    queryFn: () => fetchAppSetting<number | string>("accounting.reports.pl.varianceThresholdPct"),
  });

  const currentOpenPeriod = useMemo(() => {
    const today = new Date();
    return periods.find((period) => {
      if (period.status !== "OPEN") return false;
      const startDate = new Date(period.startDate);
      const endDate = new Date(period.endDate);
      return today >= startDate && today <= endDate;
    });
  }, [periods]);

  useEffect(() => {
    if (hasUserEdited.current) return;
    if (!currentOpenPeriod) return;
    setUseYtd(false);
    setStart(currentOpenPeriod.startDate.slice(0, 10));
    setEnd(currentOpenPeriod.endDate.slice(0, 10));
  }, [currentOpenPeriod]);

  useEffect(() => {
    dateInputStateRef.current = { start, end };
  }, [start, end]);

  useEffect(() => {
    if (!useYtd) return;
    const normalizedEnd = end || toDateLabel(new Date());
    const ytdRange = getYtdRange(normalizedEnd);
    if (!ytdRange) return;
    if (!end) setEnd(ytdRange.end);
    if (start !== ytdRange.start) {
      setStart(ytdRange.start);
    }
  }, [useYtd, end, start]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const isSharedRangeLink = (params.get("share") || "").trim() === "1";
    const startFromUrl = (params.get("start") || "").trim();
    const endFromUrl = (params.get("end") || "").trim();
    const rangeMode = (params.get("rangeMode") || "").trim().toLowerCase();
    const hasRangeParams = Boolean(startFromUrl || endFromUrl || rangeMode);
    if (!isSharedRangeLink) {
      if (hasRangeParams) {
        window.history.replaceState(null, "", "/admin/accounting/reports/pl");
      }
      return;
    }
    const ytdFromUrl = rangeMode === "ytd";
    if (!startFromUrl && !endFromUrl && !ytdFromUrl) return;
    hasUserEdited.current = true;
    if (startFromUrl) setStart(startFromUrl);
    if (endFromUrl) setEnd(endFromUrl);
    setUseYtd(ytdFromUrl);
  }, []);

  const effectiveRange = useMemo(() => {
    if (!useYtd) return { start, end };
    const fallbackEnd = end || toDateLabel(new Date());
    return getYtdRange(fallbackEnd) || { start, end };
  }, [useYtd, start, end]);

  const dateValidationError = useMemo(() => {
    if (!effectiveRange.start || !effectiveRange.end) return null;
    const startDate = parseDateInput(effectiveRange.start);
    const endDate = parseDateInput(effectiveRange.end);
    if (!startDate || !endDate) {
      return "Date range is invalid. Use valid dates in YYYY-MM-DD format.";
    }
    if (endDate.getTime() < startDate.getTime()) {
      return "End date cannot be earlier than start date.";
    }
    return null;
  }, [effectiveRange.end, effectiveRange.start]);

  const noteKey = `${effectiveRange.start || ""}|${effectiveRange.end || ""}`;

  const {
    data,
    isLoading,
    error: reportError,
    refetch: refetchReport,
    dataUpdatedAt,
  } = useClientQuery<PLResponse>({
    queryKey: ["accounting", "reports", "pl", { start: effectiveRange.start, end: effectiveRange.end, useYtd }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (effectiveRange.start) params.set("start", effectiveRange.start);
      if (effectiveRange.end) params.set("end", effectiveRange.end);
      const res = await fetch(`/api/admin/accounting/reports/pl?${params.toString()}`);
      return fetchJsonOrThrow<PLResponse>(res, "Failed to load P&L report.");
    },
    enabled: !dateValidationError,
  });

  const previousRange = useMemo(() => {
    if (useYtd) {
      if (!effectiveRange.end) return null;
      return getPriorYtdRange(effectiveRange.end);
    }
    if (!effectiveRange.start || !effectiveRange.end) return null;
    return getPreviousRange(effectiveRange.start, effectiveRange.end);
  }, [effectiveRange.start, effectiveRange.end, useYtd]);

  const {
    data: previousData,
    isLoading: isLoadingPrevious,
    error: previousError,
  } = useClientQuery<PLResponse>({
    queryKey: ["accounting", "reports", "pl", "previous", previousRange?.start || "", previousRange?.end || ""],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (previousRange?.start) params.set("start", previousRange.start);
      if (previousRange?.end) params.set("end", previousRange.end);
      const res = await fetch(`/api/admin/accounting/reports/pl?${params.toString()}`);
      return fetchJsonOrThrow<PLResponse>(res, "Failed to load comparison period.");
    },
    enabled: Boolean(previousRange?.start && previousRange?.end && !dateValidationError),
  });

  const varianceThreshold = useMemo(() => parseThreshold(thresholdData?.value), [thresholdData?.value]);

  useEffect(() => {
    if (thresholdData?.value === null || thresholdData?.value === undefined) return;
    setThresholdInput(String(parseThreshold(thresholdData.value)));
  }, [thresholdData?.value]);

  const notesMap = useMemo(() => {
    const value = notesData?.value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, string>;
    }
    return {};
  }, [notesData?.value]);

  const storedNote = notesMap[noteKey] || "";

  useEffect(() => {
    const shouldHydrate = lastHydratedNoteKey.current !== noteKey || !noteDirty;
    if (!shouldHydrate) return;
    setVarianceNote(storedNote);
    setNoteDirty(false);
    lastHydratedNoteKey.current = noteKey;
  }, [noteKey, noteDirty, storedNote]);

  const hasUnsavedVarianceNote = noteDirty && varianceNote.trim() !== storedNote.trim();
  const trimmedVarianceNote = varianceNote.trim();
  const minimumVarianceNoteLength = 8;
  const varianceNoteLengthValid = trimmedVarianceNote.length >= minimumVarianceNoteLength;
  useUnsavedChangesGuard({
    enabled: hasUnsavedVarianceNote,
    message: "You have unsaved variance note changes. Leave this page and lose the unsaved changes?",
  });

  const isClosedRange = useMemo(() => {
    if (!effectiveRange.start || !effectiveRange.end) return false;
    const startDate = new Date(`${effectiveRange.start}T00:00:00`);
    const endDate = new Date(`${effectiveRange.end}T23:59:59`);
    return periods.some((period) => {
      if (period.status !== "CLOSED") return false;
      const periodStart = new Date(period.startDate);
      const periodEnd = new Date(period.endDate);
      return startDate >= periodStart && endDate <= periodEnd;
    });
  }, [periods, effectiveRange.start, effectiveRange.end]);

  const income = data?.income || [];
  const expenses = data?.expenses || [];
  const hasReportRows = income.length + expenses.length > 0;

  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set("basis", "accrual");
    if (effectiveRange.start) params.set("start", effectiveRange.start);
    if (effectiveRange.end) params.set("end", effectiveRange.end);
    if (useYtd) params.set("rangeMode", "ytd");
    return params.toString();
  }, [effectiveRange.end, effectiveRange.start, useYtd]);

  useEffect(() => {
    const params = new URLSearchParams(query);
    params.set("share", "1");
    const next = `?${params.toString()}`;
    if (window.location.search === next) return;
    window.history.replaceState(null, "", `/admin/accounting/reports/pl${next}`);
  }, [query]);

  const priorProfit = previousData?.netProfit || 0;
  const currentProfit = data?.netProfit || 0;
  const profitDelta = currentProfit - priorProfit;
  const profitChange = percentChange(currentProfit, priorProfit);
  const hasUnboundedMaterialChange =
    profitChange === null &&
    Boolean(previousRange?.start && previousRange?.end) &&
    Math.abs(currentProfit) > 0.0001;
  const bigSwing = (profitChange !== null && Math.abs(profitChange) >= varianceThreshold) || hasUnboundedMaterialChange;
  const incomeTotal = data?.incomeTotal || 0;

  const rangeSummary = useMemo(() => {
    if (!effectiveRange.start && !effectiveRange.end) return "All posted dates";
    if (effectiveRange.start && effectiveRange.end) {
      return useYtd
        ? `Year-to-date (${effectiveRange.start} to ${effectiveRange.end})`
        : `${effectiveRange.start} to ${effectiveRange.end}`;
    }
    if (effectiveRange.start) return `From ${effectiveRange.start}`;
    return `Up to ${effectiveRange.end}`;
  }, [effectiveRange.end, effectiveRange.start, useYtd]);

  const comparisonHint = useMemo(() => {
    if (!previousRange?.start || !previousRange?.end) {
      return "Comparison requires both start and end dates.";
    }
    if (previousError) {
      return previousError instanceof Error ? previousError.message : "Comparison period could not be loaded.";
    }
    if (!isLoadingPrevious && previousData && Math.abs(previousData.netProfit) < 0.0001) {
      return "Comparison is limited because prior net profit is zero or near zero.";
    }
    if (!isLoadingPrevious && !previousData) {
      return "Comparison period returned no data.";
    }
    return null;
  }, [isLoadingPrevious, previousData, previousError, previousRange?.end, previousRange?.start]);

  const comparisonQuality = useMemo(() => {
    if (!previousRange?.start || !previousRange?.end) return "No comparison baseline";
    if (previousError) return "Comparison unavailable";
    if (!isLoadingPrevious && previousData && Math.abs(previousData.netProfit) < 0.0001) return "Limited baseline";
    if (!isLoadingPrevious && !previousData) return "No comparison data";
    return "High confidence";
  }, [isLoadingPrevious, previousData, previousError, previousRange?.end, previousRange?.start]);

  const comparisonRangeLabel = useMemo(() => {
    if (!previousRange?.start || !previousRange?.end) return "Comparison period: Not available";
    return `Comparison period: ${previousRange.start} to ${previousRange.end}`;
  }, [previousRange?.end, previousRange?.start]);

  const lastUpdatedLabel = useMemo(() => {
    if (!dataUpdatedAt) return "Not loaded yet";
    return new Date(dataUpdatedAt).toLocaleString();
  }, [dataUpdatedAt]);

  const noteAuditLink = "/admin/audit?scope=accounting_settings&action=app-setting.update&sourcePage=admin/accounting/reports/pl&settingSection=variance-note";
  const thresholdAuditLink =
    "/admin/audit?scope=accounting_settings&action=app-setting.update&sourcePage=admin/accounting/reports/pl&settingSection=variance-threshold";

  const { data: exportJobData, refetch: refetchExportJob } = useClientQuery<ExportJobResponse>({
    queryKey: ["accounting", "reports", "pl", "export-job", currentExportJobId || ""],
    enabled: Boolean(currentExportJobId),
    queryFn: async () => {
      const res = await fetch(`/api/admin/accounting/reports/pl/export/jobs/${encodeURIComponent(currentExportJobId || "")}`);
      return fetchJsonOrThrow<ExportJobResponse>(res, "Failed to load export job status.");
    },
    refetchInterval: (query) => {
      const status = (query.state.data as ExportJobResponse | undefined)?.status;
      return status === "READY" || status === "FAILED" ? false : 1000;
    },
  });
  useEffect(() => {
    if (!exportJobData) return;
    if (exportJobData.status === "READY" || exportJobData.status === "FAILED") {
      setExportJobMessage(null);
    }
  }, [exportJobData]);

  const { data: exportJobsHistoryData, refetch: refetchExportJobsHistory } = useClientQuery<{ jobs: ExportJobListItem[]; stats?: ExportJobsStats }>({
    queryKey: ["accounting", "reports", "pl", "export-jobs-history", currentExportJobId || ""],
    queryFn: async () => {
      const res = await fetch("/api/admin/accounting/reports/pl/export/jobs?limit=3&summary=1");
      return fetchJsonOrThrow<{ jobs: ExportJobListItem[]; stats?: ExportJobsStats }>(res, "Failed to load export job history.");
    },
    refetchInterval: 10_000,
  });

  const applyPresetToday = () => {
    const today = toDateLabel(new Date());
    hasUserEdited.current = true;
    setUseYtd(false);
    setStart(today);
    setEnd(today);
  };

  const applyPresetMonthToDate = () => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    hasUserEdited.current = true;
    setUseYtd(false);
    setStart(toDateLabel(monthStart));
    setEnd(toDateLabel(now));
  };

  const applyPresetCurrentPeriod = () => {
    if (!currentOpenPeriod) return;
    hasUserEdited.current = true;
    setUseYtd(false);
    setStart(currentOpenPeriod.startDate.slice(0, 10));
    setEnd(currentOpenPeriod.endDate.slice(0, 10));
  };

  const applyPresetYtd = () => {
    const today = toDateLabel(new Date());
    hasUserEdited.current = true;
    const ytdRange = getYtdRange(today);
    if (ytdRange) {
      setStart(ytdRange.start);
      setEnd(ytdRange.end);
    } else {
      setEnd(today);
    }
    setUseYtd(true);
  };

  const handleYtdToggle = (checked: boolean) => {
    hasUserEdited.current = true;
    if (!checked) {
      setUseYtd(false);
      return;
    }
    const normalizedEnd = end || toDateLabel(new Date());
    const ytdRange = getYtdRange(normalizedEnd);
    if (ytdRange) {
      setStart(ytdRange.start);
      setEnd(ytdRange.end);
    }
    setUseYtd(true);
  };

  const saveVarianceNote = async () => {
    if (!varianceNoteLengthValid) {
      toast.error(`Variance note must be at least ${minimumVarianceNoteLength} characters.`);
      return;
    }
    try {
      setSavingNote(true);
      setNoteConflictMessage(null);
      setNoteAuditMessage(null);
      const currentMap = { ...notesMap };
      currentMap[noteKey] = trimmedVarianceNote;

      await saveAppSetting(
        {
          key: "accounting.reports.pl.varianceNotes",
          value: currentMap,
          expectedUpdatedAt: notesData?.updatedAt ?? null,
          audit: {
            sourcePage: "admin/accounting/reports/pl",
            section: "variance-note",
            operation: "save",
          },
        },
        "Failed to save variance note.",
      );

      await refetchNotes();
      setNoteDirty(false);
      toast.success("Variance note saved.");
      setNoteAuditMessage("Saved and recorded in audit log.");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to save variance note.";
      if (message.includes("changed since you opened the page")) {
        setNoteConflictMessage("Variance note was updated by someone else. Reload latest note before saving again.");
        toast.error("Variance note changed in another session. Reload the latest note and retry.");
      } else {
        toast.error(message);
      }
    } finally {
      setSavingNote(false);
    }
  };

  const saveVarianceThreshold = async () => {
    if (!isAdmin) {
      toast.error("Only admins can edit variance threshold.");
      return;
    }
    const nextThreshold = Number(thresholdInput);
    if (!Number.isFinite(nextThreshold) || nextThreshold < 0 || nextThreshold > 1000) {
      toast.error("Variance threshold must be a number between 0 and 1000.");
      return;
    }

    try {
      setSavingThreshold(true);
      setThresholdAuditMessage(null);
      const previousThreshold = varianceThreshold;
      await saveAppSetting(
        {
          key: "accounting.reports.pl.varianceThresholdPct",
          value: nextThreshold,
          expectedUpdatedAt: thresholdData?.updatedAt ?? null,
          audit: {
            sourcePage: "admin/accounting/reports/pl",
            section: "variance-threshold",
            operation: "save",
          },
        },
        "Failed to save variance threshold.",
      );
      await refetchThreshold();
      toast.success(`Variance threshold updated from ${previousThreshold}% to ${nextThreshold}%.`);
      setThresholdAuditMessage("Threshold update recorded in audit log.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save variance threshold.");
    } finally {
      setSavingThreshold(false);
    }
  };

  const handleExportClick = (event: ReactMouseEvent<HTMLAnchorElement>, label: string) => {
    if (dateValidationError) {
      event.preventDefault();
      toast.error(dateValidationError);
      return;
    }
    if (!hasReportRows) {
      event.preventDefault();
      toast.error("No report rows for this range. Change filters before exporting.");
      return;
    }
    toast.message(`Exporting ${label} for ${rangeSummary}.`);
  };

  const runQueuedExport = async (type: "pl_csv" | "reporting_pack_csv") => {
    if (dateValidationError) {
      toast.error(dateValidationError);
      return;
    }
    if (!hasReportRows) {
      toast.error("No report rows for this range. Change filters before exporting.");
      return;
    }
    try {
      setExportJobLoading(true);
      setExportJobMessage(null);
      const res = await fetch("/api/admin/accounting/reports/pl/export/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          start: effectiveRange.start || null,
          end: effectiveRange.end || null,
          basis: "accrual",
          rangeSummary,
        }),
      });
      const payload = await fetchJsonOrThrow<{ jobId: string; downloadUrl: string }>(
        res,
        "Failed to queue export job.",
      );
      setCurrentExportJobId(payload.jobId);
      setExportJobMessage(`Export queued as job ${payload.jobId}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to queue export.");
    } finally {
      setExportJobLoading(false);
    }
  };

  const copyReportLink = async () => {
    if (dateValidationError) {
      toast.error(dateValidationError);
      return;
    }
    try {
      const params = new URLSearchParams(query);
      params.set("share", "1");
      const queryString = params.toString() ? `?${params.toString()}` : "";
      const link = `${window.location.origin}/admin/accounting/reports/pl${queryString}`;
      await navigator.clipboard.writeText(link);
      toast.success("Report link copied.");
    } catch {
      toast.error("Could not copy report link. Copy it from the browser address bar.");
    }
  };

  const runPlaywrightHelper = async () => {
    if (!isAdmin) return;
    try {
      setPlaywrightHelperLoading(true);
      setPlaywrightHelperMessage(null);
      const res = await fetch("/api/admin/accounting/reports/pl/playwright", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: effectiveRange.start || null,
          end: effectiveRange.end || null,
          useYtd,
        }),
      });
      const payload = await fetchJsonOrThrow<{ message: string; command: string }>(
        res,
        "Failed to prepare Playwright helper command.",
      );
      setPlaywrightCommand(payload.command);
      setPlaywrightHelperMessage(payload.message);
      toast.success("Playwright helper command is ready.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to prepare Playwright helper command.");
    } finally {
      setPlaywrightHelperLoading(false);
    }
  };

  const copyPlaywrightCommand = async () => {
    if (!playwrightCommand) return;
    try {
      await navigator.clipboard.writeText(playwrightCommand);
      toast.success("Playwright command copied.");
    } catch {
      toast.error("Could not copy Playwright command.");
    }
  };

  const exportJobsHistory = Array.isArray(exportJobsHistoryData?.jobs) ? exportJobsHistoryData.jobs : [];
  const exportJobsStats = exportJobsHistoryData?.stats || null;
  const showPlaywrightHelper = isAdmin && !isProduction;
  const selectedHistoryJob = exportJobsHistory.find((job) => job.id === selectedHistoryJobId) || null;
  const selectedJobAuditLink = selectedHistoryJob
    ? `/admin/audit?scope=accounting_reports&action=report.export.job.create&entityType=AccountingReportExportJob&entityId=${encodeURIComponent(selectedHistoryJob.id)}`
    : null;

  const simulateExportFailure = async (jobId: string) => {
    if (isProduction) return;
    try {
      const res = await fetch(`/api/admin/accounting/reports/pl/export/jobs/${encodeURIComponent(jobId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "simulate_failure",
          failReason: "Simulated export failure for test verification.",
        }),
      });
      await fetchJsonOrThrow(res, "Failed to simulate export failure.");
      toast.success("Simulated failed export status.");
      if (currentExportJobId === jobId) {
        await refetchExportJob();
      }
      await refetchExportJobsHistory();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to simulate export failure.");
    }
  };

  const isInvalidDateOrder = (nextStart: string, nextEnd: string) => {
    if (!nextStart || !nextEnd) return false;
    const startDate = parseDateInput(nextStart);
    const endDate = parseDateInput(nextEnd);
    if (!startDate || !endDate) return false;
    return endDate.getTime() < startDate.getTime();
  };

  useEffect(() => {
    if (isInvalidDateOrder(start, end)) {
      if (start && end && end !== start) {
        setEnd(start);
      }
      if (lastEditedDateFieldRef.current === "end") {
        const fallbackEnd = lastValidDateRangeRef.current.end || start;
        if (fallbackEnd !== end) setEnd(fallbackEnd);
      } else if (lastEditedDateFieldRef.current === "start") {
        const fallbackStart = lastValidDateRangeRef.current.start || end;
        if (fallbackStart !== start) setStart(fallbackStart);
      }
      return;
    }
    lastValidDateRangeRef.current = { start, end };
  }, [start, end]);

  const handleStartDateChange = (value: string) => {
    hasUserEdited.current = true;
    lastEditedDateFieldRef.current = "start";
    const currentEnd = endDateInputRef.current?.value || dateInputStateRef.current.end;
    if (isInvalidDateOrder(value, currentEnd)) {
      toast.error("End date cannot be earlier than start date.");
      return;
    }
    dateInputStateRef.current.start = value;
    setStart(value);
  };

  const handleEndDateChange = (value: string) => {
    hasUserEdited.current = true;
    lastEditedDateFieldRef.current = "end";
    const currentStart = startDateInputRef.current?.value || dateInputStateRef.current.start;
    if (isInvalidDateOrder(currentStart, value)) {
      toast.error("End date cannot be earlier than start date.");
      return;
    }
    dateInputStateRef.current.end = value;
    setEnd(value);
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Profit &amp; Loss</h1>
        <p className="text-sm text-muted-foreground">Accrual-based income statement.</p>
        <p className="text-xs text-muted-foreground mt-1">Report basis: Accrual. Range: {rangeSummary}.</p>
        <p className="text-xs text-muted-foreground mt-1">Last refreshed: {lastUpdatedLabel}.</p>
        <p className="text-xs text-muted-foreground mt-1">
          {currentOpenPeriod ? `Current period: ${currentOpenPeriod.name}` : "No open fiscal period."}
        </p>
        {periodsError ? (
          <p className="text-xs text-amber-700 mt-1">
            {periodsError instanceof Error ? periodsError.message : "Fiscal periods could not be loaded."}
          </p>
        ) : null}
        {dateValidationError ? <p className="text-xs text-red-700 mt-1">{dateValidationError}</p> : null}
        {!isClosedRange ? (
          <p className="text-xs text-amber-700 mt-1">
            Period not closed. Results can still change as entries are posted or edited.
          </p>
        ) : null}
      </div>

      <FiltersCard
        start={start}
        end={end}
        useYtd={useYtd}
        onStartChange={handleStartDateChange}
        onEndChange={handleEndDateChange}
        onYtdChange={handleYtdToggle}
        onPresetToday={applyPresetToday}
        onPresetMonthToDate={applyPresetMonthToDate}
        onPresetYtd={applyPresetYtd}
        onPresetOpenPeriod={applyPresetCurrentPeriod}
        openPeriodDisabled={!currentOpenPeriod}
        exportDisabled={Boolean(dateValidationError) || !hasReportRows}
        exportQuery={query}
        onExportClick={handleExportClick}
        onCopyReportLink={() => {
          void copyReportLink();
        }}
        copyLinkDisabled={Boolean(dateValidationError)}
        showNoRowsHint={!dateValidationError && !isLoading && !hasReportRows}
        thresholdInput={thresholdInput}
        onThresholdInputChange={setThresholdInput}
        onSaveThreshold={saveVarianceThreshold}
        savingThreshold={savingThreshold}
        thresholdEditable={isAdmin}
        thresholdErrorText={thresholdError instanceof Error ? thresholdError.message : thresholdError ? "Threshold setting could not be loaded." : null}
        thresholdAuditMessage={thresholdAuditMessage}
        thresholdAuditLink={thresholdAuditLink}
        startInputRef={startDateInputRef}
        endInputRef={endDateInputRef}
        startLockedByYtd={useYtd}
      />

      <Card>
        <CardHeader>
          <CardTitle>Large range export jobs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            For long ranges, queue export and continue working while file generation is prepared.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void runQueuedExport("pl_csv")} disabled={exportJobLoading}>
              Queue P&amp;L CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runQueuedExport("reporting_pack_csv")}
              disabled={exportJobLoading}
            >
              Queue reporting pack
            </Button>
          </div>
          {exportJobData?.status === "READY" ? (
            <p className="text-emerald-700">
              Job ready.{" "}
              <a className="underline underline-offset-2" href={exportJobData.downloadUrl} target="_blank" rel="noreferrer">
                Download export
              </a>
            </p>
          ) : null}
          {exportJobData?.status === "FAILED" ? (
            <p className="text-amber-700">
              Export job failed. {exportJobData.failReason || "Queue the export again, or use a smaller date range."}
            </p>
          ) : null}
          {exportJobMessage ? <p className="text-emerald-700">{exportJobMessage}</p> : null}
          <div className="pt-1">
            <p className="text-muted-foreground">Last export jobs</p>
            <p className="text-xs text-muted-foreground">
              Status legend: <span className="rounded border border-slate-200 bg-slate-100 px-1 py-0.5 text-slate-700">Queued</span>{" "}
              <span className="rounded border border-emerald-200 bg-emerald-100 px-1 py-0.5 text-emerald-800">Ready</span>{" "}
              <span className="rounded border border-amber-200 bg-amber-100 px-1 py-0.5 text-amber-800">Failed</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Last successful export:{" "}
              {exportJobsStats?.lastSuccessfulAt ? new Date(exportJobsStats.lastSuccessfulAt).toLocaleString() : "No successful export in the last 30 days"}.
              {" "}Most used range:{" "}
              {exportJobsStats?.topRangeSummary
                ? `${exportJobsStats.topRangeSummary} (${exportJobsStats.topRangeCount} run${exportJobsStats.topRangeCount === 1 ? "" : "s"})`
                : "No range trend yet"}.
            </p>
            {exportJobsHistory.length === 0 ? (
              <p className="text-muted-foreground">No recent queued export jobs.</p>
            ) : (
              <ul className="space-y-1">
                {exportJobsHistory.map((job) => (
                  <li key={job.id} className="rounded border p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex flex-wrap items-center gap-1">
                        {job.type === "pl_csv" ? "P&L CSV" : "Reporting pack"} |{" "}
                        <span className={`rounded border px-1 py-0.5 text-xs ${getExportJobStatusPresentation(job.status).className}`}>
                          {getExportJobStatusPresentation(job.status).label}
                        </span>{" "}
                        |{" "}
                        {new Date(job.createdAt).toLocaleString()} |{" "}
                        {job.requestedBy ? `Requested by ${job.requestedBy}` : "Requested by admin"} |{" "}
                        {job.rangeSummary || "Range not specified"}
                      </span>
                      <a className="underline underline-offset-2" href={job.downloadUrl} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="outline" onClick={() => setSelectedHistoryJobId(job.id)}>
                        View details
                      </Button>
                      {showPlaywrightHelper ? (
                        <Button size="sm" variant="outline" onClick={() => void simulateExportFailure(job.id)}>
                          Simulate failed status
                        </Button>
                      ) : null}
                    </div>
                    {job.status === "FAILED" ? (
                      <p className="mt-1 text-xs text-amber-700">
                        {job.failReason || "This job did not complete. Try queueing another export."}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {selectedHistoryJob ? (
            <Card className="mt-2">
              <CardHeader>
                <CardTitle>Export job details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p>Job ID: {selectedHistoryJob.id}</p>
                <p>Type: {selectedHistoryJob.type === "pl_csv" ? "P&L CSV" : "Reporting pack"}</p>
                <p>
                  Status:{" "}
                  <span className={`rounded border px-1 py-0.5 text-xs ${getExportJobStatusPresentation(selectedHistoryJob.status).className}`}>
                    {getExportJobStatusPresentation(selectedHistoryJob.status).label}
                  </span>
                </p>
                <p>Requested by: {selectedHistoryJob.requestedBy || "Unknown admin"}</p>
                <p>Range: {selectedHistoryJob.rangeSummary || "Not specified"}</p>
                <p>
                  Date range: {selectedHistoryJob.start || "-"} to {selectedHistoryJob.end || "-"}
                </p>
                <p>Created: {new Date(selectedHistoryJob.createdAt).toLocaleString()}</p>
                <p>Expires: {new Date(selectedHistoryJob.expiresAt).toLocaleString()}</p>
                {selectedHistoryJob.failReason ? <p className="text-amber-700">Failure reason: {selectedHistoryJob.failReason}</p> : null}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <a className="underline underline-offset-2" href={selectedHistoryJob.downloadUrl} target="_blank" rel="noreferrer">
                    Open export
                  </a>
                  {selectedJobAuditLink ? (
                    <Link className="underline underline-offset-2" href={selectedJobAuditLink}>
                      Open audit log
                    </Link>
                  ) : null}
                  <Button size="sm" variant="outline" onClick={() => setSelectedHistoryJobId(null)}>
                    Close
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </CardContent>
      </Card>

      {showPlaywrightHelper ? (
        <Card>
          <CardHeader>
            <CardTitle>Playwright page check helper</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">Prepare the exact terminal command to run P&amp;L page Playwright checks.</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void runPlaywrightHelper()} disabled={playwrightHelperLoading}>
                {playwrightHelperLoading ? "Preparing..." : "Prepare Playwright command"}
              </Button>
              {playwrightCommand ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void copyPlaywrightCommand();
                  }}
                >
                  Copy command
                </Button>
              ) : null}
            </div>
            {playwrightHelperMessage ? <p className="text-emerald-700">{playwrightHelperMessage}</p> : null}
            {playwrightCommand ? <p className="font-mono text-xs break-all">{playwrightCommand}</p> : null}
          </CardContent>
        </Card>
      ) : null}
      {isAdmin && isProduction ? (
        <Card>
          <CardHeader>
            <CardTitle>Playwright page check helper</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Hidden in production. Use the CI test pipeline for Playwright checks in production environments.
          </CardContent>
        </Card>
      ) : null}

      {reportError ? (
        <Card>
          <CardHeader>
            <CardTitle>Report error</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>{reportError instanceof Error ? reportError.message : "Failed to load P&L report."}</p>
            <Button size="sm" variant="outline" onClick={() => refetchReport()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {bigSwing ? (
        <VarianceNoteCard
          profitChange={profitChange}
          varianceThreshold={varianceThreshold}
          notesErrorText={notesError instanceof Error ? notesError.message : notesError ? "Variance notes could not be loaded." : null}
          noteConflictMessage={noteConflictMessage}
          varianceNote={varianceNote}
          onVarianceNoteChange={(value) => {
            setVarianceNote(value);
            setNoteDirty(true);
          }}
          onReloadLatest={() => {
            void refetchNotes();
          }}
          onSave={saveVarianceNote}
          savingNote={savingNote}
          hasUnsavedVarianceNote={hasUnsavedVarianceNote}
          noteSaveDisabled={Boolean(notesError) || !varianceNoteLengthValid}
          noteLengthHint={
            varianceNoteLengthValid || trimmedVarianceNote.length === 0
              ? null
              : `Minimum ${minimumVarianceNoteLength} characters required.`
          }
          noteAuditMessage={noteAuditMessage}
          noteAuditLink={noteAuditLink}
        />
      ) : null}

      <ComparisonCard
        currentProfit={currentProfit}
        priorProfit={priorProfit}
        profitDelta={profitDelta}
        profitChange={profitChange}
        comparisonQuality={comparisonQuality}
        comparisonHint={comparisonHint}
        comparisonRangeLabel={comparisonRangeLabel}
      />

      <Card>
        <CardHeader>
          <CardTitle>Income</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : income.length === 0 ? (
            <p className="text-muted-foreground">No income entries.</p>
          ) : (
            income.map((row) => (
              <div key={row.accountId} className="flex justify-between gap-2">
                <Link
                  className="underline underline-offset-2"
                  href={`/admin/accounting/journal?account=${encodeURIComponent(row.code)}${effectiveRange.start ? `&start=${encodeURIComponent(effectiveRange.start)}` : ""}${effectiveRange.end ? `&end=${encodeURIComponent(effectiveRange.end)}` : ""}`}
                >
                  {row.code} - {row.name}
                </Link>
                <span className="text-right">
                  {formatCurrency(row.credit - row.debit)}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {incomeTotal ? `${(((row.credit - row.debit) / incomeTotal) * 100).toFixed(1)}%` : "0.0%"}
                  </span>
                </span>
              </div>
            ))
          )}
          <div className="flex justify-between font-semibold pt-2 border-t">
            <span>Total income</span>
            <span>{formatCurrency(data?.incomeTotal || 0)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Expenses</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : expenses.length === 0 ? (
            <p className="text-muted-foreground">No expense entries.</p>
          ) : (
            expenses.map((row) => (
              <div key={row.accountId} className="flex justify-between gap-2">
                <Link
                  className="underline underline-offset-2"
                  href={`/admin/accounting/journal?account=${encodeURIComponent(row.code)}${effectiveRange.start ? `&start=${encodeURIComponent(effectiveRange.start)}` : ""}${effectiveRange.end ? `&end=${encodeURIComponent(effectiveRange.end)}` : ""}`}
                >
                  {row.code} - {row.name}
                </Link>
                <span className="text-right">
                  {formatCurrency(row.debit - row.credit)}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {incomeTotal ? `${(((row.debit - row.credit) / incomeTotal) * 100).toFixed(1)}%` : "0.0%"}
                  </span>
                </span>
              </div>
            ))
          )}
          <div className="flex justify-between font-semibold pt-2 border-t">
            <span>Total expenses</span>
            <span>{formatCurrency(data?.expenseTotal || 0)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Net profit</CardTitle>
        </CardHeader>
        <CardContent className="text-lg font-semibold">{formatCurrency(currentProfit)}</CardContent>
      </Card>
    </section>
  );
}
