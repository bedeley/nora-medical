"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { Suspense, useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Info, ArrowUpDown, ArrowUp, ArrowDown, MessageSquare, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { chipToneClass } from "@/lib/status-chips";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import { logAdminMovementDetailView } from "@/lib/admin-movement-audit-client";

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
  purchaseId?: string | null;
  createdAt: string | Date;
};

type SortField = "createdAt" | "productName" | "delta" | "reason" | "expiryDate";
type SortDir = "asc" | "desc";

const DEFAULT_PAGE_SIZE: 25 | 50 | 100 = 50;
const PRODUCT_PAGE_SIZE = 100;
const REASON_OPTIONS = [
  { value: "", label: "All reasons" },
  { value: "PURCHASE", label: "Purchases" },
  { value: "SALE", label: "Sales" },
  { value: "RETURN", label: "Returns" },
  { value: "ADJUSTMENT", label: "Adjustments" },
  { value: "DELETE", label: "Deletes" },
  { value: "PRODUCT_CREATE", label: "Product create" },
] as const;
const SORT_OPTIONS: Array<{ value: SortField; label: string }> = [
  { value: "createdAt", label: "Date" },
  { value: "productName", label: "Product" },
  { value: "delta", label: "Delta" },
  { value: "reason", label: "Reason" },
  { value: "expiryDate", label: "Expiry" },
];

function toCsvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function formatSignedQuantity(value: number, forcePositiveSign = true) {
  const formatted = Math.abs(Number(value || 0)).toLocaleString();
  if (value < 0) return `-${formatted}`;
  if (value > 0 && forcePositiveSign) return `+${formatted}`;
  return formatted;
}

function formatUnitCost(value: number | string | null | undefined) {
  if (value == null || value === "") return "";
  return `GHS ${Number(value).toFixed(2)}`;
}

function reasonBadge(reason: string) {
  const upper = reason.toUpperCase();
  if (upper.includes("PURCHASE")) return chipToneClass("success");
  if (upper.includes("SALE")) return chipToneClass("danger");
  if (upper.includes("RETURN")) return chipToneClass("info");
  if (upper.includes("ADJUST")) return chipToneClass("warning");
  return chipToneClass("neutral");
}

