"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

type AdjustmentResponse = {
  items: AdjustmentRow[];
};

export default function StockAdjustmentsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ProductLite | null>(null);
  const [countedStock, setCountedStock] = useState("");
  const [reasonType, setReasonType] = useState("CYCLE_COUNT");
  const [reasonCode, setReasonCode] = useState("");
  const [note, setNote] = useState("");
  const [lotCode, setLotCode] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [typeFilter, setTypeFilter] = useState("adjustments");
  const [productFilter, setProductFilter] = useState("");

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
        if (!r.ok) {
          throw new Error((payload as { error?: string }).error || "Failed to load products.");
        }
        return payload as ProductResponse;
      }),
  });

  const adjustmentParams = useMemo(() => {
    const sp = new URLSearchParams();
    if (start) sp.set("start", start);
    if (end) sp.set("end", end);
    if (productFilter) sp.set("productId", productFilter);
    if (typeFilter !== "adjustments") sp.set("type", typeFilter);
    return sp.toString();
  }, [start, end, productFilter, typeFilter]);

  const { data: adjustmentData, error: adjustmentsError, isLoading: adjustmentsLoading } =
    useClientQuery<AdjustmentResponse>({
      queryKey: ["admin", "stock-adjustments", start, end, productFilter, typeFilter],
      queryFn: () =>
        fetch(`/api/admin/stock-adjustments?${adjustmentParams}`).then(async (r) => {
          const payload = await r.json().catch(() => ({}));
          if (!r.ok) {
            throw new Error((payload as { error?: string }).error || "Failed to load adjustments.");
          }
          return payload as AdjustmentResponse;
        }),
    });

  const results = productData?.items || [];
  const adjustments = adjustmentData?.items || [];
  const currentStock = selected ? Number(selected.stock || 0) : 0;
  const countValue = Number(countedStock || currentStock);
  const delta = selected ? countValue - currentStock : 0;
  const valueImpact = selected ? Number((delta * Number(selected.cost || 0)).toFixed(2)) : 0;

  const submitAdjustment = async () => {
    if (!selected) {
      toast.error("Select a product first.");
      return;
    }
    const parsedCount = Number(countedStock);
    if (!Number.isInteger(parsedCount) || parsedCount < 0) {
      toast.error("Enter a valid counted stock.");
      return;
    }
    if (!note.trim()) {
      toast.error("Add a reason note for this adjustment.");
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
    try {
      setSubmitting(true);
      const res = await fetch("/api/admin/stock-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: selected.id,
          countedStock: parsedCount,
          reasonType,
          reasonCode,
          note: note.trim(),
          lotCode: lotCode.trim() || undefined,
          expiryDate: expiryDate || undefined,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((payload as { error?: string }).error || "Failed to post adjustment.");
      }
      toast.success("Stock adjustment saved.");
      setCountedStock("");
      setReasonCode("");
      setNote("");
      setLotCode("");
      setExpiryDate("");
      queryClient.invalidateQueries({ queryKey: ["admin", "inventory"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "stock-adjustments"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "movements"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to post adjustment.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Stock adjustments</h1>
        <p className="text-sm text-muted-foreground">
          Capture cycle counts and one-off corrections with audit-friendly notes.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New adjustment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Find product</label>
              <Input
                placeholder="Search by name or SKU"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
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
                          setProductFilter(item.id);
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
            </div>
            <div className="rounded-md border p-3 space-y-3">
              <div className="text-xs text-muted-foreground">Selected product</div>
              {selected ? (
                <>
                  <div className="text-sm font-medium">{selected.name}</div>
                  <div className="text-xs text-muted-foreground">{selected.sku || "No SKU"}</div>
                  <div className="text-xs">Current stock: {currentStock}</div>
                  <div className="text-xs">Unit cost: {formatCurrency(Number(selected.cost || 0))}</div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSelected(null);
                      setCountedStock("");
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

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Counted stock</label>
              <Input
                type="number"
                min="0"
                value={countedStock}
                onChange={(e) => setCountedStock(e.target.value)}
                disabled={!selected}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Reason</label>
              <select
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
              <label className="text-xs font-medium text-muted-foreground">Reason code</label>
              <select
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
              <label className="text-xs font-medium text-muted-foreground">Note</label>
              <Textarea
                rows={2}
                placeholder="Short reason (damage, audit variance, expiry, etc.)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={!selected}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Lot / Batch code</label>
              <Input
                placeholder="Optional"
                value={lotCode}
                onChange={(e) => setLotCode(e.target.value)}
                disabled={!selected}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Expiry date</label>
              <Input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                disabled={!selected}
              />
            </div>
          </div>
          {selected?.requiresLotTracking || selected?.requiresExpiryDate ? (
            <p className="text-xs text-muted-foreground">
              This SKU requires{" "}
              {selected.requiresLotTracking ? "lot/batch codes" : "lot/batch codes"}
              {selected.requiresExpiryDate ? " and expiry dates." : "."}
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs text-muted-foreground">
            <div>
              Delta:{" "}
              <span className={delta < 0 ? "text-red-600" : "text-foreground"}>
                {selected ? delta : "—"}
              </span>
            </div>
            <div>
              Value impact:{" "}
              <span className={valueImpact < 0 ? "text-red-600" : "text-foreground"}>
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

          <Button className="w-full sm:w-auto" onClick={submitAdjustment} disabled={!selected || submitting}>
            {submitting ? "Saving…" : "Save adjustment"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent adjustments</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            <Input
              placeholder="Filter by product ID"
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value)}
            />
            <select
              className="h-10 rounded-md border bg-background px-3 text-sm text-foreground"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="adjustments">All adjustments</option>
              <option value="CYCLE_COUNT">Cycle count</option>
              <option value="STOCK_ADJUSTMENT">Stock adjustment</option>
            </select>
          </div>

          {adjustmentsLoading ? (
            <div className="text-muted-foreground">Loading adjustments…</div>
          ) : adjustmentsError ? (
            <div className="text-red-600">Failed to load adjustments.</div>
          ) : adjustments.length === 0 ? (
            <div className="text-muted-foreground">No adjustments yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Product</th>
                    <th className="py-2 pr-3 text-right">Delta</th>
                    <th className="py-2 pr-3 text-right">Value</th>
                    <th className="py-2 pr-3">Type</th>
                    <th className="py-2 pr-3">Reason code</th>
                    <th className="py-2 pr-3">Lot</th>
                    <th className="py-2 pr-3">Expiry</th>
                    <th className="py-2 pr-3">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        {new Date(row.createdAt).toLocaleDateString()}
                      </td>
                      <td className="py-2 pr-3">
                        <div>{row.productName}</div>
                        <div className="text-xs text-muted-foreground">
                          {row.productSku || "No SKU"}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right">{row.delta}</td>
                      <td className="py-2 pr-3 text-right">
                        {formatCurrency(row.valueDelta)}
                      </td>
                      <td className="py-2 pr-3">{row.reason}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {row.reasonCode || "—"}
                      </td>
                      <td className="py-2 pr-3">{row.lotCode || "—"}</td>
                      <td className="py-2 pr-3">
                        {row.expiryDate ? new Date(row.expiryDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {row.note || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setStart("");
              setEnd("");
              setProductFilter("");
              setTypeFilter("adjustments");
            }}
          >
            Clear filters
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}
