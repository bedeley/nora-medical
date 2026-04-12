"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { useClientQuery } from "@/hooks/use-client-query";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import { PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS } from "@/lib/product-categories";
import {
  SYSTEM_SUPPLIER_NAMES,
  type AdminProduct,
  type ProductSortDir,
  type ProductSortField,
  type ProductStockFilter,
  type ProductsOverviewStats,
  type ProductsSavedFilter,
  type SupplierOption,
} from "./types";

const fetcher = (url: string) => fetch(url).then((response) => response.json());

type AdminProductsResponse = {
  items?: AdminProduct[];
  total?: number;
  stats?: ProductsOverviewStats | null;
};

export function useAdminProductsPageState() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sortDir, setSortDir] = useState<ProductSortDir>("desc");
  const [sortField, setSortField] = useState<ProductSortField>("updatedAt");
  const [showCost, setShowCost] = useState(false);
  const [stockFilter, setStockFilter] = useState<ProductStockFilter>("all");
  const [bulkSupplierOpen, setBulkSupplierOpen] = useState(false);
  const [bulkSupplierId, setBulkSupplierId] = useState("");
  const [bulkSupplierName, setBulkSupplierName] = useState("");
  const [bulkSupplierReason, setBulkSupplierReason] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkMinMarginOpen, setBulkMinMarginOpen] = useState(false);
  const [bulkMinMarginCategory, setBulkMinMarginCategory] = useState("");
  const [bulkMinMarginValue, setBulkMinMarginValue] = useState("");
  const [bulkMinMarginReason, setBulkMinMarginReason] = useState("");
  const [bulkMinMarginSaving, setBulkMinMarginSaving] = useState(false);
  const [archiveReasonOpen, setArchiveReasonOpen] = useState(false);
  const [archiveReasonInput, setArchiveReasonInput] = useState("");
  const [saveFilterOpen, setSaveFilterOpen] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState("");
  const [savedFilters, setSavedFilters] = useState<ProductsSavedFilter[]>([]);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    select: 44,
    name: 260,
    category: 160,
    supplier: 180,
    price: 120,
    cost: 120,
    margin: 120,
    stock: 120,
    updated: 140,
    actions: 200,
  });

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const archiveReasonResolve = useRef<((reason: string | null) => void) | null>(null);
  const resizing = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const initializedFromSearchParams = useRef(false);

  const role = (session?.user as { role?: string } | undefined)?.role || "";
  const isAdmin = role === "ADMIN";
  const canShowCost = isAdmin && showCost;

  useEffect(() => {
    if (initializedFromSearchParams.current) return;
    initializedFromSearchParams.current = true;

    const includeArchivedParam = searchParams.get("includeArchived");
    if (includeArchivedParam === "1" || includeArchivedParam === "true") setIncludeArchived(true);

    const query = searchParams.get("q");
    if (typeof query === "string") {
      setSearch(query);
      setSearchInput(query);
    }

    const rawCategory = String(searchParams.get("category") || "").toLowerCase();
    if (PRODUCT_CATEGORIES.includes(rawCategory as (typeof PRODUCT_CATEGORIES)[number])) {
      setCategoryFilter(rawCategory);
    }

    const rawSupplierId = String(searchParams.get("supplierId") || "").trim();
    if (rawSupplierId) setSupplierFilter(rawSupplierId);

    const edit = searchParams.get("edit");
    if (edit) setEditId(edit);

    const nextPage = Number(searchParams.get("page") || 1);
    const nextPageSize = Number(searchParams.get("pageSize") || 10);
    const nextSortField = searchParams.get("sort");
    const nextSortDir = searchParams.get("sortDir");
    const nextShowCost = searchParams.get("showCost");
    const nextStockFilter = searchParams.get("stockFilter");

    if (!Number.isNaN(nextPage) && nextPage > 0) setPage(nextPage);
    if (!Number.isNaN(nextPageSize) && nextPageSize > 0) setPageSize(nextPageSize);
    if (isSortField(nextSortField)) setSortField(nextSortField);
    if (nextSortDir === "asc" || nextSortDir === "desc") setSortDir(nextSortDir);
    if (nextShowCost === "1" || nextShowCost === "true") setShowCost(true);
    if (nextStockFilter === "low" || nextStockFilter === "out") setStockFilter(nextStockFilter);
  }, [searchParams]);

  useEffect(() => {
    if (!isAdmin) setShowCost(false);
  }, [isAdmin]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-products-saved-filters");
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as ProductsSavedFilter[];
      if (Array.isArray(parsed)) setSavedFilters(parsed);
    } catch {
      // ignore invalid saved filter payloads
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("admin-products-saved-filters", JSON.stringify(savedFilters));
  }, [savedFilters]);

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());

    if (search) params.set("q", search);
    else params.delete("q");

    if (categoryFilter) params.set("category", categoryFilter);
    else params.delete("category");

    if (supplierFilter) params.set("supplierId", supplierFilter);
    else params.delete("supplierId");

    if (includeArchived) params.set("includeArchived", "1");
    else params.delete("includeArchived");

    if (sortField !== "updatedAt") params.set("sort", sortField);
    else params.delete("sort");

    if (sortDir !== "desc") params.set("sortDir", sortDir);
    else params.delete("sortDir");

    if (showCost && isAdmin) params.set("showCost", "1");
    else params.delete("showCost");

    if (stockFilter !== "all") params.set("stockFilter", stockFilter);
    else params.delete("stockFilter");

    if (page !== 1) params.set("page", String(page));
    else params.delete("page");

    if (pageSize !== 10) params.set("pageSize", String(pageSize));
    else params.delete("pageSize");

    if (editId) params.set("edit", editId);
    else params.delete("edit");

    const next = params.toString();
    const current = searchParams.toString();
    if (next !== current) {
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    }
  }, [
    categoryFilter,
    editId,
    includeArchived,
    isAdmin,
    page,
    pageSize,
    pathname,
    router,
    search,
    searchParams,
    showCost,
    sortDir,
    sortField,
    stockFilter,
    supplierFilter,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-products-column-widths");
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (parsed && typeof parsed === "object") {
        setColumnWidths((current) => ({ ...current, ...parsed }));
      }
    } catch {
      // ignore invalid column width payloads
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("admin-products-column-widths", JSON.stringify(columnWidths));
  }, [columnWidths]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizing.current) return;

      const { key, startX, startWidth } = resizing.current;
      const delta = event.clientX - startX;
      const nextWidth = Math.max(90, startWidth + delta);
      setColumnWidths((current) => ({ ...current, [key]: nextWidth }));
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

  useEffect(() => {
    const handleTypeToSearch = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const input = searchInputRef.current;
        if (!input) return;

        input.value = "";
        setSearchInput("");
        setPage(1);
        try {
          input.setSelectionRange(0, 0);
        } catch {
          // ignore unsupported selection APIs
        }
        event.preventDefault();
        return;
      }

      if (isTextInput(event.target)) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (!event.key || event.key.length !== 1) return;

      const input = searchInputRef.current;
      if (!input) return;

      input.focus();
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      const next = input.value.slice(0, start) + event.key + input.value.slice(end);

      input.value = next;
      setSearchInput(next);
      setPage(1);
      try {
        input.setSelectionRange(start + 1, start + 1);
      } catch {
        // ignore unsupported selection APIs
      }
    };

    window.addEventListener("keydown", handleTypeToSearch, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleTypeToSearch, { capture: true } as EventListenerOptions);
    };
  }, []);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setSearch(searchInput);
    }, 400);

    return () => clearTimeout(timeoutId);
  }, [searchInput]);

  useEffect(() => {
    const onSlashFocus = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const tag = (target?.tagName || "").toLowerCase();
      const isEditable = tag === "input" || tag === "textarea" || (target?.isContentEditable ?? false);
      if (isEditable) return;

      event.preventDefault();
      const input = searchInputRef.current;
      if (!input) return;

      input.focus();
      try {
        input.select();
      } catch {
        // ignore unsupported selection APIs
      }
    };

    window.addEventListener("keydown", onSlashFocus);
    return () => window.removeEventListener("keydown", onSlashFocus);
  }, []);

  const { data, error, isLoading, refetch } = useClientQuery<AdminProductsResponse>({
    queryKey: [
      "admin",
      "products",
      { search, categoryFilter, supplierFilter, page, pageSize, includeArchived, sortDir, sortField, stockFilter },
    ],
    queryFn: () =>
      fetcher(
        `/api/products?q=${encodeURIComponent(search)}&category=${encodeURIComponent(categoryFilter)}&supplierId=${encodeURIComponent(supplierFilter)}&page=${page}&pageSize=${pageSize}&sort=${sortField}&sortDir=${sortDir}&includeArchived=${includeArchived ? "1" : "0"}&startsWith=1&stockFilter=${stockFilter}&includeStats=1`,
      ),
    refetchInterval: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const { data: suppliersData } = useClientQuery<{ rows: SupplierOption[] }>({
    queryKey: ["admin", "suppliers"],
    queryFn: () => fetch("/api/admin/suppliers").then((response) => response.json()),
  });

  const products = useMemo<AdminProduct[]>(
    () => (Array.isArray(data?.items) ? (data.items as AdminProduct[]) : []),
    [data?.items],
  );
  const total = data?.total || 0;
  const overviewStats = data?.stats ?? {
    filteredTotal: total,
    outOfStockCount: 0,
    lowStockCount: 0,
    archivedCount: 0,
    supplierCount: 0,
    marginRiskCount: isAdmin ? 0 : null,
  };
  const totalPages = Math.ceil(total / pageSize) || 1;
  const suppliers = useMemo<SupplierOption[]>(
    () => (Array.isArray(suppliersData?.rows) ? suppliersData.rows : []),
    [suppliersData?.rows],
  );
  const assignableSuppliers = useMemo(() => {
    const systemSupplierNames = new Set<string>(SYSTEM_SUPPLIER_NAMES);
    return suppliers.filter((supplier) => !systemSupplierNames.has(supplier.name.trim().toLowerCase()));
  }, [suppliers]);
  const visibleIds = useMemo(() => products.map((product) => product.id), [products]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const selectedCount = selectedIds.size;
  const activeFilterCount = [
    Boolean(search),
    Boolean(categoryFilter),
    Boolean(supplierFilter),
    includeArchived,
    stockFilter !== "all",
    sortField !== "updatedAt" || sortDir !== "desc",
  ].filter(Boolean).length;
  const hasActiveFilters = activeFilterCount > 0;

  const resetBulkSupplierState = () => {
    setBulkSupplierId("");
    setBulkSupplierName("");
    setBulkSupplierReason("");
  };

  const resetBulkMinMarginState = () => {
    setBulkMinMarginCategory("");
    setBulkMinMarginValue("");
    setBulkMinMarginReason("");
  };

  const handleSearchInputChange = (value: string) => {
    setSearchInput(value);
    setPage(1);
  };

  const clearSearch = () => {
    setSearchInput("");
    setSearch("");
    setPage(1);
  };

  const handlePageSizeChange = (value: number) => {
    setPageSize(value);
    setPage(1);
  };

  const handleCategoryFilterChange = (value: string) => {
    setCategoryFilter(value);
    setPage(1);
  };

  const handleSupplierFilterChange = (value: string) => {
    setSupplierFilter(value);
    setPage(1);
  };

  const handleStockFilterChange = (value: ProductStockFilter) => {
    setStockFilter(value);
    setPage(1);
  };

  const handleSortColumn = (field: ProductSortField) => {
    if (sortField === field) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
    setPage(1);
  };

  const handleSortSelection = (value: string) => {
    const [field, dir] = value.split("-") as [ProductSortField, ProductSortDir];
    if (!field || !dir) return;

    setSortField(field);
    setSortDir(dir);
    setPage(1);
  };

  const handleIncludeArchivedChange = (checked: boolean) => {
    setIncludeArchived(checked);
    setPage(1);
  };

  const handleShowCostChange = (checked: boolean) => {
    setShowCost(checked);
  };

  const openSaveFilter = () => {
    setSaveFilterName("");
    setSaveFilterOpen(true);
  };

  const closeSaveFilter = () => setSaveFilterOpen(false);

  const confirmSaveFilter = () => {
    const name = saveFilterName.trim();
    if (!name) return;

    const entry: ProductsSavedFilter = {
      id: `${Date.now()}`,
      name,
      state: {
        search,
        category: categoryFilter,
        supplierId: supplierFilter,
        includeArchived,
        sortField,
        sortDir,
        showCost,
        stockFilter,
        pageSize,
      },
    };

    setSavedFilters((current) => [entry, ...current]);
    setSaveFilterOpen(false);
    toast.success("Saved filter");
  };

  const applySavedFilter = (entry: ProductsSavedFilter) => {
    const nextState = entry.state;
    setSearch(nextState.search);
    setSearchInput(nextState.search);
    setCategoryFilter(nextState.category || "");
    setSupplierFilter(nextState.supplierId || "");
    setIncludeArchived(nextState.includeArchived);
    setSortField(nextState.sortField || "updatedAt");
    setSortDir(nextState.sortDir);
    setShowCost(nextState.showCost);
    setStockFilter(nextState.stockFilter);
    setPageSize(nextState.pageSize);
    setPage(1);
    toast.success(`Applied "${entry.name}"`);
  };

  const removeSavedFilter = (id: string) => {
    setSavedFilters((current) => current.filter((entry) => entry.id !== id));
  };

  const clearAllFilters = () => {
    setSearch("");
    setSearchInput("");
    setCategoryFilter("");
    setSupplierFilter("");
    setIncludeArchived(false);
    setStockFilter("all");
    setShowCost(false);
    setSortDir("desc");
    setSortField("updatedAt");
    setPage(1);
    setPageSize(10);
    router.replace(pathname, { scroll: false });
  };

  const getArchiveReason = (): Promise<string | null> => {
    setArchiveReasonInput("");
    setArchiveReasonOpen(true);
    return new Promise((resolve) => {
      archiveReasonResolve.current = resolve;
    });
  };

  const confirmArchiveReason = () => {
    const trimmed = archiveReasonInput.trim();
    if (trimmed.length < 5) {
      toast.error("Please provide a reason (at least 5 characters).");
      return;
    }

    setArchiveReasonOpen(false);
    archiveReasonResolve.current?.(trimmed);
    archiveReasonResolve.current = null;
  };

  const cancelArchiveReason = () => {
    setArchiveReasonOpen(false);
    archiveReasonResolve.current?.(null);
    archiveReasonResolve.current = null;
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
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
    const selected = products.filter((product) => selectedIds.has(product.id));
    if (selected.length === 0) {
      toast.error("Select at least one product to export.");
      return;
    }

    const header = ["Name", "SKU", "Category", "Supplier", "Price", "Stock", "Updated", "Archived"];
    const lines = [header.join(",")];
    for (const product of selected) {
      lines.push(
        [
          JSON.stringify(product.name || ""),
          JSON.stringify(product.sku || ""),
          JSON.stringify(
            PRODUCT_CATEGORY_LABELS[(product.category || "") as keyof typeof PRODUCT_CATEGORY_LABELS] || "Uncategorized",
          ),
          JSON.stringify(product.supplier || ""),
          String(Number(product.price || 0)),
          String(Number(product.stock || 0)),
          JSON.stringify(new Date(product.updatedAt).toISOString()),
          JSON.stringify(Boolean(product.archived)),
        ].join(","),
      );
    }

    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const filename = `products_${Date.now()}.csv`;

    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    void logAdminExportDownload({
      area: "products",
      format: "CSV",
      fileName: filename,
      sourcePage: "admin/products",
      rowCount: selected.length,
      columnCount: header.length,
      byteSize: blob.size,
      resultSummary: `Products CSV export downloaded (${selected.length} selected rows).`,
      scopeSnapshot: "Selected products export",
    });
  };

  const bulkArchive = async (archived: boolean) => {
    const editReason = await getArchiveReason();
    if (!editReason) return;

    const selected = products.filter((product) => selectedIds.has(product.id));
    if (selected.length === 0) {
      toast.error("Select at least one product.");
      return;
    }

    const blocked = archived ? selected.filter((product) => Number(product.stock || 0) > 0) : [];
    const allowed = archived ? selected.filter((product) => Number(product.stock || 0) <= 0) : selected;

    if (blocked.length > 0) {
      toast.error("Some products have stock > 0 and cannot be archived.");
    }
    if (allowed.length === 0) return;

    const results = await Promise.all(
      allowed.map((product) =>
        fetch(`/api/products/${product.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived, editReason }),
        }),
      ),
    );

    const failed = results.filter((response) => !response.ok).length;
    if (failed === 0) {
      const actionLabel = archived ? "Archived" : "Unarchived";
      const undoReason = `Undo ${archived ? "archive" : "unarchive"} action`;

      toast.success(`${actionLabel} ${allowed.length} product(s).`, {
        action: {
          label: "Undo",
          onClick: async () => {
            const undoResults = await Promise.all(
              allowed.map((product) =>
                fetch(`/api/products/${product.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ archived: !archived, editReason: undoReason }),
                }),
              ),
            );

            const undoFailed = undoResults.filter((response) => !response.ok).length;
            if (undoFailed === 0) {
              toast.success(`Undo complete for ${allowed.length} product(s).`);
            } else {
              toast.error(`Undo failed for ${undoFailed} product(s).`);
            }
            queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
          },
        },
      });

      clearSelection();
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
      return;
    }

    toast.error(`Failed to update ${failed} product(s).`);
    queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
  };

  const handleBulkSupplierOpenChange = (open: boolean) => {
    setBulkSupplierOpen(open);
    if (!open) resetBulkSupplierState();
  };

  const bulkAssignSupplier = async () => {
    const selected = products.filter((product) => selectedIds.has(product.id));
    if (selected.length === 0) {
      toast.error("Select at least one product.");
      return;
    }

    const nextSupplierId = bulkSupplierId.trim();
    const nextSupplierName = bulkSupplierName.trim();
    if (!nextSupplierId && !nextSupplierName) {
      toast.error("Select or enter a supplier.");
      return;
    }
    if (bulkSupplierReason.trim().length < 5) {
      toast.error("Please add a brief reason (min 5 chars).");
      return;
    }

    setBulkSaving(true);
    const basePayload: { supplierId?: string; supplier?: string; editReason: string } = {
      editReason: bulkSupplierReason.trim(),
    };
    if (nextSupplierId) basePayload.supplierId = nextSupplierId;
    if (nextSupplierName) basePayload.supplier = nextSupplierName;

    const results = await Promise.all(
      selected.map((product) =>
        fetch(`/api/products/${product.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(basePayload),
        }),
      ),
    );

    const failed = results.filter((response) => !response.ok).length;
    if (failed === 0) {
      toast.success(`Updated supplier for ${selected.length} product(s).`);
      clearSelection();
      setBulkSupplierOpen(false);
      resetBulkSupplierState();
    } else {
      toast.error(`Failed to update ${failed} product(s).`);
    }

    queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    setBulkSaving(false);
  };

  const handleBulkMinMarginOpenChange = (open: boolean) => {
    setBulkMinMarginOpen(open);
    if (!open) resetBulkMinMarginState();
  };

  const bulkSetMinMargin = async () => {
    const category = bulkMinMarginCategory.trim();
    if (!category) {
      toast.error("Please choose a category.");
      return;
    }
    if (bulkMinMarginReason.trim().length < 5) {
      toast.error("Please provide a reason (min 5 characters).");
      return;
    }

    const parsedValue = bulkMinMarginValue.trim() === "" ? null : Number(bulkMinMarginValue);
    if (parsedValue !== null && (Number.isNaN(parsedValue) || parsedValue < 0)) {
      toast.error("Minimum margin must be a non-negative number.");
      return;
    }

    setBulkMinMarginSaving(true);
    try {
      const response = await fetch("/api/admin/products/bulk-min-margin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          minMarginPct: parsedValue,
          reason: bulkMinMarginReason.trim(),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Failed to update minimum margin.");

      toast.success(payload?.message || "Minimum margin updated.");
      setBulkMinMarginOpen(false);
      resetBulkMinMarginState();
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update minimum margin.");
    } finally {
      setBulkMinMarginSaving(false);
    }
  };

  const archiveSingle = async (product: AdminProduct, archived: boolean) => {
    if (archived && Number(product.stock || 0) > 0) {
      toast.error("Cannot archive a product with stock greater than 0.");
      return;
    }

    const editReason = await getArchiveReason();
    if (!editReason) return;

    const response = await fetch(`/api/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived, editReason }),
    });

    if (!response.ok) {
      const payload = await response
        .json()
        .catch(async () => ({ error: await response.text().catch(() => "") }));
      toast.error(payload?.error || (archived ? "Failed to archive" : "Failed to unarchive"));
      return;
    }

    const undoReason = `Undo ${archived ? "archive" : "unarchive"} action`;
    toast.success(archived ? "Product archived" : "Product unarchived", {
      action: {
        label: "Undo",
        onClick: async () => {
          const undo = await fetch(`/api/products/${product.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived: !archived, editReason: undoReason }),
          });
          if (!undo.ok) {
            const payload = await undo.json().catch(async () => ({ error: await undo.text().catch(() => "") }));
            toast.error(payload?.error || "Undo failed");
            return;
          }
          queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
          toast.success("Undo complete");
        },
      },
    });

    queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
  };

  const startResize = (key: string, event: ReactMouseEvent) => {
    event.preventDefault();
    resizing.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key] ?? 120,
    };
    document.body.style.cursor = "col-resize";
  };

  const openEditDialog = (id: string) => setEditId(id);
  const closeEditDialog = () => setEditId(null);
  const openDeleteDialog = (id: string) => setDeleteId(id);
  const handleDeleteOpenChange = (open: boolean) => {
    if (!open) setDeleteId(null);
  };

  return {
    activeFilterCount,
    allVisibleSelected,
    archiveReasonInput,
    archiveReasonOpen,
    assignableSuppliers,
    bulkMinMarginCategory,
    bulkMinMarginOpen,
    bulkMinMarginReason,
    bulkMinMarginSaving,
    bulkMinMarginValue,
    bulkSaving,
    bulkSupplierId,
    bulkSupplierName,
    bulkSupplierOpen,
    bulkSupplierReason,
    canShowCost,
    cancelArchiveReason,
    categoryFilter,
    clearAllFilters,
    clearSearch,
    clearSelection,
    closeEditDialog,
    closeSaveFilter,
    columnWidths,
    confirmArchiveReason,
    confirmSaveFilter,
    deleteId,
    editId,
    error,
    exportSelected,
    handleArchiveReasonInputChange: setArchiveReasonInput,
    handleArchiveToggle: archiveSingle,
    handleBulkArchive: bulkArchive,
    handleBulkAssignSupplier: bulkAssignSupplier,
    handleBulkMinMarginCategoryChange: setBulkMinMarginCategory,
    handleBulkMinMarginOpenChange,
    handleBulkMinMarginReasonChange: setBulkMinMarginReason,
    handleBulkMinMarginValueChange: setBulkMinMarginValue,
    handleBulkSetMinMargin: bulkSetMinMargin,
    handleBulkSupplierIdChange: setBulkSupplierId,
    handleBulkSupplierNameChange: setBulkSupplierName,
    handleBulkSupplierOpenChange,
    handleBulkSupplierReasonChange: setBulkSupplierReason,
    handleCategoryFilterChange,
    handleDeleteOpenChange,
    handleIncludeArchivedChange,
    handlePageChange: setPage,
    handlePageSizeChange,
    handleSearchInputChange,
    handleShowCostChange,
    handleSortColumn,
    handleSortSelection,
    handleStockFilterChange,
    handleSupplierFilterChange,
    hasActiveFilters,
    includeArchived,
    isAdmin,
    isLoading,
    onRemoveSavedFilter: removeSavedFilter,
    onApplySavedFilter: applySavedFilter,
    openDeleteDialog,
    openEditDialog,
    openSaveFilter,
    overviewStats,
    page,
    pageSize,
    products,
    saveFilterName,
    saveFilterOpen,
    savedFilters,
    search,
    searchInput,
    searchInputRef,
    selectedCount,
    selectedIds,
    retryProducts: refetch,
    setSaveFilterName,
    showCost,
    sortDir,
    sortField,
    startResize,
    stockFilter,
    suppliers,
    supplierFilter,
    toggleSelectAllVisible,
    toggleSelected,
    total,
    totalPages,
  };
}

function isSortField(value: string | null): value is ProductSortField {
  return value === "updatedAt" || value === "price" || value === "stock" || value === "name";
}

function isTextInput(target: EventTarget | null): boolean {
  if (!target || !(target as HTMLElement).tagName) return false;

  const tag = String((target as HTMLElement).tagName).toLowerCase();
  if (tag === "input") {
    const type = String(((target as HTMLInputElement).type || "").toLowerCase());
    return ["text", "search", "email", "number", "url", "tel", "password"].includes(type);
  }
  if (tag === "textarea") return true;

  try {
    return !!(target as HTMLElement).isContentEditable;
  } catch {
    return false;
  }
}
