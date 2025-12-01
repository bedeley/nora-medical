"use client";

export const dynamic = "force-dynamic";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Info } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

// Title-case helper: capitalizes first letter of each word
function toTitleCase(str: string) {
  return String(str || "").replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

type Product = { id: string; name: string };

type PurchaseRow = {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  unitCost: number;
  total: number;
  supplier?: string | null;
  note?: string | null;
  createdAt: string | Date;
};

function AdminPurchasesContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);

  const [filters, setFilters] = useState({ start: "", end: "", supplier: "", q: "", product: "" });
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(50);
  const [products, setProducts] = useState<Product[]>([]);
  const [form, setForm] = useState({ productId: "", quantity: "", unitCost: "", supplier: "", note: "" });
  const [currentCost, setCurrentCost] = useState<number | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [selected, setSelected] = useState<PurchaseRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams.toString());
    setFilters({
      start: sp.get("start") || "",
      end: sp.get("end") || "",
      supplier: sp.get("supplier") || "",
      q: sp.get("q") || "",
      product: sp.get("product") || "",
    });
    initialized.current = true;
  }, [searchParams]);

  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams(searchParams.toString());
    if (filters.start) params.set("start", filters.start); else params.delete("start");
    if (filters.end) params.set("end", filters.end); else params.delete("end");
    if (filters.supplier) params.set("supplier", filters.supplier); else params.delete("supplier");
    if (filters.q) params.set("q", filters.q); else params.delete("q");
    if (filters.product) params.set("product", filters.product); else params.delete("product");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [filters, pathname, router, searchParams]);

  async function fetchProducts() {
    try {
      const res = await fetch(`/api/products?pageSize=200&includeArchived=1`);
      const data = await res.json();
      const list: Product[] = (data.items || []).map((p: { id: string; name: string }) => ({ id: p.id, name: p.name }));
      setProducts(list);
    } catch {}
  }

  const fetchPurchases = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.supplier) params.append("supplier", filters.supplier);
      if (filters.q) params.append("q", filters.q);
      if (filters.product) params.append("product", filters.product);
      const res = await fetch(`/api/admin/purchases?${params.toString()}`);
      let data: { items?: PurchaseRow[]; error?: string } = {};
      try { data = await res.json(); } catch {}
      if (!res.ok) {
        console.error("Failed to load purchases:", data?.error || res.statusText);
        setRows([]);
        setError(typeof data?.error === "string" ? data.error : "Failed to load purchases");
        return;
      }
      setRows(data.items || []);
      setPage(1);
      setError(null);
    } catch (err) {
      console.error(err);
      setRows([]);
      setError(err instanceof Error ? err.message : "Failed to load purchases");
    } finally {
      setLoading(false);
    }
  }, [filters.start, filters.end, filters.supplier, filters.q, filters.product]);

  useEffect(() => {
    fetchProducts();
    fetchPurchases();
  }, [fetchPurchases]);

  // Preselect product from URL if provided
  useEffect(() => {
    const sp = new URLSearchParams(searchParams.toString());
    const pid = sp.get("product");
    if (pid) setForm((f) => ({ ...f, productId: pid }));
  }, [searchParams]);

  // Load current average cost when product changes
  useEffect(() => {
    (async () => {
      if (!form.productId) { setCurrentCost(null); return; }
      try {
        const inv = await fetch('/api/admin/inventory');
        const data = await inv.json();
        const row = (data.rows || []).find((r: { id: string; cost?: number | string | null }) => r.id === form.productId);
        setCurrentCost(row ? Number(row.cost || 0) : null);
      } catch {
        setCurrentCost(null);
      }
    })();
  }, [form.productId]);

  const variance = useMemo(() => {
    const uc = Number(form.unitCost);
    if (!currentCost && currentCost !== 0) return null;
    if (!isFinite(uc)) return null;
    const diff = uc - Number(currentCost);
    const pct = Number(currentCost) > 0 ? (diff / Number(currentCost)) * 100 : null;
    return { diff, pct } as { diff: number; pct: number | null };
  }, [form.unitCost, currentCost]);

  const totals = useMemo(() => {
    const qty = rows.reduce((s, r) => s + Number(r.quantity || 0), 0);
    const value = rows.reduce((s, r) => s + Number(r.total || 0), 0);
    return { qty, value };
  }, [rows]);

  const totalPages = Math.max(1, Math.ceil((rows.length || 0) / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paginatedRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, currentPage, pageSize]);

  const handleExport = async () => {
    const params = new URLSearchParams();
    if (filters.start) params.append("start", filters.start);
    if (filters.end) params.append("end", filters.end);
    if (filters.supplier) params.append("supplier", filters.supplier);
    if (filters.q) params.append("q", filters.q);
    if (filters.product) params.append("product", filters.product);
    params.append("format", "csv");
    const res = await fetch(`/api/admin/purchases?${params.toString()}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `purchases_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  async function submitPurchase(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch(`/api/admin/purchases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: form.productId,
          quantity: Number(form.quantity),
          unitCost: Number(form.unitCost),
          supplier: form.supplier.trim() || undefined,
          note: form.note.trim() || undefined,
        }),
      });
      if (!res.ok) {
        let payload: { error?: string } = {};
        try { payload = await res.json(); } catch {}
        const msg = typeof payload?.error === "string" ? payload.error : "Failed to save purchase";
        setError(msg);
        return;
      }
      const payload = await res.json().catch(() => ({} as { newCost?: number }));
      if (payload && typeof payload.newCost === "number") {
        setCurrentCost(payload.newCost);
      }
      setForm({ productId: "", quantity: "", unitCost: "", supplier: "", note: "" });
      fetchPurchases();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to save purchase");
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1 text-center sm:text-left w-full sm:w-auto">
          <CardTitle>Purchases</CardTitle>
          <p className="text-sm text-muted-foreground">Record restocks and update weighted-average cost</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <Button className="w-full sm:w-auto" form="purchase-form" type="submit">Add Purchase</Button>
          <Button className="w-full sm:w-auto" variant="outline" onClick={handleExport}>Export CSV</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <div className="mb-2 p-2 rounded-md bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}
        <form id="purchase-form" onSubmit={submitPurchase} className="grid md:grid-cols-5 gap-3 items-end">
          <div>
            <Label htmlFor="product">Product</Label>
            <select
              id="product"
              className="border rounded-md h-9 w-full bg-background capitalize"
              value={form.productId}
              onChange={(e) => setForm({ ...form, productId: e.target.value })}
              required
            >
              <option value="">Select a product</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{toTitleCase(p.name || "")}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="qty">Quantity</Label>
            <Input id="qty" type="number" min="1" value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })} required />
          </div>
          <div>
            <Label
              htmlFor="uc"
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span>Unit Cost</span>
              {currentCost != null && (
                <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <span>
                    Current avg:{" "}
                    <span className="font-medium">
                      {Number(currentCost).toFixed(2)}
                    </span>
                  </span>
                  {variance &&
                    variance.pct !== null &&
                    Math.abs(variance.pct) >= 20 && (
                      <Tooltip
                        content={`Entered cost deviates ${variance.pct!.toFixed(
                          1,
                        )}% from current average`}
                      >
                        <span
                          className={`ml-1 font-medium ${
                            variance.pct! > 0
                              ? "text-red-600"
                              : "text-amber-600"
                          }`}
                        >
                          {variance.pct! > 0 ? "↑" : "↓"}{" "}
                          {Math.abs(variance.pct!).toFixed(1)}%
                        </span>
                      </Tooltip>
                    )}
                </span>
              )}
            </Label>
            <Input
              id="uc"
              type="number"
              step="0.01"
              min="0"
              value={form.unitCost}
              onChange={(e) =>
                setForm({ ...form, unitCost: e.target.value })
              }
              required
            />
          </div>
          <div>
            <Label htmlFor="supplier">Supplier</Label>
            <Input id="supplier" value={form.supplier}
              onChange={(e) => setForm({ ...form, supplier: e.target.value })} placeholder="Optional" />
          </div>
          <div>
            <Label htmlFor="note">Note</Label>
            <Input id="note" value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Optional" />
          </div>
          <div className="md:col-span-5">
            <Button type="submit">Add Purchase</Button>
          </div>
        </form>

        <div className="grid sm:grid-cols-2 md:grid-cols-5 gap-3">
          <div>
            <Label htmlFor="start">Start date</Label>
            <Input id="start" type="date" value={filters.start} onChange={(e) => setFilters({ ...filters, start: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="end">End date</Label>
            <Input id="end" type="date" value={filters.end} onChange={(e) => setFilters({ ...filters, end: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="supplierFilter">Supplier</Label>
            <Input id="supplierFilter" value={filters.supplier} onChange={(e) => setFilters({ ...filters, supplier: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="productFilter">Product</Label>
            <select
              id="productFilter"
              className="border rounded-md h-9 w-full bg-background capitalize"
              value={filters.product}
              onChange={(e) => setFilters({ ...filters, product: e.target.value })}
            >
              <option value="">All products</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{toTitleCase(p.name || "")}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="q">Search note</Label>
            <Input id="q" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{loading ? "Loading..." : `${rows.length} record(s)`}</span>
            <span className="hidden sm:inline">•</span>
            <label className="flex items-center gap-1">
              <span className="text-xs">Rows per page:</span>
              <select
                className="h-7 rounded border bg-background px-1 text-xs"
                value={pageSize}
                onChange={(e) => {
                  const next = Number(e.target.value) as 25 | 50 | 100;
                  setPageSize(next);
                  setPage(1);
                }}
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
          </div>
          <p className="text-sm">
            Totals: <span className="font-medium">Qty {totals.qty}</span> &bull;{" "}
            <span className="font-medium">Value {formatCurrency(totals.value)}</span>
          </p>
        </div>

        <div className="md:hidden space-y-3">
          {rows.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              No purchases found
            </div>
          ) : (
            paginatedRows.map((r) => (
              <div key={r.id} className="rounded-lg border p-4 shadow-sm space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold">{toTitleCase(r.productName || "")}</p>
                    <p className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="View details"
                    title="View details"
                    onClick={() => { setSelected(r); setInfoOpen(true); }}
                  >
                    <Info className="w-4 h-4" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs uppercase">Qty</p>
                    <p className="font-medium">{r.quantity}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-muted-foreground text-xs uppercase">Unit Cost</p>
                    <p className="font-medium">{formatCurrency(Number(r.unitCost || 0))}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs uppercase">Total</p>
                    <p className="font-medium">{formatCurrency(Number(r.total || 0))}</p>
                  </div>
                  {r.supplier ? (
                    <div className="text-right">
                      <p className="text-muted-foreground text-xs uppercase">Supplier</p>
                      <p className="font-medium">{r.supplier}</p>
                    </div>
                  ) : null}
                </div>
                {r.note ? (
                  <p className="text-sm text-muted-foreground break-words">
                    <span className="font-medium text-foreground">Note:</span> {r.note}
                  </p>
                ) : null}
              </div>
            ))
          )}
        </div>

        <div className="overflow-x-auto hidden md:block">
          <table className="w-full text-sm border-collapse border border-gray-200 dark:border-gray-800">
            <thead className="bg-muted text-left">
              <tr>
                <th className="p-2 border">Date</th>
                <th className="p-2 border">Product</th>
                <th className="p-2 border text-right">Qty</th>
                <th className="p-2 border text-right">Unit Cost</th>
                <th className="p-2 border text-right">Total</th>
                <th className="p-2 border">Supplier</th>
                <th className="p-2 border">Note</th>
                <th className="p-2 border text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-4 text-center text-muted-foreground">No purchases found</td>
                </tr>
              ) : (
                paginatedRows.map((r) => (
                  <tr
                    key={r.id}
                    className="odd:bg-background even:bg-muted/40 hover:bg-accent/60"
                  >
                    <td className="p-2 border">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="p-2 border">{toTitleCase(r.productName || "")}</td>
                    <td className="p-2 border text-right">{r.quantity}</td>
                    <td className="p-2 border text-right">{formatCurrency(Number(r.unitCost || 0))}</td>
                    <td className="p-2 border text-right">{formatCurrency(Number(r.total || 0))}</td>
                    <td className="p-2 border">{r.supplier || ""}</td>
                    <td className="p-2 border">{r.note || ""}</td>
                    <td className="p-2 border text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="View details"
                        title="View details"
                        onClick={() => { setSelected(r); setInfoOpen(true); }}
                      >
                        <Info className="w-4 h-4" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {rows.length > pageSize && (
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground pt-2">
            <span>
              Page {currentPage} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={currentPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={currentPage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
        <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Purchase Details</DialogTitle>
            </DialogHeader>
            {selected && (
              <div className="grid gap-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span>{new Date(selected.createdAt).toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Product</span><span>{toTitleCase(selected.productName || "")}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Quantity</span><span>{selected.quantity}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Unit Cost</span><span>{formatCurrency(Number(selected.unitCost || 0))}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Total</span><span>{formatCurrency(Number(selected.total || 0))}</span></div>
                {selected.supplier ? (<div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span>{selected.supplier}</span></div>) : null}
                {selected.note ? (<div className="flex justify-between"><span className="text-muted-foreground">Note</span><span>{selected.note}</span></div>) : null}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export default function AdminPurchasesPage() {
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader>
            <CardTitle>Purchases</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Loading purchases…</p>
          </CardContent>
        </Card>
      }
    >
      <AdminPurchasesContent />
    </Suspense>
  );
}




