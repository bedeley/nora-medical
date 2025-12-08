"use client";

export const dynamic = "force-dynamic";

import { useClientQuery } from "@/hooks/use-client-query";
import { useEffect } from "react";
import { formatCurrency, formatDateTimeGH } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import Image from "next/image";
import { ADMIN_PHONE } from "@/lib/config";
import { formatIdReadable } from "@/lib/utils";

type ReceiptOrder = {
  id: string;
  status: string;
  total: number | string;
  amountPaid?: number | string;
  balance?: number | string;
  createdAt: string | Date;
  deliveryStatus?: string | null;
  user?: { name?: string | null; email?: string | null } | null;
  items: Array<{
    id: string;
    quantity: number;
    price: number | string;
    deliveredQuantity?: number;
    returnedQuantity?: number;
    product?: { name?: string | null } | null;
  }>;
  payments?: Array<{
    id: string;
    amount: number | string;
    note: string | null;
    status: string;
    createdAt: string | Date;
  }>;
};

const fetcher = async (u: string) => {
  const r = await fetch(u);
  const j = (await r.json().catch(() => ({} as { error?: string; data?: ReceiptOrder })));
  if (!r.ok) throw new Error(j?.error || "Failed to load order");
  return j;
};

export default function ReceiptPage() {
  const params = useParams();
  const orderId = String((params as { id?: string }).id || "");
  // Ensure app chrome is hidden even if Providers fails route detection
  useEffect(() => {
    try { document.body.classList.add('hide-chrome'); } catch {}
    return () => { try { document.body.classList.remove('hide-chrome'); } catch {} };
  }, []);
  const { data, error } = useClientQuery<{ data?: ReceiptOrder }>({
    queryKey: ["order", orderId],
    queryFn: () => fetcher(`/api/orders/${orderId}`),
    enabled: !!orderId,
  });
  const order = data?.data;

  useEffect(() => {
    if (!order) return;
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, [order]);

  if (error) return <p className="p-6 text-center text-red-600">Failed to load receipt.</p>;
  if (!order) return <p className="p-6 text-center">Loading receipt...</p>;

  const subtotal = Number(order.total || 0);
  const lineTotal = (order.items || []).reduce(
    (sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0),
    0,
  );
  const returnAdjustment = Math.max(0, lineTotal - subtotal);
  const paid = Number(order.amountPaid || 0);
  const balance = Math.max(0, subtotal - paid);

  const storeCreditApplied = (() => {
    const payments = order.payments || [];
    if (!payments.length) return 0;
    let sum = 0;
    for (const p of payments) {
      if (!p.note) continue;
      try {
        const meta = JSON.parse(p.note) as {
          reference?: string;
          applied?: Array<{ orderId?: string; applied?: number }>;
        };
        if (meta?.reference !== "AUTO_APPLY" || !Array.isArray(meta.applied)) {
          continue;
        }
        for (const a of meta.applied) {
          if (!a || a.orderId !== order.id) continue;
          sum += Number(a.applied || 0);
        }
      } catch {
        // ignore malformed notes
      }
    }
    return sum;
  })();

  const momoPaid = (() => {
    const payments = order.payments || [];
    if (!payments.length) return 0;
    let sum = 0;
    for (const p of payments) {
      if (!p.note) continue;
      try {
        const meta = JSON.parse(p.note) as { method?: string };
        if (meta?.method === "momo") {
          sum += Number(p.amount || 0);
        }
      } catch {
        // ignore malformed notes
      }
    }
    return sum;
  })();

  const creditFromReturns = (() => {
    const payments = order.payments || [];
    if (!payments.length) return 0;
    let sum = 0;
    for (const p of payments) {
      if (!p.note) continue;
      try {
        const meta = JSON.parse(p.note) as { reference?: string; orderId?: string };
        if (meta?.reference === "ITEM_RETURN") {
          const amt = Number(p.amount || 0);
          if (amt > 0) sum += amt;
        }
      } catch {
        // ignore malformed notes
      }
    }
    return sum;
  })();

  const deliveryLabel = (() => {
    const raw = String(order.deliveryStatus || "NOT_DELIVERED").toUpperCase();
    if (raw === "DELIVERED") return "Delivered";
    if (raw === "PARTIALLY_DELIVERED") return "Partially delivered";
    if (raw === "RETURNED") return "Returned";
    return "Not delivered";
  })();

  const cashPaid = (() => {
    const payments = order.payments || [];
    if (!payments.length) return 0;
    let sum = 0;
    for (const p of payments) {
      const amount = Number(p.amount || 0);
      if (!p.note) {
        if (
          amount > 0 &&
          typeof p.status === "string" &&
          p.status.toUpperCase() === "NORMAL"
        ) {
          sum += amount;
        }
        continue;
      }
      try {
        const meta = JSON.parse(p.note) as { method?: string };
        if (meta?.method === "cash" || meta?.method === "transfer") {
          sum += amount;
        }
      } catch {
        if (
          amount > 0 &&
          typeof p.status === "string" &&
          p.status.toUpperCase() === "NORMAL"
        ) {
          sum += amount;
        }
      }
    }
    return sum;
  })();

  return (
    <div className="mx-auto max-w-2xl p-6 print:p-0">
      {/* Screen-only actions */}
      <div className="flex items-center justify-between mb-4 print:hidden">
        <h1 className="text-xl font-semibold">Receipt</h1>
        <div className="flex gap-2">
            <Button variant="outline" onClick={() => window.print()}>Print</Button>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                const r = await fetch(`/api/orders/${orderId}/receipt/email`, {
                  method: "POST",
                });
                const j = await r.json().catch(() => ({} as { error?: string; simulated?: boolean }));
                if (!r.ok) throw new Error(j?.error || "Failed to email receipt");
                toast.success(`Receipt emailed${j?.simulated ? " (simulated)" : ""}`);
              } catch (e: unknown) {
                const message =
                  e instanceof Error ? e.message : "Email failed";
                toast.error(message);
              }
            }}
          >
            Email Receipt
          </Button>
        </div>
      </div>

      <div className="border rounded p-6 print:border-0">
        {/* Brand header for print */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image src="/logo.svg" alt="Noralls Medical Supplies" width={150} height={48} />
          </div>
          <div className="text-right text-xs">
            <p className="font-semibold">Noralls Medical Supplies</p>
            <p className="text-muted-foreground">Tel: {ADMIN_PHONE}</p>
            <p className="text-muted-foreground">
              Order {formatIdReadable(order.id)}
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 text-sm">
          <div className="space-y-0.5">
            <p>Customer: {order.user?.name || ""}</p>
            {/* Optional: show email if present */}
            {order.user?.email ? <p className="text-muted-foreground">{order.user.email}</p> : null}
          </div>
          <div className="text-right space-y-0.5">
            <p>Date: {formatDateTimeGH(order.createdAt)}</p>
            <p>Status: {order.status}</p>
            <p>Delivery: {deliveryLabel}</p>
          </div>
        </div>

        {/* Items list: mobile-friendly cards + desktop table */}
        <div className="mt-6">
          {/* Mobile: stacked item cards for clearer separation */}
          <div className="grid gap-3 md:hidden">
            {order.items.map((it) => (
              <div key={it.id} className="border rounded-md p-3 text-sm">
                <div className="font-medium">
                  {it.product?.name || "Item"}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Qty</span>
                    <span className="font-medium">{it.quantity}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Price</span>
                    <span>{formatCurrency(Number(it.price))}</span>
                  </div>
                  <div className="flex justify-between col-span-2">
                    <span className="text-muted-foreground">Total</span>
                    <span className="font-semibold">
                      {formatCurrency(Number(it.price) * it.quantity)}
                    </span>
                  </div>
                  <div className="flex flex-col items-start gap-1 col-span-2">
                    <span className="text-muted-foreground">Delivery</span>
                    {(() => {
                      const delivered = Number(it.deliveredQuantity ?? 0);
                      const qty = Number(it.quantity || 0);
                      let label = "Not delivered yet";
                      let cls = "bg-slate-100 text-slate-700";
                      let extra: string | null = null;
                      if (delivered >= qty && qty > 0) {
                        label = "Delivered";
                        cls = "bg-emerald-100 text-emerald-700";
                      } else if (delivered > 0) {
                        label = "Partial";
                        extra = `${delivered}/${qty}`;
                        cls = "bg-amber-100 text-amber-800";
                      }
                      return (
                        <div className="flex flex-col items-end gap-0.5 w-full">
                          <span
                            className={`inline-flex max-w-full items-center justify-center px-1.5 py-0.5 rounded-full text-[10px] leading-tight ${cls}`}
                          >
                            {label}
                          </span>
                          {extra && (
                            <span className="text-[10px] text-muted-foreground break-words">
                              Delivered: {extra}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  {Number(it.returnedQuantity ?? 0) > 0 && (
                    <div className="flex justify-between col-span-2">
                      <span className="text-muted-foreground">Returns</span>
                      {(() => {
                        const returned = Number(it.returnedQuantity ?? 0);
                        const delivered = Number(it.deliveredQuantity ?? 0);
                        const qty = Number(it.quantity || 0);
                        if (returned >= delivered && delivered > 0) {
                          return (
                            <span className="px-2 py-0.5 rounded-full text-[11px] bg-gray-200 text-gray-700">
                              All delivered units returned ({returned})
                            </span>
                          );
                        }
                        return (
                          <span className="px-2 py-0.5 rounded-full text-[11px] bg-gray-200 text-gray-700">
                            {returned} of {qty} returned
                          </span>
                        );
                      })()}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Desktop/tablet: keep tabular layout */}
          <div className="hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2">Item</th>
                  <th className="text-right py-2">Qty</th>
                  <th className="text-right py-2">Delivered</th>
                  <th className="text-right py-2">Price</th>
                  <th className="text-right py-2">Total</th>
                  <th className="text-right py-2">Returns</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((it) => (
                  <tr key={it.id} className="border-b last:border-0">
                    <td className="py-2">{it.product?.name || "Item"}</td>
                    <td className="text-right py-2">{it.quantity}</td>
                    <td className="text-right py-2">
                      {(() => {
                        const delivered = Number(it.deliveredQuantity ?? 0);
                        const qty = Number(it.quantity || 0);
                        if (!qty) return "0";
                        if (delivered <= 0) return "0";
                        if (delivered >= qty) return `${qty}`;
                        return `${delivered}/${qty}`;
                      })()}
                    </td>
                    <td className="text-right py-2">{formatCurrency(Number(it.price))}</td>
                    <td className="text-right py-2">
                      {formatCurrency(Number(it.price) * it.quantity)}
                    </td>
                    <td className="text-right py-2 text-xs">
                      {(() => {
                        const returned = Number(it.returnedQuantity ?? 0);
                        const delivered = Number(it.deliveredQuantity ?? 0);
                        const qty = Number(it.quantity || 0);
                        if (returned <= 0) return "—";
                        if (returned >= delivered && delivered > 0) {
                          return `All delivered returned (${returned})`;
                        }
                        return `${returned} of ${qty} returned`;
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-6 text-sm">
          <div className="flex justify-end">
            <div className="w-64">
              <div className="flex justify-between py-1">
                <span>Total</span>
                <span>{formatCurrency(lineTotal)}</span>
              </div>
              <div className="flex justify-between py-1">
                <span>Subtotal</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between py-1">
                <span>Paid</span>
                <span>{formatCurrency(paid)}</span>
              </div>
              {cashPaid > 0 && (
                <div className="flex justify-between py-1 text-xs text-muted-foreground">
                  <span>Paid in cash/transfer</span>
                  <span>{formatCurrency(cashPaid)}</span>
                </div>
              )}
              {storeCreditApplied > 0 && (
                <div className="flex justify-between py-1 text-xs text-muted-foreground">
                  <span>Paid from store credit</span>
                  <span>{formatCurrency(storeCreditApplied)}</span>
                </div>
              )}
              {momoPaid > 0 && (
                <div className="flex justify-between py-1 text-xs text-muted-foreground">
                  <span>Paid via MoMo</span>
                  <span>{formatCurrency(momoPaid)}</span>
                </div>
              )}
              {creditFromReturns > 0 && (
                <div className="flex justify-between py-1 text-xs text-muted-foreground">
                  <span>Store credit issued from item returns</span>
                  <span>{formatCurrency(creditFromReturns)}</span>
                </div>
              )}
              <div className="flex justify-between py-1 font-semibold">
                <span>Balance</span>
                <span>{formatCurrency(balance)}</span>
              </div>
              {returnAdjustment > 0.005 && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Note: Subtotal is lower than the original total because returned items reduced this order by{" "}
                  {formatCurrency(returnAdjustment)}.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Optional note for paid orders */}
        {balance === 0 ? (
          <p className="mt-4 text-center text-xs text-muted-foreground">Thank you for your payment.</p>
        ) : null}
      </div>
    </div>
  );
}
