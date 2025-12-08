"use client";

export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency, formatDateGH } from "@/lib/currency";
import { formatIdReadable } from "@/lib/utils";
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
  total: number | string;
  amountPaid: number | string;
  balance: number | string;
  userId?: string | null;
  user?: { id?: string; name?: string | null; email?: string | null; phone?: string | null } | null;
  adminNote?: string | null;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function AdminOrdersContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [filter, setFilter] = useState<string>("ALL");
  const [deliveryFilter, setDeliveryFilter] = useState<string>("ALL");
  const [query, setQuery] = useState<string>("");
  const [selectedOrder, setSelectedOrder] = useState<AdminOrder | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentNote, setPaymentNote] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [paymentTab, setPaymentTab] = useState<"custom" | "full">("custom");
  const [applyingCredit, setApplyingCredit] = useState(false);
  const [sortKey, setSortKey] = useState<
    | "total"
    | "amountPaid"
    | "balance"
    | "createdAt"
    | "customer"
    | null
  >("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const initialized = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Initialize state from URL on mount
  useEffect(() => {
    if (initialized.current) return;
    const f = searchParams.get("filter");
    const df = searchParams.get("dFilter");
    const q = searchParams.get("q");
    const sk = searchParams.get("sortKey") as
      | "total"
      | "amountPaid"
      | "balance"
      | "createdAt"
      | "customer"
      | null;
    const sd = searchParams.get("sortDir") as "asc" | "desc" | null;

    if (f && ["ALL", "UNPAID", "PARTIALLY_PAID", "PAID"].includes(f)) setFilter(f);
    if (typeof q === "string") setQuery(q);
    if (sk && ["total", "amountPaid", "balance", "createdAt", "customer"].includes(sk)) setSortKey(sk);
    if (sd && ["asc", "desc"].includes(sd)) setSortDir(sd);
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

  // Reflect state to URL based on current filters/sort/query
  useEffect(() => {
    if (!initialized.current) return;
    const params = new URLSearchParams();
    // filter
    if (filter && filter !== "ALL") params.set("filter", filter);
    else params.delete("filter");
    if (deliveryFilter && deliveryFilter !== "ALL") params.set("dFilter", deliveryFilter);
    else params.delete("dFilter");
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
  }, [filter, query, sortKey, sortDir, deliveryFilter, pathname, router]);

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
    queryKey: ["admin", "orders"],
    // Admin dashboard should see all orders, not just the logged-in user's.
    queryFn: () => fetcher("/api/orders?all=1"),
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

  if (isLoading) return <p className="text-center mt-10">Loading orders...</p>;
  if (!data)
    return (
      <p className="text-center mt-10 text-red-500">Failed to load orders.</p>
    );

  const orders: AdminOrder[] = Array.isArray(data) ? data : data.data || [];
  const filteredOrders = orders.filter((o) => {
    const matchStatus = filter === "ALL" || o.status === filter;
    const matchDelivery = deliveryFilter === "ALL" || (o.deliveryStatus || "NOT_DELIVERED") === deliveryFilter;
    const matchQuery =
      !query ||
      o.user?.name?.toLowerCase().includes(query.toLowerCase()) ||
      o.user?.email?.toLowerCase().includes(query.toLowerCase()) ||
      o.id.toLowerCase().includes(query.toLowerCase());
    return matchStatus && matchDelivery && matchQuery;
  });

  function toggleSort(key: "total" | "amountPaid" | "balance" | "createdAt" | "customer") {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

    function sortIndicator(key: "total" | "amountPaid" | "balance" | "createdAt" | "customer") {
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

  const sortedOrders = (() => {
    if (!sortKey) return filteredOrders;
    const arr = [...filteredOrders];
    arr.sort((a, b) => {
      const key = sortKey!;
      const getVal = (o: AdminOrder) => {
        if (key === "createdAt") return new Date(o.createdAt).getTime();
        if (key === "customer")
          return `${o.user?.name || ""} ${o.user?.email || ""}`.toLowerCase();
        return Number((o as Record<string, unknown>)[key] ?? 0);
      };
      const va = getVal(a);
      const vb = getVal(b);
      if (typeof va === "string" || typeof vb === "string") {
        const cmp = String(va).localeCompare(String(vb));
        return sortDir === "asc" ? cmp : -cmp;
      }
      return sortDir === "asc" ? va - vb : vb - va;
    });
    return arr;
  })();

  async function recordPayment(orderId: string) {
    if (!paymentAmount) {
      toast.error("Enter a valid amount.");
      return;
    }

    try {
      const amount = Number(paymentAmount);
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

  return (
    <section className="container mx-auto py-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-3">
        <h1 className="text-2xl font-semibold">Admin Orders Dashboard</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => queryClient.invalidateQueries({ queryKey: ["admin", "orders"] })}>
            <RefreshCcw className="w-4 h-4 mr-1" />
            Refresh
          </Button>
          <Button
            variant="secondary"
            className="w-full sm:w-auto"
            onClick={() => toast.info("CSV export coming soon!")}
          >
            <Download className="w-4 h-4 mr-1" />
            Export CSV
          </Button>
          <Button className="w-full sm:w-auto" onClick={() => router.push("/admin/orders/new") }>
            Create Order
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-6">
        <div className="relative w-full md:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search orders..."
            value={query}
            ref={searchRef}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All</SelectItem>
            <SelectItem value="UNPAID">Unpaid</SelectItem>
            <SelectItem value="PARTIALLY_PAID">Partially Paid</SelectItem>
            <SelectItem value="PAID">Paid</SelectItem>
          </SelectContent>
        </Select>
        <Select value={deliveryFilter} onValueChange={setDeliveryFilter}>
          <SelectTrigger className="w-[220px]">
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
        </div>
      </div>

      {/* Orders Table */}
      {sortedOrders.length === 0 ? (
        <p className="text-muted-foreground text-center mt-10">No orders found.</p>
      ) : (
        <div className="overflow-x-auto md:overflow-visible md:rounded-xl md:border-0">
        <Table className="hidden md:table w-full">
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead
                role="button"
                aria-label="Sort by customer"
                className="cursor-pointer select-none"
                onClick={() => toggleSort("customer")}
              >
                Customer{sortIndicator("customer")}
              </TableHead>
              <TableHead
                role="button"
                aria-label="Sort by placed date"
                className="cursor-pointer select-none"
                onClick={() => toggleSort("createdAt")}
              >
                Placed{sortIndicator("createdAt")}
              </TableHead>
              <TableHead
                role="button"
                title={`Click to cycle status filter (current: ${filter})`}
                className="cursor-pointer select-none"
                onClick={() => {
                  const seq = ["ALL", "UNPAID", "PARTIALLY_PAID", "PAID"] as const;
                  const i = seq.indexOf(filter as (typeof seq)[number]);
                  const next = seq[(i + 1) % seq.length];
                  setFilter(next);
                }}
              >
                <div className="inline-flex items-center gap-1">
                  <span>Status ({filter})</span>
                  <Tooltip content="Click to cycle filter">
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Cycle status filter" />
                  </Tooltip>
                </div>
              </TableHead>
              <TableHead
                role="button"
                aria-label="Sort by total"
                className="text-right cursor-pointer select-none"
                onClick={() => toggleSort("total")}
              >
                <div className="inline-flex items-center justify-end gap-1 w-full">
                  <span>Total{sortIndicator("total")}</span>
                  <Tooltip content="Order total">
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Order total" />
                  </Tooltip>
                </div>
              </TableHead>
              <TableHead
                role="button"
                aria-label="Sort by paid"
                className="text-right cursor-pointer select-none"
                onClick={() => toggleSort("amountPaid")}
              >
                <div className="inline-flex items-center justify-end gap-1 w-full">
                  <span>Paid{sortIndicator("amountPaid")}</span>
                  <Tooltip content="Amount paid on order">
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Paid total" />
                  </Tooltip>
                </div>
              </TableHead>
              <TableHead
                role="button"
                aria-label="Sort by balance"
                className="text-right cursor-pointer select-none"
                onClick={() => toggleSort("balance")}
              >
                <div className="inline-flex items-center justify-end gap-1 w-full">
                  <span>Balance{sortIndicator("balance")}</span>
                  <Tooltip content="Outstanding = Total - Paid">
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Balance" />
                  </Tooltip>
                </div>
              </TableHead>
              <TableHead className="text-left">
                <div className="inline-flex items-center gap-1">
                  <span>Delivery</span>
                  <Tooltip content="Delivery status">
                    <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Delivery" />
                  </Tooltip>
                </div>
              </TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedOrders.map((order) => {
              const statusClass =
                order.status === "PAID"
                  ? "bg-green-100 text-green-700"
                  : order.status === "PARTIALLY_PAID"
                  ? "bg-yellow-100 text-yellow-800"
                  : "bg-red-100 text-red-700";
              const delivery = order.deliveryStatus || "NOT_DELIVERED";
              const deliveryClass =
                delivery === "DELIVERED"
                  ? "bg-green-100 text-green-700"
                  : delivery === "PARTIALLY_DELIVERED"
                  ? "bg-yellow-100 text-yellow-800"
                  : delivery === "RETURNED"
                  ? "bg-red-100 text-red-700"
                  : "bg-gray-100 text-gray-700";
              return (
                <TableRow key={order.id}>
                  <TableCell>
                    <Link href={`/admin/orders/${order.id}`} className="hover:underline">
                      {shortOrderId(order.id)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {order.user ? (
                      <>
                        {order.user?.name} ({order.user?.email})
                      </>
                    ) : (
                      <span className="text-muted-foreground">Unknown</span>
                    )}
                  </TableCell>
                  <TableCell title={new Date(order.createdAt).toLocaleString()}>
                    {timeAgo(order.createdAt)}
                  </TableCell>
                  <TableCell>
                    <span className={`text-xs px-2 py-1 rounded-full ${statusClass}`}>
                      {order.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(Number(order.total || 0))}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(Number(order.amountPaid || 0))}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatCurrency(Number(order.balance || 0))}
                  </TableCell>
                  <TableCell>
                    <span className={`text-xs px-2 py-1 rounded-full ${deliveryClass}`}>
                      {delivery === "DELIVERED"
                        ? "Delivered"
                        : delivery === "PARTIALLY_DELIVERED"
                        ? "Partial"
                        : delivery === "RETURNED"
                        ? "Returned"
                        : "Not Delivered"}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Link href={`/admin/orders/${order.id}`}>
                        <Button size="sm" variant="outline">View Details</Button>
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
            const statusClass =
              order.status === "PAID"
                ? "bg-green-100 text-green-700"
                : order.status === "PARTIALLY_PAID"
                ? "bg-yellow-100 text-yellow-800"
                : "bg-red-100 text-red-700";
            const deliveryClass =
              delivery === "DELIVERED"
                ? "bg-green-100 text-green-700"
                : delivery === "PARTIALLY_DELIVERED"
                ? "bg-yellow-100 text-yellow-800"
                : delivery === "RETURNED"
                ? "bg-red-100 text-red-700"
                : "bg-gray-100 text-gray-700";

            return (
              <div key={order.id} className="rounded-lg border p-4 space-y-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold break-all">
                      {shortOrderId(order.id)}
                    </p>
                    <p className="text-xs text-muted-foreground">{order.user?.name || "Unknown"}</p>
                    <p className="text-xs text-muted-foreground break-all">{order.user?.email || "—"}</p>
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
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Total</p>
                    <p className="font-mono">
                      {formatCurrency(Number(order.total || 0))}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Paid</p>
                    <p className="font-mono">
                      {formatCurrency(Number(order.amountPaid || 0))}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Balance</p>
                    <p className="font-mono">
                      {formatCurrency(Number(order.balance || 0))}
                    </p>
                  </div>
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
      )}

      {/* Add Payment Modal */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Payment</DialogTitle>
          </DialogHeader>

          {selectedOrder && (
            <div className="space-y-4 mt-4">
              <p>
                <strong>Order ID:</strong> {selectedOrder.id.slice(0, 8)}...
              </p>
              <p>
                <strong>Total:</strong>{" "}
                {formatCurrency(Number(selectedOrder.total || 0))}
              </p>
              <p>
                <strong>Already Paid:</strong>{" "}
                {formatCurrency(Number(selectedOrder.amountPaid || 0))}
              </p>
              <p>
                <strong>Remaining Balance:</strong>{" "}
                {formatCurrency(Number(selectedOrder.balance || 0))}
              </p>

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
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
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

              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Amount Mode:</span>
                <div className="inline-flex gap-1" role="tablist" aria-label="Payment amount mode">
                  <Button
                    type="button"
                    size="sm"
                    variant={paymentTab === "custom" ? "default" : "outline"}
                    role="tab"
                    aria-selected={paymentTab === "custom"}
                    onClick={() => setPaymentTab("custom")}
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
                    }}
                  >
                    Pay Full ({formatCurrency(Number(selectedOrder.balance || 0))})
                  </Button>
                </div>
              </div>

              <Input
                type="number"
                placeholder="Enter payment amount"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
              />

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
        <section className="p-6">
          <h1 className="text-2xl font-semibold mb-2">Orders</h1>
          <p className="text-sm text-muted-foreground">Loading orders…</p>
        </section>
      }
    >
      <AdminOrdersContent />
    </Suspense>
  );
}



