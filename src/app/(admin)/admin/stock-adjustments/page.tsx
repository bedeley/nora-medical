"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/currency";

type ProductLite = {
  id: string;
  name: string;
  sku: string | null;
  stock: number;
  cost: number;
  requiresLotTracking?: boolean;
  requiresExpiryDate?: boolean;
};

type ProductResponse = {
  items: ProductLite[];
};

type AdjustmentRow = {
  id: string;
  productId: string;
  productName: string;
  productSku: string | null;
  delta: number;
  reason: string;
  reasonCode?: string | null;
  note: string | null;
  lotCode?: string | null;
  expiryDate?: string | null;
  unitCost: number;
  valueDelta: number;
  createdAt: string;
};

const ADJUSTMENT_REASON_CODES = [
  { value: "COUNT_VARIANCE", label: "Count variance" },
  { value: "DAMAGE", label: "Damaged" },
  { value: "EXPIRED", label: "Expired" },
  { value: "SHRINKAGE", label: "Shrinkage" },
  { value: "THEFT", label: "Theft" },
  { value: "OTHER", label: "Other" },
];

const REASON_CODE_LABEL = Object.fromEntries(
  ADJUSTMENT_REASON_CODES.map((r) => [r.value, r.label]),
) as Record<string, string>;

const REASON_TYPE_LABEL: Record<string, string> = {
  CYCLE_COUNT: "Cycle count",
  STOCK_ADJUSTMENT: "Stock adjustment",
};
const STOCK_ADJUSTMENTS_SOURCE_PAGE = "admin/stock-adjustments";
const STOCK_ADJUSTMENTS_AUDIT_HREF = "/admin/audit?sourcePage=admin%2Fstock-adjustments";

type AdjustmentResponse = {
  items: AdjustmentRow[];
  total: number;
  page: number;
  pageSize: number;
};

// Pending confirmation payload — captures full form state at dialog-open time
// so confirmAdjustment is self-contained and doesn't rely on component state.
type PendingAdjustment = {
  productId: string;
  productName: string;
  productSku: string | null;
  currentStock: number;
  countedStock: number;
  delta: number;
  valueDelta: number;
  reasonType: string;
  reasonCode: string;
  note: string;
  lotCode: string;
  expiryDate: string;
};

function deltaClass(delta: number) {
  if (delta > 0) return "text-green-600 font-medium";
  if (delta < 0) return "text-red-600 font-medium";
  return "text-muted-foreground";
}

