"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/currency";
import { AppSettingSnapshot, fetchAppSetting, saveAppSetting } from "@/lib/app-settings-client";
import { toast } from "sonner";
import {
  DEFAULT_BALANCE_TOLERANCE,
  DEFAULT_DELTA_WARNING_THRESHOLD_PCT,
  isBalancedWithinTolerance,
  parseBalanceTolerance,
  parseDeltaWarningThresholdPct,
} from "@/lib/balance-sheet-settings";

type AccountRow = {
  accountId: string;
  code: string;
  name: string;
  subtype?: string | null;
  debit: number;
  credit: number;
};

type BalanceSheetResponse = {
  assets: AccountRow[];
  liabilities: AccountRow[];
  equity: AccountRow[];
  totals: {
    assets: number;
    liabilities: number;
    equity: number;
    liabilitiesPlusEquity: number;
  };
  asOf: string;
  rowLimit?: number;
  rowsTruncated?: boolean;
  rowCounts?: {
    assets?: { returned: number; total: number };
    liabilities?: { returned: number; total: number };
    equity?: { returned: number; total: number };
  };
  sort?: { by: "code" | "name" | "balance"; dir: "asc" | "desc" };
};

type FiscalPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
};

type QueuedExportType = "balance_sheet_csv" | "balance_sheet_pdf" | "reporting_pack_csv";

type ExportJobResponse = {
  jobId: string;
  status: "QUEUED" | "READY" | "FAILED";
  downloadUrl: string;
  expiresAt: number;
  failReason?: string | null;
};

type ExportJobListItem = {
  id: string;
  type: QueuedExportType;
  status: "QUEUED" | "READY" | "FAILED";
  downloadUrl: string;
  failReason?: string | null;
  asOf?: string | null;
  sortBy?: "code" | "name" | "balance";
  sortDir?: "asc" | "desc";
  requestedBy?: string | null;
  createdAt: number;
  expiresAt: number;
};

const BALANCE_TOLERANCE_SETTING_KEY = "accounting.reports.balanceSheet.balanceTolerance";
const DELTA_WARNING_THRESHOLD_SETTING_KEY = "accounting.reports.balanceSheet.deltaWarningThresholdPct";

