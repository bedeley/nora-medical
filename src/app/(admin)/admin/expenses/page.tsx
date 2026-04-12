"use client";

export const dynamic = "force-dynamic";

import {
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import AddExpenseDialog from "@/app/(admin)/dashboard/components/AddExpenseDialog";
import { chipToneClass } from "@/lib/status-chips";
import { formatCurrency } from "@/lib/currency";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import { toast } from "sonner";

const DEFAULT_PAGE_SIZE = 50;
const COL_PREFS_KEY = "expenses-col-prefs";
const SAVED_FILTERS_KEY = "expenses-saved-filters-v1";

type ExpensePaymentMode = "cash" | "bank" | "momo";
type ExpensePaymentModeSelection = ExpensePaymentMode | "";
type SettlementStateFilter = "" | "UNPAID" | "PARTIALLY_PAID" | "PAID";
type ExpenseSortBy = "createdAt" | "category" | "vendor" | "amount" | "settlementStatus";
type ExpenseSortDir = "asc" | "desc";

type ExpenseFilterState = {
  start: string;
  end: string;
  category: string;
  vendor: string;
  q: string;
  sourceId: string;
  settlementState: SettlementStateFilter;
};

type ExpenseRow = {
  id: string;
  category: string;
  amount: number | string;
  vendor?: string | null;
  reason?: string | null;
  note: string | null;
  isReversal?: boolean | null;
  reversalOfId?: string | null;
  reversalRemaining?: number | null;
  reversedSoFar?: number | null;
  reversalCount?: number | null;
  settlementCount?: number | null;
  settlementPaid?: number | null;
  settlementOutstanding?: number | null;
  settlementStatus?: "UNPAID" | "PARTIALLY_PAID" | "PAID" | null;
  settlementLastPaidAt?: string | null;
  payrollRunId?: string | null;
  createdAt: string | Date;
  mutationLocked?: boolean | null;
  canEdit?: boolean | null;
  canDelete?: boolean | null;
  canReverse?: boolean | null;
  canSettle?: boolean | null;
  lockCode?: string | null;
  lockReason?: string | null;
};

type ExpenseSummary = {
  grossAmount: number;
  reversalAmount: number;
  netAmount: number;
  outstandingLiability: number;
  unpaidCount: number;
  topCategories: Array<{ category: string; count: number }>;
};

type ExpenseListResponse = {
  items?: ExpenseRow[];
  totalAmount?: number;
  totalCount?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  sortBy?: ExpenseSortBy;
  sortDir?: ExpenseSortDir;
  summary?: ExpenseSummary;
};

type ExpenseDetailAudit = {
  id: string;
  action: string;
  outcome?: string | null;
  createdAt: string;
  actor?: { id?: string | null; name?: string | null; email?: string | null } | null;
  meta?: Record<string, unknown> | null;
};

type ExpenseDetailJournal = {
  id: string;
  sourceId: string | null;
  memo: string | null;
  entryDate: string;
  createdAt: string;
  status: string;
  lines: Array<{
    debit: number;
    credit: number;
    description: string | null;
    account: { code: string; name: string };
  }>;
};

type ExpenseDetailResponse = {
  expense: ExpenseRow;
  original?: (ExpenseRow & { deletedAt?: string | null }) | null;
  reversals?: ExpenseRow[];
  journals?: ExpenseDetailJournal[];
  audits?: ExpenseDetailAudit[];
  metrics?: {
    originalAmount: number;
    settlementPaid: number;
    settlementOutstanding: number;
    reversedAmount: number;
    remainingAfterReversals: number;
  };
};

type SavedExpenseView = {
  id: string;
  name: string;
  filters: ExpenseFilterState;
  sortBy: ExpenseSortBy;
  sortDir: ExpenseSortDir;
  pageSize: number;
};

function defaultFilters(): ExpenseFilterState {
  return {
    start: "",
    end: "",
    category: "",
    vendor: "",
    q: "",
    sourceId: "",
    settlementState: "",
  };
}

function formatDate(input: string | Date): string {
  const value = new Date(input);
  if (Number.isNaN(value.getTime())) return "";
  const d = String(value.getDate()).padStart(2, "0");
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const y = value.getFullYear();
  const hh = String(value.getHours()).padStart(2, "0");
  const mm = String(value.getMinutes()).padStart(2, "0");
  return `${d}/${m}/${y} ${hh}:${mm}`;
}

function parsePositiveInt(value: string | null, fallback: number, max = 200) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normalizeSortBy(value: string | null): ExpenseSortBy {
  return value === "category" ||
    value === "vendor" ||
    value === "amount" ||
    value === "settlementStatus"
    ? value
    : "createdAt";
}

function normalizeSortDir(value: string | null): ExpenseSortDir {
  return value === "asc" ? "asc" : "desc";
}

function AdminExpensesContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);
  const syncingFromUrl = useRef(false);
  const fetchSeqRef = useRef(0);

  const [filters, setFilters] = useState<ExpenseFilterState>(defaultFilters());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [sort, setSort] = useState<{ col: ExpenseSortBy; dir: ExpenseSortDir }>({
    col: "createdAt",
    dir: "desc",
  });

  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [dateRangeError, setDateRangeError] = useState("");
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [totalAmount, setTotalAmount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [summary, setSummary] = useState<ExpenseSummary>({
    grossAmount: 0,
    reversalAmount: 0,
    netAmount: 0,
    outstandingLiability: 0,
    unpaidCount: 0,
    topCategories: [],
  });
  const [expenseCategories, setExpenseCategories] = useState<Array<{ value: string; label: string }>>([]);
  const [loadingCategories, setLoadingCategories] = useState(false);

  const [showCategoryCol, setShowCategoryCol] = useState(true);
  const [showVendorCol, setShowVendorCol] = useState(true);
  const [showReasonCol, setShowReasonCol] = useState(true);
  const [showNoteCol, setShowNoteCol] = useState(true);
  const [colPrefsLoaded, setColPrefsLoaded] = useState(false);

  const [savedViews, setSavedViews] = useState<SavedExpenseView[]>([]);
  const [savedViewsLoaded, setSavedViewsLoaded] = useState(false);
  const [savedViewId, setSavedViewId] = useState("");

  const [settleOpen, setSettleOpen] = useState(false);
  const [settleTarget, setSettleTarget] = useState<ExpenseRow | null>(null);
  const [settleMode, setSettleMode] = useState<ExpensePaymentModeSelection>("");
  const [settleModeError, setSettleModeError] = useState("");
  const [settleAmount, setSettleAmount] = useState("");
  const [settleAmountError, setSettleAmountError] = useState("");
  const [settling, setSettling] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ExpenseRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTarget, setDetailTarget] = useState<ExpenseRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailData, setDetailData] = useState<ExpenseDetailResponse | null>(null);

  const deferredQuery = useDeferredValue(filters.q);
  const deferredVendor = useDeferredValue(filters.vendor);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(COL_PREFS_KEY);
      if (saved) {
        const prefs = JSON.parse(saved) as Record<string, boolean>;
        if (typeof prefs.showCategory === "boolean") setShowCategoryCol(prefs.showCategory);
        if (typeof prefs.showVendor === "boolean") setShowVendorCol(prefs.showVendor);
        if (typeof prefs.showReason === "boolean") setShowReasonCol(prefs.showReason);
        if (typeof prefs.showNote === "boolean") setShowNoteCol(prefs.showNote);
      }
    } catch {
      // ignore
    }
    setColPrefsLoaded(true);
  }, []);

  useEffect(() => {
    if (!colPrefsLoaded) return;
    try {
      localStorage.setItem(
        COL_PREFS_KEY,
        JSON.stringify({
          showCategory: showCategoryCol,
          showVendor: showVendorCol,
          showReason: showReasonCol,
          showNote: showNoteCol,
        }),
      );
    } catch {
      // ignore
    }
  }, [colPrefsLoaded, showCategoryCol, showVendorCol, showReasonCol, showNoteCol]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SAVED_FILTERS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as SavedExpenseView[];
        if (Array.isArray(parsed)) setSavedViews(parsed);
      }
    } catch {
      // ignore
    }
    setSavedViewsLoaded(true);
  }, []);

  useEffect(() => {
    if (!savedViewsLoaded) return;
    try {
      localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(savedViews));
    } catch {
      // ignore
    }
  }, [savedViews, savedViewsLoaded]);

  useEffect(() => {
    const sp = new URLSearchParams(searchParams.toString());
    const rawQ = sp.get("q") || "";
    const rawSourceId = sp.get("sourceId") || "";
    const promotedSourceId =
      rawSourceId ||
      (/^[a-z0-9]{20,}$/i.test(rawQ) && !rawQ.includes(" ") ? rawQ : "");
    const nextFilters: ExpenseFilterState = {
      start: sp.get("start") || "",
      end: sp.get("end") || "",
      category: sp.get("category") || "",
      vendor: sp.get("vendor") || "",
      q: rawQ,
      sourceId: promotedSourceId,
      settlementState:
        sp.get("settlementState") === "UNPAID" ||
        sp.get("settlementState") === "PARTIALLY_PAID" ||
        sp.get("settlementState") === "PAID"
          ? (sp.get("settlementState") as SettlementStateFilter)
          : "",
    };
    const nextPage = parsePositiveInt(sp.get("page"), 1, 1_000_000);
    const nextPageSize = parsePositiveInt(sp.get("pageSize"), DEFAULT_PAGE_SIZE, 200);
    const nextSort = {
      col: normalizeSortBy(sp.get("sortBy")),
      dir: normalizeSortDir(sp.get("sortDir")),
    };

    syncingFromUrl.current = true;
    setFilters((prev) =>
      JSON.stringify(prev) === JSON.stringify(nextFilters) ? prev : nextFilters
    );
    setPage((prev) => (prev === nextPage ? prev : nextPage));
    setPageSize((prev) => (prev === nextPageSize ? prev : nextPageSize));
    setSort((prev) =>
      prev.col === nextSort.col && prev.dir === nextSort.dir ? prev : nextSort
    );
    initialized.current = true;
  }, [searchParams]);

  useEffect(() => {
    if (!initialized.current) return;
    if (syncingFromUrl.current) {
      syncingFromUrl.current = false;
      return;
    }
    const params = new URLSearchParams();
    if (filters.start) params.set("start", filters.start);
    if (filters.end) params.set("end", filters.end);
    if (filters.category) params.set("category", filters.category);
    if (filters.vendor) params.set("vendor", filters.vendor);
    if (filters.q) params.set("q", filters.q);
    if (filters.sourceId) params.set("sourceId", filters.sourceId);
    if (filters.settlementState) params.set("settlementState", filters.settlementState);
    if (page > 1) params.set("page", String(page));
    if (pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(pageSize));
    if (sort.col !== "createdAt") params.set("sortBy", sort.col);
    if (sort.dir !== "desc") params.set("sortDir", sort.dir);
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [filters, page, pageSize, pathname, router, sort]);

  useEffect(() => {
    if (!filters.start || !filters.end) {
      setDateRangeError("");
      return;
    }
    const startValue = new Date(filters.start);
    const endValue = new Date(filters.end);
    if (Number.isNaN(startValue.getTime()) || Number.isNaN(endValue.getTime())) {
      setDateRangeError("Enter a valid date range.");
      return;
    }
    setDateRangeError(startValue > endValue ? "Start date cannot be after end date." : "");
  }, [filters.end, filters.start]);

  const updateFilters = useCallback((patch: Partial<ExpenseFilterState>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
    setSavedViewId("");
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(defaultFilters());
    setPage(1);
    setSavedViewId("");
  }, []);

  const fetchExpenses = useCallback(async () => {
    const requestSeq = ++fetchSeqRef.current;
    try {
      if (requestSeq === fetchSeqRef.current) setLoading(true);
      const params = new URLSearchParams();
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.category) params.append("category", filters.category);
      if (deferredVendor) params.append("vendor", deferredVendor);
      if (deferredQuery) params.append("q", deferredQuery);
      if (filters.sourceId) params.append("sourceId", filters.sourceId);
      if (filters.settlementState) params.append("settlementState", filters.settlementState);
      params.append("page", String(page));
      params.append("pageSize", String(pageSize));
      params.append("sortBy", sort.col);
      params.append("sortDir", sort.dir);
      const res = await fetch(`/api/admin/expenses?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load expenses");
      const data = (await res.json()) as ExpenseListResponse;
      if (requestSeq !== fetchSeqRef.current) return;
      setRows(Array.isArray(data.items) ? data.items : []);
      setTotalAmount(Number(data.totalAmount || 0));
      setTotalCount(Number(data.totalCount || 0));
      setTotalPages(Math.max(1, Number(data.totalPages || 1)));
      setSummary(
        data.summary || {
          grossAmount: Number(data.totalAmount || 0),
          reversalAmount: 0,
          netAmount: Number(data.totalAmount || 0),
          outstandingLiability: 0,
          unpaidCount: 0,
          topCategories: [],
        },
      );
      if (typeof data.page === "number" && data.page !== page) setPage(data.page);
      setFetchError("");
    } catch (err) {
      if (requestSeq !== fetchSeqRef.current) return;
      const message = err instanceof Error ? err.message : "Failed to load expenses";
      setFetchError(message);
      toast.error(message);
    } finally {
      if (requestSeq === fetchSeqRef.current) setLoading(false);
    }
  }, [
    deferredQuery,
    deferredVendor,
    filters.category,
    filters.end,
    filters.settlementState,
    filters.sourceId,
    filters.start,
    page,
    pageSize,
    sort.col,
    sort.dir,
  ]);

  useEffect(() => {
    if (dateRangeError) return;
    void fetchExpenses();
  }, [dateRangeError, fetchExpenses]);

  const excludedSystemExpenseCodes = useMemo(() => new Set(["5000", "6100", "6990"]), []);

  useEffect(() => {
    let ignore = false;
    const loadExpenseCategories = async () => {
      try {
        setLoadingCategories(true);
        const res = await fetch("/api/admin/accounting/accounts", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as Array<{
          code: string;
          name: string;
          type: string;
          isActive: boolean;
        }>;
        if (ignore || !Array.isArray(data)) return;
        const options = data
          .filter(
            (row) =>
              row.isActive &&
              row.type === "EXPENSE" &&
              !excludedSystemExpenseCodes.has(String(row.code || "").trim()),
          )
          .sort((a, b) => a.code.localeCompare(b.code))
          .map((row) => ({
            value: `${row.code} ${row.name}`,
            label: `${row.code} - ${row.name}`,
          }));
        setExpenseCategories(options);
      } finally {
        if (!ignore) setLoadingCategories(false);
      }
    };
    void loadExpenseCategories();
    return () => {
      ignore = true;
    };
  }, [excludedSystemExpenseCodes]);

  const formatPayrollNote = (note?: string | null) => {
    if (!note) return "";
    const match = note.match(/Payroll(?: adjustment)? run\s+(\S+)\s+-\s+(\S+)/i);
    if (!match) return note;
    const startValue = new Date(match[1]);
    const endValue = new Date(match[2]);
    if (Number.isNaN(startValue.getTime()) || Number.isNaN(endValue.getTime())) return note;
    const label = note.toLowerCase().includes("adjustment")
      ? "Payroll adjustment period"
      : "Payroll period";
    return `${label}: ${startValue.toLocaleDateString()} - ${endValue.toLocaleDateString()}`;
  };

  const formatExpenseNote = (row: ExpenseRow) => {
    const raw = String(row.note || "").trim();
    if (!raw) return "";
    const lines = raw.split("\n");
    const nonSettlement = lines
      .filter((line) => !/^Settlement:/i.test(line.trim()))
      .join("\n")
      .trim();
    return formatPayrollNote(nonSettlement) || "";
  };

  const formatAmount = (value: number) => formatCurrency(value);

  const isPayrollExpense = (row: ExpenseRow) => Boolean(row.payrollRunId);
  const isAccruedTracked = (row: ExpenseRow) =>
    row.settlementStatus === "UNPAID" ||
    row.settlementStatus === "PARTIALLY_PAID" ||
    row.settlementStatus === "PAID";
  const isAccruedUnpaid = (row: ExpenseRow) =>
    row.settlementStatus === "UNPAID" || row.settlementStatus === "PARTIALLY_PAID";

  const settlementBadgeClass = (status?: ExpenseRow["settlementStatus"]) =>
    status === "PAID"
      ? chipToneClass("success")
      : status === "PARTIALLY_PAID"
      ? chipToneClass("warning")
      : chipToneClass("neutral");

  const settlementLabel = (status?: ExpenseRow["settlementStatus"]) =>
    status === "PARTIALLY_PAID" ? "Partially paid" : status === "PAID" ? "Paid" : "Unpaid";

  const formatLockReason = (row: ExpenseRow) => {
    if (row.lockReason) return row.lockReason;
    if (row.isReversal) return "Reversal rows are locked.";
    if (isPayrollExpense(row)) return "Payroll-generated expenses are managed from payroll.";
    return null;
  };

  const originalById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const getOriginal = (row: ExpenseRow) =>
    row.reversalOfId ? (originalById.get(row.reversalOfId) ?? null) : null;
  const formatOriginal = (original: ExpenseRow | null) => {
    if (!original) return "Original expense not on this page.";
    return `${formatDate(original.createdAt)} - ${original.category} - ${formatAmount(
      Number(original.amount),
    )}`;
  };
  const getRemaining = (row: ExpenseRow) =>
    typeof row.reversalRemaining === "number" ? row.reversalRemaining : null;

  const totalFmt = useMemo(() => formatCurrency(totalAmount), [totalAmount]);
  const grossFmt = useMemo(() => formatCurrency(summary.grossAmount || 0), [summary.grossAmount]);
  const reversalFmt = useMemo(
    () => formatCurrency(summary.reversalAmount || 0),
    [summary.reversalAmount],
  );
  const outstandingFmt = useMemo(
    () => formatCurrency(summary.outstandingLiability || 0),
    [summary.outstandingLiability],
  );
  const avgExpense = totalCount ? totalAmount / totalCount : 0;
  const showingStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const showingEnd = totalCount === 0 ? 0 : Math.min(page * pageSize, totalCount);
  const hasActiveFilters = Boolean(
    filters.category ||
      filters.vendor ||
      filters.q ||
      filters.sourceId ||
      filters.start ||
      filters.end ||
      filters.settlementState,
  );

  const tableColSpan =
    4 +
    (showCategoryCol ? 1 : 0) +
    (showVendorCol ? 1 : 0) +
    (showReasonCol ? 1 : 0) +
    (showNoteCol ? 1 : 0);

  const applyDatePreset = (preset: "today" | "last7" | "month") => {
    const now = new Date();
    const end = now.toISOString().slice(0, 10);
    let start = end;
    if (preset === "last7") {
      const seven = new Date(now);
      seven.setDate(now.getDate() - 6);
      start = seven.toISOString().slice(0, 10);
    } else if (preset === "month") {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      start = monthStart.toISOString().slice(0, 10);
    }
    updateFilters({ start, end });
  };

  const handleSort = (col: ExpenseSortBy) => {
    setPage(1);
    setSort((prev) =>
      prev.col === col ? { col, dir: prev.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" },
    );
  };

  const sortIndicator = (col: ExpenseSortBy) =>
    sort.col === col ? (sort.dir === "asc" ? " ↑" : " ↓") : "";

  const saveCurrentView = () => {
    const suggestion =
      filters.sourceId ||
      filters.vendor ||
      filters.category ||
      filters.settlementState ||
      "Expenses view";
    const name = window.prompt("Save this expenses view as:", suggestion)?.trim();
    if (!name) return;
    const snapshot: SavedExpenseView = {
      id: savedViewId || `${Date.now()}`,
      name,
      filters: { ...filters },
      sortBy: sort.col,
      sortDir: sort.dir,
      pageSize,
    };
    setSavedViews((prev) => {
      const next = prev.filter((item) => item.id !== snapshot.id && item.name !== name);
      return [snapshot, ...next].slice(0, 8);
    });
    setSavedViewId(snapshot.id);
    toast.success(`Saved view "${name}"`);
  };

  const applySavedView = (id: string) => {
    setSavedViewId(id);
    const view = savedViews.find((item) => item.id === id);
    if (!view) return;
    setFilters({ ...view.filters });
    setSort({ col: view.sortBy, dir: view.sortDir });
    setPageSize(view.pageSize);
    setPage(1);
  };

  const deleteSavedView = () => {
    if (!savedViewId) return;
    const target = savedViews.find((item) => item.id === savedViewId);
    setSavedViews((prev) => prev.filter((item) => item.id !== savedViewId));
    setSavedViewId("");
    if (target) toast.success(`Deleted saved view "${target.name}"`);
  };

  const handleExport = async () => {
    try {
      const params = new URLSearchParams();
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.category) params.append("category", filters.category);
      if (filters.vendor) params.append("vendor", filters.vendor);
      if (filters.settlementState) params.append("settlementState", filters.settlementState);
      if (filters.q) params.append("q", filters.q);
      if (filters.sourceId) params.append("sourceId", filters.sourceId);
      params.append("sortBy", sort.col);
      params.append("sortDir", sort.dir);
      params.append("format", "csv");
      const res = await fetch(`/api/admin/expenses?${params.toString()}`);
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const fileName =
        filters.start && filters.end
          ? `expenses_${filters.start}_to_${filters.end}.csv`
          : `expenses_${new Date().toISOString().slice(0, 10)}.csv`;
      const link = document.createElement("a");
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      void logAdminExportDownload({
        area: "expenses",
        format: "CSV",
        fileName,
        byteSize: blob.size,
        matchingCount: totalCount,
        sortKey: sort.col,
        sortDir: sort.dir,
        sourcePage: "admin/expenses",
        scopeSnapshot: `Start: ${filters.start || "-"} | End: ${filters.end || "-"} | Category: ${
          filters.category || "-"
        } | Vendor: ${filters.vendor || "-"} | Search: ${filters.q || "-"} | Settlement: ${
          filters.settlementState || "-"
        }`,
        resultSummary: `Downloaded filtered expenses CSV for ${totalCount.toLocaleString()} row${
          totalCount === 1 ? "" : "s"
        }.`,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    }
  };

  const doDeleteExpense = async (expense: ExpenseRow) => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/expenses/${expense.id}`, { method: "DELETE" });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error || "Failed to delete expense");
      await fetchExpenses();
      toast.warning(`${expense.category} deleted`, {
        action: {
          label: "Undo",
          onClick: async () => {
            const restore = await fetch(`/api/admin/expenses/${expense.id}`, { method: "POST" });
            if (!restore.ok) {
              const response = (await restore.json().catch(() => ({}))) as { error?: string };
              toast.error(response.error || "Failed to restore expense");
              return;
            }
            await fetchExpenses();
            toast.success(`${expense.category} restored`);
          },
        },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete expense");
    } finally {
      setDeleting(false);
    }
  };

  const openSettleDialog = (row: ExpenseRow) => {
    setSettleTarget(row);
    setSettleMode("");
    setSettleModeError("");
    setSettleAmount(String(Number(row.settlementOutstanding || 0).toFixed(2)));
    setSettleAmountError("");
    setSettleOpen(true);
  };

  const settleAccruedExpense = async () => {
    if (!settleTarget) return;
    if (!settleMode) {
      setSettleModeError("Select a payment mode.");
      return;
    }
    const outstanding = Number(settleTarget.settlementOutstanding || 0);
    const amount = Number(settleAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setSettleAmountError("Enter a valid amount.");
      return;
    }
    if (amount > outstanding) {
      setSettleAmountError(`Amount cannot exceed outstanding (${formatAmount(outstanding)}).`);
      return;
    }
    setSettling(true);
    try {
      const res = await fetch(`/api/admin/expenses/${settleTarget.id}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMode: settleMode, amount }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error || "Failed to settle expense.");
      toast.success("Expense payment recorded.");
      setSettleOpen(false);
      setSettleTarget(null);
      await fetchExpenses();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to settle expense.");
    } finally {
      setSettling(false);
    }
  };

  const openDetailDialog = async (row: ExpenseRow) => {
    setDetailOpen(true);
    setDetailTarget(row);
    setDetailData(null);
    setDetailError("");
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/expenses/${row.id}`, { cache: "no-store" });
      const payload = (await res.json().catch(() => ({}))) as ExpenseDetailResponse & { error?: string };
      if (!res.ok) throw new Error(payload.error || "Failed to load expense details.");
      setDetailData(payload);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Failed to load expense details.");
    } finally {
      setDetailLoading(false);
    }
  };

  const renderRowActions = (row: ExpenseRow) => {
    const remaining = getRemaining(row);
    const lockReason = formatLockReason(row);
    const showReverse = !row.canEdit && row.canReverse && remaining !== null && remaining > 0;
    const showSettle = isAccruedUnpaid(row) && row.canSettle;

    return (
      <>
        <Button variant="ghost" size="sm" onClick={() => void openDetailDialog(row)}>
          Details
        </Button>
        {isPayrollExpense(row) ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/hr/payroll/${row.payrollRunId}`}>View payroll run</Link>
          </Button>
        ) : null}
        {row.canEdit ? (
          <AddExpenseDialog
            mode="edit"
            expenseId={row.id}
            initial={{
              category: row.category,
              amount: Number(row.amount),
              vendor: row.vendor || "",
              reason: row.reason || "",
              note: row.note || "",
            }}
            onAdded={() => void fetchExpenses()}
            buttonVariant="outline"
            buttonSize="sm"
            label="Edit"
            submitText="Update"
          />
        ) : null}
        {row.canDelete ? (
          <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(row)}>
            Delete
          </Button>
        ) : null}
        {showReverse ? (
          <AddExpenseDialog
            mode="add"
            isReversal
            reversalOfId={row.id}
            reversalInfo={{ remaining, reversedSoFar: row.reversedSoFar ?? null }}
            initial={{
              category: row.category,
              amount: -Math.abs(remaining ?? Number(row.amount)),
              vendor: row.vendor || "",
              reason: "",
              note: "",
            }}
            onAdded={() => void fetchExpenses()}
            buttonVariant="outline"
            buttonSize="sm"
            label="Reverse"
            submitText="Create reversal"
          />
        ) : null}
        {showSettle ? (
          <Button variant="outline" size="sm" onClick={() => openSettleDialog(row)}>
            Record payment
          </Button>
        ) : null}
        {remaining !== null && remaining <= 0 ? (
          <span className="text-xs text-muted-foreground">Fully reversed</span>
        ) : null}
        {!row.canEdit && lockReason ? (
          <span className="text-xs text-muted-foreground" title={lockReason}>
            Locked
          </span>
        ) : null}
      </>
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1 text-center sm:text-left w-full sm:w-auto">
          <CardTitle className="text-base font-semibold">Expenses</CardTitle>
          <p className="text-sm text-muted-foreground">
            Review coded expenses, settlements, reversals, and exportable finance history.
          </p>
          <Link
            href="/admin/audit?entityType=EXPENSE&sourcePage=admin%2Fexpenses"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
          >
            View audit log
          </Link>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <AddExpenseDialog onAdded={() => void fetchExpenses()} />
          <Button
            className="w-full sm:w-auto"
            size="sm"
            variant="outline"
            onClick={handleExport}
            disabled={Boolean(dateRangeError)}
          >
            Export CSV (filtered)
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {filters.sourceId ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span className="font-medium">Exact expense ID filter active:</span> {filters.sourceId}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-1 h-6 px-2 text-[11px]"
              onClick={() => updateFilters({ sourceId: "", q: "" })}
            >
              Clear
            </Button>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div>
            <Label htmlFor="start">Start date</Label>
            <Input
              id="start"
              type="date"
              value={filters.start}
              onChange={(e) => updateFilters({ start: e.target.value })}
              aria-invalid={Boolean(dateRangeError)}
              className={dateRangeError ? "border-red-500" : ""}
            />
          </div>
          <div>
            <Label htmlFor="end">End date</Label>
            <Input
              id="end"
              type="date"
              value={filters.end}
              onChange={(e) => updateFilters({ end: e.target.value })}
              aria-invalid={Boolean(dateRangeError)}
              className={dateRangeError ? "border-red-500" : ""}
            />
            {dateRangeError ? <p className="mt-1 text-xs text-red-600">{dateRangeError}</p> : null}
          </div>
          <div>
            <Label htmlFor="category">Category</Label>
            <select
              id="category"
              value={filters.category}
              onChange={(e) => updateFilters({ category: e.target.value })}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{loadingCategories ? "Loading categories..." : "All expense categories"}</option>
              {expenseCategories.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="vendor">Vendor</Label>
            <Input
              id="vendor"
              value={filters.vendor}
              placeholder="e.g. Shell, MTN"
              onChange={(e) => updateFilters({ vendor: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="settlementState">Settlement</Label>
            <select
              id="settlementState"
              value={filters.settlementState}
              onChange={(e) =>
                updateFilters({ settlementState: e.target.value as SettlementStateFilter })
              }
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">All settlement states</option>
              <option value="UNPAID">Unpaid</option>
              <option value="PARTIALLY_PAID">Partially paid</option>
              <option value="PAID">Paid</option>
            </select>
          </div>
          <div>
            <Label htmlFor="q">Search</Label>
            <Input
              id="q"
              value={filters.q}
              placeholder="Vendor, category, reason, note, or exact expense ID"
              onChange={(e) => updateFilters({ q: e.target.value })}
            />
            <p className="mt-1 text-xs text-muted-foreground">Paste a full expense ID for an exact match.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Date presets:</span>
          <Button size="sm" variant="outline" onClick={() => applyDatePreset("today")}>Today</Button>
          <Button size="sm" variant="outline" onClick={() => applyDatePreset("last7")}>Last 7 days</Button>
          <Button size="sm" variant="outline" onClick={() => applyDatePreset("month")}>This month</Button>
          {summary.topCategories.length > 0 ? <span className="ml-2 text-xs text-muted-foreground">Top categories:</span> : null}
          {summary.topCategories.map((item) => (
            <Button
              key={item.category}
              size="sm"
              variant={filters.category === item.category ? "default" : "outline"}
              onClick={() => updateFilters({ category: item.category })}
            >
              {item.category}
            </Button>
          ))}
          {hasActiveFilters ? <Button size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button> : null}
        </div>

        <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <Label htmlFor="savedView">Saved view</Label>
              <select
                id="savedView"
                value={savedViewId}
                onChange={(e) => applySavedView(e.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">Select a saved view</option>
                {savedViews.map((view) => (
                  <option key={view.id} value={view.id}>
                    {view.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="pageSize">Page size</Label>
              <select
                id="pageSize"
                value={String(pageSize)}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="25">25 rows</option>
                <option value="50">50 rows</option>
                <option value="100">100 rows</option>
              </select>
            </div>
            <div>
              <Label htmlFor="sortMode">Sort</Label>
              <select
                id="sortMode"
                value={`${sort.col}:${sort.dir}`}
                onChange={(e) => {
                  const [col, dir] = e.target.value.split(":");
                  setSort({ col: normalizeSortBy(col), dir: normalizeSortDir(dir) });
                  setPage(1);
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="createdAt:desc">Newest first</option>
                <option value="createdAt:asc">Oldest first</option>
                <option value="amount:desc">Amount high to low</option>
                <option value="amount:asc">Amount low to high</option>
                <option value="category:asc">Category A-Z</option>
                <option value="vendor:asc">Vendor A-Z</option>
                <option value="settlementStatus:asc">Settlement status</option>
              </select>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={saveCurrentView}>Save current view</Button>
            <Button size="sm" variant="outline" onClick={deleteSavedView} disabled={!savedViewId}>
              Delete saved view
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <div className="rounded-md bg-background p-3 shadow-sm"><div className="text-xs text-muted-foreground">Filtered expenses</div><div className="text-lg font-semibold">{totalCount}</div></div>
          <div className="rounded-md bg-background p-3 shadow-sm"><div className="text-xs text-muted-foreground">Gross amount</div><div className="text-lg font-semibold">{grossFmt}</div></div>
          <div className="rounded-md bg-background p-3 shadow-sm"><div className="text-xs text-muted-foreground">Reversals</div><div className="text-lg font-semibold">{reversalFmt}</div></div>
          <div className="rounded-md bg-background p-3 shadow-sm"><div className="text-xs text-muted-foreground">Net amount</div><div className="text-lg font-semibold">{totalFmt}</div></div>
          <div className="rounded-md bg-background p-3 shadow-sm"><div className="text-xs text-muted-foreground">Outstanding liability</div><div className={`text-lg font-semibold ${summary.outstandingLiability > 0 ? "text-amber-700" : ""}`}>{summary.outstandingLiability > 0 ? outstandingFmt : "-"}</div></div>
          <div className="rounded-md bg-background p-3 shadow-sm"><div className="text-xs text-muted-foreground">Unpaid or partial</div><div className="text-lg font-semibold">{summary.unpaidCount}<span className="ml-2 text-xs font-normal text-muted-foreground">Avg {totalCount ? formatAmount(avgExpense) : "-"}</span></div></div>
        </div>

        <p className="text-sm text-muted-foreground">
          {loading
            ? "Loading expenses..."
            : fetchError
            ? `Error: ${fetchError}`
            : totalCount === 0
            ? "No matching expenses."
            : `Showing ${showingStart}-${showingEnd} of ${totalCount} expenses`}
        </p>

        <div className="flex flex-col gap-2 rounded-md border bg-background p-3 md:flex-row md:items-center md:justify-between">
          <p className="text-xs text-muted-foreground">
            {totalCount === 0
              ? "No rows to review."
              : `Page ${page} of ${Math.max(1, totalPages)}. Server-side sorting and pagination are active.`}
          </p>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuCheckboxItem
                checked={showCategoryCol}
                onCheckedChange={(checked) => setShowCategoryCol(Boolean(checked))}
              >
                Category
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showVendorCol}
                onCheckedChange={(checked) => setShowVendorCol(Boolean(checked))}
              >
                Vendor
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showReasonCol}
                onCheckedChange={(checked) => setShowReasonCol(Boolean(checked))}
              >
                Reason
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showNoteCol}
                onCheckedChange={(checked) => setShowNoteCol(Boolean(checked))}
              >
                Note
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="grid gap-3 lg:hidden">
          {loading && rows.length === 0
            ? Array.from({ length: 3 }).map((_, index) => (
                <div key={`expense-skeleton-${index}`} className="rounded-lg border p-4">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="mt-3 h-4 w-full" />
                  <Skeleton className="mt-2 h-4 w-4/5" />
                  <Skeleton className="mt-4 h-9 w-32" />
                </div>
              ))
            : rows.map((row) => {
                const note = formatExpenseNote(row);
                const original = getOriginal(row);
                const remaining = getRemaining(row);
                const isLocked = !row.canEdit && Boolean(formatLockReason(row));
                return (
                  <div key={row.id} className="rounded-lg border bg-background p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold">{formatAmount(Number(row.amount))}</p>
                        <p className="text-xs text-muted-foreground">{formatDate(row.createdAt)}</p>
                      </div>
                      {isAccruedTracked(row) ? (
                        <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${settlementBadgeClass(row.settlementStatus)}`}>
                          {settlementLabel(row.settlementStatus)}
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-3 space-y-2 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Category</p>
                        <p>{row.category}</p>
                      </div>
                      {row.vendor ? (
                        <div>
                          <p className="text-xs text-muted-foreground">Vendor</p>
                          <p>{row.vendor}</p>
                        </div>
                      ) : null}
                      {row.reason ? (
                        <div>
                          <p className="text-xs text-muted-foreground">Reason</p>
                          <p>{row.reason}</p>
                        </div>
                      ) : null}
                      {note ? (
                        <div>
                          <p className="text-xs text-muted-foreground">Note</p>
                          <p className="whitespace-pre-wrap break-words">{note}</p>
                        </div>
                      ) : null}
                      {row.reversalOfId ? (
                        <div>
                          <p className="text-xs text-muted-foreground">Reversal of</p>
                          <p>{formatOriginal(original)}</p>
                        </div>
                      ) : null}
                      {remaining !== null ? (
                        <div>
                          <p className="text-xs text-muted-foreground">Reversal remaining</p>
                          <p>{formatAmount(remaining)}</p>
                        </div>
                      ) : null}
                      {isAccruedTracked(row) ? (
                        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                          <div className="rounded-md bg-muted/40 p-2">
                            <div>Paid</div>
                            <div className="text-sm font-medium text-foreground">
                              {formatAmount(Number(row.settlementPaid || 0))}
                            </div>
                          </div>
                          <div className="rounded-md bg-muted/40 p-2">
                            <div>Outstanding</div>
                            <div className="text-sm font-medium text-foreground">
                              {formatAmount(Number(row.settlementOutstanding || 0))}
                            </div>
                          </div>
                        </div>
                      ) : null}
                      {isLocked ? (
                        <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                          {formatLockReason(row)}
                        </p>
                      ) : null}
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">{renderRowActions(row)}</div>
                  </div>
                );
              })}
        </div>

        <div className="hidden overflow-x-auto rounded-lg border lg:block">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-4 py-3 text-left font-medium">
                  <button type="button" className="inline-flex items-center hover:text-foreground" onClick={() => handleSort("createdAt")}>
                    Date{sortIndicator("createdAt")}
                  </button>
                </th>
                {showCategoryCol ? (
                  <th className="px-4 py-3 text-left font-medium">
                    <button type="button" className="inline-flex items-center hover:text-foreground" onClick={() => handleSort("category")}>
                      Category{sortIndicator("category")}
                    </button>
                  </th>
                ) : null}
                <th className="px-4 py-3 text-left font-medium">
                  <button type="button" className="inline-flex items-center hover:text-foreground" onClick={() => handleSort("amount")}>
                    Amount{sortIndicator("amount")}
                  </button>
                </th>
                {showVendorCol ? (
                  <th className="px-4 py-3 text-left font-medium">
                    <button type="button" className="inline-flex items-center hover:text-foreground" onClick={() => handleSort("vendor")}>
                      Vendor{sortIndicator("vendor")}
                    </button>
                  </th>
                ) : null}
                {showReasonCol ? <th className="px-4 py-3 text-left font-medium">Reason</th> : null}
                {showNoteCol ? <th className="px-4 py-3 text-left font-medium">Note</th> : null}
                <th className="px-4 py-3 text-left font-medium">
                  <button type="button" className="inline-flex items-center hover:text-foreground" onClick={() => handleSort("settlementStatus")}>
                    Status{sortIndicator("settlementStatus")}
                  </button>
                </th>
                <th className="px-4 py-3 text-left font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-background">
              {loading && rows.length === 0 ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <tr key={`row-skeleton-${index}`}>
                    <td colSpan={tableColSpan} className="px-4 py-4">
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-4 w-full" />
                      </div>
                    </td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={tableColSpan} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No expenses match the current filters.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const note = formatExpenseNote(row);
                  const original = getOriginal(row);
                  const remaining = getRemaining(row);
                  const lockReason = formatLockReason(row);
                  const outstanding = Number(row.settlementOutstanding || 0);
                  const paid = Number(row.settlementPaid || 0);
                  return (
                    <tr key={row.id} className="align-top">
                      <td className="px-4 py-4">
                        <div className="space-y-1">
                          <div>{formatDate(row.createdAt)}</div>
                          <div className="text-xs text-muted-foreground">{row.id}</div>
                        </div>
                      </td>
                      {showCategoryCol ? (
                        <td className="px-4 py-4">
                          <div className="space-y-1">
                            <div>{row.category}</div>
                            {row.reversalOfId ? (
                              <div className="text-xs text-muted-foreground">
                                Reversal of: {formatOriginal(original)}
                              </div>
                            ) : null}
                            {remaining !== null ? (
                              <div className="text-xs text-muted-foreground">
                                Remaining to reverse: {formatAmount(remaining)}
                              </div>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                      <td className="px-4 py-4 font-medium">{formatAmount(Number(row.amount))}</td>
                      {showVendorCol ? <td className="px-4 py-4">{row.vendor || "-"}</td> : null}
                      {showReasonCol ? (
                        <td className="px-4 py-4">
                          <div className="max-w-[14rem] whitespace-pre-wrap break-words">
                            {row.reason || "-"}
                          </div>
                        </td>
                      ) : null}
                      {showNoteCol ? (
                        <td className="px-4 py-4">
                          <div className="max-w-[16rem] space-y-1">
                            <div className="whitespace-pre-wrap break-words">{note || "-"}</div>
                            {isPayrollExpense(row) ? (
                              <div className="text-xs text-muted-foreground">Payroll-generated</div>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                      <td className="px-4 py-4">
                        <div className="space-y-2">
                          {isAccruedTracked(row) ? (
                            <>
                              <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${settlementBadgeClass(row.settlementStatus)}`}>
                                {settlementLabel(row.settlementStatus)}
                              </span>
                              <div className="text-xs text-muted-foreground">
                                <div>Paid: {formatAmount(paid)}</div>
                                <div>Outstanding: {formatAmount(outstanding)}</div>
                                {row.settlementLastPaidAt ? (
                                  <div>Last payment: {formatDate(row.settlementLastPaidAt)}</div>
                                ) : null}
                              </div>
                            </>
                          ) : row.isReversal ? (
                            <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${chipToneClass("neutral")}`}>
                              Reversal
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">Direct expense</span>
                          )}
                          {!row.canEdit && lockReason ? (
                            <Tooltip content={lockReason}>
                              <span className="inline-flex cursor-help rounded-full border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                                Locked
                              </span>
                            </Tooltip>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex max-w-[15rem] flex-wrap gap-2">{renderRowActions(row)}</div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 ? (
          <div className="flex flex-col gap-3 rounded-md border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Showing {showingStart}-{showingEnd} of {totalCount}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setPage(1)} disabled={page === 1}>
                First
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={page === 1}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={page >= totalPages}
              >
                Next
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPage(totalPages)}
                disabled={page >= totalPages}
              >
                Last
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>

      <Dialog
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) {
            setDetailTarget(null);
            setDetailData(null);
            setDetailError("");
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Expense details</DialogTitle>
            <DialogDescription>
              Review settlement history, reversals, journals, and audit events for this expense.
            </DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : detailError ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {detailError}
            </div>
          ) : detailData ? (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Original amount</div>
                  <div className="text-base font-semibold">
                    {formatAmount(Number(detailData.metrics?.originalAmount || detailData.expense.amount || 0))}
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Settled</div>
                  <div className="text-base font-semibold">
                    {formatAmount(Number(detailData.metrics?.settlementPaid || 0))}
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Outstanding</div>
                  <div className="text-base font-semibold">
                    {formatAmount(Number(detailData.metrics?.settlementOutstanding || 0))}
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">Remaining after reversals</div>
                  <div className="text-base font-semibold">
                    {formatAmount(Number(detailData.metrics?.remainingAfterReversals || 0))}
                  </div>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-md border p-4">
                  <h3 className="text-sm font-semibold">Expense snapshot</h3>
                  <dl className="mt-3 space-y-2 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">ID</dt>
                      <dd>{detailData.expense.id}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Category</dt>
                      <dd>{detailData.expense.category}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Vendor</dt>
                      <dd>{detailData.expense.vendor || "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Reason</dt>
                      <dd>{detailData.expense.reason || "-"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Created</dt>
                      <dd>{formatDate(detailData.expense.createdAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Lock reason</dt>
                      <dd>{formatLockReason(detailData.expense) || "Editable from this page."}</dd>
                    </div>
                    {detailData.original ? (
                      <div>
                        <dt className="text-xs text-muted-foreground">Original expense</dt>
                        <dd>{formatOriginal(detailData.original)}</dd>
                      </div>
                    ) : null}
                  </dl>
                </div>

                <div className="rounded-md border p-4">
                  <h3 className="text-sm font-semibold">Reversal history</h3>
                  {detailData.reversals?.length ? (
                    <div className="mt-3 space-y-3">
                      {detailData.reversals.map((row) => (
                        <div key={row.id} className="rounded-md border bg-muted/20 p-3 text-sm">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-medium">{formatAmount(Number(row.amount))}</span>
                            <span className="text-xs text-muted-foreground">{formatDate(row.createdAt)}</span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">{row.reason || "No reason recorded."}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted-foreground">No reversal activity recorded.</p>
                  )}
                </div>
              </div>

              <div className="rounded-md border p-4">
                <h3 className="text-sm font-semibold">Journal entries</h3>
                {detailData.journals?.length ? (
                  <div className="mt-3 space-y-3">
                    {detailData.journals.map((entry) => (
                      <div key={entry.id} className="rounded-md border bg-muted/20 p-3">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-sm font-medium">{entry.memo || "Expense journal entry"}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatDate(entry.entryDate)} | {entry.status} | {entry.sourceId || entry.id}
                            </p>
                          </div>
                        </div>
                        <div className="mt-3 overflow-x-auto">
                          <table className="min-w-full text-xs">
                            <thead>
                              <tr className="text-left text-muted-foreground">
                                <th className="pb-2 pr-4 font-medium">Account</th>
                                <th className="pb-2 pr-4 font-medium">Description</th>
                                <th className="pb-2 pr-4 font-medium">Debit</th>
                                <th className="pb-2 font-medium">Credit</th>
                              </tr>
                            </thead>
                            <tbody>
                              {entry.lines.map((line, index) => (
                                <tr key={`${entry.id}-line-${index}`} className="border-t">
                                  <td className="py-2 pr-4">{line.account.code} {line.account.name}</td>
                                  <td className="py-2 pr-4">{line.description || "-"}</td>
                                  <td className="py-2 pr-4">{formatAmount(Number(line.debit || 0))}</td>
                                  <td className="py-2">{formatAmount(Number(line.credit || 0))}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">No related journals found.</p>
                )}
              </div>

              <div className="rounded-md border p-4">
                <h3 className="text-sm font-semibold">Audit trail</h3>
                {detailData.audits?.length ? (
                  <div className="mt-3 space-y-3">
                    {detailData.audits.map((audit) => (
                      <div key={audit.id} className="rounded-md border bg-muted/20 p-3 text-sm">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="font-medium">
                              {audit.action}
                              {audit.outcome ? ` · ${audit.outcome}` : ""}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {audit.actor?.name || audit.actor?.email || "System"} | {formatDate(audit.createdAt)}
                            </p>
                          </div>
                        </div>
                        {audit.meta ? (
                          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-950 p-3 text-xs text-slate-50">
                            {JSON.stringify(audit.meta, null, 2)}
                          </pre>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">No audit events recorded for this expense.</p>
                )}
              </div>
            </div>
          ) : detailTarget ? (
            <p className="text-sm text-muted-foreground">No detail payload returned for {detailTarget.id}.</p>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={settleOpen}
        onOpenChange={(open) => {
          setSettleOpen(open);
          if (!open) {
            setSettleTarget(null);
            setSettleMode("");
            setSettleModeError("");
            setSettleAmount("");
            setSettleAmountError("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record expense payment</DialogTitle>
            <DialogDescription>
              Post a settlement against the accrued expense. The payment action is audit logged with amount, mode, and journal linkage.
            </DialogDescription>
          </DialogHeader>

          {settleTarget ? (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/20 p-3 text-sm">
                <div className="font-medium">{settleTarget.category}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Outstanding: {formatAmount(Number(settleTarget.settlementOutstanding || 0))}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="settle-mode">Payment mode</Label>
                <select
                  id="settle-mode"
                  value={settleMode}
                  onChange={(e) => {
                    setSettleMode(e.target.value as ExpensePaymentModeSelection);
                    if (settleModeError) setSettleModeError("");
                  }}
                  className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${settleModeError ? "border-red-500" : ""}`}
                >
                  <option value="">Select payment mode</option>
                  <option value="cash">Cash</option>
                  <option value="bank">Bank transfer</option>
                  <option value="momo">MoMo</option>
                </select>
                {settleModeError ? <p className="text-xs text-red-600">{settleModeError}</p> : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="settle-amount">Amount</Label>
                <Input
                  id="settle-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={settleAmount}
                  onChange={(e) => {
                    setSettleAmount(e.target.value);
                    if (settleAmountError) setSettleAmountError("");
                  }}
                  aria-invalid={Boolean(settleAmountError)}
                  className={settleAmountError ? "border-red-500" : ""}
                />
                {settleAmountError ? <p className="text-xs text-red-600">{settleAmountError}</p> : null}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSettleOpen(false)} disabled={settling}>
              Cancel
            </Button>
            <Button onClick={() => void settleAccruedExpense()} disabled={settling || !settleTarget}>
              {settling ? "Posting..." : "Record payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete expense</DialogTitle>
            <DialogDescription>
              Soft-delete the selected expense. This action is audit logged and can be undone immediately from the toast.
            </DialogDescription>
          </DialogHeader>

          {deleteTarget ? (
            <div className="rounded-md border bg-muted/20 p-3 text-sm">
              <div className="font-medium">{deleteTarget.category}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {formatAmount(Number(deleteTarget.amount))} {deleteTarget.vendor ? `| ${deleteTarget.vendor}` : ""}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return;
                void doDeleteExpense(deleteTarget).then(() => setDeleteTarget(null));
              }}
              disabled={deleting || !deleteTarget}
            >
              {deleting ? "Deleting..." : "Delete expense"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function AdminExpensesPage() {
  return (
    <section className="container mx-auto py-8">
      <Suspense
        fallback={
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold">Expenses</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Loading expenses...</p>
            </CardContent>
          </Card>
        }
      >
        <AdminExpensesContent />
      </Suspense>
    </section>
  );
}
