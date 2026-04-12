"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { Suspense, type ReactNode, type DragEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { useClientQuery } from "@/hooks/use-client-query";
import { formatCurrency } from "@/lib/currency";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ChevronLeft,
  ChevronRight,
  History,
  Info,
  PackagePlus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDebounce } from "use-debounce";
import { toast } from "sonner";
import { chipToneClass, stockStatusTone } from "@/lib/status-chips";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

type SortKey = "price" | "stock" | "totalValue" | "salesValue" | "costValue";

type ColumnDef = {
  id: string;
  label: string;
  tooltip: string;
  visible: boolean;
  sortable?: boolean;
  sortKey?: SortKey;
  headerClassName?: string;
  cellClassName?: string;
  renderCell: (row: Row) => ReactNode;
};

type InventorySavedFilter = {
  id: string;
  name: string;
  state: {
    q: string;
    minStock: string;
    maxStock: string;
    minPrice: string;
    maxPrice: string;
    includeArchived: boolean;
    sortKey: SortKey | null;
    sortDir: "asc" | "desc";
    valuationMode: "sales" | "cost";
  };
};

type Row = {
  id: string;
  sku?: string | null;
  name: string;
  requiresLotTracking?: boolean;
  requiresExpiryDate?: boolean;
  price: number;
  cost?: number;
  stock: number;
  totalValue: number;
  avgPurchaseCost?: number | null;
  lastPurchaseCost?: number | null;
  lastPurchaseDate?: string | null;
  lastPurchaseSupplier?: string | null;
  lastPurchaseNote?: string | null;
  soldLast30?: number | null;
  avgDailySales?: number | null;
  daysOfStock?: number | null;
  weeksCover?: number | null;
  reorderPoint?: number | null;
  suggestedReorder?: number | null;
};

type AlertRow = {
  id: string;
  productId: string;
  name: string;
  price: number | string;
  stock: number;
  updatedAt: string | Date;
  type: string;
  severity: "critical" | "warning";
  message: string;
};

type InventoryResponse = {
  rows: Row[];
  totalCount: number;
  matchingCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  filteredTotals: {
    priceValue: number;
    costValue: number;
  };
};

const defaultColumnOrder = [
  "item",
  "price",
  "cost",
  "lastUnitCost",
  "lastPurchase",
  "lastSupplier",
  "stock",
  "status",
  "daysOfStock",
  "weeksCover",
  "salesValue",
  "costValue",
  "expectedPL",
  "reorderPoint",
  "suggestedReorder",
  "actions",
];

const INVENTORY_SAVED_FILTERS_KEY = "inventory.savedFilters";
const LEGACY_INVENTORY_SAVED_FILTERS_STORAGE_KEY =
  "admin-inventory-saved-filters";
const MAX_VISIBLE_ALERTS = 8;
const INVENTORY_PAGE_SIZE = 50;
const defaultOptionalColumnVisibility = {
  lastUnitCost: false,
  lastPurchase: false,
  lastSupplier: false,
  daysOfStock: true,
  weeksCover: false,
  expectedPL: false,
  reorderPoint: false,
  suggestedReorder: false,
};

function getRowMetrics(row: Row) {
  const salesValue = Number(row.price || 0) * Number(row.stock || 0);
  const unitCost =
    typeof row.avgPurchaseCost === "number" &&
    !Number.isNaN(row.avgPurchaseCost)
      ? row.avgPurchaseCost
      : typeof row.lastPurchaseCost === "number" &&
          !Number.isNaN(row.lastPurchaseCost)
        ? row.lastPurchaseCost
        : Number(row.cost || 0);
  const costValue = unitCost * Number(row.stock || 0);
  return {
    salesValue,
    costValue,
    unitCost,
    expectedProfit: salesValue - costValue,
  };
}

function getRowLowStockThreshold(row: Pick<Row, "reorderPoint">) {
  return Math.max(0, Number(row.reorderPoint ?? 0));
}

function getRowStatusLabel(row: Pick<Row, "stock" | "reorderPoint">) {
  const stock = Number(row.stock || 0);
  if (stock <= 0) return "Out";
  return stock <= getRowLowStockThreshold(row) ? "Low" : "OK";
}

function hasPurchaseDetails(row: Row) {
  return Boolean(
    row.lastPurchaseDate ||
      typeof row.lastPurchaseCost === "number" ||
      row.lastPurchaseSupplier ||
      row.lastPurchaseNote,
  );
}

