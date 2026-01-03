"use client";

export const dynamic = "force-dynamic";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Info } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";

// Title-case helper: capitalizes first letter of each word
function toTitleCase(str: string) {
  return String(str || "").replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function formatCategoryLabel(category?: string | null) {
  if (!category) return "";
  return toTitleCase(category.replace(/-/g, " "));
}

type Product = {
  id: string;
  name: string;
  sku?: string | null;
  category?: string | null;
  brand?: string | null;
};

type PurchaseRow = {
  id: string;
  productId: string;
  productName: string;
  productSku?: string | null;
  quantity: number;
  unitCost: number;
  total: number;
  supplier?: string | null;
  reason?: string | null;
  note?: string | null;
  createdAt: string | Date;
};

type PurchasesSavedFilter = {
  id: string;
  name: string;
  state: {
    start: string;
    end: string;
    supplier: string;
    q: string;
    product: string;
    pageSize: 25 | 50 | 100;
    showSupplierCol: boolean;
    showReasonCol: boolean;
    showNoteCol: boolean;
  };
};

function AdminPurchasesContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);

  const [filters, setFilters] = useState({ start: "", end: "", supplier: "", q: "", product: "" });
  const [filtersReady, setFiltersReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(50);
  const [products, setProducts] = useState<Product[]>([]);
  const [form, setForm] = useState({
    productId: "",
    quantity: "",
    unitCost: "",
    supplier: "",
    reason: "",
    note: "",
  });
  const [currentCost, setCurrentCost] = useState<number | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [selected, setSelected] = useState<PurchaseRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<{ productId?: string; quantity?: string; unitCost?: string }>({});
  const [updatedAtText, setUpdatedAtText] = useState<string>("");
  const lastFormProductId = useRef<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showSupplierCol, setShowSupplierCol] = useState(true);
  const [showReasonCol, setShowReasonCol] = useState(true);
  const [showNoteCol, setShowNoteCol] = useState(true);
  const [savedFilters, setSavedFilters] = useState<PurchasesSavedFilter[]>([]);
  const resizing = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    select: 44,
    date: 170,
    product: 240,
    qty: 90,
    unitCost: 120,
    total: 120,
    supplier: 160,
    reason: 200,
    note: 220,
    actions: 80,
  });

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
    setFiltersReady(true);
  }, [searchParams]);

  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams();
    if (filters.start) params.set("start", filters.start); else params.delete("start");
    if (filters.end) params.set("end", filters.end); else params.delete("end");
    if (filters.supplier) params.set("supplier", filters.supplier); else params.delete("supplier");
    if (filters.q) params.set("q", filters.q); else params.delete("q");
    if (filters.product) params.set("product", filters.product); else params.delete("product");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [filters, pathname, router]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-purchases-saved-filters");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as PurchasesSavedFilter[];
      if (Array.isArray(parsed)) setSavedFilters(parsed);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "admin-purchases-saved-filters",
      JSON.stringify(savedFilters),
    );
  }, [savedFilters]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-purchases-column-widths");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (parsed && typeof parsed === "object") {
        setColumnWidths((prev) => ({ ...prev, ...parsed }));
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "admin-purchases-column-widths",
      JSON.stringify(columnWidths),
    );
  }, [columnWidths]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizing.current) return;
      const { key, startX, startWidth } = resizing.current;
      const delta = event.clientX - startX;
      const next = Math.max(90, startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [key]: next }));
    };
    const handleUp = () => {
      if (!resizing.current) return;
      resizing.current = null;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, []);

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === form.productId) ?? null,
    [products, form.productId],
  );

  const startResize = (key: string, event: React.MouseEvent) => {
    event.preventDefault();
    resizing.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key] ?? 120,
    };
    document.body.style.cursor = "col-resize";
  };

  const fetchProducts = useCallback(async () => {
    try {
      const res = await fetch(`/api/products?pageSize=200&includeArchived=1`);
      const data = await res.json();
      const list: Product[] = (data.items || []).map((p: { id: string; name: string; sku?: string | null; category?: string | null; brand?: string | null }) => ({
        id: p.id,
        name: p.name,
        sku: p.sku ?? null,
        category: p.category ?? null,
        brand: p.brand ?? null,
      }));
      setProducts(list);
    } catch {}
  }, []);

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
    if (!filtersReady) return;
    fetchProducts();
    fetchPurchases();
  }, [fetchProducts, fetchPurchases, filtersReady]);

  useEffect(() => {
    if (!rows.length) return;
    setUpdatedAtText(new Date().toLocaleString());
  }, [rows.length]);

  // Preselect product from URL if provided
  useEffect(() => {
    const sp = new URLSearchParams(searchParams.toString());
    const pid = sp.get("product");
    if (pid) setForm((f) => ({ ...f, productId: pid }));
  }, [searchParams]);

  // Keep the purchases filter in sync with the selected product,
  // but only when the filter is empty or was previously synced.
  useEffect(() => {
    const next = form.productId;
    if (!initialized.current) return;
    if (!next) {
      if (filters.product && filters.product === lastFormProductId.current) {
        setFilters((prev) => ({ ...prev, product: "" }));
      }
      lastFormProductId.current = "";
      return;
    }
    if (!filters.product || filters.product === lastFormProductId.current) {
      setFilters((prev) => ({ ...prev, product: next }));
    }
    lastFormProductId.current = next;
  }, [form.productId, filters.product]);

  // If the filter is cleared to "All products", clear the form product
  // when it was previously synced to avoid stale selections.
  useEffect(() => {
    if (!initialized.current) return;
    if (!filters.product && form.productId && form.productId === lastFormProductId.current) {
      setForm((prev) => ({ ...prev, productId: "" }));
      lastFormProductId.current = "";
    }
  }, [filters.product, form.productId]);

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
  const avgUnitCost = totals.qty > 0 ? totals.value / totals.qty : 0;
  const topSuppliers = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row) => {
      const supplier = String(row.supplier || "").trim();
      if (!supplier) return;
      map.set(supplier, (map.get(supplier) || 0) + 1);
    });
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([supplier]) => supplier);
  }, [rows]);
  const tableColSpan = 7
    + (showSupplierCol ? 1 : 0)
    + (showReasonCol ? 1 : 0)
    + (showNoteCol ? 1 : 0);

  const totalPages = Math.max(1, Math.ceil((rows.length || 0) / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visiblePages = useMemo(() => {
    const start = Math.max(1, currentPage - 2);
    const end = Math.min(totalPages, start + 4);
    const pages: number[] = [];
    for (let p = start; p <= end; p += 1) pages.push(p);
    return pages;
  }, [currentPage, totalPages]);
  const paginatedRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, currentPage, pageSize]);

  const visibleIds = paginatedRows.map((r) => r.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const selectedCount = selectedIds.size;

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        visibleIds.forEach((id) => next.delete(id));
      } else {
        visibleIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const exportSelected = () => {
    const selectedRows = rows.filter((r) => selectedIds.has(r.id));
    if (selectedRows.length === 0) {
      toast.error("Select at least one purchase to export.");
      return;
    }
    const header = ["Date", "Product", "SKU", "Qty", "Unit Cost", "Total", "Supplier", "Reason", "Note"];
    const lines = [header.join(",")];
    for (const r of selectedRows) {
      lines.push([
        JSON.stringify(new Date(r.createdAt).toISOString()),
        JSON.stringify(r.productName || ""),
        JSON.stringify(r.productSku || ""),
        String(r.quantity),
        Number(r.unitCost || 0).toFixed(2),
        Number(r.total || 0).toFixed(2),
        JSON.stringify(r.supplier || ""),
        JSON.stringify(r.reason || ""),
        JSON.stringify(r.note || ""),
      ].join(","));
    }
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `purchases_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const saveCurrentFilter = () => {
    const name = window.prompt("Name this saved filter");
    if (!name) return;
    const entry: PurchasesSavedFilter = {
      id: `${Date.now()}`,
      name,
      state: {
        start: filters.start,
        end: filters.end,
        supplier: filters.supplier,
        q: filters.q,
        product: filters.product,
        pageSize,
        showSupplierCol,
        showReasonCol,
        showNoteCol,
      },
    };
    setSavedFilters((prev) => [entry, ...prev]);
    toast.success("Saved filter");
  };

  const applySavedFilter = (entry: PurchasesSavedFilter) => {
    const s = entry.state;
    setFilters({
      start: s.start,
      end: s.end,
      supplier: s.supplier,
      q: s.q,
      product: s.product,
    });
    setPageSize(s.pageSize);
    setShowSupplierCol(s.showSupplierCol);
    setShowReasonCol(s.showReasonCol);
    setShowNoteCol(s.showNoteCol);
    setPage(1);
    toast.success(`Applied "${entry.name}"`);
  };

  const removeSavedFilter = (id: string) => {
    setSavedFilters((prev) => prev.filter((f) => f.id !== id));
  };

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
    const nextErrors: { productId?: string; quantity?: string; unitCost?: string } = {};
    const qty = Number(form.quantity);
    const unitCost = Number(form.unitCost);
    if (!form.productId) nextErrors.productId = "Select a product.";
    if (!form.quantity.trim() || !Number.isFinite(qty) || qty <= 0) {
      nextErrors.quantity = "Enter a valid quantity.";
    }
    if (!form.unitCost.trim() || !Number.isFinite(unitCost) || unitCost <= 0) {
      nextErrors.unitCost = "Enter a valid unit cost.";
    }
    if (Object.values(nextErrors).some(Boolean)) {
      setFormErrors(nextErrors);
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/admin/purchases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: form.productId,
          quantity: Number(form.quantity),
          unitCost: Number(form.unitCost),
          supplier: form.supplier.trim() || undefined,
          reason: form.reason.trim() || undefined,
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
      setForm({ productId: "", quantity: "", unitCost: "", supplier: "", reason: "", note: "" });
      setFormErrors({});
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
          <CardTitle className="text-base font-semibold">Purchases</CardTitle>
          <p className="text-sm text-muted-foreground">Record restocks and update weighted-average cost</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <Button className="w-full sm:w-auto" variant="outline" onClick={handleExport}>Export CSV</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <div className="mb-2 p-2 rounded-md bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}
        <div className="rounded-md border bg-background p-4 lg:sticky lg:top-6 lg:z-10">
          <form id="purchase-form" onSubmit={submitPurchase} className="grid md:grid-cols-6 gap-3 items-end">
            <div>
              <Label htmlFor="product">Product</Label>
              <select
                id="product"
                className={`border rounded-md h-9 w-full bg-background capitalize ${formErrors.productId ? "border-red-500" : ""}`}
                value={form.productId}
                onChange={(e) => {
                  setForm({ ...form, productId: e.target.value });
                  if (formErrors.productId) {
                    setFormErrors((prev) => ({ ...prev, productId: "" }));
                  }
                }}
                required
                aria-invalid={!!formErrors.productId}
              >
                <option value="">Select a product</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {toTitleCase(p.name || "")}{p.sku ? ` - ${p.sku}` : ""}
                  </option>
                ))}
              </select>
              {formErrors.productId && <p className="mt-1 text-xs text-red-600">{formErrors.productId}</p>}
            </div>
            <div>
              <Label htmlFor="qty">Quantity</Label>
              <Input
                id="qty"
                type="number"
                min="1"
                value={form.quantity}
                onChange={(e) => {
                  setForm({ ...form, quantity: e.target.value });
                  if (formErrors.quantity) {
                    setFormErrors((prev) => ({ ...prev, quantity: "" }));
                  }
                }}
                required
                aria-invalid={!!formErrors.quantity}
                className={formErrors.quantity ? "border-red-500" : ""}
              />
              {formErrors.quantity && <p className="mt-1 text-xs text-red-600">{formErrors.quantity}</p>}
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
                onChange={(e) => {
                  setForm({ ...form, unitCost: e.target.value });
                  if (formErrors.unitCost) {
                    setFormErrors((prev) => ({ ...prev, unitCost: "" }));
                  }
                }}
                required
                aria-invalid={!!formErrors.unitCost}
                className={formErrors.unitCost ? "border-red-500" : ""}
              />
              {formErrors.unitCost && <p className="mt-1 text-xs text-red-600">{formErrors.unitCost}</p>}
            </div>
            <div>
              <Label htmlFor="supplier">Supplier</Label>
              <Input id="supplier" value={form.supplier}
                onChange={(e) => setForm({ ...form, supplier: e.target.value })} placeholder="Optional" />
            </div>
            <div>
              <Label htmlFor="reason">Reason</Label>
              <Input
                id="reason"
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="Optional"
              />
            </div>
            <div>
              <Label htmlFor="note">Note</Label>
              <Input id="note" value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Optional" />
            </div>
            <div className="md:col-span-6">
              <Button type="submit">Add Purchase</Button>
            </div>
            {selectedProduct ? (
              <div className="md:col-span-6 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                {selectedProduct.category ? (
                  <span className="rounded-full border px-2 py-0.5">
                    Category: {formatCategoryLabel(selectedProduct.category)}
                  </span>
                ) : null}
                {selectedProduct.brand ? (
                  <span className="rounded-full border px-2 py-0.5">
                    Brand: {selectedProduct.brand}
                  </span>
                ) : null}
              </div>
            ) : null}
          </form>
        </div>

        <div className="grid sm:grid-cols-2 md:grid-cols-6 gap-3">
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
              onChange={(e) => {
                const next = e.target.value;
                setFilters({ ...filters, product: next });
                if (!next) {
                  setForm((prev) => ({ ...prev, productId: "" }));
                  lastFormProductId.current = "";
                }
              }}
            >
              <option value="">All products</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {toTitleCase(p.name || "")}{p.sku ? ` - ${p.sku}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="q">Search note/reason</Label>
            <Input id="q" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
          </div>
          <div className="flex flex-wrap items-end gap-2 md:col-span-2">
            <div className="text-xs text-muted-foreground">Top suppliers</div>
            {topSuppliers.length === 0 ? (
              <span className="text-xs text-muted-foreground">None</span>
            ) : (
              topSuppliers.map((supplier) => (
                <Button
                  key={supplier}
                  type="button"
                  size="sm"
                  variant={filters.supplier === supplier ? "default" : "outline"}
                  onClick={() => setFilters((prev) => ({ ...prev, supplier }))}
                >
                  {supplier}
                </Button>
              ))
            )}
            {filters.supplier ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setFilters((prev) => ({ ...prev, supplier: "" }))}
              >
                Clear
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setFilters({ start: "", end: "", supplier: "", q: "", product: "" });
                setPage(1);
                setForm((prev) => ({ ...prev, productId: "" }));
                lastFormProductId.current = "";
              }}
            >
              Clear filters
            </Button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Purchases</div>
            <div className="text-lg font-semibold">{rows.length}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Total qty</div>
            <div className="text-lg font-semibold">{totals.qty}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Total value</div>
            <div className="text-lg font-semibold">{formatCurrency(totals.value)}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Avg unit cost</div>
            <div className="text-lg font-semibold">{totals.qty ? formatCurrency(avgUnitCost) : "-"}</div>
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
            {updatedAtText ? (
              <>
                <span className="hidden sm:inline">•</span>
                <span>Last updated {updatedAtText}</span>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">Columns</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem
                  onSelect={(event) => event.preventDefault()}
                  checked={showSupplierCol}
                  onCheckedChange={(value) => setShowSupplierCol(Boolean(value))}
                >
                  Supplier
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">Saved filters</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={saveCurrentFilter}>
                  Save current filter
                </DropdownMenuItem>
                {savedFilters.length === 0 ? (
                  <DropdownMenuItem disabled>No saved filters</DropdownMenuItem>
                ) : (
                  savedFilters.map((entry) => (
                    <DropdownMenuItem key={entry.id} className="flex items-center justify-between gap-4">
                      <button
                        type="button"
                        className="text-left"
                        onClick={() => applySavedFilter(entry)}
                      >
                        {entry.name}
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeSavedFilter(entry.id);
                        }}
                      >
                        Remove
                      </Button>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {selectedCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">{selectedCount} selected</span>
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                Clear
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={exportSelected}>
                Export CSV
              </Button>
            </div>
          </div>
        )}

        <div className="md:hidden space-y-3">
          {rows.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              <p>No purchases found for the current filters.</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setFilters({ start: "", end: "", supplier: "", q: "", product: "" })}
                >
                  Clear filters
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    const formEl = document.getElementById("purchase-form");
                    formEl?.scrollIntoView({ behavior: "smooth", block: "center" });
                  }}
                >
                  Add purchase
                </Button>
              </div>
            </div>
          ) : (
            paginatedRows.map((r) => (
              <div key={r.id} className="rounded-lg border p-4 shadow-sm space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 mt-1"
                    checked={selectedIds.has(r.id)}
                    onChange={() => toggleSelected(r.id)}
                    aria-label={`Select purchase ${r.id}`}
                  />
                  <div>
                    <p className="text-sm font-semibold">{toTitleCase(r.productName || "")}</p>
                    {r.productSku ? (
                      <p className="text-xs text-muted-foreground">SKU: {r.productSku}</p>
                    ) : null}
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
                {r.reason ? (
                  <p className="text-sm text-muted-foreground break-words">
                    <span className="font-medium text-foreground">Reason:</span> {r.reason}
                  </p>
                ) : null}
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
          <table className="w-full table-fixed text-sm border-collapse border border-gray-200 dark:border-gray-800 admin-purchases-table">
            <thead className="bg-muted text-left admin-purchases-head">
              <tr>
                <th className="p-2 border text-center relative" style={{ width: columnWidths.select }}>
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    aria-label="Select all visible purchases"
                  />
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("select", event)}
                  />
                </th>
                <th className="p-2 border relative" style={{ width: columnWidths.date }}>
                  Date
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("date", event)}
                  />
                </th>
                <th className="p-2 border relative" style={{ width: columnWidths.product }}>
                  Product
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("product", event)}
                  />
                </th>
                <th className="p-2 border text-right relative" style={{ width: columnWidths.qty }}>
                  Qty
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("qty", event)}
                  />
                </th>
                <th className="p-2 border text-right relative" style={{ width: columnWidths.unitCost }}>
                  Unit Cost
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("unitCost", event)}
                  />
                </th>
                <th className="p-2 border text-right relative" style={{ width: columnWidths.total }}>
                  Total
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("total", event)}
                  />
                </th>
                {showSupplierCol && (
                  <th className="p-2 border relative" style={{ width: columnWidths.supplier }}>
                    Supplier
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("supplier", event)}
                    />
                  </th>
                )}
                {showReasonCol && (
                  <th className="p-2 border relative" style={{ width: columnWidths.reason }} title="Why this purchase was made">
                    Reason
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("reason", event)}
                    />
                  </th>
                )}
                {showNoteCol && (
                  <th className="p-2 border relative" style={{ width: columnWidths.note }} title="Additional context or internal notes">
                    Note
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("note", event)}
                    />
                  </th>
                )}
                <th className="p-2 border text-right relative" style={{ width: columnWidths.actions }}>
                  Actions
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("actions", event)}
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={tableColSpan} className="p-6 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-3">
                      <span>No purchases found for the current filters.</span>
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setFilters({ start: "", end: "", supplier: "", q: "", product: "" })}
                        >
                          Clear filters
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => {
                            const formEl = document.getElementById("purchase-form");
                            formEl?.scrollIntoView({ behavior: "smooth", block: "center" });
                          }}
                        >
                          Add purchase
                        </Button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedRows.map((r) => (
                  <tr
                    key={r.id}
                    className="odd:bg-background even:bg-muted/40 hover:bg-accent/60"
                  >
                    <td className="p-2 border text-center">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={selectedIds.has(r.id)}
                        onChange={() => toggleSelected(r.id)}
                        aria-label={`Select purchase ${r.id}`}
                      />
                    </td>
                    <td className="p-2 border">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="p-2 border">
                      <div className="space-y-0.5">
                        <div>{toTitleCase(r.productName || "")}</div>
                        {r.productSku ? (
                          <div className="text-xs text-muted-foreground">SKU: {r.productSku}</div>
                        ) : null}
                      </div>
                    </td>
                    <td className="p-2 border text-right">{r.quantity}</td>
                    <td className="p-2 border text-right">{formatCurrency(Number(r.unitCost || 0))}</td>
                    <td className="p-2 border text-right">{formatCurrency(Number(r.total || 0))}</td>
                    {showSupplierCol && <td className="p-2 border">{r.supplier || ""}</td>}
                    {showReasonCol && <td className="p-2 border">{r.reason || ""}</td>}
                    {showNoteCol && <td className="p-2 border">{r.note || ""}</td>}
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
          <div className="flex flex-col gap-2 pt-2">
            <div className="text-xs text-muted-foreground">
              Page {currentPage} of {totalPages}
            </div>
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      if (currentPage > 1) setPage(currentPage - 1);
                    }}
                  />
                </PaginationItem>
                {visiblePages[0] && visiblePages[0] > 1 && (
                  <>
                    <PaginationItem>
                      <PaginationLink href="#" onClick={(e) => { e.preventDefault(); setPage(1); }}>
                        1
                      </PaginationLink>
                    </PaginationItem>
                    {visiblePages[0] > 2 && (
                      <PaginationItem>
                        <span className="px-2 text-muted-foreground">…</span>
                      </PaginationItem>
                    )}
                  </>
                )}
                {visiblePages.map((p) => (
                  <PaginationItem key={p}>
                    <PaginationLink
                      href="#"
                      isActive={p === currentPage}
                      onClick={(e) => { e.preventDefault(); setPage(p); }}
                    >
                      {p}
                    </PaginationLink>
                  </PaginationItem>
                ))}
                {visiblePages[visiblePages.length - 1] && visiblePages[visiblePages.length - 1] < totalPages && (
                  <>
                    {visiblePages[visiblePages.length - 1] < totalPages - 1 && (
                      <PaginationItem>
                        <span className="px-2 text-muted-foreground">…</span>
                      </PaginationItem>
                    )}
                    <PaginationItem>
                      <PaginationLink href="#" onClick={(e) => { e.preventDefault(); setPage(totalPages); }}>
                        {totalPages}
                      </PaginationLink>
                    </PaginationItem>
                  </>
                )}
                <PaginationItem>
                  <PaginationNext
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      if (currentPage < totalPages) setPage(currentPage + 1);
                    }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        )}
        <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Purchase Details</DialogTitle>
            </DialogHeader>
            {selected && (
              <div className="grid gap-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span>{new Date(selected.createdAt).toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Product</span><span>{toTitleCase(selected.productName || "")}</span></div>
                {selected.reason ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">Reason</span><span>{selected.reason}</span></div>
                ) : null}
                {selected.productSku ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">SKU</span><span>{selected.productSku}</span></div>
                ) : null}
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
    <section className="container mx-auto py-8">
      <Suspense
        fallback={
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold">Purchases</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Loading purchases…</p>
            </CardContent>
          </Card>
        }
      >
        <AdminPurchasesContent />
      </Suspense>
    </section>
  );
}




