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
import { Tooltip } from "@/components/ui/tooltip";
import AddExpenseDialog from "@/app/(admin)/dashboard/components/AddExpenseDialog";
import { chipToneClass } from "@/lib/status-chips";
import { toast } from "sonner";

function AdminExpensesContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);

  const [filters, setFilters] = useState({ start: "", end: "", category: "", vendor: "", q: "" });
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
    createdAt: string | Date;
  };
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [showCategoryCol, setShowCategoryCol] = useState(true);
  const [showVendorCol, setShowVendorCol] = useState(true);
  const [showReasonCol, setShowReasonCol] = useState(true);
  const [showNoteCol, setShowNoteCol] = useState(true);

  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams.toString());
    setFilters({
      start: sp.get("start") || "",
      end: sp.get("end") || "",
      category: sp.get("category") || "",
      vendor: sp.get("vendor") || "",
      q: sp.get("q") || "",
    });
    initialized.current = true;
  }, [searchParams]);

  useEffect(() => {
    if (!initialized.current) return;
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
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.category) params.append("category", filters.category);
      if (filters.vendor) params.append("vendor", filters.vendor);
      if (filters.q) params.append("q", filters.q);
      const res = await fetch(`/api/admin/expenses?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load expenses");
      const data = await res.json();
      setRows((data.items || []) as ExpenseRow[]);
      setTotal(data.totalAmount || 0);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchExpenses();
  }, [fetchExpenses]);

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

  const totalFmt = useMemo(() => total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), [total]);
  const avgExpense = rows.length ? total / rows.length : 0;
  const formatAmount = (value: number) =>
    value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isLocked = (createdAt: string | Date) => {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    return ageMs > 48 * 60 * 60 * 1000;
  };
  const isRowLocked = (row: ExpenseRow) => row.isReversal || isLocked(row.createdAt);
  const getRemaining = (row: ExpenseRow) =>
    typeof row.reversalRemaining === "number" ? row.reversalRemaining : null;
  const originalById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const getOriginal = (row: ExpenseRow) =>
    row.reversalOfId ? originalById.get(row.reversalOfId) ?? null : null;
  const formatOriginal = (original: ExpenseRow | null) => {
    if (!original) return "Original expense not in current filters.";
    const created = new Date(original.createdAt).toLocaleString();
    const amount = `GH₵${formatAmount(Number(original.amount))}`;
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
  const tableColSpan = 3
    + (showCategoryCol ? 1 : 0)
    + (showVendorCol ? 1 : 0)
    + (showReasonCol ? 1 : 0)
    + (showNoteCol ? 1 : 0);

  const handleExport = async () => {
    const params = new URLSearchParams();
    if (filters.start) params.append("start", filters.start);
    if (filters.end) params.append("end", filters.end);
    if (filters.category) params.append("category", filters.category);
    if (filters.q) params.append("q", filters.q);
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
        <div className="grid sm:grid-cols-2 md:grid-cols-6 gap-3">
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
            <Input id="category" value={filters.category}
              placeholder="e.g. Delivery, Utilities"
              onChange={(e) => setFilters({ ...filters, category: e.target.value })} />
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
            <Label htmlFor="q">Search</Label>
            <Input id="q" value={filters.q}
              placeholder="Search notes/category/vendor/reason"
              onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          </div>
          <div className="flex flex-wrap items-end gap-2 md:col-span-2">
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
            {(filters.category || filters.vendor || filters.q || filters.start || filters.end) ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setFilters({ start: "", end: "", category: "", vendor: "", q: "" })}
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
              {rows.length ? avgExpense.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-"}
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
                filters.q ? 1 : 0,
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

        <div className="md:hidden space-y-3">
          {rows.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              <p>No expenses found for the current filters.</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setFilters({ start: "", end: "", category: "", vendor: "", q: "" })}
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
                      {r.isReversal ? (
                        <Tooltip content={formatOriginal(getOriginal(r))}>
                          <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${chipToneClass("warning")}`}>
                            Reversal
                          </span>
                        </Tooltip>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</p>
                    {r.vendor ? (
                      <p className="text-xs text-muted-foreground">Vendor: {r.vendor}</p>
                    ) : null}
                    {r.reason ? (
                      <p className="text-xs text-muted-foreground">Reason: {r.reason}</p>
                    ) : null}
                  </div>
                  <p className="text-right font-semibold">{Number(r.amount).toFixed(2)}</p>
                </div>
                {r.note ? (
                  <p className="text-sm text-muted-foreground break-words">
                    <span className="font-medium text-foreground">Note:</span> {r.note}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {isRowLocked(r) ? (
                    r.isReversal ? (
                      <span className="text-xs text-muted-foreground self-center">Locked</span>
                    ) : (
                      <>
                        {getRemaining(r) !== null && getRemaining(r)! <= 0 ? (
                          <span className="text-xs text-muted-foreground self-center">Fully reversed</span>
                        ) : (
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
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="overflow-x-auto hidden md:block">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-muted text-left">
              <tr>
                <th className="p-2">Date</th>
                {showCategoryCol && <th className="p-2">Category</th>}
                {showVendorCol && <th className="p-2">Vendor</th>}
                {showReasonCol && <th className="p-2">Reason</th>}
                <th className="p-2 text-right">Amount</th>
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
                          onClick={() => setFilters({ start: "", end: "", category: "", vendor: "", q: "" })}
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
                    <td className="p-2 text-right">{Number(r.amount).toFixed(2)}</td>
                    {showNoteCol && <td className="p-2">{r.note || ""}</td>}
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        {isRowLocked(r) ? (
                          r.isReversal ? (
                            <span className="text-xs text-muted-foreground">Locked</span>
                          ) : (
                            <>
                              {getRemaining(r) !== null && getRemaining(r)! <= 0 ? (
                                <span className="text-xs text-muted-foreground">Fully reversed</span>
                              ) : (
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
