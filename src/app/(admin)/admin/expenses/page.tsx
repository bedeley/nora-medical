"use client";

export const dynamic = "force-dynamic";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import AddExpenseDialog from "@/app/(admin)/dashboard/components/AddExpenseDialog";
import { chipToneClass } from "@/lib/status-chips";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";
import Link from "next/link";

type ExpensePaymentMode = "cash" | "bank" | "momo";
type ExpensePaymentModeSelection = ExpensePaymentMode | "";
type SettlementStateFilter = "" | "UNPAID" | "PARTIALLY_PAID" | "PAID";

function AdminExpensesContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);
  const syncingFromUrl = useRef(false);
  const fetchSeqRef = useRef(0);

  const [filters, setFilters] = useState<{
    start: string;
    end: string;
    category: string;
    vendor: string;
    q: string;
    sourceId: string;
    settlementState: SettlementStateFilter;
  }>({ start: "", end: "", category: "", vendor: "", q: "", sourceId: "", settlementState: "" });
  const [loading, setLoading] = useState(false);
  const [dateRangeError, setDateRangeError] = useState("");
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
    settlementPaid?: number | null;
    settlementOutstanding?: number | null;
    settlementStatus?: "UNPAID" | "PARTIALLY_PAID" | "PAID" | null;
    settlementLastPaidAt?: string | null;
    payrollRunId?: string | null;
    createdAt: string | Date;
  };
  const excludedSystemExpenseCodes = useMemo(() => new Set(["5000", "6100", "6990"]), []);
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [expenseCategories, setExpenseCategories] = useState<Array<{ value: string; label: string }>>([]);
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [showCategoryCol, setShowCategoryCol] = useState(true);
  const [showVendorCol, setShowVendorCol] = useState(true);
  const [showReasonCol, setShowReasonCol] = useState(true);
  const [showNoteCol, setShowNoteCol] = useState(true);
  const [settleOpen, setSettleOpen] = useState(false);
  const [settleTarget, setSettleTarget] = useState<ExpenseRow | null>(null);
  const [settleMode, setSettleMode] = useState<ExpensePaymentModeSelection>("");
  const [settleModeError, setSettleModeError] = useState("");
  const [settleAmount, setSettleAmount] = useState("");
  const [settleAmountError, setSettleAmountError] = useState("");
  const [settling, setSettling] = useState(false);

  const formatPayrollNote = (note?: string | null) => {
    if (!note) return "";
    const match = note.match(/Payroll(?: adjustment)? run\s+(\S+)\s+-\s+(\S+)/i);
    if (!match) return note;
    const start = new Date(match[1]);
    const end = new Date(match[2]);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return note;
    const label = note.toLowerCase().includes("adjustment") ? "Payroll adjustment period" : "Payroll period";
    return `${label}: ${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;
  };
  const formatCompactDateTime = (input: string) => {
    const value = new Date(input);
    if (Number.isNaN(value.getTime())) return "";
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    const hh = String(value.getHours()).padStart(2, "0");
    const mm = String(value.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${d}, ${hh}:${mm}`;
  };
  const formatExpenseNote = (row: ExpenseRow) => {
    const raw = String(row.note || "").trim();
    if (!raw) return "";
    const lines = raw.split("\n");
    const settlementLine = lines.find((line) => /^Settlement:/i.test(line.trim())) || "";
    const nonSettlement = lines.filter((line) => !/^Settlement:/i.test(line.trim())).join("\n").trim();
    const base = formatPayrollNote(nonSettlement);
    if (!settlementLine) return formatPayrollNote(raw);

    const status = row.settlementStatus;
    if (!status) return base || settlementLine;

    const paid = Number(row.settlementPaid || 0);
    const total = Number(row.amount || 0);
    const ratio = `${paid.toFixed(2)}/${total.toFixed(2)}`;
    const viaMatch = settlementLine.match(/via\s+([^,;)\n]+)(?:,|;|\)|\s+on|\s+at|$)/i);
    const viaRaw = viaMatch?.[1]?.trim() || "";
    const via = viaRaw.replace(/\s+(?:on|at)\b.*$/i, "").trim().replace(/[;,]+$/, "");
    const onMatch = settlementLine.match(/(?:on|at)\s+(\d{4}-\d{2}-\d{2}T[0-9:.+-Z]+|\d{4}-\d{2}-\d{2}[ T][0-9:.-]+)/i);
    const when = onMatch?.[1] ? formatCompactDateTime(onMatch[1]) : "";
    const parts = [when, via].filter(Boolean);

    const settlementSummary =
      status === "UNPAID"
        ? "Settlement: accrued (unpaid)"
        : status === "PARTIALLY_PAID"
        ? `Settlement: partially paid ${ratio}${parts.length ? `, ${parts.join(", ")}` : ""}`
        : `Settlement: paid ${ratio}${parts.length ? `, ${parts.join(", ")}` : ""}`;

    return base ? `${base}\n${settlementSummary}` : settlementSummary;
  };

  useEffect(() => {
    const sp = new URLSearchParams(searchParams.toString());
    const rawQ = sp.get("q") || "";
    const rawSourceId = sp.get("sourceId") || "";
    const promotedSourceId =
      rawSourceId ||
      (/^[a-z0-9]{20,}$/i.test(rawQ) && !rawQ.includes(" ") ? rawQ : "");
    const next = {
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
    syncingFromUrl.current = true;
    setFilters((prev) => {
      if (
        prev.start === next.start &&
        prev.end === next.end &&
        prev.category === next.category &&
        prev.vendor === next.vendor &&
        prev.q === next.q &&
        prev.sourceId === next.sourceId &&
        prev.settlementState === next.settlementState
      ) {
        return prev;
      }
      return next;
    });
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
    else params.delete("start");
    if (filters.end) params.set("end", filters.end);
    else params.delete("end");
    if (filters.category) params.set("category", filters.category);
    else params.delete("category");
    if (filters.vendor) params.set("vendor", filters.vendor);
    else params.delete("vendor");
    if (filters.q) params.set("q", filters.q);
    else params.delete("q");
    if (filters.sourceId) params.set("sourceId", filters.sourceId);
    else params.delete("sourceId");
    if (filters.settlementState) params.set("settlementState", filters.settlementState);
    else params.delete("settlementState");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [filters, pathname, router]);

  useEffect(() => {
    if (!filters.start || !filters.end) {
      setDateRangeError("");
      return;
    }
    const start = new Date(filters.start);
    const end = new Date(filters.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setDateRangeError("Enter a valid date range.");
      return;
    }
    setDateRangeError(start > end ? "Start date cannot be after end date." : "");
  }, [filters.start, filters.end]);

  const fetchExpenses = useCallback(async () => {
    const requestSeq = ++fetchSeqRef.current;
    try {
      if (requestSeq === fetchSeqRef.current) setLoading(true);
      const params = new URLSearchParams();
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.category) params.append("category", filters.category);
      if (filters.vendor) params.append("vendor", filters.vendor);
      if (filters.q) params.append("q", filters.q);
      if (filters.sourceId) params.append("sourceId", filters.sourceId);
      if (filters.settlementState) params.append("settlementState", filters.settlementState);
      const res = await fetch(`/api/admin/expenses?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load expenses");
      const data = await res.json();
      if (requestSeq !== fetchSeqRef.current) return;
      setRows((data.items || []) as ExpenseRow[]);
      setTotal(data.totalAmount || 0);
    } catch (err) {
      if (requestSeq !== fetchSeqRef.current) return;
      console.error(err);
    } finally {
      if (requestSeq === fetchSeqRef.current) setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

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
            label: `${row.code} · ${row.name}`,
          }));
        setExpenseCategories(options);
      } finally {
        if (!ignore) setLoadingCategories(false);
      }
    };
    loadExpenseCategories();
    return () => {
      ignore = true;
    };
  }, [excludedSystemExpenseCodes]);

  const deleteExpense = async (expense: ExpenseRow) => {
    if (!confirm("Delete this expense?")) return;
    try {
      const res = await fetch(`/api/admin/expenses/${expense.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      await fetchExpenses();
      toast.warning(`${expense.category} deleted`, {
        action: {
          label: "Undo",
          onClick: async () => {
            const restore = await fetch(`/api/admin/expenses/${expense.id}`, { method: "POST" });
            if (!restore.ok) {
              const j = await restore.json().catch(async () => ({ error: await restore.text().catch(() => "") }));
              toast.error(j?.error || "Failed to restore expense");
              return;
            }
            await fetchExpenses();
            toast.success(`${expense.category} restored`);
          },
        },
      });
    } catch (err) {
      console.error(err);
      toast.error("Failed to delete expense");
    }
  };

  const totalFmt = useMemo(() => formatCurrency(total), [total]);
  const avgExpense = rows.length ? total / rows.length : 0;
  const formatAmount = (value: number) => formatCurrency(value);
  const isLocked = (createdAt: string | Date) => {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    return ageMs > 48 * 60 * 60 * 1000;
  };
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
  const isRowLocked = (row: ExpenseRow) =>
    row.isReversal || isLocked(row.createdAt) || isPayrollExpense(row);
  const getRemaining = (row: ExpenseRow) =>
    typeof row.reversalRemaining === "number" ? row.reversalRemaining : null;
  const originalById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const getOriginal = (row: ExpenseRow) =>
    row.reversalOfId ? originalById.get(row.reversalOfId) ?? null : null;
  const formatOriginal = (original: ExpenseRow | null) => {
    if (!original) return "Original expense not in current filters.";
    const created = new Date(original.createdAt).toLocaleString();
    const amount = formatAmount(Number(original.amount));
    return `${created} • ${original.category} • ${amount}`;
  };
  const topCategories = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row) => {
      const category = String(row.category || "").trim();
      if (!category) return;
      map.set(category, (map.get(category) || 0) + 1);
    });
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([category]) => category);
  }, [rows]);
  const tableColSpan = 4
    + (showCategoryCol ? 1 : 0)
    + (showVendorCol ? 1 : 0)
    + (showReasonCol ? 1 : 0)
    + (showNoteCol ? 1 : 0);

  const handleExport = async () => {
    const params = new URLSearchParams();
    if (filters.start) params.append("start", filters.start);
    if (filters.end) params.append("end", filters.end);
    if (filters.category) params.append("category", filters.category);
    if (filters.settlementState) params.append("settlementState", filters.settlementState);
    if (filters.q) params.append("q", filters.q);
    if (filters.sourceId) params.append("sourceId", filters.sourceId);
    params.append("format", "csv");
    const res = await fetch(`/api/admin/expenses?${params.toString()}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `expenses_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
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
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || "Failed to settle expense.");
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

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1 text-center sm:text-left w-full sm:w-auto">
          <CardTitle className="text-base font-semibold">Expenses</CardTitle>
          <p className="text-sm text-muted-foreground">Filter, review, and export expense records</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <AddExpenseDialog onAdded={() => fetchExpenses()} />
          <Button className="w-full sm:w-auto" size="sm" variant="outline" onClick={handleExport}>
            Export CSV (filtered)
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {filters.sourceId ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span className="font-medium">Exact source filter active:</span> {filters.sourceId}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-1 h-6 px-2 text-[11px]"
              onClick={() =>
                setFilters((prev) => ({
                  ...prev,
                  sourceId: "",
                }))
              }
            >
              Clear
            </Button>
          </div>
        ) : null}
        <div className="grid sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <div>
            <Label htmlFor="start">Start date</Label>
            <Input
              id="start"
              type="date"
              value={filters.start}
              onChange={(e) => {
                setFilters({ ...filters, start: e.target.value });
                if (dateRangeError) setDateRangeError("");
              }}
              aria-invalid={!!dateRangeError}
              className={dateRangeError ? "border-red-500" : ""}
            />
          </div>
          <div>
            <Label htmlFor="end">End date</Label>
            <Input
              id="end"
              type="date"
              value={filters.end}
              onChange={(e) => {
                setFilters({ ...filters, end: e.target.value });
                if (dateRangeError) setDateRangeError("");
              }}
              aria-invalid={!!dateRangeError}
              className={dateRangeError ? "border-red-500" : ""}
            />
            {dateRangeError && <p className="mt-1 text-xs text-red-600">{dateRangeError}</p>}
          </div>
          <div>
            <Label htmlFor="category">Category</Label>
            <select
              id="category"
              value={filters.category}
              onChange={(e) => setFilters({ ...filters, category: e.target.value })}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">
                {loadingCategories ? "Loading categories..." : "All expense categories"}
              </option>
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
              onChange={(e) => setFilters({ ...filters, vendor: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="settlementState">Settlement</Label>
            <select
              id="settlementState"
              value={filters.settlementState}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  settlementState: e.target.value as SettlementStateFilter,
                })
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
            <Input id="q" value={filters.q}
              placeholder="Search notes/category/vendor/reason"
              onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          </div>
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-2">
            <div className="text-xs text-muted-foreground">Top categories</div>
            {topCategories.length === 0 ? (
              <span className="text-xs text-muted-foreground">None</span>
            ) : (
              topCategories.map((category) => (
                <Button
                  key={category}
                  type="button"
                  size="sm"
                  variant={filters.category === category ? "default" : "outline"}
                  onClick={() => setFilters((prev) => ({ ...prev, category }))}
                >
                  {category}
                </Button>
              ))
            )}
            {(filters.category || filters.vendor || filters.q || filters.sourceId || filters.start || filters.end || filters.settlementState) ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setFilters({
                    start: "",
                    end: "",
                    category: "",
                    vendor: "",
                    q: "",
                    sourceId: "",
                    settlementState: "",
                  })
                }
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Expenses</div>
            <div className="text-lg font-semibold">{rows.length}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Total amount</div>
            <div className="text-lg font-semibold">{totalFmt}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Avg per expense</div>
            <div className="text-lg font-semibold">
              {rows.length ? formatAmount(avgExpense) : "-"}
            </div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Filters</div>
            <div className="text-lg font-semibold">
              {[
                filters.start ? 1 : 0,
                filters.end ? 1 : 0,
                filters.category ? 1 : 0,
                filters.vendor ? 1 : 0,
                filters.settlementState ? 1 : 0,
                filters.q ? 1 : 0,
                filters.sourceId ? 1 : 0,
              ].reduce((s, v) => s + v, 0)}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">{loading ? "Loading..." : `${rows.length} record(s)`}</p>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">Columns</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem
                  onSelect={(event) => event.preventDefault()}
                  checked={showCategoryCol}
                  onCheckedChange={(value) => setShowCategoryCol(Boolean(value))}
                >
                  Category
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  onSelect={(event) => event.preventDefault()}
                  checked={showVendorCol}
                  onCheckedChange={(value) => setShowVendorCol(Boolean(value))}
                >
                  Vendor
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  onSelect={(event) => event.preventDefault()}
                  checked={showReasonCol}
                  onCheckedChange={(value) => setShowReasonCol(Boolean(value))}
                >
                  Reason
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  onSelect={(event) => event.preventDefault()}
                  checked={showNoteCol}
                  onCheckedChange={(value) => setShowNoteCol(Boolean(value))}
                >
                  Note
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="lg:hidden space-y-3">
          {rows.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              <p>No expenses found for the current filters.</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setFilters({
                        start: "",
                        end: "",
                        category: "",
                        vendor: "",
                        q: "",
                        sourceId: "",
                        settlementState: "",
                      })
                    }
                  >
                    Clear filters
                  </Button>
                <AddExpenseDialog onAdded={() => fetchExpenses()} />
              </div>
            </div>
          ) : (
            rows.map((r) => (
              <div key={r.id} className="rounded-lg border p-4 shadow-sm space-y-3">
                <div className="flex justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">
                      {r.category}
                      {isPayrollExpense(r) ? (
                        <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                          Payroll
                        </span>
                      ) : null}
                      {r.isReversal ? (
                        <Tooltip content={formatOriginal(getOriginal(r))}>
                          <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${chipToneClass("warning")}`}>
                            Reversal
                          </span>
                        </Tooltip>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</p>
                    {isAccruedTracked(r) ? (
                      <p className="mt-1">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${settlementBadgeClass(r.settlementStatus)}`}
                        >
                          {settlementLabel(r.settlementStatus)}
                        </span>
                      </p>
                    ) : null}
                    {r.vendor ? (
                      <p className="text-xs text-muted-foreground">Vendor: {r.vendor}</p>
                    ) : null}
                    {r.reason ? (
                      <p className="text-xs text-muted-foreground">Reason: {r.reason}</p>
                    ) : null}
                  </div>
                  <p className="text-right font-semibold">{formatAmount(Number(r.amount))}</p>
                </div>
                {r.note ? (
                  <p className="text-sm text-muted-foreground break-words">
                    <span className="font-medium text-foreground">Note:</span> {formatExpenseNote(r)}
                  </p>
                ) : null}
                {isAccruedTracked(r) ? (
                  <p className="text-xs text-muted-foreground">
                    Paid: {formatAmount(Number(r.settlementPaid || 0))} | Outstanding:{" "}
                    <span className={isAccruedUnpaid(r) ? "text-amber-700 font-medium" : "text-emerald-700 font-medium"}>
                      {formatAmount(Number(r.settlementOutstanding || 0))}
                    </span>
                    {r.settlementLastPaidAt ? (
                      <>
                        {" "}
                        | Last paid: {formatCompactDateTime(r.settlementLastPaidAt)}
                      </>
                    ) : null}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {isPayrollExpense(r) ? (
                    <>
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/admin/hr/payroll/${r.payrollRunId}`}>View payroll run</Link>
                      </Button>
                      <span className="text-xs text-muted-foreground self-center">Locked</span>
                    </>
                  ) : isRowLocked(r) ? (
                    r.isReversal ? (
                      <span className="text-xs text-muted-foreground self-center">Locked</span>
                    ) : (
                      <>
                        {getRemaining(r) !== null && getRemaining(r)! <= 0 ? (
                          <span className="text-xs text-muted-foreground self-center">Fully reversed</span>
                        ) : (
                          <>
                            <AddExpenseDialog
                              mode="add"
                              isReversal
                              reversalOfId={r.id}
                              reversalInfo={{ remaining: getRemaining(r), reversedSoFar: r.reversedSoFar ?? null }}
                              initial={{
                                category: r.category,
                                amount: -Math.abs(getRemaining(r) ?? Number(r.amount)),
                                vendor: r.vendor || "",
                                reason: "",
                                note: "",
                              }}
                              onAdded={() => fetchExpenses()}
                              buttonVariant="outline"
                              buttonSize="sm"
                              label="Reverse"
                              submitText="Create reversal"
                            />
                            {isAccruedUnpaid(r) ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openSettleDialog(r)}
                              >
                                Record payment
                              </Button>
                            ) : null}
                          </>
                        )}
                      </>
                    )
                  ) : (
                    <>
                      <AddExpenseDialog
                        mode="edit"
                        expenseId={r.id}
                        initial={{
                          category: r.category,
                          amount: Number(r.amount),
                          vendor: r.vendor || "",
                          reason: r.reason || "",
                          note: r.note || "",
                        }}
                        onAdded={() => fetchExpenses()}
                        buttonVariant="outline"
                        buttonSize="sm"
                        label="Edit"
                        submitText="Update"
                      />
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => deleteExpense(r)}
                      >
                        Delete
                      </Button>
                      {isAccruedUnpaid(r) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openSettleDialog(r)}
                        >
                          Record payment
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="overflow-x-auto hidden lg:block">
          <table className="w-full text-sm border-collapse table-auto">
            <thead className="bg-muted text-left">
              <tr>
                <th className="p-2">Date</th>
                {showCategoryCol && <th className="p-2">Category</th>}
                {showVendorCol && <th className="p-2">Vendor</th>}
                {showReasonCol && <th className="p-2">Reason</th>}
                <th className="p-2 text-right">Amount</th>
                <th className="p-2">Settlement</th>
                {showNoteCol && <th className="p-2">Note</th>}
                <th className="p-2 w-[140px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={tableColSpan} className="p-6 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-3">
                      <span>No expenses found for the current filters.</span>
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setFilters({
                              start: "",
                              end: "",
                              category: "",
                              vendor: "",
                              q: "",
                              sourceId: "",
                              settlementState: "",
                            })
                          }
                        >
                          Clear filters
                        </Button>
                        <AddExpenseDialog onAdded={() => fetchExpenses()} />
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    className="odd:bg-background even:bg-muted/40 hover:bg-accent/60"
                  >
                    <td className="p-2">{new Date(r.createdAt).toLocaleString()}</td>
                    {showCategoryCol && (
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          <span>{r.category}</span>
                          {isPayrollExpense(r) ? (
                            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                              Payroll
                            </span>
                          ) : null}
                          {r.isReversal ? (
                            <Tooltip content={formatOriginal(getOriginal(r))}>
                              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${chipToneClass("warning")}`}>
                                Reversal
                              </span>
                            </Tooltip>
                          ) : null}
                        </div>
                      </td>
                    )}
                    {showVendorCol && <td className="p-2">{r.vendor || ""}</td>}
                    {showReasonCol && <td className="p-2">{r.reason || ""}</td>}
                    <td className="p-2 text-right">{formatAmount(Number(r.amount))}</td>
                    <td className="p-2 align-top">
                      {isAccruedTracked(r) ? (
                        <div className="space-y-1">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${settlementBadgeClass(r.settlementStatus)}`}
                          >
                            {settlementLabel(r.settlementStatus)}
                          </span>
                          <div className="text-xs text-muted-foreground">
                            {r.settlementLastPaidAt
                              ? `Last paid: ${formatCompactDateTime(r.settlementLastPaidAt)}`
                              : "-"}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                    {showNoteCol && (
                      <td className="p-2 max-w-[300px] align-top">
                        <div className="whitespace-pre-line break-words">{formatExpenseNote(r)}</div>
                        {isAccruedTracked(r) ? (
                          <div className="text-xs text-muted-foreground mt-1">
                            Paid: {formatAmount(Number(r.settlementPaid || 0))} | Outstanding:{" "}
                            <span className={isAccruedUnpaid(r) ? "text-amber-700 font-medium" : "text-emerald-700 font-medium"}>
                              {formatAmount(Number(r.settlementOutstanding || 0))}
                            </span>
                          </div>
                        ) : null}
                      </td>
                    )}
                    <td className="p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        {isPayrollExpense(r) ? (
                          <>
                            <Button asChild size="sm" variant="outline">
                              <Link href={`/admin/hr/payroll/${r.payrollRunId}`}>View payroll run</Link>
                            </Button>
                            <span className="text-xs text-muted-foreground">Locked</span>
                          </>
                        ) : isRowLocked(r) ? (
                          r.isReversal ? (
                            <span className="text-xs text-muted-foreground">Locked</span>
                          ) : (
                            <>
                              {getRemaining(r) !== null && getRemaining(r)! <= 0 ? (
                                <span className="text-xs text-muted-foreground">Fully reversed</span>
                              ) : (
                              <>
                                <AddExpenseDialog
                                  mode="add"
                                  isReversal
                                  reversalOfId={r.id}
                                  reversalInfo={{ remaining: getRemaining(r), reversedSoFar: r.reversedSoFar ?? null }}
                                  initial={{
                                    category: r.category,
                                    amount: -Math.abs(getRemaining(r) ?? Number(r.amount)),
                                    vendor: r.vendor || "",
                                    reason: "",
                                    note: "",
                                  }}
                                  onAdded={() => fetchExpenses()}
                                  buttonVariant="outline"
                                  buttonSize="sm"
                                  label="Reverse"
                                  submitText="Create reversal"
                                />
                                {isAccruedUnpaid(r) ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => openSettleDialog(r)}
                                  >
                                    Record payment
                                  </Button>
                                ) : null}
                              </>
                            )}
                          </>
                        )
                      ) : (
                          <>
                            <AddExpenseDialog
                              mode="edit"
                              expenseId={r.id}
                              initial={{
                                category: r.category,
                                amount: Number(r.amount),
                                vendor: r.vendor || "",
                                reason: r.reason || "",
                                note: r.note || "",
                              }}
                              onAdded={() => fetchExpenses()}
                              buttonVariant="outline"
                              buttonSize="sm"
                              label="Edit"
                              submitText="Update"
                            />
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => deleteExpense(r)}
                            >
                              Delete
                            </Button>
                            {isAccruedUnpaid(r) ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openSettleDialog(r)}
                              >
                                Record payment
                              </Button>
                            ) : null}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Dialog open={settleOpen} onOpenChange={setSettleOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Record expense payment</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              <div className="rounded-md border p-3">
                <div className="font-medium">{settleTarget?.category || "Expense"}</div>
                <div className="text-xs text-muted-foreground">
                  Amount: {formatAmount(Number(settleTarget?.amount || 0))}
                </div>
              </div>
              <div>
                <Label htmlFor="settleMode">Payment mode</Label>
                <select
                  id="settleMode"
                  value={settleMode}
                  onChange={(e) => {
                    setSettleMode(e.target.value as ExpensePaymentModeSelection);
                    if (settleModeError) setSettleModeError("");
                  }}
                  className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${settleModeError ? "border-red-500" : ""}`}
                  aria-invalid={Boolean(settleModeError)}
                >
                  <option value="">Select payment mode</option>
                  <option value="cash">Cash</option>
                  <option value="bank">Bank transfer</option>
                  <option value="momo">MoMo</option>
                </select>
                {settleModeError ? (
                  <p className="mt-1 text-xs text-red-600">{settleModeError}</p>
                ) : null}
              </div>
              <div>
                <Label htmlFor="settleAmount">Amount to pay</Label>
                <Input
                  id="settleAmount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={String(Number(settleTarget?.settlementOutstanding || 0))}
                  value={settleAmount}
                  onChange={(e) => {
                    setSettleAmount(e.target.value);
                    if (settleAmountError) setSettleAmountError("");
                  }}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Outstanding: {formatAmount(Number(settleTarget?.settlementOutstanding || 0))}
                </p>
                {settleAmountError ? (
                  <p className="mt-1 text-xs text-red-600">{settleAmountError}</p>
                ) : null}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSettleOpen(false)} disabled={settling}>
                Cancel
              </Button>
              <Button onClick={settleAccruedExpense} disabled={settling}>
                {settling ? "Posting..." : "Record payment"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
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
              <p className="text-sm text-muted-foreground">Loading expenses…</p>
            </CardContent>
          </Card>
        }
      >
        <AdminExpensesContent />
      </Suspense>
    </section>
  );
}
