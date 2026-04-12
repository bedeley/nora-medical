"use client";

export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency, formatDateGH } from "@/lib/currency";
import { formatIdReadable, formatInvoiceNumber } from "@/lib/utils";
import { chipToneClass, deliveryStatusTone, orderStatusTone } from "@/lib/status-chips";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";
import {
  Download,
  RefreshCcw,
  Search,
  DollarSign,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  HelpCircle,
  Filter,
  Save,
  SlidersHorizontal,
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type AdminOrder = {
  id: string;
  status: string;
  deliveryStatus?: string | null;
  createdAt: string | Date;
  updatedAt?: string | Date;
  invoiceNumber?: string | null;
  subtotal?: number | string;
  taxAmount?: number | string;
  discountAmount?: number | string;
  total: number | string;
  amountPaid: number | string;
  balance: number | string;
  userId?: string | null;
  customerType?: string | null;
  walkInName?: string | null;
  walkInPhone?: string | null;
  hasPendingMomo?: boolean;
  user?: { id?: string; name?: string | null; email?: string | null; phone?: string | null } | null;
  adminNote?: string | null;
};

type OrdersSavedFilter = {
  id: string;
  name: string;
  state: {
    filter: string;
    deliveryFilter: string;
    paymentMethod: string;
    customerType: string;
    discountOnly: boolean;
    query: string;
    start: string;
    end: string;
    minTotal: string;
    maxTotal: string;
    userIdFilter: string;
    orderIdFilter: string;
    paymentIdFilter: string;
    outstandingOnly: boolean;
    sortKey: "total" | "amountPaid" | "balance" | "createdAt" | "customer" | "invoice" | "delivery" | null;
    sortDir: "asc" | "desc";
    showPaid: boolean;
    showBalance: boolean;
    showDelivery: boolean;
    pageSize: number;
  };
};

type OrdersResponse = {
  items: AdminOrder[];
  total: number;
  page: number;
  pageSize: number;
  totals: {
    total: number;
    paid: number;
    balance: number;
  };
};

type SavedFiltersSource = "loading" | "server" | "local";

const ORDERS_SAVED_FILTERS_KEY = "orders.savedFilters";
const LEGACY_ORDERS_SAVED_FILTERS_STORAGE_KEY = "admin-orders-saved-filters";

async function fetchJsonOrThrow<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text || null;
  }

  if (!response.ok) {
    if (
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof (payload as { error?: unknown }).error === "string"
    ) {
      throw new Error((payload as { error: string }).error);
    }
    if (typeof payload === "string" && payload.trim()) {
      throw new Error(payload.trim());
    }
    throw new Error(`Request failed (${response.status})`);
  }

  return payload as T;
}

