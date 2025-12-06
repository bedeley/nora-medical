"use client";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { formatCurrency, formatDateTimeGH } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogClose } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useQuery as useRQ } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import Image from "next/image";
import { ADMIN_PHONE } from "@/lib/config";
import { formatIdReadable } from "@/lib/utils";

type ReceiptOrder = {
  id: string;
  total: number | string;
  amountPaid?: number | string;
  balance?: number | string;
  status: string;
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
  const { data, error } = useQuery({
    queryKey: ["order", orderId],
    queryFn: () => fetcher(`/api/orders/${orderId}`),
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

  const total = Number(order.total || 0);
  const paid = Number(order.amountPaid || 0);
  const balance = Math.max(0, total - paid);

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

  return (
    <div className="mx-auto max-w-2xl p-6 print:p-0">
      {/* Screen-only actions */}
      <div className="flex flex-col gap-3 items-start justify-between mb-4 print:hidden sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => { window.location.href = '/orders'; }}>Back to Orders</Button>
          <h1 className="text-xl font-semibold">Receipt</h1>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end w-full sm:w-auto">
          <Button variant="outline" onClick={() => window.print()}>Print</Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Email Receipt</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Email Receipt</DialogTitle>
              </DialogHeader>
              <EmailForm orderId={orderId} defaultEmail={defaultEmail} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="border rounded p-6 print:border-0">
        {/* Brand header */}
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
            <p>Customer: {order.user?.name || ''}</p>
            {order.user?.email ? <p className="text-muted-foreground">{order.user.email}</p> : null}
          </div>
          <div className="text-right space-y-0.5">
            <p>Date: {formatDateTimeGH(order.createdAt)}</p>
            <p>Status: {order.status}</p>
            {order.deliveryStatus ? (
              <p>Delivery: {order.deliveryStatus}</p>
            ) : null}
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
                  <div className="flex justify-between col-span-2">
                    <span className="text-muted-foreground">Delivery</span>
                    {(() => {
                      const delivered = Number(it.deliveredQuantity ?? 0);
                      const qty = Number(it.quantity || 0);
                      let label = "Not delivered yet";
                      let cls = "bg-slate-100 text-slate-700";
                      if (delivered >= qty && qty > 0) {
                        label = "Delivered";
                        cls = "bg-emerald-100 text-emerald-700";
                      } else if (delivered > 0) {
                        label = `Partially delivered (${delivered}/${qty})`;
                        cls = "bg-amber-100 text-amber-800";
                      }
                      return (
                        <span className={`px-2 py-0.5 rounded-full text-[11px] ${cls}`}>
                          {label}
                        </span>
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
                    <td className="text-right py-2">
                      {formatCurrency(Number(it.price))}
                    </td>
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
                <span>Subtotal</span>
                <span>{formatCurrency(total)}</span>
              </div>
              <div className="flex justify-between py-1">
                <span>Paid</span>
                <span>{formatCurrency(paid)}</span>
              </div>
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
              <div className="flex justify-between py-1 font-semibold">
                <span>Balance</span>
                <span>{formatCurrency(balance)}</span>
              </div>
            </div>
          </div>
        </div>

        {balance === 0 ? (
          <p className="mt-4 text-center text-xs text-muted-foreground">Thank you for your payment.</p>
        ) : null}
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
