"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useClientQuery } from "@/hooks/use-client-query";

type LotRow = {
  id: string;
  productId: string;
  productName: string;
  productSku: string | null;
  supplierId: string | null;
  supplierName: string | null;
  lotCode: string;
  expiryDate: string | null;
  receivedAt: string;
  quantityReceived: number;
  quantityRemaining: number;
  notes: string | null;
};

type LotsResponse = {
  items: LotRow[];
  summary: {
    totalLots: number;
    totalRemaining: number;
    expiredLots: number;
    expiringHigh: number;
    expiringMedium: number;
    expiring30?: number;
    expiring60?: number;
  };
  fefoThresholds?: {
    highDays: number;
    mediumDays: number;
  };
  compliance?: {
    regulatedCount: number;
    missingExpiryLots: number;
    missingLotMovements: number;
    missingLotCoverage: number;
    missingExpirySamples: Array<{
      id: string;
      productId: string;
      productName: string;
      productSku: string | null;
      lotCode: string;
      receivedAt: string;
      quantityRemaining: number;
    }>;
    missingMovementSamples: Array<{
      id: string;
      productId: string;
      productName: string;
      productSku: string | null;
      reason: string;
      delta: number;
      createdAt: string;
    }>;
    missingCoverageSamples: Array<{
      productId: string;
      productName: string;
      productSku: string | null;
      stock: number;
      trackedRemaining: number;
      missingUnits: number;
    }>;
  };
};

type LotTraceResponse = {
  lot: {
    id: string;
    lotCode: string;
    expiryDate: string | null;
    receivedAt: string;
    quantityReceived: number;
    quantityRemaining: number;
    notes: string | null;
    supplier: { id: string; name: string } | null;
    product: {
      id: string;
      name: string;
      sku: string | null;
      requiresLotTracking: boolean;
      requiresExpiryDate: boolean;
    } | null;
    purchase: {
      id: string;
      createdAt: string;
      status: string;
      orderedQuantity: number;
      receivedQuantity: number;
      unitCost: number;
      supplier: string | null;
      supplierId: string | null;
    } | null;
  };
  movements: Array<{
    id: string;
    reason: string;
    reasonCode: string | null;
    delta: number;
    note: string | null;
    purchaseId: string | null;
    createdAt: string;
  }>;
};

