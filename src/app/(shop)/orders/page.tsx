"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { ADMIN_PHONE, ADMIN_PHONE_TEL } from "@/lib/config";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatCurrency, formatDateGH } from "@/lib/currency";
import { formatIdReadable } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, PackageCheck } from "lucide-react";
import { useClientQuery } from "@/hooks/use-client-query";

type PaymentMeta = {
  method?: string;
  status?: string;
  providerRef?: string;
};

type OrderItem = {
  id: string;
  quantity: number;
  price: number | string;
  product: {
    id: string;
    name: string;
    imageUrl: string | null;
  } | null;
  deliveredQuantity?: number;
  returnedQuantity?: number;
};

type Payment = {
  id: string;
  amount: number | string;
  note: string | null;
  createdAt: string | Date;
};

type Order = {
  id: string;
  status: string;
  deliveryStatus?: "NOT_DELIVERED" | "PARTIALLY_DELIVERED" | "DELIVERED" | "RETURNED" | string;
  deliveredAt?: string | Date | null;
  createdAt: string | Date;
  total: number | string;
  amountPaid?: number | string;
  balance?: number | string;
  items: OrderItem[];
  payments: Payment[];
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function OrdersContent() {
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  const { data, error, isLoading } = useClientQuery({
    queryKey: ["orders", "history"],
    queryFn: () => fetcher("/api/orders/history"),
    enabled: !!session,
    refetchInterval: 10000,
  });
  const { data: me } = useClientQuery({
    queryKey: ["account", "me"],
    queryFn: () => fetcher("/api/account/me"),
    enabled: !!session,
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
  });
  const queryClientOrders = useQueryClient();
  const { data: balanceData } = useClientQuery({
    queryKey: ["balance", "self"],
    queryFn: () => fetcher("/api/balance?self=1"),
    enabled: !!session,
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
  });

  const [status, setStatus] = useState<string>("ALL");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const searchParams = useSearchParams();
  const justPlaced = searchParams?.get("placed") === "1";

  const orders: Array<Order & { totalPaid: number; balance: number }> = useMemo(() => {
    const source = (data?.orders || []) as Order[];
    return source.map((o) => {
      const totalPaid = Number(o.amountPaid ?? 0);
      const balance = Number(o.balance ?? Math.max(0, Number(o.total) - totalPaid));
      return { ...o, totalPaid, balance };
    });
  }, [data]);

  const filtered = useMemo(() => {
    if (status === "ALL") return orders;
    if (status === "PAID") return orders.filter((o) => o.balance <= 0);
    if (status === "PENDING") return orders.filter((o) => o.balance > 0);
    return orders;
  }, [orders, status]);

  const summary = useMemo(() => {
    const active = orders.filter((o) => o.status !== "CANCELLED");
    const totalOrders = active.length;
    const totalSpent = active.reduce((s, o) => s + Number(o.total), 0);
    const totalPaid = active.reduce((s, o) => s + Number(o.totalPaid), 0);
    const outstanding = Math.max(0, totalSpent - totalPaid);
    return { totalOrders, totalSpent, totalPaid, outstanding };
  }, [orders]);

  const hasOutstanding = useMemo(
    () => orders.some((o) => o.status !== "CANCELLED" && Number(o.balance) > 0),
    [orders]
  );

  if (!session)
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground">
          Please sign in to view your order history.
        </p>
      </div>
    );

  if (isLoading)
    return (
      <div className="text-center py-20 text-muted-foreground">
        Loading your orders...
      </div>
    );

  if (error) {
    toast.error("Could not load order history");
    return (
      <div className="text-center py-20 text-red-500">
        Error loading orders.
      </div>
    );
  }

  if (!orders.length)
    return (
      <div className="text-center py-20 text-muted-foreground">
        You haven&apos;t placed any orders yet.
      </div>
    );

  const creditAvailable = Math.max(0, Number(balanceData?.unappliedFunds ?? 0));
  const cashRefunds = Math.max(0, Number(balanceData?.cashRefunds ?? 0));

  return (
    <section className="orders-page mx-auto w-full max-w-5xl space-y-4 px-3 sm:px-4 lg:px-0">
      {(justPlaced || hasOutstanding) && (
        <div className="rounded-md border border-primary/20 bg-primary/10 text-primary p-3 text-sm">
          {justPlaced ? (
            <>Order placed successfully. Please call <a href={ADMIN_PHONE_TEL} className="underline font-medium">{ADMIN_PHONE}</a> to confirm and complete payment.</>
          ) : (
            <>You have unpaid orders. Please call <a href={ADMIN_PHONE_TEL} className="underline font-medium">{ADMIN_PHONE}</a> to complete payment.</>
          )}
        </div>
      )}
      {(creditAvailable > 0 || cashRefunds > 0) && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 text-emerald-900 p-3 text-sm space-y-1">
          {creditAvailable > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <p>
                Store credit available:{" "}
                <span className="font-semibold">
                  {formatCurrency(creditAvailable)}
                </span>
                . You can apply it directly to your outstanding orders, and it
                will also be auto-applied when you place new orders (oldest
                unpaid or partially-paid orders are cleared first).
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    const res = await fetch("/api/account/credit/apply", {
                      method: "POST",
                    });
                    const j = await res.json().catch(() => ({}));
                    if (!res.ok) {
                      throw new Error(
                        j?.error || "Failed to apply store credit",
                      );
                    }
                    toast.success(
                      j?.applied
                        ? `Applied ${formatCurrency(
                            Number(j.applied || 0),
                          )} of store credit to your orders.`
                        : "No store credit could be applied.",
                    );
                    queryClient.invalidateQueries({
                      queryKey: ["orders", "history"],
                    });
                    queryClient.invalidateQueries({
                      queryKey: ["balance", "self"],
                    });
                    queryClientOrders.invalidateQueries({
                      queryKey: ["orders", "history"],
                    });
                  } catch (e: unknown) {
                    const message =
                      e instanceof Error
                        ? e.message
                        : "Failed to apply store credit";
                    toast.error(message);
                  }
                }}
              >
                Apply Store Credit
              </Button>
            </div>
          )}
          {cashRefunds > 0 && (
            <p>
              Cash refunds issued so far: <span className="font-semibold">{formatCurrency(cashRefunds)}</span>.
            </p>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Order History</h1>
          <p className="text-sm text-muted-foreground">
            View your past orders and payment activity
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by payment status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All</SelectItem>
              <SelectItem value="PENDING">Has outstanding balance</SelectItem>
              <SelectItem value="PAID">Paid</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Summary cards (hide lifetime totals; show only count and outstanding) */}
      <div className="grid gap-2 sm:grid-cols-2 text-xs">
        <Card className="!py-1.5 !border-none !shadow-sm !rounded-none">
          <CardContent className="!py-2">
            <p className="text-[11px] text-muted-foreground">Orders</p>
            <p className="text-lg font-semibold">{summary.totalOrders}</p>
          </CardContent>
        </Card>
        <Card className="!py-1.5 !border-none !shadow-sm !rounded-none">
          <CardContent className="!py-2">
            <p className="text-[11px] text-muted-foreground">Outstanding</p>
            <p className={`text-lg font-semibold ${summary.outstanding > 0 ? "text-red-600" : "text-green-700"}`}>
              {formatCurrency(summary.outstanding)}
            </p>
          </CardContent>
        </Card>
      </div>

      {filtered.map((order) => {
        const items = Array.isArray(order.items) ? order.items : [];
        const nonNullItems = items.filter((it) => it?.product);
        const uniqueProducts = nonNullItems.reduce(
          (
            acc: Array<{
              product: NonNullable<OrderItem["product"]>;
              quantity: number;
              delivered: number;
              returned: number;
            }>,
            it,
          ) => {
            if (!it.product) return acc;
            const delivered = Number(it.deliveredQuantity ?? 0);
            const returned = Number(it.returnedQuantity ?? 0);
            const existing = acc.find((x) => x.product.id === it.product!.id);
            if (existing) {
              existing.quantity += it.quantity;
              existing.delivered += delivered;
              existing.returned += returned;
            } else {
              acc.push({
                product: it.product as NonNullable<OrderItem["product"]>,
                quantity: it.quantity,
                delivered,
                returned,
              });
            }
            return acc;
          },
          [],
        );

        return (
          <Card
            key={order.id}
            className="text-xs !py-1.5 !border-none !shadow-sm !rounded-none"
          >
            <CardHeader className="!py-1.5 !px-3">
              <CardTitle className="flex justify-between items-center text-[13px]">
                <span className="flex items-center gap-2">
                  <span className="truncate max-w-[160px]">
                    Order {formatIdReadable(order.id)}
                  </span>
                  {(() => {
                    try {
                      const pending = (order.payments || []).some((p) => {
                        if (!p?.note) return false;
                        try { const m = JSON.parse(p.note); return m?.method === 'momo' && m?.status === 'pending'; } catch { return false; }
                      });
                      if (pending) {
                        return (
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                            MoMo Pending
                          </span>
                        );
                      }
                    } catch {}
                    return null;
                  })()}
                </span>
                <div className="flex items-center gap-2">
                  {(() => {
                    const sc =
                      order.status === "PAID"
                        ? "bg-green-100 text-green-700"
                        : order.status === "PARTIALLY_PAID"
                        ? "bg-yellow-100 text-yellow-800"
                        : order.status === "CANCELLED"
                        ? "bg-gray-200 text-gray-700"
                        : "bg-red-100 text-red-700";
                    return (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${sc}`}>
                        {order.status}
                      </span>
                    );
                  })()}
                  {(() => {
                    const ds = String(order.deliveryStatus || "NOT_DELIVERED").toUpperCase();
                    let label = "Not delivered";
                    let cls = "bg-slate-100 text-slate-700";
                    if (ds === "DELIVERED") {
                      label = "Delivered";
                      cls = "bg-emerald-100 text-emerald-700";
                    } else if (ds === "PARTIALLY_DELIVERED") {
                      label = "Partially delivered";
                      cls = "bg-amber-100 text-amber-800";
                    } else if (ds === "RETURNED") {
                      label = "Returned";
                      cls = "bg-gray-200 text-gray-700";
                    }
                    return (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>
                        {label}
                      </span>
                    );
                  })()}
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1 !px-3 !py-1.5">
              {uniqueProducts.length > 0 && (
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-2">
                      {uniqueProducts.slice(0, 3).map((it) => (
                        <div
                          key={it.product.id}
                          className="relative h-7 w-7 rounded-md bg-slate-100 border border-slate-200 overflow-hidden flex items-center justify-center"
                        >
                          {it.product.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={it.product.imageUrl}
                              alt={it.product.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span className="text-[9px] px-1 text-slate-500 text-center line-clamp-2">
                              {it.product.name}
                            </span>
                          )}
                          <span className="absolute bottom-[1px] right-[1px] bg-slate-900/80 text-white text-[9px] leading-none px-0.5 rounded">
                            x{it.quantity}
                          </span>
                        </div>
                      ))}
                      {uniqueProducts.length > 3 && (
                        <div className="h-7 w-7 rounded-md bg-slate-100 border border-slate-200 flex items-center justify-center text-[10px] text-slate-600">
                          +{uniqueProducts.length - 3}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col text-[11px] text-muted-foreground">
                      <span>
                        {uniqueProducts.length === 1
                          ? `${uniqueProducts[0].quantity} item`
                          : `${uniqueProducts.reduce(
                              (s, it) => s + Number(it.quantity || 0),
                              0,
                            )} items`}
                      </span>
                      <span>
                        {(() => {
                          const totalQty = uniqueProducts.reduce(
                            (s, it) => s + Number(it.quantity || 0),
                            0,
                          );
                          const totalDelivered = uniqueProducts.reduce(
                            (s, it) => s + Number(it.delivered || 0),
                            0,
                          );
                          const totalReturned = uniqueProducts.reduce(
                            (s, it) => s + Number(it.returned || 0),
                            0,
                          );
                          if (totalReturned > 0 && totalReturned >= totalDelivered) {
                            return `Returned items: ${totalReturned}`;
                          }
                          if (totalDelivered <= 0) return "Items not delivered yet";
                          if (totalDelivered >= totalQty) {
                            return "All items delivered";
                          }
                          return `Items delivered: ${totalDelivered}/${totalQty}`;
                        })()}
                      </span>
                    </div>
                  </div>
                  <Button
                    asChild
                    size="sm"
                    variant="outline"
                    className="px-3 py-1 text-[11px]"
                    title="View printable receipt"
                  >
                    <Link href={`/orders/${order.id}/receipt`}>View Receipt</Link>
                  </Button>
                </div>
              )}
              <div className="flex justify-between">
                <span>Date</span>
                <span>{formatDateGH(order.createdAt)}</span>
              </div>
              {order.deliveredAt && (
                <div className="flex justify-between">
                  <span>Delivered</span>
                  <span>
                    {formatDateGH(order.deliveredAt)}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span>Total</span>
                <span>{formatCurrency(Number(order.total))}</span>
              </div>
              <div className="flex justify-between">
                <span>Paid</span>
                <span>{formatCurrency(Number(order.totalPaid))}</span>
              </div>
              {(() => {
                const payments = (order.payments || []) as Array<{
                  id: string;
                  amount: number | string;
                  note?: string | null;
                }>;
                let storeCreditApplied = 0;
                for (const p of payments) {
                  if (!p.note) continue;
                  try {
                    const meta = JSON.parse(p.note) as {
                      reference?: string;
                      applied?: Array<{ orderId?: string; applied?: number }>;
                    };
                    if (meta.reference === "AUTO_APPLY" && Array.isArray(meta.applied)) {
                      for (const a of meta.applied) {
                        if (a && a.orderId === order.id) {
                          storeCreditApplied += Number(a.applied || 0);
                        }
                      }
                    }
                  } catch {
                    // ignore malformed notes
                  }
                }
                if (storeCreditApplied <= 0) return null;
                return (
                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>Paid from store credit:</span>
                    <span>{formatCurrency(storeCreditApplied)}</span>
                  </div>
                );
              })()}
              {items.length > 0 && (
                <div className="mt-2 border-t pt-2 space-y-1">
                  <p className="text-[11px] font-semibold text-muted-foreground">
                    Items and delivery
                  </p>
                  {items.map((it) => {
                    const delivered = Number(it.deliveredQuantity ?? 0);
                    const returned = Number(it.returnedQuantity ?? 0);
                    const qty = Number(it.quantity || 0);
                    return (
                      <div
                        key={it.id}
                        className="flex items-center justify-between gap-2 text-[11px]"
                      >
                        <span className="truncate max-w-[200px]">
                          {it.product?.name || "Item"}{" "}
                          <span className="text-muted-foreground">
                            ×{qty}
                          </span>
                        </span>
                        <div className="flex flex-col items-end gap-0.5">
                          <span
                            className={`px-2 py-0.5 rounded-full whitespace-nowrap ${
                              delivered >= qty && qty > 0
                                ? "bg-emerald-100 text-emerald-700"
                                : delivered > 0
                                ? "bg-amber-100 text-amber-800"
                                : "bg-slate-100 text-slate-700"
                            }`}
                          >
                            {delivered >= qty && qty > 0
                              ? "Delivered"
                              : delivered > 0
                              ? `Partially delivered (${delivered}/${qty})`
                              : "Not delivered yet"}
                          </span>
                          {returned > 0 && (
                            <span className="text-[10px] text-muted-foreground">
                              {returned >= delivered && delivered > 0
                                ? `All delivered units returned (${returned})`
                                : `${returned} of ${qty} returned`}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {(() => {
                const payments = (order.payments || []) as Array<{
                  id: string;
                  amount: number | string;
                  note?: string | null;
                }>;
                let storeCreditApplied = 0;
                let momoPaid = 0;
                for (const p of payments) {
                  if (!p.note) continue;
                  try {
                    const meta = JSON.parse(p.note) as {
                      reference?: string;
                      applied?: Array<{ orderId?: string; applied?: number }>;
                      method?: string;
                    };
                    if (meta.reference === "AUTO_APPLY" && Array.isArray(meta.applied)) {
                      for (const a of meta.applied) {
                        if (a && a.orderId === order.id) {
                          storeCreditApplied += Number(a.applied || 0);
                        }
                      }
                    }
                    if (meta.method === "momo") {
                      momoPaid += Number(p.amount || 0);
                    }
                  } catch {
                    // ignore malformed notes
                  }
                }
                return (
                  <>
                    {storeCreditApplied > 0 && (
                      <div className="flex justify-between text-[11px] text-muted-foreground">
                        <span>Paid from store credit:</span>
                        <span>{formatCurrency(storeCreditApplied)}</span>
                      </div>
                    )}
                    {momoPaid > 0 && (
                      <div className="flex justify-between text-[11px] text-muted-foreground">
                        <span>Paid via MoMo:</span>
                        <span>{formatCurrency(momoPaid)}</span>
                      </div>
                    )}
                  </>
                );
              })()}
              <div className="flex justify-between font-semibold">
                <span>Balance</span>
                <span className={order.balance <= 0 ? "text-green-600" : "text-red-600"}>
                  {formatCurrency(Number(order.balance))}
                </span>
              </div>

              {/* Simple timeline-style view */}
              <div className="mt-3 border-t pt-2 space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-medium">Order placed</span>
                  <span>{formatDateGH(order.createdAt)}</span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-medium">Payments</span>
                  <span>
                    {Number(order.totalPaid) > 0
                      ? `${formatCurrency(Number(order.totalPaid))} paid`
                      : "No payments yet"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-medium">Delivery</span>
                  <span>
                    {(() => {
                      const ds = String(order.deliveryStatus || "NOT_DELIVERED").toUpperCase();
                      if (ds === "DELIVERED") {
                        return order.deliveredAt
                          ? `Delivered on ${formatDateGH(order.deliveredAt)}`
                          : "Delivered";
                      }
                      if (ds === "PARTIALLY_DELIVERED") {
                        return "Partially delivered";
                      }
                      if (ds === "RETURNED") {
                        return "Returned";
                      }
                      return "Not delivered";
                    })()}
                  </span>
                </div>
              </div>

              {Number(order.balance) > 0 && order.status !== "CANCELLED" && (
                <div className="mt-2 grid gap-2">
                  <p className="text-xs text-primary bg-primary/10 border border-primary/20 rounded px-2 py-1">
                    You can pay your outstanding balance via Mobile Money (MoMo)
                    or call <a href={ADMIN_PHONE_TEL} className="underline font-medium">{ADMIN_PHONE}</a> to arrange payment.
                  </p>
                  <MomoPayInline
                    orderId={order.id}
                    maxAmount={Number(order.balance)}
                    defaultPhone={String(me?.phone || "")}
                    onSuccess={() => queryClient.invalidateQueries({ queryKey: ["orders","history"] })}
                  />
                    <MomoPendingList
                      payments={order.payments}
                      onSettled={() =>
                        queryClient.invalidateQueries({ queryKey: ["orders", "history"] })
                      }
                    />
                </div>
              )}

              {order.payments.length > 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm">Payments</h3>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-expanded={!!expanded[order.id]}
                      aria-controls={`order-${order.id}-payments`}
                      onClick={() =>
                        setExpanded((e) => ({ ...e, [order.id]: !e[order.id] }))
                      }
                    >
                      {expanded[order.id] ? (
                        <>
                          <ChevronUp className="w-4 h-4 mr-1" /> Hide
                        </>
                      ) : (
                        <>
                          <ChevronDown className="w-4 h-4 mr-1" /> View
                        </>
                      )}
                    </Button>
                  </div>
                  {expanded[order.id] && (
                    <div
                      id={`order-${order.id}-payments`}
                      className="mt-2 text-xs space-y-1"
                    >
                      {(() => {
                        const payments = order.payments || [];
                        let storeCreditApplied = 0;
                        let momoPaid = 0;
                        let cashPaid = 0;
                        for (const p of payments) {
                          if (!p.note) continue;
                          try {
                            const meta = JSON.parse(p.note as string) as {
                              reference?: string;
                              applied?: Array<{ orderId?: string; applied?: number }>;
                              method?: string;
                            };
                            if (meta.reference === "AUTO_APPLY" && Array.isArray(meta.applied)) {
                              for (const a of meta.applied) {
                                if (a && a.orderId === order.id) {
                                  storeCreditApplied += Number(a.applied || 0);
                                }
                              }
                            }
                            if (meta.method === "momo") {
                              momoPaid += Number(p.amount || 0);
                            }
                            if (meta.method === "cash" || meta.method === "transfer") {
                              cashPaid += Number(p.amount || 0);
                            }
                          } catch {
                            // ignore malformed notes
                          }
                        }
                        if (storeCreditApplied <= 0 && momoPaid <= 0 && cashPaid <= 0) {
                          return <p>No summarized payment information available.</p>;
                        }
                        return (
                          <>
                            {cashPaid > 0 && (
                              <p>
                                Paid in cash/transfer:{" "}
                                <span className="font-semibold">
                                  {formatCurrency(cashPaid)}
                                </span>
                              </p>
                            )}
                            {momoPaid > 0 && (
                              <p>
                                Paid via MoMo:{" "}
                                <span className="font-semibold">
                                  {formatCurrency(momoPaid)}
                                </span>
                              </p>
                            )}
                            {storeCreditApplied > 0 && (
                              <p>
                                Store credit applied:{" "}
                                <span className="font-semibold">
                                  {formatCurrency(storeCreditApplied)}
                                </span>
                              </p>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}

              {/* Reorder shortcut */}
              {uniqueProducts.length > 0 && (
                <div className="mt-3 flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-[11px] flex items-center gap-1"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        for (const it of items) {
                          if (!it.product) continue;
                          await fetch("/api/cart", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              productId: it.product.id,
                              quantity: it.quantity,
                            }),
                          });
                        }
                        toast.success("Items from this order were added to your cart.");
                        queryClient.invalidateQueries({ queryKey: ["cart"] });
                      } catch (err) {
                        console.error(err);
                        toast.error("Failed to add items back to cart.");
                      }
                    }}
                  >
                    <PackageCheck className="w-3 h-3" />
                    Reorder items
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </section>
  );
}

export default function OrdersPage() {
  return (
    <Suspense
      fallback={
        <section className="space-y-4">
          <h1 className="text-2xl font-semibold">Order History</h1>
          <p className="text-sm text-muted-foreground">Loading your orders…</p>
        </section>
      }
    >
      <OrdersContent />
    </Suspense>
  );
}

// Legacy payment formatting helpers and payment row typing have been removed
// to keep this page focused on high-level order summaries.

function MomoPayInline({ orderId, maxAmount, defaultPhone, onSuccess }: { orderId: string; maxAmount: number; defaultPhone?: string; onSuccess?: () => void }) {
  const [phone, setPhone] = useState<string>("");
  const [normalized, setNormalized] = useState<string>("");
  const [amtStr, setAmtStr] = useState<string>(() => (Number(maxAmount) > 0 ? String(Number(maxAmount).toFixed(2)) : ""));
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const normalizePhone = (input: string) => {
    const s = (input || "").trim().replace(/[^\d+]/g, "");
    if (/^0\d{9}$/.test(s)) return "+233" + s.slice(1);
    return s;
  };
  const isValidPhone = (input: string) => /^\+?\d{10,15}$/.test(normalizePhone(input));

 
  const parsedAmount = (() => {
    const n = Number((amtStr || "").replace(/,/g, ""));
    if (!isFinite(n)) return NaN;
    return Math.max(0, Math.min(Number(maxAmount) || 0, n));
  })();
  const amountInvalid = !(parsedAmount > 0) || parsedAmount > (Number(maxAmount) || 0);

  const resetFields = () => {
    setPhone("");
    setAmtStr("");
    setNormalized("");
  };

  async function onPay() {
    try {
      setLoading(true);
      const phoneToUse = normalizePhone(phone);
      if (!isValidPhone(phoneToUse)) {
        toast.error("Enter a valid phone number");
        return;
      }
      const amt = parsedAmount;
      if (!(amt > 0)) {
        toast.error("Enter a valid amount");
        return;
      }
      const res = await fetch("/api/payments/momo/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, phone: phoneToUse, provider: "mtn", amount: amt }),
      });
      const j = (await res.json().catch(() => ({} as { error?: string; paymentId?: string; applied?: boolean; simulated?: boolean })));
      if (!res.ok) {
        throw new Error(j?.error || "Failed to initiate MoMo");
      }
      const paymentId = j?.paymentId as string | undefined;
      if (j?.applied) {
        toast.success(`Payment confirmed. Thank you!${j?.simulated ? ' (simulated)' : ''}`);
        resetFields();
        if (onSuccess) onSuccess();
        return;
      }
      toast.success("MoMo payment initiated. Approve the prompt on your phone.");
      if (paymentId) startPolling(paymentId);
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Failed to initiate MoMo";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  async function pollOnce(paymentId: string) {
    const r = await fetch(`/api/payments/momo/status/${paymentId}`);
    const j = (await r.json().catch(() => ({}))) as {
      status?: string;
      error?: string;
    };
    if (!r.ok) return { done: true, ok: false, error: j?.error };
    const status = String(j?.status || "").toUpperCase();
    if (status === "SUCCESSFUL") {
      toast.success("Payment confirmed. Thank you!");
      resetFields();
      if (onSuccess) onSuccess();
      return { done: true, ok: true };
    }
    if (status === "FAILED") {
      toast.error("MoMo payment failed.");
      return { done: true, ok: false };
    }
    return { done: false, ok: true };
  }

  function startPolling(paymentId: string) {
    let attempts = 0;
    const maxAttempts = 24; // ~2 minutes at 5s interval
    const tick = async () => {
      attempts += 1;
      const res = await pollOnce(paymentId);
      if (res.done || attempts >= maxAttempts) {
        const current = pollRef.current;
        if (current) {
          try { clearInterval(current); } catch {}
        }
        pollRef.current = null;
        return;
      }
    };
    const current = pollRef.current;
    if (current) {
      try { clearInterval(current); } catch {}
    }
    pollRef.current = setInterval(tick, 5000);
    tick();
  }

  const savedPhoneNormalized = defaultPhone ? normalizePhone(defaultPhone) : "";
  const showSavedPhoneChoice = Boolean(savedPhoneNormalized);

  return (
    <div className="grid gap-2 sm:flex sm:items-start sm:gap-2">
      <div className="grid gap-1">
        <Input
          type="tel"
          inputMode="tel"
          placeholder="MoMo number (e.g., 0241234567 or +23324...)"
          value={phone}
          onChange={(e) => { setPhone(e.target.value); }}
          onBlur={() => setNormalized(normalizePhone(phone))}
          className="max-w-xs"
        />
        {(phone || normalized || showSavedPhoneChoice) && (
          <div className="flex flex-wrap gap-2 text-xs">
            {phone && !isValidPhone(phone) && (
              <span className="text-red-600">Enter a valid phone number</span>
            )}
            {showSavedPhoneChoice && phone !== savedPhoneNormalized && (
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => setPhone(savedPhoneNormalized)}
              >
                Use saved MoMo number: {savedPhoneNormalized}
              </button>
            )}
            {isValidPhone(savedPhoneNormalized) && !phone && (
              <span className="text-muted-foreground">
                We&apos;ll send the payment prompt to your saved MoMo number when you use it here.
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
        <div className="relative w-40">
          <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-xs text-muted-foreground">
            GH₵
          </span>
          <Input
            type="text"
            inputMode="decimal"
            pattern="[0-9]*[.,]?[0-9]*"
            placeholder="0.00"
            value={amtStr}
            onChange={(e) => {
              const raw = e.target.value || "";
              const cleaned = raw.replace(/[^0-9.,]/g, "");
              setAmtStr(cleaned);
            }}
            className="w-full pl-10"
          />
        </div>
        {amountInvalid ? (
          <span className="text-xs text-red-600">
            {`Enter 0.01 - ${formatCurrency(Number(maxAmount) || 0)}`}
          </span>
        ) : (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline text-left"
            onClick={() => {
              const max = Number(maxAmount) || 0;
              if (max > 0) {
                setAmtStr(String(max.toFixed(2)));
              }
            }}
          >
            Outstanding: {formatCurrency(Number(maxAmount) || 0)}
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogTrigger asChild>
            <Button
              size="sm"
              disabled={loading || !isValidPhone(phone) || amountInvalid}
            >
              {loading ? 'Processing...' : 'Pay with MoMo'}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirm MoMo payment</DialogTitle>
            </DialogHeader>
            <div className="text-sm space-y-3">
              <p className="text-muted-foreground">
                You are about to pay your outstanding balance via Mobile Money (MoMo).
                Please review the payment details below before continuing.
              </p>
              <div className="rounded-md border p-3 bg-muted/40 space-y-1">
                <div className="flex justify-between">
                  <span className="text-xs text-muted-foreground">MoMo number</span>
                  <span className="font-medium break-all">
                    {phone || defaultPhone || "Not provided"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-muted-foreground">Amount to pay</span>
                  <span className="font-semibold">
                    {formatCurrency(parsedAmount || 0)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-muted-foreground">Outstanding balance</span>
                  <span className="text-xs font-medium">
                    {formatCurrency(Number(maxAmount) || 0)}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button
                  onClick={() => {
                    void onPay();
                  }}
                  disabled={loading}
                >
                  Confirm &amp; Pay
                </Button>
              </DialogClose>
            </div>
          </DialogContent>
        </Dialog>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            const full = Number(maxAmount) || 0;
            setAmtStr(String(full.toFixed(2)));
            if (isValidPhone(phone) && full > 0) {
              setConfirmOpen(true);
            }
          }}
          disabled={loading || !(Number(maxAmount) > 0)}
          title="Pay your full outstanding balance"
        >
          Pay full balance
        </Button>
      </div>
    </div>
  );
}
function MomoPendingList({ payments, onSettled }: { payments: Array<{ id: string; note: string | null }>; onSettled?: () => void }) {
  const pending = (payments || [])
    .map((p) => {
      try {
        const meta = p.note ? (JSON.parse(p.note) as PaymentMeta) : null;
        return meta && meta.method === "momo" && meta.status === "pending" && meta.providerRef
          ? { id: p.id, providerRef: meta.providerRef }
          : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is { id: string; providerRef: string } => Boolean(x));
  if (!pending.length) return null;
  return (
    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
      MoMo payment pending confirmation...
      {pending.map((p) => (
        <MomoPendingWatcher key={p.id} paymentId={p.id} onSettled={onSettled} />
      ))}
    </div>
  );
}

function MomoPendingWatcher({ paymentId, onSettled }: { paymentId: string; onSettled?: () => void }) {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const attempts = useRef(0);
  useEffect(() => {
    const run = async () => {
      attempts.current += 1;
      try {
        const r = await fetch(`/api/payments/momo/status/${paymentId}`);
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          const status = String(j?.status || '').toUpperCase();
          if (status === 'SUCCESSFUL') {
            if (onSettled) onSettled();
            const current = timer.current;
            if (current) {
              clearInterval(current);
            }
          }
          if (status === 'FAILED') {
            const current = timer.current;
            if (current) {
              clearInterval(current);
            }
          }
        }
      } catch {}
      if (attempts.current >= 48) { // stop after ~4 minutes
        const current = timer.current;
        if (current) {
          clearInterval(current);
        }
      }
    };
    timer.current = setInterval(run, 5000);
    run();
    return () => {
      const current = timer.current;
      if (current) {
        try { clearInterval(current); } catch {}
      }
    };
  }, [paymentId, onSettled]);
  return null;
}