function mergeSavedFilters(serverFilters: OrdersSavedFilter[], legacyFilters: OrdersSavedFilter[]) {
  const merged: OrdersSavedFilter[] = [];
  const seen = new Set<string>();
  for (const item of [...serverFilters, ...legacyFilters]) {
    const key = `${item.id}::${item.name.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function buildOrdersQueryParams(options: {
  filter: string;
  deliveryFilter: string;
  paymentMethod: string;
  customerType: string;
  outstandingOnly: boolean;
  discountOnly: boolean;
  query: string;
  start: string;
  end: string;
  minTotal: string;
  maxTotal: string;
  userIdFilter: string;
  orderIdFilter: string;
  paymentIdFilter: string;
  sortKey: "total" | "amountPaid" | "balance" | "createdAt" | "customer" | "invoice" | "delivery" | null;
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
  ids?: string[];
}) {
  const params = new URLSearchParams();
  params.set("all", "1");
  if (options.filter && options.filter !== "ALL") params.set("filter", options.filter);
  if (options.deliveryFilter && options.deliveryFilter !== "ALL") params.set("dFilter", options.deliveryFilter);
  if (options.paymentMethod && options.paymentMethod !== "ALL") params.set("paymentMethod", options.paymentMethod);
  if (options.customerType && options.customerType !== "ALL") params.set("customerType", options.customerType);
  if (options.outstandingOnly) params.set("outstandingOnly", "1");
  if (options.discountOnly) params.set("discountOnly", "1");
  if (options.query) params.set("q", options.query);
  if (options.start) params.set("start", options.start);
  if (options.end) params.set("end", options.end);
  if (options.minTotal) params.set("minTotal", options.minTotal);
  if (options.maxTotal) params.set("maxTotal", options.maxTotal);
  if (options.userIdFilter) params.set("userId", options.userIdFilter);
  if (options.orderIdFilter) params.set("orderId", options.orderIdFilter);
  if (options.paymentIdFilter) params.set("paymentId", options.paymentIdFilter);
  if (options.sortKey) params.set("sortKey", options.sortKey);
  if (options.sortKey) params.set("sortDir", options.sortDir);
  if (options.ids && options.ids.length > 0) {
    params.set("ids", options.ids.join(","));
    params.set("page", "1");
    params.set("pageSize", String(Math.max(options.ids.length, 1)));
  } else {
    params.set("page", String(options.page));
    params.set("pageSize", String(options.pageSize));
  }
  return params;
}

function AdminOrdersContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const isAdmin = role === "ADMIN";
  const [filter, setFilter] = useState<string>("ALL");
  const [deliveryFilter, setDeliveryFilter] = useState<string>("ALL");
  const [query, setQuery] = useState<string>("");
  const [paymentMethod, setPaymentMethod] = useState<string>("ALL");
  const [customerType, setCustomerType] = useState<string>("ALL");
  const [outstandingOnly, setOutstandingOnly] = useState<boolean>(false);
  const [discountOnly, setDiscountOnly] = useState<boolean>(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");
  const [minTotal, setMinTotal] = useState<string>("");
  const [maxTotal, setMaxTotal] = useState<string>("");
  const [selectedOrder, setSelectedOrder] = useState<AdminOrder | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentNote, setPaymentNote] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isSaveFilterDialogOpen, setIsSaveFilterDialogOpen] = useState(false);
  const [paymentTab, setPaymentTab] = useState<"custom" | "full">("custom");
  const [applyingCredit, setApplyingCredit] = useState(false);
  const [recordingPayment, setRecordingPayment] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [paymentDialogMethod, setPaymentDialogMethod] = useState<"cash" | "momo" | "transfer" | "card">("cash");
  const [sortKey, setSortKey] = useState<
    | "total"
    | "amountPaid"
    | "balance"
    | "createdAt"
    | "customer"
    | "invoice"
    | "delivery"
    | null
  >("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const initialized = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [showPaid, setShowPaid] = useState(true);
  const [showBalance, setShowBalance] = useState(true);
  const [showDelivery, setShowDelivery] = useState(true);
  const [userIdFilter, setUserIdFilter] = useState<string>("");
  const [orderIdFilter, setOrderIdFilter] = useState<string>("");
  const [paymentIdFilter, setPaymentIdFilter] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [savedFilters, setSavedFilters] = useState<OrdersSavedFilter[]>([]);
  const [savedFiltersLoaded, setSavedFiltersLoaded] = useState(false);
  const [savedFiltersSource, setSavedFiltersSource] = useState<SavedFiltersSource>("loading");
  const [saveFilterName, setSaveFilterName] = useState("");
  const [savingFilter, setSavingFilter] = useState(false);
  const [removingFilterId, setRemovingFilterId] = useState<string | null>(null);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const resizing = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({
    select: 44,
    order: 220,
    customer: 240,
    placed: 160,
    status: 160,
    total: 130,
    paid: 130,
    balance: 130,
    delivery: 160,
    actions: 320,
  });
  const getColWidth = (key: string) => columnWidths[key] ?? 140;
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    if (!isDialogOpen) {
      setPaymentError("");
    }
  }, [isDialogOpen]);

  // Initialize state from URL on mount
  useEffect(() => {
    if (initialized.current) return;
    const f = searchParams.get("filter");
    const df = searchParams.get("dFilter");
    const q = searchParams.get("q");
    const startParam = searchParams.get("start");
    const endParam = searchParams.get("end");
    const minParam = searchParams.get("minTotal");
    const maxParam = searchParams.get("maxTotal");
    const methodParam = searchParams.get("paymentMethod");
    const customerTypeParam = searchParams.get("customerType");
    const outstandingOnlyParam = searchParams.get("outstandingOnly");
    const discountOnlyParam = searchParams.get("discountOnly");
    const userIdParam = searchParams.get("userId");
    const orderIdParam = searchParams.get("orderId");
    const paymentIdParam = searchParams.get("paymentId");
    const sk = searchParams.get("sortKey") as
      | "total"
      | "amountPaid"
      | "balance"
      | "createdAt"
      | "customer"
      | "invoice"
      | "delivery"
      | null;
    const sd = searchParams.get("sortDir") as "asc" | "desc" | null;
    const p = Number(searchParams.get("page") || 1);
    const ps = Number(searchParams.get("pageSize") || 25);

    if (f && ["ALL", "UNPAID", "PARTIALLY_PAID", "PAID", "CANCELLED", "ON_HOLD_CREDIT"].includes(f)) setFilter(f);
    if (typeof q === "string") setQuery(q);
    if (startParam) setStart(startParam);
    if (endParam) setEnd(endParam);
    if (minParam) setMinTotal(minParam);
    if (maxParam) setMaxTotal(maxParam);
    if (methodParam) setPaymentMethod(methodParam);
    if (customerTypeParam && ["ALL", "REGISTERED", "WALK_IN"].includes(customerTypeParam)) {
      setCustomerType(customerTypeParam);
    }
    if (outstandingOnlyParam === "1") setOutstandingOnly(true);
    if (discountOnlyParam === "1") setDiscountOnly(true);
    if (userIdParam) setUserIdFilter(userIdParam);
    if (orderIdParam) setOrderIdFilter(orderIdParam);
    if (paymentIdParam) setPaymentIdFilter(paymentIdParam);
    if (sk && ["total", "amountPaid", "balance", "createdAt", "customer", "invoice", "delivery"].includes(sk)) setSortKey(sk);
    if (sd && ["asc", "desc"].includes(sd)) setSortDir(sd);
    if (!Number.isNaN(p) && p > 0) setPage(p);
    if (!Number.isNaN(ps) && ps > 0) setPageSize(ps);
    if (
      df &&
      ["ALL", "NOT_DELIVERED", "PARTIALLY_DELIVERED", "DELIVERED", "RETURNED"].includes(
        df,
      )
    )
      setDeliveryFilter(df);
    if (methodParam || customerTypeParam === "WALK_IN" || customerTypeParam === "REGISTERED" || minParam || maxParam || userIdParam || orderIdParam || paymentIdParam || discountOnlyParam === "1" || outstandingOnlyParam === "1") {
      setShowAdvancedFilters(true);
    }
    initialized.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadSavedFilters() {
      let localFilters: OrdersSavedFilter[] = [];
      if (typeof window !== "undefined") {
        const raw = window.localStorage.getItem(LEGACY_ORDERS_SAVED_FILTERS_STORAGE_KEY);
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as OrdersSavedFilter[];
            if (Array.isArray(parsed)) localFilters = parsed;
          } catch {
            // ignore malformed local filters
          }
        }
      }

      try {
        const response = await fetchJsonOrThrow<{ value: OrdersSavedFilter[] | null }>(
          `/api/admin/preferences?key=${encodeURIComponent(ORDERS_SAVED_FILTERS_KEY)}`,
        );
        const serverFilters = Array.isArray(response?.value) ? response.value : [];
        const mergedFilters = mergeSavedFilters(serverFilters, localFilters);
        if (cancelled) return;
        setSavedFilters(mergedFilters);
        setSavedFiltersSource("server");
        if (mergedFilters.length !== serverFilters.length) {
          void fetch("/api/admin/preferences", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: ORDERS_SAVED_FILTERS_KEY, value: mergedFilters, skipAudit: true }),
          }).catch(() => {});
        }
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(LEGACY_ORDERS_SAVED_FILTERS_STORAGE_KEY);
        }
      } catch {
        if (cancelled) return;
        setSavedFilters(localFilters);
        setSavedFiltersSource("local");
      } finally {
        if (!cancelled) setSavedFiltersLoaded(true);
      }
    }
    void loadSavedFilters();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (savedFiltersSource !== "local") return;
    window.localStorage.setItem(
      LEGACY_ORDERS_SAVED_FILTERS_STORAGE_KEY,
      JSON.stringify(savedFilters),
    );
  }, [savedFilters, savedFiltersSource]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-orders-column-widths");
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
      "admin-orders-column-widths",
      JSON.stringify(columnWidths),
    );
  }, [columnWidths]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizing.current) return;
      const { key, startX, startWidth } = resizing.current;
      const delta = event.clientX - startX;
      const next = Math.max(80, startWidth + delta);
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

  // Reflect state to URL based on current filters/sort/query
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams();
    // filter
    if (filter && filter !== "ALL") params.set("filter", filter);
    else params.delete("filter");
    if (deliveryFilter && deliveryFilter !== "ALL") params.set("dFilter", deliveryFilter);
    else params.delete("dFilter");
    if (paymentMethod && paymentMethod !== "ALL") params.set("paymentMethod", paymentMethod);
    else params.delete("paymentMethod");
    if (customerType && customerType !== "ALL") params.set("customerType", customerType);
    else params.delete("customerType");
    if (outstandingOnly) params.set("outstandingOnly", "1");
    else params.delete("outstandingOnly");
    if (discountOnly) params.set("discountOnly", "1");
    else params.delete("discountOnly");
    if (start) params.set("start", start);
    else params.delete("start");
    if (end) params.set("end", end);
    else params.delete("end");
    if (minTotal) params.set("minTotal", minTotal);
    else params.delete("minTotal");
    if (maxTotal) params.set("maxTotal", maxTotal);
    else params.delete("maxTotal");
    if (userIdFilter) params.set("userId", userIdFilter);
    else params.delete("userId");
    if (orderIdFilter) params.set("orderId", orderIdFilter);
    else params.delete("orderId");
    if (paymentIdFilter) params.set("paymentId", paymentIdFilter);
    else params.delete("paymentId");
    if (page && page > 1) params.set("page", String(page));
    else params.delete("page");
    if (pageSize && pageSize !== 25) params.set("pageSize", String(pageSize));
    else params.delete("pageSize");
    // query
    if (query) params.set("q", query);
    else params.delete("q");
    // sort
    if (sortKey) params.set("sortKey", sortKey);
    else params.delete("sortKey");
    if (sortKey) params.set("sortDir", sortDir);
    else params.delete("sortDir");

    const next = `${pathname}?${params.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [filter, query, sortKey, sortDir, deliveryFilter, paymentMethod, customerType, outstandingOnly, discountOnly, start, end, minTotal, maxTotal, userIdFilter, orderIdFilter, paymentIdFilter, page, pageSize, pathname, router]);

  // Type-to-focus: focus Search and append keystrokes when typing outside inputs
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
    const handler = (event: KeyboardEvent) => {
      const e = event;
      if (e.key === "Escape") {
        const el = searchRef.current;
        if (el) {
          el.value = "";
          setQuery("");
          try {
            el.setSelectionRange(0, 0);
          } catch {
            // ignore
          }
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
      setQuery(next);
      try {
        el.setSelectionRange(start + 1, start + 1);
      } catch {
        // ignore
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener(
        "keydown",
        handler,
        {
          capture: true,
        } as EventListenerOptions,
      );
  }, []);

  const queryClient = useQueryClient();
  const {
    data,
    isLoading,
    isError,
    error,
    isFetching,
    refetch,
  } = useClientQuery<OrdersResponse>({
    queryKey: ["admin", "orders", { filter, deliveryFilter, paymentMethod, customerType, outstandingOnly, discountOnly, query: deferredQuery, start, end, minTotal, maxTotal, userIdFilter, orderIdFilter, paymentIdFilter, sortKey, sortDir, page, pageSize }],
    // Admin dashboard should see all orders, not just the logged-in user's.
    queryFn: () =>
      fetchJsonOrThrow<OrdersResponse>(
        `/api/orders?${buildOrdersQueryParams({
          filter,
          deliveryFilter,
          paymentMethod,
          customerType,
          outstandingOnly,
          discountOnly,
          query: deferredQuery,
          start,
          end,
          minTotal,
          maxTotal,
          userIdFilter,
          orderIdFilter,
          paymentIdFilter,
          sortKey,
          sortDir,
          page,
          pageSize,
        }).toString()}`,
      ),
    refetchOnWindowFocus: false,
  });

  const selectedUserId = selectedOrder?.userId;

  type AccountSummary = {
    ordersTotal: number;
    paidTotal: number;
    paymentsTotal: number;
    balance: number;
    storeCredit: number;
    cashRefunds: number;
    updatedAt: string;
  };

  const {
    data: accountSummary,
    isLoading: isSummaryLoading,
  } = useClientQuery<AccountSummary>({
    queryKey: ["admin", "customer-balance", selectedUserId] as unknown as [
      string,
      string,
      string | null | undefined,
    ],
    queryFn: () =>
      fetchJsonOrThrow(`/api/admin/customers/${selectedUserId}/balance`),
    enabled: !!selectedUserId && isDialogOpen,
    refetchOnWindowFocus: false,
  });

  const orders: AdminOrder[] = useMemo(
    () => (Array.isArray(data?.items) ? data.items : []),
    [data]
  );
  const total = Number(data?.total || 0);
  const totals = data?.totals || { total: 0, paid: 0, balance: 0 };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const visibleIds = orders.map((o) => o.id);
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

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  if (isLoading) {
    return (
      <section className="container mx-auto py-8 space-y-6">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="h-7 w-32 bg-muted animate-pulse rounded" />
            <div className="h-4 w-56 bg-muted animate-pulse rounded mt-1" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="!border-none shadow-sm">
              <CardContent className="pt-4">
                <div className="h-4 w-20 bg-muted animate-pulse rounded mb-2" />
                <div className="h-7 w-28 bg-muted animate-pulse rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card className="shadow-md !border-none">
          <CardContent className="p-4 space-y-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-12 w-full bg-muted animate-pulse rounded" />
            ))}
          </CardContent>
        </Card>
      </section>
    );
  }
  if (isError)
    return (
      <section className="container mx-auto py-8">
        <Card className="border-destructive/30">
          <CardContent className="flex flex-col gap-4 p-6">
            <div>
              <h1 className="text-xl font-semibold">Orders unavailable</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {error instanceof Error ? error.message : "Failed to load orders."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void refetch()}>
                Retry
              </Button>
              <Button variant="outline" onClick={() => queryClient.invalidateQueries({ queryKey: ["admin", "orders"] })}>
                Refresh cache
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    );
  if (!data)
    return (
      <p className="text-center mt-10 text-red-500">Failed to load orders.</p>
    );

  const activeFilterCount = [
    filter !== "ALL",
    deliveryFilter !== "ALL",
    paymentMethod !== "ALL",
    customerType !== "ALL",
    outstandingOnly,
    discountOnly,
    !!query,
    !!start,
    !!end,
    !!minTotal,
    !!maxTotal,
    !!userIdFilter,
    !!orderIdFilter,
    !!paymentIdFilter,
  ].filter(Boolean).length;
  const advancedFilterCount = [
    paymentMethod !== "ALL",
    customerType !== "ALL",
    outstandingOnly,
    discountOnly,
    !!minTotal,
    !!maxTotal,
    !!userIdFilter,
    !!orderIdFilter,
    !!paymentIdFilter,
  ].filter(Boolean).length;
  const resultsSummary = `${total.toLocaleString("en-GH")} matching order${total === 1 ? "" : "s"}`;

  const currentFilterState: OrdersSavedFilter["state"] = {
    filter,
    deliveryFilter,
    paymentMethod,
    customerType,
    outstandingOnly,
    discountOnly,
    query,
    start,
    end,
    minTotal,
    maxTotal,
    userIdFilter,
    orderIdFilter,
    paymentIdFilter,
    sortKey,
    sortDir,
    showPaid,
    showBalance,
    showDelivery,
    pageSize,
  };

  const persistSavedFilters = async (
    nextFilters: OrdersSavedFilter[],
    options?: {
      skipAudit?: boolean;
      auditAction?: string;
      resultSummary?: string;
    },
  ) => {
    const body = options?.skipAudit
      ? { key: ORDERS_SAVED_FILTERS_KEY, value: nextFilters, skipAudit: true }
      : {
          key: ORDERS_SAVED_FILTERS_KEY,
          value: nextFilters,
          sourcePage: "admin/orders",
          section: "saved-filters",
          auditAction: options?.auditAction || "ORDERS_FILTER_SAVE",
          resultSummary: options?.resultSummary || `Orders saved filters updated (${nextFilters.length} saved).`,
        };
    await fetchJsonOrThrow("/api/admin/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  const fetchOrdersForExport = async () => {
    if (selectedIds.size === 0) return sortedOrders;
    const response = await fetchJsonOrThrow<OrdersResponse>(
      `/api/orders?${buildOrdersQueryParams({
        filter: "ALL",
        deliveryFilter: "ALL",
        paymentMethod: "ALL",
        customerType: "ALL",
        outstandingOnly: false,
        discountOnly: false,
        query: "",
        start: "",
        end: "",
        minTotal: "",
        maxTotal: "",
        userIdFilter: "",
        orderIdFilter: "",
        paymentIdFilter: "",
        sortKey,
        sortDir,
        page,
        pageSize,
        ids: Array.from(selectedIds),
      }).toString()}`,
    );
    return Array.isArray(response.items) ? response.items : [];
  };

  const exportSelected = async () => {
    try {
      setExporting(true);
      const exportRows = await fetchOrdersForExport();
      const header = [
        "OrderId",
        "InvoiceNumber",
        "Customer",
        "Email",
        "Phone",
        "Status",
        "DeliveryStatus",
        "TaxableSubtotal",
        "Tax",
        "Total",
        "Discount",
        "Paid",
        "Balance",
        "PlacedAt",
        "UpdatedAt",
      ];
      const lines = [header.join(",")];
      for (const o of exportRows) {
        const customerName = o.user?.name || o.walkInName || "Walk-in";
        const customerEmail = o.user?.email || "";
        const customerPhone = o.user?.phone || o.walkInPhone || "";
        lines.push([
          JSON.stringify(o.id),
          JSON.stringify(o.invoiceNumber || ""),
          JSON.stringify(customerName),
          JSON.stringify(customerEmail),
          JSON.stringify(customerPhone),
          JSON.stringify(o.status || ""),
          JSON.stringify(o.deliveryStatus || ""),
          String(Number(o.subtotal || 0)),
          String(Number(o.taxAmount || 0)),
          String(Number(o.total || 0)),
          String(Number(o.discountAmount || 0)),
          String(Number(o.amountPaid || 0)),
          String(Number(o.balance || 0)),
          JSON.stringify(new Date(o.createdAt).toISOString()),
          JSON.stringify(new Date(o.updatedAt || o.createdAt).toISOString()),
        ].join(","));
      }
      const csv = lines.join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const filename = `orders_${Date.now()}.csv`;
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      void logAdminExportDownload({
        area: "orders",
        format: "CSV",
        fileName: filename,
        rowCount: exportRows.length,
        columnCount: header.length,
        byteSize: blob.size,
        sourcePage: "admin/orders",
        matchingCount: total,
        totalCount: total,
        sortKey: sortKey || "default",
        sortDir: sortKey ? sortDir : "default",
        resultSummary: `Orders CSV export downloaded (${exportRows.length} rows).`,
        scopeSnapshot: selectedIds.size > 0 ? "Selected orders export" : "Current page export",
      });
    } catch (exportError) {
      toast.error(exportError instanceof Error ? exportError.message : "Could not export orders.");
    } finally {
      setExporting(false);
    }
  };

  function toggleSort(key: "total" | "amountPaid" | "balance" | "createdAt" | "customer" | "invoice" | "delivery") {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setPage(1);
  }

    function sortIndicator(key: "total" | "amountPaid" | "balance" | "createdAt" | "customer" | "invoice" | "delivery") {
    const baseClass = "inline w-3 h-3 ml-1 align-middle";
    if (sortKey !== key) return <ArrowUpDown className={`${baseClass} text-muted-foreground`} />;
    return sortDir === "asc" ? (
      <ArrowUp className={baseClass} />
    ) : (
      <ArrowDown className={baseClass} />
    );
  }

  function formatStatus(status: string): string {
    switch (String(status || "").toUpperCase()) {
      case "UNPAID": return "Unpaid";
      case "PARTIALLY_PAID": return "Partially Paid";
      case "PAID": return "Paid";
      case "ON_HOLD_CREDIT": return "On Hold (Credit)";
      case "CANCELLED": return "Cancelled";
      case "NOT_DELIVERED": return "Not Delivered";
      case "PARTIALLY_DELIVERED": return "Partially Delivered";
      case "DELIVERED": return "Delivered";
      case "RETURNED": return "Returned";
      default: return status;
    }
  }

  function timeAgo(value: string | Date) {
    const d = value instanceof Date ? value : new Date(value);
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString("en-GH", { day: "numeric", month: "short", year: "numeric" });
  }

  function shortOrderId(id: string | undefined | null) {
    if (!id) return "";
    const full = formatIdReadable(id);
    const parts = full.split("-");
    return parts.slice(0, 2).join("-");
  }

  const sortedOrders = orders;
  const pageTotal = sortedOrders.reduce(
    (sum, o) => sum + Number(o.total || 0),
    0
  );

  const dateInputValue = (d: Date) => d.toISOString().slice(0, 10);

  function resetAllFilters() {
    setFilter("ALL");
    setDeliveryFilter("ALL");
    setPaymentMethod("ALL");
    setCustomerType("ALL");
    setOutstandingOnly(false);
    setDiscountOnly(false);
    setQuery("");
    setStart("");
    setEnd("");
    setMinTotal("");
    setMaxTotal("");
    setUserIdFilter("");
    setOrderIdFilter("");
    setPaymentIdFilter("");
    setShowAdvancedFilters(false);
  }

  async function copyOrderLink(orderId: string) {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(`${origin}/admin/orders/${orderId}`);
      toast.success("Link copied");
    } catch {
      toast.error("Unable to copy the order link.");
    }
  }

  function applySavedView(kind: "unpaid-not-delivered" | "last-7-days" | "delivered-7-days") {
    const now = new Date();
    resetAllFilters();
    if (kind === "unpaid-not-delivered") {
      setFilter("UNPAID");
      setDeliveryFilter("NOT_DELIVERED");
    } else if (kind === "last-7-days") {
      const endDate = dateInputValue(now);
      const startDate = dateInputValue(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
      setStart(startDate);
      setEnd(endDate);
    } else if (kind === "delivered-7-days") {
      const endDate = dateInputValue(now);
      const startDate = dateInputValue(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
      setDeliveryFilter("DELIVERED");
      setStart(startDate);
      setEnd(endDate);
    }
    setPage(1);
  }

  async function recordPayment(orderId: string) {
    const amount = Number(paymentAmount);
    if (!paymentAmount || !Number.isFinite(amount) || amount <= 0) {
      setPaymentError("Enter a valid amount.");
      return;
    }
    if (selectedOrder && amount > Number(selectedOrder.balance || 0)) {
      setPaymentError("Amount cannot exceed remaining balance.");
      return;
    }

    try {
      setRecordingPayment(true);
      setPaymentError("");
      const res = await fetch(`/api/orders/${orderId}/payment`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, method: paymentDialogMethod, note: paymentNote || undefined }),
      });

      if (!res.ok) {
        const j = await res
          .json()
          .catch(async () => ({ error: await res.text().catch(() => "") }));
        const msg = j?.error || "Failed to record payment";
        setPaymentError(msg);
        return;
      }
      toast.success(`Payment of ${formatCurrency(amount)} recorded.`);
      setPaymentAmount("");
      setPaymentNote("");
      setPaymentDialogMethod("cash");
      setIsDialogOpen(false);
      router.push(`/admin/orders/${orderId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to record payment";
      setPaymentError(msg);
    } finally {
      setRecordingPayment(false);
    }
  }

  async function refreshSelectedOrder(orderId: string) {
    const response = await fetchJsonOrThrow<OrdersResponse>(
      `/api/orders?${buildOrdersQueryParams({
        filter: "ALL",
        deliveryFilter: "ALL",
        paymentMethod: "ALL",
        customerType: "ALL",
        outstandingOnly: false,
        discountOnly: false,
        query: "",
        start: "",
        end: "",
        minTotal: "",
        maxTotal: "",
        userIdFilter: "",
        orderIdFilter: "",
        paymentIdFilter: "",
        sortKey: null,
        sortDir: "desc",
        page: 1,
        pageSize: 1,
        ids: [orderId],
      }).toString()}`,
    );
    const latestOrder = Array.isArray(response.items) ? response.items[0] : null;
    if (latestOrder) {
      setSelectedOrder(latestOrder);
    }
    return latestOrder;
  }

  async function applyStoreCredit() {
    if (!selectedUserId || !selectedOrder) return;
    try {
      setApplyingCredit(true);
      const res = await fetch(
        `/api/admin/customers/${selectedUserId}/credit/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      if (!res.ok) {
        const j = await res
          .json()
          .catch(async () => ({ error: await res.text().catch(() => "") }));
        const msg = j?.error || "Failed to apply store credit";
        throw new Error(msg);
      }
      const result = await res.json().catch(() => null);
      const applied = result?.applied ?? 0;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "orders"] }),
        queryClient.invalidateQueries({
          queryKey: ["admin", "customer-balance", selectedUserId],
        }),
      ]);
      const latestOrder = await refreshSelectedOrder(selectedOrder.id);
      if (latestOrder && paymentTab === "full") {
        setPaymentAmount(Number(latestOrder.balance || 0).toFixed(2));
      }
      if (applied > 0) {
        toast.success(
          `Applied ${formatCurrency(Number(applied))} in store credit across this customer's open orders.`,
        );
      } else {
        toast.info("No store credit available to apply.");
      }
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Error applying store credit.");
    } finally {
      setApplyingCredit(false);
    }
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
    const entry: OrdersSavedFilter = {
      id: `${Date.now()}`,
      name,
      state: currentFilterState,
    };
    const nextFilters = [entry, ...savedFilters];
    setSavedFilters(nextFilters);
    setSavingFilter(true);
    try {
      if (savedFiltersSource === "server") {
        await persistSavedFilters(nextFilters, {
          auditAction: "ORDERS_FILTER_SAVE",
          resultSummary: `Saved orders filter "${name}".`,
        });
      }
      setSaveFilterName("");
      setIsSaveFilterDialogOpen(false);
      toast.success("Saved filter");
    } catch (saveError) {
      setSavedFilters(savedFilters);
      toast.error(saveError instanceof Error ? saveError.message : "Could not save filter.");
    } finally {
      setSavingFilter(false);
    }
  };

  const applySavedFilter = (entry: OrdersSavedFilter) => {
    const s = entry.state;
    setFilter(s.filter);
    setDeliveryFilter(s.deliveryFilter);
    setPaymentMethod(s.paymentMethod);
    setCustomerType(s.customerType || "ALL");
    setOutstandingOnly(Boolean(s.outstandingOnly));
    setDiscountOnly(Boolean(s.discountOnly));
    setQuery(s.query);
    setStart(s.start);
    setEnd(s.end);
    setMinTotal(s.minTotal);
    setMaxTotal(s.maxTotal);
    setUserIdFilter(s.userIdFilter);
    setOrderIdFilter(s.orderIdFilter || "");
    setPaymentIdFilter(s.paymentIdFilter || "");
    setSortKey(s.sortKey);
    setSortDir(s.sortDir);
    setShowPaid(s.showPaid);
    setShowBalance(s.showBalance);
    setShowDelivery(s.showDelivery);
    setPageSize(s.pageSize);
    setShowAdvancedFilters(
      s.paymentMethod !== "ALL" ||
      s.customerType !== "ALL" ||
      Boolean(s.outstandingOnly) ||
      Boolean(s.discountOnly) ||
      Boolean(s.minTotal) ||
      Boolean(s.maxTotal) ||
      Boolean(s.userIdFilter) ||
      Boolean(s.orderIdFilter) ||
      Boolean(s.paymentIdFilter),
    );
    setPage(1);
    setIsSaveFilterDialogOpen(false);
    toast.success(`Applied "${entry.name}"`);
  };

  const removeSavedFilter = async (id: string) => {
    if (!savedFiltersLoaded) {
      toast.error("Saved filters are still loading.");
      return;
    }
    const nextFilters = savedFilters.filter((item) => item.id !== id);
    const removed = savedFilters.find((item) => item.id === id);
    setSavedFilters(nextFilters);
    setRemovingFilterId(id);
    try {
      if (savedFiltersSource === "server") {
        await persistSavedFilters(nextFilters, {
          auditAction: "ORDERS_FILTER_REMOVE",
          resultSummary: removed ? `Removed orders filter "${removed.name}".` : "Removed an orders filter.",
        });
      }
      toast.success("Removed saved filter");
    } catch (removeError) {
      setSavedFilters(savedFilters);
      toast.error(removeError instanceof Error ? removeError.message : "Could not remove saved filter.");
    } finally {
      setRemovingFilterId(null);
    }
  };

  return (
    <section className="orders-page container mx-auto py-8 space-y-6" data-slot="admin-page">
      <div className="orders-page-hero rounded-3xl border px-6 py-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/80">Operations</p>
              <h1 className="text-3xl font-semibold tracking-tight">Orders</h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Operational worklist for orders, collections, and delivery follow-up.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{resultsSummary}</Badge>
              {activeFilterCount > 0 ? (
                <Badge variant="outline">{activeFilterCount} active filter{activeFilterCount === 1 ? "" : "s"}</Badge>
              ) : null}
              {selectedCount > 0 ? (
                <Badge variant="outline">{selectedCount} selected</Badge>
              ) : null}
              {outstandingOnly ? (
                <div className="inline-flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  Collections mode: Outstanding only
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => {
                      setOutstandingOnly(false);
                      setPage(1);
                    }}
                  >
                    Show all
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            {isAdmin ? (
              <Button variant="outline" className="w-full border-white/60 bg-white/80 sm:w-auto" asChild>
                <Link href="/admin/audit?entityType=ORDER&sourcePage=admin/orders">
                  Orders Audit
                </Link>
              </Button>
            ) : null}
            <Button
              variant="outline"
              className="w-full border-white/60 bg-white/80 sm:w-auto"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["admin", "orders"] })}
            >
              <RefreshCcw className="w-4 h-4 mr-1" />
              {isFetching ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              variant="secondary"
              className="w-full bg-white text-foreground shadow-sm sm:w-auto"
              title={selectedCount > 0 ? `Export ${selectedCount} selected order(s)` : "Export current page orders"}
              onClick={() => void exportSelected()}
              disabled={exporting}
            >
              <Download className="w-4 h-4 mr-1" />
              {exporting ? "Exporting…" : selectedCount > 0 ? `Export ${selectedCount} Selected` : "Export Page"}
            </Button>
            <Button variant="outline" className="w-full border-white/60 bg-white/80 sm:w-auto" onClick={() => router.push("/admin/orders/otc")}>
              Walk-in Sale
            </Button>
            <Button className="w-full shadow-sm sm:w-auto" onClick={() => router.push("/admin/orders/new")}>
              Create Order
            </Button>
          </div>
        </div>
      </div>

      {/* KPI summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="orders-metric-card orders-metric-card-neutral !border-none shadow-sm">
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Matching Orders</p>
            <p className="text-2xl font-semibold mt-1">{total.toLocaleString("en-GH")}</p>
            <p className="mt-2 text-xs text-muted-foreground">Current result set after filters and search.</p>
          </CardContent>
        </Card>
        <Card className="orders-metric-card orders-metric-card-primary !border-none shadow-sm">
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Filtered Revenue</p>
            <p className="text-2xl font-semibold mt-1">{formatCurrency(Number(totals.total || 0))}</p>
            <p className="mt-2 text-xs text-muted-foreground">Invoice total across visible matching orders.</p>
          </CardContent>
        </Card>
        <Card className="orders-metric-card orders-metric-card-success !border-none shadow-sm">
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Filtered Collected</p>
            <p className="text-2xl font-semibold mt-1 text-green-700">{formatCurrency(Number(totals.paid || 0))}</p>
            <p className="mt-2 text-xs text-muted-foreground">Payments already captured against these orders.</p>
          </CardContent>
        </Card>
        <Card className="orders-metric-card orders-metric-card-warning !border-none shadow-sm">
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Filtered Outstanding</p>
            <p className={`text-2xl font-semibold mt-1 ${Number(totals.balance || 0) > 0 ? "text-amber-700" : "text-muted-foreground"}`}>
              {formatCurrency(Number(totals.balance || 0))}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">Open exposure still awaiting collection.</p>
          </CardContent>
        </Card>
      </div>

      {selectedCount > 0 && (
        <div className="orders-selection-bar mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">{selectedCount} selected</span>
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              Clear
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void exportSelected()} disabled={exporting}>
              <Download className="w-4 h-4 mr-1" />
              {exporting ? "Exporting…" : `Export ${selectedCount} Selected`}
            </Button>
          </div>
        </div>
      )}

      {/* Filters */}
      <Card className="orders-filters-card shadow-md !border-none mb-6">
        <CardHeader className="flex flex-col gap-3 space-y-0 py-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base font-semibold">Worklist Filters</CardTitle>
              {activeFilterCount > 0 ? (
                <Badge variant="secondary">{activeFilterCount} active</Badge>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              Keep primary filters visible and expand advanced controls only when needed.
            </p>
          </div>
          <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="w-full sm:w-auto">
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuCheckboxItem
                  checked={showPaid}
                  onCheckedChange={(v) => setShowPaid(Boolean(v))}
                >
                  Paid
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={showBalance}
                  onCheckedChange={(v) => setShowBalance(Boolean(v))}
                >
                  Balance
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={showDelivery}
                  onCheckedChange={(v) => setShowDelivery(Boolean(v))}
                >
                  Delivery
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => setIsSaveFilterDialogOpen(true)}
            >
              <Save className="mr-1 h-4 w-4" />
              Saved filters
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => setShowAdvancedFilters((prev) => !prev)}
            >
              <SlidersHorizontal className="mr-1 h-4 w-4" />
              {showAdvancedFilters ? "Hide advanced" : `Show advanced${advancedFilterCount > 0 ? ` (${advancedFilterCount})` : ""}`}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => { resetAllFilters(); setPage(1); }}
            >
              Clear all
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {orderIdFilter || paymentIdFilter ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <span className="font-medium">Exact lookup active:</span>{" "}
              {orderIdFilter ? `order or invoice ${orderIdFilter}` : `payment ${paymentIdFilter}`}{" "}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-1 h-6 px-2 text-[11px]"
                onClick={() => {
                  setOrderIdFilter("");
                  setPaymentIdFilter("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Filter className="h-4 w-4" />
              {resultsSummary}
            </span>
            {sortKey ? (
              <span className="text-muted-foreground">
                Sorted by {sortKey} {sortDir}
              </span>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div className="relative sm:col-span-2">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by customer, invoice, phone, or order ID"
                value={query}
                ref={searchRef}
                autoFocus
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                className="pl-9"
              />
            </div>
            <Select
              value={filter}
              onValueChange={(value) => {
                setFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="Filter orders by status">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                <SelectItem value="UNPAID">Unpaid</SelectItem>
                <SelectItem value="PARTIALLY_PAID">Partially Paid</SelectItem>
                <SelectItem value="ON_HOLD_CREDIT">On hold (credit)</SelectItem>
                <SelectItem value="PAID">Paid</SelectItem>
                <SelectItem value="CANCELLED">Cancelled</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={deliveryFilter}
              onValueChange={(value) => {
                setDeliveryFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="Filter orders by delivery status">
                <SelectValue placeholder="Filter by delivery" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All deliveries</SelectItem>
                <SelectItem value="NOT_DELIVERED">Not Delivered</SelectItem>
                <SelectItem value="PARTIALLY_DELIVERED">Partially Delivered</SelectItem>
                <SelectItem value="DELIVERED">Delivered</SelectItem>
                <SelectItem value="RETURNED">Returned</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex flex-col gap-1">
              <label htmlFor="orders-start-date" className="text-xs text-muted-foreground">From date</label>
              <Input
                id="orders-start-date"
                type="date"
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="orders-end-date" className="text-xs text-muted-foreground">To date</label>
              <Input
                id="orders-end-date"
                type="date"
                value={end}
                onChange={(e) => {
                  setEnd(e.target.value);
                  setPage(1);
                }}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Quick views:</span>
            <Button
              variant={outstandingOnly ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setOutstandingOnly((prev) => !prev);
                setShowAdvancedFilters(true);
                setPage(1);
              }}
            >
              Outstanding only
            </Button>
            <Button
              variant={discountOnly ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setDiscountOnly((prev) => !prev);
                setShowAdvancedFilters(true);
                setPage(1);
              }}
            >
              Discounted only
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => applySavedView("unpaid-not-delivered")}
            >
              Unpaid &amp; not delivered
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => applySavedView("last-7-days")}
            >
              Last 7 days
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => applySavedView("delivered-7-days")}
            >
              Delivered (7 days)
            </Button>
          </div>
          {showAdvancedFilters ? (
            <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium">Advanced filters</p>
                  <p className="text-xs text-muted-foreground">
                    Use exact lookups and finance-specific filters without crowding the main worklist.
                  </p>
                </div>
                {advancedFilterCount > 0 ? (
                  <Badge variant="outline">{advancedFilterCount} advanced filter{advancedFilterCount === 1 ? "" : "s"}</Badge>
                ) : null}
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <Select
                  value={paymentMethod}
                  onValueChange={(value) => {
                    setPaymentMethod(value);
                    setPage(1);
                  }}
                >
                  <SelectTrigger aria-label="Filter orders by payment method">
                    <SelectValue placeholder="Payment method" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All methods</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="card">Card</SelectItem>
                    <SelectItem value="momo">MoMo</SelectItem>
                    <SelectItem value="transfer">Transfer</SelectItem>
                    <SelectItem value="adjustment">Adjustment</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={customerType}
                  onValueChange={(value) => {
                    setCustomerType(value);
                    setPage(1);
                  }}
                >
                  <SelectTrigger aria-label="Filter orders by customer type">
                    <SelectValue placeholder="Customer type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All customers</SelectItem>
                    <SelectItem value="REGISTERED">Registered</SelectItem>
                    <SelectItem value="WALK_IN">Walk-in</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex flex-col gap-1">
                  <label htmlFor="orders-customer-id" className="text-xs text-muted-foreground">Customer ID</label>
                  <Input
                    id="orders-customer-id"
                    placeholder="Exact customer ID"
                    value={userIdFilter}
                    onChange={(e) => {
                      setUserIdFilter(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="orders-order-id" className="text-xs text-muted-foreground">Order or invoice</label>
                  <Input
                    id="orders-order-id"
                    placeholder="INV-1001 or order ID"
                    value={orderIdFilter}
                    onChange={(e) => {
                      setOrderIdFilter(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="orders-payment-id" className="text-xs text-muted-foreground">Payment ID</label>
                  <Input
                    id="orders-payment-id"
                    placeholder="Exact payment ID"
                    value={paymentIdFilter}
                    onChange={(e) => {
                      setPaymentIdFilter(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="orders-min-total" className="text-xs text-muted-foreground">Min total (GHS)</label>
                  <Input
                    id="orders-min-total"
                    type="number"
                    placeholder="0"
                    value={minTotal}
                    onChange={(e) => {
                      setMinTotal(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="orders-max-total" className="text-xs text-muted-foreground">Max total (GHS)</label>
                  <Input
                    id="orders-max-total"
                    type="number"
                    placeholder="Any"
                    value={maxTotal}
                    onChange={(e) => {
                      setMaxTotal(e.target.value);
                      setPage(1);
                    }}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Orders Table */}
      {sortedOrders.length === 0 ? (
        <div className="orders-empty-state mt-10 rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Search className="h-5 w-5" />
          </div>
          <p className="text-base font-medium text-foreground">No orders found for the current filters.</p>
          <p className="mt-1">Try widening the date range, clearing exact lookups, or starting a new order.</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => { resetAllFilters(); setPage(1); }}
            >
              Clear filters
            </Button>
            <Button size="sm" onClick={() => router.push("/admin/orders/new")}>
              Create order
            </Button>
          </div>
        </div>
      ) : (
        <Card className="orders-list-card shadow-md !border-none">
          <CardHeader className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base font-semibold">Orders</CardTitle>
              <p className="text-xs text-muted-foreground">
                {sortedOrders.length} shown on this page{isFetching ? " · syncing latest data" : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">Page total {formatCurrency(pageTotal)}</Badge>
              <Badge variant="outline">Balance {formatCurrency(Number(totals.balance || 0))}</Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
        <Table className="hidden lg:table w-full table-fixed min-w-[1200px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[36px] relative" style={{ width: columnWidths.select }}>
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAllVisible}
                  aria-label="Select all visible orders"
                />
                <div
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                  onMouseDown={(event) => startResize("select", event)}
                />
              </TableHead>
              <TableHead className="relative" style={{ width: columnWidths.order }}>
                Order / Invoice
                <div
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                  onMouseDown={(event) => startResize("order", event)}
                />
              </TableHead>
              <TableHead
                role="button"
                aria-label="Sort by customer"
                className="cursor-pointer select-none relative"
                style={{ width: columnWidths.customer }}
                onClick={() => toggleSort("customer")}
              >
                Customer{sortIndicator("customer")}
                <div
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                  onMouseDown={(event) => startResize("customer", event)}
                />
              </TableHead>
              <TableHead
                role="button"
                aria-label="Sort by placed date"
                className="cursor-pointer select-none relative"
                style={{ width: columnWidths.placed }}
                onClick={() => toggleSort("createdAt")}
              >
                <div className="inline-flex items-center gap-1">
                  <span>Placed{sortIndicator("createdAt")}</span>
                  <Tooltip content="Updated time shown on hover">
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
                  </Tooltip>
                </div>
                <div
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                  onMouseDown={(event) => startResize("placed", event)}
                />
              </TableHead>
              <TableHead
                className="select-none relative"
                style={{ width: columnWidths.status }}
              >
                <div className="inline-flex items-center gap-1">
                  <span>Status</span>
                  {filter !== "ALL" ? (
                    <span className="text-[11px] text-muted-foreground">({formatStatus(filter)})</span>
                  ) : null}
                </div>
                <div
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                  onMouseDown={(event) => startResize("status", event)}
                />
              </TableHead>
              <TableHead
                role="button"
                aria-label="Sort by total"
                className="text-right cursor-pointer select-none relative"
                style={{ width: columnWidths.total }}
                onClick={() => toggleSort("total")}
              >
                <div className="inline-flex items-center justify-end gap-1 w-full">
                  <span>Total{sortIndicator("total")}</span>
                  <Tooltip content="Order total">
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Order total" />
                  </Tooltip>
                </div>
                <div
                  className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                  onMouseDown={(event) => startResize("total", event)}
                />
              </TableHead>
              {showPaid ? (
                <TableHead
                  role="button"
                  aria-label="Sort by paid"
                  className="text-right cursor-pointer select-none relative"
                  style={{ width: columnWidths.paid }}
                  onClick={() => toggleSort("amountPaid")}
                >
                  <div className="inline-flex items-center justify-end gap-1 w-full">
                    <span>Paid{sortIndicator("amountPaid")}</span>
                    <Tooltip content="Amount paid on order">
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Paid total" />
                    </Tooltip>
                  </div>
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("paid", event)}
                  />
                </TableHead>
              ) : null}
              {showBalance ? (
                <TableHead
                  role="button"
                  aria-label="Sort by balance"
                  className="text-right cursor-pointer select-none relative"
                  style={{ width: columnWidths.balance }}
                  onClick={() => toggleSort("balance")}
                >
                  <div className="inline-flex items-center justify-end gap-1 w-full">
                    <span>Balance{sortIndicator("balance")}</span>
                    <Tooltip content="Outstanding = Total - Paid">
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Balance" />
                    </Tooltip>
                  </div>
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("balance", event)}
                  />
                </TableHead>
              ) : null}
              {showDelivery ? (
                <TableHead
                  role="button"
                  aria-label="Sort by delivery status"
                  className="text-left cursor-pointer select-none relative"
                  style={{ width: columnWidths.delivery }}
                  onClick={() => toggleSort("delivery")}
                >
                  <div className="inline-flex items-center gap-1">
                    <span>Delivery{sortIndicator("delivery")}</span>
                  </div>
                  <div
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize"
                    onMouseDown={(event) => startResize("delivery", event)}
                  />
                </TableHead>
              ) : null}
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
            {sortedOrders.map((order) => {
              const delivery = order.deliveryStatus || "NOT_DELIVERED";
              return (
                <TableRow key={order.id}>
                  <TableCell style={{ width: getColWidth("select") }}>
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selectedIds.has(order.id)}
                      onChange={() => toggleSelected(order.id)}
                      aria-label={`Select ${order.id}`}
                    />
                  </TableCell>
                  <TableCell style={{ width: getColWidth("order") }}>
                    <div className="min-w-0">
                      <Link href={`/admin/orders/${order.id}`} className="block truncate hover:underline">
                        {shortOrderId(order.id)}
                      </Link>
                      {order.invoiceNumber ? (
                        <div className="text-[11px] text-muted-foreground truncate">
                          {formatInvoiceNumber(order.invoiceNumber)
                            ? `INV: ${formatInvoiceNumber(order.invoiceNumber)}`
                            : ""}
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell style={{ width: getColWidth("customer") }}>
                    {order.user ? (
                      <div className="min-w-0 space-y-0.5">
                        <div className="truncate">
                          {order.user?.name || order.user?.email || "Unknown"}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {order.user?.phone || order.user?.email || ""}
                        </div>
                      </div>
                    ) : (
                      <div className="min-w-0 space-y-0.5">
                        <div className="truncate">
                          {order.walkInName || "Walk-in"}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {order.walkInPhone || "OTC sale"}
                        </div>
                      </div>
                    )}
                  </TableCell>
                  <TableCell
                    style={{ width: getColWidth("placed") }}
                    title={`Placed: ${new Date(order.createdAt).toLocaleString()}\nUpdated: ${new Date(order.updatedAt || order.createdAt).toLocaleString()}`}
                  >
                    <span className="block truncate">{timeAgo(order.createdAt)}</span>
                  </TableCell>
                  <TableCell style={{ width: getColWidth("status") }}>
                    <div className="flex flex-col gap-1">
                      <span className={`text-xs px-2 py-1 rounded-full ${chipToneClass(orderStatusTone(order.status))}`}>
                        {formatStatus(order.status)}
                      </span>
                      {Boolean(order.hasPendingMomo) ? (
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${chipToneClass("warning")}`}>
                          MoMo pending
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right" style={{ width: getColWidth("total") }}>
                    <div className="space-y-0.5">
                      <div>{formatCurrency(Number(order.total || 0))}</div>
                      {Number(order.discountAmount || 0) > 0 ? (
                        <div className="text-[11px] text-amber-700">
                          Discount: -{formatCurrency(Number(order.discountAmount || 0))}
                        </div>
                      ) : null}
                    </div>
                  </TableCell>
                  {showPaid ? (
                    <TableCell className="text-right" style={{ width: getColWidth("paid") }}>
                      {formatCurrency(Number(order.amountPaid || 0))}
                    </TableCell>
                  ) : null}
                  {showBalance ? (
                    <TableCell className="text-right" style={{ width: getColWidth("balance") }}>
                      {formatCurrency(Number(order.balance || 0))}
                    </TableCell>
                  ) : null}
                  {showDelivery ? (
                    <TableCell style={{ width: getColWidth("delivery") }}>
                      <span className={`text-xs px-2 py-1 rounded-full ${chipToneClass(deliveryStatusTone(delivery))}`}>
                        {formatStatus(delivery)}
                      </span>
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right overflow-visible" style={{ width: getColWidth("actions") }}>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Link href={`/admin/orders/${order.id}`}>
                        <Button size="sm" variant="outline">View Details</Button>
                      </Link>
                      {isAdmin ? (
                        <Link href={`/admin/audit?entityType=ORDER&entityId=${order.id}&sourcePage=admin/orders`}>
                          <Button size="sm" variant="outline">Audit</Button>
                        </Link>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedOrder(order);
                          setPaymentAmount("");
                          setPaymentNote("");
                          setPaymentTab("custom");
                          setPaymentDialogMethod("cash");
                          setIsDialogOpen(true);
                        }}
                        disabled={order.status === "PAID" || order.status === "CANCELLED"}
                      >
                        <DollarSign className="w-4 h-4 mr-1" />
                        Add Payment
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div className="lg:hidden space-y-4 p-2">
          {sortedOrders.map((order) => {
            const delivery = order.deliveryStatus || "NOT_DELIVERED";
            const statusClass = chipToneClass(orderStatusTone(order.status));
            const deliveryClass = chipToneClass(deliveryStatusTone(delivery));

            return (
              <div key={order.id} className="rounded-lg border p-4 space-y-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4 mt-1"
                    checked={selectedIds.has(order.id)}
                    onChange={() => toggleSelected(order.id)}
                    aria-label={`Select ${order.id}`}
                  />
                  <div>
                    <p className="font-semibold break-all">
                      {shortOrderId(order.id)}
                    </p>
                    {order.invoiceNumber ? (
                      <p className="text-[11px] text-muted-foreground">
                        {formatInvoiceNumber(order.invoiceNumber)
                          ? `INV: ${formatInvoiceNumber(order.invoiceNumber)}`
                          : ""}
                      </p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {order.user?.name || order.walkInName || "Walk-in"}
                    </p>
                    <p className="text-xs text-muted-foreground break-all">
                      {order.user?.phone || order.user?.email || order.walkInPhone || "—"}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">{timeAgo(order.createdAt)}</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Status</p>
                    <div className="flex flex-col gap-1">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${statusClass}`}>
                        {formatStatus(order.status)}
                      </span>
                      {Boolean(order.hasPendingMomo) ? (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${chipToneClass("warning")}`}>
                          MoMo pending
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {showDelivery ? (
                    <div>
                      <p className="text-xs uppercase text-muted-foreground">Delivery</p>
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${deliveryClass}`}>
                        {formatStatus(delivery)}
                      </span>
                    </div>
                  ) : null}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Total</p>
                    <p className="font-mono">
                      {formatCurrency(Number(order.total || 0))}
                    </p>
                    {Number(order.discountAmount || 0) > 0 ? (
                      <p className="text-[11px] text-amber-700">
                        Discount: -{formatCurrency(Number(order.discountAmount || 0))}
                      </p>
                    ) : null}
                  </div>
                  {showPaid ? (
                    <div>
                      <p className="text-xs uppercase text-muted-foreground">Paid</p>
                      <p className="font-mono">
                        {formatCurrency(Number(order.amountPaid || 0))}
                      </p>
                    </div>
                  ) : null}
                  {showBalance ? (
                    <div>
                      <p className="text-xs uppercase text-muted-foreground">Balance</p>
                      <p className="font-mono">
                        {formatCurrency(Number(order.balance || 0))}
                      </p>
                    </div>
                  ) : null}
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Contact</p>
                    <p>{order.user?.phone || "—"}</p>
                  </div>
                </div>

                {order.adminNote ? (
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Notes</p>
                    <p className="text-sm">{order.adminNote}</p>
                  </div>
                ) : null}

                <div className="border-t pt-2 mt-1 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                  <div className="flex flex-col">
                    <span className="font-medium">Order placed</span>
                    <span>{formatDateGH(order.createdAt)}</span>
                  </div>
                  <div className="flex flex-col text-right">
                    <span className="font-medium">Updated</span>
                    <span>{formatDateGH(order.updatedAt || order.createdAt)}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="font-medium">Delivery</span>
                    <span>
                      {(() => {
                        const deliveredAt =
                          (order as { deliveredAt?: string | Date | null })
                            .deliveredAt ?? null;
                        if (delivery === "DELIVERED" && deliveredAt) {
                          return `Delivered on ${formatDateGH(deliveredAt)}`;
                        }
                        return formatStatus(delivery);
                      })()}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" asChild className="w-full sm:flex-1 sm:min-w-[120px]">
                    <Link href={`/admin/orders/${order.id}`}>View Details</Link>
                  </Button>
                  {isAdmin ? (
                    <Button variant="outline" size="sm" asChild className="w-full sm:flex-1 sm:min-w-[120px]">
                      <Link href={`/admin/audit?entityType=ORDER&entityId=${order.id}&sourcePage=admin/orders`}>Audit</Link>
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:flex-1 sm:min-w-[120px]"
                    onClick={() => {
                      setSelectedOrder(order);
                      setPaymentAmount("");
                      setPaymentNote("");
                      setPaymentTab("custom");
                      setPaymentDialogMethod("cash");
                      setIsDialogOpen(true);
                    }}
                    disabled={order.status === "PAID" || order.status === "CANCELLED"}
                  >
                    <DollarSign className="w-4 h-4 mr-1" />
                    Add Payment
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full sm:flex-1 sm:min-w-[120px]"
                    onClick={() => {
                      void copyOrderLink(order.id);
                    }}
                  >
                    Copy Link
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mt-4 flex flex-col gap-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <span>
            Page {page} of {totalPages} ({total} order{total === 1 ? "" : "s"})
          </span>
          <span className="text-xs">
            Page total: {formatCurrency(pageTotal)}
          </span>
          <span className="text-xs">
            Filtered paid: {formatCurrency(Number(totals.paid || 0))}
          </span>
          <span className="text-xs">
            Filtered balance: {formatCurrency(Number(totals.balance || 0))}
          </span>
          <div className="flex items-center gap-1">
            <span>Rows per page:</span>
            <select
              aria-label="Rows per page"
              className="h-7 rounded border bg-background px-1 text-xs"
              value={pageSize}
              onChange={(e) => {
                const next = Number(e.target.value) || 25;
                setPageSize(next);
                setPage(1);
              }}
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
          <div className="flex items-center gap-1">
            <span>Go to page:</span>
            <Input
              type="number"
              aria-label="Go to page"
              min={1}
              max={totalPages}
              value={page}
              onChange={(e) => {
                const next = Number(e.target.value) || 1;
                setPage(Math.max(1, Math.min(totalPages, next)));
              }}
              className="h-7 w-16 px-2 text-xs"
            />
          </div>
        </div>
        <Pagination aria-label="Orders pagination" className="sm:mt-0">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (page > 1) setPage(page - 1);
                }}
              />
            </PaginationItem>
            {totalPages > 1 && (
              <>
                <PaginationItem>
                  <PaginationLink
                    href="#"
                    isActive={page === 1}
                    onClick={(e) => {
                      e.preventDefault();
                      setPage(1);
                    }}
                  >
                    1
                  </PaginationLink>
                </PaginationItem>
                {page > 3 && (
                  <PaginationItem>
                    <span className="px-2">…</span>
                  </PaginationItem>
                )}
                {Array.from({ length: Math.min(3, totalPages) }, (_, i) => {
                  const start = Math.max(2, page - 1);
                  const p = start + i;
                  if (p >= totalPages) return null;
                  return (
                    <PaginationItem key={p}>
                      <PaginationLink
                        href="#"
                        isActive={page === p}
                        onClick={(e) => {
                          e.preventDefault();
                          setPage(p);
                        }}
                      >
                        {p}
                      </PaginationLink>
                    </PaginationItem>
                  );
                })}
                {page < totalPages - 2 && (
                  <PaginationItem>
                    <span className="px-2">…</span>
                  </PaginationItem>
                )}
                {totalPages > 1 && (
                  <PaginationItem>
                    <PaginationLink
                      href="#"
                      isActive={page === totalPages}
                      onClick={(e) => {
                        e.preventDefault();
                        setPage(totalPages);
                      }}
                    >
                      {totalPages}
                    </PaginationLink>
                  </PaginationItem>
                )}
              </>
            )}
            <PaginationItem>
              <PaginationNext
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (page < totalPages) setPage(page + 1);
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>

      <Dialog open={isSaveFilterDialogOpen} onOpenChange={setIsSaveFilterDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Saved filters</DialogTitle>
            <DialogDescription>
              {savedFiltersSource === "server"
                ? "Saved to your account and available across devices."
                : savedFiltersSource === "local"
                  ? "Saved in this browser only. Server sync is unavailable right now."
                  : "Loading saved filters..."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border p-4 space-y-3">
              <div>
                <p className="text-sm font-medium">Save current filter set</p>
                <p className="text-xs text-muted-foreground">
                  Capture the current filter, sort, and visible column settings.
                </p>
              </div>
              <Input
                value={saveFilterName}
                placeholder="e.g. Collections queue"
                onChange={(e) => setSaveFilterName(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void saveCurrentFilter();
                  }
                }}
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsSaveFilterDialogOpen(false)}>
                  Close
                </Button>
                <Button onClick={() => void saveCurrentFilter()} disabled={savingFilter || !savedFiltersLoaded}>
                  {savingFilter ? "Saving…" : "Save current filter"}
                </Button>
              </DialogFooter>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Available filters</p>
                <span className="text-xs text-muted-foreground">
                  {savedFiltersLoaded ? `${savedFilters.length} saved` : "Loading..."}
                </span>
              </div>
              {!savedFiltersLoaded ? (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  Loading saved filters...
                </div>
              ) : savedFilters.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  No saved filters yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {savedFilters.map((entry) => (
                    <div key={entry.id} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-medium">{entry.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Status: {entry.state.filter === "ALL" ? "All" : formatStatus(entry.state.filter)}
                          {" · "}
                          Delivery: {entry.state.deliveryFilter === "ALL" ? "All" : formatStatus(entry.state.deliveryFilter)}
                          {" · "}
                          Sort: {entry.state.sortKey ? `${entry.state.sortKey} ${entry.state.sortDir}` : "default"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" size="sm" onClick={() => applySavedFilter(entry)}>
                          Apply
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void removeSavedFilter(entry.id)}
                          disabled={removingFilterId === entry.id}
                        >
                          {removingFilterId === entry.id ? "Removing…" : "Remove"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Payment Modal */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto overflow-x-hidden sm:max-h-none">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Add Payment</DialogTitle>
          </DialogHeader>

          {selectedOrder && (
            <div className="space-y-4 mt-4">
              <div className="grid gap-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Order ID</span>
                  <span className="font-mono">{selectedOrder.id.slice(0, 8)}…</span>
                </div>
                {selectedOrder.invoiceNumber ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Invoice</span>
                    <span className="font-mono">{selectedOrder.invoiceNumber}</span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-mono">{formatCurrency(Number(selectedOrder.total || 0))}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Already Paid</span>
                  <span className="font-mono">{formatCurrency(Number(selectedOrder.amountPaid || 0))}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Remaining Balance</span>
                  <span className="font-mono">{formatCurrency(Number(selectedOrder.balance || 0))}</span>
                </div>
              </div>

              {selectedUserId && (
                <div className="rounded-md bg-muted px-3 py-2 text-sm space-y-1">
                  <p className="font-medium">
                    Store credit for this customer
                  </p>
                  <p>
                    {isSummaryLoading && "Checking store credit…"}
                    {!isSummaryLoading && accountSummary && (
                      <>
                        Available store credit:{" "}
                        <span className="font-mono">
                          {formatCurrency(
                            Number(accountSummary.storeCredit || 0),
                          )}
                        </span>
                      </>
                    )}
                    {!isSummaryLoading &&
                      !accountSummary &&
                      "Unable to load store credit right now."}
                  </p>
                  {accountSummary && accountSummary.storeCredit > 0 && (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-muted-foreground">
                        Applying store credit will reduce this customer&rsquo;s
                        outstanding balances across all open orders
                        (oldest first), including this one.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={applyStoreCredit}
                        disabled={applyingCredit}
                      >
                        {applyingCredit ? "Applying…" : "Apply store credit"}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">Amount Mode</span>
                <div className="flex flex-wrap gap-2" role="tablist" aria-label="Payment amount mode">
                  <Button
                    type="button"
                    size="sm"
                    variant={paymentTab === "custom" ? "default" : "outline"}
                    role="tab"
                    aria-selected={paymentTab === "custom"}
                    onClick={() => setPaymentTab("custom")}
                    className="w-full sm:w-auto"
                  >
                    Custom
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={paymentTab === "full" ? "default" : "outline"}
                    role="tab"
                    aria-selected={paymentTab === "full"}
                    onClick={() => {
                      setPaymentTab("full");
                      const amt = Number(selectedOrder.balance || 0);
                      setPaymentAmount(amt.toFixed(2));
                      setPaymentError("");
                    }}
                    className="w-full sm:w-auto"
                  >
                    Pay Full ({formatCurrency(Number(selectedOrder.balance || 0))})
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">Payment Method</span>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Payment method">
                  {(["cash", "momo", "transfer", "card"] as const).map((m) => (
                    <Button
                      key={m}
                      type="button"
                      size="sm"
                      variant={paymentDialogMethod === m ? "default" : "outline"}
                      onClick={() => setPaymentDialogMethod(m)}
                      className="w-full sm:w-auto capitalize"
                    >
                      {m === "momo" ? "MoMo" : m === "transfer" ? "Transfer" : m === "card" ? "Card" : "Cash"}
                    </Button>
                  ))}
                </div>
              </div>

              <Input
                type="number"
                aria-label="Payment amount"
                placeholder="Enter payment amount"
                value={paymentAmount}
                onChange={(e) => {
                  setPaymentAmount(e.target.value);
                  if (paymentError) setPaymentError("");
                }}
                aria-invalid={!!paymentError}
                className={paymentError ? "border-red-500" : ""}
              />
              {paymentError && <p className="text-xs text-red-600">{paymentError}</p>}

              <Textarea
                aria-label="Payment note"
                placeholder="Optional note (e.g., cash received by admin)"
                value={paymentNote}
                onChange={(e) => setPaymentNote(e.target.value)}
              />

              <div className="flex justify-end gap-2 mt-4">
                <Button
                  variant="outline"
                  onClick={() => setIsDialogOpen(false)}
                  disabled={recordingPayment}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => recordPayment(selectedOrder.id)}
                  disabled={!paymentAmount || recordingPayment}
                >
                  {recordingPayment ? "Recording…" : "Confirm Payment"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default function AdminOrdersPage() {
  return (
    <Suspense
      fallback={
        <section className="container mx-auto py-8">
          <h1 className="text-2xl font-semibold mb-2">Orders</h1>
          <p className="text-sm text-muted-foreground">Loading orders…</p>
        </section>
      }
    >
      <AdminOrdersContent />
    </Suspense>
  );
}
