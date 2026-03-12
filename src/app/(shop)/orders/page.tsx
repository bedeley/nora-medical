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
import { chipToneBorderClass, chipToneClass, deliveryStatusTone, orderStatusTone, paymentStatusTone } from "@/lib/status-chips";
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
  subtotal?: number | string;
  taxAmount?: number | string;
  discountAmount?: number | string;
  total: number | string;
  amountPaid?: number | string;
  balance?: number | string;
  items: OrderItem[];
  payments: Payment[];
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function OrdersContent() {
  const queryClient = useQueryClient();
  const { data: session, status: sessionStatus } = useSession();

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
  const { data: balanceData } = useClientQuery({
    queryKey: ["balance", "self"],
    queryFn: () => fetcher("/api/balance?self=1"),
    enabled: !!session,
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
  });

  const [status, setStatus] = useState<string>("ALL");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [detailsOpen, setDetailsOpen] = useState<Record<string, boolean>>({});
  const searchParams = useSearchParams();
  const justPlaced = searchParams?.get("placed") === "1";

  const orders: Array<Order & { totalPaid: number; balance: number }> = useMemo(() => {
    const source = (data?.orders || []) as Order[];
    return source.map((o) => {
      const totalPaid = Number(o.amountPaid ?? 0);
      const rawBalance = Number(o.balance ?? Math.max(0, Number(o.total) - totalPaid));
      const balance = Math.abs(rawBalance) < 0.01 ? 0 : rawBalance;
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
    const outstanding = Math.max(0, active.reduce((s, o) => s + Number(o.balance), 0));
    return { totalOrders, outstanding };
  }, [orders]);

  const hasOutstanding = useMemo(
    () => orders.some((o) => o.status !== "CANCELLED" && Number(o.balance) > 0),
    [orders]
  );
  const openOrdersOldestFirst = useMemo(
    () =>
      [...orders]
        .filter((o) => o.status !== "CANCELLED" && Number(o.balance) > 0)
        .sort(
          (a, b) =>
            new Date(String(a.createdAt || "")).getTime() -
            new Date(String(b.createdAt || "")).getTime(),
        )
        .map((o) => ({
          id: o.id,
          balance: Number(o.balance || 0),
        })),
    [orders],
  );
  const preferredPhone = String((me?.phone ?? me?.user?.phone ?? "") as string).trim();

  const creditAvailable = Math.max(0, Number(balanceData?.unappliedFunds ?? 0));
  const cashRefunds = Math.max(0, Number(balanceData?.cashRefunds ?? 0));
  const notices = useMemo(() => {
    const items: Array<{ tone: "info" | "success" | "warning"; text: React.ReactNode }> = [];
    if (justPlaced || hasOutstanding) {
      items.push({
        tone: "warning",
        text: justPlaced ? (
          <>
            Order placed successfully. Please call{" "}
            <a href={ADMIN_PHONE_TEL} className="underline font-medium">
              {ADMIN_PHONE}
            </a>{" "}
            to confirm and complete payment.
          </>
        ) : (
          <>
            You have unpaid orders. Please call{" "}
            <a href={ADMIN_PHONE_TEL} className="underline font-medium">
              {ADMIN_PHONE}
            </a>{" "}
            to complete payment.
          </>
        ),
      });
    }
    if (creditAvailable > 0) {
      items.push({
        tone: "info",
        text: (
          <>
            Store credit available:{" "}
            <span className="font-semibold">{formatCurrency(creditAvailable)}</span>. This will be used automatically
            toward your oldest unpaid or partially-paid orders when you place new orders. If you would like credit
            applied to an existing balance right away, please contact the store admin.
          </>
        ),
      });
    }
    if (cashRefunds > 0) {
      items.push({
        tone: "success",
        text: (
          <>
            Cash refunds issued so far:{" "}
            <span className="font-semibold">{formatCurrency(cashRefunds)}</span>.
          </>
        ),
      });
    }
    return items;
  }, [justPlaced, hasOutstanding, creditAvailable, cashRefunds]);
  const anyExpanded = useMemo(() => Object.values(detailsOpen).some(Boolean), [detailsOpen]);

  useEffect(() => {
    if (!orders.length) return;
    setDetailsOpen((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const order of orders) {
        if (order.balance > 0 && order.status !== "CANCELLED") {
          if (!next[order.id]) {
            next[order.id] = true;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [orders]);

  if (sessionStatus === "unauthenticated") {
    if (typeof window !== "undefined") {
      window.location.href = `/login?callbackUrl=${encodeURIComponent(
        "/orders",
      )}`;
    }
    return null;
  }

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
        <p>You haven&apos;t placed any orders yet.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button asChild size="sm">
            <Link href="/products">Start shopping</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/contact">Contact us</Link>
          </Button>
        </div>
      </div>
    );

  return (
    <section className="orders-page mx-auto w-full max-w-6xl space-y-4 px-3 sm:px-4 lg:px-0">
      {notices.length > 0 && (
        <Card className="border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Account notices</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {notices.map((notice, idx) => {
              const cls =
                notice.tone === "warning"
                  ? `${chipToneClass("warning")} ${chipToneBorderClass("warning")}`
                  : notice.tone === "success"
                  ? `${chipToneClass("success")} ${chipToneBorderClass("success")}`
                  : `${chipToneClass("info")} ${chipToneBorderClass("info")}`;
              return (
                <div key={idx} className={`rounded-md border px-3 py-2 ${cls}`}>
                  {notice.text}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Order History</h1>
          <p className="text-sm text-muted-foreground">
            View your past orders and payment activity
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (anyExpanded) {
                setDetailsOpen({});
                return;
              }
              const next: Record<string, boolean> = {};
              for (const order of orders) {
                next[order.id] = true;
              }
              setDetailsOpen(next);
            }}
          >
            {anyExpanded ? "Collapse all" : "Expand all"}
          </Button>
        </div>
      </div>

      {summary.outstanding > 0 ? (
        <Card className="border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Pay All Open Balances</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Make one payment and we will apply it oldest-first across your unpaid or partially-paid orders.
            </p>
            <div className="text-sm">
              Outstanding across open orders:{" "}
              <span className="font-semibold text-red-600">
                {formatCurrency(summary.outstanding)}
              </span>
            </div>
            <MomoPayInline
              maxAmount={summary.outstanding}
              defaultPhone={preferredPhone || undefined}
              allocatableOrders={openOrdersOldestFirst}
              onSuccess={() => {
                queryClient.invalidateQueries({ queryKey: ["orders", "history"] });
                queryClient.invalidateQueries({ queryKey: ["balance", "self"] });
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <Card className="border">
          <CardContent className="py-4 text-sm text-green-700">
            No balance due.
          </CardContent>
        </Card>
      )}

      {filtered.map((order) => {
        const items = Array.isArray(order.items) ? order.items : [];
        const lineTotal = items.reduce(
          (sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0),
          0,
        );
        const subtotal = Number(order.subtotal ?? order.total ?? 0);
        const taxAmount = Number(order.taxAmount ?? 0);
        const netTotal = Number(order.total || 0);
        const discountAmount = Math.max(
          0,
          Number(order.discountAmount ?? subtotal + taxAmount - netTotal),
        );
        const returnAdjustment = Math.max(0, lineTotal - subtotal);
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
            className="border shadow-sm text-[12px]"
          >
            <CardHeader className="px-4 pb-1 pt-3">
              <CardTitle className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between text-[12px]">
                <span className="flex items-start gap-2 min-w-0">
                  <span className="min-w-0">
                    <div className="font-semibold break-all">Order {formatIdReadable(order.id)}</div>
                    <div className="text-[11px] text-muted-foreground">{formatDateGH(order.createdAt)}</div>
                  </span>
                  {(() => {
                    try {
                      const pending = (order.payments || []).some((p) => {
                        if (!p?.note) return false;
                        try { const m = JSON.parse(p.note); return m?.method === 'momo' && m?.status === 'pending'; } catch { return false; }
                      });
                      if (pending) {
                        const pendingClass = chipToneClass(paymentStatusTone("PENDING"));
                        return (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${pendingClass}`}>
                            MoMo Pending
                          </span>
                        );
                      }
                    } catch {}
                    return null;
                  })()}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  {(() => {
                    const sc = chipToneClass(orderStatusTone(order.status));
                    return (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${sc}`}>
                        {order.status}
                      </span>
                    );
                  })()}
                  {(() => {
                    const ds = String(order.deliveryStatus || "NOT_DELIVERED").toUpperCase();
                    let label = "Not delivered";
                    const cls = chipToneClass(deliveryStatusTone(ds));
                    if (ds === "DELIVERED") {
                      label = "Delivered";
                    } else if (ds === "PARTIALLY_DELIVERED") {
                      label = "Partially delivered";
                    } else if (ds === "RETURNED") {
                      label = "Returned";
                    }
                    return (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${cls}`}>
                        {label}
                      </span>
                    );
                  })()}
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                      order.balance > 0
                        ? `${chipToneClass("danger")} ${chipToneBorderClass("danger")}`
                        : `${chipToneClass("success")} ${chipToneBorderClass("success")}`
                    }`}
                  >
                    Balance {formatCurrency(Number(order.balance))}
                  </span>
                  {discountAmount > 0 ? (
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded-full border ${chipToneClass("warning")} ${chipToneBorderClass("warning")}`}
                    >
                      Discount -{formatCurrency(discountAmount)}
                    </span>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-[11px]"
                    onClick={() =>
                      setDetailsOpen((prev) => ({
                        ...prev,
                        [order.id]: !prev[order.id],
                      }))
                    }
                  >
                    {detailsOpen[order.id] ? "Hide details" : "View details"}
                  </Button>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1 px-4 pb-3 pt-0">
              {uniqueProducts.length > 0 && (
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between mb-1">
                  <div className="flex items-start gap-1.5">
                    <div className="flex flex-wrap gap-1.5 max-w-[176px] sm:max-w-none">
                      {uniqueProducts.slice(0, 3).map((it) => (
                        <div
                          key={it.product.id}
                          className="relative h-6 w-6 rounded-md bg-slate-100 border border-slate-200 overflow-hidden flex items-center justify-center"
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
                        <div className="h-6 w-6 rounded-md bg-slate-100 border border-slate-200 flex items-center justify-center text-[10px] text-slate-600">
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
                    className="px-3 py-1 text-[11px] self-start sm:self-auto"
                    title="View printable receipt"
                  >
                    <Link href={`/orders/${order.id}/receipt`}>View Receipt</Link>
                  </Button>
                </div>
              )}
              {detailsOpen[order.id] && (
                <>
              <div className="mt-1 grid gap-1 rounded-md border bg-muted/20 p-2 sm:grid-cols-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Items total</span>
                  <span>{formatCurrency(lineTotal)}</span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{formatCurrency(subtotal)}</span>
                </div>
                {taxAmount > 0 ? (
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Tax</span>
                    <span>{formatCurrency(taxAmount)}</span>
                  </div>
                ) : null}
                {discountAmount > 0 ? (
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Discount</span>
                    <span className="text-amber-700">-{formatCurrency(discountAmount)}</span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Invoice total</span>
                  <span>{formatCurrency(netTotal)}</span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">Paid</span>
                  <span>{formatCurrency(Number(order.totalPaid))}</span>
                </div>
                <div className="flex items-center justify-between text-[11px] font-semibold">
                  <span className="text-muted-foreground">Balance</span>
                  <span className={order.balance <= 0 ? "text-green-600" : "text-red-600"}>
                    {formatCurrency(Number(order.balance))}
                  </span>
                </div>
              </div>
              {returnAdjustment > 0.005 && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Note: Subtotal is lower than the original total because returned items reduced this
                  order by {formatCurrency(returnAdjustment)}.
                </p>
              )}
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
                        className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2 text-[11px]"
                      >
                        <span className="truncate sm:max-w-[220px]">
                          {it.product?.name || "Item"}{" "}
                          <span className="text-muted-foreground">
                            x{qty}
                          </span>
                        </span>
                        <div className="flex flex-col items-start sm:items-end gap-0.5">
                          {(() => {
                            let statusKey = "NOT_DELIVERED";
                            if (delivered >= qty && qty > 0) statusKey = "DELIVERED";
                            else if (delivered > 0) statusKey = "PARTIALLY_DELIVERED";
                            const deliveryClass = chipToneClass(deliveryStatusTone(statusKey));
                            return (
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] leading-tight sm:text-[11px] sm:whitespace-nowrap ${deliveryClass}`}
                              >
                            {delivered >= qty && qty > 0
                              ? "Delivered"
                              : delivered > 0
                              ? `Partially delivered (${delivered}/${qty})`
                              : "Not delivered yet"}
                              </span>
                            );
                          })()}
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
              {/* Simple timeline-style view (no duplicated payments) */}
              <div className="mt-2 border-t pt-2 space-y-1">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-medium">Order placed</span>
                  <span>{formatDateGH(order.createdAt)}</span>
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
                <div className="mt-2 grid gap-2 rounded-md border bg-muted/40 p-2.5">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">Pay outstanding balance</p>
                    <p className="text-sm text-red-600 font-semibold">{formatCurrency(Number(order.balance))}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Use Mobile Money (MoMo) or call{" "}
                    <a href={ADMIN_PHONE_TEL} className="underline font-medium">
                      {ADMIN_PHONE}
                    </a>{" "}
                    to arrange payment.
                  </p>
                  <MomoPayInline
                    orderId={order.id}
                    maxAmount={Number(order.balance)}
                    defaultPhone={preferredPhone || undefined}
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
                <div className="mt-2">
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
                    let creditFromReturns = 0;
                    for (const p of payments) {
                      const amount = Number(p.amount || 0);
                      if (!p.note) {
                        if (amount > 0) {
                          cashPaid += amount;
                        }
                        continue;
                      }
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
                        if (meta.reference === "ITEM_RETURN") {
                          if (amount > 0) creditFromReturns += amount;
                        }
                        if (meta.method === "momo") {
                          momoPaid += amount;
                        }
                        if (meta.method === "cash" || meta.method === "transfer") {
                          cashPaid += amount;
                        }
                      } catch {
                        if (amount > 0) {
                          cashPaid += amount;
                        }
                      }
                    }
                    if (
                      storeCreditApplied <= 0 &&
                      momoPaid <= 0 &&
                      cashPaid <= 0 &&
                      creditFromReturns <= 0
                    ) {
                      return (
                        <div className="text-sm text-muted-foreground">
                          <p>
                            No payment summary yet. If you just paid, it may take a moment to appear.
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button asChild size="sm" variant="outline">
                              <Link href="/contact">Contact support</Link>
                            </Button>
                            <Button asChild size="sm" variant="ghost">
                              <Link href="/orders">Refresh page</Link>
                            </Button>
                          </div>
                        </div>
                      );
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
                        {creditFromReturns > 0 && (
                          <p>
                            Store credit issued from item returns:{" "}
                            <span className="font-semibold">
                              {formatCurrency(creditFromReturns)}
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
              </>
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
          <p className="text-sm text-muted-foreground">Loading your orders...</p>
        </section>
      }
    >
      <OrdersContent />
    </Suspense>
  );
}

// Legacy payment formatting helpers and payment row typing have been removed
// to keep this page focused on high-level order summaries.

function MomoPayInline({
  orderId,
  maxAmount,
  defaultPhone,
  allocatableOrders,
  onSuccess,
}: {
  orderId?: string;
  maxAmount: number;
  defaultPhone?: string;
  allocatableOrders?: Array<{ id: string; balance: number }>;
  onSuccess?: () => void;
}) {
  const [phone, setPhone] = useState<string>("");
  const [normalized, setNormalized] = useState<string>("");
  const [amtStr, setAmtStr] = useState<string>(() => (Number(maxAmount) > 0 ? String(Number(maxAmount).toFixed(2)) : ""));
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phoneError, setPhoneError] = useState("");
  const [amountError, setAmountError] = useState("");

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
  const allocationPreview = useMemo(() => {
    if (orderId || !allocatableOrders?.length) {
      return { allocations: [] as Array<{ orderId: string; apply: number; before: number; after: number }>, unallocated: 0 };
    }
    const amountToApply = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : 0;
    let remaining = amountToApply;
    const allocations: Array<{ orderId: string; apply: number; before: number; after: number }> = [];
    for (const o of allocatableOrders) {
      if (remaining <= 0.0001) break;
      const before = Math.max(0, Number(o.balance || 0));
      if (before <= 0) continue;
      const apply = Math.min(before, remaining);
      const after = Math.max(0, before - apply);
      allocations.push({ orderId: o.id, apply, before, after });
      remaining -= apply;
    }
    return { allocations, unallocated: Math.max(0, remaining) };
  }, [orderId, allocatableOrders, parsedAmount]);

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
        setPhoneError("Enter a valid phone number.");
        return;
      }
      const amt = parsedAmount;
      if (!(amt > 0)) {
        setAmountError(`Enter 0.01 - ${formatCurrency(Number(maxAmount) || 0)}`);
        return;
      }
      setPhoneError("");
      setAmountError("");
      const res = await fetch("/api/payments/momo/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(orderId ? { orderId } : {}), phone: phoneToUse, provider: "mtn", amount: amt }),
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
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-start">
        <div className="grid gap-1">
        {showSavedPhoneChoice ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Saved phone: <span className="font-medium text-foreground">{savedPhoneNormalized}</span></span>
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => setPhone(savedPhoneNormalized)}
            >
              Use this number
            </button>
          </div>
        ) : null}
        <Input
          type="tel"
          inputMode="tel"
          placeholder="MoMo number (e.g., 0241234567 or +23324...)"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            if (phoneError) setPhoneError("");
          }}
          onBlur={() => setNormalized(normalizePhone(phone))}
          className={`max-w-xs ${phoneError ? "border-red-500" : ""}`}
          aria-invalid={!!phoneError}
        />
        {phoneError && <span className="text-xs text-red-600">{phoneError}</span>}
        {(phone || normalized || showSavedPhoneChoice) && (
          <div className="flex flex-wrap gap-2 text-xs">
            {phone && !isValidPhone(phone) && (
              <span className="text-red-600">Enter a valid phone number</span>
            )}
            {showSavedPhoneChoice && phone !== savedPhoneNormalized && (
              <span className="text-muted-foreground">Tip: tap &quot;Use this number&quot;.</span>
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
            GHS
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
              if (amountError) setAmountError("");
            }}
            className={`w-full pl-10 ${amountError ? "border-red-500" : ""}`}
            aria-invalid={!!amountError}
          />
        </div>
        {amountError ? (
          <span className="text-xs text-red-600">{amountError}</span>
        ) : amountInvalid ? (
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
        <div className="flex flex-wrap gap-2">
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogTrigger asChild>
            <Button
              size="sm"
              disabled={loading || !isValidPhone(phone) || amountInvalid}
            >
              {loading ? 'Processing...' : 'Pay with MoMo'}
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
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
            <div className="mt-4 flex flex-wrap justify-end gap-2">
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
      {!orderId && allocatableOrders && allocatableOrders.length > 0 ? (
        <div className="rounded-md border bg-muted/20 p-3 text-xs space-y-2">
          <div className="font-medium">Allocation preview (oldest orders first)</div>
          {allocationPreview.allocations.length === 0 ? (
            <div className="text-muted-foreground">Enter amount to preview allocations.</div>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_auto] gap-x-3 text-[11px] font-medium text-muted-foreground">
                <span>Order</span>
                <span>Apply (before -&gt; after)</span>
              </div>
              {allocationPreview.allocations.map((row) => (
                <div
                  key={`alloc-${row.orderId}`}
                  className="grid grid-cols-[1fr_auto] gap-x-3 border-t pt-1 first:border-0 first:pt-0"
                >
                  <span className="truncate">Order {formatIdReadable(row.orderId)}</span>
                  <span className="text-right">
                    {formatCurrency(row.apply)} ({formatCurrency(row.before)} -&gt; {formatCurrency(row.after)})
                  </span>
                </div>
              ))}
              <div className="border-t pt-1 flex items-center justify-between">
                <span>Total to allocate</span>
                <span className="font-medium">
                  {formatCurrency(
                    allocationPreview.allocations.reduce((sum, item) => sum + Number(item.apply || 0), 0),
                  )}
                </span>
              </div>
              {allocationPreview.unallocated > 0.005 ? (
                <div className="text-amber-700">
                  Unallocated remainder: {formatCurrency(allocationPreview.unallocated)}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
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
    <div className={`text-xs rounded border px-2 py-1 ${chipToneClass("warning")} ${chipToneBorderClass("warning")}`}>
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

