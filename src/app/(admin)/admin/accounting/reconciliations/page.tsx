"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useDebounce } from "use-debounce";
import { useClientQuery } from "@/hooks/use-client-query";
import {
  buildReconciliationListQuery,
  clampPageSize,
  DEFAULT_RECON_PAGE_SIZE,
  isDuplicateReconciliation,
  parsePositiveInt,
  parseReconciliationSort,
  parseReconciliationStatusFilter,
  pickSelectedReconciliationId,
  type ReconciliationSortOption,
  type ReconciliationStatusFilter,
} from "@/lib/accounting-reconciliations";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency, formatDateGH } from "@/lib/currency";
import { toast } from "sonner";

type BankAccount = {
  id: string;
  name: string;
  currency: string;
};

type Reconciliation = {
  id: string;
  bankAccountId: string;
  periodStart: string;
  periodEnd: string;
  statementBalance: number | string;
  status: "DRAFT" | "IN_PROGRESS" | "CLOSED" | string;
  createdAt: string;
  updatedAt: string;
  assignedTo?: { id: string; name: string | null; email: string | null } | null;
  matchStats?: {
    totalBankTxns: number;
    matchedBankTxns: number;
    unmatchedBankTxns: number;
    matchedPercent: number;
  };
  bankAccount?: BankAccount;
  lines?: unknown[];
};

