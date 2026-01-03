"use client";

export const dynamic = "force-dynamic";

import { Suspense, type ReactNode, type DragEvent } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { formatCurrency } from "@/lib/currency";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Info } from "lucide-react";
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
import { useEffect, useMemo, useRef, useState } from "react";
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

function InventoryContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const lowStockThreshold = 5;

  const { data, isLoading } = useClientQuery<{ rows: Row[] }>({
    queryKey: ["admin", "inventory", { includeArchived: includeArchived ? "1" : "0" }],
    queryFn: () => fetcher(`/api/admin/inventory?includeArchived=${includeArchived ? "1" : "0"}`),
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const rows: Row[] = useMemo(() => data?.rows || [], [data]);
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
  const [updatedAtText, setUpdatedAtText] = useState<string>("");
  const [showLastUnitCost, setShowLastUnitCost] = useState(true);
  const [showLastPurchase, setShowLastPurchase] = useState(true);
  const [showLastSupplier, setShowLastSupplier] = useState(true);
  const [showDaysOfStock, setShowDaysOfStock] = useState(true);
  const [showWeeksCover, setShowWeeksCover] = useState(true);
  const [showExpectedPL, setShowExpectedPL] = useState(true);
  const [showReorderPoint, setShowReorderPoint] = useState(true);
  const [showSuggestedReorder, setShowSuggestedReorder] = useState(true);
  const [columnOrder, setColumnOrder] = useState<string[]>(defaultColumnOrder);
  const [orderLoaded, setOrderLoaded] = useState(false);
  const [visibilityLoaded, setVisibilityLoaded] = useState(false);
  const [savedFilters, setSavedFilters] = useState<InventorySavedFilter[]>([]);
  const resizing = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    item: 240,
    price: 120,
    cost: 140,
    lastUnitCost: 150,
    lastPurchase: 150,
    lastSupplier: 160,
    stock: 110,
    status: 130,
    daysOfStock: 140,
    weeksCover: 140,
    salesValue: 150,
    costValue: 150,
    expectedPL: 150,
    reorderPoint: 150,
    suggestedReorder: 170,
    actions: 140,
  });

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
    if (sk0 && ["price", "stock", "totalValue", "salesValue", "costValue"].includes(sk0)) {
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
    if (sortKey) params.set("sortKey", sortKey);
    else params.delete("sortKey");
    if (sortKey) params.set("sortDir", sortDir);
    else params.delete("sortDir");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [q, minStock, maxStock, minPrice, maxPrice, includeArchived, sortKey, sortDir, pathname, router]);

  // Client-only updated timestamp to avoid hydration mismatch
  useEffect(() => {
    setUpdatedAtText(new Date().toLocaleTimeString());
  }, [rows.length]);

  useEffect(() => {
    let cancelled = false;
    async function loadColumnOrder() {
      try {
        const res = await fetch("/api/admin/preferences?key=inventory.columns.order");
        if (!res.ok) return;
        const json = await res.json().catch(() => null);
        const value = Array.isArray(json?.value) ? json.value : null;
        if (!value || cancelled) return;
        const filtered = value.filter((id: string) => defaultColumnOrder.includes(id));
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
    const controller = new AbortController();
    fetch("/api/admin/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "inventory.columns.order",
        value: columnOrder,
      }),
      signal: controller.signal,
    }).catch(() => {});
    return () => controller.abort();
  }, [columnOrder, orderLoaded]);

  useEffect(() => {
    let cancelled = false;
    async function loadVisibility() {
      try {
        const res = await fetch("/api/admin/preferences?key=inventory.columns.visibility");
        if (!res.ok) return;
        const json = await res.json().catch(() => null);
        const value = json?.value as Record<string, unknown> | null;
        if (!value || typeof value !== "object" || cancelled) return;
        if ("lastUnitCost" in value) setShowLastUnitCost(Boolean(value.lastUnitCost));
        if ("lastPurchase" in value) setShowLastPurchase(Boolean(value.lastPurchase));
        if ("lastSupplier" in value) setShowLastSupplier(Boolean(value.lastSupplier));
        if ("daysOfStock" in value) setShowDaysOfStock(Boolean(value.daysOfStock));
        if ("weeksCover" in value) setShowWeeksCover(Boolean(value.weeksCover));
        if ("expectedPL" in value) setShowExpectedPL(Boolean(value.expectedPL));
        if ("reorderPoint" in value) setShowReorderPoint(Boolean(value.reorderPoint));
        if ("suggestedReorder" in value) setShowSuggestedReorder(Boolean(value.suggestedReorder));
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
    const controller = new AbortController();
    fetch("/api/admin/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "inventory.columns.visibility",
        value: {
          lastUnitCost: showLastUnitCost,
          lastPurchase: showLastPurchase,
          lastSupplier: showLastSupplier,
          daysOfStock: showDaysOfStock,
          weeksCover: showWeeksCover,
          expectedPL: showExpectedPL,
          reorderPoint: showReorderPoint,
          suggestedReorder: showSuggestedReorder,
        },
      }),
      signal: controller.signal,
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
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-inventory-saved-filters");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as InventorySavedFilter[];
      if (Array.isArray(parsed)) setSavedFilters(parsed);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "admin-inventory-saved-filters",
      JSON.stringify(savedFilters),
    );
  }, [savedFilters]);

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
      if (e.key === 'Escape') {
        const el = searchRef.current;
        if (el) {
          el.value = '';
          setQ('');
          try { el.setSelectionRange(0, 0); } catch {}
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

  const filteredRows = useMemo(() => {
    const ms = Number(minStock);
    const xs = Number(maxStock);
    const mp = Number(minPrice);
    const xp = Number(maxPrice);
    const hasMinStock = !Number.isNaN(ms) && minStock !== "";
    const hasMaxStock = !Number.isNaN(xs) && maxStock !== "";
    const hasMinPrice = !Number.isNaN(mp) && minPrice !== "";
    const hasMaxPrice = !Number.isNaN(xp) && maxPrice !== "";
    const ql = qDeb.trim().toLowerCase();
    return rows.filter((r) => {
      const price = Number(r.price || 0);
      const stock = Number(r.stock || 0);
      const nameOk = !ql || r.name.toLowerCase().includes(ql);
      const skuOk = !ql || String(r.sku || "").toLowerCase().includes(ql);
      const stockMinOk = !hasMinStock || stock >= ms;
      const stockMaxOk = !hasMaxStock || stock <= xs;
      const priceMinOk = !hasMinPrice || price >= mp;
      const priceMaxOk = !hasMaxPrice || price <= xp;
      return (nameOk || skuOk) && stockMinOk && stockMaxOk && priceMinOk && priceMaxOk;
    });
  }, [rows, qDeb, minStock, maxStock, minPrice, maxPrice]);

  const sortedRows = useMemo(() => {
    const base = filteredRows;
    if (!sortKey) return base;
    const arr = [...base];
    arr.sort((a, b) => {
      const salesA = Number(a.price || 0) * Number(a.stock || 0);
      const salesB = Number(b.price || 0) * Number(b.stock || 0);
      const costA = Number(a.cost || 0) * Number(a.stock || 0);
      const costB = Number(b.cost || 0) * Number(b.stock || 0);
      const va =
        sortKey === "salesValue"
          ? salesA
          : sortKey === "costValue"
          ? costA
          : Number((a as Record<string, unknown>)[sortKey] ?? 0);
      const vb =
        sortKey === "salesValue"
          ? salesB
          : sortKey === "costValue"
          ? costB
          : Number((b as Record<string, unknown>)[sortKey] ?? 0);
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return arr;
  }, [filteredRows, sortKey, sortDir]);

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
    const renderMetrics = (r: Row) => {
      const pv = Number(r.price || 0) * Number(r.stock || 0);
      const unitCost =
        typeof r.avgPurchaseCost === "number" && !Number.isNaN(r.avgPurchaseCost)
          ? r.avgPurchaseCost
          : typeof r.lastPurchaseCost === "number" && !Number.isNaN(r.lastPurchaseCost)
          ? r.lastPurchaseCost
          : Number(r.cost || 0);
      const cv = unitCost * Number(r.stock || 0);
      return { pv, cv, unitCost, diff: pv - cv };
    };

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
            <div>{String(r.name || "").replace(/^./, (c) => c.toUpperCase())}</div>
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
        renderCell: (r) => (
          <div className="flex items-center justify-center gap-2">
            <Input
              className="w-24 h-8"
              type="number"
              step="0.01"
              value={Number(r.cost ?? 0).toFixed(2)}
              readOnly
              disabled
              title="Cost is managed via Purchases"
            />
          </div>
        ),
      },
      {
        id: "lastUnitCost",
        label: "Last Unit Cost",
        tooltip: "Unit cost from the most recent purchase",
        visible: showLastUnitCost,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => (
          <>
            {typeof r.lastPurchaseCost === "number" ? (
              <Tooltip
                content={`Supplier: ${r.lastPurchaseSupplier || "-"}, Note: ${r.lastPurchaseNote || "-"}`}
              >
                <span title={`Supplier: ${r.lastPurchaseSupplier || "-"}, Note: ${r.lastPurchaseNote || "-"}`}>
                  {Number(r.lastPurchaseCost).toFixed(2)}
                </span>
              </Tooltip>
            ) : (
              "-"
            )}
            {r.lastPurchaseDate && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-1 align-middle"
                aria-label="Show last purchase details"
                title="Show last purchase details"
                onClick={() => {
                  setInfoRow(r);
                  setInfoOpen(true);
                }}
              >
                <Info className="w-3 h-3" />
              </Button>
            )}
          </>
        ),
      },
      {
        id: "lastPurchase",
        label: "Last Purchase",
        tooltip: "Date of the most recent purchase",
        visible: showLastPurchase,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => (
          <>
            {r.lastPurchaseDate ? (
              <Tooltip
                content={`Supplier: ${r.lastPurchaseSupplier || "-"}, Note: ${r.lastPurchaseNote || "-"}`}
              >
                <span title={`Supplier: ${r.lastPurchaseSupplier || "-"}, Note: ${r.lastPurchaseNote || "-"}`}>
                  {new Date(r.lastPurchaseDate).toLocaleDateString()}
                </span>
              </Tooltip>
            ) : (
              "-"
            )}
            {r.lastPurchaseDate && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-1 align-middle"
                aria-label="Show last purchase details"
                title="Show last purchase details"
                onClick={() => {
                  setInfoRow(r);
                  setInfoOpen(true);
                }}
              >
                <Info className="w-3 h-3" />
              </Button>
            )}
          </>
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
        tooltip: "OK / Low / Out, based on the low-stock threshold",
        visible: true,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] ${
              chipToneClass(stockStatusTone(Number(r.stock || 0), lowStockThreshold))
            }`}
          >
            {Number(r.stock || 0) <= 0
              ? "Out"
              : Number(r.stock || 0) <= lowStockThreshold
              ? "Low"
              : "OK"}
          </span>
        ),
      },
      {
        id: "daysOfStock",
        label: "Days of Stock",
        tooltip: "How many days current stock will last at the last 30-day sales pace",
        visible: showDaysOfStock,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => (r.daysOfStock != null ? r.daysOfStock.toFixed(1) : "—"),
      },
      {
        id: "weeksCover",
        label: "Weeks Cover",
        tooltip: "Days of Stock divided by 7",
        visible: showWeeksCover,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => (r.weeksCover != null ? r.weeksCover.toFixed(1) : "—"),
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
          const { pv } = renderMetrics(r);
          return (
            <Tooltip content={`Expected Total Sales Value = Price x Stock = ${Number(r.price || 0).toFixed(2)} x ${Number(r.stock || 0)} = ${pv.toFixed(2)}`}>
              <span>{formatCurrency(pv)}</span>
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
          const { cv, unitCost } = renderMetrics(r);
          return (
            <Tooltip content={`Cost of Purchase = Unit Purchase Cost x Stock = ${unitCost.toFixed(2)} x ${Number(r.stock || 0)} = ${cv.toFixed(2)}`}>
              <span>{formatCurrency(cv)}</span>
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
          const { pv, cv, diff } = renderMetrics(r);
          return (
            <Tooltip content={`P/L = Expected Sales - Cost of Purchase = ${pv.toFixed(2)} - ${cv.toFixed(2)} = ${diff.toFixed(2)}`}>
              <span className={`font-medium ${diff >= 0 ? "text-green-600" : "text-red-600"}`}>
                {formatCurrency(diff)}
              </span>
            </Tooltip>
          );
        },
      },
      {
        id: "reorderPoint",
        label: "Reorder Point",
        tooltip: "Reorder when stock falls to ~7 days of sales",
        visible: showReorderPoint,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => (r.reorderPoint != null ? r.reorderPoint : "—"),
      },
      {
        id: "suggestedReorder",
        label: "Suggested Reorder",
        tooltip: "Quantity needed to reach ~14 days of stock",
        visible: showSuggestedReorder,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => (r.suggestedReorder != null ? r.suggestedReorder : "—"),
      },
      {
        id: "actions",
        label: "Actions",
        tooltip: "Quick actions for restock or movement history",
        visible: true,
        headerClassName: "text-center",
        cellClassName: "text-center",
        renderCell: (r) => (
          <div className="flex flex-col items-center gap-1">
            <a
              href={`/admin/purchases?product=${encodeURIComponent(r.id)}#new`}
              className="text-primary underline-offset-2 hover:underline"
              title="Add Purchase for this product"
            >
              Add Purchase
            </a>
            <a
              href={`/admin/movements?product=${encodeURIComponent(r.id)}`}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              title="View inventory movements"
            >
              Movements
            </a>
          </div>
        ),
      },
    ];
  }, [
    showLastUnitCost,
    showLastPurchase,
    showLastSupplier,
    showDaysOfStock,
    showWeeksCover,
    showExpectedPL,
    showReorderPoint,
    showSuggestedReorder,
    lowStockThreshold,
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

  const totals = useMemo(() => {
    let priceValue = 0;
    let costValue = 0;
    for (const r of sortedRows) {
      const pv = Number(r.price || 0) * Number(r.stock || 0);
      const unitCost =
        typeof r.avgPurchaseCost === "number" && !Number.isNaN(r.avgPurchaseCost)
          ? r.avgPurchaseCost
          : typeof r.lastPurchaseCost === "number" && !Number.isNaN(r.lastPurchaseCost)
          ? r.lastPurchaseCost
          : Number(r.cost || 0);
      const cv = unitCost * Number(r.stock || 0);
      priceValue += pv;
      costValue += cv;
    }
    return { priceValue, costValue };
  }, [sortedRows]);

  function downloadCSV() {
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
    for (const r of sortedRows) {
      const pv = Number(r.price || 0) * Number(r.stock || 0);
      const unitCost =
        typeof r.avgPurchaseCost === "number" && !Number.isNaN(r.avgPurchaseCost)
          ? r.avgPurchaseCost
          : typeof r.lastPurchaseCost === "number" && !Number.isNaN(r.lastPurchaseCost)
          ? r.lastPurchaseCost
          : Number(r.cost || 0);
      const cv = unitCost * Number(r.stock || 0);
      const status =
        Number(r.stock || 0) <= 0
          ? "Out"
          : Number(r.stock || 0) <= lowStockThreshold
          ? "Low"
          : "OK";
      lines.push([
        JSON.stringify(r.name),
        JSON.stringify(r.sku || ""),
        Number(r.price || 0).toFixed(2),
        Number(r.cost || 0).toFixed(2),
        String(r.stock ?? 0),
        JSON.stringify(status),
        r.daysOfStock != null ? Number(r.daysOfStock).toFixed(1) : "",
        r.weeksCover != null ? Number(r.weeksCover).toFixed(1) : "",
        r.reorderPoint != null ? String(r.reorderPoint) : "",
        r.suggestedReorder != null ? String(r.suggestedReorder) : "",
        JSON.stringify(r.lastPurchaseSupplier || ""),
        pv.toFixed(2),
        cv.toFixed(2),
      ].join(","));
    }
    lines.push([
      "Totals",
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
    ].join(","));
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventory_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const saveCurrentFilter = () => {
    const name = window.prompt("Name this saved filter");
    if (!name) return;
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
    setSavedFilters((prev) => [entry, ...prev]);
    toast.success("Saved filter");
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
    toast.success(`Applied "${entry.name}"`);
  };

  const removeSavedFilter = (id: string) => {
    setSavedFilters((prev) => prev.filter((f) => f.id !== id));
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="w-full">
          <CardTitle className="text-base font-semibold">Inventory Valuation</CardTitle>
          <p className="text-sm text-muted-foreground">Realtime snapshot</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto">
          {(() => {
            const count = [
              q ? 1 : 0,
              minStock ? 1 : 0,
              maxStock ? 1 : 0,
              minPrice ? 1 : 0,
              maxPrice ? 1 : 0,
              includeArchived ? 1 : 0,
              sortKey ? 1 : 0,
            ].reduce((a, b) => a + b, 0);
            return count > 0 ? (
              <Badge variant="secondary" title="Active filters and sort">
                {count} active filters
              </Badge>
            ) : null;
          })()}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="hidden md:inline-flex">Columns</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <button
                type="button"
                className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted"
                onClick={() => {
                  setColumnOrder(defaultColumnOrder);
                  setShowLastUnitCost(true);
                  setShowLastPurchase(true);
                  setShowLastSupplier(true);
                  setShowDaysOfStock(true);
                  setShowWeeksCover(true);
                  setShowExpectedPL(true);
                  setShowReorderPoint(true);
                  setShowSuggestedReorder(true);
                }}
              >
                Reset to default layout
              </button>
              <div className="my-1 h-px bg-border" />
              <DropdownMenuCheckboxItem
                checked={columnToggleState}
                onCheckedChange={(v) => {
                  const next = Boolean(v);
                  setShowLastUnitCost(next);
                  setShowLastPurchase(next);
                  setShowLastSupplier(next);
                  setShowDaysOfStock(next);
                  setShowWeeksCover(next);
                  setShowExpectedPL(next);
                  setShowReorderPoint(next);
                  setShowSuggestedReorder(next);
                }}
                onSelect={(e) => e.preventDefault()}
              >
                All optional columns
              </DropdownMenuCheckboxItem>
              <div className="my-1 h-px bg-border" />
              <DropdownMenuCheckboxItem
                checked={showLastUnitCost}
                onCheckedChange={(v) => setShowLastUnitCost(Boolean(v))}
                onSelect={(e) => e.preventDefault()}
              >
                Last Unit Cost
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showLastPurchase}
                onCheckedChange={(v) => setShowLastPurchase(Boolean(v))}
                onSelect={(e) => e.preventDefault()}
              >
                Last Purchase
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showLastSupplier}
                onCheckedChange={(v) => setShowLastSupplier(Boolean(v))}
                onSelect={(e) => e.preventDefault()}
              >
                Last Supplier
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showDaysOfStock}
                onCheckedChange={(v) => setShowDaysOfStock(Boolean(v))}
                onSelect={(e) => e.preventDefault()}
              >
                Days of Stock
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showWeeksCover}
                onCheckedChange={(v) => setShowWeeksCover(Boolean(v))}
                onSelect={(e) => e.preventDefault()}
              >
                Weeks Cover
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showExpectedPL}
                onCheckedChange={(v) => setShowExpectedPL(Boolean(v))}
                onSelect={(e) => e.preventDefault()}
              >
                Expected P/L
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showReorderPoint}
                onCheckedChange={(v) => setShowReorderPoint(Boolean(v))}
                onSelect={(e) => e.preventDefault()}
              >
                Reorder Point
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={showSuggestedReorder}
                onCheckedChange={(v) => setShowSuggestedReorder(Boolean(v))}
                onSelect={(e) => e.preventDefault()}
              >
                Suggested Reorder
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
          <div className="flex flex-wrap items-center gap-1 mr-2">
            <Button
              size="sm"
              variant={valuationMode === "sales" ? "default" : "outline"}
              onClick={() => setValuationMode("sales")}
              title="Show Sales valuation total (Price x Stock)"
            >
              Sales
            </Button>
            <Button
              size="sm"
              variant={valuationMode === "cost" ? "default" : "outline"}
              onClick={() => setValuationMode("cost")}
              title="Show Cost valuation total (Cost x Stock)"
            >
              Cost
            </Button>

            <div className="w-full sm:w-auto text-sm text-muted-foreground">
              Valuation Total:{" "}
              <span className="font-medium text-foreground">
                {formatCurrency(valuationMode === "sales" ? totals.priceValue : totals.costValue)}
              </span>
            </div>
            <span className="text-xs text-muted-foreground underline decoration-dotted cursor-help"
              title={`Expected Sales = Price x Stock. Cost of Purchase = Unit Purchase Cost x Stock. P/L = (Expected Sales - Cost of Purchase).\nDays of Stock/Weeks Cover use the last 30 days of sales. Reorder Point is 7 days of sales (or low-stock threshold if no sales), Suggested Reorder targets 14 days of sales.\nUse Sales/Cost buttons to switch the total shown. Click column headers to sort.`}
            >
              What is this?
            </span>
          </div>
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
              } catch (e) {
                console.error(e);
                toast.error("Could not copy link");
              }
            }}
          >
            Copy Link
          </Button>
          <p className="text-sm text-muted-foreground" suppressHydrationWarning>
            Updated: {updatedAtText || "—"}
          </p>
        </div>
      </CardHeader>
      <CardContent>
        {rows.some((r) => Number(r.stock || 0) < 0) && (
          <div className="mb-3 p-2 rounded-md bg-destructive/10 text-destructive text-sm">
            Warning: One or more products have negative stock. Please review purchases and sales.
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
            <p className="text-xs text-red-600 sm:basis-full">{stockRangeError}</p>
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
            <p className="text-xs text-red-600 sm:basis-full">{priceRangeError}</p>
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
          <Button
            variant="ghost"
            onClick={() => {
              setQ("");
              setMinStock("");
              setMaxStock("");
              setMinPrice("");
              setMaxPrice("");
              setIncludeArchived(false);
              setSortKey(null);
              setSortDir("desc");
            }}
          >
            Reset
          </Button>
        </div>
        <div className="overflow-x-auto">
          {!isLoading && sortedRows.length === 0 && (
            <div className="md:hidden rounded-md border p-4 text-center text-sm text-muted-foreground">
              <div className="flex flex-col items-center gap-3">
                <span>No products found for the current filters.</span>
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setQ("");
                      setMinStock("");
                      setMaxStock("");
                      setMinPrice("");
                      setMaxPrice("");
                      setIncludeArchived(false);
                      setSortKey(null);
                      setSortDir("desc");
                    }}
                  >
                    Clear filters
                  </Button>
                  <Button size="sm" onClick={() => router.push("/admin/products")}>
                    Add product
                  </Button>
                </div>
              </div>
            </div>
          )}

          {sortedRows.length > 0 && (
            <div className="md:hidden space-y-3">
              {sortedRows.map((r) => {
                const pv = Number(r.price || 0) * Number(r.stock || 0);
                const unitCost =
                  typeof r.avgPurchaseCost === "number" && !Number.isNaN(r.avgPurchaseCost)
                    ? r.avgPurchaseCost
                    : typeof r.lastPurchaseCost === "number" && !Number.isNaN(r.lastPurchaseCost)
                      ? r.lastPurchaseCost
                      : Number(r.cost || 0);
                const cv = unitCost * Number(r.stock || 0);
                const diff = pv - cv;
                const statusLabel =
                  Number(r.stock || 0) <= 0
                    ? "Out"
                    : Number(r.stock || 0) <= lowStockThreshold
                      ? "Low"
                      : "OK";
                const statusTone = chipToneClass(stockStatusTone(Number(r.stock || 0), lowStockThreshold));

                return (
                  <div key={r.id} className="rounded-md border p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold truncate">
                          {String(r.name || "").replace(/^./, (c) => c.toUpperCase())}
                        </div>
                        {r.sku ? (
                          <div className="text-xs text-muted-foreground">SKU: {r.sku}</div>
                        ) : null}
                      </div>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] ${statusTone}`}>
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
                        <div className="text-foreground">{formatCurrency(Number(r.price || 0))}</div>
                      </div>
                      <div>
                        <div>Cost</div>
                        <div className="text-foreground">{formatCurrency(unitCost)}</div>
                      </div>
                      <div>
                        <div>Expected Sales</div>
                        <div className="text-foreground">{formatCurrency(pv)}</div>
                      </div>
                      <div>
                        <div>Expected P/L</div>
                        <div className={`font-medium ${diff >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {formatCurrency(diff)}
                        </div>
                      </div>
                      <div>
                        <div>Last Purchase</div>
                        <div className="text-foreground">
                          {r.lastPurchaseDate ? new Date(r.lastPurchaseDate).toLocaleDateString() : "—"}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <a
                        href={`/admin/purchases?product=${encodeURIComponent(r.id)}#new`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        Add Purchase
                      </a>
                      <a
                        href={`/admin/movements?product=${encodeURIComponent(r.id)}`}
                        className="text-xs text-muted-foreground underline-offset-2 hover:underline text-left"
                      >
                        Movements
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <Table className="min-w-[1400px] table-fixed hidden md:table">
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
                      {col.sortable && col.sortKey ? sortIndicator(col.sortKey) : ""}
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
                  <TableCell colSpan={Math.max(1, visibleColumns.length)} className="text-center py-6 text-muted-foreground">
                    Loading inventory...
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={Math.max(1, visibleColumns.length)} className="text-center py-6 text-muted-foreground">
                    <div className="flex flex-col items-center gap-3">
                      <span>No products found for the current filters.</span>
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setQ("");
                            setMinStock("");
                            setMaxStock("");
                            setMinPrice("");
                            setMaxPrice("");
                            setIncludeArchived(false);
                            setSortKey(null);
                            setSortDir("desc");
                          }}
                        >
                          Clear filters
                        </Button>
                        <Button size="sm" onClick={() => router.push("/admin/products")}>
                          Add product
                        </Button>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {sortedRows.map((r) => (
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
              {sortedRows.length > 0 && (
                <TableRow className="border-t-2 border-border bg-muted/30">
                  {visibleColumns.map((col, idx) => {
                    if (idx === 0) {
                      return (
                        <TableCell key={col.id} className="text-center font-semibold py-2" style={{ width: getColWidth(col.id) }}>
                          Totals
                        </TableCell>
                      );
                    }
                    if (col.id === "salesValue") {
                      return (
                        <TableCell key={col.id} className="text-center font-semibold py-2" style={{ width: getColWidth(col.id) }}>
                          {formatCurrency(totals.priceValue)}
                        </TableCell>
                      );
                    }
                    if (col.id === "costValue") {
                      return (
                        <TableCell key={col.id} className="text-center font-semibold py-2" style={{ width: getColWidth(col.id) }}>
                          {formatCurrency(totals.costValue)}
                        </TableCell>
                      );
                    }
                    return <TableCell key={col.id} className="py-2" style={{ width: getColWidth(col.id) }} />;
                  })}
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Last Purchase Details</DialogTitle>
          </DialogHeader>
          {infoRow && (
            <div className="grid gap-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Product</span><span>{String(infoRow.name || "").replace(/^./, (c) => c.toUpperCase())}</span></div>
              {infoRow.sku ? (
                <div className="flex justify-between"><span className="text-muted-foreground">SKU</span><span>{infoRow.sku}</span></div>
              ) : null}
              <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span>{infoRow.lastPurchaseDate ? new Date(infoRow.lastPurchaseDate).toLocaleDateString() : "-"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Last Unit Cost</span><span>{typeof infoRow.lastPurchaseCost === 'number' ? Number(infoRow.lastPurchaseCost).toFixed(2) : "-"}</span></div>
              {infoRow.lastPurchaseSupplier ? (
                <div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span>{infoRow.lastPurchaseSupplier}</span></div>
              ) : null}
              {infoRow.lastPurchaseNote ? (
                <div className="flex justify-between"><span className="text-muted-foreground">Note</span><span>{infoRow.lastPurchaseNote}</span></div>
              ) : null}
            </div>
          )}
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
              <CardTitle className="text-base font-semibold">Inventory</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">Loading inventory…</p>
            </CardContent>
          </Card>
        }
      >
        <InventoryContent />
      </Suspense>
    </section>
  );
}







