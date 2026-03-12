"use client";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { formatCurrency, formatDateTimeGH } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogClose } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useQuery as useRQ } from "@tanstack/react-query";
import { useParams, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import Image from "next/image";
import { ADMIN_PHONE } from "@/lib/config";
import { formatIdReadable } from "@/lib/utils";
import { chipToneClass, deliveryStatusTone } from "@/lib/status-chips";
import { useSession } from "next-auth/react";

type ReceiptOrder = {
  id: string;
  subtotal?: number | string;
  taxAmount?: number | string;
  total: number | string;
  amountPaid?: number | string;
  balance?: number | string;
  status: string;
  createdAt: string | Date;
  deliveryStatus?: string | null;
  walkInName?: string | null;
  adminNote?: string | null;
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
  const searchParams = useSearchParams();
  const receiptToken =
    searchParams?.get("receipt") || searchParams?.get("receiptHash") || "";
  const receiptQuery = receiptToken
    ? `?receipt=${encodeURIComponent(receiptToken)}`
    : "";
  const { data: session } = useSession();
  const { data, error } = useQuery({
    queryKey: ["order", orderId, receiptToken],
    queryFn: () => fetcher(`/api/orders/${orderId}${receiptQuery}`),
    enabled: !!orderId,
  });
  const order = (data as { data?: ReceiptOrder } | undefined)?.data;
  // Load account info for default email
  const { data: me } = useRQ({
    queryKey: ["account", "me"],
    queryFn: () => fetch("/api/account/me").then((r) => r.json()),
    staleTime: 15000,
  });
  const defaultEmail = String(me?.email || order?.user?.email || "");

  if (error) return <p className="p-6 text-center text-red-600">Failed to load receipt.</p>;
  if (!order) return <p className="p-6 text-center">Loading receipt...</p>;

  const subtotal = Number(order.subtotal ?? order.total ?? 0);
  const taxAmount = Number(order.taxAmount ?? 0);
  const lineTotal = (order.items || []).reduce(
    (sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0),
    0,
  );
  const discountAmount = Math.max(0, subtotal + taxAmount - Number(order.total || 0));
  const returnAdjustment = Math.max(0, lineTotal - subtotal);
  const paid = Number(order.amountPaid || 0);
  const rawBalance = Math.max(0, Number(order.total || 0) - paid);
  const balance = Math.abs(rawBalance) < 0.01 ? 0 : rawBalance;
  const deliveryLabel = (() => {
    const raw = String(order.deliveryStatus || "NOT_DELIVERED").toUpperCase();
    if (raw === "DELIVERED") return "Delivered";
    if (raw === "PARTIALLY_DELIVERED") return "Partially delivered";
    if (raw === "RETURNED") return "Returned";
    return "Not delivered";
  })();
  const customerDisplayName = order.user?.name || order.walkInName || "Walk-in";
  const anonymousReason = (() => {
    const raw = String(order.adminNote || "");
    const marker = "ANONYMOUS_OTC:";
    const idx = raw.indexOf(marker);
    if (idx < 0) return "";
    return raw.slice(idx + marker.length).trim().split(" | ")[0].trim();
  })();

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

  return (
    <div className="min-h-screen bg-muted/30 py-6 print:bg-white print:py-0">
      <div className="mx-auto w-full max-w-3xl px-4 print:px-0">
      {/* Screen-only actions */}
      <div className="flex flex-col gap-3 items-start justify-between mb-4 print:hidden sm:flex-row sm:items-center">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 w-full">
          <Button
            variant="secondary"
            className="w-full sm:w-auto"
            onClick={() => {
              if (!session) {
                window.location.href = `/login?callbackUrl=${encodeURIComponent("/orders")}`;
                return;
              }
              window.location.href = "/orders";
            }}
          >
            Back to Orders
          </Button>
          <div className="space-y-0.5">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Receipt</p>
            <h1 className="text-xl font-semibold break-words">
              Order {formatIdReadable(order.id)}
            </h1>
          </div>
        </div>
        <div className="flex flex-col gap-2 w-full sm:w-auto sm:flex-row sm:justify-end">
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => window.print()}>
            Print
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" className="w-full sm:w-auto">Email Receipt</Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
              <DialogHeader>
                <DialogTitle>Email Receipt</DialogTitle>
              </DialogHeader>
              <EmailForm orderId={orderId} defaultEmail={defaultEmail} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="border rounded-xl bg-card p-6 shadow-sm print:border-0 print:shadow-none">
        {/* Brand header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="flex items-center gap-3">
            <Image
              src="/logo.svg"
              alt="Noralls Medical Supplies"
              width={140}
              height={44}
              className="h-8 w-auto"
            />
            <div className="text-xs text-muted-foreground">
              <p className="font-semibold text-foreground">Noralls Medical Supplies</p>
              <p>Tel: {ADMIN_PHONE}</p>
            </div>
          </div>
          <div className="text-left sm:text-right text-xs text-muted-foreground">
            <p className="text-foreground font-semibold">Receipt</p>
            <p className="break-words">Order {formatIdReadable(order.id)}</p>
            <p>{formatDateTimeGH(order.createdAt)}</p>
          </div>
        </div>
        <div className="mt-6 grid gap-4 rounded-lg border bg-muted/30 p-4 text-sm sm:grid-cols-2">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Customer</p>
            <p className="font-medium">{customerDisplayName}</p>
            {order.user?.email ? (
              <p className="text-muted-foreground">{order.user.email}</p>
            ) : null}
            {!order.user?.name && anonymousReason ? (
              <p className="text-xs text-muted-foreground">Anonymous reason: {anonymousReason}</p>
            ) : null}
          </div>
          <div className="space-y-1 sm:text-right">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Order Status</p>
            <p className="font-medium">{order.status}</p>
            <p className="text-muted-foreground">Delivery: {deliveryLabel}</p>
          </div>
        </div>

        {/* Items list: mobile-friendly cards + desktop table */}
        <div className="mt-6">
          {/* Mobile: stacked item cards for clearer separation */}
          <div className="grid gap-3 lg:hidden print:hidden">
            {order.items.map((it) => (
              <div key={it.id} className="border rounded-lg p-3 text-sm bg-muted/20">
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
                      let statusKey = "NOT_DELIVERED";
                      let extra: string | null = null;
                      if (delivered >= qty && qty > 0) {
                        label = "Delivered";
                        statusKey = "DELIVERED";
                      } else if (delivered > 0) {
                        label = "Partial";
                        statusKey = "PARTIALLY_DELIVERED";
                        extra = `${delivered}/${qty}`;
                      }
                      const cls = chipToneClass(deliveryStatusTone(statusKey));
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
                </div>
              </div>
            ))}
          </div>

          {/* Desktop/tablet: keep tabular layout */}
          <div className="hidden lg:block print:block">
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="text-left py-2 px-3">Item</th>
                    <th className="text-right py-2 px-3">Qty</th>
                    <th className="text-right py-2 px-3">Delivered</th>
                    <th className="text-right py-2 px-3">Price</th>
                    <th className="text-right py-2 px-3">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {order.items.map((it) => (
                    <tr key={it.id} className="bg-background">
                      <td className="py-2 px-3">{it.product?.name || "Item"}</td>
                      <td className="text-right py-2 px-3">{it.quantity}</td>
                      <td className="text-right py-2 px-3">
                        {(() => {
                          const delivered = Number(it.deliveredQuantity ?? 0);
                          const qty = Number(it.quantity || 0);
                          if (!qty) return "0";
                          if (delivered <= 0) return "0";
                          if (delivered >= qty) return `${qty}`;
                          return `${delivered}/${qty}`;
                        })()}
                      </td>
                      <td className="text-right py-2 px-3">
                        {formatCurrency(Number(it.price))}
                      </td>
                      <td className="text-right py-2 px-3">
                        {formatCurrency(Number(it.price) * it.quantity)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="mt-6 text-sm">
          <div className="flex justify-end">
            <div className="w-full max-w-xs rounded-lg border bg-muted/20 p-4">
              <div className="flex justify-between py-1">
                <span>Taxable subtotal</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              {Math.abs(lineTotal - subtotal) > 0.005 ? (
                <div className="flex justify-between py-1">
                  <span>Items total</span>
                  <span>{formatCurrency(lineTotal)}</span>
                </div>
              ) : null}
              {taxAmount > 0 ? (
                <div className="flex justify-between py-1">
                  <span>Tax</span>
                  <span>{formatCurrency(taxAmount)}</span>
                </div>
              ) : null}
              {discountAmount > 0 ? (
                <div className="flex justify-between py-1 text-amber-700">
                  <span>Discount</span>
                  <span>-{formatCurrency(discountAmount)}</span>
                </div>
              ) : null}
              <div className="flex justify-between py-1">
                <span>Invoice total</span>
                <span>{formatCurrency(Number(order.total || 0))}</span>
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

        {balance <= 0 ? (
          <p className="mt-4 text-center text-xs text-muted-foreground">Thank you for your payment.</p>
        ) : null}
      </div>
    </div>
    </div>
  );
}

function EmailForm({ orderId, defaultEmail }: { orderId: string; defaultEmail?: string }) {
  const [email, setEmail] = React.useState<string>(defaultEmail || "");
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    if (defaultEmail) setEmail(defaultEmail);
  }, [defaultEmail]);
  const [sending, setSending] = React.useState(false);
  return (
    <div className="grid gap-3">
      <Input type="email" placeholder="customer@example.com" value={email} onChange={(e)=>setEmail(e.target.value)} />
      <div className="flex justify-end gap-2">
        <Button
          onClick={async () => {
            try {
              setSending(true);
              const r = await fetch(`/api/orders/${orderId}/receipt/email`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ to: email }) });
              const j = await r.json().catch(() => ({} as { error?: string; simulated?: boolean }));
              if (!r.ok) throw new Error(j?.error || "Failed to email receipt");
              toast.success(`Receipt emailed${j?.simulated ? ' (simulated)' : ''}`);
              // Auto-close and clear after success
              setEmail("");
              try { closeRef.current?.click(); } catch {}
            } catch (e: unknown) {
              const message =
                e instanceof Error ? e.message : "Email failed";
              toast.error(message);
            } finally {
              setSending(false);
            }
          }}
          disabled={!email || sending}
        >{sending ? 'Sending…' : 'Send'}</Button>
      </div>
      {/* Hidden close button to programmatically close the dialog */}
      <DialogClose asChild>
        <button ref={closeRef} className="hidden" aria-hidden="true" />
      </DialogClose>
    </div>
  );
}
