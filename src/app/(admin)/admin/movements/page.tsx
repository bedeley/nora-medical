"use client";

export const dynamic = "force-dynamic";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Info } from "lucide-react";

type Product = { id: string; name: string };

type MovementRow = {
  id: string;
  productId: string;
  productName: string;
  delta: number;
  reason: string;
  supplier?: string | null;
  unitCost?: number | string | null;
  createdAt: string | Date;
};

function AdminMovementsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);

  const [filters, setFilters] = useState({ start: "", end: "", product: "", reason: "" });
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<MovementRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(50);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<MovementRow | null>(null);
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams.toString());
    setFilters({
      start: sp.get("start") || "",
      end: sp.get("end") || "",
      product: sp.get("product") || "",
      reason: sp.get("reason") || "",
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
    if (filters.product) params.set("product", filters.product);
    else params.delete("product");
    if (filters.reason) params.set("reason", filters.reason);
    else params.delete("reason");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [filters, pathname, router]);

  async function fetchProducts() {
    try {
      const res = await fetch(`/api/products?pageSize=200&includeArchived=1`);
      const data = await res.json();
      const list: Product[] = (data.items || []).map(
        (p: { id: string; name: string }) => ({ id: p.id, name: p.name })
      );
      setProducts(list);
    } catch {}
  }

  const fetchMovements = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.product) params.append("product", filters.product);
      if (filters.reason) params.append("reason", filters.reason);
      const res = await fetch(`/api/admin/movements?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load movements");
      const data = await res.json();
      setRows((data.items || []) as MovementRow[]);
      setPage(1);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchProducts();
    fetchMovements();
  }, [fetchMovements]);

  const net = useMemo(() => rows.reduce((s, r) => s + Number(r.delta || 0), 0), [rows]);
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
    if (filters.product) params.append("product", filters.product);
    if (filters.reason) params.append("reason", filters.reason);
    params.append("format", "csv");
    const res = await fetch(`/api/admin/movements?${params.toString()}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `movements_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1 text-center sm:text-left w-full sm:w-auto">
          <CardTitle>Inventory Movements</CardTitle>
          <p className="text-sm text-muted-foreground">Audit restocks and sales by product and time</p>
        </div>
        <div className="flex w-full sm:w-auto justify-center sm:justify-end">
          <Button className="w-full sm:w-auto" variant="outline" onClick={handleExport}>Export CSV</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <Label htmlFor="start">Start date</Label>
            <Input id="start" type="date" value={filters.start} onChange={(e) => setFilters({ ...filters, start: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="end">End date</Label>
            <Input id="end" type="date" value={filters.end} onChange={(e) => setFilters({ ...filters, end: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="product">Product</Label>
            <select
              id="product"
              className="border rounded-md h-9 w-full bg-background"
              value={filters.product}
              onChange={(e) => setFilters({ ...filters, product: e.target.value })}
            >
              <option value="">All products</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="reason">Reason</Label>
            <Input id="reason" value={filters.reason} onChange={(e) => setFilters({ ...filters, reason: e.target.value })} placeholder="e.g., PURCHASE, SALE" />
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
            Net:{" "}
            <span
              className={`font-medium ${
                net >= 0 ? "text-green-600" : "text-red-600"
              }`}
            >
              {net}
            </span>
          </p>
        </div>

        <div className="md:hidden space-y-3">
          {rows.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              No movements found
            </div>
          ) : (
            paginatedRows.map((r) => (
              <div key={r.id} className="rounded-lg border p-4 shadow-sm space-y-3">
                <div className="flex justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold break-words">{r.productName}</p>
                    <p className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="View details"
                    title="View details"
                    onClick={() => { setSelected(r); setOpen(true); }}
                  >
                    <Info className="w-4 h-4" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs uppercase">Delta</p>
                    <p className={`font-semibold ${r.delta >= 0 ? 'text-green-600' : 'text-red-600'}`}>{r.delta}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-muted-foreground text-xs uppercase">Reason</p>
                    <p className="font-medium">{r.reason}</p>
                  </div>
                  {r.unitCost != null ? (
                    <div>
                      <p className="text-muted-foreground text-xs uppercase">Unit Cost</p>
                      <p className="font-medium">{Number(r.unitCost).toFixed(2)}</p>
                    </div>
                  ) : null}
                  {r.supplier ? (
                    <div className="text-right">
                      <p className="text-muted-foreground text-xs uppercase">Supplier</p>
                      <p className="font-medium">{r.supplier}</p>
                    </div>
                  ) : null}
                </div>
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
                <th className="p-2 border text-right">Delta</th>
                <th className="p-2 border">Reason</th>
                <th className="p-2 border">Supplier</th>
                <th className="p-2 border text-right">Unit Cost</th>
                <th className="p-2 border text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-4 text-center text-muted-foreground">No movements found</td>
                </tr>
              ) : (
                paginatedRows.map((r) => (
                  <tr
                    key={r.id}
                    className="odd:bg-background even:bg-muted/40 hover:bg-accent/60 cursor-pointer"
                    onClick={() => { setSelected(r); setOpen(true); }}
                    title="View details"
                  >
                    <td className="p-2 border">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="p-2 border">{r.productName}</td>
                    <td className={`p-2 border text-right ${r.delta >= 0 ? 'text-green-600' : 'text-red-600'}`}>{r.delta}</td>
                    <td className="p-2 border">{r.reason}</td>
                    <td className="p-2 border">{r.supplier || ''}</td>
                    <td className="p-2 border text-right">{r.unitCost == null ? '' : Number(r.unitCost).toFixed(2)}</td>
                    <td className="p-2 border text-right" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="View details"
                        title="View details"
                        onClick={() => { setSelected(r); setOpen(true); }}
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
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Movement Details</DialogTitle>
            </DialogHeader>
            {selected && (
              <div className="grid gap-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span>{new Date(selected.createdAt).toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Product</span><span>{selected.productName}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Delta</span><span className={selected.delta >= 0 ? 'text-green-600' : 'text-red-600'}>{selected.delta}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Reason</span><span>{selected.reason}</span></div>
                {selected.supplier ? (<div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span>{selected.supplier}</span></div>) : null}
                {selected.unitCost != null ? (<div className="flex justify-between"><span className="text-muted-foreground">Unit Cost</span><span>{Number(selected.unitCost).toFixed(2)}</span></div>) : null}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

export default function AdminMovementsPage() {
  return (
    <Suspense
      fallback={
        <Card>
          <CardHeader>
            <CardTitle>Inventory Movements</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Loading movements…</p>
          </CardContent>
        </Card>
      }
    >
      <AdminMovementsContent />
    </Suspense>
  );
}