function SortableHeader({
  field, label, sortBy, sortDir, onSort, className,
}: {
  field: SortField; label: string; sortBy: SortField; sortDir: SortDir;
  onSort: (f: SortField) => void; className?: string;
}) {
  const isActive = sortBy === field;
  return (
    <th
      className={`p-2 border cursor-pointer select-none hover:bg-accent/50 transition-colors${className ? ` ${className}` : ""}`}
      onClick={() => onSort(field)}
      title={`Sort by ${label}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
        ) : (
          <ArrowUpDown className="w-3 h-3 text-muted-foreground/40" />
        )}
      </span>
    </th>
  );
}

function expiryStatusBadge(date: Date | string) {
  const d = new Date(date);
  const diffDays = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0)
    return <span className="ml-1 rounded px-1.5 py-0.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200">Expired</span>;
  if (diffDays <= 30)
    return <span className="ml-1 rounded px-1.5 py-0.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200">Exp. in {diffDays}d</span>;
  if (diffDays <= 60)
    return <span className="ml-1 rounded px-1.5 py-0.5 text-xs font-medium text-yellow-700 bg-yellow-50 border border-yellow-200">Exp. in {diffDays}d</span>;
  return null;
}

function getDatePresets() {
  const today = new Date();
  const toStr = (d: Date) => d.toISOString().slice(0, 10);
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
  return [
    { label: "Today", start: toStr(today), end: toStr(today) },
    { label: "Last 7 days", start: toStr(addDays(today, -6)), end: toStr(today) },
    { label: "This month", start: toStr(new Date(today.getFullYear(), today.getMonth(), 1)), end: toStr(today) },
    {
      label: "Last month",
      start: toStr(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      end: toStr(new Date(today.getFullYear(), today.getMonth(), 0)),
    },
  ];
}

function MovementCardsSkeleton() {
  return (
    <div className="space-y-3 lg:hidden" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="space-y-3 rounded-lg border p-4 shadow-sm">
          <div className="flex items-start gap-3">
            <Skeleton className="mt-1 h-4 w-4 rounded-sm" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-3 w-36" />
            </div>
            <Skeleton className="h-8 w-8 rounded-md" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function MovementTableSkeleton({ colSpan }: { colSpan: number }) {
  return (
    <div className="hidden overflow-x-auto lg:block" aria-hidden="true">
      <table className="w-full border-collapse border border-gray-200 text-sm dark:border-gray-800">
        <thead className="bg-muted text-left">
          <tr>
            <th className="w-[36px] border p-2"><Skeleton className="h-4 w-4 rounded-sm" /></th>
            <th className="border p-2"><Skeleton className="h-4 w-20" /></th>
            <th className="border p-2"><Skeleton className="h-4 w-24" /></th>
            <th className="border p-2"><Skeleton className="h-4 w-16" /></th>
            <th className="border p-2"><Skeleton className="h-4 w-16" /></th>
            <th className="border p-2"><Skeleton className="h-4 w-16" /></th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, index) => (
            <tr key={index} className="odd:bg-background even:bg-muted/40">
              <td colSpan={colSpan} className="border p-3">
                <div className="grid gap-3 lg:grid-cols-6">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdminMovementsContent() {
  const { data: session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialized = useRef(false);
  const movementRequestSeq = useRef(0);
  const productRequestSeq = useRef(0);
  const selectedRef = useRef<MovementRow | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [filters, setFilters] = useState({ start: "", end: "", product: "", reason: "", lotId: "" });
  const [productSearch, setProductSearch] = useState("");
  const deferredProductSearch = useDeferredValue(productSearch);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [rows, setRows] = useState<MovementRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [stats, setStats] = useState({ totalIn: 0, totalOut: 0, net: 0 });
  const [movementsError, setMovementsError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(DEFAULT_PAGE_SIZE);
  const [sortBy, setSortBy] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<MovementRow | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsTotal, setProductsTotal] = useState(0);
  const [productsError, setProductsError] = useState("");
  const [productsLoading, setProductsLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showSupplierCol, setShowSupplierCol] = useState(true);
  const [showUnitCostCol, setShowUnitCostCol] = useState(true);
  const [showLotCol, setShowLotCol] = useState(true);
  const [showExpiryCol, setShowExpiryCol] = useState(true);
  const [isExportingFiltered, setIsExportingFiltered] = useState(false);
  const [isExportingSelected, setIsExportingSelected] = useState(false);
  const role = String(session?.user?.role || "");
  const isAdmin = role === "ADMIN";
  const movementsAuditHref = "/admin/audit?sourcePage=admin/movements";

  const updateFilters = useCallback((next: Partial<typeof filters>) => {
    setPage(1);
    setFilters((prev) => ({ ...prev, ...next }));
  }, []);

  const openMovementDetails = useCallback((row: MovementRow) => {
    selectedRef.current = row;
    setSelected(row);
    setOpen(true);
    void logAdminMovementDetailView({
      movementId: row.id,
      productId: row.productId,
      productName: row.productName,
      productSku: row.productSku ?? null,
      reason: row.reason,
      delta: row.delta,
      createdAt: new Date(row.createdAt).toISOString(),
      lotCode: row.lotCode ?? null,
      expiryDate: row.expiryDate ? new Date(row.expiryDate).toISOString() : null,
      supplier: row.supplier ?? null,
      hasNote: Boolean(row.note),
      hasUnitCost: row.unitCost != null && row.unitCost !== "",
      filters,
      page,
      pageSize,
      totalRows,
      sortBy,
      sortDir,
    });
  }, [filters, page, pageSize, sortBy, sortDir, totalRows]);

  const handleDetailOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      selectedRef.current = null;
      setSelected(null);
    }
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    const params = new URLSearchParams(searchParams.toString());
    setFilters({
      start: params.get("start") || "",
      end: params.get("end") || "",
      product: params.get("product") || "",
      reason: params.get("reason") || "",
      lotId: params.get("lotId") || "",
    });
    initialized.current = true;
    setIsReady(true);
  }, [searchParams]);

  useEffect(() => {
    if (!isReady) return;
    const params = new URLSearchParams();
    if (filters.start) params.set("start", filters.start);
    if (filters.end) params.set("end", filters.end);
    if (filters.product) params.set("product", filters.product);
    if (filters.reason) params.set("reason", filters.reason);
    if (filters.lotId) params.set("lotId", filters.lotId);
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [filters, isReady, pathname, router]);

  const fetchProducts = useCallback(async (query: string, selectedProductId: string) => {
    const requestSeq = ++productRequestSeq.current;
    setProductsError("");
    setProductsLoading(true);

    try {
      const params = new URLSearchParams({
        includeArchived: "1",
        page: "1",
        pageSize: String(PRODUCT_PAGE_SIZE),
        sort: "name",
        sortDir: "asc",
      });
      if (query) params.set("q", query);
      const res = await fetch(`/api/products?${params.toString()}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as
        | { items?: Array<{ id?: string; name?: string; sku?: string | null }>; total?: number; error?: string }
        | null;
      if (!res.ok) throw new Error(String(data?.error || "Failed to load products."));

      let items: Product[] = Array.isArray(data?.items)
        ? data.items
            .filter((item): item is { id: string; name: string; sku?: string | null } => Boolean(item?.id && item?.name))
            .map((item) => ({
              id: item.id,
              name: item.name,
              sku: item.sku ?? null,
            }))
        : [];

      if (selectedProductId && !items.some((item) => item.id === selectedProductId)) {
        const selectedParams = new URLSearchParams({
          ids: selectedProductId,
          includeArchived: "1",
        });
        const selectedRes = await fetch(`/api/products?${selectedParams.toString()}`, { cache: "no-store" });
        const selectedData = (await selectedRes.json().catch(() => null)) as
          | { items?: Array<{ id?: string; name?: string; sku?: string | null }>; error?: string }
          | null;
        if (selectedRes.ok && Array.isArray(selectedData?.items) && selectedData.items[0]?.id && selectedData.items[0]?.name) {
          items = [{
            id: String(selectedData.items[0].id),
            name: String(selectedData.items[0].name),
            sku: selectedData.items[0].sku ?? null,
          }, ...items];
        }
      }

      const deduped = items.filter((item, index, array) => array.findIndex((candidate) => candidate.id === item.id) === index);

      if (requestSeq !== productRequestSeq.current) return;
      setProducts(deduped);
      setProductsTotal(Number(data?.total || deduped.length));
    } catch (error) {
      if (requestSeq !== productRequestSeq.current) return;
      const message = error instanceof Error ? error.message : "Failed to load products.";
      setProductsError(message);
      toast.error(message);
    } finally {
      if (requestSeq === productRequestSeq.current) {
        setProductsLoading(false);
      }
    }
  }, []);

  const fetchMovements = useCallback(async () => {
    if (!isReady) return;
    const requestSeq = ++movementRequestSeq.current;
    setLoading(true);
    setMovementsError("");

    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        sortBy,
        sortDir,
      });
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.product) params.append("product", filters.product);
      if (filters.reason) params.append("reason", filters.reason);
      if (filters.lotId) params.append("lotId", filters.lotId);
      const res = await fetch(`/api/admin/movements?${params.toString()}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as
        | {
            items?: MovementRow[];
            total?: number;
            stats?: { totalIn?: number; totalOut?: number; net?: number };
            error?: string;
          }
        | null;
      if (!res.ok) throw new Error(String(data?.error || "Failed to load movements."));
      if (requestSeq !== movementRequestSeq.current) return;

      const nextRows = Array.isArray(data?.items) ? data.items : [];
      setRows(nextRows);
      setTotalRows(Number(data?.total || 0));
      setStats({
        totalIn: Number(data?.stats?.totalIn || 0),
        totalOut: Number(data?.stats?.totalOut || 0),
        net: Number(data?.stats?.net || 0),
      });
      setSelectedIds(new Set());
      setSelected((current) => (current && nextRows.some((row) => row.id === current.id) ? current : null));
      setOpen((currentOpen) => {
        const sel = selectedRef.current;
        return currentOpen && sel != null && nextRows.some((row) => row.id === sel.id) ? currentOpen : false;
      });
    } catch (error) {
      if (requestSeq !== movementRequestSeq.current) return;
      const message = error instanceof Error ? error.message : "Failed to load movements.";
      setMovementsError(message);
      toast.error(message);
    } finally {
      if (requestSeq === movementRequestSeq.current) {
        setLoading(false);
        setHasLoaded(true);
      }
    }
  }, [filters, isReady, page, pageSize, sortBy, sortDir]);

  useEffect(() => {
    if (!isReady) return;
    void fetchProducts(deferredProductSearch.trim(), filters.product);
  }, [deferredProductSearch, fetchProducts, filters.product, isReady]);

  useEffect(() => {
    void fetchMovements();
  }, [fetchMovements]);

  const tableColSpan = 6
    + (showSupplierCol ? 1 : 0)
    + (showUnitCostCol ? 1 : 0)
    + (showLotCol ? 1 : 0)
    + (showExpiryCol ? 1 : 0);
  const reasonFilter = filters.reason.trim().toUpperCase();
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const hasEmptyState = hasLoaded && !loading && !movementsError && totalRows === 0;

  const visibleIds = rows.map((r) => r.id);
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

  const handleSort = useCallback((field: SortField) => {
    setPage(1);
    if (field === sortBy) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(field);
      setSortDir("desc");
    }
  }, [sortBy]);

  const exportSelected = async () => {
    const selectedRows = rows.filter((r) => selectedIds.has(r.id));
    if (selectedRows.length === 0) {
      toast.error("Select at least one movement to export.");
      return;
    }
    if (isExportingSelected) return;
    setIsExportingSelected(true);

    try {
      const header = ["Date", "Product", "SKU", "Delta", "Reason", "Note", "Supplier", "Unit Cost", "Lot", "Expiry"];
      const lines = [header.map(toCsvCell).join(",")];
      for (const row of selectedRows) {
        lines.push([
          toCsvCell(new Date(row.createdAt).toISOString()),
          toCsvCell(row.productName || ""),
          toCsvCell(row.productSku || ""),
          toCsvCell(Number(row.delta || 0)),
          toCsvCell(row.reason || ""),
          toCsvCell(row.note || ""),
          toCsvCell(row.supplier || ""),
          toCsvCell(row.unitCost == null ? "" : Number(row.unitCost).toFixed(2)),
          toCsvCell(row.lotCode || ""),
          toCsvCell(row.expiryDate ? new Date(row.expiryDate).toISOString().slice(0, 10) : ""),
        ].join(","));
      }
      const csv = lines.join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const filename = `movements_selected_${Date.now()}.csv`;
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      void logAdminExportDownload({
        area: "movements",
        format: "CSV",
        fileName: filename,
        rowCount: selectedRows.length,
        columnCount: header.length,
        byteSize: blob.size,
        sourcePage: "admin/movements",
        scopeSnapshot: "Selected movement rows on current page",
        resultSummary: `Downloaded ${selectedRows.length} selected movement row${selectedRows.length === 1 ? "" : "s"} as CSV.`,
      });
    } finally {
      setIsExportingSelected(false);
    }
  };

  const handleExport = async () => {
    if (isExportingFiltered) return;
    setIsExportingFiltered(true);

    try {
      const params = new URLSearchParams({
        format: "csv",
        sortBy,
        sortDir,
      });
      if (filters.start) params.append("start", filters.start);
      if (filters.end) params.append("end", filters.end);
      if (filters.product) params.append("product", filters.product);
      if (filters.reason) params.append("reason", filters.reason);
      if (filters.lotId) params.append("lotId", filters.lotId);

      const res = await fetch(`/api/admin/movements?${params.toString()}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(String(data?.error || "Failed to export movements."));
      }
      const blob = await res.blob();
      const link = document.createElement("a");
      const filename = `movements_${Date.now()}.csv`;
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      void logAdminExportDownload({
        area: "movements",
        format: "CSV",
        fileName: filename,
        byteSize: blob.size,
        sourcePage: "admin/movements",
        scopeSnapshot: `Start: ${filters.start || "-"} | End: ${filters.end || "-"} | Product: ${filters.product || "-"} | Reason: ${filters.reason || "-"} | Lot: ${filters.lotId || "-"} | Sort: ${sortBy}:${sortDir}`,
        resultSummary: `Downloaded filtered movements CSV for ${totalRows.toLocaleString()} matching row${totalRows === 1 ? "" : "s"}.`,
        matchingCount: totalRows,
        sortKey: sortBy,
        sortDir,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to export movements.");
    } finally {
      setIsExportingFiltered(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1 text-center sm:text-left w-full sm:w-auto">
          <CardTitle className="text-base font-semibold">Inventory Movements</CardTitle>
          <p className="text-sm text-muted-foreground">Audit restocks and sales by product, lot, and time.</p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:justify-end">
          {isAdmin ? (
            <Button asChild className="w-full sm:w-auto" variant="outline">
              <Link href={movementsAuditHref}>View audit trail</Link>
            </Button>
          ) : null}
          <Button className="w-full sm:w-auto" variant="outline" onClick={handleExport} disabled={isExportingFiltered}>
            {isExportingFiltered ? "Exporting..." : "Export CSV (filtered)"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {movementsError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {movementsError}
          </div>
        ) : null}
        {productsError ? (
          <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {productsError}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div>
            <Label htmlFor="start">Start date</Label>
            <Input id="start" type="date" value={filters.start} onChange={(e) => updateFilters({ start: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="end">End date</Label>
            <Input id="end" type="date" value={filters.end} onChange={(e) => updateFilters({ end: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="lotId">Lot ID</Label>
            <Input
              id="lotId"
              value={filters.lotId}
              onChange={(e) => updateFilters({ lotId: e.target.value })}
              placeholder="Paste a lot ID"
            />
          </div>
          <div>
            <Label htmlFor="reason">Reason</Label>
            <select
              id="reason"
              className="h-9 w-full rounded-md border bg-background px-3"
              value={filters.reason}
              onChange={(e) => updateFilters({ reason: e.target.value })}
            >
              {REASON_OPTIONS.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
              {filters.reason && !REASON_OPTIONS.some((option) => option.value === filters.reason) ? (
                <option value={filters.reason}>Custom: {filters.reason}</option>
              ) : null}
            </select>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="productSearch">Product</Label>
            <div className="space-y-2">
              <Input
                id="productSearch"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Search product name or SKU"
              />
              <select
                className="h-9 w-full rounded-md border bg-background px-3"
                value={filters.product}
                onChange={(e) => updateFilters({ product: e.target.value })}
              >
                <option value="">All products</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}{product.sku ? ` - ${product.sku}` : ""}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {productsLoading
                  ? "Loading product options..."
                  : productSearch.trim()
                    ? `Showing ${products.length} of ${productsTotal || products.length} matching products.`
                    : `Showing ${products.length} of ${productsTotal || products.length} products. Search to narrow the list.`}
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Date presets</span>
          {getDatePresets().map((preset) => (
            <Button
              key={preset.label}
              type="button"
              size="sm"
              variant={filters.start === preset.start && filters.end === preset.end ? "default" : "outline"}
              onClick={() => updateFilters({ start: preset.start, end: preset.end })}
            >
              {preset.label}
            </Button>
          ))}
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
                onClick={() => updateFilters({ lotId: "" })}
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
            onClick={() => updateFilters({ reason: "" })}
          >
            All
          </Button>
          <Button
            type="button"
            size="sm"
            variant={reasonFilter.includes("PURCHASE") ? "default" : "outline"}
            onClick={() => updateFilters({ reason: "PURCHASE" })}
          >
            Purchases
          </Button>
          <Button
            type="button"
            size="sm"
            variant={reasonFilter.includes("SALE") ? "default" : "outline"}
            onClick={() => updateFilters({ reason: "SALE" })}
          >
            Sales
          </Button>
          <Button
            type="button"
            size="sm"
            variant={reasonFilter.includes("RETURN") ? "default" : "outline"}
            onClick={() => updateFilters({ reason: "RETURN" })}
          >
            Returns
          </Button>
          <Button
            type="button"
            size="sm"
            variant={reasonFilter.includes("ADJUST") ? "default" : "outline"}
            onClick={() => updateFilters({ reason: "ADJUSTMENT" })}
          >
            Adjustments
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setProductSearch("");
              setSortBy("createdAt");
              setSortDir("desc");
              setPage(1);
              setFilters({ start: "", end: "", product: "", reason: "", lotId: "" });
            }}
          >
            Clear filters
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Total in</div>
            <div className="text-lg font-semibold text-emerald-700">{formatSignedQuantity(stats.totalIn)} units</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Total out</div>
            <div className="text-lg font-semibold text-rose-700">-{Math.abs(Number(stats.totalOut || 0)).toLocaleString()} units</div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Net</div>
            <div className={`text-lg font-semibold ${stats.net >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
              {formatSignedQuantity(stats.net)} units
            </div>
          </div>
          <div className="rounded-md bg-background p-3 shadow-sm">
            <div className="text-xs text-muted-foreground">Movements</div>
            <div className="text-lg font-semibold">{totalRows.toLocaleString()} filtered rows</div>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{loading && !hasLoaded ? "Loading movements..." : `${totalRows.toLocaleString()} record(s)`}</span>
            <span className="hidden sm:inline">|</span>
            {/* Sort dropdowns shown on mobile only; desktop uses clickable column headers */}
            <label className="flex items-center gap-1 lg:hidden">
              <span className="text-xs">Sort by:</span>
              <select
                className="h-7 rounded border bg-background px-1 text-xs"
                value={sortBy}
                onChange={(e) => { setSortBy(e.target.value as SortField); setPage(1); }}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 lg:hidden">
              <span className="text-xs">Order:</span>
              <select
                className="h-7 rounded border bg-background px-1 text-xs"
                value={sortDir}
                onChange={(e) => { setSortDir(e.target.value as SortDir); setPage(1); }}
              >
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </label>
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
              <span className="font-medium">{selectedCount} selected on this page</span>
              <Button variant="ghost" size="sm" onClick={clearSelection}>Clear</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void exportSelected()} disabled={isExportingSelected}>
                {isExportingSelected ? "Exporting..." : `Export ${selectedCount} selected`}
              </Button>
              <Button size="sm" onClick={handleExport} disabled={isExportingFiltered} title="Export all rows matching current filters - not just this page">
                {isExportingFiltered ? "Exporting..." : `Download all ${totalRows.toLocaleString()} filtered rows`}
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <>
            <MovementCardsSkeleton />
            <MovementTableSkeleton colSpan={tableColSpan} />
          </>
        ) : null}

        {!loading ? (
          <>
            <div className="lg:hidden space-y-3">
              {hasEmptyState ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  <p>No movements found for the current filters.</p>
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setProductSearch("");
                        setFilters({ start: "", end: "", product: "", reason: "", lotId: "" });
                        setPage(1);
                      }}
                    >
                      Clear filters
                    </Button>
                    <Button size="sm" variant="outline" onClick={handleExport} disabled={isExportingFiltered}>
                      {isExportingFiltered ? "Exporting..." : "Export CSV"}
                    </Button>
                  </div>
                </div>
              ) : (
                rows.map((row) => (
                  <div key={row.id} className="space-y-3 rounded-lg border p-4 shadow-sm">
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4"
                        checked={selectedIds.has(row.id)}
                        onChange={() => toggleSelected(row.id)}
                        aria-label={`Select movement ${row.id}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="inline-flex items-center gap-1.5 text-sm font-semibold break-words">
                          {row.productName}
                          {row.note ? (
                            <span title={row.note}>
                              <MessageSquare className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                            </span>
                          ) : null}
                        </p>
                        {row.productSku ? <p className="text-xs text-muted-foreground">SKU: {row.productSku}</p> : null}
                        <p className="text-xs text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="View details"
                        title="View details"
                        onClick={() => openMovementDetails(row)}
                      >
                        <Info className="w-4 h-4" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <p className="text-muted-foreground text-xs uppercase">Delta</p>
                        <p className={`font-semibold ${row.delta >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {formatSignedQuantity(row.delta)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-muted-foreground text-xs uppercase">Reason</p>
                        <p className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${reasonBadge(row.reason)}`}>
                          {row.reason}
                        </p>
                      </div>
                      {showUnitCostCol && row.unitCost != null ? (
                        <div>
                          <p className="text-muted-foreground text-xs uppercase">Unit Cost</p>
                          <p className="font-medium">{formatUnitCost(row.unitCost)}</p>
                        </div>
                      ) : null}
                      {showLotCol && row.lotCode ? (
                        <div>
                          <p className="text-muted-foreground text-xs uppercase">Lot</p>
                          <p className="font-medium">{row.lotCode}</p>
                        </div>
                      ) : null}
                      {showExpiryCol && row.expiryDate ? (
                        <div>
                          <p className="text-muted-foreground text-xs uppercase">Expiry</p>
                          <p className="font-medium inline-flex flex-wrap items-center gap-1">
                            {new Date(row.expiryDate).toLocaleDateString()}
                            {expiryStatusBadge(row.expiryDate)}
                          </p>
                        </div>
                      ) : null}
                      {showSupplierCol && row.supplier ? (
                        <div className="text-right">
                          <p className="text-muted-foreground text-xs uppercase">Supplier</p>
                          <p className="font-medium">{row.supplier}</p>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full border-collapse border border-gray-200 text-sm dark:border-gray-800">
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
                    <SortableHeader field="createdAt" label="Date" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    <SortableHeader field="productName" label="Product" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    <SortableHeader field="delta" label="Delta" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="text-right" />
                    <SortableHeader field="reason" label="Reason" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                    {showSupplierCol ? <th className="p-2 border">Supplier</th> : null}
                    {showUnitCostCol ? <th className="p-2 border text-right">Unit Cost</th> : null}
                    {showLotCol ? <th className="p-2 border">Lot</th> : null}
                    {showExpiryCol ? <SortableHeader field="expiryDate" label="Expiry" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} /> : null}
                    <th className="p-2 border text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {hasEmptyState ? (
                    <tr>
                      <td colSpan={tableColSpan} className="p-6 text-center text-muted-foreground">
                        <div className="flex flex-col items-center gap-3">
                          <span>No movements found for the current filters.</span>
                          <div className="flex flex-wrap justify-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setProductSearch("");
                                setFilters({ start: "", end: "", product: "", reason: "", lotId: "" });
                                setPage(1);
                              }}
                            >
                              Clear filters
                            </Button>
                            <Button size="sm" variant="outline" onClick={handleExport} disabled={isExportingFiltered}>
                              {isExportingFiltered ? "Exporting..." : "Export CSV"}
                            </Button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr
                        key={row.id}
                        className="odd:bg-background even:bg-muted/40 hover:bg-accent/60 cursor-pointer"
                        onClick={() => openMovementDetails(row)}
                        title="View details"
                      >
                        <td className="p-2 border text-center" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={selectedIds.has(row.id)}
                            onChange={() => toggleSelected(row.id)}
                            aria-label={`Select movement ${row.id}`}
                          />
                        </td>
                        <td className="p-2 border">{new Date(row.createdAt).toLocaleString()}</td>
                        <td className="p-2 border">
                          <div className="space-y-0.5">
                            <div className="inline-flex items-center gap-1.5">
                              {row.productName}
                              {row.note ? (
                                <span title={row.note}>
                                  <MessageSquare className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                                </span>
                              ) : null}
                            </div>
                            {row.productSku ? <div className="text-xs text-muted-foreground">SKU: {row.productSku}</div> : null}
                          </div>
                        </td>
                        <td className={`p-2 border text-right ${row.delta >= 0 ? "text-green-600" : "text-red-600"}`}>
                          {formatSignedQuantity(row.delta)}
                        </td>
                        <td className="p-2 border">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${reasonBadge(row.reason)}`}>
                            {row.reason}
                          </span>
                        </td>
                        {showSupplierCol ? <td className="p-2 border">{row.supplier || ""}</td> : null}
                        {showUnitCostCol ? <td className="p-2 border text-right">{formatUnitCost(row.unitCost)}</td> : null}
                        {showLotCol ? <td className="p-2 border">{row.lotCode || ""}</td> : null}
                        {showExpiryCol ? (
                          <td className="p-2 border">
                            {row.expiryDate ? (
                              <span className="inline-flex flex-wrap items-center gap-1">
                                {new Date(row.expiryDate).toLocaleDateString()}
                                {expiryStatusBadge(row.expiryDate)}
                              </span>
                            ) : ""}
                          </td>
                        ) : null}
                        <td className="p-2 border text-right" onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="View details"
                            title="View details"
                            onClick={() => openMovementDetails(row)}
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

            {hasLoaded && !movementsError && totalRows > 0 ? (
              <div className="flex items-center justify-between gap-3 border-t pt-2 text-xs text-muted-foreground">
                <span>
                  Page {page} of {totalPages} - showing {rows.length} of {totalRows.toLocaleString()} rows
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={page >= totalPages || loading}
                    onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        <Dialog open={open} onOpenChange={handleDetailOpenChange}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-base font-semibold">Movement Details</DialogTitle>
              <DialogDescription>
                Review the selected stock movement, including reason, quantity, lot, and sourcing details.
              </DialogDescription>
            </DialogHeader>
            {selected && (
              <div className="grid gap-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Date</span><span>{new Date(selected.createdAt).toLocaleString()}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Product</span><span>{selected.productName}</span></div>
                {selected.productSku ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">SKU</span><span>{selected.productSku}</span></div>
                ) : null}
                <div className="flex justify-between"><span className="text-muted-foreground">Delta</span><span className={selected.delta >= 0 ? 'text-green-600' : 'text-red-600'}>{formatSignedQuantity(selected.delta)}</span></div>
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
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Expiry</span>
                    <span className="inline-flex items-center gap-1.5">
                      {new Date(selected.expiryDate).toLocaleDateString()}
                      {expiryStatusBadge(selected.expiryDate)}
                    </span>
                  </div>
                ) : null}
                {selected.supplier ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">Supplier</span><span>{selected.supplier}</span></div>
                ) : null}
                {selected.unitCost != null ? (
                  <div className="flex justify-between"><span className="text-muted-foreground">Unit Cost</span><span>{formatUnitCost(selected.unitCost)}</span></div>
                ) : null}
                {selected.purchaseId ? (
                  <div className="pt-2 border-t">
                    <Link
                      href={`/admin/purchases?purchaseId=${selected.purchaseId}`}
                      className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                      onClick={() => setOpen(false)}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      View source purchase
                    </Link>
                  </div>
                ) : null}
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
              <p className="text-sm text-muted-foreground">Loading movements...</p>
            </CardContent>
          </Card>
        }
      >
        <AdminMovementsContent />
      </Suspense>
    </section>
  );
}