function mergeSavedFilters(
  primary: InventorySavedFilter[],
  secondary: InventorySavedFilter[],
) {
  const seen = new Set<string>();
  const merged: InventorySavedFilter[] = [];
  for (const entry of [...primary, ...secondary]) {
    if (!entry?.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

function getCreatePurchaseHref(productId: string) {
  return `/admin/purchases?product=${encodeURIComponent(productId)}&new=1`;
}

function InventoryContent() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const userRole = session?.user?.role as
    | "ADMIN"
    | "STAFF"
    | "ACCOUNTANT"
    | undefined;
  const canManageProducts = userRole === "ADMIN" || userRole === "STAFF";
  const canCreatePurchases = userRole === "ADMIN";
  const canViewMovements = userRole === "ADMIN" || userRole === "STAFF";
  const canAdjustInventoryValue =
    userRole === "ADMIN" || userRole === "ACCOUNTANT";
  const { data: alertData, isLoading: alertsLoading } = useClientQuery<
    AlertRow[]
  >({
    queryKey: ["admin", "inventory-alerts"],
    queryFn: () => fetcher("/api/admin/inventory-alerts"),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [q, setQ] = useState("");
  const [qDeb] = useDebounce(q, 300);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [minStock, setMinStock] = useState<string>("");
  const [maxStock, setMaxStock] = useState<string>("");
  const [minPrice, setMinPrice] = useState<string>("");
  const [maxPrice, setMaxPrice] = useState<string>("");
  const [stockRangeError, setStockRangeError] = useState("");
  const [priceRangeError, setPriceRangeError] = useState("");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [valuationMode, setValuationMode] = useState<"sales" | "cost">("sales");
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoRow, setInfoRow] = useState<Row | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustRow, setAdjustRow] = useState<Row | null>(null);
  const [adjustCost, setAdjustCost] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [updatedAtText, setUpdatedAtText] = useState<string>("");
  const [showLastUnitCost, setShowLastUnitCost] = useState(
    defaultOptionalColumnVisibility.lastUnitCost,
  );
  const [showLastPurchase, setShowLastPurchase] = useState(
    defaultOptionalColumnVisibility.lastPurchase,
  );
  const [showLastSupplier, setShowLastSupplier] = useState(
    defaultOptionalColumnVisibility.lastSupplier,
  );
  const [showDaysOfStock, setShowDaysOfStock] = useState(
    defaultOptionalColumnVisibility.daysOfStock,
  );
  const [showWeeksCover, setShowWeeksCover] = useState(
    defaultOptionalColumnVisibility.weeksCover,
  );
  const [showExpectedPL, setShowExpectedPL] = useState(
    defaultOptionalColumnVisibility.expectedPL,
  );
  const [showReorderPoint, setShowReorderPoint] = useState(
    defaultOptionalColumnVisibility.reorderPoint,
  );
  const [showSuggestedReorder, setShowSuggestedReorder] = useState(
    defaultOptionalColumnVisibility.suggestedReorder,
  );
  const [columnOrder, setColumnOrder] = useState<string[]>(defaultColumnOrder);
  const [orderLoaded, setOrderLoaded] = useState(false);
  const [visibilityLoaded, setVisibilityLoaded] = useState(false);
  const [savedFilters, setSavedFilters] = useState<InventorySavedFilter[]>([]);
  const [savedFiltersLoaded, setSavedFiltersLoaded] = useState(false);
  const [saveFilterOpen, setSaveFilterOpen] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState("");
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const pendingLegacySavedFiltersCleanup = useRef(false);
  const orderPersistenceReady = useRef(false);
  const visibilityPersistenceReady = useRef(false);
  const resizing = useRef<{
    key: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    item: 240,
    price: 120,
    cost: 120,
    lastUnitCost: 150,
    lastPurchase: 150,
    lastSupplier: 160,
    stock: 110,
    status: 120,
    daysOfStock: 130,
    weeksCover: 140,
    salesValue: 150,
    costValue: 150,
    expectedPL: 150,
    reorderPoint: 150,
    suggestedReorder: 170,
    actions: 170,
  });

  const inventoryQueryString = useMemo(() => {
    const params = new URLSearchParams();
    if (includeArchived) params.set("includeArchived", "1");
    if (qDeb) params.set("q", qDeb);
    if (minStock) params.set("minStock", minStock);
    if (maxStock) params.set("maxStock", maxStock);
    if (minPrice) params.set("minPrice", minPrice);
    if (maxPrice) params.set("maxPrice", maxPrice);
    if (sortKey) params.set("sortKey", sortKey);
    if (sortKey) params.set("sortDir", sortDir);
    params.set("page", String(currentPage));
    params.set("pageSize", String(INVENTORY_PAGE_SIZE));
    return params.toString();
  }, [
    currentPage,
    includeArchived,
    maxPrice,
    maxStock,
    minPrice,
    minStock,
    qDeb,
    sortDir,
    sortKey,
  ]);

  const { data, isLoading, dataUpdatedAt } = useClientQuery<InventoryResponse>({
    queryKey: ["admin", "inventory", inventoryQueryString],
    queryFn: () => fetcher(`/api/admin/inventory?${inventoryQueryString}`),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const rows: Row[] = useMemo(() => data?.rows || [], [data]);
  const alerts = useMemo(
    () => (Array.isArray(alertData) ? alertData : []),
    [alertData],
  );

  const openAdjust = (row: Row) => {
    setAdjustRow(row);
    setAdjustCost(String(Number(row.cost || 0)));
    setAdjustReason("");
    setAdjustOpen(true);
  };

  const persistPreference = useCallback(async (
    key: string,
    value: unknown,
    options?: {
      signal?: AbortSignal;
      skipAudit?: boolean;
      section?: string;
      auditAction?: string;
      resultSummary?: string;
    },
  ) => {
    const body = options?.skipAudit
      ? { key, value, skipAudit: true }
      : {
          key,
          value,
          sourcePage: "admin/inventory",
          section: options?.section,
          auditAction: options?.auditAction,
          resultSummary: options?.resultSummary,
        };
    const res = await fetch("/api/admin/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!res.ok) {
      throw new Error("Failed to save preference.");
    }
    return res;
  }, []);

  const submitAdjust = async () => {
    if (!adjustRow) return;
    const nextCost = Number(adjustCost);
    if (!Number.isFinite(nextCost) || nextCost < 0) {
      toast.error("Enter a valid unit cost.");
      return;
    }
    if (!adjustReason.trim()) {
      toast.error("Add a reason for this adjustment.");
      return;
    }
    try {
      setAdjusting(true);
      const res = await fetch("/api/admin/accounting/inventory-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: adjustRow.id,
          newUnitCost: nextCost,
          reason: adjustReason.trim(),
          sourcePage: "admin/inventory",
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to post adjustment.");
      toast.success("Inventory revaluation posted.");
      setAdjustOpen(false);
      setAdjustRow(null);
      queryClient.invalidateQueries({ queryKey: ["admin", "inventory"] });
    } catch (e: unknown) {
      toast.error(
        e instanceof Error ? e.message : "Failed to post adjustment.",
      );
    } finally {
      setAdjusting(false);
    }
  };

  const persistSavedFilters = useCallback(async (
    nextFilters: InventorySavedFilter[],
    options?: {
      cleanupLegacy?: boolean;
      skipAudit?: boolean;
      auditAction?: string;
      resultSummary?: string;
    },
  ) => {
    await persistPreference(INVENTORY_SAVED_FILTERS_KEY, nextFilters, {
      skipAudit: options?.skipAudit,
      section: "saved-filters",
      auditAction: options?.auditAction,
      resultSummary:
        options?.resultSummary ||
        `Inventory saved filters updated (${nextFilters.length} saved).`,
    });
    if (options?.cleanupLegacy && typeof window !== "undefined") {
      window.localStorage.removeItem(LEGACY_INVENTORY_SAVED_FILTERS_STORAGE_KEY);
      pendingLegacySavedFiltersCleanup.current = false;
    }
  }, [persistPreference]);

  useEffect(() => {
    if (!minStock || !maxStock) {
      setStockRangeError("");
      return;
    }
    const min = Number(minStock);
    const max = Number(maxStock);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      setStockRangeError("Enter valid numbers for stock range.");
      return;
    }
    setStockRangeError(min > max ? "Min stock cannot exceed max stock." : "");
  }, [minStock, maxStock]);

  useEffect(() => {
    if (!minPrice || !maxPrice) {
      setPriceRangeError("");
      return;
    }
    const min = Number(minPrice);
    const max = Number(maxPrice);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      setPriceRangeError("Enter valid numbers for price range.");
      return;
    }
    setPriceRangeError(min > max ? "Min price cannot exceed max price." : "");
  }, [minPrice, maxPrice]);

  // Initialize from URL
  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams?.toString() || "");
    const q0 = sp.get("q") || "";
    const ms0 = sp.get("minStock") || "";
    const xs0 = sp.get("maxStock") || "";
    const mp0 = sp.get("minPrice") || "";
    const xp0 = sp.get("maxPrice") || "";
    const ia0 = sp.get("includeArchived") === "1";
    const page0 = Math.max(1, Number(sp.get("page") || 1) || 1);
    const sk0 = sp.get("sortKey") as
      | "price"
      | "stock"
      | "totalValue"
      | "salesValue"
      | "costValue"
      | null;
    const sd0 = sp.get("sortDir") as "asc" | "desc" | null;
    setQ(q0);
    setMinStock(ms0);
    setMaxStock(xs0);
    setMinPrice(mp0);
    setMaxPrice(xp0);
    setIncludeArchived(ia0);
    setCurrentPage(page0);
    if (
      sk0 &&
      ["price", "stock", "totalValue", "salesValue", "costValue"].includes(sk0)
    ) {
      setSortKey(sk0);
    }
    if (sd0 && ["asc", "desc"].includes(sd0)) setSortDir(sd0);
    initialized.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect to URL (avoid using searchParams as a dependency to prevent loops)
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    else params.delete("q");
    if (minStock) params.set("minStock", minStock);
    else params.delete("minStock");
    if (maxStock) params.set("maxStock", maxStock);
    else params.delete("maxStock");
    if (minPrice) params.set("minPrice", minPrice);
    else params.delete("minPrice");
    if (maxPrice) params.set("maxPrice", maxPrice);
    else params.delete("maxPrice");
    if (includeArchived) params.set("includeArchived", "1");
    else params.delete("includeArchived");
    if (currentPage > 1) params.set("page", String(currentPage));
    else params.delete("page");
    if (sortKey) params.set("sortKey", sortKey);
    else params.delete("sortKey");
    if (sortKey) params.set("sortDir", sortDir);
    else params.delete("sortDir");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [
    q,
    minStock,
    maxStock,
    minPrice,
    maxPrice,
    includeArchived,
    currentPage,
    sortKey,
    sortDir,
    pathname,
    router,
  ]);

  useEffect(() => {
    if (!dataUpdatedAt) return;
    setUpdatedAtText(new Date(dataUpdatedAt).toLocaleTimeString());
  }, [dataUpdatedAt]);

  useEffect(() => {
    let cancelled = false;
    async function loadColumnOrder() {
      try {
        const res = await fetch(
          "/api/admin/preferences?key=inventory.columns.order",
        );
        if (!res.ok) return;
        const json = await res.json().catch(() => null);
        const value = Array.isArray(json?.value) ? json.value : null;
        if (!value || cancelled) return;
        const filtered = value.filter((id: string) =>
          defaultColumnOrder.includes(id),
        );
        const merged = [
          ...filtered,
          ...defaultColumnOrder.filter((id) => !filtered.includes(id)),
        ];
        setColumnOrder(merged);
      } catch {
        // ignore preference load failures
      } finally {
        if (!cancelled) setOrderLoaded(true);
      }
    }
    loadColumnOrder();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!orderLoaded) return;
    if (!orderPersistenceReady.current) {
      orderPersistenceReady.current = true;
      return;
    }
    const controller = new AbortController();
    void persistPreference("inventory.columns.order", columnOrder, {
      signal: controller.signal,
      section: "layout",
      auditAction: "INVENTORY_LAYOUT_UPDATE",
      resultSummary: `Inventory column order updated (${columnOrder.length} columns).`,
    }).catch(() => {});
    return () => controller.abort();
  }, [columnOrder, orderLoaded, persistPreference]);

  useEffect(() => {
    let cancelled = false;
    async function loadVisibility() {
      try {
        const res = await fetch(
          "/api/admin/preferences?key=inventory.columns.visibility",
        );
        if (!res.ok) return;
        const json = await res.json().catch(() => null);
        const value = json?.value as Record<string, unknown> | null;
        if (!value || typeof value !== "object" || cancelled) return;
        if ("lastUnitCost" in value)
          setShowLastUnitCost(Boolean(value.lastUnitCost));
        if ("lastPurchase" in value)
          setShowLastPurchase(Boolean(value.lastPurchase));
        if ("lastSupplier" in value)
          setShowLastSupplier(Boolean(value.lastSupplier));
        if ("daysOfStock" in value)
          setShowDaysOfStock(Boolean(value.daysOfStock));
        if ("weeksCover" in value) setShowWeeksCover(Boolean(value.weeksCover));
        if ("expectedPL" in value) setShowExpectedPL(Boolean(value.expectedPL));
        if ("reorderPoint" in value)
          setShowReorderPoint(Boolean(value.reorderPoint));
        if ("suggestedReorder" in value)
          setShowSuggestedReorder(Boolean(value.suggestedReorder));
      } catch {
        // ignore preference load failures
      } finally {
        if (!cancelled) setVisibilityLoaded(true);
      }
    }
    loadVisibility();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!visibilityLoaded) return;
    if (!visibilityPersistenceReady.current) {
      visibilityPersistenceReady.current = true;
      return;
    }
    const controller = new AbortController();
    const visibilityState = {
      lastUnitCost: showLastUnitCost,
      lastPurchase: showLastPurchase,
      lastSupplier: showLastSupplier,
      daysOfStock: showDaysOfStock,
      weeksCover: showWeeksCover,
      expectedPL: showExpectedPL,
      reorderPoint: showReorderPoint,
      suggestedReorder: showSuggestedReorder,
    };
    const visibleCount = Object.values(visibilityState).filter(Boolean).length;
    void persistPreference("inventory.columns.visibility", visibilityState, {
      signal: controller.signal,
      section: "layout",
      auditAction: "INVENTORY_LAYOUT_UPDATE",
      resultSummary: `Inventory column visibility updated (${visibleCount} optional columns visible).`,
    }).catch(() => {});
    return () => controller.abort();
  }, [
    showLastUnitCost,
    showLastPurchase,
    showLastSupplier,
    showDaysOfStock,
    showWeeksCover,
    showExpectedPL,
    showReorderPoint,
    showSuggestedReorder,
    visibilityLoaded,
    persistPreference,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function loadSavedFilters() {
      let serverLoadSucceeded = false;
      try {
        const res = await fetch(
          `/api/admin/preferences?key=${encodeURIComponent(INVENTORY_SAVED_FILTERS_KEY)}`,
        );
        serverLoadSucceeded = res.ok;
        const json = res.ok ? await res.json().catch(() => null) : null;
        const serverFilters = Array.isArray(json?.value)
          ? (json.value as InventorySavedFilter[])
          : [];
        let legacyFilters: InventorySavedFilter[] = [];
        if (typeof window !== "undefined") {
          const raw = window.localStorage.getItem(
            LEGACY_INVENTORY_SAVED_FILTERS_STORAGE_KEY,
          );
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as InventorySavedFilter[];
              if (Array.isArray(parsed)) legacyFilters = parsed;
            } catch {
              // ignore malformed legacy filters
            }
          }
        }
        const merged = serverLoadSucceeded
          ? mergeSavedFilters(serverFilters, legacyFilters)
          : legacyFilters;
        if (!cancelled) {
          setSavedFilters(merged);
        }
        if (serverLoadSucceeded && legacyFilters.length > 0) {
          pendingLegacySavedFiltersCleanup.current = true;
          if (merged.length !== serverFilters.length) {
            await persistSavedFilters(merged, {
              cleanupLegacy: true,
              skipAudit: true,
            });
          } else if (typeof window !== "undefined") {
            window.localStorage.removeItem(
              LEGACY_INVENTORY_SAVED_FILTERS_STORAGE_KEY,
            );
            pendingLegacySavedFiltersCleanup.current = false;
          }
        }
      } catch {
        // ignore preference load failures
      } finally {
        if (!cancelled) setSavedFiltersLoaded(true);
      }
    }
    void loadSavedFilters();
    return () => {
      cancelled = true;
    };
  }, [persistSavedFilters]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-inventory-column-widths");
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
      "admin-inventory-column-widths",
      JSON.stringify(columnWidths),
    );
  }, [columnWidths]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizing.current) return;
      const { key, startX, startWidth } = resizing.current;
      const delta = event.clientX - startX;
      const next = Math.max(100, startWidth + delta);
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

  const startResize = (key: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    resizing.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key] ?? 120,
    };
    document.body.style.cursor = "col-resize";
  };

  // Type-to-focus: focus search when typing outside inputs
  useEffect(() => {
    const isTextInput = (el: EventTarget | null) => {
      if (!el || !(el as HTMLElement).tagName) return false;
      const tag = String((el as HTMLElement).tagName).toLowerCase();
      if (tag === "input" || tag === "textarea") return true;
      try {
        return !!(el as HTMLElement).isContentEditable;
      } catch {
        return false;
      }
    };
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const el = searchRef.current;
        if (el) {
          el.value = "";
          setQ("");
          try {
            el.setSelectionRange(0, 0);
          } catch {}
          e.preventDefault();
        }
        return;
      }
      if (isTextInput(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key;
      if (!k || k.length !== 1) return;
      const el = searchRef.current;
      if (!el) return;
      el.focus();
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + k + el.value.slice(end);
      el.value = next;
      setQ(next);
      try {
        el.setSelectionRange(start + 1, start + 1);
      } catch {}
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, {
        capture: true,
      } as EventListenerOptions);
  }, []);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  useEffect(() => {
    setCurrentPage(1);
  }, [
    qDeb,
    minStock,
    maxStock,
    minPrice,
    maxPrice,
    includeArchived,
    sortKey,
    sortDir,
  ]);

  const matchingCount = data?.matchingCount ?? 0;
  const totalCount = data?.totalCount ?? 0;
  const activePage = data?.page ?? currentPage;
  const totalPages = data?.totalPages ?? 1;
  const pageSize = data?.pageSize ?? INVENTORY_PAGE_SIZE;
  const paginatedRows = rows;

  // Only clamp after data arrives — avoids wiping a valid URL page param on first render
  // when totalPages defaults to 1 before the first fetch completes.
  useEffect(() => {
    if (!data) return;
    setCurrentPage((prev) => Math.min(prev, totalPages));
  }, [data, totalPages]);

  const activeFilterCount = useMemo(
    () =>
      [
        q ? 1 : 0,
        minStock ? 1 : 0,
        maxStock ? 1 : 0,
        minPrice ? 1 : 0,
        maxPrice ? 1 : 0,
        includeArchived ? 1 : 0,
        sortKey ? 1 : 0,
      ].reduce((count, value) => count + value, 0),
    [includeArchived, maxPrice, maxStock, minPrice, minStock, q, sortKey],
  );

  const resultRangeStart =
    matchingCount === 0 ? 0 : (activePage - 1) * pageSize + 1;
  const resultRangeEnd = Math.min(
    activePage * pageSize,
    matchingCount,
  );
  const visibleAlerts = showAllAlerts
    ? alerts
    : alerts.slice(0, MAX_VISIBLE_ALERTS);
  const hiddenAlertsCount = Math.max(0, alerts.length - visibleAlerts.length);

  const resetFilters = () => {
    setQ("");
    setMinStock("");
    setMaxStock("");
    setMinPrice("");
    setMaxPrice("");
    setIncludeArchived(false);
    setSortKey(null);
    setSortDir("desc");
    setCurrentPage(1);
  };

  const openSaveFilterDialog = () => {
    setSaveFilterName(q ? `${q} view` : "");
    setSaveFilterOpen(true);
  };

  const columnToggleState = useMemo<true | false | "indeterminate">(() => {
    const values = [
      showLastUnitCost,
      showLastPurchase,
      showLastSupplier,
      showDaysOfStock,
      showWeeksCover,
      showExpectedPL,
      showReorderPoint,
      showSuggestedReorder,
    ];
    const all = values.every(Boolean);
    if (all) return true;
    const any = values.some(Boolean);
    return any ? "indeterminate" : false;
  }, [
    showLastUnitCost,
    showLastPurchase,
    showLastSupplier,
    showDaysOfStock,
    showWeeksCover,
    showExpectedPL,
    showReorderPoint,
    showSuggestedReorder,
  ]);

  const columnDefs = useMemo<ColumnDef[]>(() => {
    return [
      {
        id: "item",
        label: "Item",
        tooltip: "Product name and SKU",
        visible: true,
        headerClassName: "text-center",
        cellClassName: "font-medium text-center",
        renderCell: (r) => (
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center justify-center gap-2">
              {canCreatePurchases ? (
                <Link
                  href={getCreatePurchaseHref(r.id)}
                  className="underline-offset-4 hover:text-primary hover:underline"
                >
                  {String(r.name || "").replace(/^./, (c) => c.toUpperCase())}
                </Link>
              ) : (
                <span>
                  {String(r.name || "").replace(/^./, (c) => c.toUpperCase())}
                </span>
              )}
              {r.requiresLotTracking || r.requiresExpiryDate ? (
                <Badge
                  variant="outline"
                  className="text-[10px] uppercase tracking-wide"
                >
                  Regulated
                </Badge>
              ) : null}
            </div>
            {r.sku ? (
              <div className="text-xs text-muted-foreground">SKU: {r.sku}</div>
            ) : null}
          </div>
        ),
      },
      {
        id: "price",
        label: "Price",
        tooltip: "Current selling price per unit",
        visible: true,
        sortable: true,
        sortKey: "price",
        headerClassName: "text-center cursor-pointer select-none",
        cellClassName: "text-center",
        renderCell: (r) => formatCurrency(Number(r.price || 0)),
      },
      {
        id: "cost",
        label: "Cost",
        tooltip: "Current weighted average cost per unit",
        visible: true,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => formatCurrency(getRowMetrics(r).unitCost),
      },
      {
        id: "lastUnitCost",
        label: "Last Unit Cost",
        tooltip: "Unit cost from the most recent purchase",
        visible: showLastUnitCost,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) =>
          typeof r.lastPurchaseCost === "number" ? (
            <Tooltip
              content={`Supplier: ${r.lastPurchaseSupplier || "-"}, Note: ${r.lastPurchaseNote || "-"}`}
            >
              <span
                title={`Supplier: ${r.lastPurchaseSupplier || "-"}, Note: ${r.lastPurchaseNote || "-"}`}
              >
                {formatCurrency(Number(r.lastPurchaseCost))}
              </span>
            </Tooltip>
          ) : (
            "-"
          ),
      },
      {
        id: "lastPurchase",
        label: "Last Purchase",
        tooltip: "Date of the most recent purchase",
        visible: showLastPurchase,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) =>
          r.lastPurchaseDate ? (
            <Tooltip
              content={`Supplier: ${r.lastPurchaseSupplier || "-"}, Note: ${r.lastPurchaseNote || "-"}`}
            >
              <span
                title={`Supplier: ${r.lastPurchaseSupplier || "-"}, Note: ${r.lastPurchaseNote || "-"}`}
              >
                {new Date(r.lastPurchaseDate).toLocaleDateString()}
              </span>
            </Tooltip>
          ) : (
            "-"
          ),
      },
      {
        id: "lastSupplier",
        label: "Last Supplier",
        tooltip: "Supplier used in the most recent purchase",
        visible: showLastSupplier,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) =>
          r.lastPurchaseSupplier ? (
            <Tooltip
              content={`Supplier: ${r.lastPurchaseSupplier}${r.lastPurchaseNote ? ` · ${r.lastPurchaseNote}` : ""}`}
            >
              <span>{r.lastPurchaseSupplier}</span>
            </Tooltip>
          ) : (
            "-"
          ),
      },
      {
        id: "stock",
        label: "Stock",
        tooltip: "Current on-hand quantity",
        visible: true,
        sortable: true,
        sortKey: "stock",
        headerClassName: "text-center cursor-pointer select-none",
        cellClassName: "text-center",
        renderCell: (r) => r.stock,
      },
      {
        id: "status",
        label: "Status",
        tooltip: "OK / Low / Out, based on the product reorder point",
        visible: true,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] ${chipToneClass(
              stockStatusTone(Number(r.stock || 0), getRowLowStockThreshold(r)),
            )}`}
          >
            {getRowStatusLabel(r)}
          </span>
        ),
      },
      {
        id: "daysOfStock",
        label: "Days of Stock",
        tooltip:
          "How many days current stock will last at the last 30-day sales pace",
        visible: showDaysOfStock,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) =>
          r.daysOfStock != null ? r.daysOfStock.toFixed(1) : "—",
      },
      {
        id: "weeksCover",
        label: "Weeks Cover",
        tooltip: "Days of Stock divided by 7",
        visible: showWeeksCover,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) =>
          r.weeksCover != null ? r.weeksCover.toFixed(1) : "—",
      },
      {
        id: "salesValue",
        label: "Expected Total Sales Value",
        tooltip: "Price × Stock (potential sales revenue)",
        visible: true,
        sortable: true,
        sortKey: "salesValue",
        headerClassName: "text-center cursor-pointer select-none",
        cellClassName: "text-center",
        renderCell: (r) => {
          const { salesValue } = getRowMetrics(r);
          return (
            <Tooltip
              content={`Expected Total Sales Value = Price x Stock = ${Number(r.price || 0).toFixed(2)} x ${Number(r.stock || 0)} = ${salesValue.toFixed(2)}`}
            >
              <span>{formatCurrency(salesValue)}</span>
            </Tooltip>
          );
        },
      },
      {
        id: "costValue",
        label: "Cost of Purchase",
        tooltip: "Unit purchase cost × Stock (inventory cost)",
        visible: true,
        sortable: true,
        sortKey: "costValue",
        headerClassName: "text-center cursor-pointer select-none",
        cellClassName: "text-center",
        renderCell: (r) => {
          const { costValue, unitCost } = getRowMetrics(r);
          return (
            <Tooltip
              content={`Cost of Purchase = Unit Purchase Cost x Stock = ${unitCost.toFixed(2)} x ${Number(r.stock || 0)} = ${costValue.toFixed(2)}`}
            >
              <span>{formatCurrency(costValue)}</span>
            </Tooltip>
          );
        },
      },
      {
        id: "expectedPL",
        label: "Expected P/L",
        tooltip: "Expected Sales − Cost of Purchase",
        visible: showExpectedPL,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => {
          const { salesValue, costValue, expectedProfit } = getRowMetrics(r);
          return (
            <Tooltip
              content={`P/L = Expected Sales - Cost of Purchase = ${salesValue.toFixed(2)} - ${costValue.toFixed(2)} = ${expectedProfit.toFixed(2)}`}
            >
              <span
                className={`font-medium ${expectedProfit >= 0 ? "text-green-600" : "text-red-600"}`}
              >
                {formatCurrency(expectedProfit)}
              </span>
            </Tooltip>
          );
        },
      },
      {
        id: "reorderPoint",
        label: "Reorder Point",
        tooltip: "From Inventory Planning effective plan",
        visible: showReorderPoint,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => (r.reorderPoint != null ? r.reorderPoint : "—"),
      },
      {
        id: "suggestedReorder",
        label: "Suggested Reorder",
        tooltip: "From Inventory Planning suggestion (open/auto)",
        visible: showSuggestedReorder,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) =>
          r.suggestedReorder != null ? r.suggestedReorder : "—",
      },
      {
        id: "actions",
        label: "Actions",
        tooltip: "Quick actions for restock or movement history",
        visible: true,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => (
          <div className="flex items-center justify-center gap-2">
            {hasPurchaseDetails(r) ? (
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                title="Show last purchase details"
                aria-label="Show last purchase details"
                onClick={() => {
                  setInfoRow(r);
                  setInfoOpen(true);
                }}
              >
                <Info className="size-4" />
              </Button>
            ) : null}
            {canCreatePurchases ? (
              <Button
                asChild
                variant="outline"
                size="icon-sm"
                title="Add purchase"
              >
                <Link
                  href={getCreatePurchaseHref(r.id)}
                  aria-label="Add purchase"
                >
                  <PackagePlus className="size-4" />
                </Link>
              </Button>
            ) : null}
            {canViewMovements ? (
              <Button
                asChild
                variant="outline"
                size="icon-sm"
                title="View movements"
              >
                <Link
                  href={`/admin/movements?product=${encodeURIComponent(r.id)}`}
                  aria-label="View movements"
                >
                  <History className="size-4" />
                </Link>
              </Button>
            ) : null}
            {!hasPurchaseDetails(r) &&
            !canCreatePurchases &&
            !canViewMovements ? (
              <span className="text-muted-foreground">—</span>
            ) : null}
          </div>
        ),
      },
    ];
  }, [
    canCreatePurchases,
    canViewMovements,
    showLastUnitCost,
    showLastPurchase,
    showLastSupplier,
    showDaysOfStock,
    showWeeksCover,
    showExpectedPL,
    showReorderPoint,
    showSuggestedReorder,
  ]);

  const orderedColumns = useMemo(() => {
    const map = new Map(columnDefs.map((col) => [col.id, col]));
    const seen = new Set<string>();
    const ordered = columnOrder
      .map((id) => {
        const col = map.get(id);
        if (col) seen.add(id);
        return col || null;
      })
      .filter(Boolean) as ColumnDef[];
    for (const col of columnDefs) {
      if (!seen.has(col.id)) ordered.push(col);
    }
    return ordered;
  }, [columnDefs, columnOrder]);

  const visibleColumns = useMemo(
    () => orderedColumns.filter((col) => col.visible),
    [orderedColumns],
  );

  const getColWidth = (id: string) => columnWidths[id] ?? 140;

  const handleDragStart = (id: string) => (event: DragEvent) => {
    event.dataTransfer.setData("text/plain", id);
    event.dataTransfer.effectAllowed = "move";
  };

  const handleDrop = (targetId: string) => (event: DragEvent) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain");
    if (!sourceId || sourceId === targetId) return;
    setColumnOrder((prev) => {
      const targetIdx = prev.indexOf(targetId);
      if (targetIdx === -1) return prev;
      const next = prev.filter((id) => id !== sourceId);
      next.splice(targetIdx, 0, sourceId);
      return next;
    });
  };

  const totals = useMemo(
    () =>
      data?.filteredTotals ?? {
        priceValue: 0,
        costValue: 0,
      },
    [data],
  );

  async function downloadCSV() {
    let exportRows = rows;
    try {
      const params = new URLSearchParams(inventoryQueryString);
      params.set("all", "1");
      const exportData = (await fetcher(
        `/api/admin/inventory?${params.toString()}`,
      )) as InventoryResponse;
      exportRows = Array.isArray(exportData?.rows) ? exportData.rows : [];
    } catch (error) {
      console.error(error);
      toast.error("Could not export inventory.");
      return;
    }
    const headers = [
      "Item",
      "SKU",
      "Price",
      "Cost",
      "Stock",
      "Status",
      "Days of Stock",
      "Weeks of Cover",
      "Reorder Point",
      "Suggested Reorder",
      "Last Supplier",
      "Expected Total Sales Value",
      "Cost of Purchase",
    ];
    const lines = [headers.join(",")];
    for (const r of exportRows) {
      const metrics = getRowMetrics(r);
      const status = getRowStatusLabel(r);
      lines.push(
        [
          JSON.stringify(r.name),
          JSON.stringify(r.sku || ""),
          Number(r.price || 0).toFixed(2),
          metrics.unitCost.toFixed(2),
          String(r.stock ?? 0),
          JSON.stringify(status),
          r.daysOfStock != null ? Number(r.daysOfStock).toFixed(1) : "",
          r.weeksCover != null ? Number(r.weeksCover).toFixed(1) : "",
          r.reorderPoint != null ? String(r.reorderPoint) : "",
          r.suggestedReorder != null ? String(r.suggestedReorder) : "",
          JSON.stringify(r.lastPurchaseSupplier || ""),
          metrics.salesValue.toFixed(2),
          metrics.costValue.toFixed(2),
        ].join(","),
      );
    }
    lines.push(
      [
        "Filtered totals",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        totals.priceValue.toFixed(2),
        totals.costValue.toFixed(2),
      ].join(","),
    );
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const filename = `inventory_${Date.now()}.csv`;
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "inventory",
      format: "CSV",
      fileName: filename,
      rowCount: exportRows.length,
      columnCount: 13,
      byteSize: blob.size,
      sourcePage: "admin/inventory",
      matchingCount,
      totalCount,
      sortKey: sortKey || "default",
      sortDir: sortKey ? sortDir : "default",
      valuationMode,
      resultSummary: `Inventory CSV export downloaded (${exportRows.length} rows).`,
      scopeSnapshot: `Search: ${q || "-"} | Stock: ${minStock || "-"} to ${maxStock || "-"} | Price: ${minPrice || "-"} to ${maxPrice || "-"} | Include archived: ${includeArchived ? "yes" : "no"} | Sort: ${sortKey ? `${sortKey} ${sortDir}` : "default"} | Valuation: ${valuationMode} | Matching: ${matchingCount} of ${totalCount}`,
    });
  }

  const saveCurrentFilter = async () => {
    if (!savedFiltersLoaded) {
      toast.error("Saved filters are still loading.");
      return;
    }
    const name = saveFilterName.trim();
    if (!name) {
      toast.error("Enter a name for this saved filter.");
      return;
    }
    const entry: InventorySavedFilter = {
      id: `${Date.now()}`,
      name,
      state: {
        q,
        minStock,
        maxStock,
        minPrice,
        maxPrice,
        includeArchived,
        sortKey,
        sortDir,
        valuationMode,
      },
    };
    const nextFilters = [entry, ...savedFilters];
    setSavedFilters(nextFilters);
    try {
      await persistSavedFilters(nextFilters, {
        cleanupLegacy: pendingLegacySavedFiltersCleanup.current,
        auditAction: "INVENTORY_FILTER_SAVE",
        resultSummary: `Saved inventory filter "${name}".`,
      });
      setSaveFilterOpen(false);
      setSaveFilterName("");
      toast.success("Saved filter");
    } catch (error) {
      setSavedFilters(savedFilters);
      console.error(error);
      toast.error("Could not save filter.");
    }
  };

  const applySavedFilter = (entry: InventorySavedFilter) => {
    const s = entry.state;
    setQ(s.q);
    setMinStock(s.minStock);
    setMaxStock(s.maxStock);
    setMinPrice(s.minPrice);
    setMaxPrice(s.maxPrice);
    setIncludeArchived(s.includeArchived);
    setSortKey(s.sortKey);
    setSortDir(s.sortDir);
    setValuationMode(s.valuationMode);
    setCurrentPage(1);
    toast.success(`Applied "${entry.name}"`);
  };

  const removeSavedFilter = async (id: string) => {
    if (!savedFiltersLoaded) {
      toast.error("Saved filters are still loading.");
      return;
    }
    const nextFilters = savedFilters.filter((f) => f.id !== id);
    const removed = savedFilters.find((f) => f.id === id);
    setSavedFilters(nextFilters);
    try {
      await persistSavedFilters(nextFilters, {
        cleanupLegacy: pendingLegacySavedFiltersCleanup.current,
        auditAction: "INVENTORY_FILTER_REMOVE",
        resultSummary: removed
          ? `Removed inventory filter "${removed.name}".`
          : "Removed an inventory saved filter.",
      });
      toast.success("Removed saved filter");
    } catch (error) {
      setSavedFilters(savedFilters);
      console.error(error);
      toast.error("Could not remove saved filter.");
    }
  };

  return (
    <Card>
      <CardHeader className="space-y-4">
        <div className="flex flex-col gap-1 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <CardTitle className="text-base font-semibold">
              Inventory Valuation
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Realtime snapshot with one-minute refresh.
            </p>
          </div>
          <p className="text-sm text-muted-foreground" suppressHydrationWarning>
            Updated: {updatedAtText || "—"}
          </p>
        </div>
        <div className="rounded-md border p-3">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                {activeFilterCount > 0 ? (
                  <Badge variant="secondary" title="Active filters and sort">
                    {activeFilterCount} active filters
                  </Badge>
                ) : null}
                <span className="text-sm text-muted-foreground">
                  {matchingCount} of {totalCount} products match current filters
                </span>
                {matchingCount > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    Showing {resultRangeStart}-{resultRangeEnd} of {matchingCount}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {userRole === "ADMIN" ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href="/admin/audit?sourcePage=admin%2Finventory">
                      View Audit Log
                    </Link>
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={downloadCSV}>
                  Export CSV
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(window.location.href);
                      toast.success("Link copied");
                    } catch (error) {
                      console.error(error);
                      toast.error("Could not copy link");
                    }
                  }}
                >
                  Copy Link
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline">
                      Columns
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <button
                      type="button"
                      className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                      onClick={() => {
                        setColumnOrder(defaultColumnOrder);
                        setShowLastUnitCost(
                          defaultOptionalColumnVisibility.lastUnitCost,
                        );
                        setShowLastPurchase(
                          defaultOptionalColumnVisibility.lastPurchase,
                        );
                        setShowLastSupplier(
                          defaultOptionalColumnVisibility.lastSupplier,
                        );
                        setShowDaysOfStock(
                          defaultOptionalColumnVisibility.daysOfStock,
                        );
                        setShowWeeksCover(
                          defaultOptionalColumnVisibility.weeksCover,
                        );
                        setShowExpectedPL(
                          defaultOptionalColumnVisibility.expectedPL,
                        );
                        setShowReorderPoint(
                          defaultOptionalColumnVisibility.reorderPoint,
                        );
                        setShowSuggestedReorder(
                          defaultOptionalColumnVisibility.suggestedReorder,
                        );
                      }}
                    >
                      Reset to default layout
                    </button>
                    <div className="my-1 h-px bg-border" />
                    <DropdownMenuCheckboxItem
                      checked={columnToggleState}
                      onCheckedChange={(value) => {
                        const next = Boolean(value);
                        setShowLastUnitCost(next);
                        setShowLastPurchase(next);
                        setShowLastSupplier(next);
                        setShowDaysOfStock(next);
                        setShowWeeksCover(next);
                        setShowExpectedPL(next);
                        setShowReorderPoint(next);
                        setShowSuggestedReorder(next);
                      }}
                      onSelect={(event) => event.preventDefault()}
                    >
                      All optional columns
                    </DropdownMenuCheckboxItem>
                    <div className="my-1 h-px bg-border" />
                    <DropdownMenuCheckboxItem
                      checked={showLastUnitCost}
                      onCheckedChange={(value) =>
                        setShowLastUnitCost(Boolean(value))
                      }
                      onSelect={(event) => event.preventDefault()}
                    >
                      Last Unit Cost
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={showLastPurchase}
                      onCheckedChange={(value) =>
                        setShowLastPurchase(Boolean(value))
                      }
                      onSelect={(event) => event.preventDefault()}
                    >
                      Last Purchase
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={showLastSupplier}
                      onCheckedChange={(value) =>
                        setShowLastSupplier(Boolean(value))
                      }
                      onSelect={(event) => event.preventDefault()}
                    >
                      Last Supplier
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={showDaysOfStock}
                      onCheckedChange={(value) =>
                        setShowDaysOfStock(Boolean(value))
                      }
                      onSelect={(event) => event.preventDefault()}
                    >
                      Days of Stock
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={showWeeksCover}
                      onCheckedChange={(value) =>
                        setShowWeeksCover(Boolean(value))
                      }
                      onSelect={(event) => event.preventDefault()}
                    >
                      Weeks Cover
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={showExpectedPL}
                      onCheckedChange={(value) =>
                        setShowExpectedPL(Boolean(value))
                      }
                      onSelect={(event) => event.preventDefault()}
                    >
                      Expected P/L
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={showReorderPoint}
                      onCheckedChange={(value) =>
                        setShowReorderPoint(Boolean(value))
                      }
                      onSelect={(event) => event.preventDefault()}
                    >
                      Reorder Point
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={showSuggestedReorder}
                      onCheckedChange={(value) =>
                        setShowSuggestedReorder(Boolean(value))
                      }
                      onSelect={(event) => event.preventDefault()}
                    >
                      Suggested Reorder
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline">
                      Saved filters
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={openSaveFilterDialog}>
                      Save current filter
                    </DropdownMenuItem>
                    {!savedFiltersLoaded ? (
                      <DropdownMenuItem disabled>
                        Loading saved filters...
                      </DropdownMenuItem>
                    ) : savedFilters.length === 0 ? (
                      <DropdownMenuItem disabled>
                        No saved filters
                      </DropdownMenuItem>
                    ) : (
                      savedFilters.map((entry) => (
                        <DropdownMenuItem
                          key={entry.id}
                          className="flex items-center justify-between gap-4"
                        >
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
                              void removeSavedFilter(entry.id);
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
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant={valuationMode === "sales" ? "default" : "outline"}
                    onClick={() => setValuationMode("sales")}
                    title="Show sales valuation total"
                  >
                    Sales
                  </Button>
                  <Button
                    size="sm"
                    variant={valuationMode === "cost" ? "default" : "outline"}
                    onClick={() => setValuationMode("cost")}
                    title="Show cost valuation total"
                  >
                    Cost
                  </Button>
                </div>
                <div className="text-sm text-muted-foreground">
                  Valuation total{" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(
                      valuationMode === "sales"
                        ? totals.priceValue
                        : totals.costValue,
                    )}
                  </span>
                </div>
                <Tooltip
                  side="bottom"
                  content={
                    <span>
                      Expected Sales = Price x Stock. Cost of Purchase = Unit
                      Purchase Cost x Stock. P/L = Expected Sales minus Cost of
                      Purchase. Status uses each product&apos;s reorder point.
                      Days of Stock and Weeks Cover use the last 30 days of
                      sales. Use Sales or Cost to switch the total shown, then
                      sort by any supported column header.
                    </span>
                  }
                >
                  <span className="cursor-help text-xs text-muted-foreground underline decoration-dotted">
                    How valuation works
                  </span>
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-4 rounded-md border p-3">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm font-semibold">Inventory alerts</div>
            <div className="text-xs text-muted-foreground">
              Auto-refreshes every minute
              {alerts.length > 0 ? ` • ${alerts.length} active` : ""}
            </div>
          </div>
          {alertsLoading ? (
            <div className="mt-2 text-xs text-muted-foreground">
              Loading alerts...
            </div>
          ) : alerts.length === 0 ? (
            <div className="mt-2 text-xs text-muted-foreground">
              No active alerts.
            </div>
          ) : (
            <>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {visibleAlerts.map((alert) => (
                  <div
                    key={alert.id}
                    className="rounded-md border px-3 py-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium truncate">{alert.name}</div>
                      <Badge
                        className={
                          alert.severity === "critical"
                            ? "bg-rose-100 text-rose-800"
                            : "bg-amber-100 text-amber-800"
                        }
                      >
                        {alert.severity === "critical" ? "Critical" : "Warning"}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground">{alert.message}</div>
                    {canCreatePurchases ? (
                      <div className="mt-1 flex items-center gap-2">
                        <Link
                          href={getCreatePurchaseHref(alert.productId)}
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          Create purchase
                        </Link>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {showAllAlerts
                    ? `Showing all ${alerts.length} alerts`
                    : `Showing ${visibleAlerts.length} of ${alerts.length} alerts`}
                </span>
                {hiddenAlertsCount > 0 || showAllAlerts ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowAllAlerts((prev) => !prev)}
                  >
                    {showAllAlerts ? "Show less" : `View all ${alerts.length}`}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>
        {rows.some((r) => Number(r.stock || 0) < 0) && (
          <div className="mb-3 p-2 rounded-md bg-destructive/10 text-destructive text-sm">
            Warning: One or more products have negative stock. Please review
            purchases and sales.
          </div>
        )}
        <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 mb-4">
          <Input
            placeholder="Search item name or SKU..."
            value={q}
            ref={searchRef}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            className="sm:max-w-xs"
          />
          <Input
            placeholder="Min stock"
            type="number"
            inputMode="numeric"
            value={minStock}
            onChange={(e) => {
              setMinStock(e.target.value);
              if (stockRangeError) setStockRangeError("");
            }}
            aria-invalid={!!stockRangeError}
            className={`sm:max-w-[140px] ${stockRangeError ? "border-red-500" : ""}`}
          />
          <Input
            placeholder="Max stock"
            type="number"
            inputMode="numeric"
            value={maxStock}
            onChange={(e) => {
              setMaxStock(e.target.value);
              if (stockRangeError) setStockRangeError("");
            }}
            aria-invalid={!!stockRangeError}
            className={`sm:max-w-[140px] ${stockRangeError ? "border-red-500" : ""}`}
          />
          {stockRangeError && (
            <p className="text-xs text-red-600 sm:basis-full">
              {stockRangeError}
            </p>
          )}
          <Input
            placeholder="Min price"
            type="number"
            inputMode="decimal"
            value={minPrice}
            onChange={(e) => {
              setMinPrice(e.target.value);
              if (priceRangeError) setPriceRangeError("");
            }}
            aria-invalid={!!priceRangeError}
            className={`sm:max-w-[160px] ${priceRangeError ? "border-red-500" : ""}`}
          />
          <Input
            placeholder="Max price"
            type="number"
            inputMode="decimal"
            value={maxPrice}
            onChange={(e) => {
              setMaxPrice(e.target.value);
              if (priceRangeError) setPriceRangeError("");
            }}
            aria-invalid={!!priceRangeError}
            className={`sm:max-w-[160px] ${priceRangeError ? "border-red-500" : ""}`}
          />
          {priceRangeError && (
            <p className="text-xs text-red-600 sm:basis-full">
              {priceRangeError}
            </p>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Include archived
          </label>
          <Button variant="ghost" onClick={resetFilters}>
            Reset
          </Button>
          <div className="flex items-center text-xs text-muted-foreground sm:ml-auto">
            {isLoading
              ? "Loading inventory..."
              : matchingCount > 0
                ? `Page ${activePage} of ${totalPages}`
                : activeFilterCount > 0
                  ? "No products match the current filters."
                  : "No inventory rows available."}
          </div>
        </div>
        {!isLoading && matchingCount === 0 ? (
          <div className="rounded-md border p-4 text-center text-sm text-muted-foreground">
            <div className="flex flex-col items-center gap-3">
              <span>
                {totalCount === 0
                  ? "No products found yet."
                  : "No products found for the current filters."}
              </span>
              <div className="flex flex-wrap justify-center gap-2">
                {activeFilterCount > 0 ? (
                  <Button size="sm" variant="outline" onClick={resetFilters}>
                    Clear filters
                  </Button>
                ) : null}
                {canManageProducts ? (
                  <Button
                    size="sm"
                    onClick={() => router.push("/admin/products")}
                  >
                    Add product
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {matchingCount > 0 ? (
          <>
            <div className="lg:hidden space-y-3">
              {paginatedRows.map((r) => {
                const metrics = getRowMetrics(r);
                const statusLabel = getRowStatusLabel(r);
                const statusTone = chipToneClass(
                  stockStatusTone(
                    Number(r.stock || 0),
                    getRowLowStockThreshold(r),
                  ),
                );

                return (
                  <div key={r.id} className="rounded-md border p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 font-semibold">
                          {canCreatePurchases ? (
                            <Link
                              href={getCreatePurchaseHref(r.id)}
                              className="truncate underline-offset-4 hover:text-primary hover:underline"
                            >
                              {String(r.name || "").replace(/^./, (c) =>
                                c.toUpperCase(),
                              )}
                            </Link>
                          ) : (
                            <span className="truncate">
                              {String(r.name || "").replace(/^./, (c) =>
                                c.toUpperCase(),
                              )}
                            </span>
                          )}
                          {r.requiresLotTracking || r.requiresExpiryDate ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] uppercase tracking-wide"
                            >
                              Regulated
                            </Badge>
                          ) : null}
                        </div>
                        {r.sku ? (
                          <div className="text-xs text-muted-foreground">
                            SKU: {r.sku}
                          </div>
                        ) : null}
                      </div>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] ${statusTone}`}
                      >
                        {statusLabel}
                      </span>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                      <div>
                        <div>Stock</div>
                        <div className="text-foreground">{r.stock}</div>
                      </div>
                      <div>
                        <div>Price</div>
                        <div className="text-foreground">
                          {formatCurrency(Number(r.price || 0))}
                        </div>
                      </div>
                      <div>
                        <div>Cost</div>
                        <div className="text-foreground">
                          {formatCurrency(metrics.unitCost)}
                        </div>
                      </div>
                      <div>
                        <div>Expected Sales</div>
                        <div className="text-foreground">
                          {formatCurrency(metrics.salesValue)}
                        </div>
                      </div>
                      <div>
                        <div>Expected P/L</div>
                        <div
                          className={`font-medium ${metrics.expectedProfit >= 0 ? "text-green-600" : "text-red-600"}`}
                        >
                          {formatCurrency(metrics.expectedProfit)}
                        </div>
                      </div>
                      <div>
                        <div>Last Purchase</div>
                        <div className="text-foreground">
                          {r.lastPurchaseDate
                            ? new Date(r.lastPurchaseDate).toLocaleDateString()
                            : "—"}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {hasPurchaseDetails(r) ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setInfoRow(r);
                            setInfoOpen(true);
                          }}
                        >
                          Details
                        </Button>
                      ) : null}
                      {canCreatePurchases ? (
                        <Button asChild size="sm">
                          <Link
                            href={getCreatePurchaseHref(r.id)}
                          >
                            Add Purchase
                          </Link>
                        </Button>
                      ) : null}
                      {canViewMovements ? (
                        <Button asChild size="sm" variant="outline">
                          <Link
                            href={`/admin/movements?product=${encodeURIComponent(r.id)}`}
                          >
                            Movements
                          </Link>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="overflow-x-auto">
              <Table className="hidden min-w-[1320px] table-fixed lg:table">
                <TableHeader>
                  <TableRow>
                    {visibleColumns.map((col) => (
                      <TableHead
                        key={col.id}
                        className={`${col.headerClassName ?? ""} relative`}
                        style={{ width: getColWidth(col.id) }}
                        draggable
                        onDragStart={handleDragStart(col.id)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={handleDrop(col.id)}
                        onClick={
                          col.sortable && col.sortKey
                            ? () => toggleSort(col.sortKey as SortKey)
                            : undefined
                        }
                      >
                        <span title={col.tooltip}>
                          {col.label}
                          {col.sortable && col.sortKey
                            ? sortIndicator(col.sortKey)
                            : ""}
                        </span>
                        <div
                          className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                          onMouseDown={(event) => startResize(col.id, event)}
                          onClick={(event) => event.stopPropagation()}
                          onDragStart={(event) => event.preventDefault()}
                          draggable={false}
                        />
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading && (
                    <TableRow>
                      <TableCell
                        colSpan={Math.max(1, visibleColumns.length)}
                        className="text-center py-6 text-muted-foreground"
                      >
                        Loading inventory...
                      </TableCell>
                    </TableRow>
                  )}
                  {paginatedRows.map((r) => (
                    <TableRow key={r.id} className="odd:bg-muted/30">
                      {visibleColumns.map((col) => (
                        <TableCell
                          key={`${r.id}-${col.id}`}
                          className={col.cellClassName}
                          style={{ width: getColWidth(col.id) }}
                        >
                          {col.renderCell(r)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                  {matchingCount > 0 && (
                    <TableRow className="border-t-2 border-border bg-muted/30">
                      {visibleColumns.map((col, idx) => {
                        if (idx === 0) {
                          return (
                            <TableCell
                              key={col.id}
                              className="text-center font-semibold py-2"
                              style={{ width: getColWidth(col.id) }}
                            >
                              Filtered totals
                            </TableCell>
                          );
                        }
                        if (col.id === "salesValue") {
                          return (
                            <TableCell
                              key={col.id}
                              className="text-center font-semibold py-2"
                              style={{ width: getColWidth(col.id) }}
                            >
                              {formatCurrency(totals.priceValue)}
                            </TableCell>
                          );
                        }
                        if (col.id === "costValue") {
                          return (
                            <TableCell
                              key={col.id}
                              className="text-center font-semibold py-2"
                              style={{ width: getColWidth(col.id) }}
                            >
                              {formatCurrency(totals.costValue)}
                            </TableCell>
                          );
                        }
                        return (
                          <TableCell
                            key={col.id}
                            className="py-2"
                            style={{ width: getColWidth(col.id) }}
                          />
                        );
                      })}
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {totalPages > 1 ? (
              <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-xs text-muted-foreground">
                  Showing {resultRangeStart}-{resultRangeEnd} of{" "}
                  {matchingCount} matching products
                </div>
                <div className="flex items-center gap-2 self-end sm:self-auto">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={activePage <= 1}
                    onClick={() =>
                      setCurrentPage((page) => Math.max(1, page - 1))
                    }
                  >
                    <ChevronLeft className="size-4" />
                    Prev
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Page {activePage} / {totalPages}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={activePage >= totalPages}
                    onClick={() =>
                      setCurrentPage((page) => Math.min(totalPages, page + 1))
                    }
                  >
                    Next
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
      <Dialog
        open={saveFilterOpen}
        onOpenChange={(open) => {
          setSaveFilterOpen(open);
          if (!open) setSaveFilterName("");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              Save current filter
            </DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-3 text-sm"
            onSubmit={(event) => {
              event.preventDefault();
              void saveCurrentFilter();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="saveFilterName">Filter name</Label>
              <Input
                id="saveFilterName"
                value={saveFilterName}
                onChange={(event) => setSaveFilterName(event.target.value)}
                placeholder="e.g., Low stock this week"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setSaveFilterOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Save filter</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Last Purchase Details</DialogTitle>
          </DialogHeader>
          {infoRow && (
            <div className="grid gap-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Product</span>
                <span>
                  {String(infoRow.name || "").replace(/^./, (c) =>
                    c.toUpperCase(),
                  )}
                </span>
              </div>
              {infoRow.sku ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">SKU</span>
                  <span>{infoRow.sku}</span>
                </div>
              ) : null}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Date</span>
                <span>
                  {infoRow.lastPurchaseDate
                    ? new Date(infoRow.lastPurchaseDate).toLocaleDateString()
                    : "-"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last Unit Cost</span>
                <span>
                  {typeof infoRow.lastPurchaseCost === "number"
                    ? Number(infoRow.lastPurchaseCost).toFixed(2)
                    : "-"}
                </span>
              </div>
              {infoRow.lastPurchaseSupplier ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Supplier</span>
                  <span>{infoRow.lastPurchaseSupplier}</span>
                </div>
              ) : null}
              {infoRow.lastPurchaseNote ? (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Note</span>
                  <span>{infoRow.lastPurchaseNote}</span>
                </div>
              ) : null}
              {canAdjustInventoryValue ? (
                <div className="pt-3 flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openAdjust(infoRow)}
                  >
                    Adjust inventory value
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={adjustOpen}
        onOpenChange={(open) => {
          setAdjustOpen(open);
          if (!open) {
            setAdjustRow(null);
            setAdjustCost("");
            setAdjustReason("");
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Inventory revaluation</DialogTitle>
          </DialogHeader>
          {adjustRow ? (
            <div className="grid gap-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Product</span>
                <span>{adjustRow.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Current cost</span>
                <span>{formatCurrency(Number(adjustRow.cost || 0))}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Stock</span>
                <span>{adjustRow.stock}</span>
              </div>
              <div className="space-y-1">
                <Label htmlFor="adjustCost">New unit cost</Label>
                <Input
                  id="adjustCost"
                  type="number"
                  step="0.01"
                  value={adjustCost}
                  onChange={(e) => setAdjustCost(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="adjustReason">Reason</Label>
                <Textarea
                  id="adjustReason"
                  rows={3}
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="e.g. End-of-quarter revaluation, supplier invoice correction"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="secondary"
                  onClick={() => setAdjustOpen(false)}
                >
                  Cancel
                </Button>
                <Button onClick={submitAdjust} disabled={adjusting}>
                  {adjusting ? "Posting..." : "Post adjustment"}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function Inventory() {
  return (
    <section className="container mx-auto py-8">
      <Suspense
        fallback={
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold">
                Inventory
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Loading inventory…
              </p>
            </CardContent>
          </Card>
        }
      >
        <InventoryContent />
      </Suspense>
    </section>
  );
}