export default function InventoryLotsPage() {
  const [productId, setProductId] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [expStart, setExpStart] = useState("");
  const [expEnd, setExpEnd] = useState("");
  const [expiringWithin, setExpiringWithin] = useState("");
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustLot, setAdjustLot] = useState<LotRow | null>(null);
  const [adjustQty, setAdjustQty] = useState("");
  const [adjustReason, setAdjustReason] = useState("Expired");
  const [adjustNote, setAdjustNote] = useState("");
  const [adjustError, setAdjustError] = useState("");
  const [adjustNotice, setAdjustNotice] = useState("");
  const [adjustSubmitting, setAdjustSubmitting] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [traceLotId, setTraceLotId] = useState<string | null>(null);
  const [traceLotRow, setTraceLotRow] = useState<LotRow | null>(null);
  const currentRemaining = adjustLot ? Number(adjustLot.quantityRemaining || 0) : 0;
  const hasRequestedQty = adjustQty.trim().length > 0;
  const requestedQtyValid = Number.isFinite(Number(adjustQty)) && Number(adjustQty) >= 0;
  const requestedQtyDiffers = requestedQtyValid && Number(adjustQty) !== currentRemaining;
  const canSubmitAdjust = Boolean(adjustLot) && hasRequestedQty && requestedQtyDiffers && !adjustSubmitting;

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (productId) sp.set("productId", productId);
    if (q.trim()) sp.set("q", q.trim());
    if (status) sp.set("status", status);
    if (expStart) sp.set("expStart", expStart);
    if (expEnd) sp.set("expEnd", expEnd);
    if (expiringWithin) sp.set("expiringWithin", expiringWithin);
    return sp.toString();
  }, [productId, q, status, expStart, expEnd, expiringWithin]);

  const { data, refetch } = useClientQuery<LotsResponse>({
    queryKey: ["inventory", "lots", params],
    queryFn: () => fetch(`/api/admin/inventory/lots?${params}`).then((r) => r.json()),
  });
  const { data: traceData, isFetching: traceLoading } = useClientQuery<LotTraceResponse>({
    queryKey: ["inventory", "lot-trace", traceLotId || ""],
    queryFn: () =>
      fetch(`/api/admin/inventory/lots/${traceLotId}`).then((r) => r.json()),
    enabled: Boolean(traceLotId),
  });

  const rows = Array.isArray(data?.items) ? data?.items : [];
  const summary = data?.summary;
  const fefoThresholds = data?.fefoThresholds;
  const compliance = data?.compliance;
  const highExpiryDays = Number(fefoThresholds?.highDays || 30);
  const mediumExpiryDays = Number(fefoThresholds?.mediumDays || 60);
  const now = new Date();

  const formatDaysToExpiry = (expiryDate: string | null) => {
    if (!expiryDate) return "-";
    const expiry = new Date(expiryDate);
    if (Number.isNaN(expiry.getTime())) return "-";
    const msLeft = expiry.getTime() - now.getTime();
    const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
    if (daysLeft < 0) return "Expired";
    return `${daysLeft}d`;
  };

  const expiryCellStyle = (expiryDate: string | null) => {
    if (!expiryDate) return "";
    const expiry = new Date(expiryDate);
    if (Number.isNaN(expiry.getTime())) return "";
    const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (daysLeft < 0) return "text-rose-700 font-semibold";
    if (daysLeft <= highExpiryDays) return "text-amber-700 font-semibold";
    if (daysLeft <= mediumExpiryDays) return "text-yellow-700";
    return "";
  };

  const daysLeft = (expiryDate: string | null) => {
    if (!expiryDate) return null;
    const expiry = new Date(expiryDate);
    if (Number.isNaN(expiry.getTime())) return null;
    return Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  };

  const fefoPriority = (row: LotRow) => {
    const d = daysLeft(row.expiryDate);
    if (d == null) return { label: "No expiry", className: "text-muted-foreground" };
    if (d < 0) return { label: "Expired", className: "text-rose-700 font-semibold" };
    if (d <= highExpiryDays) return { label: "High", className: "text-rose-700 font-semibold" };
    if (d <= mediumExpiryDays) return { label: "Medium", className: "text-amber-700 font-semibold" };
    return { label: "Low", className: "text-emerald-700 font-semibold" };
  };

  const openAdjust = (row: LotRow) => {
    const expired = row.expiryDate ? new Date(row.expiryDate) <= new Date() : false;
    setAdjustLot(row);
    setAdjustQty("");
    setAdjustReason(expired ? "Expired" : "Damaged");
    setAdjustNote("");
    setAdjustError("");
    setAdjustNotice("");
    setAdjustOpen(true);
  };

  const openTrace = (row: LotRow) => {
    setTraceLotRow(row);
    setTraceLotId(row.id);
    setTraceOpen(true);
  };

  const downloadTraceSummaryCsv = () => {
    if (!traceData?.lot) return;
    const lines = [
      ["Section", "Field", "Value"].join(","),
      ["LOT", "Lot ID", JSON.stringify(traceData.lot.id)].join(","),
      ["LOT", "Product", JSON.stringify(traceData.lot.product?.name || "")].join(","),
      ["LOT", "SKU", JSON.stringify(traceData.lot.product?.sku || "")].join(","),
      ["LOT", "Lot Code", JSON.stringify(traceData.lot.lotCode || "")].join(","),
      ["LOT", "Supplier", JSON.stringify(traceData.lot.supplier?.name || "")].join(","),
      ["LOT", "Received At", JSON.stringify(new Date(traceData.lot.receivedAt).toISOString())].join(","),
      [
        "LOT",
        "Expiry Date",
        JSON.stringify(
          traceData.lot.expiryDate ? new Date(traceData.lot.expiryDate).toISOString().slice(0, 10) : "",
        ),
      ].join(","),
      ["LOT", "Qty Received", String(traceData.lot.quantityReceived || 0)].join(","),
      ["LOT", "Qty Remaining", String(traceData.lot.quantityRemaining || 0)].join(","),
      ["LOT", "Notes", JSON.stringify(traceData.lot.notes || "")].join(","),
      ["PURCHASE", "Purchase ID", JSON.stringify(traceData.lot.purchase?.id || "")].join(","),
      ["PURCHASE", "Status", JSON.stringify(traceData.lot.purchase?.status || "")].join(","),
      ["PURCHASE", "Ordered Quantity", String(traceData.lot.purchase?.orderedQuantity || 0)].join(","),
      ["PURCHASE", "Received Quantity", String(traceData.lot.purchase?.receivedQuantity || 0)].join(","),
      ["PURCHASE", "Unit Cost", String(traceData.lot.purchase?.unitCost || 0)].join(","),
      ["MOVEMENT", "Movement rows", String(traceData.movements?.length || 0)].join(","),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const filename = `lot_trace_summary_${traceData.lot.lotCode || traceData.lot.id}_${Date.now()}.csv`;
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "inventory-lots-trace-summary",
      format: "CSV",
      fileName: filename,
      rowCount: lines.length - 1,
      columnCount: 3,
      byteSize: blob.size,
      scopeSnapshot: `Lot: ${traceData.lot.lotCode || traceData.lot.id}`,
    });
  };

  const downloadTraceCombinedCsv = () => {
    if (!traceData?.lot) return;
    const lines = [
      ["Section", "Field", "Value"].join(","),
      ["LOT", "Lot ID", JSON.stringify(traceData.lot.id)].join(","),
      ["LOT", "Product", JSON.stringify(traceData.lot.product?.name || "")].join(","),
      ["LOT", "SKU", JSON.stringify(traceData.lot.product?.sku || "")].join(","),
      ["LOT", "Lot Code", JSON.stringify(traceData.lot.lotCode || "")].join(","),
      ["LOT", "Supplier", JSON.stringify(traceData.lot.supplier?.name || "")].join(","),
      ["LOT", "Received At", JSON.stringify(new Date(traceData.lot.receivedAt).toISOString())].join(","),
      [
        "LOT",
        "Expiry Date",
        JSON.stringify(
          traceData.lot.expiryDate ? new Date(traceData.lot.expiryDate).toISOString().slice(0, 10) : "",
        ),
      ].join(","),
      ["LOT", "Qty Received", String(traceData.lot.quantityReceived || 0)].join(","),
      ["LOT", "Qty Remaining", String(traceData.lot.quantityRemaining || 0)].join(","),
      ["LOT", "Notes", JSON.stringify(traceData.lot.notes || "")].join(","),
      ["PURCHASE", "Purchase ID", JSON.stringify(traceData.lot.purchase?.id || "")].join(","),
      ["PURCHASE", "Status", JSON.stringify(traceData.lot.purchase?.status || "")].join(","),
      ["PURCHASE", "Ordered Quantity", String(traceData.lot.purchase?.orderedQuantity || 0)].join(","),
      ["PURCHASE", "Received Quantity", String(traceData.lot.purchase?.receivedQuantity || 0)].join(","),
      ["PURCHASE", "Unit Cost", String(traceData.lot.purchase?.unitCost || 0)].join(","),
      ["MOVEMENT", "Movement rows", String(traceData.movements?.length || 0)].join(","),
      ["", "", ""].join(","),
      ["Movement ID", "When", "Reason", "Delta", "Purchase ID", "Note"].join(","),
      ...(traceData.movements || []).map((move) =>
        [
          JSON.stringify(move.id),
          JSON.stringify(new Date(move.createdAt).toISOString()),
          JSON.stringify(move.reasonCode || move.reason || ""),
          String(move.delta || 0),
          JSON.stringify(move.purchaseId || ""),
          JSON.stringify(move.note || ""),
        ].join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const filename = `lot_trace_${traceData.lot.lotCode || traceData.lot.id}_${Date.now()}.csv`;
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "inventory-lots-trace-combined",
      format: "CSV",
      fileName: filename,
      rowCount: lines.length - 1,
      columnCount: 6,
      byteSize: blob.size,
      scopeSnapshot: `Lot: ${traceData.lot.lotCode || traceData.lot.id}`,
    });
  };

  const downloadTraceMovementsCsv = () => {
    if (!traceData?.lot) return;
    const lines = [
      ["Movement ID", "When", "Reason", "Delta", "Purchase ID", "Note"].join(","),
      ...(traceData.movements || []).map((move) =>
        [
          JSON.stringify(move.id),
          JSON.stringify(new Date(move.createdAt).toISOString()),
          JSON.stringify(move.reasonCode || move.reason || ""),
          String(move.delta || 0),
          JSON.stringify(move.purchaseId || ""),
          JSON.stringify(move.note || ""),
        ].join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const filename = `lot_trace_movements_${traceData.lot.lotCode || traceData.lot.id}_${Date.now()}.csv`;
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "inventory-lots-trace-movements",
      format: "CSV",
      fileName: filename,
      rowCount: lines.length - 1,
      columnCount: 6,
      byteSize: blob.size,
      scopeSnapshot: `Lot: ${traceData.lot.lotCode || traceData.lot.id}`,
    });
  };

  const submitAdjust = async () => {
    if (!adjustLot) return;
    setAdjustError("");
    if (!adjustQty.trim()) {
      setAdjustError("Enter the new remaining quantity.");
      return;
    }
    const qty = Number(adjustQty);
    if (!Number.isFinite(qty) || qty < 0) {
      setAdjustError("Enter a valid remaining quantity.");
      return;
    }
    if (!adjustReason.trim()) {
      setAdjustError("Reason is required.");
      return;
    }
    const expired = adjustLot.expiryDate ? new Date(adjustLot.expiryDate) <= new Date() : false;
    if (!expired && adjustReason === "Expired") {
      setAdjustError("Expired is only valid for lots past the expiry date.");
      return;
    }
    if (!expired && !adjustNote.trim()) {
      setAdjustError("Add a short note when adjusting an unexpired lot.");
      return;
    }
    if (qty === currentRemaining) {
      setAdjustNotice(
        `No change to apply. Current: ${currentRemaining} | Requested: ${qty}`,
      );
      toast.info("No changes were applied.");
      return;
    }
    setAdjustSubmitting(true);
    try {
      const res = await fetch(`/api/admin/inventory/lots/${adjustLot.id}/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantityRemaining: qty,
          reason: adjustReason,
          note: adjustNote.trim() || null,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.error || "Failed to adjust lot.");
      }
      if (payload?.message === "No change") {
        setAdjustNotice("No change to apply.");
        toast.error("No changes were applied.");
        return;
      }
      setAdjustNotice(payload?.message || "Lot updated.");
      toast.success("Adjustment successful.");
      setAdjustOpen(false);
      setAdjustLot(null);
      await refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to adjust lot.";
      setAdjustError(message);
      toast.error(message || "Adjustment failed.");
    } finally {
      setAdjustSubmitting(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Inventory Lots</h1>
        <p className="text-sm text-muted-foreground">
          Track batch/lot codes and expiry dates for lot-tracked (regulated) inventory.
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Lots are issued using FEFO (first-expiry-first-out) to reduce expiry risk.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <a
            href="#lot-list"
            className="rounded-md border px-3 py-1 text-muted-foreground hover:text-foreground"
          >
            Lots
          </a>
          <a
            href="#compliance"
            className="rounded-md border px-3 py-1 text-muted-foreground hover:text-foreground"
          >
            Compliance
          </a>
        </div>
      </div>

      <Card id="filters">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <Input
            placeholder="Filter by product ID"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          />
          <Input
            placeholder="Lot code search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All status</option>
            <option value="ACTIVE">Active</option>
            <option value="EXPIRED">Expired</option>
          </select>
          <Input type="date" value={expStart} onChange={(e) => setExpStart(e.target.value)} />
          <Input type="date" value={expEnd} onChange={(e) => setExpEnd(e.target.value)} />
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={expiringWithin}
            onChange={(e) => setExpiringWithin(e.target.value)}
          >
            <option value="">Expiry window</option>
            <option value={String(highExpiryDays)}>Expiring in {highExpiryDays}d</option>
            <option value={String(mediumExpiryDays)}>Expiring in {mediumExpiryDays}d</option>
            <option value="90">Expiring in 90d</option>
          </select>
          <div className="sm:col-span-2 lg:col-span-6">
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
                <a href={`/api/admin/inventory/lots?${params}&format=csv`}>Export CSV</a>
              </Button>
              <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
                <a href={`/api/admin/inventory/lots?${params}&format=compliance_csv`}>
                  Export compliance CSV
                </a>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Lots</div>
            <div className="text-lg font-semibold">{summary?.totalLots ?? 0}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Remaining units</div>
            <div className="text-lg font-semibold">{summary?.totalRemaining ?? 0}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Expired lots</div>
            <div className="text-lg font-semibold text-rose-700">{summary?.expiredLots ?? 0}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">{`Expiring <=${highExpiryDays}d`}</div>
            <div className="text-lg font-semibold text-amber-700">{summary?.expiringHigh ?? summary?.expiring30 ?? 0}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">{`Expiring <=${mediumExpiryDays}d`}</div>
            <div className="text-lg font-semibold text-amber-700">{summary?.expiringMedium ?? summary?.expiring60 ?? 0}</div>
          </div>
        </CardContent>
      </Card>

      <Card id="compliance">
        <CardHeader>
          <CardTitle>Compliance report</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-xs text-muted-foreground">
            Compliance results honor the current filters (product and date window). Expiry-window
            filtering narrows to items expiring soon, plus any regulated SKUs missing expiry dates.
          </p>
          <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            <div className="font-medium text-foreground mb-1">Resolution checklist</div>
            <div>Missing expiry lots: update the lot with a valid expiry date or correct the product requirement.</div>
            <div>Untracked movements: ensure the SKU has lots and re-enter adjustments with lot codes.</div>
            <div>Stock without lot coverage: create/import lots to cover stock or adjust stock down.</div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border px-3 py-2">
              <div className="text-xs text-muted-foreground">Regulated SKUs</div>
              <div className="text-lg font-semibold">{compliance?.regulatedCount ?? 0}</div>
            </div>
            <div className="rounded-md border px-3 py-2">
              <div className="text-xs text-muted-foreground">Missing expiry</div>
              <div className="text-lg font-semibold text-amber-700">
                {compliance?.missingExpiryLots ?? 0}
              </div>
              <div className="text-[11px] text-muted-foreground">
                Lots missing expiry dates on regulated SKUs.
              </div>
            </div>
            <div className="rounded-md border px-3 py-2">
              <div className="text-xs text-muted-foreground">Untracked movements</div>
              <div className="text-lg font-semibold text-amber-700">
                {compliance?.missingLotMovements ?? 0}
              </div>
              <div className="text-[11px] text-muted-foreground">
                Movements recorded without a lot on regulated SKUs.
              </div>
            </div>
            <div className="rounded-md border px-3 py-2">
              <div className="text-xs text-muted-foreground">Stock without lots</div>
              <div className="text-lg font-semibold text-amber-700">
                {compliance?.missingLotCoverage ?? 0}
              </div>
              <div className="text-[11px] text-muted-foreground">
                On-hand exceeds total remaining across lots.
              </div>
            </div>
          </div>

          {compliance?.missingExpirySamples?.length ? (
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Lots missing expiry (sample)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="border-b">
                      <th className="py-2 pr-3">Product</th>
                      <th className="py-2 pr-3">Lot</th>
                      <th className="py-2 pr-3 text-center">Qty Remaining</th>
                      <th className="py-2 pr-3">Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compliance.missingExpirySamples.map((row) => (
                      <tr key={row.id} className="border-b last:border-0">
                        <td className="py-2 pr-3">
                          <div>{row.productName}</div>
                          <div className="text-xs text-muted-foreground">{row.productSku || "No SKU"}</div>
                        </td>
                        <td className="py-2 pr-3">{row.lotCode}</td>
                        <td className="py-2 pr-3 text-center">{row.quantityRemaining}</td>
                        <td className="py-2 pr-3">
                          {new Date(row.receivedAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {compliance?.missingCoverageSamples?.length ? (
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Stock without lot coverage (sample)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="border-b">
                      <th className="py-2 pr-3">Product</th>
                      <th className="py-2 pr-3 text-center">On hand</th>
                      <th className="py-2 pr-3 text-center">Tracked</th>
                      <th className="py-2 pr-3 text-center">Missing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compliance.missingCoverageSamples.map((row) => (
                      <tr key={row.productId} className="border-b last:border-0">
                        <td className="py-2 pr-3">
                          <div>{row.productName}</div>
                          <div className="text-xs text-muted-foreground">{row.productSku || "No SKU"}</div>
                        </td>
                        <td className="py-2 pr-3 text-center">{row.stock}</td>
                        <td className="py-2 pr-3 text-center">{row.trackedRemaining}</td>
                        <td className="py-2 pr-3 text-center text-amber-700 font-semibold">{row.missingUnits}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {compliance?.missingMovementSamples?.length ? (
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Movements without lot (sample on regulated SKUs)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr className="border-b">
                      <th className="py-2 pr-3">Product</th>
                      <th className="py-2 pr-3">Reason</th>
                      <th className="py-2 pr-3 text-center">Delta</th>
                      <th className="py-2 pr-3">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compliance.missingMovementSamples.map((row) => (
                      <tr key={row.id} className="border-b last:border-0">
                        <td className="py-2 pr-3">
                          <div>{row.productName}</div>
                          <div className="text-xs text-muted-foreground">{row.productSku || "No SKU"}</div>
                        </td>
                        <td className="py-2 pr-3">{row.reason}</td>
                        <td className="py-2 pr-3 text-center">{row.delta}</td>
                        <td className="py-2 pr-3">
                          {new Date(row.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card id="lot-list">
        <CardHeader>
          <CardTitle>Lot list</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 overflow-x-auto">
          <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            <div className="font-medium text-foreground mb-1">Expiry threshold legend (FEFO)</div>
            <div className="flex flex-wrap gap-3">
              <span><span className="font-semibold text-rose-700">High:</span> expires in 0-{highExpiryDays} days</span>
              <span><span className="font-semibold text-amber-700">Medium:</span> expires in {highExpiryDays + 1}-{mediumExpiryDays} days</span>
              <span><span className="font-semibold text-emerald-700">Low:</span> expires in {mediumExpiryDays + 1}+ days</span>
              <span><span className="font-semibold text-muted-foreground">No expiry:</span> no expiry date set</span>
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No lots found.</div>
          ) : (
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-3">Product</th>
                  <th className="py-2 pr-3">Lot</th>
                  <th className="py-2 pr-3 text-center">FEFO Priority</th>
                  <th className="py-2 pr-3">Expiry</th>
                  <th className="py-2 pr-3 text-center">Days left</th>
                  <th className="py-2 pr-3">Received</th>
                  <th className="py-2 pr-3 text-center">Qty Received</th>
                  <th className="py-2 pr-3 text-center">Qty Remaining</th>
                  <th className="py-2 pr-3">Supplier</th>
                  <th className="py-2 pr-3">Notes</th>
                  <th className="py-2 pr-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <div>{row.productName}</div>
                      <div className="text-xs text-muted-foreground">{row.productSku || "No SKU"}</div>
                    </td>
                    <td className="py-2 pr-3">{row.lotCode}</td>
                    <td className={`py-2 pr-3 text-center ${fefoPriority(row).className}`}>
                      {fefoPriority(row).label}
                    </td>
                    <td className="py-2 pr-3">
                      {row.expiryDate ? new Date(row.expiryDate).toLocaleDateString() : "-"}
                    </td>
                    <td className={`py-2 pr-3 text-center ${expiryCellStyle(row.expiryDate)}`}>
                      {formatDaysToExpiry(row.expiryDate)}
                    </td>
                    <td className="py-2 pr-3">{new Date(row.receivedAt).toLocaleDateString()}</td>
                    <td className="py-2 pr-3 text-center">{row.quantityReceived}</td>
                    <td className="py-2 pr-3 text-center">{row.quantityRemaining}</td>
                    <td className="py-2 pr-3">{row.supplierName || "-"}</td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {row.notes || "-"}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => openTrace(row)}>
                          Trace
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openAdjust(row)}>
                          Adjust lot
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <Dialog
        open={traceOpen}
        onOpenChange={(open) => {
          setTraceOpen(open);
          if (!open) {
            setTraceLotId(null);
            setTraceLotRow(null);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Lot trace</DialogTitle>
          </DialogHeader>
          {traceLoading ? (
            <div className="text-sm text-muted-foreground">Loading lot trace...</div>
          ) : traceData?.lot ? (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap justify-end gap-2">
                {(traceData.movements?.length || 0) <= 1 ? (
                  <Button size="sm" variant="outline" onClick={downloadTraceCombinedCsv}>
                    Export trace CSV
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={downloadTraceSummaryCsv}>
                      Export summary CSV
                    </Button>
                    <Button size="sm" variant="outline" onClick={downloadTraceMovementsCsv}>
                      Export movements CSV
                    </Button>
                  </>
                )}
              </div>
              <div className="rounded-md border px-3 py-2">
                <div className="font-medium">
                  {traceData.lot.product?.name || traceLotRow?.productName || "-"} | {traceData.lot.lotCode}
                </div>
                <div className="text-xs text-muted-foreground">
                  SKU: {traceData.lot.product?.sku || traceLotRow?.productSku || "No SKU"} | Supplier:{" "}
                  {traceData.lot.supplier?.name || "-"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Received: {new Date(traceData.lot.receivedAt).toLocaleString()} | Expiry:{" "}
                  {traceData.lot.expiryDate ? new Date(traceData.lot.expiryDate).toLocaleDateString() : "-"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Qty received: {traceData.lot.quantityReceived} | Qty remaining: {traceData.lot.quantityRemaining}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Source purchase</div>
                {traceData.lot.purchase ? (
                  <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground space-y-1">
                    <div>Purchase ID: {traceData.lot.purchase.id}</div>
                    <div>Status: {traceData.lot.purchase.status}</div>
                    <div>
                      Ordered/Received: {traceData.lot.purchase.orderedQuantity} / {traceData.lot.purchase.receivedQuantity}
                    </div>
                    <div>Unit cost: GHS {Number(traceData.lot.purchase.unitCost || 0).toFixed(2)}</div>
                    <div>Created: {new Date(traceData.lot.purchase.createdAt).toLocaleString()}</div>
                    <a
                      className="inline-block underline text-foreground"
                      href={`/admin/purchases?purchaseId=${encodeURIComponent(traceData.lot.purchase.id)}`}
                    >
                      Open in Purchases
                    </a>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">No linked purchase record.</div>
                )}
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Lot movements</div>
                  <a
                    className="text-xs underline"
                    href={`/admin/movements?product=${encodeURIComponent(traceData.lot.product?.id || traceLotRow?.productId || "")}&lotId=${encodeURIComponent(traceData.lot.id)}`}
                  >
                    View all lot movements
                  </a>
                </div>
                {traceData.movements?.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b">
                          <th className="py-2 pr-3">When</th>
                          <th className="py-2 pr-3">Reason</th>
                          <th className="py-2 pr-3 text-center">Delta</th>
                          <th className="py-2 pr-3">Purchase</th>
                          <th className="py-2 pr-3">Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {traceData.movements.map((move) => (
                          <tr key={move.id} className="border-b last:border-0">
                            <td className="py-2 pr-3">{new Date(move.createdAt).toLocaleString()}</td>
                            <td className="py-2 pr-3">{move.reasonCode || move.reason}</td>
                            <td className="py-2 pr-3 text-center">{move.delta}</td>
                            <td className="py-2 pr-3">
                              {move.purchaseId ? (
                                <a
                                  className="underline"
                                  title={move.purchaseId}
                                  href={`/admin/purchases?purchaseId=${encodeURIComponent(move.purchaseId)}`}
                                >
                                  View purchase
                                </a>
                              ) : (
                                "-"
                              )}
                            </td>
                            <td className="py-2 pr-3">{move.note || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">No lot movements found.</div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No lot trace data available.</div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={adjustOpen} onOpenChange={(open) => (!open ? setAdjustOpen(false) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust lot</DialogTitle>
          </DialogHeader>
          {adjustLot ? (
            <div className="space-y-4 text-sm">
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">Lot</div>
                <div className="font-medium">
                  {adjustLot.lotCode} · {adjustLot.productName}
                </div>
                <div className="text-xs text-muted-foreground">
                  Remaining: {adjustLot.quantityRemaining} · Expiry:{" "}
                  {adjustLot.expiryDate ? new Date(adjustLot.expiryDate).toLocaleDateString() : "—"}
                </div>
                {adjustLot.expiryDate && new Date(adjustLot.expiryDate) > new Date() ? (
                  <div className="mt-2 inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                    Unexpired lot
                  </div>
                ) : null}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="adjustQty">New remaining quantity</Label>
                  <Input
                    id="adjustQty"
                    type="number"
                    min="0"
                    value={adjustQty}
                    onChange={(e) => setAdjustQty(e.target.value)}
                    placeholder={String(adjustLot.quantityRemaining ?? 0)}
                    onFocus={(e) => e.currentTarget.select()}
                    autoComplete="off"
                  />
                  {!hasRequestedQty ? (
                    <div className="text-xs text-muted-foreground">
                      Enter a different number to apply an adjustment.
                    </div>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="adjustReason">Reason</Label>
                  <select
                    id="adjustReason"
                    className="h-10 rounded-md border bg-background px-3 text-sm"
                    value={adjustReason}
                    onChange={(e) => setAdjustReason(e.target.value)}
                  >
                    <option value="Expired">Expired</option>
                    <option value="Damaged">Damaged</option>
                    <option value="Count correction">Count correction</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="adjustNote">
                  Note{" "}
                  {adjustLot.expiryDate && new Date(adjustLot.expiryDate) > new Date()
                    ? "(required for unexpired lots)"
                    : "(optional)"}
                </Label>
                <Input
                  id="adjustNote"
                  value={adjustNote}
                  onChange={(e) => setAdjustNote(e.target.value)}
                  placeholder="Add context for the adjustment"
                />
              </div>
              {adjustNotice ? (
                <div className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                  {adjustNotice}
                </div>
              ) : null}
              {adjustError ? (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {adjustError}
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustOpen(false)} disabled={adjustSubmitting}>
              Cancel
            </Button>
            <Button onClick={submitAdjust} disabled={!canSubmitAdjust}>
              Save adjustment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}









