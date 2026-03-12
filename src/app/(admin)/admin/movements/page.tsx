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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Info } from "lucide-react";
import { toast } from "sonner";
import { chipToneClass } from "@/lib/status-chips";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";

type Product = { id: string; name: string; sku?: string | null };

type MovementRow = {
  id: string;
  productId: string;
  productName: string;
  productSku?: string | null;
  delta: number;
  reason: string;
  note?: string | null;
  supplier?: string | null;
  unitCost?: number | string | null;
  lotCode?: string | null;
  expiryDate?: string | Date | null;
  createdAt: string | Date;
};

function AdminMovementsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);

  const [filters, setFilters] = useState({ start: "", end: "", product: "", reason: "", lotId: "" });
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<MovementRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(50);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<MovementRow | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showSupplierCol, setShowSupplierCol] = useState(true);
  const [showUnitCostCol, setShowUnitCostCol] = useState(true);
  const [showLotCol, setShowLotCol] = useState(true);
  const [showExpiryCol, setShowExpiryCol] = useState(true);

  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams.toString());
    setFilters({
      start: sp.get("start") || "",
      end: sp.get("end") || "",
      product: sp.get("product") || "",
      reason: sp.get("reason") || "",
      lotId: sp.get("lotId") || "",
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
    if (filters.lotId) params.set("lotId", filters.lotId);
    else params.delete("lotId");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [filters, pathname, router]);

  async function fetchProducts() {
    try {
      const res = await fetch(`/api/products?pageSize=200&includeArchived=1`);
      const data = await res.json();
      const list: Product[] = (data.items || []).map(
        (p: { id: string; name: string; sku?: string | null }) => ({
          id: p.id,
          name: p.name,
          sku: p.sku ?? null,
        })
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
      if (filters.lotId) params.append("lotId", filters.lotId);
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
  const totals = useMemo(() => {
    let totalIn = 0;
    let totalOut = 0;
    rows.forEach((r) => {
      const delta = Number(r.delta || 0);
      if (delta >= 0) totalIn += delta;
      else totalOut += Math.abs(delta);
    });
    return { totalIn, totalOut };
  }, [rows]);
  const tableColSpan = 6
    + (showSupplierCol ? 1 : 0)
    + (showUnitCostCol ? 1 : 0)
    + (showLotCol ? 1 : 0)
    + (showExpiryCol ? 1 : 0);
  const reasonFilter = filters.reason.trim().toUpperCase();
  const reasonBadge = (reason: string) => {
    const upper = reason.toUpperCase();
    if (upper.includes("PURCHASE")) return chipToneClass("success");
    if (upper.includes("SALE")) return chipToneClass("danger");
    if (upper.includes("RETURN")) return chipToneClass("info");
    if (upper.includes("ADJUST")) return chipToneClass("warning");
    return chipToneClass("neutral");
  };
  const totalPages = Math.max(1, Math.ceil((rows.length || 0) / pageSize));
  const currentPage = Math.min(page, totalPages);
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
      toast.error("Select at least one movement to export.");
      return;
    }
    const header = ["Date", "Product", "SKU", "Delta", "Reason", "Supplier", "Unit Cost", "Lot", "Expiry"];
    const lines = [header.join(",")];
    for (const r of selectedRows) {
      lines.push([
        JSON.stringify(new Date(r.createdAt).toISOString()),
        JSON.stringify(r.productName || ""),
        JSON.stringify(r.productSku || ""),
        String(Number(r.delta || 0)),
        JSON.stringify(r.reason || ""),
        JSON.stringify(r.supplier || ""),
        r.unitCost == null ? "" : Number(r.unitCost).toFixed(2),
        JSON.stringify(r.lotCode || ""),
        r.expiryDate ? new Date(r.expiryDate).toISOString().slice(0, 10) : "",
      ].join(","));
    }
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const filename = `movements_${Date.now()}.csv`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "movements",
      format: "CSV",
      fileName: filename,
      rowCount: selectedRows.length,
      columnCount: header.length,
      byteSize: blob.size,
      scopeSnapshot: "Selected movement rows export",
    });
  };

  const handleExport = async () => {
    const params = new URLSearchParams();
    if (filters.start) params.append("start", filters.start);
    if (filters.end) params.append("end", filters.end);
    if (filters.product) params.append("product", filters.product);
    if (filters.reason) params.append("reason", filters.reason);
    if (filters.lotId) params.append("lotId", filters.lotId);
    params.append("format", "csv");
    const res = await fetch(`/api/admin/movements?${params.toString()}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const link = document.createElement("a");
    const filename = `movements_${Date.now()}.csv`;
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    void logAdminExportDownload({
      area: "movements",
      format: "CSV",
      fileName: filename,
      byteSize: blob.size,
      scopeSnapshot: `Start: ${filters.start || "-"} | End: ${filters.end || "-"} | Product: ${filters.product || "-"} | Reason: ${filters.reason || "-"}`,
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1 text-center sm:text-left w-full sm:w-auto">
          <CardTitle className="text-base font-semibold">Inventory Movements</CardTitle>
          <p className="text-sm text-muted-foreground">Audit restocks and sales by product and time</p>
        </div>
        <div className="flex w-full sm:w-auto justify-center sm:justify-end">
          <Button className="w-full sm:w-auto" variant="outline" onClick={handleExport}>
            Export CSV (filtered)
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
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
                <option key={p.id} value={p.id}>
                  {p.name}{p.sku ? ` - ${p.sku}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="reason">Reason</Label>
            <Input id="reason" value={filters.reason} onChange={(e) => setFilters({ ...filters, reason: e.target.value })} placeholder="e.g., PURCHASE, SALE" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {filters.lotId ? (
            <div className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs">
              <span className="text-muted-foreground">Lot filter:</span>
              <span className="font-mono">{filters.lotId}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2"
                onClick={() => setFilters((prev) => ({ ...prev, lotId: "" }))}
              >
                Clear
              </Button>
            </div>
          ) : null}
          <span className="text-muted-foreground text-xs">Quick filters</span>
          <Button
            type="button"
            size="sm"
            variant={reasonFilter === "" ? "default" : "outline"}
            onClick={() => setFilters((prev) => ({ ...prev, reason: "" }))}
          >
            All
          </Button>
          <Button
            type="button"
            size="sm"
            variant={reasonFilter.includes("PURCHASE") ? "default" : "outline"}
            onClick={() => setFilters((prev) => ({ ...prev, reason: "PURCHASE" }))}
          >
            Purchases
          </Button>
          <Button
            type="button"
            size="sm"
            variant={reasonFilter.includes("SALE") ? "default" : "outline"}
            onClick={() => setFilters((prev) => ({ ...prev, reason: "SALE" }))}
          >
            Sales
          </Button>
          <Button
            type="button"
            size="sm"
            variant={reasonFilter.includes("RETURN") ? "default" : "outline"}
            onClick={() => setFilters((prev) => ({ ...prev, reason: "RETURN" }))}
          >
            Returns
          </Button>
          <Button
            type="button"
            size="sm"
            variant={reasonFilter.includes("ADJUST") ? "default" : "outline"}
            onClick={() => setFilters((prev) => ({ ...prev, reason: "ADJUSTMENT" }))}
          >
            Adjustments
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setFilters({ start: "", end: "", product: "", reason: "", lotId: "" })}
          >
            Clear filters
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Total in</div>
            <div className="text-lg font-semibold text-emerald-700">{totals.totalIn}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Total out</div>
            <div className="text-lg font-semibold text-rose-700">{totals.totalOut}</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Net</div>
            <div className={`text-lg font-semibold ${net >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
              {net}
            </div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Movements</div>
            <div className="text-lg font-semibold">{rows.length}</div>
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
                  checked={showUnitCostCol}
                  onCheckedChange={(value) => setShowUnitCostCol(Boolean(value))}
                >
                  Unit Cost
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  onSelect={(event) => event.preventDefault()}
                  checked={showLotCol}
                  onCheckedChange={(value) => setShowLotCol(Boolean(value))}
                >
                  Lot
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  onSelect={(event) => event.preventDefault()}
                  checked={showExpiryCol}
                  onCheckedChange={(value) => setShowExpiryCol(Boolean(value))}
                >
                  Expiry
                </DropdownMenuCheckboxItem>
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

        <div className="lg:hidden space-y-3">
          {rows.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              <p>No movements found for the current filters.</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
            onClick={() => setFilters({ start: "", end: "", product: "", reason: "", lotId: "" })}
                >
                  Clear filters
                </Button>
                <Button size="sm" variant="outline" onClick={handleExport}>
                  Export CSV
                </Button>
              </div>
            </div>
          ) : (
            paginatedRows.map((r) => (
              <div key={r.id} className="rounded-lg border p-4 shadow-sm space-y-3">
                <div className="flex justify-between gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 mt-1"
                    checked={selectedIds.has(r.id)}
                    onChange={() => toggleSelected(r.id)}
                    aria-label={`Select movement ${r.id}`}
                  />
                  <div>
                    <p className="text-sm font-semibold break-words">{r.productName}</p>
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
                    <p className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${reasonBadge(r.reason)}`}>
                      {r.reason}
                    </p>
                  </div>
                  {showUnitCostCol && r.unitCost != null ? (
                    <div>
                      <p className="text-muted-foreground text-xs uppercase">Unit Cost</p>
                      <p className="font-medium">{Number(r.unitCost).toFixed(2)}</p>
                    </div>
                  ) : null}
                  {showLotCol && r.lotCode ? (
                    <div>
                      <p className="text-muted-foreground text-xs uppercase">Lot</p>
                      <p className="font-medium">{r.lotCode}</p>
                    </div>
                  ) : null}
                  {showExpiryCol && r.expiryDate ? (
                    <div>
                      <p className="text-muted-foreground text-xs uppercase">Expiry</p>
                      <p className="font-medium">
                        {new Date(r.expiryDate).toLocaleDateString()}
                      </p>
                    </div>
                  ) : null}
                  {showSupplierCol && r.supplier ? (
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

        <div className="overflow-x-auto hidden lg:block">
          <table className="w-full text-sm border-collapse border border-gray-200 dark:border-gray-800">
            <thead className="bg-muted text-left">
              <tr>
                <th className="p-2 border w-[36px] text-center">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    aria-label="Select all visible movements"
                  />
                </th>
                <th className="p-2 border">Date</th>
                <th className="p-2 border">Product</th>
                <th className="p-2 border text-right">Delta</th>
                <th className="p-2 border">Reason</th>
                {showSupplierCol && <th className="p-2 border">Supplier</th>}
                {showUnitCostCol && <th className="p-2 border text-right">Unit Cost</th>}
                {showLotCol && <th className="p-2 border">Lot</th>}
                {showExpiryCol && <th className="p-2 border">Expiry</th>}
                <th className="p-2 border text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={tableColSpan} className="p-6 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-3">
                      <span>No movements found for the current filters.</span>
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                        onClick={() => setFilters({ start: "", end: "", product: "", reason: "", lotId: "" })}
                        >
                          Clear filters
                        </Button>
                        <Button size="sm" variant="outline" onClick={handleExport}>
                          Export CSV
                        </Button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                paginatedRows.map((r) => (
                  <tr
                    key={r.id}
                    className="odd:bg-background even:bg-muted/40 hover:bg-accent/60 cursor-pointer"
                    onClick={() => { setSelected(r); setOpen(true); }}
                    title="View details"
                  >
                    <td className="p-2 border text-center" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={selectedIds.has(r.id)}
                        onChange={() => toggleSelected(r.id)}
                        aria-label={`Select movement ${r.id}`}
                      />
                    </td>
                    <td className="p-2 border">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="p-2 border">
                      <div className="space-y-0.5">
                        <div>{r.productName}</div>
                        {r.productSku ? (
                          <div className="text-xs text-muted-foreground">SKU: {r.productSku}</div>
                        ) : null}
                      </div>
                    </td>
                    <td className={`p-2 border text-right ${r.delta >= 0 ? 'text-green-600' : 'text-red-600'}`}>{r.delta}</td>
                    <td className="p-2 border">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${reasonBadge(r.reason)}`}>
                        {r.reason}
                      </span>
                    </td>
                    {showSupplierCol && <td className="p-2 border">{r.supplier || ""}</td>}
                    {showUnitCostCol && (
                      <td className="p-2 border text-right">
                        {r.unitCost == null ? "" : Number(r.unitCost).toFixed(2)}
                      </td>
                    )}
                    {showLotCol && <td className="p-2 border">{r.lotCode || ""}</td>}
                    {showExpiryCol && (
                      <td className="p-2 border">
                        {r.expiryDate ? new Date(r.expiryDate).toLocaleDateString() : ""}
                      </td>
                    )}
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
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Movement Details</DialogTitle>
            </DialogHeader>
            {selected && (
              <div className="grid gap-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span>{new Date(selected.createdAt).toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Product</span><span>{selected.productName}</span></div>
                {selected.productSku ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">SKU</span><span>{selected.productSku}</span></div>
                ) : null}
                <div className="flex justify-between"><span className="text-muted-foreground">Delta</span><span className={selected.delta >= 0 ? 'text-green-600' : 'text-red-600'}>{selected.delta}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Reason</span><span>{selected.reason}</span></div>
                {selected.note ? (
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Detail</span>
                    <span className="text-right">{selected.note}</span>
                  </div>
                ) : null}
                {selected.lotCode ? (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Lot</span>
                    <span>{selected.lotCode}</span>
                  </div>
                ) : null}
                {selected.expiryDate ? (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Expiry</span>
                    <span>{new Date(selected.expiryDate).toLocaleDateString()}</span>
                  </div>
                ) : null}
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
    <section className="container mx-auto py-8">
      <Suspense
        fallback={
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold">Inventory Movements</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Loading movements…</p>
            </CardContent>
          </Card>
        }
      >
        <AdminMovementsContent />
      </Suspense>
    </section>
  );
}
