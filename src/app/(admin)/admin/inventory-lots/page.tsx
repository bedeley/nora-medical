"use client";
export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useClientQuery } from "@/hooks/use-client-query";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  totalItems: number;
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: string;
  summary: {
    totalLots: number;
    totalRemaining: number;
    expiredLots: number;
    expiringHigh: number;
    expiringMedium: number;
    expiring30?: number;
    expiring60?: number;
  };
  fefoThresholds?: { highDays: number; mediumDays: number };
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
  movementTotal?: number;
  movementsTruncated?: boolean;
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

type ProductSuggestion = { id: string; name: string; sku: string | null };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InventoryLotsPage() {
  const { data: session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isAdmin = session?.user?.role === "ADMIN";

  // --- Derive all filter/sort/page state from URL ---
  const productId = searchParams.get("productId") || "";
  const productLabel = searchParams.get("productLabel") || "";
  const q = searchParams.get("q") || "";
  const status = searchParams.get("status") || "";
  const expStart = searchParams.get("expStart") || "";
  const expEnd = searchParams.get("expEnd") || "";
  const expiringWithin = searchParams.get("expiringWithin") || "";
  const page = Math.max(1, Number(searchParams.get("page") || "1") || 1);
  const sortBy = searchParams.get("sortBy") || "expiryDate";
  const sortDir = searchParams.get("sortDir") || "asc";
  const focusId = searchParams.get("focus");

  // --- URL mutator ---
  // pendingParamsRef tracks the latest "intended" search params so that rapid
  // successive pushUrl calls (e.g. sort then page) compose correctly even when
  // router.replace doesn't synchronously trigger a React re-render (e.g. in tests).
  const pendingParamsRef = useRef<URLSearchParams | null>(null);
  // Reset the pending ref whenever the actual searchParams change (real navigation).
  useEffect(() => {
    pendingParamsRef.current = null;
  }, [searchParams]);

  const pushUrl = useCallback(
    (patch: Record<string, string | null>, resetPage = false) => {
      const base = pendingParamsRef.current ?? new URLSearchParams(searchParams.toString());
      const sp = new URLSearchParams(base.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") {
          sp.delete(key);
        } else {
          sp.set(key, value);
        }
      }
      if (resetPage) sp.delete("page");
      pendingParamsRef.current = sp;
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    },
    [searchParams, pathname, router],
  );

  // --- Local state (in-progress inputs and UI-only) ---
  const [productSearch, setProductSearch] = useState(productLabel);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Lot code search has local state + debounce so we don't thrash the URL on every keystroke
  const [qInput, setQInput] = useState(q);
  const debouncedQInput = useDebounce(qInput, 300);

  // --- Dialog state ---
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustLot, setAdjustLot] = useState<LotRow | null>(null);
  const [adjustQty, setAdjustQty] = useState("");
  const [adjustReason, setAdjustReason] = useState("Expired");
  const [adjustNote, setAdjustNote] = useState("");
  const [adjustError, setAdjustError] = useState("");
  const [adjustSubmitting, setAdjustSubmitting] = useState(false);

  const [traceOpen, setTraceOpen] = useState(false);
  const [traceLotId, setTraceLotId] = useState<string | null>(null);
  const [traceLotRow, setTraceLotRow] = useState<LotRow | null>(null);

  const suggestionsRef = useRef<HTMLDivElement>(null);
  const focusInitialized = useRef(false);

  // --- Derived adjust values ---
  const currentRemaining = adjustLot ? Number(adjustLot.quantityRemaining || 0) : 0;
  const hasRequestedQty = adjustQty.trim().length > 0;
  const requestedQtyNum = Number(adjustQty);
  const requestedQtyValid =
    Number.isFinite(requestedQtyNum) &&
    requestedQtyNum >= 0 &&
    Number.isInteger(requestedQtyNum);
  const requestedQtyDiffers = requestedQtyValid && requestedQtyNum !== currentRemaining;
  const canSubmitAdjust =
    Boolean(adjustLot) && hasRequestedQty && requestedQtyDiffers && !adjustSubmitting;

  // --- Effects ---

  // Deep-link: ?focus=<lotId> opens trace dialog immediately
  useEffect(() => {
    if (focusId && !focusInitialized.current) {
      focusInitialized.current = true;
      setTraceLotId(focusId);
      setTraceOpen(true);
    }
  }, [focusId]);

  // Keep product search input in sync when productLabel changes from URL navigation
  useEffect(() => {
    setProductSearch(productLabel);
  }, [productLabel]);

  // Debounced lot-code sync to URL
  useEffect(() => {
    if (debouncedQInput === q) return;
    pushUrl({ q: debouncedQInput || null }, true);
  }, [debouncedQInput, pushUrl, q]);

  // Keep lot code input in sync when URL q changes externally
  useEffect(() => {
    setQInput(q);
  }, [q]);

  // --- API params (from URL state) ---
  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (productId) sp.set("productId", productId);
    if (q) sp.set("q", q);
    if (status) sp.set("status", status);
    if (expStart) sp.set("expStart", expStart);
    if (expEnd) sp.set("expEnd", expEnd);
    if (expiringWithin) sp.set("expiringWithin", expiringWithin);
    sp.set("sortBy", sortBy);
    sp.set("sortDir", sortDir);
    sp.set("page", String(page));
    sp.set("pageSize", "50");
    return sp.toString();
  }, [productId, q, status, expStart, expEnd, expiringWithin, sortBy, sortDir, page]);

  // --- Queries ---
  const { data, isFetching, isError: listError, refetch } = useClientQuery<LotsResponse>({
    queryKey: ["inventory", "lots", params],
    queryFn: async () => {
      const r = await fetch(`/api/admin/inventory/lots?${params}`);
      if (!r.ok) throw new Error(`Failed to load lots (${r.status})`);
      return r.json() as Promise<LotsResponse>;
    },
    placeholderData: (prev) => prev as LotsResponse | undefined,
  });

  const { data: productSuggestionsData } = useClientQuery<{ products: ProductSuggestion[] }>({
    queryKey: ["inventory", "lots", "product-search", productSearch],
    queryFn: async () => {
      const r = await fetch(
        `/api/admin/inventory/lots?format=product_search&q=${encodeURIComponent(productSearch)}`,
      );
      if (!r.ok) throw new Error(`Product search failed (${r.status})`);
      return r.json() as Promise<{ products: ProductSuggestion[] }>;
    },
    enabled: showSuggestions,
  });

  const { data: traceData, isFetching: traceLoading, isError: traceError } =
    useClientQuery<LotTraceResponse>({
      queryKey: ["inventory", "lot-trace", traceLotId || ""],
      queryFn: async () => {
        const r = await fetch(`/api/admin/inventory/lots/${traceLotId}`);
        if (!r.ok) throw new Error(`Failed to load lot trace (${r.status})`);
        return r.json() as Promise<LotTraceResponse>;
      },
      enabled: Boolean(traceLotId),
    });

  // --- Derived data ---
  const rows = Array.isArray(data?.items) ? data.items : [];
  const summary = data?.summary;
  const fefoThresholds = data?.fefoThresholds;
  const compliance = data?.compliance;
  const totalItems = data?.totalItems ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const highExpiryDays = Number(fefoThresholds?.highDays || 30);
  const mediumExpiryDays = Number(fefoThresholds?.mediumDays || 60);
  const now = new Date();
  const productSuggestions: ProductSuggestion[] = productSuggestionsData?.products ?? [];

  // --- Sort handler ---
  const handleSort = useCallback(
    (field: string) => {
      if (sortBy === field) {
        const newDir = sortDir === "asc" ? "desc" : "asc";
        pushUrl({ sortDir: newDir === "asc" ? null : "desc" }, true);
      } else {
        pushUrl({ sortBy: field, sortDir: null }, true);
      }
    },
    [sortBy, sortDir, pushUrl],
  );

  // --- Product combobox handlers ---
  const selectProduct = useCallback(
    (p: ProductSuggestion) => {
      const label = `${p.name}${p.sku ? ` (${p.sku})` : ""}`;
      setProductSearch(label);
      setShowSuggestions(false);
      setActiveSuggestionIndex(-1);
      pushUrl({ productId: p.id, productLabel: label }, true);
    },
    [pushUrl],
  );

  const clearProduct = () => {
    setProductSearch("");
    setShowSuggestions(false);
    pushUrl({ productId: null, productLabel: null }, true);
  };

  const handleProductKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSuggestionIndex((i) => Math.min(i + 1, productSuggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSuggestionIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const idx = activeSuggestionIndex >= 0 ? activeSuggestionIndex : 0;
      const suggestion = productSuggestions[idx];
      if (suggestion) selectProduct(suggestion);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  // --- Filter handlers ---
  const handleExpiryWindowChange = (value: string) => {
    if (value) {
      pushUrl({ expiringWithin: value, expStart: null, expEnd: null }, true);
    } else {
      pushUrl({ expiringWithin: null }, true);
    }
  };

  const handleExpStartChange = (value: string) => {
    pushUrl({ expStart: value || null, expiringWithin: null }, true);
  };

  const handleExpEndChange = (value: string) => {
    pushUrl({ expEnd: value || null, expiringWithin: null }, true);
  };

  // --- Expiry helpers ---
  const formatDaysToExpiry = (expiryDate: string | null) => {
    if (!expiryDate) return "-";
    const expiry = new Date(expiryDate);
    if (Number.isNaN(expiry.getTime())) return "-";
    const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
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

  const daysLeftFn = (expiryDate: string | null) => {
    if (!expiryDate) return null;
    const expiry = new Date(expiryDate);
    if (Number.isNaN(expiry.getTime())) return null;
    return Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  };

  const fefoPriority = (row: LotRow) => {
    const d = daysLeftFn(row.expiryDate);
    if (d == null) return { label: "No expiry", className: "text-muted-foreground" };
    if (d < 0) return { label: "Expired", className: "text-rose-700 font-semibold" };
    if (d <= highExpiryDays) return { label: "High", className: "text-rose-700 font-semibold" };
    if (d <= mediumExpiryDays)
      return { label: "Medium", className: "text-amber-700 font-semibold" };
    return { label: "Low", className: "text-emerald-700 font-semibold" };
  };

  const isExpiredLot = (row: LotRow) =>
    row.expiryDate != null && new Date(row.expiryDate) <= now;

  // --- Lot actions ---
  const openAdjust = (row: LotRow) => {
    setAdjustLot(row);
    setAdjustQty("");
    setAdjustReason(isExpiredLot(row) ? "Expired" : "Damaged");
    setAdjustNote("");
    setAdjustError("");
    setAdjustOpen(true);
  };

  const openTrace = (row: LotRow) => {
    setTraceLotRow(row);
    setTraceLotId(row.id);
    setTraceOpen(true);
  };

  // --- Trace CSV exports ---
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
      ["LOT", "Expiry Date", JSON.stringify(traceData.lot.expiryDate ? new Date(traceData.lot.expiryDate).toISOString().slice(0, 10) : "")].join(","),
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
      sourcePage: "admin/inventory-lots",
      rowCount: lines.length - 1,
      columnCount: 3,
      byteSize: blob.size,
      scopeSnapshot: `Lot: ${traceData.lot.lotCode || traceData.lot.id}`,
      totalCount: traceData.movementTotal || traceData.movements?.length || 0,
      matchingCount: traceData.movements?.length || 0,
      resultSummary: `Downloaded lot trace summary for ${traceData.lot.lotCode || traceData.lot.id}.`,
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
      ["LOT", "Expiry Date", JSON.stringify(traceData.lot.expiryDate ? new Date(traceData.lot.expiryDate).toISOString().slice(0, 10) : "")].join(","),
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
      sourcePage: "admin/inventory-lots",
      rowCount: lines.length - 1,
      columnCount: 6,
      byteSize: blob.size,
      scopeSnapshot: `Lot: ${traceData.lot.lotCode || traceData.lot.id}`,
      totalCount: traceData.movementTotal || traceData.movements?.length || 0,
      matchingCount: traceData.movements?.length || 0,
      resultSummary: `Downloaded combined lot trace export for ${traceData.lot.lotCode || traceData.lot.id}.`,
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
      sourcePage: "admin/inventory-lots",
      rowCount: lines.length - 1,
      columnCount: 6,
      byteSize: blob.size,
      scopeSnapshot: `Lot: ${traceData.lot.lotCode || traceData.lot.id}`,
      totalCount: traceData.movementTotal || traceData.movements?.length || 0,
      matchingCount: traceData.movements?.length || 0,
      resultSummary: `Downloaded lot movement export for ${traceData.lot.lotCode || traceData.lot.id}.`,
    });
  };

  // --- Adjust submit ---
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
    if (!Number.isInteger(qty)) {
      setAdjustError("Quantity must be a whole number.");
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
      if (!res.ok) throw new Error(payload?.error || "Failed to adjust lot.");
      if (payload?.message === "No change") {
        toast.info("No changes were applied.");
        return;
      }
      toast.success("Adjustment successful.");
      setAdjustOpen(false);
      setAdjustLot(null);
      await refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to adjust lot.";
      setAdjustError(message);
      toast.error(message);
    } finally {
      setAdjustSubmitting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const listboxId = "product-suggestions-listbox";

  return (
    <section className="container mx-auto py-8 space-y-4">
      {/* Page header */}
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
          {isAdmin ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/audit?sourcePage=admin%2Finventory-lots">Open lot audit</Link>
            </Button>
          ) : null}
        </div>
      </div>

      {/* Filters — always visible so user can adjust and retry on error */}
      <Card id="filters">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Product combobox */}
          <div className="space-y-1 relative" ref={suggestionsRef}>
            <Label htmlFor="product-combobox" className="text-xs text-muted-foreground">
              Product
            </Label>
            <div className="relative">
              <input
                id="product-combobox"
                role="combobox"
                aria-label="Product"
                aria-expanded={showSuggestions && productSuggestions.length > 0}
                aria-controls={listboxId}
                aria-autocomplete="list"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="Search by product name or SKU"
                value={productSearch}
                autoComplete="off"
                onChange={(e) => {
                  setProductSearch(e.target.value);
                  if (!e.target.value) clearProduct();
                  setActiveSuggestionIndex(-1);
                  setShowSuggestions(true);
                }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                onKeyDown={handleProductKeyDown}
              />
              {productId && (
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                  onClick={clearProduct}
                  tabIndex={-1}
                  aria-label="Clear product filter"
                >
                  ✕
                </button>
              )}
            </div>
            {showSuggestions && productSuggestions.length > 0 && (
              <div
                id={listboxId}
                role="listbox"
                aria-label="Product suggestions"
                className="absolute z-20 top-full left-0 right-0 mt-0.5 rounded-md border bg-background shadow-md"
              >
                {productSuggestions.map((p, i) => (
                  <div
                    key={p.id}
                    role="option"
                    aria-selected={i === activeSuggestionIndex}
                    className={`flex items-baseline gap-2 px-3 py-2 text-sm cursor-pointer ${
                      i === activeSuggestionIndex ? "bg-muted" : "hover:bg-muted"
                    }`}
                    onMouseDown={() => selectProduct(p)}
                  >
                    <span>{p.name}</span>
                    {p.sku && (
                      <span className="text-xs text-muted-foreground">{p.sku}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Lot code search */}
          <div className="space-y-1">
            <Label htmlFor="lot-code-search" className="text-xs text-muted-foreground">
              Lot code
            </Label>
            <Input
              id="lot-code-search"
              placeholder="Search lot code"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
            />
          </div>

          {/* Status */}
          <div className="space-y-1">
            <Label htmlFor="status-filter" className="text-xs text-muted-foreground">
              Status
            </Label>
            <select
              id="status-filter"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={status}
              onChange={(e) => pushUrl({ status: e.target.value || null }, true)}
            >
              <option value="">All status</option>
              <option value="ACTIVE">Active</option>
              <option value="EXPIRED">Expired</option>
            </select>
          </div>

          {/* Expiry from */}
          <div className="space-y-1">
            <Label htmlFor="exp-start" className="text-xs text-muted-foreground">
              Expiry from
            </Label>
            <Input
              id="exp-start"
              type="date"
              value={expStart}
              onChange={(e) => handleExpStartChange(e.target.value)}
            />
          </div>

          {/* Expiry to */}
          <div className="space-y-1">
            <Label htmlFor="exp-end" className="text-xs text-muted-foreground">
              Expiry to
            </Label>
            <Input
              id="exp-end"
              type="date"
              value={expEnd}
              onChange={(e) => handleExpEndChange(e.target.value)}
            />
          </div>

          {/* Expiry window */}
          <div className="space-y-1">
            <Label htmlFor="expiry-window" className="text-xs text-muted-foreground">
              Expiry window
            </Label>
            <select
              id="expiry-window"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={expiringWithin}
              onChange={(e) => handleExpiryWindowChange(e.target.value)}
            >
              <option value="">All</option>
              <option value={String(highExpiryDays)}>Expiring in {highExpiryDays}d</option>
              <option value={String(mediumExpiryDays)}>Expiring in {mediumExpiryDays}d</option>
              <option value="90">Expiring in 90d</option>
            </select>
          </div>

          {/* Export buttons */}
          <div className="sm:col-span-2 lg:col-span-3">
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

      {/* ---- Error state: replaces Summary + List + Compliance ---- */}
      {listError ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-4 text-center">
            <h2 className="text-lg font-semibold text-destructive">Inventory Lots Unavailable</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              The server returned an error loading lot data. This may be a permissions issue or a
              temporary outage. Check the network tab for details, then retry.
            </p>
            <Button
              variant="outline"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap">
              <CardTitle>Summary</CardTitle>
              {isFetching && (
                <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>
              )}
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
                <div className="text-lg font-semibold text-rose-700">
                  {summary?.expiredLots ?? 0}
                </div>
              </div>
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">{`Expiring 0–${highExpiryDays}d`}</div>
                <div className="text-lg font-semibold text-amber-700">
                  {summary?.expiringHigh ?? summary?.expiring30 ?? 0}
                </div>
              </div>
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">{`Expiring ${highExpiryDays + 1}–${mediumExpiryDays}d`}</div>
                <div className="text-lg font-semibold text-yellow-700">
                  {summary?.expiringMedium ?? summary?.expiring60 ?? 0}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Lot list */}
          <Card id="lot-list">
            <CardHeader>
              <CardTitle>Lot list</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 overflow-x-auto">
              <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                <div className="font-medium text-foreground mb-1">
                  Expiry threshold legend (FEFO)
                </div>
                <div className="flex flex-wrap gap-3">
                  <span>
                    <span className="font-semibold text-rose-700">High:</span> 0–{highExpiryDays}d
                  </span>
                  <span>
                    <span className="font-semibold text-amber-700">Medium:</span>{" "}
                    {highExpiryDays + 1}–{mediumExpiryDays}d
                  </span>
                  <span>
                    <span className="font-semibold text-emerald-700">Low:</span>{" "}
                    {mediumExpiryDays + 1}+d
                  </span>
                  <span>
                    <span className="font-semibold text-muted-foreground">No expiry:</span> no
                    expiry date set
                  </span>
                </div>
              </div>

              {!isFetching && rows.length === 0 ? (
                <div className="text-sm text-muted-foreground py-4 text-center">
                  No lots found.
                </div>
              ) : isFetching && rows.length === 0 ? (
                <div className="space-y-2 py-2">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="h-8 rounded bg-muted/40 animate-pulse" />
                  ))}
                </div>
              ) : (
                <>
                  <table className="w-full text-sm text-left">
                    <thead>
                      <tr className="border-b">
                        <th className="py-2 pr-3">
                          <button
                            type="button"
                            aria-label="Sort by Product"
                            className="text-left font-semibold hover:underline"
                            onClick={() => handleSort("productName")}
                          >
                            Product{sortBy === "productName" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                          </button>
                        </th>
                        <th className="py-2 pr-3">
                          <button
                            type="button"
                            aria-label="Sort by Lot code"
                            className="text-left font-semibold hover:underline"
                            onClick={() => handleSort("lotCode")}
                          >
                            Lot{sortBy === "lotCode" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                          </button>
                        </th>
                        <th className="py-2 pr-3 text-center">FEFO Priority</th>
                        <th className="py-2 pr-3">
                          <button
                            type="button"
                            aria-label="Sort by Expiry date"
                            className="text-left font-semibold hover:underline"
                            onClick={() => handleSort("expiryDate")}
                          >
                            Expiry{sortBy === "expiryDate" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                          </button>
                        </th>
                        <th className="py-2 pr-3 text-center">Days left</th>
                        <th className="py-2 pr-3">
                          <button
                            type="button"
                            aria-label="Sort by Received date"
                            className="text-left font-semibold hover:underline"
                            onClick={() => handleSort("receivedAt")}
                          >
                            Received{sortBy === "receivedAt" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                          </button>
                        </th>
                        <th className="py-2 pr-3 text-center">
                          <button
                            type="button"
                            aria-label="Sort by Qty received"
                            className="text-left font-semibold hover:underline"
                            onClick={() => handleSort("quantityReceived")}
                          >
                            Rcvd{sortBy === "quantityReceived" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                          </button>
                        </th>
                        <th className="py-2 pr-3 text-center">
                          <button
                            type="button"
                            aria-label="Sort by Qty remaining"
                            className="text-left font-semibold hover:underline"
                            onClick={() => handleSort("quantityRemaining")}
                          >
                            Remaining{sortBy === "quantityRemaining" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                          </button>
                        </th>
                        <th className="py-2 pr-3">
                          <button
                            type="button"
                            aria-label="Sort by Supplier"
                            className="text-left font-semibold hover:underline"
                            onClick={() => handleSort("supplierName")}
                          >
                            Supplier{sortBy === "supplierName" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                          </button>
                        </th>
                        <th className="py-2 pr-3">Notes</th>
                        <th className="py-2 pr-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr
                          key={row.id}
                          className={`border-b last:border-0 ${isExpiredLot(row) ? "bg-rose-50" : ""}`}
                        >
                          <td className="py-2 pr-3">
                            <div>{row.productName}</div>
                            <div className="text-xs text-muted-foreground">
                              {row.productSku || "No SKU"}
                            </div>
                          </td>
                          <td className="py-2 pr-3">{row.lotCode}</td>
                          <td className={`py-2 pr-3 text-center ${fefoPriority(row).className}`}>
                            {fefoPriority(row).label}
                          </td>
                          <td className="py-2 pr-3">
                            {row.expiryDate
                              ? new Date(row.expiryDate).toLocaleDateString()
                              : "-"}
                          </td>
                          <td
                            className={`py-2 pr-3 text-center ${expiryCellStyle(row.expiryDate)}`}
                          >
                            {formatDaysToExpiry(row.expiryDate)}
                          </td>
                          <td className="py-2 pr-3">
                            {new Date(row.receivedAt).toLocaleDateString()}
                          </td>
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
                                Adjust
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Pagination */}
                  {totalItems > 0 && (
                    <div className="flex items-center justify-between gap-2 pt-2 text-sm">
                      <span className="text-muted-foreground text-xs">
                        {`Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, totalItems)} of ${totalItems} lots`}
                      </span>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={page <= 1}
                          onClick={() => pushUrl({ page: String(page - 1) }, false)}
                        >
                          Previous
                        </Button>
                        <span className="px-2 text-xs text-muted-foreground">
                          Page {page} of {totalPages}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={page >= totalPages}
                          onClick={() => pushUrl({ page: String(page + 1) }, false)}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Compliance */}
          <Card id="compliance">
            <CardHeader>
              <CardTitle>Compliance report</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p className="text-xs text-muted-foreground">
                Compliance results honour the current filters. Expiry-window filtering narrows to
                items expiring soon, plus any regulated SKUs missing expiry dates.
              </p>
              <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                <div className="font-medium text-foreground mb-1">Resolution checklist</div>
                <div>
                  Missing expiry lots: update the lot with a valid expiry date or correct the
                  product requirement.
                </div>
                <div>
                  Untracked movements: ensure the SKU has lots and re-enter adjustments with lot
                  codes.
                </div>
                <div>
                  Stock without lot coverage: create/import lots to cover stock or adjust stock
                  down.
                </div>
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
                    Lots missing expiry
                    {(compliance.missingExpiryLots ?? 0) > compliance.missingExpirySamples.length
                      ? ` — showing ${compliance.missingExpirySamples.length} of ${compliance.missingExpiryLots}`
                      : ""}
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
                              <div className="text-xs text-muted-foreground">
                                {row.productSku || "No SKU"}
                              </div>
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
                    Stock without lot coverage
                    {(compliance.missingLotCoverage ?? 0) > compliance.missingCoverageSamples.length
                      ? ` — showing ${compliance.missingCoverageSamples.length} of ${compliance.missingLotCoverage}`
                      : ""}
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
                              <div className="text-xs text-muted-foreground">
                                {row.productSku || "No SKU"}
                              </div>
                            </td>
                            <td className="py-2 pr-3 text-center">{row.stock}</td>
                            <td className="py-2 pr-3 text-center">{row.trackedRemaining}</td>
                            <td className="py-2 pr-3 text-center text-amber-700 font-semibold">
                              {row.missingUnits}
                            </td>
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
                    Movements without lot (regulated SKUs)
                    {(compliance.missingLotMovements ?? 0) >
                    compliance.missingMovementSamples.length
                      ? ` — showing ${compliance.missingMovementSamples.length} of ${compliance.missingLotMovements}`
                      : ""}
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
                              <div className="text-xs text-muted-foreground">
                                {row.productSku || "No SKU"}
                              </div>
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
        </>
      )}

      {/* Trace dialog */}
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
            <DialogDescription>
              Review the lot profile, purchase context, and movement history for this tracked batch.
            </DialogDescription>
          </DialogHeader>
          {traceLoading ? (
            <div className="text-sm text-muted-foreground">Loading lot trace…</div>
          ) : traceError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Failed to load lot trace. The lot may have been deleted, or the server returned an
              error. Try closing and reopening the trace.
            </div>
          ) : traceData?.lot ? (
            <div className="space-y-4 text-sm">
              {/* Truncation warning */}
              {traceData.movementsTruncated && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  This lot has{" "}
                  <span className="font-semibold">{traceData.movementTotal}</span> movements. Only
                  the first 200 are shown. Exports below also contain only the first 200. Use{" "}
                  <a
                    className="underline font-medium"
                    href={`/admin/movements?product=${encodeURIComponent(
                      traceData.lot.product?.id || traceLotRow?.productId || "",
                    )}&lotId=${encodeURIComponent(traceData.lot.id)}`}
                  >
                    View all lot movements
                  </a>{" "}
                  to see the complete history.
                </div>
              )}

              {/* Export buttons */}
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="outline" onClick={downloadTraceCombinedCsv}>
                  {traceData.movementsTruncated
                    ? `Export CSV (first 200 of ${traceData.movementTotal})`
                    : "Export full CSV"}
                </Button>
                {(traceData.movements?.length || 0) > 1 && (
                  <>
                    <Button size="sm" variant="outline" onClick={downloadTraceSummaryCsv}>
                      Summary CSV
                    </Button>
                    <Button size="sm" variant="outline" onClick={downloadTraceMovementsCsv}>
                      Movements CSV
                    </Button>
                  </>
                )}
              </div>

              <div className="rounded-md border px-3 py-2">
                <div className="font-medium">
                  {traceData.lot.product?.name || traceLotRow?.productName || "-"} |{" "}
                  {traceData.lot.lotCode}
                </div>
                <div className="text-xs text-muted-foreground">
                  SKU: {traceData.lot.product?.sku || traceLotRow?.productSku || "No SKU"} |
                  Supplier: {traceData.lot.supplier?.name || "-"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Received: {new Date(traceData.lot.receivedAt).toLocaleString()} | Expiry:{" "}
                  {traceData.lot.expiryDate
                    ? new Date(traceData.lot.expiryDate).toLocaleDateString()
                    : "-"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Qty received: {traceData.lot.quantityReceived} | Qty remaining:{" "}
                  {traceData.lot.quantityRemaining}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Source purchase
                </div>
                {traceData.lot.purchase ? (
                  <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground space-y-1">
                    <div>Purchase ID: {traceData.lot.purchase.id}</div>
                    <div>Status: {traceData.lot.purchase.status}</div>
                    <div>
                      Ordered/Received: {traceData.lot.purchase.orderedQuantity} /{" "}
                      {traceData.lot.purchase.receivedQuantity}
                    </div>
                    <div>
                      Unit cost: GHS{" "}
                      {Number(traceData.lot.purchase.unitCost || 0).toFixed(2)}
                    </div>
                    <div>
                      Created: {new Date(traceData.lot.purchase.createdAt).toLocaleString()}
                    </div>
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
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    Lot movements
                  </div>
                  <a
                    className="text-xs underline"
                    href={`/admin/movements?product=${encodeURIComponent(
                      traceData.lot.product?.id || traceLotRow?.productId || "",
                    )}&lotId=${encodeURIComponent(traceData.lot.id)}`}
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
                            <td className="py-2 pr-3">
                              {new Date(move.createdAt).toLocaleString()}
                            </td>
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

      {/* Adjust dialog */}
      <Dialog open={adjustOpen} onOpenChange={(open) => !open && setAdjustOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust lot</DialogTitle>
            <DialogDescription>
              Update the remaining quantity for this lot and store the reason in the audit trail.
            </DialogDescription>
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
                  {adjustLot.expiryDate
                    ? new Date(adjustLot.expiryDate).toLocaleDateString()
                    : "—"}
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
                    step="1"
                    value={adjustQty}
                    onChange={(e) => setAdjustQty(e.target.value)}
                    placeholder={String(adjustLot.quantityRemaining ?? 0)}
                    onFocus={(e) => e.currentTarget.select()}
                    autoComplete="off"
                  />
                  {!hasRequestedQty ? (
                    <div className="text-xs text-muted-foreground">
                      Enter a different whole number to apply an adjustment.
                    </div>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="adjustReason">Reason</Label>
                  <select
                    id="adjustReason"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    value={adjustReason}
                    onChange={(e) => setAdjustReason(e.target.value)}
                  >
                    <option
                      value="Expired"
                      disabled={
                        !!adjustLot.expiryDate && new Date(adjustLot.expiryDate) > new Date()
                      }
                    >
                      Expired
                    </option>
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
              {adjustError ? (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {adjustError}
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAdjustOpen(false)}
              disabled={adjustSubmitting}
            >
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
