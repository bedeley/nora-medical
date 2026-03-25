"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Lock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/currency";
import { hasPermission } from "@/lib/permissions";
import { toast } from "sonner";

type LedgerAccount = {
  id: string;
  code: string;
  name: string;
  type: string;
};

type JournalLine = {
  id: string;
  debit: number | string;
  credit: number | string;
  account: LedgerAccount;
  taxCode?: { id: string; name: string } | null;
  description?: string | null;
};

type JournalEntry = {
  id: string;
  entryDate: string;
  memo?: string | null;
  sourceType: string;
  sourceId?: string | null;
  sourceLabel?: string | null;
  status: string;
  archivedAt?: string | null;
  approvedBy?: { id: string; name: string | null; email: string | null } | null;
  approvedAt?: string | null;
  lines: JournalLine[];
  apBalanceAfter?: number | null;
};
type JournalListResponse = {
  items: JournalEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type TaxCode = {
  id: string;
  name: string;
  rate: number | string;
  type: string;
};

type FiscalPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
};
type JournalPolicy = {
  recentWindowDays: number;
  manualEntryAllowPnl: boolean;
  archiveAfterMonths: number;
  archiveCronDryRun: boolean;
};

type JournalSavedView = {
  id: string;
  name: string;
  state: {
    periodFilter: string;
    statusFilter: string;
    sourceFilter: string;
    dateStart: string;
    dateEnd: string;
    searchQuery: string;
    linkQuery: string;
    accountQuery: string;
    entryDirectionFilter: string;
    outOfBalanceOnly: boolean;
    includeArchive: boolean;
    accountFilterId: string;
    rowsPerPage: 25 | 50 | 100;
    rowDensity?: "comfortable" | "compact";
    largestVarianceFirst?: boolean;
    reviewMode?: boolean;
    exceptionMissingRefOnly?: boolean;
    exceptionLargeAmountOnly?: boolean;
    exceptionStaleDraftOnly?: boolean;
    sortBy?: "date" | "status" | "amount";
    sortDir?: "asc" | "desc";
  };
};

type ManualCategory =
  | "PERIOD_END_ADJUSTMENT"
  | "CORRECTION"
  | "RECLASSIFICATION"
  | "ACCRUAL_DEFERRAL"
  | "OTHER_EXCEPTION";

const MANUAL_CATEGORY_OPTIONS: Array<{ value: ManualCategory; label: string }> = [
  { value: "PERIOD_END_ADJUSTMENT", label: "Period-end adjustment" },
  { value: "CORRECTION", label: "Correction" },
  { value: "RECLASSIFICATION", label: "Reclassification" },
  { value: "ACCRUAL_DEFERRAL", label: "Accrual / deferral" },
  { value: "OTHER_EXCEPTION", label: "Other exception" },
];

