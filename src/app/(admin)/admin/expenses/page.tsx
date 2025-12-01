"use client";

export const dynamic = "force-dynamic";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import AddExpenseDialog from "@/app/(admin)/dashboard/components/AddExpenseDialog";

function AdminExpensesContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);

  const [filters, setFilters] = useState({ start: "", end: "", category: "", q: "" });
  const [loading, setLoading] = useState(false);
  type ExpenseRow = {
    id: string;
    category: string;
    amount: number | string;
    note: string | null;
    createdAt: string | Date;
  };
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams.toString());
    setFilters({
      start: sp.get("start") || "",
      end: sp.get("end") || "",
      category: sp.get("category") || "",
      q: sp.get("q") || "",
    });
    initialized.current = true;
  }, [searchParams]);

  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams(searchParams.toString());
    if (filters.start) params.set("start", filters.start);
    else params.delete("start");
    if (filters.end) params.set("end", filters.end);
    else params.delete("end");
    if (filters.category) params.set("category", filters.category);
    else params.delete("category");
    if (filters.q) params.set("q", filters.q);
    else params.delete("q");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [filters, pathname, router, searchParams]);

  const fetchExpenses = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.category) params.append("category", filters.category);
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

  const totalFmt = useMemo(() => total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), [total]);

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
          <CardTitle>Expenses</CardTitle>
          <p className="text-sm text-muted-foreground">Filter, review, and export expense records</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <AddExpenseDialog onAdded={() => fetchExpenses()} />
          <Button className="w-full sm:w-auto" variant="outline" onClick={handleExport}>Export CSV</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <Label htmlFor="start">Start date</Label>
            <Input id="start" type="date" value={filters.start}
              onChange={(e) => setFilters({ ...filters, start: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="end">End date</Label>
            <Input id="end" type="date" value={filters.end}
              onChange={(e) => setFilters({ ...filters, end: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="category">Category</Label>
            <Input id="category" value={filters.category}
              placeholder="e.g. Delivery, Utilities"
              onChange={(e) => setFilters({ ...filters, category: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="q">Search</Label>
            <Input id="q" value={filters.q}
              placeholder="Search notes/category"
              onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          </div>
        </div>

        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">{loading ? "Loading..." : `${rows.length} record(s)`}</p>
          <p className="text-sm">
            Total: <span className="font-medium">{totalFmt}</span>
          </p>
        </div>

        <div className="md:hidden space-y-3">
          {rows.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              No expenses found
            </div>
          ) : (
            rows.map((r) => (
              <div key={r.id} className="rounded-lg border p-4 shadow-sm space-y-3">
                <div className="flex justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{r.category}</p>
                    <p className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</p>
                  </div>
                  <p className="text-right font-semibold">{Number(r.amount).toFixed(2)}</p>
                </div>
                {r.note ? (
                  <p className="text-sm text-muted-foreground break-words">
                    <span className="font-medium text-foreground">Note:</span> {r.note}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <AddExpenseDialog
                    mode="edit"
                    expenseId={r.id}
                    initial={{ category: r.category, amount: Number(r.amount), note: r.note || "" }}
                    onAdded={() => fetchExpenses()}
                    buttonVariant="outline"
                    buttonSize="sm"
                    label="Edit"
                    submitText="Update"
                  />
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={async () => {
                      if (!confirm("Delete this expense?")) return;
                      try {
                        const res = await fetch(`/api/admin/expenses/${r.id}`, { method: "DELETE" });
                        if (!res.ok) throw new Error("Failed to delete");
                        await fetchExpenses();
                      } catch (err) {
                        console.error(err);
                      }
                    }}
                  >
                    Delete
                  </Button>
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
                <th className="p-2">Category</th>
                <th className="p-2 text-right">Amount</th>
                <th className="p-2">Note</th>
                <th className="p-2 w-[140px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-4 text-center text-muted-foreground">No expenses found</td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    className="odd:bg-background even:bg-muted/40 hover:bg-accent/60"
                  >
                    <td className="p-2">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="p-2">{r.category}</td>
                    <td className="p-2 text-right">{Number(r.amount).toFixed(2)}</td>
                    <td className="p-2">{r.note || ""}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-2">
                        <AddExpenseDialog
                          mode="edit"
                          expenseId={r.id}
                          initial={{ category: r.category, amount: Number(r.amount), note: r.note || "" }}
                          onAdded={() => fetchExpenses()}
                          buttonVariant="outline"
                          buttonSize="sm"
                          label="Edit"
                          submitText="Update"
                        />
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={async () => {
                            if (!confirm("Delete this expense?")) return;
                            try {
                              const res = await fetch(`/api/admin/expenses/${r.id}`, { method: "DELETE" });
                              if (!res.ok) throw new Error("Failed to delete");
                              await fetchExpenses();
                            } catch (err) {
                              console.error(err);
                            }
                          }}
                        >
                          Delete
                        </Button>
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
    <Suspense
      fallback={
        <Card>
          <CardHeader>
            <CardTitle>Expenses</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Loading expenses…</p>
          </CardContent>
        </Card>
      }
    >
      <AdminExpensesContent />
    </Suspense>
  );
}