type ReconciliationListResponse = {
  items: Reconciliation[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  nextCursor?: string | null;
  pageMode?: "offset" | "cursor";
  summary: {
    total: number;
    draft: number;
    inProgress: number;
    closed: number;
    totalBalance: number;
    sla?: {
      openOver7: number;
      openOver14: number;
      oldestOpenDays: number;
    };
  };
  queryMs?: number;
};

type Assignee = {
  id: string;
  name: string | null;
  email: string | null;
  role: "ADMIN" | "ACCOUNTANT" | string;
};

const MS_PER_DAY = 86_400_000;
const SAVED_VIEWS_KEY = "accounting.reconciliations.savedViews.v1";
const COLUMN_PREF_KEY = "accounting.reconciliations.columns.v1";

type SavedView = {
  id: string;
  name: string;
  query: string;
  createdAt: string;
};

type ColumnKey = "status" | "progress" | "age" | "lastActivity" | "balance" | "assignee";
const DEFAULT_COLUMNS: Record<ColumnKey, boolean> = {
  status: true,
  progress: true,
  age: true,
  lastActivity: true,
  balance: true,
  assignee: true,
};

function statusVariant(status: string): "outline" | "warning" | "secondary" | "success" {
  if (status === "CLOSED") return "success";
  if (status === "IN_PROGRESS") return "warning";
  if (status === "DRAFT") return "secondary";
  return "outline";
}

function getOpenAgeDays(rec: Reconciliation) {
  if (rec.status === "CLOSED") return null;
  const createdAt = new Date(rec.createdAt).getTime();
  if (!Number.isFinite(createdAt)) return null;
  const days = Math.ceil((Date.now() - createdAt) / MS_PER_DAY);
  return Math.max(0, days);
}

export default function ReconciliationsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const [historyBankId, setHistoryBankId] = useState(() => searchParams.get("historyBankId") || "");
  const [assignedToId, setAssignedToId] = useState(() => searchParams.get("assignedToId") || "");
  const [statusFilter, setStatusFilter] = useState<ReconciliationStatusFilter>(() =>
    parseReconciliationStatusFilter(searchParams.get("status")),
  );
  const [searchText, setSearchText] = useState(() => searchParams.get("q") || "");
  const [debouncedSearchText] = useDebounce(searchText, 350);
  const [sort, setSort] = useState<ReconciliationSortOption>(() =>
    parseReconciliationSort(searchParams.get("sort")),
  );
  const [periodStartFrom, setPeriodStartFrom] = useState(() => searchParams.get("periodStartFrom") || "");
  const [periodEndTo, setPeriodEndTo] = useState(() => searchParams.get("periodEndTo") || "");
  const [minOpenAgeDays, setMinOpenAgeDays] = useState(() => parsePositiveInt(searchParams.get("minOpenAgeDays"), 0));
  const [page, setPage] = useState(() => parsePositiveInt(searchParams.get("page"), 1));
  const [pageSize, setPageSize] = useState(() =>
    clampPageSize(parsePositiveInt(searchParams.get("pageSize"), DEFAULT_RECON_PAGE_SIZE)),
  );
  const [pageMode, setPageMode] = useState<"offset" | "cursor">(() =>
    searchParams.get("pageMode") === "cursor" ? "cursor" : "offset",
  );
  const [cursor, setCursor] = useState(() => searchParams.get("cursor") || "");
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(() => searchParams.get("autoRefresh") === "1");

  const [bankAccountId, setBankAccountId] = useState(() => searchParams.get("bankAccountId") || "");
  const [periodStart, setPeriodStart] = useState(() => searchParams.get("periodStart") || "");
  const [periodEnd, setPeriodEnd] = useState(() => searchParams.get("periodEnd") || "");
  const [statementBalance, setStatementBalance] = useState(() => searchParams.get("statementBalance") || "");
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState(() => searchParams.get("recId") || "");
  const [lastManualRefreshAt, setLastManualRefreshAt] = useState<Date | null>(null);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewName, setSavedViewName] = useState("");
  const [visibleColumns, setVisibleColumns] = useState<Record<ColumnKey, boolean>>(DEFAULT_COLUMNS);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [virtualScrollTop, setVirtualScrollTop] = useState(0);
  const [bulkCloseDialogOpen, setBulkCloseDialogOpen] = useState(false);
  const [bulkCloseChecklistA, setBulkCloseChecklistA] = useState(false);
  const [bulkCloseChecklistB, setBulkCloseChecklistB] = useState(false);
  const [bulkCloseDryRunLoading, setBulkCloseDryRunLoading] = useState(false);
  const [bulkCloseDryRun, setBulkCloseDryRun] = useState<{ withIssues: number; unmatchedBank: number; unmatchedJournal: number }>({
    withIssues: 0,
    unmatchedBank: 0,
    unmatchedJournal: 0,
  });
  const [bulkClosing, setBulkClosing] = useState(false);
  const initializedFromPrefsRef = useRef(false);

  const listParams = useMemo(
    () =>
      buildReconciliationListQuery({
        bankAccountId: historyBankId || undefined,
        assignedToId: assignedToId || undefined,
        status: statusFilter,
        q: debouncedSearchText.trim() || undefined,
        periodStartFrom: periodStartFrom || undefined,
        periodEndTo: periodEndTo || undefined,
        minOpenAgeDays: minOpenAgeDays > 0 ? minOpenAgeDays : undefined,
        sort,
        pageMode,
        cursor: pageMode === "cursor" ? cursor || undefined : undefined,
        page,
        pageSize,
      }),
    [historyBankId, assignedToId, statusFilter, debouncedSearchText, periodStartFrom, periodEndTo, minOpenAgeDays, sort, pageMode, cursor, page, pageSize],
  );

  const {
    data: banksData,
    isLoading: banksLoading,
    isError: banksIsError,
    error: banksError,
    refetch: refetchBanks,
  } = useClientQuery<BankAccount[]>({
    queryKey: ["accounting", "banks"],
    queryFn: async () => {
      const res = await fetch("/api/admin/accounting/banks", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load bank accounts.");
      return res.json();
    },
  });

  const { data: assigneesData } = useClientQuery<Assignee[]>({
    queryKey: ["accounting", "reconciliations", "assignees"],
    queryFn: async () => {
      const res = await fetch("/api/admin/accounting/reconciliations/assignees", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load assignees.");
      return res.json();
    },
  });

  const { data: savedViewsPref } = useClientQuery<{ key: string; value: unknown }>({
    queryKey: ["admin-preferences", "accounting.reconciliations.savedViews"],
    queryFn: async () =>
      fetch("/api/admin/preferences?key=accounting.reconciliations.savedViews", { cache: "no-store" }).then((r) => r.json()),
  });

  const { data: columnsPref } = useClientQuery<{ key: string; value: unknown }>({
    queryKey: ["admin-preferences", "accounting.reconciliations.columns"],
    queryFn: async () =>
      fetch("/api/admin/preferences?key=accounting.reconciliations.columns", { cache: "no-store" }).then((r) => r.json()),
  });

  const {
    data: reconciliationsData,
    isLoading: listLoading,
    isError: listIsError,
    error: listError,
    refetch: refetchList,
    dataUpdatedAt: listUpdatedAt,
  } = useClientQuery<ReconciliationListResponse>({
    queryKey: ["accounting", "reconciliations", listParams],
    queryFn: async () => {
      const res = await fetch(`/api/admin/accounting/reconciliations?${listParams}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load reconciliations.");
      return res.json();
    },
  });

  const banks = Array.isArray(banksData) ? banksData : [];
  const assignees = Array.isArray(assigneesData) ? assigneesData : [];
  const items = Array.isArray(reconciliationsData?.items) ? reconciliationsData.items : [];
  const summary = reconciliationsData?.summary || {
    total: 0,
    draft: 0,
    inProgress: 0,
    closed: 0,
    totalBalance: 0,
  };
  const total = Number(reconciliationsData?.total || 0);
  const totalPages = Number(reconciliationsData?.totalPages || 1);
  const nextCursor = reconciliationsData?.nextCursor || "";

  const selectedReconciliation = items.find((rec) => rec.id === selectedId);

  const {
    data: reconciliationDetail,
    isLoading: detailLoading,
    isError: detailIsError,
    error: detailError,
    refetch: refetchDetail,
  } = useClientQuery<Reconciliation & { lines?: unknown[] }>({
    queryKey: ["accounting", "reconciliations", selectedId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/accounting/reconciliations/${selectedId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load selected reconciliation.");
      return res.json();
    },
    enabled: Boolean(selectedId),
  });

  useEffect(() => {
    setSelectedId((current) => pickSelectedReconciliationId(current, items));
  }, [items]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const resetPaginationState = () => {
    setPage(1);
    setCursor("");
    setCursorHistory([]);
  };

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void refetchList();
      if (selectedId) void refetchDetail();
      setLastManualRefreshAt(new Date());
    }, 60_000);
    return () => clearInterval(id);
  }, [autoRefresh, refetchList, refetchDetail, selectedId]);

  useEffect(() => {
    if (initializedFromPrefsRef.current) return;
    const serverViews = savedViewsPref?.value;
    const serverCols = columnsPref?.value;
    let hydrated = false;
    if (Array.isArray(serverViews)) {
      setSavedViews(
        serverViews
          .filter((v) => v && typeof v === "object")
          .map((v) => v as SavedView)
          .filter((v) => v?.id && v?.name && v?.query),
      );
      hydrated = true;
    }
    if (serverCols && typeof serverCols === "object") {
      setVisibleColumns({
        ...DEFAULT_COLUMNS,
        ...(serverCols as Partial<Record<ColumnKey, boolean>>),
      });
      hydrated = true;
    }
    if (!hydrated) {
      try {
        const rawViews = localStorage.getItem(SAVED_VIEWS_KEY);
        if (rawViews) {
          const parsed = JSON.parse(rawViews) as SavedView[];
          if (Array.isArray(parsed)) {
            setSavedViews(parsed.filter((v) => v?.id && v?.name && v?.query));
          }
        }
      } catch {
        // Ignore invalid local storage payload.
      }
      try {
        const rawColumns = localStorage.getItem(COLUMN_PREF_KEY);
        if (rawColumns) {
          const parsed = JSON.parse(rawColumns) as Partial<Record<ColumnKey, boolean>>;
          setVisibleColumns({
            ...DEFAULT_COLUMNS,
            ...parsed,
          });
        }
      } catch {
        // Ignore invalid local storage payload.
      }
    }
    initializedFromPrefsRef.current = true;
  }, [savedViewsPref?.value, columnsPref?.value]);

  useEffect(() => {
    if (!initializedFromPrefsRef.current) return;
    localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(savedViews));
    void fetch("/api/admin/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "accounting.reconciliations.savedViews", value: savedViews }),
    });
  }, [savedViews]);

  useEffect(() => {
    if (!initializedFromPrefsRef.current) return;
    localStorage.setItem(COLUMN_PREF_KEY, JSON.stringify(visibleColumns));
    void fetch("/api/admin/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "accounting.reconciliations.columns", value: visibleColumns }),
    });
  }, [visibleColumns]);

  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => items.some((item) => item.id === id)));
  }, [items]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase() || "";
      const isTypingTarget =
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        Boolean(target?.isContentEditable);
      if (isTypingTarget && event.key !== "Escape") return;

      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        setShortcutHelpOpen(true);
        return;
      }
      if (items.length === 0) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        const currentIndex = items.findIndex((item) => item.id === selectedId);
        const safeIndex = currentIndex >= 0 ? currentIndex : 0;
        const nextIndex =
          event.key === "j"
            ? Math.min(items.length - 1, safeIndex + 1)
            : Math.max(0, safeIndex - 1);
        setSelectedId(items[nextIndex].id);
        return;
      }
      if (event.key === "Enter" && selectedId) {
        event.preventDefault();
        void logWorkspaceOpen(selectedId);
        router.push(`/admin/accounting/reconciliations/${selectedId}`);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, selectedId, router]);

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (bankAccountId) params.set("bankAccountId", bankAccountId);
    else params.delete("bankAccountId");
    if (historyBankId) params.set("historyBankId", historyBankId);
    else params.delete("historyBankId");
    if (assignedToId) params.set("assignedToId", assignedToId);
    else params.delete("assignedToId");
    if (statusFilter !== "all") params.set("status", statusFilter);
    else params.delete("status");
    if (searchText.trim()) params.set("q", searchText.trim());
    else params.delete("q");
    if (sort !== "periodEnd_desc") params.set("sort", sort);
    else params.delete("sort");
    if (periodStartFrom) params.set("periodStartFrom", periodStartFrom);
    else params.delete("periodStartFrom");
    if (periodEndTo) params.set("periodEndTo", periodEndTo);
    else params.delete("periodEndTo");
    if (minOpenAgeDays > 0) params.set("minOpenAgeDays", String(minOpenAgeDays));
    else params.delete("minOpenAgeDays");
    if (periodStart) params.set("periodStart", periodStart);
    else params.delete("periodStart");
    if (periodEnd) params.set("periodEnd", periodEnd);
    else params.delete("periodEnd");
    if (statementBalance) params.set("statementBalance", statementBalance);
    else params.delete("statementBalance");
    if (selectedId) params.set("recId", selectedId);
    else params.delete("recId");
    if (pageMode === "cursor") params.set("pageMode", "cursor");
    else params.delete("pageMode");
    if (cursor) params.set("cursor", cursor);
    else params.delete("cursor");
    if (autoRefresh) params.set("autoRefresh", "1");
    else params.delete("autoRefresh");
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    const next = params.toString();
    const current = searchParams.toString();
    if (next !== current) {
      router.replace(next ? `?${next}` : "?", { scroll: false });
    }
  }, [
    bankAccountId,
    historyBankId,
    assignedToId,
    statusFilter,
    searchText,
    sort,
    periodStartFrom,
    periodEndTo,
    minOpenAgeDays,
    periodStart,
    periodEnd,
    statementBalance,
    selectedId,
    pageMode,
    cursor,
    autoRefresh,
    page,
    pageSize,
    router,
    searchParams,
  ]);

  const createReconciliation = async () => {
    if (!bankAccountId || !periodStart || !periodEnd) {
      toast.error("Select bank and period dates.");
      return;
    }
    if (new Date(periodStart) > new Date(periodEnd)) {
      toast.error("Period start cannot be after period end.");
      return;
    }

    const numericBalance = Number(statementBalance);
    if (!Number.isFinite(numericBalance)) {
      toast.error("Enter a statement balance.");
      return;
    }

    const duplicate = isDuplicateReconciliation(items, bankAccountId, periodStart, periodEnd);
    if (duplicate) {
      toast.error("A reconciliation already exists for this bank and period.");
      setSelectedId(duplicate.id);
      return;
    }

    try {
      setSaving(true);
      const res = await fetch("/api/admin/accounting/reconciliations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankAccountId,
          periodStart,
          periodEnd,
          statementBalance: numericBalance,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) throw new Error("A reconciliation already exists for this bank and period.");
        throw new Error(j?.error || "Failed to create reconciliation");
      }
      toast.success("Reconciliation created.");
      setSelectedId(String(j?.id || ""));
      setPeriodStart("");
      setPeriodEnd("");
      setStatementBalance("");
      queryClient.invalidateQueries({ queryKey: ["accounting", "reconciliations"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create reconciliation.");
    } finally {
      setSaving(false);
    }
  };

  const triggerExport = (rec: Reconciliation) => {
    void logAdminExportDownload({
      area: "accounting.reconciliations",
      format: "CSV",
      fileName: `reconciliation-${rec.id}.csv`,
      scopeSnapshot: JSON.stringify({
        reconciliationId: rec.id,
        bankAccountId: rec.bankAccountId,
        status: rec.status,
        periodStart: rec.periodStart,
        periodEnd: rec.periodEnd,
      }),
    });
    window.location.assign(`/api/admin/accounting/reconciliations/${rec.id}/export`);
  };

  const logWorkspaceOpen = async (reconciliationId: string) => {
    try {
      await fetch(`/api/admin/accounting/reconciliations/${reconciliationId}/open-log`, {
        method: "POST",
        keepalive: true,
      });
    } catch {
      // Best-effort only.
    }
  };

  const assignReconciliation = async (reconciliationId: string, nextAssignedToId: string) => {
    try {
      const res = await fetch(`/api/admin/accounting/reconciliations/${reconciliationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedToId: nextAssignedToId || null }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to assign reconciliation.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "reconciliations"] });
      queryClient.invalidateQueries({ queryKey: ["accounting", "reconciliations", reconciliationId] });
      toast.success(nextAssignedToId ? "Reconciliation assigned." : "Reconciliation unassigned.");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to update assignee.";
      toast.error(msg, {
        action: {
          label: "Retry",
          onClick: () => {
            void assignReconciliation(reconciliationId, nextAssignedToId);
          },
        },
      });
    }
  };

  const refreshNow = async () => {
    await refetchList();
    if (selectedId) await refetchDetail();
    setLastManualRefreshAt(new Date());
  };

  const applyPreset = (preset: "open_only" | "closing_month" | "needs_attention") => {
    const now = new Date();
    if (preset === "open_only") {
      setStatusFilter("IN_PROGRESS");
      setSort("createdAt_asc");
      setPeriodStartFrom("");
      setPeriodEndTo("");
      setMinOpenAgeDays(0);
      resetPaginationState();
      return;
    }
    if (preset === "closing_month") {
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, "0");
      const monthEnd = new Date(Date.UTC(y, now.getUTCMonth() + 1, 0));
      const endDay = String(monthEnd.getUTCDate()).padStart(2, "0");
      setPeriodStartFrom(`${y}-${m}-01`);
      setPeriodEndTo(`${y}-${m}-${endDay}`);
      setStatusFilter("all");
      setSort("periodEnd_desc");
      setMinOpenAgeDays(0);
      resetPaginationState();
      return;
    }
    setStatusFilter("IN_PROGRESS");
    setSort("createdAt_asc");
    setPeriodStartFrom("");
    setPeriodEndTo("");
    setMinOpenAgeDays(7);
    resetPaginationState();
  };

  const toggleSelectRow = (recId: string) => {
    setSelectedIds((prev) => (prev.includes(recId) ? prev.filter((id) => id !== recId) : [...prev, recId]));
  };

  const toggleSelectPage = () => {
    const pageIds = items.map((item) => item.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.includes(id));
    if (allSelected) {
      setSelectedIds((prev) => prev.filter((id) => !pageIds.includes(id)));
    } else {
      setSelectedIds((prev) => Array.from(new Set([...prev, ...pageIds])));
    }
  };

  const clearSelected = () => setSelectedIds([]);

  const exportSelectedSummaryCsv = () => {
    const selectedRows = items.filter((rec) => selectedIds.includes(rec.id));
    if (selectedRows.length === 0) {
      toast.error("Select at least one reconciliation.");
      return;
    }
    const header = [
      "Reconciliation ID",
      "Bank",
      "Period Start",
      "Period End",
      "Status",
      "Statement Balance",
      "Matched %",
      "Matched Count",
      "Unmatched Count",
      "Updated At",
    ];
    const rows = selectedRows.map((rec) => [
      rec.id,
      rec.bankAccount?.name || rec.bankAccountId,
      rec.periodStart.slice(0, 10),
      rec.periodEnd.slice(0, 10),
      rec.status,
      Number(rec.statementBalance || 0).toFixed(2),
      String(rec.matchStats?.matchedPercent ?? 0),
      String(rec.matchStats?.matchedBankTxns ?? 0),
      String(rec.matchStats?.unmatchedBankTxns ?? 0),
      rec.updatedAt,
    ]);
    const csv = [header, ...rows]
      .map((row) =>
        row
          .map((value) => {
            const text = String(value ?? "");
            return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
          })
          .join(","),
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reconciliations-summary-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "accounting.reconciliations.bulk.summary",
      format: "CSV",
      fileName: a.download,
      rowCount: selectedRows.length,
      columnCount: header.length,
      scopeSnapshot: JSON.stringify({ ids: selectedRows.map((row) => row.id) }),
    });
  };

  const exportSelectedDetailedCsv = () => {
    void (async () => {
      const selectedRows = items.filter((rec) => selectedIds.includes(rec.id));
      if (selectedRows.length === 0) {
        toast.error("Select at least one reconciliation.");
        return;
      }
      const ids = selectedRows.map((row) => row.id);
      const res = await fetch("/api/admin/accounting/reconciliations/export-zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        toast.error("Failed to build ZIP export.");
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const match = /filename=\"([^\"]+)\"/i.exec(disposition);
      const fileName = match?.[1] || `reconciliations-bulk-${new Date().toISOString().slice(0, 10)}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      void logAdminExportDownload({
        area: "accounting.reconciliations.bulk.zip",
        format: "CSV",
        fileName,
        rowCount: ids.length,
        scopeSnapshot: JSON.stringify({ ids }),
      });
      toast.success("ZIP export downloaded.");
    })();
  };

  const openSelectedWorkspaces = () => {
    const selectedRows = items.filter((rec) => selectedIds.includes(rec.id));
    if (selectedRows.length === 0) {
      toast.error("Select at least one reconciliation.");
      return;
    }
    selectedRows.forEach((rec) => {
      void logWorkspaceOpen(rec.id);
      window.open(`/admin/accounting/reconciliations/${rec.id}`, "_blank", "noopener,noreferrer");
    });
  };

  const prepareBulkClose = async () => {
    const selectedRows = items.filter((rec) => selectedIds.includes(rec.id));
    if (selectedRows.length === 0) {
      toast.error("Select at least one reconciliation.");
      return;
    }
    setBulkCloseDialogOpen(true);
    setBulkCloseChecklistA(false);
    setBulkCloseChecklistB(false);
    setBulkCloseDryRunLoading(true);
    try {
      let withIssues = 0;
      let unmatchedBank = 0;
      let unmatchedJournal = 0;
      await Promise.all(
        selectedRows.map(async (rec) => {
          const res = await fetch(`/api/admin/accounting/reconciliations/${rec.id}/checklist`, { cache: "no-store" });
          const j = await res.json().catch(() => ({}));
          const bank = Number(j?.unmatchedBankTxns || 0);
          const journal = Number(j?.unmatchedJournalLines || 0);
          unmatchedBank += bank;
          unmatchedJournal += journal;
          if (bank > 0 || journal > 0) withIssues += 1;
        }),
      );
      setBulkCloseDryRun({ withIssues, unmatchedBank, unmatchedJournal });
    } catch {
      setBulkCloseDryRun({ withIssues: 0, unmatchedBank: 0, unmatchedJournal: 0 });
    } finally {
      setBulkCloseDryRunLoading(false);
    }
  };

  const confirmBulkClose = async () => {
    const selectedRows = items.filter((rec) => selectedIds.includes(rec.id));
    if (selectedRows.length === 0) {
      toast.error("Select at least one reconciliation.");
      return;
    }
    if (!bulkCloseChecklistA || !bulkCloseChecklistB) {
      toast.error("Confirm both checklist items before closing.");
      return;
    }
    setBulkClosing(true);
    let closed = 0;
    let failed = 0;
    for (const rec of selectedRows) {
      try {
        const res = await fetch(`/api/admin/accounting/reconciliations/${rec.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
        });
        if (!res.ok) {
          failed += 1;
          continue;
        }
        closed += 1;
      } catch {
        failed += 1;
      }
    }
    if (closed > 0) toast.success(`Closed ${closed} reconciliation(s).`);
    if (failed > 0) toast.error(`${failed} reconciliation(s) failed to close.`);
    if (closed > 0) {
      await refreshNow();
      queryClient.invalidateQueries({ queryKey: ["accounting", "reconciliations"] });
    }
    setBulkClosing(false);
    setBulkCloseDialogOpen(false);
  };

  const saveCurrentView = () => {
    const name = savedViewName.trim();
    if (!name) {
      toast.error("Enter a view name first.");
      return;
    }
    const query = listParams;
    const view: SavedView = {
      id: `${Date.now()}`,
      name,
      query,
      createdAt: new Date().toISOString(),
    };
    setSavedViews((prev) => [view, ...prev].slice(0, 30));
    setSavedViewName("");
    toast.success("Saved view created.");
  };

  const applySavedView = (view: SavedView) => {
    const p = new URLSearchParams(view.query);
    setHistoryBankId(p.get("bankAccountId") || "");
    setAssignedToId(p.get("assignedToId") || "");
    setStatusFilter(parseReconciliationStatusFilter(p.get("status")));
    setSearchText(p.get("q") || "");
    setPeriodStartFrom(p.get("periodStartFrom") || "");
    setPeriodEndTo(p.get("periodEndTo") || "");
    setMinOpenAgeDays(parsePositiveInt(p.get("minOpenAgeDays"), 0));
    setSort(parseReconciliationSort(p.get("sort")));
    setPageMode(p.get("pageMode") === "cursor" ? "cursor" : "offset");
    setCursor(p.get("cursor") || "");
    setCursorHistory([]);
    setPage(parsePositiveInt(p.get("page"), 1));
    setPageSize(clampPageSize(parsePositiveInt(p.get("pageSize"), DEFAULT_RECON_PAGE_SIZE)));
  };

  const copySavedViewLink = async (view: SavedView) => {
    const base = `${window.location.origin}${window.location.pathname}`;
    const url = `${base}?${view.query}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("View link copied.");
    } catch {
      toast.error("Could not copy link.");
    }
  };

  const rowHeightPx = 134;
  const virtualEnabled = items.length > 40;
  const virtualViewportHeight = 540;
  const virtualOverscan = 4;
  const virtualStart = virtualEnabled
    ? Math.max(0, Math.floor(virtualScrollTop / rowHeightPx) - virtualOverscan)
    : 0;
  const virtualEnd = virtualEnabled
    ? Math.min(items.length, Math.ceil((virtualScrollTop + virtualViewportHeight) / rowHeightPx) + virtualOverscan)
    : items.length;
  const virtualItems = virtualEnabled ? items.slice(virtualStart, virtualEnd) : items;

  const renderHistoryRow = (rec: Reconciliation) => {
    const openAgeDays = getOpenAgeDays(rec);
    return (
      <div
        key={rec.id}
        className={`w-full rounded-md border px-3 py-2 ${selectedId === rec.id ? "border-primary bg-muted/40" : ""}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={selectedIds.includes(rec.id)}
              onChange={() => toggleSelectRow(rec.id)}
              aria-label={`Select row ${rec.id}`}
            />
            <button
              type="button"
              className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
              onClick={() => setSelectedId(rec.id)}
              aria-label={`Select reconciliation ${rec.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{rec.bankAccount?.name || rec.bankAccountId}</span>
                {visibleColumns.status ? <Badge variant={statusVariant(rec.status)}>{rec.status}</Badge> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {new Date(rec.periodStart).toLocaleDateString("en-GH", { timeZone: "Africa/Accra" })} to{" "}
                {new Date(rec.periodEnd).toLocaleDateString("en-GH", { timeZone: "Africa/Accra" })}
              </div>
              <div className="text-xs text-muted-foreground">
                {visibleColumns.assignee
                  ? `Assignee ${rec.assignedTo?.name || rec.assignedTo?.email || "Unassigned"} | `
                  : ""}
                {visibleColumns.balance ? `${formatCurrency(Number(rec.statementBalance || 0))} | ` : ""}
                {visibleColumns.lastActivity
                  ? `Last activity ${formatDateGH(rec.updatedAt)}${openAgeDays !== null && visibleColumns.age ? " | " : ""}`
                  : ""}
                {openAgeDays !== null && visibleColumns.age ? `Open age ${openAgeDays}d` : ""}
                {visibleColumns.progress
                  ? ` | Matched ${Number(rec.matchStats?.matchedPercent || 0)}% (${Number(
                      rec.matchStats?.matchedBankTxns || 0,
                    )}/${Number(rec.matchStats?.totalBankTxns || 0)})`
                  : ""}
              </div>
            </button>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={rec.assignedTo?.id || ""}
              onChange={(e) => {
                void assignReconciliation(rec.id, e.target.value);
              }}
              aria-label={`Assign reconciliation ${rec.id}`}
            >
              <option value="">Unassigned</option>
              {assignees.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name || person.email || person.id}
                </option>
              ))}
            </select>
            <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
              <Link
                href={`/admin/accounting/reconciliations/${rec.id}`}
                onClick={() => {
                  void logWorkspaceOpen(rec.id);
                }}
              >
                Open
              </Link>
            </Button>
            <Button size="sm" variant="ghost" className="w-full sm:w-auto" onClick={() => triggerExport(rec)}>
              Export CSV
            </Button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Bank Reconciliations</h1>
          <p className="text-sm text-muted-foreground">
            Create period reconciliations, monitor status, and jump into matching workspace quickly.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Last data refresh:{" "}
            {listUpdatedAt
              ? new Date(listUpdatedAt).toLocaleTimeString("en-GH", { timeZone: "Africa/Accra" })
              : "Not loaded"}
            {lastManualRefreshAt
              ? ` | Last manual/auto refresh ${lastManualRefreshAt.toLocaleTimeString("en-GH", {
                  timeZone: "Africa/Accra",
                })}`
              : ""}
            {reconciliationsData?.queryMs ? ` | Query ${reconciliationsData.queryMs}ms` : ""}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Keyboard shortcuts: press <kbd className="rounded border bg-muted px-1">/</kbd> to focus search,{" "}
            <kbd className="rounded border bg-muted px-1">j</kbd>/<kbd className="rounded border bg-muted px-1">k</kbd> to
            move selection, and <kbd className="rounded border bg-muted px-1">enter</kbd> to open the selected reconciliation.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/accounting/banks">Manage bank accounts</Link>
          </Button>
          <Button size="sm" variant="outline" onClick={() => void refreshNow()}>
            Refresh now
          </Button>
          <Button
            size="sm"
            variant={autoRefresh ? "default" : "outline"}
            onClick={() => setAutoRefresh((v) => !v)}
            aria-pressed={autoRefresh}
          >
            Auto-refresh {autoRefresh ? "ON" : "OFF"}
          </Button>
          {selectedReconciliation ? (
            <Button asChild size="sm">
              <Link
                href={`/admin/accounting/reconciliations/${selectedReconciliation.id}`}
                onClick={() => {
                  void logWorkspaceOpen(selectedReconciliation.id);
                }}
              >
                Open selected workspace
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {listLoading ? (
          Array.from({ length: 4 }).map((_, idx) => (
            <Card key={idx}>
              <CardHeader className="pb-2">
                <Skeleton className="h-5 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-20" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Total</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <p className="text-2xl font-semibold leading-none">{summary.total}</p>
                <p className="mt-1 text-muted-foreground">Reconciliations in filtered scope.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">In Progress</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <p className="text-2xl font-semibold leading-none">{summary.inProgress}</p>
                <p className="mt-1 text-muted-foreground">Still being matched.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Closed</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <p className="text-2xl font-semibold leading-none">{summary.closed}</p>
                <p className="mt-1 text-muted-foreground">Ready for close evidence.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Statement Total</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <p className="text-2xl font-semibold leading-none">{formatCurrency(Number(summary.totalBalance || 0))}</p>
                <p className="mt-1 text-muted-foreground">Across filtered bank/period scope.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Open &gt; 7 Days</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <p className="text-2xl font-semibold leading-none">{Number(summary.sla?.openOver7 || 0)}</p>
                <p className="mt-1 text-muted-foreground">Aging open reconciliations.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Open &gt; 14 Days</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <p className="text-2xl font-semibold leading-none">{Number(summary.sla?.openOver14 || 0)}</p>
                <p className="mt-1 text-muted-foreground">Escalation threshold.</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Oldest Open Age</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                <p className="text-2xl font-semibold leading-none">{Number(summary.sla?.oldestOpenDays || 0)}d</p>
                <p className="mt-1 text-muted-foreground">Longest unresolved item.</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <Card className={Number(summary.sla?.openOver14 || 0) > 0 ? "border-destructive/40 bg-destructive/5" : ""}>
        <CardHeader>
          <CardTitle>SLA Notifications</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {Number(summary.sla?.openOver14 || 0) > 0 ? (
            <p className="text-destructive">
              Alert: {Number(summary.sla?.openOver14 || 0)} reconciliation(s) are older than 14 days and still open.
            </p>
          ) : (
            <p className="text-muted-foreground">No current SLA breach for 14-day open reconciliations.</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => applyPreset("needs_attention")}>
              View needs attention
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setSort("createdAt_asc");
                setStatusFilter("IN_PROGRESS");
                setMinOpenAgeDays(14);
                resetPaginationState();
              }}
            >
              Show &gt;14d only
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create reconciliation</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="create-bank">Bank account</Label>
            <select
              id="create-bank"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={bankAccountId}
              onChange={(e) => setBankAccountId(e.target.value)}
              aria-label="Select bank account"
            >
              <option value="">Select bank</option>
              {banks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name} ({bank.currency})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="create-period-start">Period start</Label>
            <Input id="create-period-start" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="create-period-end">Period end</Label>
            <Input id="create-period-end" type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="create-statement-balance">Statement ending balance</Label>
            <Input
              id="create-statement-balance"
              placeholder="Statement balance (end-of-period)"
              inputMode="decimal"
              value={statementBalance}
              onChange={(e) => setStatementBalance(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Button className="w-full sm:w-auto" onClick={createReconciliation} disabled={saving || banksLoading}>
              {saving ? "Saving..." : "Create reconciliation"}
            </Button>
            {banksIsError ? (
              <p className="mt-2 text-xs text-destructive">
                {banksError instanceof Error ? banksError.message : "Failed to load banks."}{" "}
                <button className="underline" type="button" onClick={() => void refetchBanks()}>
                  Retry
                </button>
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="history-bank">Bank</Label>
            <select
              id="history-bank"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={historyBankId}
              onChange={(e) => {
                setHistoryBankId(e.target.value);
                resetPaginationState();
              }}
            >
              <option value="">All banks</option>
              {banks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name} ({bank.currency})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-assignee">Assignee</Label>
            <select
              id="history-assignee"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={assignedToId}
              onChange={(e) => {
                setAssignedToId(e.target.value);
                resetPaginationState();
              }}
            >
              <option value="">All assignees</option>
              <option value="unassigned">Unassigned</option>
              {assignees.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name || person.email || person.id}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-status">Status</Label>
            <select
              id="history-status"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as ReconciliationStatusFilter);
                resetPaginationState();
              }}
            >
              <option value="all">All statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="CLOSED">Closed</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-search">Search</Label>
            <Input
              ref={searchInputRef}
              id="history-search"
              placeholder="Search bank/status/id"
              value={searchText}
              onChange={(e) => {
                setSearchText(e.target.value);
                resetPaginationState();
              }}
            />
            <p className="text-[11px] text-muted-foreground">Debounced by 350ms to reduce query churn.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-sort">Sort</Label>
            <select
              id="history-sort"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as ReconciliationSortOption);
                resetPaginationState();
              }}
            >
              <option value="periodEnd_desc">Newest period first</option>
              <option value="periodEnd_asc">Oldest period first</option>
              <option value="createdAt_asc">Oldest open first</option>
              <option value="statementBalance_desc">Largest statement balance</option>
              <option value="updatedAt_desc">Recently updated</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-page-size">Rows per page</Label>
            <select
              id="history-page-size"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={String(pageSize)}
              onChange={(e) => {
                setPageSize(clampPageSize(parsePositiveInt(e.target.value, DEFAULT_RECON_PAGE_SIZE)));
                resetPaginationState();
              }}
            >
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-page-mode">Pagination mode</Label>
            <select
              id="history-page-mode"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={pageMode}
              onChange={(e) => {
                setPageMode(e.target.value === "cursor" ? "cursor" : "offset");
                resetPaginationState();
              }}
            >
              <option value="offset">Offset (page numbers)</option>
              <option value="cursor">Cursor (large lists)</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-period-from">Period start from</Label>
            <Input
              id="history-period-from"
              type="date"
              value={periodStartFrom}
              onChange={(e) => {
                setPeriodStartFrom(e.target.value);
                resetPaginationState();
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-period-to">Period end to</Label>
            <Input
              id="history-period-to"
              type="date"
              value={periodEndTo}
              onChange={(e) => {
                setPeriodEndTo(e.target.value);
                resetPaginationState();
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="history-open-age">Min open age (days)</Label>
            <Input
              id="history-open-age"
              type="number"
              min={0}
              step={1}
              value={String(minOpenAgeDays || 0)}
              onChange={(e) => {
                setMinOpenAgeDays(Math.max(0, parsePositiveInt(e.target.value, 0)));
                resetPaginationState();
              }}
            />
          </div>
          <div className="flex items-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setHistoryBankId("");
                setAssignedToId("");
                setStatusFilter("all");
                setSearchText("");
                setPeriodStartFrom("");
                setPeriodEndTo("");
                setMinOpenAgeDays(0);
                resetPaginationState();
                setPageSize(DEFAULT_RECON_PAGE_SIZE);
                setSort("periodEnd_desc");
                setPageMode("offset");
              }}
            >
            Clear filters
          </Button>
          </div>
          <div className="flex items-end">
            <Button type="button" variant="outline" onClick={() => void refreshNow()}>
              Refresh list
            </Button>
          </div>
          <div className="space-y-1 sm:col-span-2 lg:col-span-4">
            <Label>Quick presets</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => applyPreset("open_only")}>
                Open only
              </Button>
              <Button size="sm" variant="outline" onClick={() => applyPreset("closing_month")}>
                Closing this month
              </Button>
              <Button size="sm" variant="outline" onClick={() => applyPreset("needs_attention")}>
                Needs attention (&gt;7d open)
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Saved Views & Columns</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[220px] flex-1 space-y-1">
              <Label htmlFor="saved-view-name">Save current filter view</Label>
              <Input
                id="saved-view-name"
                placeholder="e.g. Month-end open recons"
                value={savedViewName}
                onChange={(e) => setSavedViewName(e.target.value)}
              />
            </div>
            <Button type="button" size="sm" onClick={saveCurrentView}>
              Save view
            </Button>
          </div>
          {savedViews.length > 0 ? (
            <div className="space-y-2">
              {savedViews.map((view) => (
                <div key={view.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <div>
                    <p className="font-medium">{view.name}</p>
                    <p className="text-xs text-muted-foreground">Saved {formatDateGH(view.createdAt)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => applySavedView(view)}>
                      Apply
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void copySavedViewLink(view)}>
                      Share link
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSavedViews((prev) => prev.filter((v) => v.id !== view.id))}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">No saved views yet.</p>
          )}

          <div className="space-y-1">
            <Label>Visible row columns</Label>
            <div className="flex flex-wrap items-center gap-3">
              {(Object.keys(DEFAULT_COLUMNS) as ColumnKey[]).map((col) => (
                <label key={col} className="inline-flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={Boolean(visibleColumns[col])}
                    onChange={(e) =>
                      setVisibleColumns((prev) => ({
                        ...prev,
                        [col]: e.target.checked,
                      }))
                    }
                  />
                  <span>{col}</span>
                </label>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Export is available from each reconciliation or in the matching workspace. Oldest open reconciliations should be worked first.
          </p>

          {listLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, idx) => (
                <Skeleton key={idx} className="h-20 w-full" />
              ))}
            </div>
          ) : listIsError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <p>{listError instanceof Error ? listError.message : "Failed to load reconciliation history."}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void refetchList()}>
                Retry
              </Button>
            </div>
          ) : items.length === 0 ? (
            <p className="text-muted-foreground">No reconciliations yet.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
                <label className="inline-flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={items.length > 0 && items.every((item) => selectedIds.includes(item.id))}
                    onChange={toggleSelectPage}
                  />
                  <span>Select page</span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">{selectedIds.length} selected</span>
                  <Button size="sm" variant="outline" onClick={openSelectedWorkspaces}>
                    Open selected
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void prepareBulkClose()}>
                    Close selected
                  </Button>
                  <Button size="sm" variant="outline" onClick={exportSelectedSummaryCsv}>
                    Export summary CSV
                  </Button>
                  <Button size="sm" variant="outline" onClick={exportSelectedDetailedCsv}>
                    Export detailed CSVs
                  </Button>
                  <Button size="sm" variant="ghost" onClick={clearSelected}>
                    Clear
                  </Button>
                </div>
              </div>

              {virtualEnabled ? (
                <div
                  className="overflow-auto rounded-md border"
                  style={{ maxHeight: virtualViewportHeight }}
                  onScroll={(e) => setVirtualScrollTop(e.currentTarget.scrollTop)}
                >
                  <div style={{ height: items.length * rowHeightPx, position: "relative" }}>
                    {virtualItems.map((rec, idx) => (
                      <div
                        key={rec.id}
                        style={{
                          position: "absolute",
                          top: (virtualStart + idx) * rowHeightPx,
                          left: 0,
                          right: 0,
                          padding: "4px",
                        }}
                      >
                        {renderHistoryRow(rec)}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                items.map((rec) => renderHistoryRow(rec))
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                <p className="text-xs text-muted-foreground">
                  {pageMode === "cursor"
                    ? `${items.length} rows loaded (cursor mode)`
                    : `Page ${page} of ${totalPages} (${total} total)`}
                </p>
                <div className="flex items-center gap-2">
                  {pageMode === "cursor" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setCursorHistory((prev) => {
                          const next = [...prev];
                          const previousCursor = next.pop() || "";
                          setCursor(previousCursor);
                          return next;
                        })
                      }
                      disabled={cursorHistory.length === 0}
                    >
                      Previous
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                      Previous
                    </Button>
                  )}
                  {pageMode === "cursor" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (!nextCursor) return;
                        setCursorHistory((prev) => [...prev, cursor]);
                        setCursor(nextCursor);
                      }}
                      disabled={!nextCursor}
                    >
                      Next
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                    >
                      Next
                    </Button>
                  )}
                  
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {selectedId ? (
        <Card>
          <CardHeader>
            <CardTitle>Selected reconciliation</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            {detailLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : detailIsError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive">
                <p>{detailError instanceof Error ? detailError.message : "Failed to load selected reconciliation."}</p>
                <Button size="sm" variant="outline" className="mt-2" onClick={() => void refetchDetail()}>
                  Retry
                </Button>
              </div>
            ) : reconciliationDetail ? (
              <>
                <p className="font-medium">{reconciliationDetail.bankAccount?.name || reconciliationDetail.bankAccountId}</p>
                <p className="text-muted-foreground">
                  {new Date(reconciliationDetail.periodStart).toLocaleDateString("en-GH", { timeZone: "Africa/Accra" })} to{" "}
                  {new Date(reconciliationDetail.periodEnd).toLocaleDateString("en-GH", { timeZone: "Africa/Accra" })} |{" "}
                  {formatCurrency(Number(reconciliationDetail.statementBalance || 0))} | {reconciliationDetail.status}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link
                      href={`/admin/accounting/reconciliations/${reconciliationDetail.id}`}
                      onClick={() => {
                        void logWorkspaceOpen(reconciliationDetail.id);
                      }}
                    >
                      Open matching workspace
                    </Link>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => triggerExport(reconciliationDetail)}>
                    Export CSV
                  </Button>
                </div>
                {reconciliationDetail?.lines && Array.isArray(reconciliationDetail.lines) ? (
                  <p className="text-xs text-muted-foreground">Matched lines so far: {reconciliationDetail.lines.length}</p>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">Select a reconciliation to review details.</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={shortcutHelpOpen} onOpenChange={setShortcutHelpOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keyboard Shortcuts</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p><kbd className="rounded border bg-muted px-1">/</kbd> Focus search input</p>
            <p><kbd className="rounded border bg-muted px-1">j</kbd>/<kbd className="rounded border bg-muted px-1">k</kbd> Move selected row</p>
            <p><kbd className="rounded border bg-muted px-1">enter</kbd> Open selected reconciliation workspace</p>
            <p><kbd className="rounded border bg-muted px-1">?</kbd> Open this help panel</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShortcutHelpOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkCloseDialogOpen} onOpenChange={setBulkCloseDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Bulk Close</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>Selected reconciliations: {selectedIds.length}</p>
            {bulkCloseDryRunLoading ? (
              <p className="text-muted-foreground">Running dry-run checklist...</p>
            ) : (
              <div className="rounded-md border p-2 text-xs text-muted-foreground">
                <p>Reconciliations with unmatched items: {bulkCloseDryRun.withIssues}</p>
                <p>Total unmatched bank transactions: {bulkCloseDryRun.unmatchedBank}</p>
                <p>Total unmatched journal lines: {bulkCloseDryRun.unmatchedJournal}</p>
              </div>
            )}
            <label className="inline-flex items-start gap-2">
              <input type="checkbox" checked={bulkCloseChecklistA} onChange={(e) => setBulkCloseChecklistA(e.target.checked)} />
              <span>I reviewed unmatched items using dry-run and accept the close risk.</span>
            </label>
            <label className="inline-flex items-start gap-2">
              <input type="checkbox" checked={bulkCloseChecklistB} onChange={(e) => setBulkCloseChecklistB(e.target.checked)} />
              <span>I understand this action force-closes selected reconciliations.</span>
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setBulkCloseDialogOpen(false)} disabled={bulkClosing}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void confirmBulkClose()} disabled={bulkClosing || !bulkCloseChecklistA || !bulkCloseChecklistB}>
              {bulkClosing ? "Closing..." : "Confirm close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>Operational notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm text-muted-foreground">
          <p>- Create one reconciliation per bank-period pair (DB-enforced unique key).</p>
          <p>- Date filters and create-period inputs use Accra calendar days normalized to UTC boundaries.</p>
          <p>- Use status + age indicators to prioritize oldest open reconciliations first.</p>
          <p>- Export actions are audit-logged for accounting control traceability.</p>
        </CardContent>
      </Card>
    </section>
  );
}