function getEntryImbalance(entry: JournalEntry) {
  const debitTotal = entry.lines?.reduce((sum, line) => sum + Number(line.debit || 0), 0) || 0;
  const creditTotal = entry.lines?.reduce((sum, line) => sum + Number(line.credit || 0), 0) || 0;
  return debitTotal - creditTotal;
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export default function JournalPage() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role || "";
  const canApprove = hasPermission(role, "journal.approve");
  const canArchive = role === "ADMIN";
  const { data: accountsData } = useClientQuery<LedgerAccount[]>({
    queryKey: ["accounting", "accounts"],
    queryFn: () => fetch("/api/admin/accounting/accounts").then((r) => r.json()),
  });
  const { data: periodsData } = useClientQuery<FiscalPeriod[]>({
    queryKey: ["accounting", "periods"],
    queryFn: () => fetch("/api/admin/accounting/periods").then((r) => r.json()),
  });
  const { data: taxCodesData } = useClientQuery<TaxCode[]>({
    queryKey: ["accounting", "tax-codes"],
    queryFn: () => fetch("/api/admin/accounting/tax-codes").then((r) => r.json()),
  });
  const { data: journalPolicyData } = useClientQuery<{ policy?: JournalPolicy | null }>({
    queryKey: ["accounting", "journal", "policy"],
    queryFn: () => fetch("/api/admin/accounting/journal/policy").then((r) => r.json()),
  });
  const periods = useMemo(() => (Array.isArray(periodsData) ? periodsData : []), [periodsData]);
  const taxCodes = useMemo(() => (Array.isArray(taxCodesData) ? taxCodesData : []), [taxCodesData]);

  const currentOpenPeriod = useMemo(() => {
    const today = new Date();
    return periods.find((period) => {
      if (period.status !== "OPEN") return false;
      const start = new Date(period.startDate);
      const end = new Date(period.endDate);
      return today >= start && today <= end;
    });
  }, [periods]);

  const initialPeriodFilter = String(searchParams.get("period") || "recent");
  const [periodFilter, setPeriodFilter] = useState(initialPeriodFilter);
  const hasUserSelected = useRef(Boolean(searchParams.get("period")));
  const [statusFilter, setStatusFilter] = useState(() => String(searchParams.get("status") || ""));
  const [sourceFilter, setSourceFilter] = useState(() => String(searchParams.get("sourceType") || ""));
  const [dateStart, setDateStart] = useState(() => String(searchParams.get("start") || ""));
  const [dateEnd, setDateEnd] = useState(() => String(searchParams.get("end") || ""));
  const [searchQuery, setSearchQuery] = useState(() => String(searchParams.get("q") || ""));
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 400);
  const [linkQuery, setLinkQuery] = useState(() => String(searchParams.get("link") || ""));
  const [accountQuery, setAccountQuery] = useState(() => String(searchParams.get("account") || ""));
  const [entryDirectionFilter, setEntryDirectionFilter] = useState(() => {
    const raw = String(searchParams.get("entryDir") || "").toLowerCase();
    return raw === "debit" || raw === "credit" ? raw : "";
  });
  const [rowDensity, setRowDensity] = useState<"comfortable" | "compact">("comfortable");
  const [outOfBalanceOnly, setOutOfBalanceOnly] = useState(
    () => String(searchParams.get("outOfBalance") || "") === "1",
  );
  const [includeArchive, setIncludeArchive] = useState(
    () => String(searchParams.get("includeArchive") || "") === "1",
  );
  const [accountFilterId, setAccountFilterId] = useState(() => String(searchParams.get("accountId") || ""));
  const [savedViews, setSavedViews] = useState<JournalSavedView[]>([]);
  const [selectedViewId, setSelectedViewId] = useState("");
  const [defaultViewId, setDefaultViewId] = useState("");
  const [autoRestoreLastView, setAutoRestoreLastView] = useState(true);
  const [lastUsedViewId, setLastUsedViewId] = useState("");
  const [page, setPage] = useState(() => {
    const raw = Number(searchParams.get("page") || "1");
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
  });
  const [rowsPerPage, setRowsPerPage] = useState<25 | 50 | 100>(() => {
    const raw = Number(searchParams.get("rows") || "25");
    return raw === 25 || raw === 50 || raw === 100 ? raw : 25;
  });
  const [goToPageInput, setGoToPageInput] = useState("");
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [showOnboardingTip, setShowOnboardingTip] = useState(false);
  const [prefsHydrated, setPrefsHydrated] = useState(false);
  const hasAppliedStartupView = useRef(false);
  const [exceptionMissingRefOnly, setExceptionMissingRefOnly] = useState(false);
  const [exceptionLargeAmountOnly, setExceptionLargeAmountOnly] = useState(false);
  const [exceptionStaleDraftOnly, setExceptionStaleDraftOnly] = useState(false);
  const [largestVarianceFirst, setLargestVarianceFirst] = useState(
    () => String(searchParams.get("varianceSort") || "") === "1",
  );
  const [reviewMode, setReviewMode] = useState(
    () => String(searchParams.get("reviewMode") || "") === "1",
  );
  const [showAdvancedJournalFilters, setShowAdvancedJournalFilters] = useState(false);
  const [sortBy, setSortBy] = useState<"date" | "status" | "amount">(() => {
    const raw = String(searchParams.get("sortBy") || "date").toLowerCase();
    return raw === "status" || raw === "amount" ? raw : "date";
  });
  const [sortDir, setSortDir] = useState<"asc" | "desc">(() => {
    const raw = String(searchParams.get("sortDir") || "desc").toLowerCase();
    return raw === "asc" ? "asc" : "desc";
  });
  const [archiveMonths, setArchiveMonths] = useState(18);
  const archiveMonthsTouched = useRef(false);
  const [archiveRunning, setArchiveRunning] = useState(false);
  const [archiveEligibleCount, setArchiveEligibleCount] = useState<number | null>(null);
  const [lastArchiveRunAt, setLastArchiveRunAt] = useState<string | null>(null);
  const [undoArchiveUntilMs, setUndoArchiveUntilMs] = useState<number | null>(null);
  const [undoClockMs, setUndoClockMs] = useState<number>(Date.now());
  const mobileFiltersAutoCollapsed = useRef(false);
  useEffect(() => {
    if (hasUserSelected.current) return;
    setPeriodFilter("recent");
  }, []);
  useEffect(() => {
    const policyMonths = Number(journalPolicyData?.policy?.archiveAfterMonths || 0);
    if (!Number.isFinite(policyMonths) || policyMonths <= 0) return;
    if (archiveMonthsTouched.current) return;
    setArchiveMonths(Math.max(1, Math.min(120, Math.floor(policyMonths))));
  }, [journalPolicyData?.policy?.archiveAfterMonths]);
  useEffect(() => {
    if (!undoArchiveUntilMs) return;
    const timer = window.setInterval(() => setUndoClockMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [undoArchiveUntilMs]);
  useEffect(() => {
    const onScroll = () => {
      if (typeof window === "undefined") return;
      if (window.innerWidth >= 640) return;
      if (mobileFiltersAutoCollapsed.current) return;
      if (!showAdvancedJournalFilters) return;
      if (window.scrollY < 120) return;
      setShowAdvancedJournalFilters(false);
      mobileFiltersAutoCollapsed.current = true;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [showAdvancedJournalFilters]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("accounting.journal.savedViews.v1");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) setSavedViews(parsed as JournalSavedView[]);
    } catch {
      // ignore malformed saved views
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const seen = window.localStorage.getItem("accounting.journal.onboardingSeen.v1");
    setShowOnboardingTip(seen !== "1");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("accounting.journal.savedViews.v1", JSON.stringify(savedViews));
  }, [savedViews]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("accounting.journal.preferences.v1");
    if (!raw) {
      setPrefsHydrated(true);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as {
        defaultViewId?: string;
        autoRestoreLastView?: boolean;
        lastUsedViewId?: string;
        rowsPerPage?: number;
        lastPage?: number;
        sortBy?: "date" | "status" | "amount";
        sortDir?: "asc" | "desc";
      };
      setDefaultViewId(parsed.defaultViewId || "");
      setAutoRestoreLastView(parsed.autoRestoreLastView !== false);
      setLastUsedViewId(parsed.lastUsedViewId || "");
      if (parsed.rowsPerPage === 25 || parsed.rowsPerPage === 50 || parsed.rowsPerPage === 100) {
        setRowsPerPage(parsed.rowsPerPage);
      }
      if (Number.isFinite(parsed.lastPage) && Number(parsed.lastPage) > 0) {
        setPage(Number(parsed.lastPage));
      }
      if (parsed.sortBy === "status" || parsed.sortBy === "amount" || parsed.sortBy === "date") {
        setSortBy(parsed.sortBy);
      }
      if (parsed.sortDir === "asc" || parsed.sortDir === "desc") {
        setSortDir(parsed.sortDir);
      }
    } catch {
      // ignore malformed preferences
    } finally {
      setPrefsHydrated(true);
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined" || !prefsHydrated) return;
    window.localStorage.setItem(
      "accounting.journal.preferences.v1",
      JSON.stringify({
        defaultViewId,
        autoRestoreLastView,
        lastUsedViewId,
        rowsPerPage,
        lastPage: page,
        sortBy,
        sortDir,
      }),
    );
  }, [defaultViewId, autoRestoreLastView, lastUsedViewId, rowsPerPage, page, prefsHydrated, sortBy, sortDir]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const write = (key: string, value: string) => {
      if (value) params.set(key, value);
      else params.delete(key);
    };
    write("period", periodFilter && periodFilter !== "recent" ? periodFilter : "");
    write("status", statusFilter);
    write("sourceType", sourceFilter);
    write("start", dateStart);
    write("end", dateEnd);
    write("q", searchQuery.trim());
    write("link", linkQuery.trim());
    write("account", accountQuery.trim());
    write("entryDir", entryDirectionFilter);
    write("outOfBalance", outOfBalanceOnly ? "1" : "");
    write("includeArchive", includeArchive ? "1" : "");
    write("varianceSort", largestVarianceFirst ? "1" : "");
    write("reviewMode", reviewMode ? "1" : "");
    write("sortBy", sortBy !== "date" ? sortBy : "");
    write("sortDir", sortDir !== "desc" ? sortDir : "");
    write("accountId", accountFilterId);
    write("page", page > 1 ? String(page) : "");
    write("rows", rowsPerPage !== 25 ? String(rowsPerPage) : "");
    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    window.history.replaceState(null, "", nextUrl);
  }, [
    periodFilter,
    statusFilter,
    sourceFilter,
    dateStart,
    dateEnd,
    searchQuery,
    linkQuery,
    accountQuery,
    entryDirectionFilter,
    outOfBalanceOnly,
    includeArchive,
    largestVarianceFirst,
    reviewMode,
    sortBy,
    sortDir,
    accountFilterId,
    page,
    rowsPerPage,
  ]);

  const selectedPeriod = useMemo(() => {
    if (periodFilter === "recent") return null;
    if (periodFilter === "all_non_archived") return null;
    if (periodFilter === "current") return currentOpenPeriod;
    if (periodFilter === "all") return null;
    return periods.find((period) => period.id === periodFilter) || null;
  }, [periodFilter, periods, currentOpenPeriod]);
  const scopeLabel = useMemo(() => {
    if (dateStart || dateEnd) return "Custom date range";
    if (periodFilter === "recent") return "Recent 90 days";
    if (periodFilter === "all_non_archived") return "All non-archived";
    if (periodFilter === "current") return "Current open period";
    if (periodFilter === "all") return "All time";
    if (selectedPeriod?.name) return selectedPeriod.name;
    return "Recent 90 days";
  }, [dateStart, dateEnd, periodFilter, selectedPeriod]);

  const { data: entriesData, isLoading, isFetching, error: entriesError, refetch: refetchEntries } = useClientQuery<JournalListResponse>({
    queryKey: [
      "accounting",
      "journal",
      selectedPeriod?.id || periodFilter || "recent",
      statusFilter,
      sourceFilter,
      dateStart,
      dateEnd,
      includeArchive,
      debouncedSearchQuery,
      page,
      rowsPerPage,
      sortBy,
      sortDir,
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("paginate", "1");
      params.set("page", String(page));
      params.set("pageSize", String(rowsPerPage));
      const hasCustomDates = dateStart || dateEnd;
      if (hasCustomDates) {
        if (dateStart) params.set("start", dateStart);
        if (dateEnd) params.set("end", dateEnd);
      } else if (selectedPeriod) {
        params.set("start", selectedPeriod.startDate.slice(0, 10));
        params.set("end", selectedPeriod.endDate.slice(0, 10));
      }
      if (statusFilter) params.set("status", statusFilter);
      if (sourceFilter) params.set("sourceType", sourceFilter);
      if (includeArchive) params.set("includeArchive", "1");
      if (debouncedSearchQuery.trim()) params.set("q", debouncedSearchQuery.trim());
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      const suffix = params.toString();
      return fetch(`/api/admin/accounting/journal${suffix ? `?${suffix}` : ""}`).then(async (r) => {
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) {
          const message = String((payload as { error?: unknown })?.error || "Failed to load journal entries.");
          throw new Error(message);
        }
        return payload as JournalListResponse;
      });
    },
  });
  const { data: balanceEntriesData } = useClientQuery<JournalEntry[]>({
    queryKey: [
      "accounting",
      "journal-balance",
      statusFilter,
      includeArchive,
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (includeArchive) params.set("includeArchive", "1");
      const suffix = params.toString();
      return fetch(`/api/admin/accounting/journal${suffix ? `?${suffix}` : ""}`).then((r) => r.json());
    },
  });
  const accounts = useMemo(() => (Array.isArray(accountsData) ? accountsData : []), [accountsData]);
  const entries = useMemo(
    () => (Array.isArray(entriesData?.items) ? entriesData.items : []),
    [entriesData?.items],
  );
  const searchQueryPending = debouncedSearchQuery !== searchQuery;
  const queryError = entriesError instanceof Error ? entriesError.message : "";
  const totalEntries = Number(entriesData?.total || 0);
  const totalPages = Math.max(1, Number(entriesData?.totalPages || 1));
  const balanceEntries = Array.isArray(balanceEntriesData) ? balanceEntriesData : entries;
  const { data: archiveAuditRaw } = useClientQuery<
    Array<{ action?: string; createdAt?: string; actor?: { name?: string | null; email?: string | null } | null; meta?: Record<string, unknown> | null }>
  >({
    queryKey: ["admin", "audit", "journal-archive-runs"],
    queryFn: () =>
      fetch("/api/admin/audit?entityType=JournalEntry&limit=100")
        .then((r) => r.json())
        .catch(() => []),
  });
  const archiveAuditRows = useMemo(
    () =>
      (Array.isArray(archiveAuditRaw) ? archiveAuditRaw : []).filter((row) =>
        String(row?.action || "").startsWith("journal.archive"),
      ),
    [archiveAuditRaw],
  );
  const latestCronArchiveRun = useMemo(
    () =>
      archiveAuditRows.find(
        (row) =>
          row.action === "journal.archive.cron.run" || row.action === "journal.archive.cron.dry_run",
      ) || null,
    [archiveAuditRows],
  );
  const archiveTimelineRows = useMemo(() => {
    const rows = [...archiveAuditRows].sort((a, b) => {
      const at = new Date(String(a.createdAt || "")).getTime();
      const bt = new Date(String(b.createdAt || "")).getTime();
      return bt - at;
    });
    return rows.slice(0, 6).map((row) => {
      const meta = (row.meta || {}) as Record<string, unknown>;
      const actor = row.actor?.name || row.actor?.email || "System";
      const action = String(row.action || "");
      const when = row.createdAt ? new Date(row.createdAt).toLocaleString() : "Unknown time";
      if (action === "journal.archive.undo") {
        return `${when}: ${actor} restored ${Number(meta.restoredCount || 0)} archived entr${Number(meta.restoredCount || 0) === 1 ? "y" : "ies"}.`;
      }
      if (action.includes("dry_run")) {
        return `${when}: ${actor} ran archive dry run. ${Number(meta.candidateCount || 0)} entr${Number(meta.candidateCount || 0) === 1 ? "y is" : "ies are"} currently eligible.`;
      }
      if (action.includes("archive.run") || action.includes("archive.cron.run")) {
        return `${when}: ${actor} archived ${Number(meta.archivedCount || 0)} entr${Number(meta.archivedCount || 0) === 1 ? "y" : "ies"} using ${Number(meta.months || 0)} month cutoff.`;
      }
      return `${when}: ${actor} recorded ${action}.`;
    });
  }, [archiveAuditRows]);
  const filteredEntries = useMemo(() => {
    const raw = "";
    const linkRaw = linkQuery.trim().toLowerCase();
    const accountRaw = accountQuery.trim().toLowerCase();
    if (
      !raw &&
      !linkRaw &&
      !accountRaw &&
      !accountFilterId &&
      !entryDirectionFilter &&
      !outOfBalanceOnly &&
      !exceptionMissingRefOnly &&
      !exceptionLargeAmountOnly &&
      !exceptionStaleDraftOnly
    ) {
      return entries;
    }
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normalizedQuery = normalize(raw);
    const normalizedLinkQuery = normalize(linkRaw);
    const normalizedAccountQuery = normalize(accountRaw);
    const matchesAccount = (line: JournalLine) => {
      const code = line.account?.code || "";
      const name = line.account?.name || "";
      const composite = `${code} ${name}`;
      return (
        code.toLowerCase().includes(accountRaw) ||
        name.toLowerCase().includes(accountRaw) ||
        composite.toLowerCase().includes(accountRaw) ||
        (normalizedAccountQuery && normalize(composite).includes(normalizedAccountQuery))
      );
    };
    return entries.filter((entry) => {
      const isBalanced = Math.abs(getEntryImbalance(entry)) <= 0.01;
      const debitTotal = entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
      const creditTotal = entry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
      const missingReferenceRisk =
        entry.status === "POSTED" &&
        entry.sourceType !== "MANUAL" &&
        !String(entry.sourceId || "").trim() &&
        !String(entry.sourceLabel || "").trim();
      const unusualAmountRisk = Math.max(Math.abs(debitTotal), Math.abs(creditTotal)) >= 25000;
      const staleDraftRisk =
        entry.status === "DRAFT" &&
        (Date.now() - new Date(entry.entryDate).getTime()) / (1000 * 60 * 60 * 24) >= 7;
      if (outOfBalanceOnly && isBalanced) return false;
      if (exceptionMissingRefOnly && !missingReferenceRisk) return false;
      if (exceptionLargeAmountOnly && !unusualAmountRisk) return false;
      if (exceptionStaleDraftOnly && !staleDraftRisk) return false;

      if (accountFilterId) {
        const hasSelectedAccount = entry.lines?.some((line) => line.account?.id === accountFilterId);
        if (!hasSelectedAccount) return false;
      }
      if (accountRaw) {
        const accountMatches = entry.lines?.some((line) => matchesAccount(line));
        if (!accountMatches) return false;
      }
      if (entryDirectionFilter) {
        const relevantLines = (entry.lines || []).filter((line) => {
          if (accountFilterId && line.account?.id !== accountFilterId) return false;
          if (accountRaw && !matchesAccount(line)) return false;
          return true;
        });
        if (relevantLines.length === 0) return false;
        const hasDirectionMatch = relevantLines.some((line) => {
          const debit = Number(line.debit || 0);
          const credit = Number(line.credit || 0);
          return entryDirectionFilter === "debit" ? debit > credit : credit > debit;
        });
        if (!hasDirectionMatch) return false;
      }
      if (linkRaw) {
        const linkCandidates = [
          entry.sourceId || "",
          entry.sourceLabel || "",
          entry.memo || "",
          ...((entry.lines || []).map((line) => line.description || "")),
        ];
        const linkMatch = linkCandidates.some(
          (value) =>
            value.toLowerCase().includes(linkRaw) ||
            (normalizedLinkQuery && normalize(value).includes(normalizedLinkQuery)),
        );
        if (!linkMatch) return false;
      }
      if (!raw) return true;
      const memo = entry.memo || "";
      const sourceType = entry.sourceType || "";
      const sourceId = entry.sourceId || "";
      const sourceLabel = entry.sourceLabel || "";
      const candidates = [memo, sourceType, sourceId, sourceLabel];
      if (
        candidates.some(
          (value) =>
            value.toLowerCase().includes(raw) ||
            (normalizedQuery && normalize(value).includes(normalizedQuery)),
        )
      ) {
        return true;
      }
      return entry.lines?.some((line) => {
        const description = line.description || "";
        return (
          description.toLowerCase().includes(raw) ||
          (normalizedQuery && normalize(description).includes(normalizedQuery))
        );
      });
    });
  }, [
    entries,
    linkQuery,
    accountQuery,
    accountFilterId,
    outOfBalanceOnly,
    entryDirectionFilter,
    exceptionMissingRefOnly,
    exceptionLargeAmountOnly,
    exceptionStaleDraftOnly,
  ]);
  const sourceChipOptions = ["ORDER", "PAYMENT", "PURCHASE", "EXPENSE", "MANUAL", "PAYROLL"] as const;
  const sourceCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of entries) {
      const src = String(entry.sourceType || "").toUpperCase();
      map.set(src, (map.get(src) || 0) + 1);
    }
    return map;
  }, [entries]);
  const periodSummary = useMemo(() => {
    return filteredEntries.reduce(
      (acc, entry) => {
        const debitTotal = entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
        const creditTotal = entry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
        acc.total += 1;
        if (entry.status === "POSTED") acc.posted += 1;
        if (entry.status === "DRAFT") acc.draft += 1;
        if (entry.status === "VOID") acc.void += 1;
        acc.debit += debitTotal;
        acc.credit += creditTotal;
        return acc;
      },
      { total: 0, posted: 0, draft: 0, void: 0, debit: 0, credit: 0 },
    );
  }, [filteredEntries]);
  const draftQueue = useMemo(() => {
    const drafts = entries
      .filter((entry) => entry.status === "DRAFT")
      .sort((a, b) => new Date(a.entryDate).getTime() - new Date(b.entryDate).getTime());
    const oldest = drafts[0] || null;
    const oldestAgeDays = oldest
      ? Math.floor((Date.now() - new Date(oldest.entryDate).getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    return {
      count: drafts.length,
      oldest,
      oldestAgeDays,
    };
  }, [entries]);
  const saveCurrentView = () => {
    if (typeof window === "undefined") return;
    const name = window.prompt("Name this saved journal view");
    if (!name) return;
    const entry: JournalSavedView = {
      id: String(Date.now()),
      name,
      state: {
        periodFilter,
        statusFilter,
        sourceFilter,
        dateStart,
        dateEnd,
        searchQuery,
        linkQuery,
        accountQuery,
        entryDirectionFilter,
        outOfBalanceOnly,
        includeArchive,
        accountFilterId,
        rowsPerPage,
        rowDensity,
        largestVarianceFirst,
        reviewMode,
        exceptionMissingRefOnly,
        exceptionLargeAmountOnly,
        exceptionStaleDraftOnly,
        sortBy,
        sortDir,
      },
    };
    setSavedViews((prev) => [entry, ...prev]);
    setSelectedViewId(entry.id);
    toast.success("Saved journal view.");
  };
  const applySavedView = useCallback((id: string) => {
    const view = savedViews.find((v) => v.id === id);
    if (!view) return;
    hasUserSelected.current = true;
    setSelectedViewId(view.id);
    setPeriodFilter(view.state.periodFilter || "recent");
    setStatusFilter(view.state.statusFilter || "");
    setSourceFilter(view.state.sourceFilter || "");
    setDateStart(view.state.dateStart || "");
    setDateEnd(view.state.dateEnd || "");
    setSearchQuery(view.state.searchQuery || "");
    setLinkQuery(view.state.linkQuery || "");
    setAccountQuery(view.state.accountQuery || "");
    setEntryDirectionFilter(view.state.entryDirectionFilter || "");
    setOutOfBalanceOnly(Boolean(view.state.outOfBalanceOnly));
    setIncludeArchive(Boolean(view.state.includeArchive));
    setAccountFilterId(view.state.accountFilterId || "");
    setRowDensity(view.state.rowDensity === "compact" ? "compact" : "comfortable");
    setLargestVarianceFirst(Boolean(view.state.largestVarianceFirst));
    setReviewMode(Boolean(view.state.reviewMode));
    setExceptionMissingRefOnly(Boolean(view.state.exceptionMissingRefOnly));
    setExceptionLargeAmountOnly(Boolean(view.state.exceptionLargeAmountOnly));
    setExceptionStaleDraftOnly(Boolean(view.state.exceptionStaleDraftOnly));
    setSortBy(view.state.sortBy === "status" || view.state.sortBy === "amount" ? view.state.sortBy : "date");
    setSortDir(view.state.sortDir === "asc" ? "asc" : "desc");
    if (view.state.rowsPerPage === 25 || view.state.rowsPerPage === 50 || view.state.rowsPerPage === 100) {
      setRowsPerPage(view.state.rowsPerPage);
    }
    setLastUsedViewId(view.id);
    toast.success(`Applied "${view.name}".`);
  }, [savedViews]);
  const removeSavedView = (id: string) => {
    setSavedViews((prev) => prev.filter((view) => view.id !== id));
    if (selectedViewId === id) setSelectedViewId("");
    if (defaultViewId === id) setDefaultViewId("");
    if (lastUsedViewId === id) setLastUsedViewId("");
  };
  const renameSelectedView = () => {
    if (!selectedViewId) return;
    const current = savedViews.find((v) => v.id === selectedViewId);
    if (!current) return;
    const name = window.prompt("Rename saved journal view", current.name)?.trim();
    if (!name) return;
    setSavedViews((prev) => prev.map((v) => (v.id === selectedViewId ? { ...v, name } : v)));
    toast.success("Saved view renamed.");
  };
  const applyQuickPreset = (preset: "today_posted" | "draft_only" | "payments_today") => {
    const today = new Date().toISOString().slice(0, 10);
    hasUserSelected.current = true;
    if (preset === "today_posted") {
      setIncludeArchive(false);
      setStatusFilter("POSTED");
      setSourceFilter("");
      setDateStart(today);
      setDateEnd(today);
      setSearchQuery("");
      setLinkQuery("");
      return;
    }
    if (preset === "draft_only") {
      setIncludeArchive(false);
      setStatusFilter("DRAFT");
      setSourceFilter("");
      setDateStart("");
      setDateEnd("");
      setSearchQuery("");
      setLinkQuery("");
      return;
    }
    setIncludeArchive(false);
    setStatusFilter("");
    setSourceFilter("PAYMENT");
    setDateStart(today);
    setDateEnd(today);
    setSearchQuery("");
    setLinkQuery("");
  };
  const clearJournalFilters = () => {
    hasUserSelected.current = true;
    hasAppliedStartupView.current = true;
    setSearchQuery("");
    setLinkQuery("");
    setAccountQuery("");
    setEntryDirectionFilter("");
    setAccountFilterId("");
    setSourceFilter("");
    setStatusFilter("");
    setOutOfBalanceOnly(false);
    setIncludeArchive(false);
    setLargestVarianceFirst(false);
    setReviewMode(false);
    setExceptionMissingRefOnly(false);
    setExceptionLargeAmountOnly(false);
    setExceptionStaleDraftOnly(false);
    setSortBy("date");
    setSortDir("desc");
    setPeriodFilter("recent");
    setDateStart("");
    setDateEnd("");
    setSelectedViewId("");
    setPage(1);
    setShowAdvancedJournalFilters(false);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", window.location.pathname);
    }
  };
  useEffect(() => {
    if (!prefsHydrated || hasAppliedStartupView.current || savedViews.length === 0) return;
    const startupViewId = autoRestoreLastView ? lastUsedViewId || defaultViewId : defaultViewId;
    if (!startupViewId) {
      hasAppliedStartupView.current = true;
      return;
    }
    const exists = savedViews.some((v) => v.id === startupViewId);
    if (!exists) {
      hasAppliedStartupView.current = true;
      return;
    }
    applySavedView(startupViewId);
    hasAppliedStartupView.current = true;
  }, [prefsHydrated, savedViews, autoRestoreLastView, lastUsedViewId, defaultViewId, applySavedView]);
  const applyAccountDrill = (accountCode: string, accountId?: string) => {
    const targetId = accountId || accountIdByCode.get(accountCode) || "";
    if (!targetId) return;
    setAccountFilterId(targetId);
    setAccountQuery(accountCode);
    toast.success(`Filtered to account ${accountCode}.`);
  };
  const accountDrillCodes = ["1100", "2000", "1200", "1000", "2300"] as const;
  const extractBaseSourceId = (raw: string) => {
    const value = String(raw || "").trim();
    if (!value) return "";
    const idx = value.indexOf(":");
    return idx > 0 ? value.slice(0, idx) : value;
  };
  const getSourceHref = (entry: JournalEntry) => {
    const sourceId = String(entry.sourceId || "").trim();
    const sourceLabel = String(entry.sourceLabel || "").trim();
    const sourceBaseId = extractBaseSourceId(sourceId);
    const sourceBaseLabel = extractBaseSourceId(sourceLabel);
    const memoLower = String(entry.memo || "").trim().toLowerCase();
    if (entry.sourceType === "ORDER" && sourceId) return `/admin/orders/${sourceId}`;
    if (entry.sourceType === "PAYMENT") {
      if (sourceBaseId) {
        return `/admin/orders?${new URLSearchParams({ paymentId: sourceBaseId }).toString()}`;
      }
      if (sourceBaseLabel) {
        return `/admin/orders?${new URLSearchParams({ orderId: sourceBaseLabel }).toString()}`;
      }
      return "/admin/orders";
    }
    if (entry.sourceType === "PURCHASE") {
      if (
        sourceBaseId &&
        (memoLower.startsWith("supplier payment") || memoLower.startsWith("supplier refund"))
      ) {
        return `/admin/purchases?${new URLSearchParams({ paymentId: sourceBaseId }).toString()}`;
      }
      const purchaseQuery = sourceBaseId || sourceBaseLabel;
      return purchaseQuery
        ? `/admin/purchases?${new URLSearchParams({ purchaseId: purchaseQuery }).toString()}`
        : "/admin/purchases";
    }
    if (entry.sourceType === "EXPENSE") {
      const expenseQuery = sourceBaseId || sourceBaseLabel;
      return expenseQuery
        ? `/admin/expenses/${encodeURIComponent(expenseQuery)}`
        : "/admin/expenses";
    }
    if (entry.sourceType === "PAYROLL") {
      if (sourceId) return `/admin/hr/payroll/${sourceId}`;
      return "/admin/hr/compensation";
    }
    return "";
  };
  const sourceTraceLabel = (entry: JournalEntry) => {
    const trace = String(entry.sourceId || entry.sourceLabel || "").trim();
    if (!trace) return `${entry.sourceType} · -`;
    return `${entry.sourceType} · ${trace.slice(0, 12)}${trace.length > 12 ? "..." : ""}`;
  };
  const toggleSort = (nextBy: "date" | "status" | "amount") => {
    if (sortBy === nextBy) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(nextBy);
    setSortDir(nextBy === "status" ? "asc" : "desc");
  };
  const jumpToPage = () => {
    const next = Number(goToPageInput || 0);
    if (!Number.isFinite(next)) return;
    const target = Math.max(1, Math.min(totalPages, Math.floor(next)));
    setPage(target);
  };
  const postEntryById = async (entryId: string) => {
    const res = await fetch(`/api/admin/accounting/journal/${entryId}/post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || "Failed to post entry.");
  };
  const approveSelectedEntries = async () => {
    if (selectedEntryIds.length === 0) return;
    try {
      setBulkApproving(true);
      const res = await fetch("/api/admin/accounting/journal/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryIds: selectedEntryIds }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(j?.error || "Failed to approve entries.");
      }
      toast.success(`Approved ${j.approved ?? 0} entry(ies).`);
      setSelectedEntryIds([]);
      setShowBulkApproveDialog(false);
      queryClient.invalidateQueries({ queryKey: ["accounting", "journal"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to approve entries.");
    } finally {
      setBulkApproving(false);
    }
  };
  const approveSingleEntry = async (openNextDraft: boolean) => {
    if (!singleApproveEntry) return;
    const currentEntryId = singleApproveEntry.id;
    const nextDraftId = openNextDraft ? nextDraftFromSingleApprove?.id || null : null;
    try {
      setBulkApproving(true);
      await postEntryById(currentEntryId);
      toast.success("Entry approved and posted.");
      if (nextDraftId) {
        const nextEntry = filteredEntries.find((entry) => entry.id === nextDraftId) || null;
        if (nextEntry) {
          setSingleApproveEntry(nextEntry);
          setActiveEntryId(nextEntry.id);
          setExpandedEntryId(nextEntry.id);
          const idx = filteredEntries.findIndex((entry) => entry.id === nextEntry.id);
          if (idx >= 0) {
            const targetPage = Math.floor(idx / rowsPerPage) + 1;
            setPage(targetPage);
          }
        } else {
          setSingleApproveEntry(null);
        }
      } else {
        setSingleApproveEntry(null);
      }
      queryClient.invalidateQueries({ queryKey: ["accounting", "journal"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to post entry.");
    } finally {
      setBulkApproving(false);
    }
  };
  const toCsv = (entriesForExport: JournalEntry[]) => {
    const esc = (v: string | number) => {
      const s = String(v ?? "");
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = [
      "Date",
      "Memo",
      "Source",
      "Status",
      "Approved By",
      "Debit Total",
      "Credit Total",
      "Source ID",
      "Source Label",
    ];
    const rows = entriesForExport.map((entry) => {
      const debitTotal = entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
      const creditTotal = entry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
      const approvedBy =
        entry.approvedBy?.name || entry.approvedBy?.email || (entry.status === "POSTED" ? "System" : "-");
      return [
        new Date(entry.entryDate).toISOString().slice(0, 10),
        entry.memo || "",
        entry.sourceType || "",
        entry.status || "",
        approvedBy,
        debitTotal.toFixed(2),
        creditTotal.toFixed(2),
        entry.sourceId || "",
        entry.sourceLabel || "",
      ];
    });
    return [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  };
  const downloadTextFile = (filename: string, content: string, mime = "text/plain;charset=utf-8;") => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const exportFilteredCsv = () => {
    if (!filteredEntries.length) {
      toast.error("No entries to export for current filters.");
      return;
    }
    const csv = toCsv(filteredEntries);
    const today = new Date().toISOString().slice(0, 10);
    downloadTextFile(`journal_filtered_${today}.csv`, csv, "text/csv;charset=utf-8;");
    toast.success("Journal CSV exported.");
  };
  const exportFilteredPdf = async () => {
    if (!filteredEntries.length) {
      toast.error("No entries to export for current filters.");
      return;
    }
    try {
      const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
      const page = () => pdf.addPage([842, 595]); // A4 landscape
      const sanitize = (value: unknown) =>
        String(value ?? "")
          .replace(/[^\x20-\x7E]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const fmtAmount = (value: number) => `GHS ${Number(value || 0).toFixed(2)}`;
      const ellipsize = (value: string, max = 48) =>
        value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;

      const columns = [
        { key: "date", label: "Date", w: 74 },
        { key: "memo", label: "Memo", w: 220 },
        { key: "source", label: "Source", w: 78 },
        { key: "status", label: "Status", w: 58 },
        { key: "debit", label: "Debit", w: 100 },
        { key: "credit", label: "Credit", w: 100 },
        { key: "sourceId", label: "Source ID", w: 170 },
      ] as const;
      const margin = 24;
      const top = 570;
      const lineH = 14;
      const now = new Date().toLocaleString();
      const filtersLine = `Filters: scope=${sanitize(scopeLabel)}, archive=${sanitize(
        includeArchive ? "included" : "recent-only",
      )}, period=${sanitize(periodFilter || "recent")}, status=${sanitize(
        statusFilter || "all",
      )}, source=${sanitize(sourceFilter || "all")}, from=${sanitize(
        dateStart || "-",
      )}, to=${sanitize(dateEnd || "-")}, search=${sanitize(searchQuery || "-")}`;

      let pdfPage = page();
      let y = top;

      const drawHeader = () => {
        pdfPage.drawText("Journal Entries - Filtered View", {
          x: margin,
          y,
          size: 16,
          font: fontBold,
          color: rgb(0.07, 0.07, 0.07),
        });
        y -= 18;
        pdfPage.drawText(sanitize(`Generated: ${now}`), { x: margin, y, size: 9, font });
        y -= 12;
        pdfPage.drawText(ellipsize(filtersLine, 150), { x: margin, y, size: 9, font });
        y -= 16;

        let x = margin;
        columns.forEach((col) => {
          pdfPage.drawText(col.label, { x, y, size: 8.5, font: fontBold });
          x += col.w;
        });
        y -= 8;
        pdfPage.drawLine({
          start: { x: margin, y },
          end: { x: margin + columns.reduce((s, c) => s + c.w, 0), y },
          thickness: 0.6,
          color: rgb(0.75, 0.75, 0.75),
        });
        y -= 10;
      };

      drawHeader();

      for (const entry of filteredEntries) {
        const debitTotal = entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
        const creditTotal = entry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
        const row = [
          sanitize(new Date(entry.entryDate).toISOString().slice(0, 10)),
          sanitize(ellipsize(entry.memo || "-", 42)),
          sanitize(entry.sourceType || "-"),
          sanitize(entry.status || "-"),
          sanitize(fmtAmount(debitTotal)),
          sanitize(fmtAmount(creditTotal)),
          sanitize(ellipsize(String(entry.sourceId || entry.sourceLabel || "-"), 34)),
        ];

        if (y < 42) {
          pdfPage = page();
          y = top;
          drawHeader();
        }
        let x = margin;
        row.forEach((cell, idx) => {
          pdfPage.drawText(cell, { x, y, size: 8, font });
          x += columns[idx]!.w;
        });
        y -= lineH;
      }

      const bytes = await pdf.save();
      const pdfBytes = Uint8Array.from(bytes);
      const blob = new Blob([pdfBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const today = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `journal_filtered_${today}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Journal PDF exported.");
    } catch (error) {
      console.error(error);
      toast.error("Failed to generate PDF.");
    }
  };
  const exportAuditPack = () => {
    if (!filteredEntries.length) {
      toast.error("No entries to export for current filters.");
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const csv = toCsv(filteredEntries);
    const exceptionRows = filteredEntries
      .map((entry) => {
        const debitTotal = entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
        const creditTotal = entry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
        const missingReferenceRisk =
          entry.status === "POSTED" &&
          entry.sourceType !== "MANUAL" &&
          !String(entry.sourceId || "").trim() &&
          !String(entry.sourceLabel || "").trim();
        const unusualAmountRisk = Math.max(Math.abs(debitTotal), Math.abs(creditTotal)) >= 25000;
        const outOfBalanceRisk = Math.abs(debitTotal - creditTotal) > 0.01;
        const staleDraftRisk =
          entry.status === "DRAFT" &&
          (Date.now() - new Date(entry.entryDate).getTime()) / (1000 * 60 * 60 * 24) >= 7;
        const flags = [
          missingReferenceRisk ? "missing_source_ref" : "",
          unusualAmountRisk ? "large_amount" : "",
          outOfBalanceRisk ? "out_of_balance" : "",
          staleDraftRisk ? "stale_draft" : "",
        ].filter(Boolean);
        return { entry, flags, debitTotal, creditTotal };
      })
      .filter((row) => row.flags.length > 0);
    const toExceptionsCsv = () => {
      const esc = (v: string | number) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const header = [
        "Date",
        "Memo",
        "Source",
        "Status",
        "Exceptions",
        "Debit Total",
        "Credit Total",
        "Source ID",
      ];
      const rows = exceptionRows.map(({ entry, flags, debitTotal, creditTotal }) => [
        new Date(entry.entryDate).toISOString().slice(0, 10),
        entry.memo || "",
        entry.sourceType || "",
        entry.status || "",
        flags.join("|"),
        debitTotal.toFixed(2),
        creditTotal.toFixed(2),
        entry.sourceId || "",
      ]);
      return [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
    };
    const summary = [
      "Journal audit pack summary",
      `Generated: ${new Date().toLocaleString()}`,
      `Scope: ${scopeLabel}`,
      `Include archive: ${includeArchive ? "yes" : "no"}`,
      `Period filter: ${periodFilter || "recent"}`,
      `Status filter: ${statusFilter || "all"}`,
      `Source filter: ${sourceFilter || "all"}`,
      `Date range: ${dateStart || "-"} to ${dateEnd || "-"}`,
      `Search query: ${searchQuery || "-"}`,
      `Link query: ${linkQuery || "-"}`,
      `Account query: ${accountQuery || "-"}`,
      `Entries: ${periodSummary.total}`,
      `Posted: ${periodSummary.posted}`,
      `Draft: ${periodSummary.draft}`,
      `Void: ${periodSummary.void}`,
      `Debits: ${formatCurrency(periodSummary.debit)}`,
      `Credits: ${formatCurrency(periodSummary.credit)}`,
      `Exceptions: ${exceptionRows.length}`,
    ].join("\n");
    downloadTextFile(`journal_filtered_${today}.csv`, csv, "text/csv;charset=utf-8;");
    downloadTextFile(`journal_summary_${today}.txt`, summary, "text/plain;charset=utf-8;");
    downloadTextFile(`journal_exceptions_${today}.csv`, toExceptionsCsv(), "text/csv;charset=utf-8;");
    toast.success("Audit pack exported (CSV + summary TXT + exceptions CSV).");
  };
  const exportAuditPackPdf = async () => {
    if (!filteredEntries.length) {
      toast.error("No entries to export for current filters.");
      return;
    }
    try {
      const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
      const sanitize = (value: unknown) =>
        String(value ?? "")
          .replace(/[^\x20-\x7E]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const fmtMoney = (n: number) => `GHS ${Number(n || 0).toFixed(2)}`;
      const mkPage = () => pdf.addPage([842, 595]); // A4 landscape
      let pageObj = mkPage();
      let y = 570;
      const margin = 24;
      const lh = 13;
      const write = (text: string, bold = false) => {
        if (y < 34) {
          pageObj = mkPage();
          y = 570;
        }
        pageObj.drawText(sanitize(text), {
          x: margin,
          y,
          size: 9,
          font: bold ? fontBold : font,
          color: rgb(0.08, 0.08, 0.08),
        });
        y -= lh;
      };

      const exceptionRows = filteredEntries
        .map((entry) => {
          const debitTotal = entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
          const creditTotal = entry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
          const missingReferenceRisk =
            entry.status === "POSTED" &&
            entry.sourceType !== "MANUAL" &&
            !String(entry.sourceId || "").trim() &&
            !String(entry.sourceLabel || "").trim();
          const unusualAmountRisk = Math.max(Math.abs(debitTotal), Math.abs(creditTotal)) >= 25000;
          const outOfBalanceRisk = Math.abs(debitTotal - creditTotal) > 0.01;
          const staleDraftRisk =
            entry.status === "DRAFT" &&
            (Date.now() - new Date(entry.entryDate).getTime()) / (1000 * 60 * 60 * 24) >= 7;
          const flags = [
            missingReferenceRisk ? "missing_source_ref" : "",
            unusualAmountRisk ? "large_amount" : "",
            outOfBalanceRisk ? "out_of_balance" : "",
            staleDraftRisk ? "stale_draft" : "",
          ].filter(Boolean);
          return { entry, flags, debitTotal, creditTotal };
        })
        .filter((row) => row.flags.length > 0);

      write("Journal Audit Pack (Filtered)", true);
      write(`Generated: ${new Date().toLocaleString()}`);
      write(
        `Filters: scope=${scopeLabel}, archive=${includeArchive ? "included" : "recent-only"}, period=${periodFilter || "recent"}, status=${statusFilter || "all"}, source=${sourceFilter || "all"}, from=${dateStart || "-"}, to=${dateEnd || "-"}, search=${searchQuery || "-"}, link=${linkQuery || "-"}`,
      );
      y -= 3;
      write(`Entries: ${periodSummary.total}`, true);
      write(`Posted: ${periodSummary.posted} | Draft: ${periodSummary.draft} | Void: ${periodSummary.void}`);
      write(`Debits: ${fmtMoney(periodSummary.debit)} | Credits: ${fmtMoney(periodSummary.credit)}`);
      write(`Exceptions: ${exceptionRows.length}`);
      y -= 4;
      write("Top exceptions:", true);
      if (!exceptionRows.length) {
        write("- None");
      } else {
        exceptionRows.slice(0, 120).forEach((row) => {
          write(
            `- ${new Date(row.entry.entryDate).toISOString().slice(0, 10)} | ${row.entry.sourceType} | ${row.entry.status} | ${row.flags.join("|")} | Dr ${fmtMoney(row.debitTotal)} Cr ${fmtMoney(row.creditTotal)} | ${sanitize(row.entry.memo || "-")}`,
          );
        });
      }

      const bytes = await pdf.save();
      const blob = new Blob([Uint8Array.from(bytes)], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const today = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `journal_audit_pack_${today}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Audit pack PDF exported.");
    } catch (error) {
      console.error(error);
      toast.error("Failed to generate audit pack PDF.");
    }
  };
  const runJournalArchive = async (dryRun: boolean) => {
    if (!canArchive || archiveRunning) return;
    try {
      setArchiveRunning(true);
      const res = await fetch("/api/admin/accounting/journal/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dryRun,
          months: Number.isFinite(archiveMonths) ? Math.max(1, Math.floor(archiveMonths)) : 18,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || "Archive run failed.");
        return;
      }
      const candidateCount = Number(data?.candidateCount || 0);
      setArchiveEligibleCount(candidateCount);
      if (dryRun) {
        toast.success(
          `Dry run: ${candidateCount} entries older than ${data?.months ?? archiveMonths} month(s).`,
        );
      } else {
        const archiveRunAt = String(data?.archiveRunAt || "");
        if (archiveRunAt) {
          setLastArchiveRunAt(archiveRunAt);
          setUndoArchiveUntilMs(Date.now() + 5 * 60 * 1000);
        } else {
          setLastArchiveRunAt(null);
          setUndoArchiveUntilMs(null);
        }
        toast.success(
          `Archived ${data?.archivedCount ?? 0} entries older than ${data?.months ?? archiveMonths} month(s).`,
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["accounting", "journal"] });
      await queryClient.invalidateQueries({ queryKey: ["accounting", "journal-balance"] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "audit", "journal-archive-runs"] });
    } catch (error) {
      console.error(error);
      toast.error("Archive run failed.");
    } finally {
      setArchiveRunning(false);
    }
  };
  const undoLastArchiveRun = async () => {
    if (!canArchive || archiveRunning || !lastArchiveRunAt || !undoArchiveUntilMs || Date.now() > undoArchiveUntilMs) {
      return;
    }
    try {
      setArchiveRunning(true);
      const res = await fetch("/api/admin/accounting/journal/archive", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runAt: lastArchiveRunAt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || "Undo archive failed.");
        return;
      }
      toast.success(`Undo complete. Restored ${Number(data?.restoredCount || 0)} entries.`);
      setLastArchiveRunAt(null);
      setUndoArchiveUntilMs(null);
      await queryClient.invalidateQueries({ queryKey: ["accounting", "journal"] });
      await queryClient.invalidateQueries({ queryKey: ["accounting", "journal-balance"] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "audit", "journal-archive-runs"] });
    } catch (error) {
      console.error(error);
      toast.error("Undo archive failed.");
    } finally {
      setArchiveRunning(false);
    }
  };
  const exportArchiveRunsCsv = () => {
    if (!archiveAuditRows.length) {
      toast.error("No archive run logs found.");
      return;
    }
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["When", "Action", "Actor", "Months", "Cutoff", "Candidates", "Archived", "DryRun"];
    const rows = archiveAuditRows.map((row) => {
      const meta = (row.meta || {}) as Record<string, unknown>;
      const actor = row.actor?.name || row.actor?.email || "System";
      return [
        row.createdAt || "",
        row.action || "",
        actor,
        meta.months ?? "",
        meta.cutoffDate ?? "",
        meta.candidateCount ?? "",
        meta.archivedCount ?? meta.restoredCount ?? "",
        meta.dryRun ?? "",
      ];
    });
    const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
    const today = new Date().toISOString().slice(0, 10);
    downloadTextFile(`journal_archive_runs_${today}.csv`, csv, "text/csv;charset=utf-8;");
    toast.success("Archive runs CSV exported.");
  };
  const arBalanceByEntryId = useMemo(() => {
    const sorted = [...balanceEntries].sort((a, b) => {
      const dateDiff = new Date(a.entryDate).getTime() - new Date(b.entryDate).getTime();
      if (dateDiff !== 0) return dateDiff;
      return a.id.localeCompare(b.id);
    });
    const byInvoice = new Map<string, number>();
    const map = new Map<string, number>();
    for (const entry of sorted) {
      const invoiceKey = (entry.sourceLabel || "").trim();
      const delta = entry.lines.reduce((sum, line) => {
        if (line.account.code !== "1100") return sum;
        return sum + Number(line.debit || 0) - Number(line.credit || 0);
      }, 0);
      if (!invoiceKey) {
        map.set(entry.id, 0);
        continue;
      }
      if (Math.abs(delta) > 0.0001) {
        const running = (byInvoice.get(invoiceKey) || 0) + delta;
        byInvoice.set(invoiceKey, running);
      }
      map.set(entry.id, byInvoice.get(invoiceKey) || 0);
    }
    return map;
  }, [balanceEntries]);
  const accruedBalanceByEntryId = useMemo(() => {
    const sorted = [...balanceEntries].sort((a, b) => {
      const dateDiff = new Date(a.entryDate).getTime() - new Date(b.entryDate).getTime();
      if (dateDiff !== 0) return dateDiff;
      return a.id.localeCompare(b.id);
    });
    const byExpense = new Map<string, number>();
    const map = new Map<string, number>();
    for (const entry of sorted) {
      if (entry.sourceType !== "EXPENSE") continue;
      const sourceId = String(entry.sourceId || "").trim();
      if (!sourceId) continue;
      const expenseId = sourceId.includes(":settlement:") ? sourceId.split(":settlement:")[0] || "" : sourceId;
      if (!expenseId) continue;
      const delta = entry.lines.reduce((sum, line) => {
        if (line.account.code !== "2300") return sum;
        return sum + Number(line.credit || 0) - Number(line.debit || 0);
      }, 0);
      if (Math.abs(delta) > 0.0001) {
        const running = (byExpense.get(expenseId) || 0) + delta;
        byExpense.set(expenseId, Math.max(0, running));
      }
      map.set(entry.id, byExpense.get(expenseId) || 0);
    }
    return map;
  }, [balanceEntries]);
  const draftEntries = entries.filter((entry) => entry.status === "DRAFT");
  const exceptionCounts = useMemo(() => {
    let missingRef = 0;
    let largeAmount = 0;
    let staleDraft = 0;
    for (const entry of entries) {
      const debitTotal = entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
      const creditTotal = entry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
      const missingReferenceRisk =
        entry.status === "POSTED" &&
        entry.sourceType !== "MANUAL" &&
        !String(entry.sourceId || "").trim() &&
        !String(entry.sourceLabel || "").trim();
      const unusualAmountRisk = Math.max(Math.abs(debitTotal), Math.abs(creditTotal)) >= 25000;
      const staleDraftRisk =
        entry.status === "DRAFT" &&
        (Date.now() - new Date(entry.entryDate).getTime()) / (1000 * 60 * 60 * 24) >= 7;
      if (missingReferenceRisk) missingRef += 1;
      if (unusualAmountRisk) largeAmount += 1;
      if (staleDraftRisk) staleDraft += 1;
    }
    return { missingRef, largeAmount, staleDraft };
  }, [entries]);
  const outOfBalanceCount = useMemo(
    () => entries.filter((entry) => Math.abs(getEntryImbalance(entry)) > 0.01).length,
    [entries],
  );
  const [selectedEntryIds, setSelectedEntryIds] = useState<string[]>([]);
  const [selectDraftsAcrossPages, setSelectDraftsAcrossPages] = useState(false);
  const [lineSearchByEntryId, setLineSearchByEntryId] = useState<Record<string, string>>({});
  const [bulkApproving, setBulkApproving] = useState(false);
  const [showBulkApproveDialog, setShowBulkApproveDialog] = useState(false);
  const { data: draftIdsData, isFetching: draftIdsFetching } = useClientQuery<{ ids?: string[]; total?: number; error?: string }>({
    queryKey: [
      "accounting",
      "journal",
      "draft-ids",
      selectedPeriod?.id || periodFilter || "recent",
      sourceFilter,
      dateStart,
      dateEnd,
      includeArchive,
      debouncedSearchQuery,
      sortBy,
      sortDir,
    ],
    enabled: canApprove && selectDraftsAcrossPages,
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("idsOnly", "1");
      params.set("status", "DRAFT");
      const hasCustomDates = dateStart || dateEnd;
      if (hasCustomDates) {
        if (dateStart) params.set("start", dateStart);
        if (dateEnd) params.set("end", dateEnd);
      } else if (selectedPeriod) {
        params.set("start", selectedPeriod.startDate.slice(0, 10));
        params.set("end", selectedPeriod.endDate.slice(0, 10));
      }
      if (sourceFilter) params.set("sourceType", sourceFilter);
      if (includeArchive) params.set("includeArchive", "1");
      if (debouncedSearchQuery.trim()) params.set("q", debouncedSearchQuery.trim());
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      return fetch(`/api/admin/accounting/journal?${params.toString()}`).then((r) => r.json());
    },
  });
  useEffect(() => {
    if (!selectDraftsAcrossPages) return;
    const ids = Array.isArray(draftIdsData?.ids) ? draftIdsData.ids : [];
    setSelectedEntryIds(ids);
  }, [selectDraftsAcrossPages, draftIdsData?.ids]);
  const [singleApproveEntry, setSingleApproveEntry] = useState<JournalEntry | null>(null);
  const nextDraftFromSingleApprove = useMemo(() => {
    if (!singleApproveEntry) return null;
    const draftEntriesInView = filteredEntries.filter((entry) => entry.status === "DRAFT");
    const idx = draftEntriesInView.findIndex((entry) => entry.id === singleApproveEntry.id);
    if (idx < 0) return null;
    return draftEntriesInView[idx + 1] || draftEntriesInView[idx - 1] || null;
  }, [singleApproveEntry, filteredEntries]);
  const allDraftSelected =
    draftEntries.length > 0 && selectedEntryIds.length === draftEntries.length;
  const approveDisabledReason = !canApprove
    ? "You do not have permission to approve entries."
    : selectedEntryIds.length === 0
      ? "Select at least one draft entry to approve."
      : null;
  const selectedDraftEntries = useMemo(
    () => draftEntries.filter((entry) => selectedEntryIds.includes(entry.id)),
    [draftEntries, selectedEntryIds],
  );
  const selectedDraftTotals = useMemo(() => {
    return selectedDraftEntries.reduce(
      (acc, entry) => {
        acc.debit += entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
        acc.credit += entry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
        return acc;
      },
      { debit: 0, credit: 0 },
    );
  }, [selectedDraftEntries]);
  const tableEntries = useMemo(() => {
    if (!largestVarianceFirst) return filteredEntries;
    return [...filteredEntries].sort(
      (a, b) => Math.abs(getEntryImbalance(b)) - Math.abs(getEntryImbalance(a)),
    );
  }, [filteredEntries, largestVarianceFirst]);
  const pagedEntries = tableEntries;
  const activeEntry = useMemo(
    () => pagedEntries.find((entry) => entry.id === activeEntryId) || null,
    [pagedEntries, activeEntryId],
  );
  useEffect(() => {
    setPage(1);
    setSelectDraftsAcrossPages(false);
  }, [
    periodFilter,
    statusFilter,
    sourceFilter,
    dateStart,
    dateEnd,
    searchQuery,
    linkQuery,
    accountQuery,
    accountFilterId,
    outOfBalanceOnly,
    entryDirectionFilter,
    exceptionMissingRefOnly,
    exceptionLargeAmountOnly,
    exceptionStaleDraftOnly,
    rowsPerPage,
    sortBy,
    sortDir,
  ]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  useEffect(() => {
    if (!pagedEntries.length) {
      setActiveEntryId(null);
      return;
    }
    if (!activeEntryId || !pagedEntries.some((entry) => entry.id === activeEntryId)) {
      setActiveEntryId(pagedEntries[0]?.id || null);
    }
  }, [pagedEntries, activeEntryId]);
  useEffect(() => {
    if (!activeEntryId) return;
    const row = document.querySelector(
      `[data-journal-entry-row="${activeEntryId}"]`,
    ) as HTMLElement | null;
    if (!row) return;
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeEntryId, page]);

  const [entryDate, setEntryDate] = useState(() => {
    const today = new Date();
    return today.toISOString().slice(0, 10);
  });
  const [memo, setMemo] = useState("");
  const [manualCategory, setManualCategory] = useState<ManualCategory | "">("");
  const [manualExceptionNote, setManualExceptionNote] = useState("");
  const [manualPriorPeriodId, setManualPriorPeriodId] = useState("");
  const [manualPriorPeriodNote, setManualPriorPeriodNote] = useState("");
  const [debitAccountId, setDebitAccountId] = useState("");
  const [creditAccountId, setCreditAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
  const entryParam = String(searchParams.get("entry") || "").trim();
  useEffect(() => {
    if (!entryParam) return;
    if (!tableEntries.some((e) => e.id === entryParam)) return;
    setExpandedEntryId((prev) => (prev === entryParam ? prev : entryParam));
    setActiveEntryId(entryParam);
    const idx = tableEntries.findIndex((e) => e.id === entryParam);
    if (idx >= 0) {
      const targetPage = Math.floor(idx / rowsPerPage) + 1;
      setPage(targetPage);
    }
  }, [entryParam, tableEntries, rowsPerPage]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        const isTypingField =
          target.isContentEditable ||
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT";
        if (isTypingField) return;
      }
      if (!pagedEntries.length) return;
      const currentIdx = Math.max(
        0,
        pagedEntries.findIndex((entry) => entry.id === activeEntryId),
      );
      const key = e.key.toLowerCase();
      const keyCode = (e as KeyboardEvent & { keyCode?: number }).keyCode;
      const isHomeKey = key === "home" || key === "pos1" || e.code === "Home" || keyCode === 36;
      const isEndKey = key === "end" || e.code === "End" || keyCode === 35;
      if (key === "j" && e.shiftKey) {
        if (page >= totalPages) return;
        e.preventDefault();
        setPage((p) => Math.min(totalPages, p + 1));
        setActiveEntryId(null);
        return;
      }
      if (key === "k" && e.shiftKey) {
        if (page <= 1) return;
        e.preventDefault();
        setPage((p) => Math.max(1, p - 1));
        setActiveEntryId(null);
        return;
      }
      if (key === "j") {
        e.preventDefault();
        const nextIdx = Math.min(pagedEntries.length - 1, currentIdx + 1);
        setActiveEntryId(pagedEntries[nextIdx]?.id || null);
        return;
      }
      if (key === "k") {
        e.preventDefault();
        const prevIdx = Math.max(0, currentIdx - 1);
        setActiveEntryId(pagedEntries[prevIdx]?.id || null);
        return;
      }
      if (key === "enter") {
        e.preventDefault();
        const entry = pagedEntries[currentIdx];
        if (!entry) return;
        setExpandedEntryId((prev) => (prev === entry.id ? null : entry.id));
        return;
      }
      if (isHomeKey) {
        e.preventDefault();
        setActiveEntryId(pagedEntries[0]?.id || null);
        return;
      }
      if (isEndKey) {
        e.preventDefault();
        setActiveEntryId(pagedEntries[pagedEntries.length - 1]?.id || null);
        return;
      }
      if (key === "g" && !e.shiftKey) {
        e.preventDefault();
        setActiveEntryId(pagedEntries[0]?.id || null);
        return;
      }
      if (key === "g" && e.shiftKey) {
        e.preventDefault();
        setActiveEntryId(pagedEntries[pagedEntries.length - 1]?.id || null);
        return;
      }
      if (key === "a" && canApprove) {
        const entry = pagedEntries[currentIdx];
        if (!entry || entry.status !== "DRAFT") return;
        e.preventDefault();
        setSingleApproveEntry(entry);
      }
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [pagedEntries, activeEntryId, canApprove, page, totalPages]);
  const sameAccountSelected =
    debitAccountId.length > 0 &&
    creditAccountId.length > 0 &&
    debitAccountId === creditAccountId;
  const numericAmount = Number(amount);
  const amountInvalid = !Number.isFinite(numericAmount) || numericAmount <= 0;
  const [fullEntryDate, setFullEntryDate] = useState(entryDate);
  const [fullMemo, setFullMemo] = useState("");
  const [fullManualCategory, setFullManualCategory] = useState<ManualCategory | "">("");
  const [fullManualExceptionNote, setFullManualExceptionNote] = useState("");
  const [fullManualPriorPeriodId, setFullManualPriorPeriodId] = useState("");
  const [fullManualPriorPeriodNote, setFullManualPriorPeriodNote] = useState("");
  const [fullSaving, setFullSaving] = useState(false);
  const [autoVatEnabled, setAutoVatEnabled] = useState(false);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [fullLines, setFullLines] = useState<Array<{
    id: string;
    accountId: string;
    debit: string;
    credit: string;
    taxCodeId: string;
    description: string;
  }>>([
    {
      id: String(Date.now()),
      accountId: "",
      debit: "",
      credit: "",
      taxCodeId: "",
      description: "",
    },
    {
      id: String(Date.now() + 1),
      accountId: "",
      debit: "",
      credit: "",
      taxCodeId: "",
      description: "",
    },
  ]);

  const accountOptions = useMemo(
    () => accounts.sort((a, b) => a.code.localeCompare(b.code)),
    [accounts],
  );
  const closedPeriods = useMemo(
    () =>
      periods
        .filter((period) => period.status === "CLOSED")
        .sort((a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime()),
    [periods],
  );
  const manualAccountOptions = useMemo(
    () =>
      accountOptions.filter(
        (acc) => acc.type === "ASSET" || acc.type === "LIABILITY" || acc.type === "EQUITY",
      ),
    [accountOptions],
  );
  const accountIdByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const acc of accounts) {
      map.set(acc.code, acc.id);
    }
    return map;
  }, [accounts]);

  useEffect(() => {
    const accountParam = String(searchParams.get("account") || "").trim();
    if (!accountParam || !accounts.length) return;
    const byCode =
      accounts.find((acc) => acc.code.toLowerCase() === accountParam.toLowerCase()) || null;
    const byId = accounts.find((acc) => acc.id === accountParam) || null;
    const matched = byCode || byId;
    if (matched) {
      setAccountFilterId((prev) => (prev === matched.id ? prev : matched.id));
      setAccountQuery((prev) => (prev.trim() ? prev : matched.code));
    }
  }, [accounts, searchParams]);

  const addFullLine = () => {
    setFullLines((prev) => [
      ...prev,
      {
        id: String(Date.now() + Math.random()),
        accountId: "",
        debit: "",
        credit: "",
        taxCodeId: "",
        description: "",
      },
    ]);
  };

  const addVatSaleTemplate = () => {
    const arId = accountIdByCode.get("1100") || "";
    const revenueId = accountIdByCode.get("4000") || "";
    const vatId = accountIdByCode.get("2100") || "";
    const defaultTaxCode = taxCodes.find((code) =>
      code.name.toLowerCase().includes("output"),
    );
    setFullLines([
      {
        id: String(Date.now()),
        accountId: arId,
        debit: "",
        credit: "",
        taxCodeId: "",
        description: "Invoice total (incl. VAT)",
      },
      {
        id: String(Date.now() + 1),
        accountId: revenueId,
        debit: "",
        credit: "",
        taxCodeId: "",
        description: "Sales revenue",
      },
      {
        id: String(Date.now() + 2),
        accountId: vatId,
        debit: "",
        credit: "",
        taxCodeId: defaultTaxCode?.id || "",
        description: "Output VAT",
      },
    ]);
    if (!fullMemo.trim()) {
      setFullMemo("VAT sale");
    }
    setAutoVatEnabled(true);
  };

  useEffect(() => {
    if (!autoVatEnabled) return;
    const arId = accountIdByCode.get("1100");
    const revenueId = accountIdByCode.get("4000");
    const vatId = accountIdByCode.get("2100");
    if (!arId || !revenueId || !vatId) return;
    const revenueLine = fullLines.find((line) => line.accountId === revenueId);
    const vatLine = fullLines.find((line) => line.accountId === vatId);
    const arLine = fullLines.find((line) => line.accountId === arId);
    if (!revenueLine || !vatLine || !arLine) return;
    const revenueAmount = Number(revenueLine.credit || 0);
    if (!Number.isFinite(revenueAmount) || revenueAmount <= 0) return;
    const taxCode = taxCodes.find((code) => code.id === vatLine.taxCodeId);
    const rate = Number(taxCode?.rate || 0);
    if (!Number.isFinite(rate) || rate <= 0) return;
    const vatAmount = revenueAmount * (rate / 100);
    const arAmount = revenueAmount + vatAmount;
    const nextVat = vatAmount.toFixed(2);
    const nextAr = arAmount.toFixed(2);
    setFullLines((prev) => {
      let changed = false;
      const next = prev.map((line) => {
        if (line.accountId === vatId) {
          if (line.credit !== nextVat || line.debit !== "") {
            changed = true;
            return { ...line, credit: nextVat, debit: "" };
          }
        }
        if (line.accountId === arId) {
          if (line.debit !== nextAr || line.credit !== "") {
            changed = true;
            return { ...line, debit: nextAr, credit: "" };
          }
        }
        return line;
      });
      return changed ? next : prev;
    });
  }, [autoVatEnabled, accountIdByCode, fullLines, taxCodes]);

  const removeFullLine = (id: string) => {
    setFullLines((prev) => prev.filter((line) => line.id !== id));
  };

  const updateFullLine = (
    id: string,
    field: "accountId" | "debit" | "credit" | "taxCodeId" | "description",
    value: string,
  ) => {
    setFullLines((prev) =>
      prev.map((line) => (line.id === id ? { ...line, [field]: value } : line)),
    );
  };

  const fullTotals = useMemo(() => {
    let debitTotal = 0;
    let creditTotal = 0;
    for (const line of fullLines) {
      debitTotal += Number(line.debit || 0);
      creditTotal += Number(line.credit || 0);
    }
    return { debitTotal, creditTotal, diff: debitTotal - creditTotal };
  }, [fullLines]);
  const hasUnsavedJournalForm = useMemo(() => {
    const todayYmd = new Date().toISOString().slice(0, 10);
    const quickDirty =
      entryDate !== todayYmd ||
      memo.trim().length > 0 ||
      manualCategory.length > 0 ||
      manualExceptionNote.trim().length > 0 ||
      manualPriorPeriodId.length > 0 ||
      manualPriorPeriodNote.trim().length > 0 ||
      debitAccountId.length > 0 ||
      creditAccountId.length > 0 ||
      amount.trim().length > 0;
    const fullLinesDirty =
      fullLines.length !== 2 ||
      fullLines.some(
        (line) =>
          line.accountId.trim().length > 0 ||
          line.debit.trim().length > 0 ||
          line.credit.trim().length > 0 ||
          line.taxCodeId.trim().length > 0 ||
          line.description.trim().length > 0,
      );
    const fullDirty =
      fullEntryDate !== todayYmd ||
      fullMemo.trim().length > 0 ||
      fullManualCategory.length > 0 ||
      fullManualExceptionNote.trim().length > 0 ||
      fullManualPriorPeriodId.length > 0 ||
      fullManualPriorPeriodNote.trim().length > 0 ||
      fullLinesDirty;
    return quickDirty || fullDirty;
  }, [
    entryDate,
    memo,
    manualCategory,
    manualExceptionNote,
    manualPriorPeriodId,
    manualPriorPeriodNote,
    debitAccountId,
    creditAccountId,
    amount,
    fullEntryDate,
    fullMemo,
    fullManualCategory,
    fullManualExceptionNote,
    fullManualPriorPeriodId,
    fullManualPriorPeriodNote,
    fullLines,
  ]);
  useEffect(() => {
    if (!hasUnsavedJournalForm) return;
    const warning = "You have unsaved manual journal changes. Leave this page and discard them?";
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = warning;
    };
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target === "_blank") return;
      const href = anchor.getAttribute("href") || "";
      if (!href || href.startsWith("#")) return;
      const nextUrl = new URL(anchor.href, window.location.href);
      if (nextUrl.origin !== window.location.origin) return;
      const keepEditing = !window.confirm(warning);
      if (!keepEditing) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onDocumentClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onDocumentClick, true);
    };
  }, [hasUnsavedJournalForm]);

  const createEntry = async () => {
    if (!memo.trim()) {
      toast.error("Manual entries require a reason in the memo field.");
      return;
    }
    if (!manualCategory) {
      toast.error("Select a manual adjustment category.");
      return;
    }
    if (manualCategory !== "PERIOD_END_ADJUSTMENT" && manualExceptionNote.trim().length < 12) {
      toast.error("Provide an exception note (12+ chars) when not using period-end adjustment.");
      return;
    }
    if (manualPriorPeriodId && manualPriorPeriodNote.trim().length < 12) {
      toast.error("Prior-period adjustment requires an amendment note (12+ chars).");
      return;
    }
    if (!debitAccountId || !creditAccountId) {
      toast.error("Select both debit and credit accounts.");
      return;
    }
    if (debitAccountId === creditAccountId) {
      toast.error("Debit and credit accounts must be different.");
      return;
    }
    if (amountInvalid) {
      toast.error("Enter a valid amount.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch("/api/admin/accounting/journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryDate,
          memo: memo.trim() || undefined,
          sourceType: "MANUAL",
          manualCategory,
          manualExceptionNote: manualExceptionNote.trim() || undefined,
          priorPeriodId: manualPriorPeriodId || undefined,
          priorPeriodNote: manualPriorPeriodNote.trim() || undefined,
          status: "DRAFT",
          lines: [
            {
              accountId: debitAccountId,
              debit: numericAmount,
              credit: 0,
              description: memo.trim() || "Manual entry",
            },
            {
              accountId: creditAccountId,
              debit: 0,
              credit: numericAmount,
              description: memo.trim() || "Manual entry",
            },
          ],
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(j?.error || "Failed to create journal entry");
      }
      toast.success("Journal entry created as draft.");
      setMemo("");
      setManualCategory("");
      setManualExceptionNote("");
      setManualPriorPeriodId("");
      setManualPriorPeriodNote("");
      setDebitAccountId("");
      setCreditAccountId("");
      setAmount("");
      queryClient.invalidateQueries({ queryKey: ["accounting", "journal"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create entry.");
    } finally {
      setSaving(false);
    }
  };

  const createFullEntry = async () => {
    if (!fullMemo.trim()) {
      toast.error("Manual entries require a reason in the memo field.");
      return;
    }
    if (!fullManualCategory) {
      toast.error("Select a manual adjustment category.");
      return;
    }
    if (fullManualCategory !== "PERIOD_END_ADJUSTMENT" && fullManualExceptionNote.trim().length < 12) {
      toast.error("Provide an exception note (12+ chars) when not using period-end adjustment.");
      return;
    }
    if (fullManualPriorPeriodId && fullManualPriorPeriodNote.trim().length < 12) {
      toast.error("Prior-period adjustment requires an amendment note (12+ chars).");
      return;
    }
    if (fullLines.length < 2) {
      toast.error("Add at least two lines.");
      return;
    }
    let debitTotal = 0;
    let creditTotal = 0;
    for (const line of fullLines) {
      if (!line.accountId) {
        toast.error("Select an account for each line.");
        return;
      }
      const debit = Number(line.debit || 0);
      const credit = Number(line.credit || 0);
      if (debit > 0 && credit > 0) {
        toast.error("A line cannot have both debit and credit.");
        return;
      }
      if (debit <= 0 && credit <= 0) {
        toast.error("Each line must have a debit or credit amount.");
        return;
      }
      debitTotal += debit;
      creditTotal += credit;
    }
    if (Math.abs(debitTotal - creditTotal) > 0.01) {
      toast.error("Debits must equal credits.");
      return;
    }
    try {
      setFullSaving(true);
      const res = await fetch("/api/admin/accounting/journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entryDate: fullEntryDate,
          memo: fullMemo.trim() || undefined,
          sourceType: "MANUAL",
          manualCategory: fullManualCategory,
          manualExceptionNote: fullManualExceptionNote.trim() || undefined,
          priorPeriodId: fullManualPriorPeriodId || undefined,
          priorPeriodNote: fullManualPriorPeriodNote.trim() || undefined,
          status: "DRAFT",
          lines: fullLines.map((line) => ({
            accountId: line.accountId,
            debit: Number(line.debit || 0),
            credit: Number(line.credit || 0),
            description: line.description.trim() || fullMemo.trim() || "Manual entry",
            taxCodeId: line.taxCodeId || null,
          })),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(j?.error || "Failed to create journal entry");
      }
      toast.success("Full journal entry created as draft.");
      setFullMemo("");
      setFullManualCategory("");
      setFullManualExceptionNote("");
      setFullManualPriorPeriodId("");
      setFullManualPriorPeriodNote("");
      setFullLines([
        {
          id: String(Date.now()),
          accountId: "",
          debit: "",
          credit: "",
          taxCodeId: "",
          description: "",
        },
        {
          id: String(Date.now() + 1),
          accountId: "",
          debit: "",
          credit: "",
          taxCodeId: "",
          description: "",
        },
      ]);
      queryClient.invalidateQueries({ queryKey: ["accounting", "journal"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create entry.");
    } finally {
      setFullSaving(false);
    }
  };
  const effectiveJournalPolicy = journalPolicyData?.policy || null;

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Journal Entries</h1>
          <p className="text-sm text-muted-foreground">
            Record and review accounting entries.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {currentOpenPeriod
              ? `Open period: ${currentOpenPeriod.name} (${new Date(
                  currentOpenPeriod.startDate,
                ).toLocaleDateString()} - ${new Date(
                  currentOpenPeriod.endDate,
                ).toLocaleDateString()})`
              : "No open fiscal period."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={exportFilteredCsv}
            disabled={filteredEntries.length === 0}
          >
            Export CSV (filtered)
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={exportFilteredPdf}
            disabled={filteredEntries.length === 0}
          >
            Export PDF (filtered)
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={exportAuditPack}
            disabled={filteredEntries.length === 0}
          >
            Export audit pack
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={exportAuditPackPdf}
            disabled={filteredEntries.length === 0}
          >
            Export audit pack PDF
          </Button>
          <Button
            size="sm"
            variant={showManualEntry ? "default" : "outline"}
            onClick={() => setShowManualEntry((prev) => !prev)}
          >
            {showManualEntry ? "Hide manual entry" : "Show manual entry"}
          </Button>
        </div>
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Journal policy summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm md:grid-cols-2">
          <div className="rounded-md border bg-muted/30 px-3 py-2">
            New entries default to last{" "}
            <span className="font-medium">{effectiveJournalPolicy?.recentWindowDays ?? 90}</span> day(s) when no date range is selected.
          </div>
          <div className="rounded-md border bg-muted/30 px-3 py-2">
            Manual entries to Income/Expense accounts are{" "}
            <span className="font-medium">{effectiveJournalPolicy?.manualEntryAllowPnl ? "allowed" : "blocked"}</span>.
          </div>
          <div className="rounded-md border bg-muted/30 px-3 py-2">
            Archive default is entries older than{" "}
            <span className="font-medium">{effectiveJournalPolicy?.archiveAfterMonths ?? 18}</span> month(s).
          </div>
          <div className="rounded-md border bg-muted/30 px-3 py-2">
            Scheduled archive runs default to{" "}
            <span className="font-medium">{effectiveJournalPolicy?.archiveCronDryRun ? "dry run mode" : "live run mode"}</span>.
          </div>
        </CardContent>
      </Card>

      {showManualEntry ? (
      <Card>
        <CardHeader>
          <CardTitle>
            <Tooltip content="Use this for adjustments or corrections that are not auto-generated.">
              <span className="cursor-help">Quick manual entry</span>
            </Tooltip>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="sm:col-span-2 lg:col-span-3 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground space-y-2">
            <div className="font-semibold text-foreground">Debit/Credit cheat sheet</div>
            <div>Debit increases Assets, Expenses - Credit increases Liabilities, Equity, Revenue</div>
            <div className="text-[11px] leading-relaxed">
              Examples: Pay supplier from bank: Debit Accounts Payable, Credit Bank. Customer pays invoice: Debit Bank, Credit Accounts Receivable.
            </div>
          </div>
          <div className="sm:col-span-2 lg:col-span-3 text-xs text-muted-foreground">
            Manual entries are saved as drafts and require approval before posting to the ledger.
          </div>
          <Input
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
          />
          <Input
            placeholder="Reason (required)"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm text-foreground"
            value={manualCategory}
            onChange={(e) => setManualCategory(e.target.value as ManualCategory | "")}
          >
            <option value="">Manual category (required)</option>
            {MANUAL_CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <Tooltip content="Enter the total amount for the entry.">
            <Input
              placeholder="Amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Tooltip>
          <Input
            className="sm:col-span-2 lg:col-span-3"
            placeholder="Exception note (required outside period-end adjustment)"
            value={manualExceptionNote}
            onChange={(e) => setManualExceptionNote(e.target.value)}
          />
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm text-foreground sm:col-span-2 lg:col-span-3"
            value={manualPriorPeriodId}
            onChange={(e) => setManualPriorPeriodId(e.target.value)}
          >
            <option value="">No prior-period reference</option>
            {closedPeriods.map((period) => (
              <option key={period.id} value={period.id}>
                {period.name} ({new Date(period.startDate).toLocaleDateString()} - {new Date(period.endDate).toLocaleDateString()})
              </option>
            ))}
          </select>
          {manualPriorPeriodId ? (
            <Input
              className="sm:col-span-2 lg:col-span-3"
              placeholder="Prior-period amendment note (required, 12+ chars)"
              value={manualPriorPeriodNote}
              onChange={(e) => setManualPriorPeriodNote(e.target.value)}
            />
          ) : null}
          {amount.length > 0 && amountInvalid ? (
            <div className="sm:col-span-2 lg:col-span-3 text-xs text-amber-600">
              Enter an amount greater than zero.
            </div>
          ) : null}
          <label className="grid gap-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              Debit account
              <Tooltip content="Select the account to debit.">
                <span className="cursor-help text-xs text-muted-foreground">?</span>
              </Tooltip>
            </span>
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm text-foreground"
              value={debitAccountId}
              onChange={(e) => setDebitAccountId(e.target.value)}
            >
              <option value="">Select debit</option>
              {manualAccountOptions.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.code} - {acc.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              Credit account
              <Tooltip content="Select the account to credit.">
                <span className="cursor-help text-xs text-muted-foreground">?</span>
              </Tooltip>
            </span>
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm text-foreground"
              value={creditAccountId}
              onChange={(e) => setCreditAccountId(e.target.value)}
            >
              <option value="">Select credit</option>
              {manualAccountOptions.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.code} - {acc.name}
                </option>
              ))}
            </select>
          </label>
          <div className="sm:col-span-2 lg:col-span-3 text-xs text-muted-foreground">
            Manual entries are limited to balance sheet accounts (assets, liabilities, equity).
          </div>
          {sameAccountSelected ? (
            <div className="sm:col-span-2 lg:col-span-3 text-xs text-amber-600">
              Debit and credit accounts are the same. Use different accounts to record a
              valid entry.
            </div>
          ) : null}
          <div className="sm:col-span-2 lg:col-span-3">
            {sameAccountSelected || amountInvalid ? (
              <Tooltip
                content={
                  sameAccountSelected
                    ? "Select different debit and credit accounts."
                    : "Enter an amount greater than zero."
                }
              >
                <span>
                  <Button
                    onClick={createEntry}
                    disabled={saving || sameAccountSelected || amountInvalid}
                  >
                    {saving ? "Saving..." : "Save draft"}
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button onClick={createEntry} disabled={saving}>
                {saving ? "Saving..." : "Save draft"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      ) : null}

      {showManualEntry ? (
      <Card>
        <CardHeader>
          <CardTitle>Full journal entry</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              type="date"
              value={fullEntryDate}
              onChange={(e) => setFullEntryDate(e.target.value)}
            />
            <Input
              placeholder="Reason (required)"
              value={fullMemo}
              onChange={(e) => setFullMemo(e.target.value)}
            />
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm text-foreground"
              value={fullManualCategory}
              onChange={(e) => setFullManualCategory(e.target.value as ManualCategory | "")}
            >
              <option value="">Manual category (required)</option>
              {MANUAL_CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <div className="text-xs text-muted-foreground flex items-center justify-between border rounded-md px-3">
              <span>Debits: {formatCurrency(fullTotals.debitTotal)}</span>
              <span>Credits: {formatCurrency(fullTotals.creditTotal)}</span>
            </div>
            <Input
              className="sm:col-span-2 lg:col-span-3"
              placeholder="Exception note (required outside period-end adjustment)"
              value={fullManualExceptionNote}
              onChange={(e) => setFullManualExceptionNote(e.target.value)}
            />
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm text-foreground sm:col-span-2 lg:col-span-3"
              value={fullManualPriorPeriodId}
              onChange={(e) => setFullManualPriorPeriodId(e.target.value)}
            >
              <option value="">No prior-period reference</option>
              {closedPeriods.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.name} ({new Date(period.startDate).toLocaleDateString()} - {new Date(period.endDate).toLocaleDateString()})
                </option>
              ))}
            </select>
            {fullManualPriorPeriodId ? (
              <Input
                className="sm:col-span-2 lg:col-span-3"
                placeholder="Prior-period amendment note (required, 12+ chars)"
                value={fullManualPriorPeriodNote}
                onChange={(e) => setFullManualPriorPeriodNote(e.target.value)}
              />
            ) : null}
          </div>
          <div className="space-y-2">
            {fullLines.map((line) => (
              <div
                key={line.id}
                className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1.2fr_0.9fr_0.9fr_1fr_1fr_auto]"
              >
                <select
                  className="h-10 rounded-md border bg-background px-3 text-sm text-foreground"
                  value={line.accountId}
                  onChange={(e) => updateFullLine(line.id, "accountId", e.target.value)}
                >
                  <option value="">Select account</option>
                  {manualAccountOptions.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.code} - {acc.name}
                    </option>
                  ))}
                </select>
                <Input
                  placeholder="Debit"
                  inputMode="decimal"
                  value={line.debit}
                  onChange={(e) => updateFullLine(line.id, "debit", e.target.value)}
                />
                <Input
                  placeholder="Credit"
                  inputMode="decimal"
                  value={line.credit}
                  onChange={(e) => updateFullLine(line.id, "credit", e.target.value)}
                />
                <select
                  className="h-10 rounded-md border bg-background px-3 text-sm text-foreground"
                  value={line.taxCodeId}
                  onChange={(e) => updateFullLine(line.id, "taxCodeId", e.target.value)}
                >
                  <option value="">Tax code (optional)</option>
                  {taxCodes.map((code) => (
                    <option key={code.id} value={code.id}>
                      {code.name}
                    </option>
                  ))}
                </select>
                <Input
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => updateFullLine(line.id, "description", e.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeFullLine(line.id)}
                  disabled={fullLines.length <= 2}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={addFullLine}>
              Add line
            </Button>
            <Button type="button" variant="outline" onClick={addVatSaleTemplate}>
              VAT sale template
            </Button>
            {autoVatEnabled ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={autoVatEnabled}
                  onChange={(e) => setAutoVatEnabled(e.target.checked)}
                />
                Auto-calc VAT from Sales Revenue
              </label>
            ) : null}
            <Button type="button" onClick={createFullEntry} disabled={fullSaving}>
              {fullSaving ? "Saving..." : "Save draft"}
            </Button>
          </div>
          {Math.abs(fullTotals.diff) > 0.01 ? (
            <p className="text-xs text-amber-600">
              Debits and credits must match. Current difference:{" "}
              {formatCurrency(fullTotals.diff)}
            </p>
          ) : null}
        </CardContent>
      </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Recent entries</CardTitle>
        </CardHeader>
        <CardContent>
          {showOnboardingTip ? (
            <div className="mb-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
              <div className="font-medium text-foreground">Journal quick tour</div>
              <div className="mt-1 text-muted-foreground">
                Use <span className="font-medium text-foreground">Review mode</span> for focused anomaly cleanup,
                click <span className="font-medium text-foreground">?</span> for keyboard shortcuts, and use{" "}
                <span className="font-medium text-foreground">Approve + next draft</span> to clear draft queues
                faster.
              </div>
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => {
                    setShowOnboardingTip(false);
                    if (typeof window !== "undefined") {
                      window.localStorage.setItem("accounting.journal.onboardingSeen.v1", "1");
                    }
                  }}
                >
                  Got it
                </Button>
              </div>
            </div>
          ) : null}
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2 text-xs">
            <span className="font-medium">Draft queue:</span>
            <span>{draftQueue.count} total</span>
            <span>Oldest age: {draftQueue.oldest ? `${draftQueue.oldestAgeDays}d` : "-"}</span>
            <span className="max-w-[320px] truncate text-muted-foreground">
              Oldest memo: {draftQueue.oldest?.memo || "-"}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[11px]"
              disabled={!draftQueue.oldest}
              onClick={() => {
                if (!draftQueue.oldest) return;
                setStatusFilter("DRAFT");
                setSingleApproveEntry(draftQueue.oldest);
                setActiveEntryId(draftQueue.oldest.id);
              }}
            >
              Approve oldest
            </Button>
          </div>
          <div
            className="sticky z-20 mb-3 rounded-md border bg-background/95 p-2 text-sm backdrop-blur supports-[backdrop-filter]:bg-background/80"
            style={{ top: "var(--admin-nav-height, 4rem)" }}
          >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="hidden sm:flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-md border bg-muted/40 px-2 py-1">
                Scope: {scopeLabel}
              </span>
              <span className="rounded-md border bg-muted/40 px-2 py-1">
                Status: {statusFilter || "All"}
              </span>
              <span className="rounded-md border bg-muted/40 px-2 py-1">
                Source: {sourceFilter || "All"}
              </span>
              <span className="rounded-md border bg-muted/40 px-2 py-1">
                Archive: {includeArchive ? "Included" : "Recent only"}
              </span>
              <span className="rounded-md border bg-muted/40 px-2 py-1">
                Entries: {totalEntries}
              </span>
              <span className="rounded-md border bg-muted/40 px-2 py-1">
                Archived in view: {tableEntries.filter((entry) => Boolean(entry.archivedAt)).length}
              </span>
            </div>
            <div className="sm:hidden flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              <span className="rounded-md border bg-muted/40 px-2 py-1">
                Scope: {scopeLabel} · Status: {statusFilter || "All"} · Source:{" "}
                {sourceFilter || "All"}
              </span>
              <span className="rounded-md border bg-muted/40 px-2 py-1">
                Archive: {includeArchive ? "Included" : "Recent only"}
              </span>
              <span className="rounded-md border bg-muted/40 px-2 py-1">
                Entries: {totalEntries}
              </span>
              <span className="rounded-md border bg-muted/40 px-2 py-1">
                Archived: {tableEntries.filter((entry) => Boolean(entry.archivedAt)).length}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={showAdvancedJournalFilters ? "default" : "outline"}
                onClick={() => setShowAdvancedJournalFilters((v) => !v)}
              >
                {showAdvancedJournalFilters ? "Hide advanced filters" : "Show advanced filters"}
              </Button>
              <Button size="sm" variant="ghost" onClick={clearJournalFilters}>
                Reset
              </Button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <Input
              className="h-9 w-full sm:w-64"
              placeholder="Search memo/source"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="POSTED">Posted</option>
              <option value="VOID">Void</option>
            </select>
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
            >
              <option value="">All sources</option>
              <option value="ORDER">Order</option>
              <option value="PAYMENT">Payment</option>
              <option value="EXPENSE">Expense</option>
              <option value="PURCHASE">Purchase</option>
              <option value="PAYROLL">Payroll</option>
              <option value="MANUAL">Manual</option>
            </select>
            <Button
              size="sm"
              variant={outOfBalanceOnly ? "default" : "outline"}
              onClick={() => setOutOfBalanceOnly((v) => !v)}
            >
              Out-of-balance only ({outOfBalanceCount})
            </Button>
            <Button
              size="sm"
              variant={includeArchive ? "default" : "outline"}
              onClick={() => setIncludeArchive((v) => !v)}
              title="Include older historical journal entries."
            >
              Include archive
            </Button>
            <div className="inline-flex items-center gap-1 rounded-md border px-1 py-1">
              <Button
                size="sm"
                variant={sortBy === "date" ? "default" : "ghost"}
                className="h-7 px-2 text-[11px]"
                onClick={() => toggleSort("date")}
              >
                Date {sortBy === "date" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </Button>
              <Button
                size="sm"
                variant={sortBy === "status" ? "default" : "ghost"}
                className="h-7 px-2 text-[11px]"
                onClick={() => toggleSort("status")}
              >
                Status {sortBy === "status" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </Button>
              <Button
                size="sm"
                variant={sortBy === "amount" ? "default" : "ghost"}
                className="h-7 px-2 text-[11px]"
                onClick={() => toggleSort("amount")}
              >
                Amount {sortBy === "amount" ? (sortDir === "asc" ? "↑" : "↓") : ""}
              </Button>
            </div>
            {searchQueryPending || (isFetching && searchQuery.trim()) ? (
              <span className="text-xs text-muted-foreground">Searching...</span>
            ) : null}
          </div>
          {queryError ? (
            <div className="sticky top-[calc(var(--admin-nav-height,4rem)+8px)] z-20 mt-2 flex items-center justify-between gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
              <span>{queryError}</span>
              <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => refetchEntries()}>
                Retry
              </Button>
            </div>
          ) : null}
          {showAdvancedJournalFilters ? (
          <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Input
              className="h-9 w-full sm:w-56"
              placeholder="Search memo/source"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <Input
              className="h-9 w-full sm:w-56"
              placeholder="Batch/Link ID"
              value={linkQuery}
              onChange={(e) => setLinkQuery(e.target.value)}
            />
            <Input
              className="h-9 w-full sm:w-56"
              placeholder="Account code/name (e.g., 1000)"
              value={accountQuery}
              onChange={(e) => setAccountQuery(e.target.value)}
            />
            <Tooltip content="Filter entries by a specific account.">
              <span className="text-muted-foreground cursor-help">Account</span>
            </Tooltip>
            <select
              className="h-9 w-full sm:w-auto rounded-md border bg-background px-3 text-sm"
              value={accountFilterId}
              onChange={(e) => setAccountFilterId(e.target.value)}
            >
              <option value="">All accounts</option>
              {accountOptions.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} - {account.name}
                </option>
              ))}
            </select>
            <div className="flex flex-wrap items-center gap-1">
              {accountDrillCodes.map((code) => {
                const id = accountIdByCode.get(code) || "";
                if (!id) return null;
                return (
                  <Button
                    key={code}
                    size="sm"
                    variant={accountFilterId === id ? "default" : "outline"}
                    className="h-7 px-2 text-[11px]"
                    onClick={() =>
                      accountFilterId === id ? setAccountFilterId("") : applyAccountDrill(code, id)
                    }
                  >
                    {code}
                  </Button>
                );
              })}
            </div>
            <Tooltip content="Filter entries by source type.">
              <span className="text-muted-foreground cursor-help">Source</span>
            </Tooltip>
            <select
              className="h-9 w-full sm:w-auto rounded-md border bg-background px-3 text-sm"
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
            >
              <option value="">All</option>
              <option value="ORDER">Order</option>
              <option value="PAYMENT">Payment</option>
              <option value="EXPENSE">Expense</option>
              <option value="PURCHASE">Purchase</option>
              <option value="PAYROLL">Payroll</option>
              <option value="MANUAL">Manual</option>
            </select>
            <div className="flex flex-wrap items-center gap-1">
              {sourceChipOptions.map((src) => (
                <Button
                  key={src}
                  size="sm"
                  variant={sourceFilter === src ? "default" : "outline"}
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setSourceFilter((prev) => (prev === src ? "" : src))}
                >
                  {src} ({sourceCounts.get(src) || 0})
                </Button>
              ))}
            </div>
            <Tooltip content="Filter entries by fiscal period.">
              <span className="text-muted-foreground cursor-help">Period filter</span>
            </Tooltip>
            <Tooltip content="All non-archived = full active history only. All time = lifetime history (includes archived).">
              <span className="text-xs text-muted-foreground cursor-help rounded border px-1 py-0.5">?</span>
            </Tooltip>
            <select
              className="h-9 w-full sm:w-auto rounded-md border bg-background px-3 text-sm"
              value={periodFilter}
              onChange={(e) => {
                hasUserSelected.current = true;
                const next = e.target.value;
                setPeriodFilter(next);
                if (next === "all") setIncludeArchive(true);
                if (next === "recent" || next === "all_non_archived") setIncludeArchive(false);
              }}
            >
                <option value="recent">Recent 90 days (default)</option>
                <option value="all_non_archived">All non-archived entries</option>
                <option value="all">All time</option>
                {currentOpenPeriod ? (
                  <option value="current">Current open period</option>
                ) : null}
                {periods.map((period) => (
                  <option key={period.id} value={period.id}>
                    {period.name} ({period.status})
                  </option>
                ))}
              </select>
            {selectedPeriod ? (
              <span className="text-xs text-muted-foreground">
                {new Date(selectedPeriod.startDate).toLocaleDateString()} -{" "}
                {new Date(selectedPeriod.endDate).toLocaleDateString()}
              </span>
            ) : null}
            <Tooltip content="Filter entries by date range (overrides period).">
              <span className="text-muted-foreground cursor-help">Date range</span>
            </Tooltip>
            <Input
              className="h-9 w-full sm:w-[140px]"
              type="date"
              value={dateStart}
              onChange={(e) => setDateStart(e.target.value)}
            />
            <Input
              className="h-9 w-full sm:w-[140px]"
              type="date"
              value={dateEnd}
              onChange={(e) => setDateEnd(e.target.value)}
            />
            {dateStart || dateEnd ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDateStart("");
                  setDateEnd("");
                }}
              >
                Clear dates
              </Button>
            ) : null}
            <Tooltip content="Draft entries require approval to post.">
              <span className="text-muted-foreground cursor-help">Status</span>
            </Tooltip>
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
                <option value="">All</option>
                <option value="DRAFT">Draft</option>
                <option value="POSTED">Posted</option>
                <option value="VOID">Void</option>
              </select>
            <Button
              size="sm"
              variant={outOfBalanceOnly ? "default" : "outline"}
              onClick={() => setOutOfBalanceOnly((v) => !v)}
            >
              Out-of-balance only ({outOfBalanceCount})
            </Button>
            <Button
              size="sm"
              variant={largestVarianceFirst ? "default" : "outline"}
              onClick={() => {
                setOutOfBalanceOnly(true);
                setLargestVarianceFirst((v) => !v);
              }}
            >
              Largest variance first
            </Button>
            <Button
              size="sm"
              variant={exceptionMissingRefOnly ? "default" : "outline"}
              onClick={() => setExceptionMissingRefOnly((v) => !v)}
            >
              Missing source ref ({exceptionCounts.missingRef})
            </Button>
            <Button
              size="sm"
              variant={exceptionLargeAmountOnly ? "default" : "outline"}
              onClick={() => setExceptionLargeAmountOnly((v) => !v)}
            >
              Large amount ({exceptionCounts.largeAmount})
            </Button>
            <Button
              size="sm"
              variant={exceptionStaleDraftOnly ? "default" : "outline"}
              onClick={() => setExceptionStaleDraftOnly((v) => !v)}
            >
              Stale drafts 7d+ ({exceptionCounts.staleDraft})
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={clearJournalFilters}
            >
              Clear filters
            </Button>
            <select
              className="h-9 w-full sm:w-auto rounded-md border bg-background px-3 text-sm"
              value={selectedViewId}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) {
                  setSelectedViewId("");
                  return;
                }
                applySavedView(id);
              }}
            >
              <option value="">Saved journal views</option>
              {savedViews.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.state.includeArchive ? "[Archive] " : ""}{view.name}
                </option>
              ))}
            </select>
            {selectedViewId && savedViews.find((view) => view.id === selectedViewId)?.state.includeArchive ? (
              <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground">
                <Lock className="h-3 w-3" />
                Archive view
              </span>
            ) : null}
            <Button size="sm" variant="outline" onClick={saveCurrentView}>
              Save view
            </Button>
            {selectedViewId ? (
              <Button size="sm" variant="outline" onClick={renameSelectedView}>
                Rename view
              </Button>
            ) : null}
            {selectedViewId ? (
              <Button
                size="sm"
                variant={defaultViewId === selectedViewId ? "default" : "outline"}
                onClick={() =>
                  setDefaultViewId((prev) => (prev === selectedViewId ? "" : selectedViewId))
                }
              >
                {defaultViewId === selectedViewId ? "Default view" : "Set as default"}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant={autoRestoreLastView ? "default" : "outline"}
              onClick={() => setAutoRestoreLastView((v) => !v)}
            >
              Auto-restore last view
            </Button>
            {selectedViewId ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => removeSavedView(selectedViewId)}
              >
                Remove view
              </Button>
            ) : null}
            <div className="inline-flex items-center gap-1 rounded-md border px-1 py-1">
              <Button
                size="sm"
                variant={rowDensity === "comfortable" ? "default" : "ghost"}
                className="h-7 px-2 text-[11px]"
                onClick={() => setRowDensity("comfortable")}
              >
                Comfortable
              </Button>
              <Button
                size="sm"
                variant={rowDensity === "compact" ? "default" : "ghost"}
                className="h-7 px-2 text-[11px]"
                onClick={() => setRowDensity("compact")}
              >
                Compact
              </Button>
            </div>
            <Button
              size="sm"
              variant={reviewMode ? "default" : "outline"}
              onClick={() => setReviewMode((v) => !v)}
            >
              Review mode
            </Button>
            {canArchive ? (
              <div className="inline-flex flex-wrap items-center gap-2 rounded-md border px-2 py-1">
                <span className="text-xs text-muted-foreground">Archive posted/void older than</span>
                <Input
                  className="h-8 w-16"
                  type="number"
                  min={1}
                  max={120}
                  value={String(archiveMonths)}
                  onChange={(e) => {
                    archiveMonthsTouched.current = true;
                    setArchiveMonths(Math.max(1, Math.min(120, Number(e.target.value || 18))));
                  }}
                />
                <span className="text-xs text-muted-foreground">months</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  disabled={archiveRunning}
                  onClick={() => runJournalArchive(true)}
                >
                  {archiveRunning ? "Working..." : "Dry run archive"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  disabled={archiveRunning}
                  onClick={() => runJournalArchive(false)}
                >
                  {archiveRunning ? "Working..." : "Run archive"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  disabled={archiveRunning || !lastArchiveRunAt || !undoArchiveUntilMs || undoClockMs > undoArchiveUntilMs}
                  onClick={undoLastArchiveRun}
                  title="Undo last archive batch (5-minute window)."
                >
                  Undo last batch
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={exportArchiveRunsCsv}
                >
                  Export archive runs CSV
                </Button>
              </div>
            ) : null}
            {entryDirectionFilter ? (
              <span className="text-xs text-muted-foreground">
                Direction filter: {entryDirectionFilter === "debit" ? "Debit-heavy lines" : "Credit-heavy lines"}
              </span>
            ) : null}
            {!canApprove ? (
              <span className="text-xs text-muted-foreground">
                Approval actions are limited to admin/accountant roles.
              </span>
            ) : null}
            {draftEntries.length > 0 && canApprove ? (
              <Tooltip content="Approve selected draft entries.">
                <span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(approveDisabledReason) || bulkApproving}
                    onClick={() => setShowBulkApproveDialog(true)}
                    title={approveDisabledReason || ""}
                  >
                    {bulkApproving ? "Approving..." : "Approve selected"}
                  </Button>
                </span>
              </Tooltip>
            ) : null}
            {canApprove ? (
              <div className="flex flex-col gap-1">
                <Button
                  size="sm"
                  variant={selectDraftsAcrossPages ? "default" : "outline"}
                  className="h-7 px-2 text-[11px]"
                  disabled={draftIdsFetching}
                  onClick={() => {
                    setSelectDraftsAcrossPages((prev) => {
                      const next = !prev;
                      if (!next) setSelectedEntryIds([]);
                      return next;
                    });
                  }}
                >
                  {draftIdsFetching
                    ? "Loading drafts..."
                    : selectDraftsAcrossPages
                      ? `Across pages selected (${selectedEntryIds.length})`
                      : "Select drafts across pages"}
                </Button>
                {selectDraftsAcrossPages && Boolean((draftIdsData as { truncated?: boolean } | undefined)?.truncated) ? (
                  <span className="text-[11px] text-amber-700">
                    Large result set: selection capped to first {Number((draftIdsData as { max?: number } | undefined)?.max || 0)} draft IDs.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          {selectedEntryIds.length > 0 && canApprove ? (
            <div
              className="sticky z-10 mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/30 bg-background/95 px-2 py-2 text-xs shadow-sm"
              style={{ top: "calc(var(--admin-nav-height, 4rem) + 52px)" }}
            >
              <span>
                <span className="font-medium">{selectedEntryIds.length}</span> draft entr{selectedEntryIds.length === 1 ? "y" : "ies"} selected
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  disabled={Boolean(approveDisabledReason) || bulkApproving}
                  onClick={() => setShowBulkApproveDialog(true)}
                  title={approveDisabledReason || ""}
                >
                  {bulkApproving ? "Approving..." : "Approve selected"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setSelectedEntryIds([])}
                >
                  Clear selection
                </Button>
              </div>
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Quick presets:</span>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => applyQuickPreset("today_posted")}>
              Today posted
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => applyQuickPreset("draft_only")}>
              Draft only
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => applyQuickPreset("payments_today")}>
              Payments today
            </Button>
            {canArchive ? (
              <span className="text-xs text-muted-foreground">
                Eligible now: {archiveEligibleCount ?? "-"} | Undo window:{" "}
                {undoArchiveUntilMs && undoClockMs <= undoArchiveUntilMs
                  ? `${Math.max(0, Math.ceil((undoArchiveUntilMs - undoClockMs) / 1000))}s`
                  : "-"}
              </span>
            ) : null}
            {latestCronArchiveRun ? (
              <span className="text-xs text-muted-foreground">
                Last cron archive: {new Date(String(latestCronArchiveRun.createdAt || "")).toLocaleString()} ({latestCronArchiveRun.action === "journal.archive.cron.dry_run" ? "dry run" : "run"})
              </span>
            ) : null}
          </div>
          {canArchive ? (
            <div className="mt-2 rounded-md border bg-muted/20 p-3 text-xs">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">Archive activity timeline</span>
                <Link
                  href="/admin/audit?entityType=JournalEntry"
                  className="underline text-muted-foreground hover:text-foreground"
                >
                  Open archive logs
                </Link>
              </div>
              {archiveTimelineRows.length === 0 ? (
                <div className="text-muted-foreground">No archive activity has been recorded yet.</div>
              ) : (
                <div className="space-y-1">
                  {archiveTimelineRows.map((line, idx) => (
                    <div key={`${idx}-${line}`} className="text-muted-foreground">
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          </div>
          ) : null}
          </div>
            <div className="mb-3 grid gap-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
              <div className="rounded-md border bg-muted/40 px-2 py-1">Entries: {periodSummary.total}</div>
              <div className="rounded-md border bg-muted/40 px-2 py-1">Posted: {periodSummary.posted}</div>
              <div className="rounded-md border bg-muted/40 px-2 py-1">Draft: {periodSummary.draft}</div>
              <div className="rounded-md border bg-muted/40 px-2 py-1">Void: {periodSummary.void}</div>
              <div className="rounded-md border bg-muted/40 px-2 py-1">Debits: {formatCurrency(periodSummary.debit)}</div>
              <div className="rounded-md border bg-muted/40 px-2 py-1">Credits: {formatCurrency(periodSummary.credit)}</div>
            </div>
            <div className="mb-3 text-xs text-muted-foreground">
              <details className="lg:hidden">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Legends
                </summary>
                <div className="mt-1 space-y-1">
                  <div>
                    Status: Draft = pending approval, Posted = approved and posted, Void = canceled.
                  </div>
                  <div>Source: Manual = created by staff, System = auto-generated.</div>
                </div>
              </details>
              <div className="hidden space-y-1 lg:block">
                <div>
                  Status: Draft = pending approval, Posted = approved and posted, Void = canceled.
                </div>
                <div>Source: Manual = created by staff, System = auto-generated.</div>
              </div>
            </div>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading journal...</p>
            ) : outOfBalanceOnly && tableEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No out-of-balance entries found for the current filters.
              </p>
            ) : tableEntries.length === 0 ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {searchQuery.trim()
                    ? "No entries match that search text."
                    : statusFilter === "DRAFT"
                      ? "No draft entries match this date/source selection."
                      : statusFilter === "POSTED"
                        ? "No posted entries match this date/source selection."
                        : statusFilter === "VOID"
                          ? "No void entries match this date/source selection."
                          : accountFilterId
                            ? "No entries found for the selected account."
                            : "No journal entries yet."}
                </p>
                {!searchQuery.trim() && periodFilter === "recent" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        hasUserSelected.current = true;
                        setPeriodFilter("all_non_archived");
                        setIncludeArchive(false);
                      }}
                    >
                      Switch to all non-archived
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setIncludeArchive(true)}
                    >
                      Include archive
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <>
              <div className="space-y-2 sm:hidden">
                {pagedEntries.map((entry) => {
                  const debitTotal = entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
                  const creditTotal = entry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
                  const isBalanced = Math.abs(getEntryImbalance(entry)) <= 0.01;
                  const isDraft = entry.status === "DRAFT";
                  const isExpanded = expandedEntryId === entry.id;
                  const approvedByRaw = entry.approvedBy?.name || entry.approvedBy?.email || "";
                  const approvedBy =
                    entry.status === "POSTED" && !approvedByRaw
                      ? entry.sourceType === "MANUAL"
                        ? "-"
                        : "System"
                      : approvedByRaw || "-";
                  return (
                    <div
                      key={`mobile-${entry.id}`}
                      className="rounded-md border bg-card p-2 text-xs space-y-2"
                      onClick={() => setActiveEntryId(entry.id)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-medium">{new Date(entry.entryDate).toLocaleDateString()}</div>
                          <div className="text-muted-foreground break-words">{entry.memo || "-"}</div>
                          <div className="mt-1">
                            {getSourceHref(entry) ? (
                              <Link href={getSourceHref(entry)} className="inline-flex">
                                <Badge variant="outline">{sourceTraceLabel(entry)}</Badge>
                              </Link>
                            ) : (
                              <Badge variant="outline">{sourceTraceLabel(entry)}</Badge>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <div>{entry.status}</div>
                          {entry.archivedAt ? (
                            <div className="mt-1">
                              <Badge className="border-amber-300 bg-amber-50 text-amber-800">Archived</Badge>
                            </div>
                          ) : null}
                          <div className="mt-1">
                            {isBalanced ? (
                              <Badge variant="success">Balanced</Badge>
                            ) : (
                              <Badge variant="warning">Diff {formatCurrency(Math.abs(getEntryImbalance(entry)))}</Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-muted-foreground">
                        <div>Source: {entry.sourceType}</div>
                        <div className="text-right">Approved: {entry.status === "POSTED" ? approvedBy : "-"}</div>
                        <div>Dr {formatCurrency(debitTotal)}</div>
                        <div className="text-right">Cr {formatCurrency(creditTotal)}</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {isDraft && canApprove ? (
                          <>
                            <input
                              type="checkbox"
                              checked={selectedEntryIds.includes(entry.id)}
                              onChange={(e) => {
                                setSelectDraftsAcrossPages(false);
                                setSelectedEntryIds((prev) =>
                                  e.target.checked ? [...prev, entry.id] : prev.filter((id) => id !== entry.id),
                                );
                              }}
                            />
                            <Button size="sm" variant="outline" onClick={() => setSingleApproveEntry(entry)}>
                              Approve
                            </Button>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {!canApprove
                              ? "No approval permission"
                              : entry.archivedAt
                                ? "Archived entry"
                                : entry.status !== "DRAFT"
                                  ? "Already posted/void"
                                  : "Cannot approve"}
                          </span>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setExpandedEntryId((prev) =>
                              prev === entry.id ? null : entry.id,
                            )
                          }
                        >
                          {isExpanded ? "Hide lines" : "View lines"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            try {
                              const url = new URL(window.location.href);
                              url.searchParams.set("entry", entry.id);
                              await navigator.clipboard.writeText(url.toString());
                              toast.success("Entry link copied.");
                            } catch {
                              toast.error("Failed to copy entry link.");
                            }
                          }}
                        >
                          Copy link
                        </Button>
                      </div>
                      {isExpanded ? (
                        <div className="space-y-2 rounded-md border bg-muted/30 p-2">
                          <Input
                            className="h-8 w-full"
                            placeholder="Filter lines by account/description/tax code"
                            value={lineSearchByEntryId[entry.id] || ""}
                            onChange={(e) =>
                              setLineSearchByEntryId((prev) => ({
                                ...prev,
                                [entry.id]: e.target.value,
                              }))
                            }
                          />
                          {entry.lines.length === 0 ? (
                            <div className="text-muted-foreground">No lines recorded.</div>
                          ) : (() => {
                              const lineSearch = (lineSearchByEntryId[entry.id] || "").trim().toLowerCase();
                              const visibleLines = lineSearch
                                ? entry.lines.filter((line) => {
                                    const haystack = [
                                      line.account?.code || "",
                                      line.account?.name || "",
                                      line.description || "",
                                      line.taxCode?.name || "",
                                    ]
                                      .join(" ")
                                      .toLowerCase();
                                    return haystack.includes(lineSearch);
                                  })
                                : entry.lines;
                              if (visibleLines.length === 0) {
                                return <div className="text-muted-foreground">No journal lines match this line filter.</div>;
                              }
                              return visibleLines.map((line) => (
                                <div key={line.id} className="rounded-md border bg-background p-2">
                                  <div className="font-medium">
                                    {line.account.code} - {line.account.name}
                                  </div>
                                  <div className="text-muted-foreground">{line.description || "-"}</div>
                                  <div className="mt-1 grid grid-cols-2 gap-2 text-muted-foreground">
                                    <div>Dr {formatCurrency(Number(line.debit || 0))}</div>
                                    <div className="text-right">Cr {formatCurrency(Number(line.credit || 0))}</div>
                                  </div>
                                </div>
                              ));
                            })()}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-col gap-2 text-xs sm:hidden">
                <div className="text-muted-foreground">
                  Showing{" "}
                  <span className="font-medium text-foreground">
                    {totalEntries === 0 ? 0 : (page - 1) * rowsPerPage + 1}
                  </span>{" "}
                  to{" "}
                  <span className="font-medium text-foreground">
                    {Math.min(page * rowsPerPage, totalEntries)}
                  </span>{" "}
                  of{" "}
                  <span className="font-medium text-foreground">{totalEntries}</span> entries
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-muted-foreground" htmlFor="journal-rows-per-page-mobile">
                    Rows
                  </label>
                  <select
                    id="journal-rows-per-page-mobile"
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                    value={rowsPerPage}
                    onChange={(e) => setRowsPerPage(Number(e.target.value) as 25 | 50 | 100)}
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    disabled={page <= 1}
                    onClick={() => setPage(1)}
                  >
                    First
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Prev
                  </Button>
                  <span className="text-muted-foreground">
                    Page <span className="font-medium text-foreground">{page}</span> of{" "}
                    <span className="font-medium text-foreground">{totalPages}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    disabled={page >= totalPages}
                    onClick={() => setPage(totalPages)}
                  >
                    Last
                  </Button>
                  <Input
                    className="h-8 w-16"
                    inputMode="numeric"
                    placeholder="Page"
                    value={goToPageInput}
                    onChange={(e) => setGoToPageInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") jumpToPage();
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    onClick={jumpToPage}
                  >
                    Go
                  </Button>
                </div>
              </div>
              <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {draftEntries.length > 0 && canApprove ? (
                        <Tooltip content="Select all draft entries on this page.">
                          <input
                            type="checkbox"
                            checked={allDraftSelected && !selectDraftsAcrossPages}
                            onChange={(e) => {
                              setSelectDraftsAcrossPages(false);
                              setSelectedEntryIds(
                                e.target.checked
                                  ? draftEntries.map((entry) => entry.id)
                                  : [],
                              );
                            }}
                          />
                        </Tooltip>
                      ) : null}
                    </TableHead>
                    <TableHead>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1"
                        onClick={() => toggleSort("date")}
                      >
                        Date {sortBy === "date" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                      </button>
                    </TableHead>
                    <TableHead>Memo</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1"
                        onClick={() => toggleSort("status")}
                      >
                        Status {sortBy === "status" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                      </button>
                    </TableHead>
                    <TableHead>Balance</TableHead>
                    {!reviewMode ? <TableHead>Approved By</TableHead> : null}
                    {!reviewMode ? (
                      <TableHead className="text-right">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1"
                          onClick={() => toggleSort("amount")}
                        >
                          Entry totals {sortBy === "amount" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                        </button>
                      </TableHead>
                    ) : null}
                    <TableHead className="text-right">
                      {!canApprove ? (
                        <Tooltip content="Approval actions are limited to admin/accountant roles.">
                          <span className="cursor-help">Actions</span>
                        </Tooltip>
                      ) : (
                        "Actions"
                      )}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedEntries.map((entry) => {
                    const debitTotal = entry.lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
                    const creditTotal = entry.lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
                    const invoiceLine =
                      entry.sourceType === "ORDER"
                        ? entry.lines.find(
                            (line) => line.account?.code === "1100" && Number(line.debit || 0) > 0,
                          )
                        : null;
                    const approvedByRaw = entry.approvedBy?.name || entry.approvedBy?.email || "";
                    const approvedBy =
                      entry.status === "POSTED" && !approvedByRaw
                        ? entry.sourceType === "MANUAL"
                          ? "-"
                          : "System"
                        : approvedByRaw || "-";
                    const isDraft = entry.status === "DRAFT";
                    const isExpanded = expandedEntryId === entry.id;
                    const isActiveRow = activeEntryId === entry.id;
                    const lineSearch = (lineSearchByEntryId[entry.id] || "").trim().toLowerCase();
                    const visibleLines = lineSearch
                      ? entry.lines.filter((line) => {
                          const haystack = [
                            line.account?.code || "",
                            line.account?.name || "",
                            line.description || "",
                            line.taxCode?.name || "",
                          ]
                            .join(" ")
                            .toLowerCase();
                          return haystack.includes(lineSearch);
                        })
                      : entry.lines;
                    const isBalanced = Math.abs(getEntryImbalance(entry)) <= 0.01;
                    const missingReferenceRisk =
                      entry.status === "POSTED" &&
                      entry.sourceType !== "MANUAL" &&
                      !String(entry.sourceId || "").trim() &&
                      !String(entry.sourceLabel || "").trim();
                    const unusualAmountRisk = Math.max(Math.abs(debitTotal), Math.abs(creditTotal)) >= 25000;
                    const hasRisk = missingReferenceRisk || unusualAmountRisk;
                    const anomalyScore: "HIGH" | "MEDIUM" | null = missingReferenceRisk
                      ? "HIGH"
                      : unusualAmountRisk
                        ? "MEDIUM"
                        : null;
                    return (
                      <Fragment key={entry.id}>
                      <TableRow
                        data-journal-entry-row={entry.id}
                        className={`${hasRisk ? "bg-rose-50/40 dark:bg-rose-950/10" : ""} ${isActiveRow ? "bg-primary/5 ring-1 ring-primary/20" : ""} ${rowDensity === "compact" ? "[&>td]:py-1" : ""}`}
                        onClick={() => setActiveEntryId(entry.id)}
                      >
                      <TableCell>
                        {isDraft && canApprove ? (
                          <Tooltip content="Select this draft entry.">
                            <input
                              type="checkbox"
                                checked={selectedEntryIds.includes(entry.id)}
                                onChange={(e) => {
                                  setSelectDraftsAcrossPages(false);
                                  setSelectedEntryIds((prev) =>
                                    e.target.checked
                                      ? [...prev, entry.id]
                                      : prev.filter((id) => id !== entry.id),
                                  );
                                }}
                              />
                            </Tooltip>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          {new Date(entry.entryDate).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="max-w-[360px] whitespace-normal break-words">
                          {entry.memo || "-"}
                          <div className="mt-1">
                            {getSourceHref(entry) ? (
                              <Link href={getSourceHref(entry)} className="inline-flex">
                                <Badge variant="outline">{sourceTraceLabel(entry)}</Badge>
                              </Link>
                            ) : (
                              <Badge variant="outline">{sourceTraceLabel(entry)}</Badge>
                            )}
                          </div>
                          {anomalyScore ? (
                            <div className="mt-1">
                              <Badge
                                variant={
                                  anomalyScore === "HIGH" ? "destructive" : "warning"
                                }
                              >
                                {anomalyScore} anomaly
                              </Badge>
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Tooltip
                            content={
                              entry.sourceType === "MANUAL"
                                ? "Created by a staff member."
                                : "Created by the system."
                            }
                          >
                            <span className="cursor-help">{entry.sourceType}</span>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            <Tooltip
                              content={
                                entry.status === "DRAFT"
                                  ? "Pending approval."
                                  : entry.status === "POSTED"
                                    ? "Approved and posted."
                                    : "Voided entry."
                              }
                            >
                              <span className="cursor-help">{entry.status}</span>
                            </Tooltip>
                            {entry.archivedAt ? (
                              <Badge className="border-amber-300 bg-amber-50 text-amber-800">Archived</Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          {isBalanced ? (
                            <Badge variant="success">Balanced</Badge>
                          ) : (
                            <div className="flex flex-col items-start gap-1">
                              <Badge variant="warning">Out of balance</Badge>
                              <Badge variant="outline">
                                Diff {formatCurrency(Math.abs(getEntryImbalance(entry)))}
                              </Badge>
                            </div>
                          )}
                        </TableCell>
                        {!reviewMode ? <TableCell>{entry.status === "POSTED" ? approvedBy : "-"}</TableCell> : null}
                        {!reviewMode ? (
                          <TableCell className="text-right">
                            <div className="flex flex-col items-end gap-1">
                              <div className="text-sm">
                                {formatCurrency(debitTotal)}
                                <span className="ml-1 text-xs text-muted-foreground">Dr</span>
                              </div>
                              <div className="text-xs text-muted-foreground">
                                Cr {formatCurrency(creditTotal)}
                              </div>
                              {invoiceLine ? (
                                <div className="text-xs text-muted-foreground">
                                  Invoice {formatCurrency(Number(invoiceLine.debit || 0))}
                                </div>
                              ) : null}
                            </div>
                          </TableCell>
                        ) : null}
                        <TableCell className="text-right">
                          <div className="inline-flex flex-wrap items-center justify-end gap-2">
                            {isDraft && canApprove ? (
                              <Tooltip content="Approve this draft entry.">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setSingleApproveEntry(entry)}
                                >
                                  Approve
                                </Button>
                              </Tooltip>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {!canApprove
                                  ? "No approval permission"
                                  : entry.archivedAt
                                    ? "Archived entry"
                                    : entry.status !== "DRAFT"
                                      ? "Already posted/void"
                                      : "-"}
                              </span>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setExpandedEntryId((prev) =>
                                  prev === entry.id ? null : entry.id,
                                )
                              }
                            >
                              {isExpanded ? "Hide lines" : "View lines"}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={async () => {
                                try {
                                  const url = new URL(window.location.href);
                                  url.searchParams.set("entry", entry.id);
                                  await navigator.clipboard.writeText(url.toString());
                                  toast.success("Entry link copied.");
                                } catch {
                                  toast.error("Failed to copy entry link.");
                                }
                              }}
                            >
                              Copy link
                            </Button>
                            {getSourceHref(entry) ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={async () => {
                                  try {
                                    const href = getSourceHref(entry);
                                    if (!href) throw new Error("No source URL");
                                    const url = href.startsWith("http")
                                      ? href
                                      : `${window.location.origin}${href}`;
                                    await navigator.clipboard.writeText(url);
                                    toast.success("Source link copied.");
                                  } catch {
                                    toast.error("Failed to copy source link.");
                                  }
                                }}
                              >
                                Copy source
                              </Button>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                      {isExpanded ? (
                        <TableRow key={`${entry.id}-lines`}>
                          <TableCell colSpan={reviewMode ? 7 : 9} className="bg-muted/40">
                            <div className="space-y-2 text-sm">
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <Input
                                  className="h-8 w-full sm:w-80"
                                  placeholder="Filter lines by account/description/tax code"
                                  value={lineSearchByEntryId[entry.id] || ""}
                                  onChange={(e) =>
                                    setLineSearchByEntryId((prev) => ({
                                      ...prev,
                                      [entry.id]: e.target.value,
                                    }))
                                  }
                                />
                                {lineSearch ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[11px]"
                                    onClick={() =>
                                      setLineSearchByEntryId((prev) => ({
                                        ...prev,
                                        [entry.id]: "",
                                      }))
                                    }
                                  >
                                    Clear line filter
                                  </Button>
                                ) : null}
                              </div>
                              {visibleLines.length === 0 ? (
                                <div className="text-muted-foreground">
                                  No journal lines match this line filter.
                                </div>
                              ) : entry.lines.length === 0 ? (
                                <div className="text-muted-foreground">No lines recorded.</div>
                              ) : (
                                visibleLines.map((line) => (
                                  <div
                                    key={line.id}
                                    className="grid gap-2 border-b pb-2 last:border-b-0 last:pb-0 sm:grid-cols-2 lg:grid-cols-6"
                                  >
                                    <div className="sm:col-span-2 lg:col-span-2">
                                      <div className="font-medium">
                                        <button
                                          type="button"
                                          className="-ml-1 rounded px-1 text-left text-primary hover:underline"
                                          onClick={() => applyAccountDrill(line.account.code, line.account.id)}
                                          title={`Filter to ${line.account.code} entries`}
                                        >
                                          {line.account.code}
                                        </button>{" "}
                                        - {line.account.name}
                                      </div>
                                      <div className="text-xs text-muted-foreground break-words whitespace-normal">
                                        {line.description || "-"}
                                      </div>
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      Debit
                                      <div className="text-sm text-foreground">
                                        {formatCurrency(Number(line.debit || 0))}
                                      </div>
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      Credit
                                      <div className="text-sm text-foreground">
                                        {formatCurrency(Number(line.credit || 0))}
                                      </div>
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      Tax code
                                      <div className="text-sm text-foreground">
                                        {line.taxCode?.name || "-"}
                                      </div>
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      {line.account.code === "1100" ||
                                      (entry.sourceType === "PAYMENT" && Boolean(entry.sourceLabel))
                                        ? "AR balance after"
                                        : line.account.code === "2000"
                                        ? "AP balance after"
                                        : line.account.code === "2300"
                                        ? "Accrued balance after"
                                        : "Balance after"}
                                      <div className="text-sm text-foreground">
                                        {line.account.code === "1100" ||
                                        (entry.sourceType === "PAYMENT" && Boolean(entry.sourceLabel))
                                          ? formatCurrency(
                                              arBalanceByEntryId.get(entry.id) || 0,
                                            )
                                          : line.account.code === "2000" &&
                                            typeof entry.apBalanceAfter === "number"
                                          ? formatCurrency(entry.apBalanceAfter)
                                          : line.account.code === "2300"
                                          ? formatCurrency(
                                              accruedBalanceByEntryId.get(entry.id) || 0,
                                            )
                                          : "-"}
                                      </div>
                                    </div>
                                  </div>
                                ))
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
                </TableBody>
              </Table>
              <div className="mt-3 flex flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                <div className="text-muted-foreground">
                  Showing{" "}
                  <span className="font-medium text-foreground">
                    {totalEntries === 0 ? 0 : (page - 1) * rowsPerPage + 1}
                  </span>{" "}
                  to{" "}
                  <span className="font-medium text-foreground">
                    {Math.min(page * rowsPerPage, totalEntries)}
                  </span>{" "}
                  of{" "}
                  <span className="font-medium text-foreground">{totalEntries}</span>{" "}
                  entries
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-muted-foreground" htmlFor="journal-rows-per-page">
                    Rows
                  </label>
                  <select
                    id="journal-rows-per-page"
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                    value={rowsPerPage}
                    onChange={(e) => setRowsPerPage(Number(e.target.value) as 25 | 50 | 100)}
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Prev
                  </Button>
                  <span className="min-w-20 text-center text-muted-foreground">
                    Page <span className="font-medium text-foreground">{page}</span> of{" "}
                    <span className="font-medium text-foreground">{totalPages}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    disabled={page >= totalPages}
                    onClick={() => setPage(totalPages)}
                  >
                    Last
                  </Button>
                  <Input
                    className="h-8 w-16"
                    inputMode="numeric"
                    placeholder="Page"
                    value={goToPageInput}
                    onChange={(e) => setGoToPageInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") jumpToPage();
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    onClick={jumpToPage}
                  >
                    Go
                  </Button>
                </div>
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                Shortcuts: <span className="font-medium">J/K</span> move rows,{" "}
                <span className="font-medium">Enter</span> toggle lines,{" "}
                <span className="font-medium">A</span> approve active draft,{" "}
                <span className="font-medium">Shift+J/K</span> page jump,{" "}
                <span className="font-medium">Home/End</span> first/last row (or{" "}
                <span className="font-medium">G / Shift+G</span> fallback).
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-2 h-6 px-2 text-[11px]"
                  onClick={() => setShowShortcutHelp(true)}
                >
                  ?
                </Button>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Active row:{" "}
                {activeEntry ? (
                  <span className="font-medium text-foreground">
                    {activeEntry.id.slice(0, 12)}... ({activeEntry.status})
                  </span>
                ) : (
                  "-"
                )}
              </div>
              </div>
              </>
            )}
          </CardContent>
      </Card>
      <Dialog open={showBulkApproveDialog} onOpenChange={setShowBulkApproveDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Approve selected journal entries?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              You are about to post <span className="font-semibold">{selectedEntryIds.length}</span> draft entr{selectedEntryIds.length === 1 ? "y" : "ies"}.
            </p>
            {selectDraftsAcrossPages ? (
              <div className="rounded-md border p-2 text-xs text-muted-foreground">
                Cross-page selection is enabled. This action will approve all selected draft IDs across pages for the active server filters.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 rounded-md border p-2 text-xs">
                  <div>Debits: {formatCurrency(selectedDraftTotals.debit)}</div>
                  <div>Credits: {formatCurrency(selectedDraftTotals.credit)}</div>
                </div>
                <div className="rounded-md border p-2 text-xs">
                  <div className="mb-1 font-medium">Preview memos</div>
                  {selectedDraftEntries.slice(0, 3).map((entry) => (
                    <div key={entry.id} className="truncate">
                      - {entry.memo || "(no memo)"}
                    </div>
                  ))}
                  {selectedDraftEntries.length > 3 ? (
                    <div className="text-muted-foreground">...and {selectedDraftEntries.length - 3} more</div>
                  ) : null}
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkApproveDialog(false)} disabled={bulkApproving}>
              Cancel
            </Button>
            <Button onClick={approveSelectedEntries} disabled={bulkApproving || selectedEntryIds.length === 0}>
              {bulkApproving ? "Approving..." : "Confirm approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(singleApproveEntry)} onOpenChange={(open) => !open && setSingleApproveEntry(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Approve journal entry?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <div>
              <span className="font-medium">Memo:</span> {singleApproveEntry?.memo || "(no memo)"}
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-md border p-2 text-xs">
              <div>
                Debits:{" "}
                {formatCurrency(
                  (singleApproveEntry?.lines || []).reduce((sum, line) => sum + Number(line.debit || 0), 0),
                )}
              </div>
              <div>
                Credits:{" "}
                {formatCurrency(
                  (singleApproveEntry?.lines || []).reduce((sum, line) => sum + Number(line.credit || 0), 0),
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSingleApproveEntry(null)} disabled={bulkApproving}>
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => approveSingleEntry(true)}
              disabled={bulkApproving || !singleApproveEntry || !nextDraftFromSingleApprove}
            >
              {bulkApproving ? "Approving..." : "Approve + next draft"}
            </Button>
            <Button
              onClick={() => approveSingleEntry(false)}
              disabled={bulkApproving || !singleApproveEntry}
            >
              {bulkApproving ? "Approving..." : "Confirm approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={showShortcutHelp} onOpenChange={setShowShortcutHelp}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Journal keyboard shortcuts</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <div><span className="font-medium">J / K</span>: move active row down/up</div>
            <div><span className="font-medium">Shift+J / Shift+K</span>: next/previous page</div>
            <div><span className="font-medium">Home / End</span>: first/last row on current page</div>
            <div><span className="font-medium">G / Shift+G</span>: first/last row fallback</div>
            <div><span className="font-medium">Enter</span>: expand/collapse active entry lines</div>
            <div><span className="font-medium">A</span>: approve active draft (authorized roles)</div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowShortcutHelp(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