function makeCorrelationId() {
  return `bs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function fetchJsonOrThrow<T>(url: string, fallbackError: string) {
  const res = await fetch(url);
  const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(typeof payload?.error === "string" && payload.error.trim() ? payload.error : fallbackError);
  }
  return payload;
}

async function sha256HexFromText(content: string) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256HexFromBuffer(content: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", content);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function prevDay(isoDate: string) {
  const d = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function displayNet(row: AccountRow, positiveDebit: boolean) {
  return positiveDebit ? row.debit - row.credit : row.credit - row.debit;
}

function liabilityCreditBalance(row: AccountRow) {
  return Math.max(displayNet(row, false), 0);
}

function liabilityDebitBalance(row: AccountRow) {
  return Math.max(-displayNet(row, false), 0);
}

function isCurrentAccount(row: AccountRow, section: "ASSET" | "LIABILITY") {
  const subtype = (row.subtype || "").toLowerCase();
  if (subtype.includes("non-current") || subtype.includes("noncurrent") || subtype.includes("long-term")) {
    return false;
  }
  if (subtype.includes("current") || subtype.includes("short-term")) {
    return true;
  }
  if (section === "ASSET") {
    return ["1000", "1010", "1020", "1030", "1040", "1100", "1200"].includes(row.code);
  }
  return row.code.startsWith("2");
}

function resolvePreviousClosedPeriodEnd(asOf: string, periods: FiscalPeriod[]) {
  if (!asOf) return "";
  const asOfDate = new Date(`${asOf}T23:59:59`);
  if (Number.isNaN(asOfDate.getTime())) return "";
  const candidates = periods
    .filter((period) => {
      if (period.status !== "CLOSED") return false;
      const endDate = new Date(period.endDate);
      return !Number.isNaN(endDate.getTime()) && endDate < asOfDate;
    })
    .sort((a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime());
  if (candidates.length === 0) return "";
  return candidates[0].endDate.slice(0, 10);
}

export default function BalanceSheetPage() {
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const isAdmin = String((session?.user as { role?: string } | undefined)?.role || "") === "ADMIN";
  const [asOf, setAsOf] = useState(() => searchParams.get("asOf") || new Date().toISOString().slice(0, 10));
  const [comparisonMode, setComparisonMode] = useState<"prior_day" | "prior_period_end">("prior_day");
  const [sortBy, setSortBy] = useState<"code" | "name" | "balance">(() => {
    const fromQuery = String(searchParams.get("sortBy") || "").toLowerCase();
    if (fromQuery === "name" || fromQuery === "balance") return fromQuery;
    return "code";
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => (String(searchParams.get("sortDir") || "").toLowerCase() === "desc" ? "desc" : "asc"));
  const [showSignedValues, setShowSignedValues] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [lastLoadDurationMs, setLastLoadDurationMs] = useState<number | null>(null);
  const [lastExportDurationMs, setLastExportDurationMs] = useState<number | null>(null);
  const [reportCorrelationId, setReportCorrelationId] = useState("");
  const [toleranceInput, setToleranceInput] = useState(String(DEFAULT_BALANCE_TOLERANCE));
  const [deltaWarningThresholdInput, setDeltaWarningThresholdInput] = useState(String(DEFAULT_DELTA_WARNING_THRESHOLD_PCT));
  const [savingTolerance, setSavingTolerance] = useState(false);
  const [savingDeltaWarningThreshold, setSavingDeltaWarningThreshold] = useState(false);
  const [exportJobLoading, setExportJobLoading] = useState(false);
  const [currentExportJobId, setCurrentExportJobId] = useState<string | null>(null);
  const [exportJobMessage, setExportJobMessage] = useState<string | null>(null);
  const [jobStatusFilter, setJobStatusFilter] = useState<"all" | "QUEUED" | "READY" | "FAILED">("all");
  const [jobTypeFilter, setJobTypeFilter] = useState<"all" | QueuedExportType>("all");
  const [jobDateFrom, setJobDateFrom] = useState("");
  const [jobDateTo, setJobDateTo] = useState("");
  const [selectedHistoryJobId, setSelectedHistoryJobId] = useState<string | null>(null);
  const [toleranceAuditMessage, setToleranceAuditMessage] = useState<string | null>(null);
  const [toleranceSaveError, setToleranceSaveError] = useState<string | null>(null);
  const [deltaThresholdAuditMessage, setDeltaThresholdAuditMessage] = useState<string | null>(null);
  const [deltaThresholdSaveError, setDeltaThresholdSaveError] = useState<string | null>(null);
  const [lastExportStatus, setLastExportStatus] = useState<{
    status: "success" | "error";
    type: "balance_sheet_csv" | "balance_sheet_pdf" | "reporting_pack_csv";
    message: string;
    at: string;
    correlationId: string;
  } | null>(null);
  const hasUserEdited = useRef(false);
  const fetchStartedAtRef = useRef<number | null>(null);
  const printMode = searchParams.get("print") === "1";

  const {
    data: balanceToleranceSetting,
    error: balanceToleranceSettingError,
    refetch: refetchBalanceToleranceSetting,
  } = useClientQuery<AppSettingSnapshot<number | string>>({
    queryKey: ["app-setting", BALANCE_TOLERANCE_SETTING_KEY],
    queryFn: () => fetchAppSetting<number | string>(BALANCE_TOLERANCE_SETTING_KEY),
  });
  const {
    data: deltaWarningThresholdSetting,
    error: deltaWarningThresholdSettingError,
    refetch: refetchDeltaWarningThresholdSetting,
  } = useClientQuery<AppSettingSnapshot<number | string>>({
    queryKey: ["app-setting", DELTA_WARNING_THRESHOLD_SETTING_KEY],
    queryFn: () => fetchAppSetting<number | string>(DELTA_WARNING_THRESHOLD_SETTING_KEY),
  });

  const { data: periodsData } = useClientQuery<FiscalPeriod[]>({
    queryKey: ["accounting", "periods"],
    queryFn: () => fetchJsonOrThrow<FiscalPeriod[]>("/api/admin/accounting/periods", "Failed to load fiscal periods."),
  });
  const periods = useMemo(() => (Array.isArray(periodsData) ? periodsData : []), [periodsData]);
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
    setAsOf(currentOpenPeriod.endDate.slice(0, 10));
  }, [currentOpenPeriod]);

  const {
    data,
    isLoading,
    error: reportError,
    refetch: refetchReport,
  } = useClientQuery<BalanceSheetResponse>({
    queryKey: ["accounting", "reports", "balance-sheet", { asOf, sortBy, sortDir }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (asOf) params.set("asOf", asOf);
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      params.set("rows", "500");
      return fetchJsonOrThrow<BalanceSheetResponse>(
        `/api/admin/accounting/reports/balance-sheet?${params.toString()}`,
        "Failed to load balance sheet report.",
      );
    },
  });

  const comparisonAsOf = useMemo(() => {
    if (!asOf) return "";
    if (comparisonMode === "prior_period_end") {
      return resolvePreviousClosedPeriodEnd(asOf, periods);
    }
    return prevDay(asOf);
  }, [asOf, comparisonMode, periods]);
  const {
    data: previousData,
    error: previousError,
    refetch: refetchPreviousReport,
  } = useClientQuery<BalanceSheetResponse>({
    queryKey: ["accounting", "reports", "balance-sheet", "previous", comparisonMode, comparisonAsOf, sortBy, sortDir],
    queryFn: () => {
      const params = new URLSearchParams();
      if (comparisonAsOf) params.set("asOf", comparisonAsOf);
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      params.set("rows", "500");
      return fetchJsonOrThrow<BalanceSheetResponse>(
        `/api/admin/accounting/reports/balance-sheet?${params.toString()}`,
        "Failed to load comparison period.",
      );
    },
    enabled: Boolean(comparisonAsOf),
  });

  const { data: exportJobData } = useClientQuery<ExportJobResponse>({
    queryKey: ["accounting", "reports", "balance-sheet", "export-job", currentExportJobId || ""],
    enabled: Boolean(currentExportJobId),
    queryFn: () =>
      fetchJsonOrThrow<ExportJobResponse>(
        `/api/admin/accounting/reports/balance-sheet/export/jobs/${encodeURIComponent(currentExportJobId || "")}`,
        "Failed to load export job status.",
      ),
    refetchInterval: (query) => {
      const status = (query.state.data as ExportJobResponse | undefined)?.status;
      return status === "READY" || status === "FAILED" ? false : 1000;
    },
  });
  const { data: exportJobsHistoryData } = useClientQuery<{ jobs: ExportJobListItem[] }>({
    queryKey: ["accounting", "reports", "balance-sheet", "export-jobs-history", currentExportJobId || ""],
    queryFn: () =>
      fetchJsonOrThrow<{ jobs: ExportJobListItem[] }>(
        "/api/admin/accounting/reports/balance-sheet/export/jobs?limit=3",
        "Failed to load export job history.",
      ),
    enabled: !printMode,
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!balanceToleranceSetting) return;
    setToleranceInput(String(parseBalanceTolerance(balanceToleranceSetting.value)));
  }, [balanceToleranceSetting]);
  useEffect(() => {
    if (!deltaWarningThresholdSetting) return;
    setDeltaWarningThresholdInput(String(parseDeltaWarningThresholdPct(deltaWarningThresholdSetting.value)));
  }, [deltaWarningThresholdSetting]);

  useEffect(() => {
    setReportCorrelationId(makeCorrelationId());
  }, []);

  useEffect(() => {
    if (!data) return;
    setLastRefreshedAt(new Date().toISOString());
  }, [data]);
  useEffect(() => {
    if (!exportJobData) return;
    if (exportJobData.status === "READY" || exportJobData.status === "FAILED") {
      setExportJobMessage(null);
    }
  }, [exportJobData]);
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (isLoading && fetchStartedAtRef.current === null) {
      fetchStartedAtRef.current = performance.now();
      return;
    }
    if (!isLoading && fetchStartedAtRef.current !== null) {
      setLastLoadDurationMs(Math.max(0, performance.now() - fetchStartedAtRef.current));
      fetchStartedAtRef.current = null;
    }
  }, [isLoading, data, reportError]);

  const assets = data?.assets || [];
  const liabilities = data?.liabilities || [];
  const equity = data?.equity || [];
  const currentAssetsRows = assets.filter((row) => isCurrentAccount(row, "ASSET"));
  const nonCurrentAssetsRows = assets.filter((row) => !isCurrentAccount(row, "ASSET"));
  const currentLiabilityRows = liabilities.filter((row) => isCurrentAccount(row, "LIABILITY"));
  const nonCurrentLiabilityRows = liabilities.filter((row) => !isCurrentAccount(row, "LIABILITY"));
  const liabilitiesCreditTotal = liabilities.reduce((sum, row) => sum + liabilityCreditBalance(row), 0);
  const liabilitiesDebitOffsetTotal = liabilities.reduce((sum, row) => sum + liabilityDebitBalance(row), 0);

  const isClosedAsOf = useMemo(() => {
    if (!asOf) return false;
    const asOfDate = new Date(`${asOf}T23:59:59`);
    return periods.some((period) => {
      if (period.status !== "CLOSED") return false;
      const startDate = new Date(period.startDate);
      const endDate = new Date(period.endDate);
      return asOfDate >= startDate && asOfDate <= endDate;
    });
  }, [periods, asOf]);

  const renderRows = (rows: AccountRow[], positiveDebit: boolean, section: "ASSET" | "LIABILITY" | "EQUITY") =>
    rows.map((row) => (
      <div key={row.accountId} className="flex justify-between gap-2">
        <Link
          className="underline underline-offset-2"
          href={`/admin/accounting/journal?account=${encodeURIComponent(row.code)}${asOf ? `&end=${encodeURIComponent(asOf)}` : ""}`}
        >
          {row.code} · {row.name}
        </Link>
        {section === "LIABILITY" && !showSignedValues ? (
          <span className={displayNet(row, positiveDebit) < 0 ? "text-amber-700" : undefined}>
            {displayNet(row, positiveDebit) < 0 ? "Debit " : ""}
            {formatCurrency(Math.abs(displayNet(row, positiveDebit)))}
          </span>
        ) : section === "EQUITY" && !showSignedValues ? (
          (() => {
            const net = displayNet(row, positiveDebit);
            const isCurrentPeriodPL =
              String(row.code || "").toUpperCase() === "CPL" ||
              /current period/i.test(String(row.name || ""));
            if (isCurrentPeriodPL) {
              return (
                <span className={net < 0 ? "text-rose-700 font-semibold" : "text-emerald-700 font-semibold"}>
                  {net < 0 ? "Loss " : "Profit "}
                  {formatCurrency(Math.abs(net))}
                </span>
              );
            }
            return <span>{formatCurrency(Math.abs(net))}</span>;
          })()
        ) : (
          <span>
            {formatCurrency(
              showSignedValues || section === "ASSET"
                ? displayNet(row, positiveDebit)
                : Math.abs(displayNet(row, positiveDebit)),
            )}
          </span>
        )}
      </div>
    ));

  const queryParams = new URLSearchParams();
  if (asOf) queryParams.set("asOf", asOf);
  queryParams.set("sortBy", sortBy);
  queryParams.set("sortDir", sortDir);
  queryParams.set("rows", "500");
  if (reportCorrelationId) queryParams.set("correlationId", reportCorrelationId);
  const query = queryParams.toString();
  const printParams = new URLSearchParams();
  if (asOf) printParams.set("asOf", asOf);
  printParams.set("sortBy", sortBy);
  printParams.set("sortDir", sortDir);
  printParams.set("print", "1");
  const currentAssets = data?.totals?.assets || 0;
  const hasPriorAssets = Boolean(previousData) && !previousError;
  const priorAssets = hasPriorAssets ? previousData?.totals?.assets || 0 : null;
  const assetsDelta = hasPriorAssets && priorAssets !== null ? currentAssets - priorAssets : null;
  const assetsDeltaPct =
    hasPriorAssets && priorAssets !== null && Math.abs(priorAssets) > 0.0001
      ? (assetsDelta! / Math.abs(priorAssets)) * 100
      : null;
  const liquidityOverdraftCodes = new Set(["1000", "1010", "1020", "1030", "1040"]);
  const liquidityCurrentAssets = currentAssetsRows.reduce((sum, row) => {
    const net = displayNet(row, true);
    if (liquidityOverdraftCodes.has(row.code)) {
      return sum + (net > 0 ? net : 0);
    }
    return sum + Math.max(net, 0);
  }, 0);
  const overdraftReclass = currentAssetsRows.reduce((sum, row) => {
    if (!liquidityOverdraftCodes.has(row.code)) return sum;
    const net = displayNet(row, true);
    return sum + (net < 0 ? Math.abs(net) : 0);
  }, 0);
  const liquidityCurrentLiabilitiesBase = currentLiabilityRows.reduce(
    (sum, row) => sum + liabilityCreditBalance(row),
    0,
  );
  const currentLiabilityDebitOffsets = currentLiabilityRows.reduce(
    (sum, row) => sum + liabilityDebitBalance(row),
    0,
  );
  const liquidityCurrentLiabilities = Math.max(
    liquidityCurrentLiabilitiesBase + overdraftReclass - currentLiabilityDebitOffsets,
    0,
  );
  const workingCapital = liquidityCurrentAssets - liquidityCurrentLiabilities;
  const currentRatio =
    liquidityCurrentLiabilities > 0 ? liquidityCurrentAssets / liquidityCurrentLiabilities : null;
  const liabilitiesNetSigned = data?.totals?.liabilities || 0;
  const liabilitiesPlusEquity = data?.totals?.liabilitiesPlusEquity || 0;
  const balanceDifference = currentAssets - liabilitiesPlusEquity;
  const balanceTolerance = parseBalanceTolerance(balanceToleranceSetting?.value);
  const isBalanced = isBalancedWithinTolerance(balanceDifference, balanceTolerance);
  const deltaWarningThresholdPct = parseDeltaWarningThresholdPct(deltaWarningThresholdSetting?.value);
  const deltaWarningTriggered =
    assetsDeltaPct !== null && Math.abs(assetsDeltaPct) >= deltaWarningThresholdPct;
  const toleranceAuditLink = `/admin/audit?scope=accounting_settings&action=app-setting.update&sourcePage=admin/accounting/reports/balance-sheet&entityType=AppSetting&entityId=${encodeURIComponent(BALANCE_TOLERANCE_SETTING_KEY)}`;
  const deltaThresholdAuditLink = `/admin/audit?scope=accounting_settings&action=app-setting.update&sourcePage=admin/accounting/reports/balance-sheet&entityType=AppSetting&entityId=${encodeURIComponent(DELTA_WARNING_THRESHOLD_SETTING_KEY)}`;
  const exportAuditLink = `/admin/audit?sourcePage=${encodeURIComponent("admin/accounting/reports/balance-sheet")}`;
  const staleMinutes =
    lastRefreshedAt ? (nowTick - new Date(lastRefreshedAt).getTime()) / 60000 : null;
  const isDataStale = staleMinutes !== null && staleMinutes >= 5;

  const saveBalanceTolerance = async () => {
    if (!isAdmin) return;
    const parsed = Number(toleranceInput);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000) {
      setToleranceSaveError("Balance tolerance must be a number between 0 and 1000.");
      return;
    }
    setSavingTolerance(true);
    setToleranceSaveError(null);
    setToleranceAuditMessage(null);
    try {
      await saveAppSetting(
        {
          key: BALANCE_TOLERANCE_SETTING_KEY,
          value: parsed,
          expectedUpdatedAt: balanceToleranceSetting?.updatedAt ?? null,
          audit: {
            sourcePage: "admin/accounting/reports/balance-sheet",
            section: "balance-check",
            operation: "save",
          },
        },
        "Failed to save balance tolerance.",
      );
      setToleranceAuditMessage("Balance tolerance saved.");
      await refetchBalanceToleranceSetting();
    } catch (error) {
      setToleranceSaveError(error instanceof Error ? error.message : "Failed to save balance tolerance.");
    } finally {
      setSavingTolerance(false);
    }
  };

  const saveDeltaWarningThreshold = async () => {
    if (!isAdmin) return;
    const parsed = Number(deltaWarningThresholdInput);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000) {
      setDeltaThresholdSaveError("Delta warning threshold must be a number between 0 and 1000.");
      return;
    }
    setSavingDeltaWarningThreshold(true);
    setDeltaThresholdSaveError(null);
    setDeltaThresholdAuditMessage(null);
    try {
      await saveAppSetting(
        {
          key: DELTA_WARNING_THRESHOLD_SETTING_KEY,
          value: parsed,
          expectedUpdatedAt: deltaWarningThresholdSetting?.updatedAt ?? null,
          audit: {
            sourcePage: "admin/accounting/reports/balance-sheet",
            section: "comparison",
            operation: "save",
          },
        },
        "Failed to save delta warning threshold.",
      );
      setDeltaThresholdAuditMessage("Delta warning threshold saved.");
      await refetchDeltaWarningThresholdSetting();
    } catch (error) {
      setDeltaThresholdSaveError(error instanceof Error ? error.message : "Failed to save delta warning threshold.");
    } finally {
      setSavingDeltaWarningThreshold(false);
    }
  };

  const runExport = async (type: "balance_sheet_csv" | "balance_sheet_pdf" | "reporting_pack_csv") => {
    const exportStartedAt = performance.now();
    const endpoint =
      type === "balance_sheet_csv"
        ? `/api/admin/accounting/reports/balance-sheet/export?${query}`
        : type === "balance_sheet_pdf"
          ? `/api/admin/accounting/reports/balance-sheet/export/pdf?${query}`
        : `/api/admin/accounting/reports/pack/export?${query}${query ? "&" : ""}source=balance-sheet`;
    const label =
      type === "balance_sheet_csv"
        ? "Balance sheet CSV"
        : type === "balance_sheet_pdf"
          ? "Balance sheet PDF"
          : "Reporting pack CSV";
    toast.message(`${label} export started.`);
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        const payload = await response
          .json()
          .catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || `Export failed (${response.status}).`);
      }
      const headerCorrelationId = response.headers.get("X-Report-Correlation-Id") || reportCorrelationId || "pending";
      const contentType = String(response.headers.get("Content-Type") || "").toLowerCase();
      const expectedChecksum = String(response.headers.get("X-Export-Checksum-Sha256") || "").trim().toLowerCase();
      const suggestedName =
        type === "balance_sheet_csv"
          ? `balance-sheet-${asOf || "latest"}.csv`
          : type === "balance_sheet_pdf"
            ? `balance-sheet-${asOf || "latest"}.pdf`
            : "reporting-pack.csv";

      let fileBlob: Blob;
      if (contentType.includes("text/csv")) {
        const expectedRowCount = Number(response.headers.get("X-Export-Row-Count") || 0);
        const csvText = await response.text();
        if (expectedRowCount > 0) {
          const actualTotalLineCount = csvText.split(/\r?\n/).length;
          if (actualTotalLineCount !== expectedRowCount) {
            throw new Error(
              `Export integrity check failed: expected ${expectedRowCount} rows, got ${actualTotalLineCount}.`,
            );
          }
        }
        if (expectedChecksum) {
          const actualChecksum = await sha256HexFromText(csvText);
          if (actualChecksum !== expectedChecksum) {
            throw new Error("Export integrity check failed: checksum mismatch.");
          }
        }
        fileBlob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
      } else {
        fileBlob = await response.blob();
        if (expectedChecksum) {
          const actualChecksum = await sha256HexFromBuffer(await fileBlob.arrayBuffer());
          if (actualChecksum !== expectedChecksum) {
            throw new Error("Export integrity check failed: checksum mismatch.");
          }
        }
      }
      const url = URL.createObjectURL(fileBlob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = suggestedName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success(`${label} export ready.`);
      setLastExportStatus({
        status: "success",
        type,
        message: `${label} export completed successfully. Integrity verified.`,
        at: new Date().toISOString(),
        correlationId: headerCorrelationId,
      });
      setLastExportDurationMs(Math.max(0, performance.now() - exportStartedAt));
    } catch (error) {
      const message = error instanceof Error ? error.message : `${label} export failed.`;
      toast.error(message);
      setLastExportStatus({
        status: "error",
        type,
        message,
        at: new Date().toISOString(),
        correlationId: reportCorrelationId || "pending",
      });
      setLastExportDurationMs(Math.max(0, performance.now() - exportStartedAt));
    }
  };

  const runQueuedExport = async (type: QueuedExportType) => {
    try {
      setExportJobLoading(true);
      setExportJobMessage(null);
      const response = await fetch("/api/admin/accounting/reports/balance-sheet/export/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          asOf: asOf || null,
          sortBy,
          sortDir,
          correlationId: reportCorrelationId || null,
        }),
      });
      const created = (await response.json().catch(() => null)) as { jobId?: string; error?: string } | null;
      if (!response.ok) {
        throw new Error(created?.error || "Failed to queue export job.");
      }
      setCurrentExportJobId(created?.jobId || null);
      setExportJobMessage(`Export queued as job ${created?.jobId || "unknown"}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to queue export.");
    } finally {
      setExportJobLoading(false);
    }
  };

  const exportJobsHistory = Array.isArray(exportJobsHistoryData?.jobs) ? exportJobsHistoryData.jobs : [];
  const filteredExportJobsHistory = exportJobsHistory.filter((job) => {
    if (jobStatusFilter !== "all" && job.status !== jobStatusFilter) return false;
    if (jobTypeFilter !== "all" && job.type !== jobTypeFilter) return false;
    const created = new Date(job.createdAt);
    if (jobDateFrom) {
      const fromDate = new Date(`${jobDateFrom}T00:00:00`);
      if (!Number.isNaN(fromDate.getTime()) && created < fromDate) return false;
    }
    if (jobDateTo) {
      const toDate = new Date(`${jobDateTo}T23:59:59`);
      if (!Number.isNaN(toDate.getTime()) && created > toDate) return false;
    }
    return true;
  });
  const selectedHistoryJob = filteredExportJobsHistory.find((job) => job.id === selectedHistoryJobId) || null;

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Balance Sheet</h1>
        <p className="text-sm text-muted-foreground">Snapshot of assets, liabilities, and equity.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Last refreshed: {lastRefreshedAt ? new Date(lastRefreshedAt).toLocaleString() : "Not yet loaded."}
        </p>
        {isDataStale ? (
          <p className="text-xs text-amber-700 mt-1" aria-live="polite">
            Data may be stale ({staleMinutes?.toFixed(1)} minutes since refresh). Refresh before final review.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground mt-1">
          {currentOpenPeriod ? `Current period: ${currentOpenPeriod.name}` : "No open fiscal period."}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Export and audit correlation ID: <span className="font-mono">{reportCorrelationId || "pending"}</span>
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          <Link className="underline underline-offset-2" href={exportAuditLink}>
            Open export audit events
          </Link>
        </p>
        {!isClosedAsOf ? (
          <p className="text-xs text-amber-700 mt-1">
            As-of date is not in a closed period. Balances can still change with new postings.
          </p>
        ) : null}
        {data?.rowsTruncated ? (
          <p className="text-xs text-amber-700 mt-1" aria-live="polite">
            Row display limit reached ({data.rowLimit}). Showing a partial list for performance. Use export for full detail.
          </p>
        ) : null}
        {data?.rowCounts ? (
          <p className="text-xs text-muted-foreground mt-1">
            Rows shown: Assets {data.rowCounts.assets?.returned ?? 0}/{data.rowCounts.assets?.total ?? 0}, Liabilities{" "}
            {data.rowCounts.liabilities?.returned ?? 0}/{data.rowCounts.liabilities?.total ?? 0}, Equity{" "}
            {data.rowCounts.equity?.returned ?? 0}/{data.rowCounts.equity?.total ?? 0}.
          </p>
        ) : null}
      </div>
      {!printMode ? (
      <Card>
        <CardHeader>
          <CardTitle>As of</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-full sm:w-auto"
              type="date"
              value={asOf}
              onChange={(e) => {
                hasUserEdited.current = true;
                setAsOf(e.target.value);
              }}
            />
            <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => void runExport("balance_sheet_csv")}>
              Export CSV
            </Button>
            <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => void runExport("balance_sheet_pdf")}>
              Export PDF
            </Button>
            <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => void runExport("reporting_pack_csv")}>
              Export reporting pack
            </Button>
            <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
              <Link href="/admin/accounting/periods">Open Fiscal Periods</Link>
            </Button>
            <label className="inline-flex items-center gap-2 text-sm">
              Compare against
              <select
                className="h-9 rounded-md border bg-background px-2"
                value={comparisonMode}
                onChange={(event) => setComparisonMode(event.target.value as "prior_day" | "prior_period_end")}
                aria-label="Comparison mode"
              >
                <option value="prior_day">Prior day</option>
                <option value="prior_period_end">Previous closed period end</option>
              </select>
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              Sort by
              <select
                className="h-9 rounded-md border bg-background px-2"
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value as "code" | "name" | "balance")}
                aria-label="Sort rows by"
              >
                <option value="code">Code</option>
                <option value="name">Name</option>
                <option value="balance">Balance</option>
              </select>
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              Direction
              <select
                className="h-9 rounded-md border bg-background px-2"
                value={sortDir}
                onChange={(event) => setSortDir(event.target.value as "asc" | "desc")}
                aria-label="Sort direction"
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </label>
            <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
              <Link href={`/admin/accounting/reports/balance-sheet?${printParams.toString()}`} target="_blank" rel="noreferrer">
                Print view
              </Link>
            </Button>
            <label className="inline-flex items-center gap-2 text-sm ml-auto">
              <input
                type="checkbox"
                checked={showSignedValues}
                onChange={(e) => setShowSignedValues(e.target.checked)}
              />
              Show signed values
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="balance-tolerance" className="text-muted-foreground">
              Balance tolerance
            </label>
            <Input
              id="balance-tolerance"
              className="w-32"
              inputMode="decimal"
              value={toleranceInput}
              onChange={(e) => setToleranceInput(e.target.value)}
              disabled={!isAdmin}
              aria-label="Balance tolerance"
            />
            <Button size="sm" variant="outline" onClick={() => void saveBalanceTolerance()} disabled={savingTolerance || !isAdmin}>
              {savingTolerance ? "Saving..." : "Save tolerance"}
            </Button>
            {!isAdmin ? <span className="text-xs text-muted-foreground">Only admins can edit tolerance.</span> : null}
            {balanceToleranceSettingError ? (
              <span className="text-xs text-amber-700">
                {balanceToleranceSettingError instanceof Error ? balanceToleranceSettingError.message : "Tolerance setting could not be loaded."}
              </span>
            ) : null}
            {toleranceSaveError ? <span className="text-xs text-amber-700">{toleranceSaveError}</span> : null}
            {toleranceAuditMessage ? (
              <span className="text-xs text-emerald-700">
                {toleranceAuditMessage}{" "}
                <Link className="underline underline-offset-2" href={toleranceAuditLink}>
                  View audit log
                </Link>
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor="delta-warning-threshold" className="text-muted-foreground">
              Delta warning threshold (%)
            </label>
            <Input
              id="delta-warning-threshold"
              className="w-32"
              inputMode="decimal"
              value={deltaWarningThresholdInput}
              onChange={(e) => setDeltaWarningThresholdInput(e.target.value)}
              disabled={!isAdmin}
              aria-label="Delta warning threshold percent"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void saveDeltaWarningThreshold()}
              disabled={savingDeltaWarningThreshold || !isAdmin}
            >
              {savingDeltaWarningThreshold ? "Saving..." : "Save threshold"}
            </Button>
            {!isAdmin ? <span className="text-xs text-muted-foreground">Only admins can edit threshold.</span> : null}
            {deltaWarningThresholdSettingError ? (
              <span className="text-xs text-amber-700">
                {deltaWarningThresholdSettingError instanceof Error
                  ? deltaWarningThresholdSettingError.message
                  : "Delta warning threshold could not be loaded."}
              </span>
            ) : null}
            {deltaThresholdSaveError ? <span className="text-xs text-amber-700">{deltaThresholdSaveError}</span> : null}
            {deltaThresholdAuditMessage ? (
              <span className="text-xs text-emerald-700">
                {deltaThresholdAuditMessage}{" "}
                <Link className="underline underline-offset-2" href={deltaThresholdAuditLink}>
                  View audit log
                </Link>
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>
      ) : null}
      {!printMode ? (
        <Card>
          <CardHeader>
            <CardTitle>Large export jobs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Use queued exports for heavy periods so you can keep working while the file link is prepared.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void runQueuedExport("balance_sheet_csv")} disabled={exportJobLoading}>
                Queue balance sheet CSV
              </Button>
              <Button size="sm" variant="outline" onClick={() => void runQueuedExport("balance_sheet_pdf")} disabled={exportJobLoading}>
                Queue balance sheet PDF
              </Button>
              <Button size="sm" variant="outline" onClick={() => void runQueuedExport("reporting_pack_csv")} disabled={exportJobLoading}>
                Queue reporting pack CSV
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
                Export job failed. {exportJobData.failReason || "Queue the export again."}
              </p>
            ) : null}
            {exportJobMessage ? <p className="text-emerald-700">{exportJobMessage}</p> : null}
            <div className="pt-1">
              <p className="text-muted-foreground">Recent queued exports</p>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                <label className="text-xs text-muted-foreground">
                  Status
                  <select
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={jobStatusFilter}
                    onChange={(event) => setJobStatusFilter(event.target.value as "all" | "QUEUED" | "READY" | "FAILED")}
                  >
                    <option value="all">All statuses</option>
                    <option value="QUEUED">Queued</option>
                    <option value="READY">Ready</option>
                    <option value="FAILED">Failed</option>
                  </select>
                </label>
                <label className="text-xs text-muted-foreground">
                  Type
                  <select
                    className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={jobTypeFilter}
                    onChange={(event) => setJobTypeFilter(event.target.value as "all" | QueuedExportType)}
                  >
                    <option value="all">All types</option>
                    <option value="balance_sheet_csv">Balance sheet CSV</option>
                    <option value="balance_sheet_pdf">Balance sheet PDF</option>
                    <option value="reporting_pack_csv">Reporting pack CSV</option>
                  </select>
                </label>
                <label className="text-xs text-muted-foreground">
                  Created from
                  <Input
                    className="mt-1"
                    type="date"
                    value={jobDateFrom}
                    onChange={(event) => setJobDateFrom(event.target.value)}
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  Created to
                  <Input
                    className="mt-1"
                    type="date"
                    value={jobDateTo}
                    onChange={(event) => setJobDateTo(event.target.value)}
                  />
                </label>
                <div className="text-xs text-muted-foreground flex items-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      setJobStatusFilter("all");
                      setJobTypeFilter("all");
                      setJobDateFrom("");
                      setJobDateTo("");
                    }}
                  >
                    Reset filters
                  </Button>
                </div>
              </div>
              {filteredExportJobsHistory.length === 0 ? (
                <p className="text-muted-foreground">No recent queued jobs.</p>
              ) : (
                <ul className="space-y-1">
                  {filteredExportJobsHistory.map((job) => (
                    <li key={job.id} className="rounded border p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {job.type === "balance_sheet_csv"
                            ? "Balance sheet CSV"
                            : job.type === "balance_sheet_pdf"
                              ? "Balance sheet PDF"
                              : "Reporting pack CSV"}{" "}
                          | {job.status} | {new Date(job.createdAt).toLocaleString()}
                        </span>
                        <a className="underline underline-offset-2" href={job.downloadUrl} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => setSelectedHistoryJobId(job.id)}>
                          View details
                        </Button>
                      </div>
                      {job.failReason ? <p className="mt-1 text-xs text-amber-700">{job.failReason}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
              {selectedHistoryJob ? (
                <Card className="mt-2">
                  <CardHeader>
                    <CardTitle>Queued export job details</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm">
                    <p>Job ID: {selectedHistoryJob.id}</p>
                    <p>
                      Type:{" "}
                      {selectedHistoryJob.type === "balance_sheet_csv"
                        ? "Balance sheet CSV"
                        : selectedHistoryJob.type === "balance_sheet_pdf"
                          ? "Balance sheet PDF"
                          : "Reporting pack CSV"}
                    </p>
                    <p>Status: {selectedHistoryJob.status}</p>
                    <p>As-of date: {selectedHistoryJob.asOf || "-"}</p>
                    <p>Sort: {selectedHistoryJob.sortBy || "code"} ({selectedHistoryJob.sortDir || "asc"})</p>
                    <p>Requested by: {selectedHistoryJob.requestedBy || "Unknown admin"}</p>
                    <p>Created: {new Date(selectedHistoryJob.createdAt).toLocaleString()}</p>
                    <p>Expires: {new Date(selectedHistoryJob.expiresAt).toLocaleString()}</p>
                    <a className="underline underline-offset-2" href={selectedHistoryJob.downloadUrl} target="_blank" rel="noreferrer">
                      Open queued export download
                    </a>
                  </CardContent>
                </Card>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
      {printMode ? (
        <p className="text-xs text-muted-foreground">
          Print mode is active. Filters and action controls are hidden for a cleaner print layout.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Comparison</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
          <div className="rounded border p-3">
            <Tooltip content="Signed total assets as-of date from posted ledger lines. Formula: sum(ASSET account net balances).">
              <div className="text-muted-foreground cursor-help">Assets (net signed)</div>
            </Tooltip>
            <div className="font-semibold">{formatCurrency(currentAssets)}</div>
          </div>
          <div className="rounded border p-3">
            <Tooltip content="Signed assets for the selected comparison period.">
              <div className="text-muted-foreground cursor-help">
                {comparisonMode === "prior_period_end" ? "Assets (previous period end)" : "Assets (prior day signed)"}
              </div>
            </Tooltip>
            <div className="font-semibold">{priorAssets === null ? "Not available" : formatCurrency(priorAssets)}</div>
          </div>
          <div className="rounded border p-3">
            <Tooltip content="Delta = Assets (net signed) - Assets (prior day signed).">
              <div className="text-muted-foreground cursor-help">Delta</div>
            </Tooltip>
            <div className="font-semibold">
              {assetsDelta === null ? "Not available" : (
                <>
                  {assetsDelta >= 0 ? "+" : ""}{formatCurrency(assetsDelta)}
                  {assetsDeltaPct !== null ? ` (${assetsDeltaPct >= 0 ? "+" : ""}${assetsDeltaPct.toFixed(2)}%)` : ""}
                </>
              )}
            </div>
          </div>
          <div className="rounded border p-3">
            <Tooltip content="Working capital = Current assets (liquidity) - Current liabilities (liquidity).">
              <div className="text-muted-foreground cursor-help">Working capital</div>
            </Tooltip>
            <div className="font-semibold">{formatCurrency(workingCapital)}</div>
          </div>
          <div className="rounded border p-3">
            <Tooltip content="Current ratio = Current assets (liquidity) / Current liabilities (liquidity).">
              <div className="text-muted-foreground cursor-help">Current ratio</div>
            </Tooltip>
            <div className="font-semibold">{currentRatio === null ? "Not available" : `${currentRatio.toFixed(2)}x`}</div>
          </div>
        </CardContent>
      </Card>
      {previousError ? (
        <p className="text-xs text-amber-700" aria-live="polite">
          {comparisonMode === "prior_period_end"
            ? "Previous period-end comparison could not be loaded. Totals still reflect the selected as-of date."
            : "Prior-day comparison could not be loaded. Totals still reflect the selected as-of date."}
        </p>
      ) : null}
      {deltaWarningTriggered ? (
        <Card>
          <CardHeader>
            <CardTitle>Data quality warning</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="text-amber-700" aria-live="polite">
              Assets moved by {assetsDeltaPct?.toFixed(2)}%, which is above your warning threshold of{" "}
              {deltaWarningThresholdPct.toFixed(2)}%. Review major postings before sharing this report.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Liquidity Basis</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="rounded border p-3">
            <Tooltip content="Liquidity current assets use only positive current-asset balances. Negative cash/bank balances are excluded here and reclassified to liabilities.">
              <div className="text-muted-foreground cursor-help">Current assets (liquidity)</div>
            </Tooltip>
            <div className="font-semibold">{formatCurrency(liquidityCurrentAssets)}</div>
          </div>
          <div className="rounded border p-3">
            <Tooltip content="Liquidity current liabilities = positive current liabilities + overdraft reclass - liability debit offsets (prepayments/over-settlement).">
              <div className="text-muted-foreground cursor-help">Current liabilities (liquidity)</div>
            </Tooltip>
            <div className="font-semibold">{formatCurrency(liquidityCurrentLiabilities)}</div>
            {overdraftReclass > 0 ? (
              <div className="text-xs text-muted-foreground mt-1">
                Includes overdraft reclass: {formatCurrency(overdraftReclass)}
              </div>
            ) : null}
            {currentLiabilityDebitOffsets > 0 ? (
              <div className="text-xs text-muted-foreground">
                Less debit offsets: {formatCurrency(currentLiabilityDebitOffsets)}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Assets</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {isLoading ? <p className="text-muted-foreground">Loading...</p> : (
            <>
              <div className="font-medium text-xs uppercase text-muted-foreground pt-1">Current assets</div>
              {renderRows(currentAssetsRows, true, "ASSET")}
              <div className="font-medium text-xs uppercase text-muted-foreground pt-2">Non-current assets</div>
              {renderRows(nonCurrentAssetsRows, true, "ASSET")}
            </>
          )}
          {isLoading ? (
            <div className="space-y-2 animate-pulse">
              <div className="h-4 rounded bg-muted" />
              <div className="h-4 rounded bg-muted" />
              <div className="h-4 rounded bg-muted" />
            </div>
          ) : null}
          <div className="flex justify-between font-semibold pt-2 border-t">
            <span>Total assets</span>
            <span>{formatCurrency(data?.totals?.assets || 0)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Liabilities</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {isLoading ? <p className="text-muted-foreground">Loading...</p> : (
            <>
              <div className="font-medium text-xs uppercase text-muted-foreground pt-1">Current liabilities</div>
              {renderRows(currentLiabilityRows, false, "LIABILITY")}
              <div className="font-medium text-xs uppercase text-muted-foreground pt-2">Non-current liabilities</div>
              {renderRows(nonCurrentLiabilityRows, false, "LIABILITY")}
            </>
          )}
          {isLoading ? (
            <div className="space-y-2 animate-pulse">
              <div className="h-4 rounded bg-muted" />
              <div className="h-4 rounded bg-muted" />
              <div className="h-4 rounded bg-muted" />
            </div>
          ) : null}
          <div className="flex justify-between font-semibold pt-2 border-t">
            <span>Total liabilities (credit balances)</span>
            <span>
              {formatCurrency(
                showSignedValues ? data?.totals?.liabilities || 0 : liabilitiesCreditTotal,
              )}
            </span>
          </div>
          {!showSignedValues && liabilitiesDebitOffsetTotal > 0 ? (
            <div className="flex justify-between text-xs text-amber-700">
              <span>Debit balance offsets (prepayments/over-settlement)</span>
              <span>{formatCurrency(liabilitiesDebitOffsetTotal)}</span>
            </div>
          ) : null}
          {!showSignedValues ? (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Net liabilities (signed)</span>
              <span className={liabilitiesNetSigned < 0 ? "text-amber-700" : undefined}>
                {liabilitiesNetSigned < 0 ? "Debit " : ""}
                {formatCurrency(Math.abs(liabilitiesNetSigned))}
              </span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Equity</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {isLoading ? <p className="text-muted-foreground">Loading...</p> : renderRows(equity, false, "EQUITY")}
          {isLoading ? (
            <div className="space-y-2 animate-pulse">
              <div className="h-4 rounded bg-muted" />
              <div className="h-4 rounded bg-muted" />
            </div>
          ) : null}
          <div className="flex justify-between font-semibold pt-2 border-t">
            <span>Total equity</span>
            <span>{formatCurrency(showSignedValues ? data?.totals?.equity || 0 : Math.abs(data?.totals?.equity || 0))}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Totals</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          <div className="flex justify-between">
            <span>Assets</span>
            <span>{formatCurrency(data?.totals?.assets || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span>Liabilities + Equity</span>
            <span>{formatCurrency(data?.totals?.liabilitiesPlusEquity || 0)}</span>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Balance Check</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          <div className="flex justify-between">
            <span>Difference (Assets - Liabilities + Equity)</span>
            <span className={isBalanced ? "text-emerald-700" : "text-amber-700"}>
              {formatCurrency(balanceDifference)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">Tolerance: {formatCurrency(balanceTolerance)}</p>
          <p className={isBalanced ? "text-xs text-emerald-700" : "text-xs text-amber-700"}>
            {isBalanced
              ? "Balanced. Assets match liabilities plus equity."
              : "Not balanced. Review recent postings and current-period profit/loss values."}
          </p>
        </CardContent>
      </Card>
      {!printMode ? (
        <Card>
          <CardHeader>
            <CardTitle>Report performance</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <p>Last load time: {lastLoadDurationMs === null ? "Not measured yet" : `${lastLoadDurationMs.toFixed(0)} ms`}</p>
            <p>Last export time: {lastExportDurationMs === null ? "Not measured yet" : `${lastExportDurationMs.toFixed(0)} ms`}</p>
          </CardContent>
        </Card>
      ) : null}
      {!printMode && lastExportStatus ? (
        <Card>
          <CardHeader>
            <CardTitle>Latest export status</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1" aria-live="polite">
            <p>Type: {lastExportStatus.type === "balance_sheet_csv" ? "Balance sheet CSV" : lastExportStatus.type === "balance_sheet_pdf" ? "Balance sheet PDF" : "Reporting pack CSV"}</p>
            <p>Status: {lastExportStatus.status === "success" ? "Success" : "Failed"}</p>
            <p>Time: {new Date(lastExportStatus.at).toLocaleString()}</p>
            <p>{lastExportStatus.message}</p>
            <p>
              Correlation ID: <span className="font-mono">{lastExportStatus.correlationId}</span>
            </p>
            <Link className="underline underline-offset-2" href={exportAuditLink}>
              Open export audit events
            </Link>
          </CardContent>
        </Card>
      ) : null}
      {reportError ? (
        <Card>
          <CardHeader>
            <CardTitle>Report error</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm" aria-live="polite">
            <p>{reportError instanceof Error ? reportError.message : "Failed to load balance sheet report."}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void refetchReport();
                void refetchPreviousReport();
              }}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

