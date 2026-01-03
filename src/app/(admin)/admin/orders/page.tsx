"use client";

export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency, formatDateGH } from "@/lib/currency";
import { formatIdReadable, formatInvoiceNumber } from "@/lib/utils";
import { chipToneClass, deliveryStatusTone, orderStatusTone } from "@/lib/status-chips";
import { Download, RefreshCcw, Search, DollarSign, ArrowUpDown, ArrowUp, ArrowDown, HelpCircle } from "lucide-react";
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
  total: number | string;
  amountPaid: number | string;
  balance: number | string;
  userId?: string | null;
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
    query: string;
    start: string;
    end: string;
    minTotal: string;
    maxTotal: string;
    userIdFilter: string;
    sortKey: "total" | "amountPaid" | "balance" | "createdAt" | "customer" | "invoice" | null;
    sortDir: "asc" | "desc";
    showPaid: boolean;
    showBalance: boolean;
    showDelivery: boolean;
    pageSize: number;
  };
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function AdminOrdersContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [filter, setFilter] = useState<string>("ALL");
  const [deliveryFilter, setDeliveryFilter] = useState<string>("ALL");
  const [query, setQuery] = useState<string>("");
  const [paymentMethod, setPaymentMethod] = useState<string>("ALL");
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
  const [paymentTab, setPaymentTab] = useState<"custom" | "full">("custom");
  const [applyingCredit, setApplyingCredit] = useState(false);
  const [sortKey, setSortKey] = useState<
    | "total"
    | "amountPaid"
    | "balance"
    | "createdAt"
      | "customer"
      | "invoice"
      | null
  >("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const initialized = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [showPaid, setShowPaid] = useState(true);
  const [showBalance, setShowBalance] = useState(true);
  const [showDelivery, setShowDelivery] = useState(true);
  const [userIdFilter, setUserIdFilter] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedOrders, setSelectedOrders] = useState<Map<string, AdminOrder>>(new Map());
  const [savedFilters, setSavedFilters] = useState<OrdersSavedFilter[]>([]);
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
    const userIdParam = searchParams.get("userId");
    const sk = searchParams.get("sortKey") as
      | "total"
      | "amountPaid"
      | "balance"
      | "createdAt"
      | "customer"
      | "invoice"
      | null;
    const sd = searchParams.get("sortDir") as "asc" | "desc" | null;
    const p = Number(searchParams.get("page") || 1);
    const ps = Number(searchParams.get("pageSize") || 25);

    if (f && ["ALL", "UNPAID", "PARTIALLY_PAID", "PAID", "CANCELLED"].includes(f)) setFilter(f);
    if (typeof q === "string") setQuery(q);
    if (startParam) setStart(startParam);
    if (endParam) setEnd(endParam);
    if (minParam) setMinTotal(minParam);
    if (maxParam) setMaxTotal(maxParam);
    if (methodParam) setPaymentMethod(methodParam);
    if (userIdParam) setUserIdFilter(userIdParam);
    if (sk && ["total", "amountPaid", "balance", "createdAt", "customer", "invoice"].includes(sk)) setSortKey(sk);
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
    initialized.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("admin-orders-saved-filters");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as OrdersSavedFilter[];
      if (Array.isArray(parsed)) setSavedFilters(parsed);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      "admin-orders-saved-filters",
      JSON.stringify(savedFilters),
    );
  }, [savedFilters]);

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
  }, [filter, query, sortKey, sortDir, deliveryFilter, paymentMethod, start, end, minTotal, maxTotal, userIdFilter, page, pageSize, pathname, router]);

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
  const { data, isLoading } = useClientQuery({
    queryKey: ["admin", "orders", { filter, deliveryFilter, paymentMethod, query, start, end, minTotal, maxTotal, userIdFilter, sortKey, sortDir, page, pageSize }],
    // Admin dashboard should see all orders, not just the logged-in user's.
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("all", "1");
      if (filter && filter !== "ALL") params.set("filter", filter);
      if (deliveryFilter && deliveryFilter !== "ALL") params.set("dFilter", deliveryFilter);
      if (paymentMethod && paymentMethod !== "ALL") params.set("paymentMethod", paymentMethod);
      if (query) params.set("q", query);
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      if (minTotal) params.set("minTotal", minTotal);
      if (maxTotal) params.set("maxTotal", maxTotal);
      if (userIdFilter) params.set("userId", userIdFilter);
      if (sortKey) params.set("sortKey", sortKey);
      if (sortKey) params.set("sortDir", sortDir);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      return fetcher(`/api/orders?${params.toString()}`);
    },
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
      fetcher(`/api/admin/customers/${selectedUserId}/balance`),
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
    setSelectedOrders((prev) => {
      const next = new Map(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      const order = orders.find((o) => o.id === id);
      if (order) next.set(id, order);
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
    setSelectedOrders((prev) => {
      const next = new Map(prev);
      if (allVisibleSelected) {
        visibleIds.forEach((id) => next.delete(id));
        return next;
      }
      orders.forEach((o) => next.set(o.id, o));
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelectedOrders(new Map());
  };

  useEffect(() => {
    setSelectedOrders((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const order of orders) {
        if (selectedIds.has(order.id)) {
          next.set(order.id, order);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [orders, selectedIds]);

  if (isLoading) return <p className="text-center mt-10">Loading orders...</p>;
  if (!data)
    return (
      <p className="text-center mt-10 text-red-500">Failed to load orders.</p>
    );

  const exportSelected = () => {
    const selected = Array.from(selectedIds)
      .map((id) => selectedOrders.get(id))
      .filter(Boolean) as AdminOrder[];
    if (selected.length === 0) {
      toast.error("Select at least one order to export.");
      return;
    }
    const header = [
      "OrderId",
      "InvoiceNumber",
      "Customer",
      "Email",
      "Phone",
      "Status",
      "DeliveryStatus",
      "Total",
      "Paid",
      "Balance",
      "PlacedAt",
      "UpdatedAt",
    ];
    const lines = [header.join(",")];
    for (const o of selected) {
      lines.push([
        JSON.stringify(o.id),
        JSON.stringify(o.invoiceNumber || ""),
        JSON.stringify(o.user?.name || ""),
        JSON.stringify(o.user?.email || ""),
        JSON.stringify(o.user?.phone || ""),
        JSON.stringify(o.status || ""),
        JSON.stringify(o.deliveryStatus || ""),
        String(Number(o.total || 0)),
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
    a.href = url;
    a.download = `orders_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  function toggleSort(key: "total" | "amountPaid" | "balance" | "createdAt" | "customer" | "invoice") {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setPage(1);
  }

    function sortIndicator(key: "total" | "amountPaid" | "balance" | "createdAt" | "customer" | "invoice") {
    const baseClass = "inline w-3 h-3 ml-1 align-middle";
    if (sortKey !== key) return <ArrowUpDown className={`${baseClass} text-muted-foreground`} />;
    return sortDir === "asc" ? (
      <ArrowUp className={baseClass} />
    ) : (
      <ArrowDown className={baseClass} />
    );
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
    return d.toLocaleDateString();
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

  function applySavedView(kind: "unpaid-not-delivered" | "last-7-days" | "delivered-7-days") {
    const now = new Date();
    if (kind === "unpaid-not-delivered") {
      setFilter("UNPAID");
      setDeliveryFilter("NOT_DELIVERED");
      setStart("");
      setEnd("");
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
      setPaymentError("");
      const res = await fetch(`/api/orders/${orderId}/payment`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, note: paymentNote || undefined }),
      });

      if (!res.ok) {
        const j = await res
          .json()
          .catch(async () => ({ error: await res.text().catch(() => "") }));
        const msg = j?.error || "Failed to record payment";
        throw new Error(msg);
      }
      toast.success(`Payment of ${formatCurrency(amount)} recorded.`);
      // Clear local state and navigate to order details for delivery updates
      setPaymentAmount("");
      setPaymentNote("");
      setIsDialogOpen(false);
      // Navigate to the order details page so admin can update delivery
      router.push(`/admin/orders/${orderId}`);
    } catch (err) {
      console.error(err);
      toast.error("Error recording payment.");
    }
  }

  async function applyStoreCredit() {
    if (!selectedUserId) return;
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
      if (applied > 0) {
        toast.success(
          `Applied ${formatCurrency(Number(applied))} in store credit across this customer's open orders.`,
        );
      } else {
        toast.info("No store credit available to apply.");
      }
      queryClient.invalidateQueries({ queryKey: ["admin", "orders"] });
      if (selectedUserId) {
        queryClient.invalidateQueries({
          queryKey: ["admin", "customer-balance", selectedUserId],
        });
      }
    } catch (err) {
      console.error(err);
      toast.error("Error applying store credit.");
    } finally {
      setApplyingCredit(false);
    }
  }

  const saveCurrentFilter = () => {
    const name = window.prompt("Name this saved filter");
    if (!name) return;
    const entry: OrdersSavedFilter = {
      id: `${Date.now()}`,
      name,
      state: {
        filter,
        deliveryFilter,
        paymentMethod,
        query,
        start,
        end,
        minTotal,
        maxTotal,
        userIdFilter,
        sortKey,
        sortDir,
        showPaid,
        showBalance,
        showDelivery,
        pageSize,
      },
    };
    setSavedFilters((prev) => [entry, ...prev]);
    toast.success("Saved filter");
  };

  const applySavedFilter = (entry: OrdersSavedFilter) => {
    const s = entry.state;
    setFilter(s.filter);
    setDeliveryFilter(s.deliveryFilter);
    setPaymentMethod(s.paymentMethod);
    setQuery(s.query);
    setStart(s.start);
    setEnd(s.end);
    setMinTotal(s.minTotal);
    setMaxTotal(s.maxTotal);
    setUserIdFilter(s.userIdFilter);
    setSortKey(s.sortKey);
    setSortDir(s.sortDir);
    setShowPaid(s.showPaid);
    setShowBalance(s.showBalance);
    setShowDelivery(s.showDelivery);
    setPageSize(s.pageSize);
    setPage(1);
    toast.success(`Applied "${entry.name}"`);
  };

  const removeSavedFilter = (id: string) => {
    setSavedFilters((prev) => prev.filter((f) => f.id !== id));
  };

  return (
    <section className="container mx-auto py-8 space-y-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Orders</h1>
          <p className="text-sm text-muted-foreground">
            Track orders, payments, and delivery status.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => queryClient.invalidateQueries({ queryKey: ["admin", "orders"] })}>
            <RefreshCcw className="w-4 h-4 mr-1" />
            Refresh
          </Button>
          <Button
            variant="secondary"
            className="w-full sm:w-auto"
            onClick={exportSelected}
          >
            <Download className="w-4 h-4 mr-1" />
            Export CSV
          </Button>
          <Button className="w-full sm:w-auto" onClick={() => router.push("/admin/orders/new") }>
            Create Order
          </Button>
        </div>
      </div>
      {selectedCount > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">{selectedCount} selected</span>
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              Clear
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={exportSelected}>
              Export CSV
            </Button>
          </div>
        </div>
      )}

      {/* Filters */}
      <Card className="shadow-md !border-none mb-6">
        <CardHeader className="flex flex-col gap-2 space-y-0 py-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-semibold">Filters</CardTitle>
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="w-full sm:w-auto">
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
              variant="ghost"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => {
                setQuery("");
                setFilter("ALL");
                setDeliveryFilter("ALL");
                setPaymentMethod("ALL");
                setStart("");
                setEnd("");
                setMinTotal("");
                setMaxTotal("");
                setUserIdFilter("");
                setPage(1);
              }}
            >
              Clear all
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search orders..."
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
            <SelectTrigger>
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All</SelectItem>
              <SelectItem value="UNPAID">Unpaid</SelectItem>
              <SelectItem value="PARTIALLY_PAID">Partially Paid</SelectItem>
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
            <SelectTrigger>
              <SelectValue placeholder="Filter by delivery" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Deliveries</SelectItem>
              <SelectItem value="NOT_DELIVERED">Not Delivered</SelectItem>
              <SelectItem value="PARTIALLY_DELIVERED">Partially Delivered</SelectItem>
              <SelectItem value="DELIVERED">Delivered</SelectItem>
              <SelectItem value="RETURNED">Returned</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={paymentMethod}
            onValueChange={(value) => {
              setPaymentMethod(value);
              setPage(1);
            }}
          >
            <SelectTrigger>
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
          <Input
            type="date"
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setPage(1);
            }}
            placeholder="Start date"
          />
          <Input
            type="date"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value);
              setPage(1);
            }}
            placeholder="End date"
          />
          <Input
            type="number"
            placeholder="Min total"
            value={minTotal}
            onChange={(e) => {
              setMinTotal(e.target.value);
              setPage(1);
            }}
          />
          <Input
            type="number"
            placeholder="Max total"
            value={maxTotal}
            onChange={(e) => {
              setMaxTotal(e.target.value);
              setPage(1);
            }}
          />
        </div>
          <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Saved views:</span>
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
        </CardContent>
      </Card>

      {/* Orders Table */}
      {sortedOrders.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          <p>No orders found for the current filters.</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setQuery("");
                setFilter("ALL");
                setDeliveryFilter("ALL");
                setPaymentMethod("ALL");
                setStart("");
                setEnd("");
                setMinTotal("");
                setMaxTotal("");
                setUserIdFilter("");
                setPage(1);
              }}
            >
              Clear filters
            </Button>
            <Button size="sm" onClick={() => router.push("/admin/orders/new")}>
              Create order
            </Button>
          </div>
        </div>
      ) : (
        <Card className="shadow-md !border-none">
          <CardHeader className="flex items-center justify-between py-3">
            <CardTitle className="text-base font-semibold">Orders</CardTitle>
            <span className="text-xs text-muted-foreground">
              {sortedOrders.length} shown
            </span>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
        <Table className="hidden md:table w-full table-fixed min-w-[1200px]">
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
                role="button"
                title={`Click to cycle status filter (current: ${filter})`}
                className="cursor-pointer select-none relative"
                style={{ width: columnWidths.status }}
                onClick={() => {
                  const seq = ["ALL", "UNPAID", "PARTIALLY_PAID", "PAID", "CANCELLED"] as const;
                  const i = seq.indexOf(filter as (typeof seq)[number]);
                  const next = seq[(i + 1) % seq.length];
                  setFilter(next);
                  setPage(1);
                }}
              >
                <div className="inline-flex items-center gap-1">
                  <span>Status ({filter})</span>
                  <Tooltip content="Click to cycle filter">
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Cycle status filter" />
                  </Tooltip>
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
                <TableHead className="text-left relative" style={{ width: columnWidths.delivery }}>
                  <div className="inline-flex items-center gap-1">
                    <span>Delivery</span>
                    <Tooltip content="Delivery status">
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Delivery" />
                    </Tooltip>
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
                      <span className="text-muted-foreground">Unknown</span>
                    )}
                  </TableCell>
                  <TableCell
                    style={{ width: getColWidth("placed") }}
                    title={`Placed: ${new Date(order.createdAt).toLocaleString()}\nUpdated: ${new Date(order.updatedAt || order.createdAt).toLocaleString()}`}
                  >
                    <span className="block truncate">{timeAgo(order.createdAt)}</span>
                  </TableCell>
                  <TableCell style={{ width: getColWidth("status") }}>
                    <span className={`text-xs px-2 py-1 rounded-full ${chipToneClass(orderStatusTone(order.status))}`}>
                      {order.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" style={{ width: getColWidth("total") }}>
                    {formatCurrency(Number(order.total || 0))}
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
                        {delivery === "DELIVERED"
                          ? "Delivered"
                          : delivery === "PARTIALLY_DELIVERED"
                          ? "Partial"
                          : delivery === "RETURNED"
                          ? "Returned"
                          : "Not Delivered"}
                      </span>
                    </TableCell>
                  ) : null}
                  <TableCell className="text-right overflow-visible" style={{ width: getColWidth("actions") }}>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Link href={`/admin/orders/${order.id}`}>
                        <Button size="sm" variant="outline">View Details</Button>
                      </Link>
                      <Link href={`/admin/audit?entityType=ORDER&entityId=${order.id}`}>
                        <Button size="sm" variant="outline">Audit</Button>
                      </Link>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedOrder(order);
                          setPaymentAmount("");
                          setPaymentNote("");
                          setPaymentTab("custom");
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
        <div className="md:hidden space-y-4 p-2">
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
                    <p className="text-xs text-muted-foreground">{order.user?.name || "Unknown"}</p>
                    <p className="text-xs text-muted-foreground break-all">
                      {order.user?.phone || order.user?.email || "—"}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">{timeAgo(order.createdAt)}</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Status</p>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${statusClass}`}>
                      {order.status}
                    </span>
                  </div>
                  {showDelivery ? (
                    <div>
                      <p className="text-xs uppercase text-muted-foreground">Delivery</p>
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${deliveryClass}`}>
                        {delivery === "DELIVERED"
                          ? "Delivered"
                          : delivery === "PARTIALLY_DELIVERED"
                          ? "Partial"
                          : delivery === "RETURNED"
                          ? "Returned"
                          : "Not Delivered"}
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

                <div>
                  <p className="text-xs uppercase text-muted-foreground">Notes</p>
                  <p>{order.adminNote || "—"}</p>
                </div>

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
                        if (delivery === "DELIVERED") return "Delivered";
                        if (delivery === "PARTIALLY_DELIVERED")
                          return "Partially delivered";
                        if (delivery === "RETURNED") return "Returned";
                        return "Not delivered";
                      })()}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" asChild className="flex-1 min-w-[120px]">
                    <Link href={`/admin/orders/${order.id}`}>View Details</Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild className="flex-1 min-w-[120px]">
                    <Link href={`/admin/audit?entityType=ORDER&entityId=${order.id}`}>Audit</Link>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 min-w-[120px]"
                    onClick={() => {
                      setSelectedOrder(order);
                      setPaymentAmount("");
                      setPaymentNote("");
                      setPaymentTab("custom");
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
                    className="flex-1 min-w-[120px]"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(`${typeof window !== "undefined" ? window.location.origin : ""}/admin/orders/${order.id}`)
                        .then(() => toast.success("Link copied"));
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
        <Pagination className="sm:mt-0">
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

              <Input
                type="number"
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
                placeholder="Optional note (e.g., cash received by admin)"
                value={paymentNote}
                onChange={(e) => setPaymentNote(e.target.value)}
              />

              <div className="flex justify-end gap-2 mt-4">
                <Button
                  variant="outline"
                  onClick={() => setIsDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => recordPayment(selectedOrder.id)}
                  disabled={!paymentAmount}
                >
                  Confirm Payment
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



