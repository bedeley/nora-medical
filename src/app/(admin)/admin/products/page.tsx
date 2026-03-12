"use client";

/* eslint-disable @next/next/no-img-element */

export const dynamic = "force-dynamic";

import { Suspense, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm, type Resolver, type SubmitHandler } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { MoreVertical, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { formatCurrency } from "@/lib/currency";
import { chipToneBorderClass, chipToneClass, stockStatusTone } from "@/lib/status-chips";
import { PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS, PRODUCT_CATEGORY_OPTIONS } from "@/lib/product-categories";
import { getMarginGuardError } from "@/lib/margin-guard";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";

type ProductsSavedFilter = {
  id: string;
  name: string;
  state: {
    search: string;
    category: string;
    supplierId: string;
    includeArchived: boolean;
    sortDir: "asc" | "desc";
    showCost: boolean;
    stockFilter: "all" | "low" | "out";
    pageSize: number;
  };
};

type SupplierOption = {
  id: string;
  name: string;
  leadTimeDays: number;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// Simple title case for names: uppercase first letter of each word
function toTitleCase(str: string) {
  return String(str || "").replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function getStockBadge(stock: number) {
  if (stock <= 0) {
    return { label: "Out", className: `${chipToneClass(stockStatusTone(stock, 5))} ${chipToneBorderClass("danger")}` };
  }
  if (stock <= 5) {
    return { label: "Low", className: `${chipToneClass(stockStatusTone(stock, 5))} ${chipToneBorderClass("warning")}` };
  }
  return null;
}

// Shared Zod schema (same as API)
// Accept absolute URLs (https://...) or a site path starting with '/'
const imageUrlOrPath = z
  .string()
  .refine(
    (val) => {
      try {
        new URL(val);
        return true;
      } catch {
        return typeof val === 'string' && val.startsWith('/');
      }
    },
    { message: "Upload an image or provide https://... or a site path like /images/..." }
  );

const categoryEnum = z.preprocess(
  (val) => (val == null ? "" : String(val)),
  z
    .string()
    .min(1, "You must select a category.")
    .refine(
      (value) => PRODUCT_CATEGORIES.includes(value as (typeof PRODUCT_CATEGORIES)[number]),
      { message: "Please select a valid category." }
    )
);

const optionalPercent = z.preprocess(
  (val) => {
    if (val == null || val === "") return undefined;
    const num = Number(val);
    return Number.isFinite(num) ? num : val;
  },
  z.number().min(0, "Minimum margin must be 0% or higher.").max(100, "Maximum is 100%.").optional()
);

const productSchema = z.object({
  name: z.string().min(2, "Name is required"),
  description: z.string().min(5, "Description too short"),
  imageUrl: imageUrlOrPath,
  category: categoryEnum,
  brand: z.string().min(2, "Brand is required"),
  supplier: z.string().min(2, "Supplier is required").optional(),
  supplierId: z.string().optional().nullable(),
  minMarginPct: optionalPercent,
  marginOverrideReason: z.string().min(5).optional(),
  price: z.coerce.number().nonnegative("Invalid price"),
  // Cost is required and must be > 0 for new products
  cost: z.coerce.number().positive("Cost must be greater than 0"),
  stock: z.coerce.number().int().nonnegative("Invalid stock"),
  receiveNow: z.boolean().optional(),
  paidOnReceipt: z.boolean().optional(),
  paymentMethod: z.enum(["cash", "transfer", "bank", "credit"]).optional(),
  lotCode: z.string().optional(),
  expiryDate: z.string().optional(),
  requiresLotTracking: z.boolean().optional(),
  requiresExpiryDate: z.boolean().optional(),
})
  .refine(
    (data) => Boolean(data.supplierId) || Boolean(data.supplier && data.supplier.trim()),
    { message: "Supplier is required", path: ["supplier"] }
  )
  .refine(
    (data) => !data.supplier || data.supplier.trim().toLowerCase() !== "unknown",
    { message: "Please enter a real supplier.", path: ["supplier"] }
  )
  .refine(
    (data) => !data.requiresExpiryDate || data.requiresLotTracking,
    { message: "Expiry date tracking requires lot tracking.", path: ["requiresExpiryDate"] }
  );
// Allow relative paths (e.g., "/placeholder.png") or absolute URLs for editing
const urlOrPath = z
  .string()
  .refine(
    (val) => {
      try {
        // absolute URL ok
        new URL(val);
        return true;
      } catch {
        return typeof val === "string" && val.startsWith("/");
      }
    },
    { message: "Enter a valid URL or /path" }
  );

const productEditSchema = z.object({
  name: z.string().min(2).optional(),
  description: z.string().min(5).optional(),
  imageUrl: urlOrPath.optional(),
  category: categoryEnum.optional(),
  brand: z.string().min(2).optional(),
  supplier: z.string().min(2).optional(),
  supplierId: z.string().optional().nullable(),
  minMarginPct: optionalPercent,
  marginOverrideReason: z.string().min(5).optional(),
  price: z.coerce.number().nonnegative().optional(),
  stock: z.coerce.number().int().nonnegative().optional(),
  requiresLotTracking: z.boolean().optional(),
  requiresExpiryDate: z.boolean().optional(),
  editReason: z.string().min(5, "Please add a brief reason for this change."),
})
  .refine(
    (data) => Boolean(data.supplierId) || Boolean(data.supplier && data.supplier.trim()),
    { message: "Supplier is required", path: ["supplier"] }
  )
  .refine(
    (data) => !data.supplier || data.supplier.trim().toLowerCase() !== "unknown",
    { message: "Please enter a real supplier.", path: ["supplier"] }
  )
  .refine(
    (data) => !data.requiresExpiryDate || data.requiresLotTracking,
    { message: "Expiry date tracking requires lot tracking.", path: ["requiresExpiryDate"] }
  );

function AdminProductsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(""); // debounced value used for API/URL
  const [searchInput, setSearchInput] = useState(""); // immediate input value
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [showCost, setShowCost] = useState(false);
  const [stockFilter, setStockFilter] = useState<"all" | "low" | "out">("all");
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
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role || "";
  const isAdmin = role === "ADMIN";
  const canShowCost = isAdmin && showCost;
  const [savedFilters, setSavedFilters] = useState<ProductsSavedFilter[]>([]);
  const resizing = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
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

  // Initialize includeArchived from URL
  useEffect(() => {
    const ia = searchParams.get("includeArchived");
    if (ia === "1" || ia === "true") setIncludeArchived(true);
    const q = searchParams.get("q");
    if (typeof q === "string") { setSearch(q); setSearchInput(q); }
    const rawCategory = String(searchParams.get("category") || "").toLowerCase();
    if (PRODUCT_CATEGORIES.includes(rawCategory as (typeof PRODUCT_CATEGORIES)[number])) {
      setCategoryFilter(rawCategory);
    }
    const rawSupplierId = String(searchParams.get("supplierId") || "").trim();
    if (rawSupplierId) setSupplierFilter(rawSupplierId);
    const edit = searchParams.get("edit");
    if (edit) setEditId(edit);
    const p = Number(searchParams.get("page") || 1);
    const ps = Number(searchParams.get("pageSize") || 10);
    const sd = searchParams.get("sortDir");
    const sc = searchParams.get("showCost");
    const sf = searchParams.get("stockFilter");
    if (!Number.isNaN(p) && p > 0) setPage(p);
    if (!Number.isNaN(ps) && ps > 0) setPageSize(ps);
    if (sd === "asc" || sd === "desc") setSortDir(sd);
    if (sc === "1" || sc === "true") setShowCost(true);
    if (sf === "low" || sf === "out") setStockFilter(sf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isAdmin && showCost) setShowCost(false);
  }, [isAdmin, showCost]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-products-saved-filters");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as ProductsSavedFilter[];
      if (Array.isArray(parsed)) setSavedFilters(parsed);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "admin-products-saved-filters",
      JSON.stringify(savedFilters),
    );
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

    if (sortDir !== "desc") params.set("sortDir", sortDir);
    else params.delete("sortDir");

    if (showCost) params.set("showCost", "1");
    else params.delete("showCost");

    if (stockFilter !== "all") params.set("stockFilter", stockFilter);
    else params.delete("stockFilter");

    if (page !== 1) params.set("page", String(page));
    else params.delete("page");

    if (pageSize !== 10) params.set("pageSize", String(pageSize));
    else params.delete("pageSize");

    const next = params.toString();
    const current = searchParams.toString();
    if (next !== current) {
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    }
  }, [
    search,
    categoryFilter,
    supplierFilter,
    includeArchived,
    sortDir,
    showCost,
    stockFilter,
    page,
    pageSize,
    pathname,
    router,
    searchParams,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-products-column-widths");
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
      "admin-products-column-widths",
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

  const startResize = (key: string, event: React.MouseEvent) => {
    event.preventDefault();
    resizing.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key] ?? 120,
    };
    document.body.style.cursor = "col-resize";
  };

  // Reflect state to URL (search, page, includeArchived)
  useEffect(() => {
    const params = new URLSearchParams();
    if (search) params.set("q", search); else params.delete("q");
    if (page && page > 1) params.set("page", String(page)); else params.delete("page");
    if (pageSize && pageSize !== 10) params.set("pageSize", String(pageSize)); else params.delete("pageSize");
    if (includeArchived) params.set("includeArchived", "1"); else params.delete("includeArchived");
    if (sortDir !== "desc") params.set("sortDir", sortDir); else params.delete("sortDir");
    if (showCost && isAdmin) params.set("showCost", "1"); else params.delete("showCost");
    if (stockFilter !== "all") params.set("stockFilter", stockFilter); else params.delete("stockFilter");
    if (supplierFilter) params.set("supplierId", supplierFilter); else params.delete("supplierId");
    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [search, page, pageSize, includeArchived, sortDir, showCost, isAdmin, stockFilter, supplierFilter, pathname, router]);

  // Global key handler: when typing outside inputs, focus search and append the key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Esc clears search
      if (e.key === 'Escape') {
        const el = searchInputRef.current;
        if (el) {
          el.value = '';
          setSearchInput('');
          setPage(1);
          try { el.setSelectionRange(0, 0); } catch {}
          e.preventDefault();
        }
        return;
      }
      if (isTextInput(e.target)) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key;
      if (!key || key.length !== 1) return;
      const el = searchInputRef.current;
      if (!el) return;
      el.focus();
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + key + el.value.slice(end);
      el.value = next;
      setSearchInput(next);
      setPage(1);
      try { el.setSelectionRange(start + 1, start + 1); } catch {}
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true } as EventListenerOptions);
  }, [setSearch]);

  // Debounce search input by ~2s before updating URL/API
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(searchInput);
    }, 2000);
    return () => clearTimeout(id);
  }, [searchInput]);

  const queryClient = useQueryClient();

  const saveCurrentFilter = () => {
    const name = window.prompt("Name this saved filter");
    if (!name) return;
    const entry: ProductsSavedFilter = {
      id: `${Date.now()}`,
      name,
      state: {
        search,
        category: categoryFilter,
        supplierId: supplierFilter,
        includeArchived,
        sortDir,
        showCost,
        stockFilter,
        pageSize,
      },
    };
    setSavedFilters((prev) => [entry, ...prev]);
    toast.success("Saved filter");
  };

  const applySavedFilter = (entry: ProductsSavedFilter) => {
    const s = entry.state;
    setSearch(s.search);
    setSearchInput(s.search);
    setCategoryFilter(s.category || "");
    setSupplierFilter(s.supplierId || "");
    setIncludeArchived(s.includeArchived);
    setSortDir(s.sortDir);
    setShowCost(s.showCost);
    setStockFilter(s.stockFilter);
    setPageSize(s.pageSize);
    setPage(1);
    toast.success(`Applied "${entry.name}"`);
  };

  const removeSavedFilter = (id: string) => {
    setSavedFilters((prev) => prev.filter((f) => f.id !== id));
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
    setPage(1);
    setPageSize(10);
    router.replace(pathname, { scroll: false });
  };

  const getArchiveReason = (action: "archive" | "unarchive") => {
    const label = action === "archive" ? "archive" : "unarchive";
    const reason = window.prompt(`Please add a brief reason to ${label} this product (min 5 chars).`);
    if (reason == null) return null;
    const trimmed = reason.trim();
    if (trimmed.length < 5) {
      toast.error("Please add a brief reason for this change.");
      return null;
    }
    return trimmed;
  };

  const { data, error, isLoading } = useClientQuery({
    queryKey: ["admin","products", { search, categoryFilter, supplierFilter, page, pageSize, includeArchived, sortDir, stockFilter }],
    queryFn: () => fetcher(`/api/products?q=${encodeURIComponent(search)}&category=${encodeURIComponent(categoryFilter)}&supplierId=${encodeURIComponent(supplierFilter)}&page=${page}&pageSize=${pageSize}&sort=updatedAt&sortDir=${sortDir}&includeArchived=${includeArchived ? "1" : "0"}&startsWith=1&stockFilter=${stockFilter}`),
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { data: suppliersData } = useClientQuery<{ rows: SupplierOption[] }>({
    queryKey: ["admin", "suppliers"],
    queryFn: () => fetch("/api/admin/suppliers").then((r) => r.json()),
  });
  const suppliers = Array.isArray(suppliersData?.rows) ? suppliersData.rows : [];
  const systemSupplierNames = new Set(["unknown", "initial stock", "initial order"]);
  const assignableSuppliers = suppliers.filter(
    (s) => !systemSupplierNames.has(s.name.trim().toLowerCase()),
  );

  // Keyboard shortcut: '/' focuses the search input when not typing in an input already
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // If target isn't a text input/textarea/contenteditable, focus search
        const target = e.target as HTMLElement | null;
        const tag = (target?.tagName || '').toLowerCase();
        const isEditable =
          tag === 'input' ||
          tag === 'textarea' ||
          (target?.isContentEditable ?? false);
        if (!isEditable) {
          e.preventDefault();
          const el = searchInputRef.current;
          if (el) {
            el.focus();
            try { el.select(); } catch {}
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const products: AdminProduct[] = (data?.items || []) as AdminProduct[];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const visibleIds = products.map((p) => p.id);
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
    const selected = products.filter((p) => selectedIds.has(p.id));
    if (selected.length === 0) {
      toast.error("Select at least one product to export.");
      return;
    }
    const header = ["Name", "SKU", "Category", "Supplier", "Price", "Stock", "Updated", "Archived"];
    const lines = [header.join(",")];
    for (const p of selected) {
      lines.push([
        JSON.stringify(p.name || ""),
        JSON.stringify(p.sku || ""),
        JSON.stringify(PRODUCT_CATEGORY_LABELS[(p.category || "") as keyof typeof PRODUCT_CATEGORY_LABELS] || "Uncategorized"),
        JSON.stringify(p.supplier || ""),
        String(Number(p.price || 0)),
        String(Number(p.stock || 0)),
        JSON.stringify(new Date(p.updatedAt).toISOString()),
        JSON.stringify(Boolean(p.archived)),
      ].join(","));
    }
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const filename = `products_${Date.now()}.csv`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "products",
      format: "CSV",
      fileName: filename,
      rowCount: selected.length,
      columnCount: header.length,
      byteSize: blob.size,
      scopeSnapshot: "Selected products export",
    });
  };

  const bulkArchive = async (archived: boolean) => {
    const editReason = getArchiveReason(archived ? "archive" : "unarchive");
    if (!editReason) return;
    const selected = products.filter((p) => selectedIds.has(p.id));
    if (selected.length === 0) {
      toast.error("Select at least one product.");
      return;
    }
    const blocked = archived ? selected.filter((p) => Number(p.stock || 0) > 0) : [];
    const allowed = archived ? selected.filter((p) => Number(p.stock || 0) <= 0) : selected;
    if (blocked.length > 0) {
      toast.error("Some products have stock > 0 and cannot be archived.");
    }
    if (allowed.length === 0) return;
    let failed = 0;
    for (const p of allowed) {
      const res = await fetch(`/api/products/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived, editReason }),
      });
      if (!res.ok) failed += 1;
    }
    if (failed === 0) {
      const actionLabel = archived ? "Archived" : "Unarchived";
      const undoReason = `Undo ${archived ? "archive" : "unarchive"} action`;
      toast.success(`${actionLabel} ${allowed.length} product(s).`, {
        action: {
          label: "Undo",
          onClick: async () => {
            let undoFailed = 0;
            for (const p of allowed) {
              const res = await fetch(`/api/products/${p.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ archived: !archived, editReason: undoReason }),
              });
              if (!res.ok) undoFailed += 1;
            }
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
    } else {
      toast.error(`Failed to update ${failed} product(s).`);
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    }
  };

  const bulkAssignSupplier = async () => {
    const selected = products.filter((p) => selectedIds.has(p.id));
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
    let failed = 0;
    for (const p of selected) {
      const payload: { supplierId?: string; supplier?: string; editReason: string } = {
        editReason: bulkSupplierReason.trim(),
      };
      if (nextSupplierId) payload.supplierId = nextSupplierId;
      if (nextSupplierName) payload.supplier = nextSupplierName;
      const res = await fetch(`/api/products/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) failed += 1;
    }
    if (failed === 0) {
      toast.success(`Updated supplier for ${selected.length} product(s).`);
      clearSelection();
      setBulkSupplierOpen(false);
      setBulkSupplierId("");
      setBulkSupplierName("");
      setBulkSupplierReason("");
    } else {
      toast.error(`Failed to update ${failed} product(s).`);
    }
    queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    setBulkSaving(false);
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
      const res = await fetch("/api/admin/products/bulk-min-margin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          minMarginPct: parsedValue,
          reason: bulkMinMarginReason.trim(),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update minimum margin.");
      toast.success(j?.message || "Minimum margin updated.");
      setBulkMinMarginOpen(false);
      setBulkMinMarginCategory("");
      setBulkMinMarginValue("");
      setBulkMinMarginReason("");
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update minimum margin.");
    } finally {
      setBulkMinMarginSaving(false);
    }
  };

  const archiveSingle = async (product: AdminProduct, archived: boolean) => {
    if (archived && Number(product.stock || 0) > 0) {
      toast.error("Cannot archive a product with stock greater than 0.");
      return;
    }
    const editReason = getArchiveReason(archived ? "archive" : "unarchive");
    if (!editReason) return;
    const res = await fetch(`/api/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived, editReason }),
    });
    if (!res.ok) {
      const j = await res
        .json()
        .catch(async () => ({ error: await res.text().catch(() => "") }));
      toast.error(j?.error || (archived ? "Failed to archive" : "Failed to unarchive"));
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
            const j = await undo
              .json()
              .catch(async () => ({ error: await undo.text().catch(() => "") }));
            toast.error(j?.error || "Undo failed");
            return;
          }
          queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
          toast.success("Undo complete");
        },
      },
    });
    queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
  };

  return (
    <section className="container mx-auto py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-sm text-muted-foreground">
            Manage catalog, pricing, and stock.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Dialog
            open={bulkMinMarginOpen}
            onOpenChange={(open) => {
              setBulkMinMarginOpen(open);
              if (!open) {
                setBulkMinMarginCategory("");
                setBulkMinMarginValue("");
                setBulkMinMarginReason("");
              }
            }}
          >
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" disabled={!isAdmin}>Set min margin</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-base font-semibold">Bulk minimum margin</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label>Category</Label>
                  <select
                    className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={bulkMinMarginCategory}
                    onChange={(e) => setBulkMinMarginCategory(e.target.value)}
                  >
                    <option value="">Select category</option>
                    {PRODUCT_CATEGORY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>Minimum margin %</Label>
                  <Input
                    type="number"
                    step="0.1"
                    placeholder="Leave blank to clear"
                    value={bulkMinMarginValue}
                    onChange={(e) => setBulkMinMarginValue(e.target.value)}
                  />
                </div>
                <div>
                  <Label>Reason for change</Label>
                  <Input
                    value={bulkMinMarginReason}
                    onChange={(e) => setBulkMinMarginReason(e.target.value)}
                    placeholder="e.g., pricing guardrail update"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setBulkMinMarginOpen(false)}
                    disabled={bulkMinMarginSaving}
                  >
                    Cancel
                  </Button>
                  <Button onClick={bulkSetMinMargin} disabled={bulkMinMarginSaving}>
                    {bulkMinMarginSaving ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
          <AddProductDialog suppliers={suppliers} />
        </div>
      </div>

      {/* Loading / error state */}
      {error || isLoading ? (
        <div className="text-sm text-muted-foreground">
          {error ? (
            <span className="text-red-500">Failed to load products.</span>
          ) : (
            <span>Loading products...</span>
          )}
        </div>
      ) : (
        <>
          {/* Filters */}
          <Card className="shadow-sm">
            <CardHeader className="py-3">
              <CardTitle className="text-base font-semibold">Filters</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="sm:col-span-2 lg:col-span-2">
                  <Input
                    placeholder="Search products..."
                    className="w-full"
                    value={searchInput}
                    ref={searchInputRef}
                    autoFocus
                    onChange={(e) => {
                      setSearchInput(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center">
                  <span>Rows:</span>
                  <select
                    className="border rounded-md h-9 bg-background px-2 w-full sm:w-auto"
                    value={pageSize}
                    onChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(1); }}
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </div>
                <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center">
                  <span>Category:</span>
                  <select
                    className="border rounded-md h-9 bg-background px-2 w-full sm:w-auto"
                    value={categoryFilter}
                    onChange={(e) => {
                      const next = e.target.value;
                      setCategoryFilter(next);
                      setPage(1);
                      const params = new URLSearchParams(searchParams.toString());
                      if (next) params.set("category", next);
                      else params.delete("category");
                      router.replace(`${pathname}?${params.toString()}`.replace(/\?$/, ""), { scroll: false });
                    }}
                  >
                    <option value="">All</option>
                    {PRODUCT_CATEGORY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center">
                  <span>Supplier:</span>
                  <select
                    className="border rounded-md h-9 bg-background px-2 w-full sm:w-auto"
                    value={supplierFilter}
                    onChange={(e) => {
                      const next = e.target.value;
                      setSupplierFilter(next);
                      setPage(1);
                      const params = new URLSearchParams(searchParams.toString());
                      if (next) params.set("supplierId", next);
                      else params.delete("supplierId");
                      router.replace(`${pathname}?${params.toString()}`.replace(/\?$/, ""), { scroll: false });
                    }}
                  >
                    <option value="">All</option>
                    {assignableSuppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-3">
                  <label className="flex items-center gap-2 text-sm select-none">
                    <input
                      type="checkbox"
                      checked={includeArchived}
                      onChange={(e) => {
                        setIncludeArchived(e.target.checked);
                        setPage(1);
                        // reflect to URL
                        const params = new URLSearchParams(searchParams.toString());
                        if (e.target.checked) params.set("includeArchived", "1");
                        else params.delete("includeArchived");
                        router.replace(`${pathname}?${params.toString()}`.replace(/\?$/, ""), { scroll: false });
                      }}
                    />
                    Include archived
                  </label>
                  {isAdmin ? (
                    <label className="flex items-center gap-2 text-sm select-none">
                      <input
                        type="checkbox"
                        checked={showCost}
                        onChange={(e) => setShowCost(e.target.checked)}
                      />
                      Show cost
                    </label>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-3">
                  <Button
                    size="sm"
                    variant={stockFilter === "all" ? "default" : "outline"}
                    onClick={() => { setStockFilter("all"); setPage(1); }}
                  >
                    All
                  </Button>
                  <Button
                    size="sm"
                    variant={stockFilter === "low" ? "default" : "outline"}
                    onClick={() => { setStockFilter("low"); setPage(1); }}
                  >
                    Low stock
                  </Button>
                  <Button
                    size="sm"
                    variant={stockFilter === "out" ? "default" : "outline"}
                    onClick={() => { setStockFilter("out"); setPage(1); }}
                  >
                    Out of stock
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-3">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm">
                        Saved filters
                      </Button>
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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={clearAllFilters}
                  >
                    Clear filters
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
          {selectedCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{selectedCount} selected</span>
                <Button variant="ghost" size="sm" onClick={clearSelection}>
                  Clear
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => bulkArchive(true)}>
                  Archive
                </Button>
                <Button size="sm" variant="outline" onClick={() => bulkArchive(false)}>
                  Unarchive
                </Button>
                <Dialog
                  open={bulkSupplierOpen}
                  onOpenChange={(open) => {
                    setBulkSupplierOpen(open);
                    if (!open) {
                      setBulkSupplierId("");
                      setBulkSupplierName("");
                      setBulkSupplierReason("");
                    }
                  }}
                >
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline" disabled={selectedCount === 0}>
                      Set Supplier
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle className="text-base font-semibold">Bulk set supplier</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                      <div className="text-sm text-muted-foreground">
                        Selected: {selectedCount}
                      </div>
                      <div>
                        <Label>Choose supplier</Label>
                        <select
                          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                          value={bulkSupplierId}
                          onChange={(e) => {
                            const nextId = e.target.value || "";
                            setBulkSupplierId(nextId);
                            const match = suppliers.find((s) => s.id === nextId);
                            if (match) setBulkSupplierName(match.name);
                          }}
                        >
                          <option value="">Select supplier</option>
                          {assignableSuppliers.map((supplier) => (
                            <option key={supplier.id} value={supplier.id}>
                              {supplier.name} · {supplier.leadTimeDays}d
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <Label>Or enter supplier name</Label>
                        <Input
                          value={bulkSupplierName}
                          onChange={(e) => {
                            setBulkSupplierName(e.target.value);
                            if (e.target.value.trim()) setBulkSupplierId("");
                          }}
                        />
                      </div>
                      <div>
                        <Label>Reason for change</Label>
                        <Input
                          value={bulkSupplierReason}
                          onChange={(e) => setBulkSupplierReason(e.target.value)}
                          placeholder="e.g., supplier update / consolidation"
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="secondary"
                          onClick={() => setBulkSupplierOpen(false)}
                          disabled={bulkSaving}
                        >
                          Cancel
                        </Button>
                        <Button onClick={bulkAssignSupplier} disabled={bulkSaving}>
                          {bulkSaving ? "Saving..." : "Save"}
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
                <Button size="sm" onClick={exportSelected}>
                  Export CSV
                </Button>
              </div>
            </div>
          )}

          {/* Products Table (desktop) */}
          <Card className="shadow-sm">
            <CardHeader className="flex items-center justify-between py-3">
            <CardTitle className="text-base font-semibold">Products</CardTitle>
              <span className="text-xs text-muted-foreground">{total} total</span>
            </CardHeader>
            <CardContent className="p-0">
              <div className="hidden lg:block">
                <div className="overflow-x-auto">
                  <Table className="admin-products-table table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[36px] relative" style={{ width: columnWidths.select }}>
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    aria-label="Select all visible products"
                  />
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("select", event)}
                  />
                </TableHead>
                <TableHead className="relative" style={{ width: columnWidths.name }}>
                  Name
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("name", event)}
                  />
                </TableHead>
                <TableHead className="relative" style={{ width: columnWidths.category }}>
                  Category
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("category", event)}
                  />
                </TableHead>
                <TableHead className="relative" style={{ width: columnWidths.supplier }}>
                  Supplier
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("supplier", event)}
                  />
                </TableHead>
                <TableHead className="relative" style={{ width: columnWidths.price }}>
                  Price
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("price", event)}
                  />
                </TableHead>
                {canShowCost ? (
                  <TableHead className="relative" style={{ width: columnWidths.cost }}>
                    Cost
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("cost", event)}
                    />
                  </TableHead>
                ) : null}
                {canShowCost ? (
                  <TableHead className="relative" style={{ width: columnWidths.margin }}>
                    Margin
                    <div
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                      onMouseDown={(event) => startResize("margin", event)}
                    />
                  </TableHead>
                ) : null}
                <TableHead className="relative" style={{ width: columnWidths.stock }}>
                  Stock
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("stock", event)}
                  />
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none relative"
                  style={{ width: columnWidths.updated }}
                  onClick={() => {
                    setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                    setPage(1);
                  }}
                >
                  Updated {sortDir === "asc" ? "▲" : "▼"}
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("updated", event)}
                  />
                </TableHead>
                <TableHead className="text-right relative" style={{ width: columnWidths.actions }}>
                  Actions
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("actions", event)}
                  />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selectedIds.has(p.id)}
                      onChange={() => toggleSelected(p.id)}
                      aria-label={`Select ${p.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      {(() => {
                        const q = (search || "").trim();
                        const name: string = p.name || "";
                        const isPrefix = q.length > 0 && name.toLowerCase().startsWith(q.toLowerCase());
                        const prefix = isPrefix ? name.slice(0, q.length) : "";
                        const rest = isPrefix ? name.slice(q.length) : name;
                        const stockBadge = getStockBadge(Number(p.stock || 0));
                        const approvalThreshold =
                          typeof p.approvalThresholdQty === "number" && p.approvalThresholdQty > 0
                            ? p.approvalThresholdQty
                            : null;
                        return (
                          <span className={p.archived ? "opacity-60 line-through" : undefined}>
                            {isPrefix ? (
                              <>
                                <span className="font-semibold underline decoration-primary/50">{prefix}</span>
                                <span>{rest}</span>
                              </>
                            ) : (
                              <span>{name}</span>
                            )}
                            {stockBadge ? (
                              <span className={`ml-2 text-xs border rounded px-1.5 py-0.5 ${stockBadge.className}`}>
                                {stockBadge.label}
                              </span>
                            ) : null}
                            {approvalThreshold ? (
                              <span className="ml-2 text-xs border rounded px-1.5 py-0.5 bg-muted">
                                Approval ≥ {approvalThreshold}
                              </span>
                            ) : null}
                            {p.requiresLotTracking || p.requiresExpiryDate ? (
                              <span className="ml-2 text-xs border rounded px-1.5 py-0.5 bg-muted">
                                Regulated
                              </span>
                            ) : null}
                            {p.archived && (
                              <span className="ml-2 text-xs bg-muted border rounded px-1.5 py-0.5">Archived</span>
                            )}
                          </span>
                        );
                      })()}
                  {p.sku ? (
                    <div className="text-xs text-muted-foreground">SKU: {p.sku}</div>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                {PRODUCT_CATEGORY_LABELS[(p.category || "") as keyof typeof PRODUCT_CATEGORY_LABELS] || "Uncategorized"}
              </TableCell>
              <TableCell>{p.supplier || "Unknown"}</TableCell>
              <TableCell>{formatCurrency(Number(p.price))}</TableCell>
              {canShowCost ? (
                <TableCell>{formatCurrency(Number(p.cost || 0))}</TableCell>
              ) : null}
              {canShowCost ? (
                <TableCell>
                  {(() => {
                    const price = Number(p.price || 0);
                    const cost = Number(p.cost || 0);
                    const marginPct = price > 0 ? ((price - cost) / price) * 100 : 0;
                    const minMargin = typeof p.minMarginPct === "number" ? p.minMarginPct : null;
                    const belowMin =
                      minMargin != null && Number.isFinite(minMargin) && marginPct < minMargin;
                    const belowCost = price > 0 && price < cost;
                    const color =
                      belowCost || belowMin ? "text-red-600" : "text-emerald-600";
                    return (
                      <span className={color} title={minMargin != null ? `Min ${minMargin}%` : undefined}>
                        {Number.isFinite(marginPct) ? `${marginPct.toFixed(1)}%` : "0.0%"}
                      </span>
                    );
                  })()}
                </TableCell>
              ) : null}
                  <TableCell>{p.stock}</TableCell>
                  <TableCell title={new Date(p.updatedAt).toLocaleString()}>
                    {new Date(p.updatedAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right w-[200px] overflow-visible">
                    <div className="flex w-full items-center justify-end">
                      <DropdownMenu>
                        <Tooltip content="Edit or delete this product">
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm">
                              Actions <MoreVertical className="ml-1 h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                        </Tooltip>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditId(p.id)}>Edit</DropdownMenuItem>
                          {p.archived ? (
                            <DropdownMenuItem
                              onClick={async () => {
                                await archiveSingle(p, false);
                              }}
                            >
                              Unarchive
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              disabled={Number(p.stock || 0) > 0}
                              onClick={async () => {
                                await archiveSingle(p, true);
                              }}
                            >
                              {Number(p.stock || 0) > 0 ? "Archive (stock must be 0)" : "Archive"}
                            </DropdownMenuItem>
                          )}
                          {(p.orderCount ?? 0) === 0 && (
                            <DropdownMenuItem variant="destructive" onClick={() => setDeleteId(p.id)}>
                              Delete
                            </DropdownMenuItem>
                          )}
                          {(p.orderCount ?? 0) > 0 && (
                            <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                              Delete hidden (order history)
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {products.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canShowCost ? 10 : 8} className="text-center py-6 text-muted-foreground">
                    <div className="flex flex-col items-center gap-3">
                      <span>No products found.</span>
                      <div className="flex flex-wrap justify-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setSearch("");
                            setSearchInput("");
                            setCategoryFilter("");
                            setSupplierFilter("");
                            setIncludeArchived(false);
                            setStockFilter("all");
                            setShowCost(false);
                            setPage(1);
                            router.replace(pathname, { scroll: false });
                          }}
                        >
                          Clear filters
                        </Button>
                        <AddProductDialog suppliers={suppliers} />
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Products list (mobile) */}
      <div className="lg:hidden space-y-3">
            {products.map((p) => (
          <div key={p.id} className="rounded-lg border p-4 space-y-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={selectedIds.has(p.id)}
                onChange={() => toggleSelected(p.id)}
                aria-label={`Select ${p.name}`}
              />
              <div className="font-semibold">
                {(() => {
                  const q = (search || "").trim();
                  const name: string = p.name || "";
                  const isPrefix = q.length > 0 && name.toLowerCase().startsWith(q.toLowerCase());
                  const prefix = isPrefix ? name.slice(0, q.length) : "";
                  const rest = isPrefix ? name.slice(q.length) : name;
                  const stockBadge = getStockBadge(Number(p.stock || 0));
                  const approvalThreshold =
                    typeof p.approvalThresholdQty === "number" && p.approvalThresholdQty > 0
                      ? p.approvalThresholdQty
                      : null;
                  return (
                    <span className={p.archived ? "opacity-60 line-through" : undefined}>
                      {isPrefix ? (
                        <>
                          <span className="font-semibold underline decoration-primary/50">{prefix}</span>
                          <span>{rest}</span>
                        </>
                      ) : (
                        <span>{name}</span>
                      )}
                      {stockBadge ? (
                        <span className={`ml-2 text-xs border rounded px-1.5 py-0.5 ${stockBadge.className}`}>
                          {stockBadge.label}
                        </span>
                      ) : null}
                      {approvalThreshold ? (
                        <span className="ml-2 text-xs border rounded px-1.5 py-0.5 bg-muted">
                          Approval ≥ {approvalThreshold}
                        </span>
                      ) : null}
                      {p.requiresLotTracking || p.requiresExpiryDate ? (
                        <span className="ml-2 text-xs border rounded px-1.5 py-0.5 bg-muted">
                          Regulated
                        </span>
                      ) : null}
                      {p.archived && (
                        <span className="ml-2 text-xs bg-muted border rounded px-1.5 py-0.5">Archived</span>
                      )}
                    </span>
                  );
                })()}
                {p.sku ? (
                  <div className="text-xs text-muted-foreground font-normal">SKU: {p.sku}</div>
                ) : null}
              </div>
              <div
                className="text-xs text-muted-foreground"
                title={new Date(p.updatedAt).toLocaleString()}
              >
                {new Date(p.updatedAt).toLocaleDateString()}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <p className="uppercase tracking-wide text-muted-foreground">Price</p>
                <p className="font-semibold">{formatCurrency(Number(p.price))}</p>
              </div>
              <div>
                <p className="uppercase tracking-wide text-muted-foreground">Category</p>
                <p className="font-semibold">
                  {PRODUCT_CATEGORY_LABELS[(p.category || "") as keyof typeof PRODUCT_CATEGORY_LABELS] || "Uncategorized"}
                </p>
              </div>
              <div>
                <p className="uppercase tracking-wide text-muted-foreground">Supplier</p>
                <p className="font-semibold">{p.supplier || "Unknown"}</p>
              </div>
              {canShowCost ? (
                <div>
                  <p className="uppercase tracking-wide text-muted-foreground">Cost</p>
                  <p className="font-semibold">{formatCurrency(Number(p.cost || 0))}</p>
                </div>
              ) : null}
              {canShowCost ? (
                <div>
                  <p className="uppercase tracking-wide text-muted-foreground">Margin</p>
                  {(() => {
                    const price = Number(p.price || 0);
                    const cost = Number(p.cost || 0);
                    const marginPct = price > 0 ? ((price - cost) / price) * 100 : 0;
                    const minMargin = typeof p.minMarginPct === "number" ? p.minMarginPct : null;
                    const belowMin =
                      minMargin != null && Number.isFinite(minMargin) && marginPct < minMargin;
                    const belowCost = price > 0 && price < cost;
                    const color =
                      belowCost || belowMin ? "text-red-600 font-semibold" : "text-emerald-600 font-semibold";
                    return (
                      <p className={color} title={minMargin != null ? `Min ${minMargin}%` : undefined}>
                        {Number.isFinite(marginPct) ? `${marginPct.toFixed(1)}%` : "0.0%"}
                      </p>
                    );
                  })()}
                </div>
              ) : null}
              <div>
                <p className="uppercase tracking-wide text-muted-foreground">Stock</p>
                <p className="font-semibold">{p.stock}</p>
              </div>
            </div>
            <div className="grid gap-2 pt-1 sm:grid-cols-2">
              <Button size="sm" variant="secondary" className="w-full" onClick={() => setEditId(p.id)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                disabled={!p.archived && Number(p.stock || 0) > 0}
                onClick={async () => {
                  await archiveSingle(p, !p.archived);
                }}
              >
                {p.archived
                  ? "Unarchive"
                  : Number(p.stock || 0) > 0
                  ? "Archive (stock must be 0)"
                  : "Archive"}
              </Button>
              {(p.orderCount ?? 0) === 0 && (
                <Button
                  size="sm"
                  variant="destructive"
                  className="w-full sm:col-span-2"
                  onClick={() => setDeleteId(p.id)}
                >
                  Delete
                </Button>
              )}
              {(p.orderCount ?? 0) > 0 && (
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Delete hidden because this product has order history.
                </p>
              )}
            </div>
          </div>
        ))}
        {products.length === 0 && (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            <p>No products found.</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                    setSearch("");
                    setSearchInput("");
                    setCategoryFilter("");
                    setSupplierFilter("");
                    setIncludeArchived(false);
                    setStockFilter("all");
                    setShowCost(false);
                    setPage(1);
                  router.replace(pathname, { scroll: false });
                }}
              >
                Clear filters
              </Button>
              <AddProductDialog suppliers={suppliers} />
            </div>
          </div>
        )}
      </div>

      {/* Pagination */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 pt-4 border-t text-sm">
        <span className="text-sm text-muted-foreground">
          Page {page} of {totalPages} ({total} total)
        </span>
        {totalPages > 1 && (
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious href="#" onClick={(e) => { e.preventDefault(); if (page > 1) setPage(page - 1); }} />
              </PaginationItem>
              {(() => {
                const pages: number[] = [];
                const start = Math.max(1, page - 2);
                const end = Math.min(totalPages, page + 2);
                for (let i = start; i <= end; i++) pages.push(i);
                return (
                  <>
                    {start > 1 && (
                      <PaginationItem>
                        <PaginationLink href="#" onClick={(e) => { e.preventDefault(); setPage(1); }}>1</PaginationLink>
                      </PaginationItem>
                    )}
                    {start > 2 && (
                      <PaginationItem>
                        <span className="px-2">…</span>
                      </PaginationItem>
                    )}
                    {pages.map((n) => (
                      <PaginationItem key={n}>
                        <PaginationLink href="#" isActive={n === page} onClick={(e) => { e.preventDefault(); setPage(n); }}>
                          {n}
                        </PaginationLink>
                      </PaginationItem>
                    ))}
                    {end < totalPages - 1 && (
                      <PaginationItem>
                        <span className="px-2">…</span>
                      </PaginationItem>
                    )}
                    {end < totalPages && (
                      <PaginationItem>
                        <PaginationLink href="#" onClick={(e) => { e.preventDefault(); setPage(totalPages); }}>
                          {totalPages}
                        </PaginationLink>
                      </PaginationItem>
                    )}
                  </>
                );
              })()}
              <PaginationItem>
                <PaginationNext href="#" onClick={(e) => { e.preventDefault(); if (page < totalPages) setPage(page + 1); }} />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        )}
      </div>
            </CardContent>
          </Card>
      {(() => {
        if (!editId) return null;
        const editProduct = products.find((x) => x.id === editId);
        if (!editProduct) return null;
        return (
          <EditProductDialog
            product={editProduct}
            isAdmin={isAdmin}
            suppliers={suppliers}
            open={true}
            onOpenChange={(o) => {
              if (!o) setEditId(null);
            }}
          />
        );
      })()}
      {deleteId && (
        <DeleteProductDialog
          id={deleteId}
          name={products.find((x) => x.id === deleteId)?.name || "Product"}
          open={true}
          onOpenChange={(o) => { if (!o) setDeleteId(null); }}
        />
      )}
      </>
      )}
    </section>
  );
}

export default function AdminProductsPage() {
  return (
    <Suspense
      fallback={
        <section className="container mx-auto py-8">
          <h1 className="text-2xl font-semibold mb-2">Products</h1>
          <p className="text-sm text-muted-foreground">Loading products…</p>
        </section>
      }
    >
      <AdminProductsContent />
    </Suspense>
  );
}

// Helper: detect if the event target is a text input element
function isTextInput(el: EventTarget | null): boolean {
  if (!el || !(el as HTMLElement).tagName) return false;
  const tag = String((el as HTMLElement).tagName).toLowerCase();
  if (tag === "input") {
    const type = String(((el as HTMLInputElement).type || "").toLowerCase());
    return ["text", "search", "email", "number", "url", "tel", "password"].includes(type);
  }
  if (tag === "textarea") return true;
  // contenteditable
  try { return !!(el as HTMLElement).isContentEditable; } catch { return false; }
}

// Add Product Dialog
function AddProductDialog({ suppliers }: { suppliers: SupplierOption[] }) {
  const queryClient = useQueryClient();
  const systemSupplierNames = useMemo(
    () => new Set(["unknown", "initial stock", "initial order"]),
    [],
  );
  const assignableSuppliers = useMemo(
    () => suppliers.filter((s) => !systemSupplierNames.has(s.name.trim().toLowerCase())),
    [suppliers, systemSupplierNames],
  );

  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const { data: purchaseConfigData } = useClientQuery<{
    purchaseApprovalQtyThreshold?: number;
    supplierPaymentApprovalThreshold?: number;
  }>({
    queryKey: ["admin", "purchases", "config"],
    queryFn: () => fetch("/api/admin/purchases/config").then((r) => r.json()),
  });

  type ProductFormValues = z.input<typeof productSchema>;
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema) as unknown as Resolver<ProductFormValues>,
    defaultValues: {
      name: "",
      description: "",
      imageUrl: "",
      category: "",
      brand: "",
      supplier: "",
      supplierId: "",
      minMarginPct: undefined,
      marginOverrideReason: undefined,
      price: 0,
      cost: 0,
      stock: 0,
      receiveNow: false,
      paidOnReceipt: false,
      paymentMethod: undefined,
      lotCode: "",
      expiryDate: "",
      requiresLotTracking: false,
      requiresExpiryDate: false,
    },
  });
  const receiveNow = form.watch("receiveNow");
  const paidOnReceipt = form.watch("paidOnReceipt");
  const requiresLotTracking = form.watch("requiresLotTracking");
  const requiresExpiryDate = form.watch("requiresExpiryDate");
  const watchPrice = Number(form.watch("price") || 0);
  const watchCost = Number(form.watch("cost") || 0);
  const watchStock = Number(form.watch("stock") || 0);
  const watchMinMargin = form.watch("minMarginPct");
  const watchOverrideReason = form.watch("marginOverrideReason");
  const purchaseApprovalThreshold = Number(
    purchaseConfigData?.purchaseApprovalQtyThreshold ??
      process.env.NEXT_PUBLIC_PURCHASE_APPROVAL_QTY_THRESHOLD ??
      0,
  );
  const paymentApprovalThreshold = Number(
    purchaseConfigData?.supplierPaymentApprovalThreshold ??
      process.env.NEXT_PUBLIC_SUPPLIER_PAYMENT_APPROVAL_THRESHOLD ??
      0,
  );
  const approvalRequiredForInitialStock =
    Boolean(receiveNow) &&
    Number.isFinite(purchaseApprovalThreshold) &&
    purchaseApprovalThreshold > 0 &&
    watchStock >= purchaseApprovalThreshold;
  const highValueCreditOnlyForInitialStock =
    Boolean(receiveNow) &&
    Number.isFinite(paymentApprovalThreshold) &&
    paymentApprovalThreshold > 0 &&
    watchStock * watchCost >= paymentApprovalThreshold;
  const currentMarginPct = watchPrice > 0 ? ((watchPrice - watchCost) / watchPrice) * 100 : 0;
  const marginError = getMarginGuardError({
    price: watchPrice,
    cost: watchCost,
    minMarginPct: typeof watchMinMargin === "number" ? watchMinMargin : undefined,
  });
  const supplierField = form.register("supplier", {
    onChange: (event) => {
      form.setValue("supplierId", undefined);
      return event;
    },
  });

  useEffect(() => {
    if (!approvalRequiredForInitialStock) return;
    form.setValue("receiveNow", false);
    form.setValue("paidOnReceipt", false);
    form.setValue("paymentMethod", undefined);
  }, [approvalRequiredForInitialStock, form]);

  useEffect(() => {
    if (!highValueCreditOnlyForInitialStock) return;
    form.setValue("paidOnReceipt", false);
    form.setValue("paymentMethod", undefined);
  }, [form, highValueCreditOnlyForInitialStock]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (data.url) {
      form.setValue("imageUrl", data.url);
      setPreview(data.url);
      toast.success("Image uploaded");
    } else {
      toast.error("Failed to upload image");
    }
    setUploading(false);
  };

  const onSubmit: SubmitHandler<ProductFormValues> = async (values) => {
    const parsed = productSchema.parse(values);
    try {
      form.clearErrors();
      if (Boolean(parsed.receiveNow) && Boolean(parsed.paidOnReceipt) && !parsed.paymentMethod) {
        form.setError("paymentMethod", {
          type: "manual",
          message: "Select payment mode when Pay now is checked.",
        });
        return;
      }
      if (Boolean(parsed.receiveNow) && Boolean(parsed.requiresLotTracking) && !String(parsed.lotCode || "").trim()) {
        form.setError("lotCode", {
          type: "manual",
          message: "Lot/Batch code is required for this product.",
        });
        return;
      }
      if (Boolean(parsed.receiveNow) && Boolean(parsed.requiresExpiryDate) && !String(parsed.expiryDate || "").trim()) {
        form.setError("expiryDate", {
          type: "manual",
          message: "Expiry date is required for this product.",
        });
        return;
      }
      const capitalizedName = toTitleCase(parsed.name || "");
      const payload = {
        ...parsed,
        name: capitalizedName,
        price: Number(parsed.price),
        cost: Number(parsed.cost),
        stock: Number(parsed.stock),
        receiveNow: approvalRequiredForInitialStock ? false : parsed.receiveNow !== false,
        paidOnReceipt:
          highValueCreditOnlyForInitialStock || approvalRequiredForInitialStock
            ? false
            : parsed.paidOnReceipt !== false,
        paymentMethod:
          highValueCreditOnlyForInitialStock ||
          approvalRequiredForInitialStock ||
          parsed.paidOnReceipt === false
            ? undefined
            : parsed.paymentMethod,
        requiresLotTracking: Boolean(parsed.requiresLotTracking) || Boolean(parsed.requiresExpiryDate),
        requiresExpiryDate: Boolean(parsed.requiresExpiryDate),
        marginOverrideReason: parsed.marginOverrideReason?.trim() || undefined,
      };
      const res = await fetch("/api/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const message = String(err?.error || "Failed to add product");
        const lower = message.toLowerCase();
        if (lower.includes("supplier")) {
          form.setError("supplier", { type: "server", message });
        } else if (lower.includes("lot/batch code")) {
          form.setError("lotCode", { type: "server", message });
        } else if (lower.includes("expiry date")) {
          form.setError("expiryDate", { type: "server", message });
        } else if (lower.includes("payment mode")) {
          form.setError("paymentMethod", { type: "server", message });
        } else {
          toast.error(message);
        }
        return;
      }
      const created = await res.json().catch(() => ({} as {
        initialPurchase?: { id?: string; status?: string; quantity?: number };
      }));
      queryClient.invalidateQueries({ queryKey: ["admin","products"] });
      if (created?.initialPurchase?.status === "PENDING_APPROVAL") {
        toast.info(
          `${values.name} saved. Initial purchase (${created.initialPurchase.quantity || 0}) is pending approval in Purchases.`,
        );
      } else if (created?.initialPurchase?.status === "ORDERED") {
        toast.info(`${values.name} saved. Initial order was created and awaits receiving.`);
      } else {
        toast.success(`${values.name} added successfully`);
      }
      form.reset();
      setPreview(null);
      setOpen(false);
    } catch (e) {
      console.error(e);
      toast.error("Unexpected error adding product");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default">+ Add Product</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Add New Product</DialogTitle>
        </DialogHeader>
        <form
            onSubmit={form.handleSubmit(
              onSubmit,
              () => {},
            )}
          className="space-y-2"
        >
          <Label>Name</Label>
          <Input
            {...form.register("name")}
            className={`capitalize ${form.formState.errors.name ? "border-red-500" : ""}`}
          />
          {form.formState.errors.name && (
            <p className="text-xs text-red-600">{String(form.formState.errors.name.message)}</p>
          )}

          <Label>Description</Label>
          <Input
            {...form.register("description")}
            className={form.formState.errors.description ? "border-red-500" : undefined}
          />
           {form.formState.errors.description && (
            <p className="text-xs text-red-600">{String(form.formState.errors.description.message)}</p>
          )}

          <Label>Category</Label>
          <select
            {...form.register("category")}
            className={`h-10 w-full rounded-md border border-input bg-background px-3 text-sm ${
              form.formState.errors.category ? "border-red-500" : ""
            }`}
          >
            <option value="">Select a category</option>
            {PRODUCT_CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {form.formState.errors.category && (
            <p className="text-xs text-red-600">{String(form.formState.errors.category.message)}</p>
          )}

          <Label>Brand</Label>
          <Input
            {...form.register("brand")}
            className={form.formState.errors.brand ? "border-red-500" : undefined}
          />
          {form.formState.errors.brand && (
            <p className="text-xs text-red-600">{String(form.formState.errors.brand.message)}</p>
          )}

          <Label>Supplier</Label>
          <select
            className={`h-10 w-full rounded-md border border-input bg-background px-3 text-sm ${
              form.formState.errors.supplier ? "border-red-500" : ""
            }`}
            value={form.watch("supplierId") || ""}
            onChange={(e) => {
              const nextId = e.target.value || "";
              form.setValue("supplierId", nextId || undefined);
              const match = assignableSuppliers.find((s) => s.id === nextId);
              if (match) form.setValue("supplier", match.name);
              if (form.formState.errors.supplier) form.clearErrors("supplier");
            }}
          >
            <option value="">Select supplier</option>
            {assignableSuppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name} · {supplier.leadTimeDays}d
              </option>
            ))}
          </select>
          <Input
            {...supplierField}
            className={form.formState.errors.supplier ? "border-red-500" : undefined}
          />
          {form.formState.errors.supplier && (
            <p className="text-xs text-red-600">{String(form.formState.errors.supplier.message)}</p>
          )}

          <Label>Image</Label>
          <div className="grid gap-2">
            <Input
              placeholder="https://example.com/image.jpg or /images/file.jpg"
              {...form.register("imageUrl")}
              className={form.formState.errors.imageUrl ? "border-red-500" : undefined}
            />
            <p className="text-xs text-muted-foreground">Or upload a file:</p>
            <Input
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className={form.formState.errors.imageUrl ? "border-red-500" : undefined}
            />
          </div>
          {uploading && <p className="text-sm text-muted-foreground">Uploading...</p>}
          {(() => {
            const url = (form.watch("imageUrl") as string) || preview || "";
            return url ? (
              <div className="flex items-center gap-3">
                <img src={url} alt="Preview" className="w-32 h-32 object-cover rounded-md border" />
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm underline text-primary"
                  title="Open image in new tab"
                >
                  Open image
                </a>
              </div>
            ) : null;
          })()}
          {form.formState.errors.imageUrl && (
            <p className="text-xs text-red-600">{String(form.formState.errors.imageUrl.message)}</p>
          )}

          <Label>Price</Label>
          <Input
            type="number"
            step="0.01"
            {...form.register("price", { valueAsNumber: true })}
            className={form.formState.errors.price ? "border-red-500" : undefined}
          />
          {form.formState.errors.price && (
            <p className="text-xs text-red-600">{String(form.formState.errors.price.message)}</p>
          )}

          <div>
            <Label>Cost (initial)</Label>
            <Input
              type="number"
              step="0.01"
              {...form.register("cost", { valueAsNumber: true })}
              className={form.formState.errors.cost ? "border-red-500" : undefined}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Used as the starting average cost. Subsequent purchases will update the weighted cost automatically.
            </p>
            {form.formState.errors.cost && (
              <p className="text-xs text-red-600">{String(form.formState.errors.cost.message)}</p>
            )}
          </div>

          <div>
            <Label>Minimum margin % (optional)</Label>
            <Input
              type="number"
              step="0.1"
              placeholder="e.g., 10"
              {...form.register("minMarginPct", {
                setValueAs: (value) => (value === "" || value == null ? undefined : Number(value)),
              })}
              className={form.formState.errors.minMarginPct ? "border-red-500" : undefined}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Current margin: {Number.isFinite(currentMarginPct) ? currentMarginPct.toFixed(1) : "0.0"}%
            </p>
            {typeof watchMinMargin === "number" && Number.isFinite(currentMarginPct) && currentMarginPct < watchMinMargin ? (
              <p className="text-xs text-amber-600">Current margin is below the minimum target.</p>
            ) : null}
            {form.formState.errors.minMarginPct && (
              <p className="text-xs text-red-600">{String(form.formState.errors.minMarginPct.message)}</p>
            )}
          </div>

          {marginError ? (
            <div>
              <Label>Margin override reason (required)</Label>
              <Input
                placeholder="Explain why this price is allowed (min 5 chars)"
                {...form.register("marginOverrideReason", {
                  setValueAs: (value) => (value ? String(value).trim() : undefined),
                })}
                className={
                  !watchOverrideReason || String(watchOverrideReason).trim().length < 5
                    ? "border-amber-500"
                    : undefined
                }
              />
              <p className="text-xs text-amber-600 mt-1">{marginError}</p>
            </div>
          ) : null}

          <Label>{receiveNow ? "Initial Stock" : "Initial Order Qty"}</Label>
          <Input
            type="number"
            {...form.register("stock", { valueAsNumber: true })}
            className={form.formState.errors.stock ? "border-red-500" : undefined}
          />
          <p className="text-xs text-muted-foreground mt-1">
            {receiveNow
              ? "This adds inventory immediately and creates a received purchase."
              : "This creates a purchase order only. Stock remains 0 until received."}
          </p>
          {approvalRequiredForInitialStock ? (
            <p className="text-xs text-amber-700 mt-1">
              Quantity requires approval. Product will be created with a pending-approval purchase (no stock received yet).
            </p>
          ) : null}
          {form.formState.errors.stock && (
            <p className="text-xs text-red-600">{String(form.formState.errors.stock.message)}</p>
          )}

          <div className="rounded-md border border-dashed p-3 space-y-2 text-xs text-muted-foreground">
            <div className="text-sm font-medium text-foreground">Regulated SKU tracking</div>
            <div className="flex items-center gap-2">
              <input
                id="requiresLotTracking"
                type="checkbox"
                checked={requiresLotTracking === true}
                onChange={(e) => {
                  const next = e.target.checked;
                  form.setValue("requiresLotTracking", next);
                  if (!next && requiresExpiryDate) {
                    form.setValue("requiresExpiryDate", false);
                  }
                }}
              />
              <Label htmlFor="requiresLotTracking" className="cursor-pointer">
                Require lot/batch tracking
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="requiresExpiryDate"
                type="checkbox"
                checked={requiresExpiryDate === true}
                onChange={(e) => {
                  const next = e.target.checked;
                  form.setValue("requiresExpiryDate", next);
                  if (next) form.setValue("requiresLotTracking", true);
                }}
              />
              <Label htmlFor="requiresExpiryDate" className="cursor-pointer">
                Require expiry date
              </Label>
            </div>
            <p>
              When enabled, receiving and stock adjustments require lot codes and/or expiry dates.
            </p>
          </div>

            <div className="mt-3 flex items-center gap-2 text-sm">
              <input
                id="receiveNow"
                type="checkbox"
                checked={receiveNow !== false}
                onChange={(e) => {
                  form.setValue("receiveNow", e.target.checked);
                  if (!e.target.checked) {
                    form.setValue("paidOnReceipt", false);
                    form.setValue("paymentMethod", undefined);
                  }
                }}
                disabled={approvalRequiredForInitialStock}
              />
              <Label htmlFor="receiveNow" className="cursor-pointer">Receive now</Label>
            </div>
          <div className="mt-2 space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <input
                id="paidOnReceipt"
                type="checkbox"
                checked={paidOnReceipt !== false}
                onChange={(e) => {
                  form.setValue("paidOnReceipt", e.target.checked);
                  if (!e.target.checked) {
                    form.setValue("paymentMethod", undefined);
                  }
                }}
                disabled={!receiveNow || highValueCreditOnlyForInitialStock}
              />
              <Label htmlFor="paidOnReceipt" className="cursor-pointer">Pay now</Label>
            </div>
            {!receiveNow ? (
              <p className="text-xs text-muted-foreground">
                Enable Receive now to allow immediate payment.
              </p>
            ) : null}
              {highValueCreditOnlyForInitialStock ? (
                <p className="text-xs text-amber-700">
                  High-value receipts are created on credit. Record payment after approval.
                </p>
              ) : null}
              {receiveNow || requiresLotTracking || requiresExpiryDate ? (
                <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="lotCode">Lot / Batch code</Label>
                  <Input
                    id="lotCode"
                    placeholder={requiresLotTracking ? "Required for regulated SKUs" : "Optional"}
                    value={form.watch("lotCode") || ""}
                    onChange={(e) => {
                      form.setValue("lotCode", e.target.value);
                      if (form.formState.errors.lotCode) form.clearErrors("lotCode");
                    }}
                    className={form.formState.errors.lotCode ? "border-red-500" : undefined}
                  />
                  {form.formState.errors.lotCode && (
                    <p className="text-xs text-red-600">{String(form.formState.errors.lotCode.message)}</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="expiryDate">Expiry date</Label>
                  <Input
                    id="expiryDate"
                    type="date"
                    value={form.watch("expiryDate") || ""}
                    onChange={(e) => {
                      form.setValue("expiryDate", e.target.value);
                      if (form.formState.errors.expiryDate) form.clearErrors("expiryDate");
                    }}
                    className={form.formState.errors.expiryDate ? "border-red-500" : undefined}
                  />
                  {form.formState.errors.expiryDate && (
                    <p className="text-xs text-red-600">{String(form.formState.errors.expiryDate.message)}</p>
                  )}
                </div>
                </div>
              ) : null}
              <select
                className={`border rounded-md h-9 w-full bg-background ${
                  form.formState.errors.paymentMethod ? "border-red-500" : ""
                }`}
                value={form.watch("paymentMethod") || ""}
                onChange={(e) => {
                  const next = e.target.value as "cash" | "transfer" | "bank" | "";
                  form.setValue("paymentMethod", next || undefined);
                  if (form.formState.errors.paymentMethod) form.clearErrors("paymentMethod");
                }}
                disabled={
                  !receiveNow ||
                  paidOnReceipt === false ||
                  highValueCreditOnlyForInitialStock
                }
              >
                <option value="" disabled>Select payment mode</option>
                <option value="cash">Cash</option>
                <option value="transfer">Transfer</option>
                <option value="bank">Bank</option>
              </select>
              {form.formState.errors.paymentMethod && (
                <p className="text-xs text-red-600">{String(form.formState.errors.paymentMethod.message)}</p>
              )}
          </div>

          <div className="flex justify-end pt-3">
            <Button type="submit" disabled={uploading}>Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Edit Dialog
type AdminProduct = {
  id: string;
  sku?: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  category?: string | null;
  brand?: string | null;
  supplier?: string | null;
  supplierId?: string | null;
  approvalThresholdQty?: number | null;
  requiresLotTracking?: boolean | null;
  requiresExpiryDate?: boolean | null;
  minMarginPct?: number | null;
  price: number | string;
  cost: number | string;
  stock: number;
  archived?: boolean;
  orderCount?: number;
  createdAt: string | Date;
  updatedAt: string | Date;
};

function EditProductDialog({
  product,
  isAdmin,
  suppliers,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  product: AdminProduct;
  isAdmin: boolean;
  suppliers: SupplierOption[];
  trigger?: React.ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const actualOpen = controlledOpen !== undefined ? controlledOpen : open;
  const setActualOpen = onOpenChange || setOpen;
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(product.imageUrl);
  const [saving, setSaving] = useState(false);
  const [linkSupplierId, setLinkSupplierId] = useState("");
  const [linkLeadTime, setLinkLeadTime] = useState("");
  const [linkMinOrderQty, setLinkMinOrderQty] = useState("");
  const [linkPackSize, setLinkPackSize] = useState("");
  const [linkPrimary, setLinkPrimary] = useState(false);
  const priceStockLocked =
    !isAdmin && Date.now() - new Date(product.createdAt).getTime() > 48 * 60 * 60 * 1000;

  const { data: linksData } = useClientQuery<{
    rows: Array<{
      supplierId: string;
      isPrimary: boolean;
      leadTimeDays?: number | null;
      minOrderQty?: number | null;
      packSize?: number | null;
      supplier: { name: string };
    }>;
  }>({
    queryKey: ["admin", "product-suppliers", product.id],
    queryFn: () => fetch(`/api/admin/products/${product.id}/suppliers`).then((r) => r.json()),
    enabled: actualOpen,
  });
  const supplierLinks = Array.isArray(linksData?.rows) ? linksData.rows : [];

  type ProductEditFormValues = z.input<typeof productEditSchema>;
  const form = useForm<ProductEditFormValues>({
    resolver: zodResolver(productEditSchema) as unknown as Resolver<ProductEditFormValues>,
    defaultValues: {
      name: product.name,
      description: product.description ?? undefined,
      imageUrl: product.imageUrl ?? undefined,
      category: product.category ?? "",
      brand: product.brand ?? "",
      supplier: product.supplier ?? "",
      supplierId: product.supplierId ?? "",
      minMarginPct: product.minMarginPct ?? undefined,
      marginOverrideReason: undefined,
      price: Number(product.price || 0),
      stock: Number(product.stock || 0),
      requiresLotTracking: Boolean(product.requiresLotTracking),
      requiresExpiryDate: Boolean(product.requiresExpiryDate),
      editReason: "",
    },
  });
  const editPrice = Number(form.watch("price") ?? product.price ?? 0);
  const editCost = Number(product.cost ?? 0);
  const editMinMargin = form.watch("minMarginPct");
  const editOverrideReason = form.watch("marginOverrideReason");
  const editMarginPct = editPrice > 0 ? ((editPrice - editCost) / editPrice) * 100 : 0;
  const editMarginError = getMarginGuardError({
    price: editPrice,
    cost: editCost,
    minMarginPct: typeof editMinMargin === "number" ? editMinMargin : undefined,
  });
  const requiresLotTracking = form.watch("requiresLotTracking");
  const requiresExpiryDate = form.watch("requiresExpiryDate");
  const supplierField = form.register("supplier", {
    onChange: (event) => {
      form.setValue("supplierId", undefined);
      return event;
    },
  });

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (data.url) {
      form.setValue("imageUrl", data.url);
      setPreview(data.url);
      toast.success("Image uploaded");
    } else {
      toast.error("Failed to upload image");
    }
    setUploading(false);
  };

  const saveSupplierLink = async () => {
    if (!linkSupplierId) {
      toast.error("Select a supplier to link.");
      return;
    }
    try {
      const payload = {
        supplierId: linkSupplierId,
        isPrimary: linkPrimary,
        leadTimeDays: linkLeadTime ? Number(linkLeadTime) : undefined,
        minOrderQty: linkMinOrderQty ? Number(linkMinOrderQty) : undefined,
        packSize: linkPackSize ? Number(linkPackSize) : undefined,
      };
      const res = await fetch(`/api/admin/products/${product.id}/suppliers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save supplier link.");
      toast.success("Supplier link saved.");
      setLinkSupplierId("");
      setLinkLeadTime("");
      setLinkMinOrderQty("");
      setLinkPackSize("");
      setLinkPrimary(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "product-suppliers", product.id] });
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save supplier link.");
    }
  };

  const deleteSupplierLink = async (supplierId: string) => {
    try {
      const res = await fetch(`/api/admin/products/${product.id}/suppliers`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to delete supplier link.");
      toast.success("Supplier link removed.");
      queryClient.invalidateQueries({ queryKey: ["admin", "product-suppliers", product.id] });
      queryClient.invalidateQueries({ queryKey: ["admin", "products"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete supplier link.");
    }
  };

  const onSubmit: SubmitHandler<ProductEditFormValues> = async (values) => {
    const parsed = productEditSchema.parse(values);
    try {
      setSaving(true);
      const payload: Partial<Pick<AdminProduct, "name" | "description" | "imageUrl" | "price" | "stock" | "category" | "brand" | "supplier" | "requiresLotTracking" | "requiresExpiryDate" | "minMarginPct">> & {
        editReason?: string;
        marginOverrideReason?: string;
        supplierId?: string | null;
      } = {};
      if (typeof parsed.name === "string" && parsed.name.trim() !== "") {
        const capitalized = toTitleCase(parsed.name.trim());
        payload.name = capitalized;
      }
      if (typeof parsed.description === "string" && parsed.description.trim() !== "") {
        payload.description = parsed.description.trim();
      }
      if (typeof parsed.imageUrl === "string" && parsed.imageUrl.trim() !== "") {
        payload.imageUrl = parsed.imageUrl.trim();
      }
      if (typeof parsed.category === "string" && parsed.category.trim() !== "") {
        const nextCategory = parsed.category.trim();
        const currentCategory = String(product.category || "");
        if (nextCategory !== currentCategory) {
          payload.category = nextCategory;
        }
      }
      if (typeof parsed.brand === "string" && parsed.brand.trim() !== "") {
        const nextBrand = parsed.brand.trim();
        const currentBrand = String(product.brand || "");
        if (nextBrand !== currentBrand) {
          payload.brand = nextBrand;
        }
      }
      const nextSupplierId = typeof parsed.supplierId === "string" ? parsed.supplierId.trim() : "";
      const nextSupplier = typeof parsed.supplier === "string" ? parsed.supplier.trim() : "";
      const currentSupplierId = String(product.supplierId || "");
      const currentSupplier = String(product.supplier || "");
      if (nextSupplierId) {
        if (nextSupplierId !== currentSupplierId) {
          payload.supplierId = nextSupplierId;
        }
      } else if (nextSupplier) {
        if (nextSupplier !== currentSupplier || currentSupplierId) {
          payload.supplier = nextSupplier;
          if (currentSupplierId) payload.supplierId = null;
        }
      }
      const nextMinMargin =
        typeof parsed.minMarginPct === "number" && Number.isFinite(parsed.minMarginPct)
          ? parsed.minMarginPct
          : undefined;
      const currentMinMargin =
        product.minMarginPct != null ? Number(product.minMarginPct) : undefined;
      if (nextMinMargin !== undefined && nextMinMargin !== currentMinMargin) {
        payload.minMarginPct = nextMinMargin;
      } else if (nextMinMargin === undefined && currentMinMargin !== undefined) {
        payload.minMarginPct = null;
      }
      if (typeof parsed.marginOverrideReason === "string" && parsed.marginOverrideReason.trim() !== "") {
        payload.marginOverrideReason = parsed.marginOverrideReason.trim();
      }
      const nextPrice = Number(parsed.price);
      const nextStock = Number(parsed.stock);
      const oldPrice = Number(product.price);
      const oldStock = Number(product.stock);
      const oldRequiresLotTracking = Boolean(product.requiresLotTracking);
      const oldRequiresExpiryDate = Boolean(product.requiresExpiryDate);
      if (!Number.isNaN(nextPrice) && nextPrice !== oldPrice) {
        if (priceStockLocked) {
          toast.error("Price/stock edits are locked after 48 hours for non-admin roles.");
          setSaving(false);
          return;
        }
        payload.price = nextPrice;
      }
      if (!Number.isNaN(nextStock) && nextStock !== oldStock) {
        if (priceStockLocked) {
          toast.error("Price/stock edits are locked after 48 hours for non-admin roles.");
          setSaving(false);
          return;
        }
        payload.stock = nextStock;
      }
      if (typeof parsed.requiresLotTracking === "boolean" && parsed.requiresLotTracking !== oldRequiresLotTracking) {
        payload.requiresLotTracking = parsed.requiresLotTracking;
      }
      if (typeof parsed.requiresExpiryDate === "boolean" && parsed.requiresExpiryDate !== oldRequiresExpiryDate) {
        payload.requiresExpiryDate = parsed.requiresExpiryDate;
        if (parsed.requiresExpiryDate && !parsed.requiresLotTracking) {
          payload.requiresLotTracking = true;
        }
      }
      if (typeof parsed.editReason === "string" && parsed.editReason.trim() !== "") {
        payload.editReason = parsed.editReason.trim();
      }
      // If nothing to update, bail early
      const { editReason, ...changes } = payload;
      if (Object.keys(changes).length === 0) {
        toast.info("No changes to save");
        setSaving(false);
        return;
      }
      if (!editReason) {
        toast.error("Please add a brief reason for this change.");
        setSaving(false);
        return;
      }
      const res = await fetch(`/api/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || "Failed to update product");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["admin","products"] });
      toast.success(`${payload.name} updated`);
      form.setValue("editReason", "");
      setActualOpen(false);
    } catch (e) {
      console.error(e);
      toast.error("Unexpected error updating product");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={actualOpen} onOpenChange={setActualOpen}>
      <DialogTrigger asChild>
        {trigger || <Button size="sm" variant="secondary">Edit</Button>}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-h-[85vh] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Edit Product</DialogTitle>
        </DialogHeader>
        <form
            onSubmit={form.handleSubmit(
              onSubmit,
              (errs) => {
                const first = Object.values(errs)[0];
                const message =
                  typeof first?.message === "string"
                    ? first.message
                    : "Please fix the highlighted fields";
                toast.error(message);
              },
            )}
          className="space-y-2"
        >
          <fieldset disabled={uploading || saving} className="space-y-2">
            <Label>Name</Label>
            <Input
              {...form.register("name")}
              className={`capitalize ${form.formState.errors.name ? "border-red-500" : ""}`}
            />
            {form.formState.errors.name && (
              <p className="text-xs text-red-600">{String(form.formState.errors.name.message)}</p>
            )}

            <Label>Description</Label>
            <Input
              {...form.register("description")}
              className={form.formState.errors.description ? "border-red-500" : undefined}
            />
            {form.formState.errors.description && (
              <p className="text-xs text-red-600">{String(form.formState.errors.description.message)}</p>
            )}

            <Label>Category</Label>
            <select
              {...form.register("category")}
              className={`h-10 w-full rounded-md border border-input bg-background px-3 text-sm ${
                form.formState.errors.category ? "border-red-500" : ""
              }`}
            >
              <option value="">Select a category</option>
              {PRODUCT_CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {form.formState.errors.category && (
              <p className="text-xs text-red-600">{String(form.formState.errors.category.message)}</p>
            )}

            <Label>Brand</Label>
            <Input
              {...form.register("brand")}
              className={form.formState.errors.brand ? "border-red-500" : undefined}
            />
            {form.formState.errors.brand && (
              <p className="text-xs text-red-600">{String(form.formState.errors.brand.message)}</p>
            )}

            <Label>Supplier</Label>
            <select
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.watch("supplierId") || ""}
              onChange={(e) => {
                const nextId = e.target.value || "";
                form.setValue("supplierId", nextId || undefined);
                const match = suppliers.find((s) => s.id === nextId);
                if (match) form.setValue("supplier", match.name);
              }}
            >
              <option value="">Select supplier (optional)</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name} · {supplier.leadTimeDays}d
                </option>
              ))}
            </select>
            <Input
              {...supplierField}
              className={form.formState.errors.supplier ? "border-red-500" : undefined}
            />
            {form.formState.errors.supplier && (
              <p className="text-xs text-red-600">{String(form.formState.errors.supplier.message)}</p>
            )}

            <div className="rounded-md border p-3 space-y-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Alternate suppliers</div>
              {supplierLinks.length === 0 ? (
                <p className="text-xs text-muted-foreground">No alternate suppliers linked yet.</p>
              ) : (
                <div className="space-y-2">
                  {supplierLinks.map((link) => (
                    <div key={link.supplierId} className="flex items-center justify-between gap-2 text-sm">
                      <div>
                        <span className="font-medium">{link.supplier.name}</span>
                        {link.isPrimary ? (
                          <span className="ml-2 text-[11px] rounded border px-1.5 py-0.5">Primary</span>
                        ) : null}
                        <div className="text-xs text-muted-foreground">
                          LT {link.leadTimeDays ?? "-"} · MOQ {link.minOrderQty ?? "-"} · Pack {link.packSize ?? "-"}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => deleteSupplierLink(link.supplierId)}
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={linkSupplierId}
                  onChange={(e) => setLinkSupplierId(e.target.value)}
                >
                  <option value="">Select supplier</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={linkPrimary}
                    onChange={(e) => setLinkPrimary(e.target.checked)}
                  />
                  Set as primary
                </label>
                <Input
                  placeholder="Lead time override"
                  value={linkLeadTime}
                  onChange={(e) => setLinkLeadTime(e.target.value)}
                />
                <Input
                  placeholder="Min order qty"
                  value={linkMinOrderQty}
                  onChange={(e) => setLinkMinOrderQty(e.target.value)}
                />
                <Input
                  placeholder="Pack size"
                  value={linkPackSize}
                  onChange={(e) => setLinkPackSize(e.target.value)}
                />
              </div>
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={saveSupplierLink}>
                  Add supplier link
                </Button>
              </div>
            </div>

          <Label>Image</Label>
          <div className="grid gap-2">
            <Input
              placeholder="https://example.com/image.jpg or /images/file.jpg"
              {...form.register("imageUrl")}
              className={form.formState.errors.imageUrl ? "border-red-500" : undefined}
            />
            <p className="text-xs text-muted-foreground">Or upload a file:</p>
            <Input
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className={form.formState.errors.imageUrl ? "border-red-500" : undefined}
            />
          </div>
          {uploading && <p className="text-sm text-muted-foreground">Uploading...</p>}
          {(() => {
            const url = (form.watch("imageUrl") as string) || preview || "";
            return url ? (
              <div className="flex items-center gap-3">
                <img src={url} alt="Preview" className="w-32 h-32 object-cover rounded-md border" />
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm underline text-primary"
                  title="Open image in new tab"
                >
                  Open image
                </a>
              </div>
            ) : null;
          })()}
          {form.formState.errors.imageUrl && (
            <p className="text-xs text-red-600">{String(form.formState.errors.imageUrl.message)}</p>
          )}

            <Label>Price</Label>
            <Input
              type="number"
              step="0.01"
              {...form.register("price", { valueAsNumber: true })}
              disabled={priceStockLocked}
              className={form.formState.errors.price ? "border-red-500" : undefined}
            />
            {form.formState.errors.price && (
              <p className="text-xs text-red-600">{String(form.formState.errors.price.message)}</p>
            )}
            {priceStockLocked && (
              <p className="text-xs text-muted-foreground">
                Price edits are locked after 48 hours for non-admin roles.
              </p>
            )}

            <Label>Cost (auto-calculated)</Label>
            <Input
              type="number"
              step="0.01"
              value={Number(product.cost || 0)}
              readOnly
              disabled
              className="bg-muted"
            />
            <p className="text-xs text-muted-foreground">
              Cost is the weighted average from purchases and cannot be edited here.
            </p>

            <Label>Minimum margin % (optional)</Label>
            <Input
              type="number"
              step="0.1"
              placeholder="e.g., 10"
              {...form.register("minMarginPct", {
                setValueAs: (value) => (value === "" || value == null ? undefined : Number(value)),
              })}
              className={form.formState.errors.minMarginPct ? "border-red-500" : undefined}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Current margin: {Number.isFinite(editMarginPct) ? editMarginPct.toFixed(1) : "0.0"}%
            </p>
            {typeof editMinMargin === "number" && Number.isFinite(editMarginPct) && editMarginPct < editMinMargin ? (
              <p className="text-xs text-amber-600">Current margin is below the minimum target.</p>
            ) : null}
            {form.formState.errors.minMarginPct && (
              <p className="text-xs text-red-600">{String(form.formState.errors.minMarginPct.message)}</p>
            )}

            {editMarginError ? (
              <div>
                <Label>Margin override reason (required)</Label>
                <Input
                  placeholder="Explain why this price is allowed (min 5 chars)"
                  {...form.register("marginOverrideReason", {
                    setValueAs: (value) => (value ? String(value).trim() : undefined),
                  })}
                  className={
                    !editOverrideReason || String(editOverrideReason).trim().length < 5
                      ? "border-amber-500"
                      : undefined
                  }
                />
                <p className="text-xs text-amber-600 mt-1">{editMarginError}</p>
              </div>
            ) : null}

            <Label>Stock</Label>
            <Input
              type="number"
              {...form.register("stock", { valueAsNumber: true })}
              disabled={priceStockLocked}
              className={form.formState.errors.stock ? "border-red-500" : undefined}
            />
            {form.formState.errors.stock && (
              <p className="text-xs text-red-600">{String(form.formState.errors.stock.message)}</p>
            )}
            {priceStockLocked && (
              <p className="text-xs text-muted-foreground">
                Stock edits are locked after 48 hours for non-admin roles.
              </p>
            )}

            <div className="rounded-md border border-dashed p-3 space-y-2 text-xs text-muted-foreground">
              <div className="text-sm font-medium text-foreground">Regulated SKU tracking</div>
              <div className="flex items-center gap-2">
                <input
                  id={`requiresLotTracking-${product.id}`}
                  type="checkbox"
                  checked={requiresLotTracking === true}
                  onChange={(e) => {
                    const next = e.target.checked;
                    form.setValue("requiresLotTracking", next);
                    if (!next && requiresExpiryDate) {
                      form.setValue("requiresExpiryDate", false);
                    }
                  }}
                />
                <Label htmlFor={`requiresLotTracking-${product.id}`} className="cursor-pointer">
                  Require lot/batch tracking
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id={`requiresExpiryDate-${product.id}`}
                  type="checkbox"
                  checked={requiresExpiryDate === true}
                  onChange={(e) => {
                    const next = e.target.checked;
                    form.setValue("requiresExpiryDate", next);
                    if (next) form.setValue("requiresLotTracking", true);
                  }}
                />
                <Label htmlFor={`requiresExpiryDate-${product.id}`} className="cursor-pointer">
                  Require expiry date
                </Label>
              </div>
              <p>
                When enabled, purchases and adjustments must include lot codes and/or expiry dates.
              </p>
            </div>

            <Label>Reason for change</Label>
            <Input
              placeholder="e.g., correcting description / stock audit / price update"
              {...form.register("editReason")}
              className={form.formState.errors.editReason ? "border-red-500" : undefined}
            />
            {form.formState.errors.editReason && (
              <p className="text-xs text-red-600">
                {String(form.formState.errors.editReason.message)}
              </p>
            )}

            <div className="flex justify-end pt-3">
              <Button type="submit" disabled={uploading || saving}>
                {saving ? (
                  <>
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Delete Dialog
function DeleteProductDialog({ id, name, trigger, open: controlledOpen, onOpenChange }: { id: string; name: string; trigger?: React.ReactElement; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const actualOpen = controlledOpen !== undefined ? controlledOpen : open;
  const setActualOpen = onOpenChange || setOpen;

  const handleDelete = async () => {
    try {
      setDeleting(true);
      const res = await fetch(`/api/products/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
        toast.error(j?.error || "Failed to delete product");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["admin","products"] });
      toast.warning(`${name} deleted`, {
        action: {
          label: "Undo",
          onClick: async () => {
            const restore = await fetch(`/api/products/${id}`, { method: "POST" });
            if (!restore.ok) {
              const j = await restore.json().catch(async () => ({ error: await restore.text().catch(() => "") }));
              toast.error(j?.error || "Failed to restore product");
              return;
            }
            queryClient.invalidateQueries({ queryKey: ["admin","products"] });
            toast.success(`${name} restored`);
          },
        },
      });
      setActualOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={actualOpen} onOpenChange={setActualOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button size="sm" variant="destructive" className="text-white">Delete</Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Delete {name}?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground mb-4">This action cannot be undone.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setActualOpen(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              "Confirm"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