function exportToCsv(rows: AdjustmentRow[]) {
  const header = ["Date", "Product", "SKU", "Delta", "Unit Cost", "Value Impact", "Type", "Reason Code", "Lot", "Expiry", "Note"];
  const lines = rows.map((r) => [
    new Date(r.createdAt).toLocaleDateString("en-GH"),
    r.productName,
    r.productSku || "",
    String(r.delta),
    String(r.unitCost),
    String(r.valueDelta),
    REASON_TYPE_LABEL[r.reason] ?? r.reason,
    r.reasonCode ? (REASON_CODE_LABEL[r.reasonCode] ?? r.reasonCode) : "",
    r.lotCode || "",
    r.expiryDate ? new Date(r.expiryDate).toLocaleDateString("en-GH") : "",
    r.note || "",
  ].map((v) => `"${v.replace(/"/g, '""')}"`).join(","));
  const csv = [header.join(","), ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const fileName = `stock-adjustments-${new Date().toISOString().slice(0, 10)}.csv`;
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  return {
    fileName,
    rowCount: rows.length,
    columnCount: header.length,
    byteSize: blob.size,
  };
}

export default function StockAdjustmentsPage() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const requestedProductId = String(searchParams.get("productId") || "").trim();
  const requestedQuery = String(searchParams.get("q") || "").trim();

  const [search, setSearch] = useState(requestedQuery);
  const [selected, setSelected] = useState<ProductLite | null>(null);
  const [countedStock, setCountedStock] = useState("");
  const [reasonType, setReasonType] = useState("CYCLE_COUNT");
  const [reasonCode, setReasonCode] = useState("");
  const [note, setNote] = useState("");
  const [lotCode, setLotCode] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingAdjustment, setPendingAdjustment] = useState<PendingAdjustment | null>(null);

  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [typeFilter, setTypeFilter] = useState("adjustments");
  const [productFilter, setProductFilter] = useState<{ id: string; name: string } | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;

  const productParams = useMemo(() => {
    const sp = new URLSearchParams();
    if (search.trim()) sp.set("q", search.trim());
    sp.set("page", "1");
    sp.set("pageSize", "8");
    sp.set("includeArchived", "0");
    sp.set("startsWith", "1");
    return sp.toString();
  }, [search]);

  const { data: productData, isLoading: productsLoading } = useClientQuery<ProductResponse>({
    queryKey: ["admin", "stock-adjustments", "products", search],
    queryFn: () =>
      fetch(`/api/products?${productParams}`).then(async (r) => {
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((payload as { error?: string }).error || "Failed to load products.");
        return payload as ProductResponse;
      }),
    enabled: search.trim().length > 0,
  });

  const { data: requestedProductData } = useClientQuery<ProductResponse>({
    queryKey: ["admin", "stock-adjustments", "requested-product", requestedProductId],
    queryFn: () =>
      fetch(`/api/products?ids=${encodeURIComponent(requestedProductId)}`).then(async (r) => {
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((payload as { error?: string }).error || "Failed to load requested product.");
        return payload as ProductResponse;
      }),
    enabled: Boolean(requestedProductId),
  });

  const adjustmentParams = useMemo(() => {
    const sp = new URLSearchParams();
    if (start) sp.set("start", start);
    if (end) sp.set("end", end);
    if (productFilter) sp.set("productId", productFilter.id);
    if (typeFilter !== "adjustments") sp.set("type", typeFilter);
    sp.set("page", String(page));
    sp.set("pageSize", String(PAGE_SIZE));
    return sp.toString();
  }, [start, end, productFilter, typeFilter, page]);

  const { data: adjustmentData, error: adjustmentsError, isLoading: adjustmentsLoading } =
    useClientQuery<AdjustmentResponse>({
      queryKey: ["admin", "stock-adjustments", start, end, productFilter?.id, typeFilter, page],
      queryFn: () =>
        fetch(`/api/admin/stock-adjustments?${adjustmentParams}`).then(async (r) => {
          const payload = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error((payload as { error?: string }).error || "Failed to load adjustments.");
          return payload as AdjustmentResponse;
        }),
    });

  const results = productData?.items || [];
  const requestedProduct = requestedProductData?.items?.[0] || null;
  const adjustments = adjustmentData?.items || [];
  const totalAdjustments = adjustmentData?.total ?? 0;
  const totalPages = Math.ceil(totalAdjustments / PAGE_SIZE);

  const currentStock = selected ? Number(selected.stock || 0) : 0;
  const countValue = countedStock !== "" ? Number(countedStock) : currentStock;
  const delta = selected ? countValue - currentStock : 0;
  const valueImpact = selected ? Number((delta * Number(selected.cost || 0)).toFixed(2)) : 0;

  // Summary row for history table
  const summaryNetDelta = adjustments.reduce((s, r) => s + r.delta, 0);
  const summaryValueDelta = adjustments.reduce((s, r) => s + r.valueDelta, 0);

  useEffect(() => {
    if (!requestedQuery) return;
    setSearch(requestedQuery);
  }, [requestedQuery]);

  useEffect(() => {
    if (!requestedProduct || selected?.id === requestedProduct.id) return;
    setSelected(requestedProduct);
    setCountedStock(String(requestedProduct.stock ?? 0));
    setProductFilter({ id: requestedProduct.id, name: requestedProduct.name });
  }, [requestedProduct, selected?.id]);

  function resetForm(nextCountedStock?: string) {
    setCountedStock(nextCountedStock ?? "");
    setReasonType("CYCLE_COUNT");
    setReasonCode("");
    setNote("");
    setLotCode("");
    setExpiryDate("");
  }

  function buildScopeSnapshot() {
    return [
      `sourcePage=${STOCK_ADJUSTMENTS_SOURCE_PAGE}`,
      `product=${productFilter?.name || "all"}`,
      `from=${start || "-"}`,
      `to=${end || "-"}`,
      `type=${typeFilter}`,
      `page=${page}`,
      `rows=${adjustments.length}`,
    ].join(" | ");
  }

  async function handleExportCsv() {
    const payload = exportToCsv(adjustments);
    try {
      await fetch("/api/admin/stock-adjustments/export-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          scopeSnapshot: buildScopeSnapshot(),
        }),
      });
    } catch {
      // best-effort audit logging
    }
    toast.success("Stock adjustments CSV exported.");
  }

  function handleSaveClick() {
    if (!selected) {
      toast.error("Select a product first.");
      return;
    }
    if (countedStock.trim() === "") {
      toast.error("Enter the counted stock.");
      return;
    }
    const parsedCount = Number(countedStock);
    if (!Number.isInteger(parsedCount) || parsedCount < 0) {
      toast.error("Enter a valid counted stock (whole number, 0 or above).");
      return;
    }
    if (!note.trim()) {
      toast.error("A reason note is required for this adjustment.");
      return;
    }
    if (!reasonCode) {
      toast.error("Select a reason code.");
      return;
    }
    if (selected.requiresLotTracking && !lotCode.trim()) {
      toast.error("Lot/Batch code is required for this product.");
      return;
    }
    if (selected.requiresExpiryDate && !expiryDate) {
      toast.error("Expiry date is required for this product.");
      return;
    }

    // Open confirmation dialog — snapshot all form values now so confirmAdjustment
    // doesn't depend on component state at submit time.
    setPendingAdjustment({
      productId: selected.id,
      productName: selected.name,
      productSku: selected.sku,
      currentStock,
      countedStock: parsedCount,
      delta: parsedCount - currentStock,
      valueDelta: Number(((parsedCount - currentStock) * Number(selected.cost || 0)).toFixed(2)),
      reasonType,
      reasonCode,
      note: note.trim(),
      lotCode: lotCode.trim(),
      expiryDate,
    });
  }

  async function confirmAdjustment() {
    if (!pendingAdjustment) return;
    const snap = pendingAdjustment;
    setPendingAdjustment(null);
    try {
      setSubmitting(true);
      const res = await fetch("/api/admin/stock-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: snap.productId,
          countedStock: snap.countedStock,
          reasonType: snap.reasonType,
          reasonCode: snap.reasonCode,
          note: snap.note,
          lotCode: snap.lotCode || undefined,
          expiryDate: snap.expiryDate || undefined,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((payload as { error?: string }).error || "Failed to post adjustment.");
      }
      if ((payload as { message?: string }).message === "No stock change required.") {
        toast.info("No change — counted stock matches current stock.");
      } else {
        toast.success("Stock adjustment saved.");
      }
      setSelected((prev) => (prev && prev.id === snap.productId ? { ...prev, stock: snap.countedStock } : prev));
      resetForm(String(snap.countedStock));
      setPage(1);
      queryClient.invalidateQueries({ queryKey: ["admin", "inventory"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "stock-adjustments"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "movements"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "stock-adjustments", "products"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "stock-adjustments", "requested-product"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to post adjustment.");
    } finally {
      setSubmitting(false);
    }
  }

  const lotRequired = selected?.requiresLotTracking ?? false;
  const expiryRequired = selected?.requiresExpiryDate ?? false;

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Stock adjustments</h1>
          <p className="text-sm text-muted-foreground">
            Capture cycle counts and one-off corrections with audit-friendly notes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={STOCK_ADJUSTMENTS_AUDIT_HREF}>Open adjustment audit</Link>
          </Button>
          {selected ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/admin/audit?entityType=PRODUCT&entityId=${encodeURIComponent(selected.id)}&sourcePage=admin%2Fstock-adjustments`}>
                Product audit
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      {/* ── New adjustment form ── */}
      <Card>
        <CardHeader>
          <CardTitle>New adjustment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">

          {/* Product search + selection panel */}
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Find product</label>
              <Input
                placeholder="Search by name or SKU"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {/* Only render the dropdown when there's an active search */}
              {search.trim().length > 0 && (
                <div className="mt-2 rounded-md border">
                  {productsLoading ? (
                    <div className="p-3 text-xs text-muted-foreground">Searching…</div>
                  ) : results.length === 0 ? (
                    <div className="p-3 text-xs text-muted-foreground">No products found.</div>
                  ) : (
                    <div className="max-h-52 overflow-y-auto divide-y text-xs">
                      {results.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setSelected(item);
                            setCountedStock(String(item.stock ?? 0));
                            setProductFilter({ id: item.id, name: item.name });
                            setSearch("");
                          }}
                          className={`flex w-full items-center justify-between px-3 py-2 text-left hover:bg-muted ${
                            selected?.id === item.id ? "bg-muted" : ""
                          }`}
                        >
                          <div>
                            <div className="font-medium">{item.name}</div>
                            <div className="text-muted-foreground">{item.sku || "No SKU"}</div>
                          </div>
                          <div className="text-right">
                            <div>Stock: {item.stock}</div>
                            <div className="text-muted-foreground">
                              Cost: {formatCurrency(Number(item.cost || 0))}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Selected product summary */}
            <div className="rounded-md border p-3 space-y-3">
              <div className="text-xs text-muted-foreground">Selected product</div>
              {selected ? (
                <>
                  <div className="text-sm font-medium">{selected.name}</div>
                  <div className="text-xs text-muted-foreground">{selected.sku || "No SKU"}</div>
                  <div className="text-xs">Current stock: <span className="font-medium">{currentStock}</span></div>
                  <div className="text-xs">Unit cost: {formatCurrency(Number(selected.cost || 0))}</div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelected(null);
                      setProductFilter(null);
                      resetForm();
                    }}
                  >
                    Clear selection
                  </Button>
                </>
              ) : (
                <div className="text-xs text-muted-foreground">Select a product to continue.</div>
              )}
            </div>
          </div>

          {/* Adjustment fields */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <label htmlFor="adj-counted-stock" className="text-xs font-medium text-muted-foreground">
                Counted stock <span className="text-red-500">*</span>
              </label>
              <Input
                id="adj-counted-stock"
                type="number"
                min="0"
                step="1"
                value={countedStock}
                onChange={(e) => setCountedStock(e.target.value)}
                disabled={!selected}
              />
            </div>
            <div>
              <label htmlFor="adj-reason-type" className="text-xs font-medium text-muted-foreground">
                Type <span className="text-red-500">*</span>
              </label>
              <select
                id="adj-reason-type"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground"
                value={reasonType}
                onChange={(e) => setReasonType(e.target.value)}
                disabled={!selected}
              >
                <option value="CYCLE_COUNT">Cycle count</option>
                <option value="STOCK_ADJUSTMENT">Stock adjustment</option>
              </select>
            </div>
            <div>
              <label htmlFor="adj-reason-code" className="text-xs font-medium text-muted-foreground">
                Reason code <span className="text-red-500">*</span>
              </label>
              <select
                id="adj-reason-code"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground"
                value={reasonCode}
                onChange={(e) => setReasonCode(e.target.value)}
                disabled={!selected}
              >
                <option value="">Select reason</option>
                {ADJUSTMENT_REASON_CODES.map((reason) => (
                  <option key={reason.value} value={reason.value}>
                    {reason.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2 lg:col-span-2">
              <label htmlFor="adj-note" className="text-xs font-medium text-muted-foreground">
                Note <span className="text-red-500">*</span>
              </label>
              <Textarea
                id="adj-note"
                rows={2}
                placeholder="Short reason (damage, audit variance, expiry, etc.)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={!selected}
              />
            </div>
          </div>

          {/* Lot / Expiry fields */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label htmlFor="adj-lot-code" className="text-xs font-medium text-muted-foreground">
                Lot / Batch code{" "}
                {lotRequired ? (
                  <span className="text-red-500">*</span>
                ) : (
                  <span className="text-muted-foreground">(optional)</span>
                )}
              </label>
              <Input
                id="adj-lot-code"
                placeholder={lotRequired ? "Required for this SKU" : "Optional"}
                value={lotCode}
                onChange={(e) => setLotCode(e.target.value)}
                disabled={!selected}
              />
            </div>
            <div>
              <label htmlFor="adj-expiry-date" className="text-xs font-medium text-muted-foreground">
                Expiry date{" "}
                {expiryRequired ? (
                  <span className="text-red-500">*</span>
                ) : (
                  <span className="text-muted-foreground">(optional)</span>
                )}
              </label>
              <Input
                id="adj-expiry-date"
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                disabled={!selected}
              />
            </div>
          </div>

          {/* Requirement hint */}
          {selected && (lotRequired || expiryRequired) && (
            <p className="text-xs text-amber-600">
              This SKU requires{" "}
              {lotRequired && expiryRequired
                ? "lot/batch codes and expiry dates"
                : lotRequired
                ? "lot/batch codes"
                : "expiry dates"}
              .
            </p>
          )}

          {/* Live delta preview */}
          <div className="grid gap-3 sm:grid-cols-3 text-xs text-muted-foreground">
            <div>
              Delta:{" "}
              <span className={selected ? deltaClass(delta) : ""}>
                {selected ? (delta > 0 ? `+${delta}` : String(delta)) : "—"}
              </span>
            </div>
            <div>
              Value impact:{" "}
              <span className={selected ? deltaClass(valueImpact) : ""}>
                {selected ? formatCurrency(valueImpact) : "—"}
              </span>
            </div>
            <div>
              Journal entry:{" "}
              <span className="text-foreground">
                {selected && Math.abs(valueImpact) > 0.01 ? "Will post" : "No entry"}
              </span>
            </div>
          </div>

          <Button className="w-full sm:w-auto" onClick={handleSaveClick} disabled={!selected || submitting}>
            {submitting ? "Saving…" : "Save adjustment"}
          </Button>
        </CardContent>
      </Card>

      {/* ── Recent adjustments ── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap">
          <CardTitle>Recent adjustments</CardTitle>
          {adjustments.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleExportCsv} title="Exports the current page only">
                Export CSV (page)
              </Button>
            )}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">

          {/* Filters */}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label htmlFor="filter-start" className="text-xs font-medium text-muted-foreground">From</label>
              <Input id="filter-start" type="date" value={start} onChange={(e) => { setStart(e.target.value); setPage(1); }} />
            </div>
            <div>
              <label htmlFor="filter-end" className="text-xs font-medium text-muted-foreground">To</label>
              <Input id="filter-end" type="date" value={end} onChange={(e) => { setEnd(e.target.value); setPage(1); }} />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Product</label>
              <div className="relative flex items-center">
                <Input
                  readOnly
                  placeholder="All products"
                  value={productFilter ? productFilter.name : ""}
                  className="pr-8"
                />
                {productFilter && (
                  <button
                    type="button"
                    onClick={() => { setProductFilter(null); setPage(1); }}
                    className="absolute right-2 text-muted-foreground hover:text-foreground text-xs"
                    aria-label="Clear product filter"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
            <div>
              <label htmlFor="filter-type" className="text-xs font-medium text-muted-foreground">Type</label>
              <select
                id="filter-type"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground"
                value={typeFilter}
                onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
              >
                <option value="adjustments">All adjustments</option>
                <option value="CYCLE_COUNT">Cycle count</option>
                <option value="STOCK_ADJUSTMENT">Stock adjustment</option>
              </select>
            </div>
          </div>

          {/* Table */}
          {adjustmentsLoading ? (
            <div className="text-muted-foreground">Loading adjustments…</div>
          ) : adjustmentsError ? (
            <div className="text-red-600">Failed to load adjustments.</div>
          ) : adjustments.length === 0 ? (
            <div className="text-muted-foreground">No adjustments found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 pr-3 whitespace-nowrap">Date</th>
                    <th className="py-2 pr-3">Product</th>
                    <th className="py-2 pr-3 text-right whitespace-nowrap">Delta</th>
                    <th className="py-2 pr-3 text-right whitespace-nowrap">Value impact</th>
                    <th className="py-2 pr-3 whitespace-nowrap">Type</th>
                    <th className="py-2 pr-3 whitespace-nowrap">Reason code</th>
                    <th className="py-2 pr-3 whitespace-nowrap">Lot</th>
                    <th className="py-2 pr-3 whitespace-nowrap">Expiry</th>
                    <th className="py-2 pr-3">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((row) => (
                    <tr key={row.id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {new Date(row.createdAt).toLocaleDateString("en-GH")}
                      </td>
                      <td className="py-2 pr-3">
                        <div>{row.productName}</div>
                        <div className="text-xs text-muted-foreground">{row.productSku || "No SKU"}</div>
                      </td>
                      <td className={`py-2 pr-3 text-right ${deltaClass(row.delta)}`}>
                        {row.delta > 0 ? `+${row.delta}` : row.delta}
                      </td>
                      <td className={`py-2 pr-3 text-right ${deltaClass(row.valueDelta)}`}>
                        {formatCurrency(row.valueDelta)}
                      </td>
                      <td className="py-2 pr-3">{REASON_TYPE_LABEL[row.reason] ?? row.reason}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {row.reasonCode ? (REASON_CODE_LABEL[row.reasonCode] ?? row.reasonCode) : "—"}
                      </td>
                      <td className="py-2 pr-3">{row.lotCode || "—"}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {row.expiryDate ? new Date(row.expiryDate).toLocaleDateString("en-GH") : "—"}
                      </td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground max-w-[200px] truncate">
                        {row.note || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {/* Summary row */}
                <tfoot>
                  <tr className="border-t bg-muted/30 font-medium text-xs">
                    <td className="py-2 pr-3 text-muted-foreground" colSpan={2}>
                      Showing {adjustments.length} of {totalAdjustments}
                    </td>
                    <td className={`py-2 pr-3 text-right ${deltaClass(summaryNetDelta)}`}>
                      {summaryNetDelta > 0 ? `+${summaryNetDelta}` : summaryNetDelta}
                    </td>
                    <td className={`py-2 pr-3 text-right ${deltaClass(summaryValueDelta)}`}>
                      {formatCurrency(summaryValueDelta)}
                    </td>
                    <td colSpan={5} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Pagination + filter controls */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStart("");
                setEnd("");
                setProductFilter(null);
                setTypeFilter("adjustments");
                setPage(1);
              }}
            >
              Clear filters
            </Button>
            {totalPages > 1 && (
              <div className="flex items-center gap-1 text-xs">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <span className="px-2 text-muted-foreground">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Confirmation dialog ── */}
      <Dialog open={Boolean(pendingAdjustment)} onOpenChange={(open) => { if (!open) setPendingAdjustment(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm stock adjustment</DialogTitle>
            <DialogDescription>
              {pendingAdjustment && Math.abs(pendingAdjustment.valueDelta) > 0.01
                ? "This will update stock and post a journal entry to the GL."
                : "This will update stock. No journal entry will be posted (zero value impact)."}
              {" "}Review the details below before confirming.
            </DialogDescription>
          </DialogHeader>
          {pendingAdjustment && (
            <div className="text-sm space-y-2">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3 text-xs">
                <span className="text-muted-foreground">Product</span>
                <span className="font-medium">
                  {pendingAdjustment.productName}
                  {pendingAdjustment.productSku ? ` (${pendingAdjustment.productSku})` : ""}
                </span>
                <span className="text-muted-foreground">Current stock</span>
                <span>{pendingAdjustment.currentStock}</span>
                <span className="text-muted-foreground">Counted stock</span>
                <span>{pendingAdjustment.countedStock}</span>
                <span className="text-muted-foreground">Delta</span>
                <span className={deltaClass(pendingAdjustment.delta)}>
                  {pendingAdjustment.delta > 0 ? `+${pendingAdjustment.delta}` : pendingAdjustment.delta}
                </span>
                <span className="text-muted-foreground">Value impact</span>
                <span className={deltaClass(pendingAdjustment.valueDelta)}>
                  {formatCurrency(pendingAdjustment.valueDelta)}
                </span>
                <span className="text-muted-foreground">Type</span>
                <span>{pendingAdjustment.reasonType.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}</span>
                <span className="text-muted-foreground">Reason code</span>
                <span>{ADJUSTMENT_REASON_CODES.find((r) => r.value === pendingAdjustment.reasonCode)?.label ?? pendingAdjustment.reasonCode}</span>
                <span className="text-muted-foreground">Note</span>
                <span className="break-words">{pendingAdjustment.note}</span>
              </div>
              {Math.abs(pendingAdjustment.valueDelta) > 0.01 && (
                <p className="text-xs text-amber-600">
                  A journal entry of {formatCurrency(Math.abs(pendingAdjustment.valueDelta))} will be posted to the GL.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAdjustment(null)}>
              Cancel
            </Button>
            <Button onClick={confirmAdjustment} disabled={submitting}>
              {submitting ? "Saving…" : "Confirm adjustment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
