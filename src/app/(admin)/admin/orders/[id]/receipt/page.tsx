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

type ReceiptOrder = {
  id: string;
  status: string;
  total: number | string;
  amountPaid?: number | string;
  balance?: number | string;
  createdAt: string | Date;
  deliveryStatus?: string | null;
  user?: { name?: string | null; email?: string | null } | null;
  items: Array<{ id: string; quantity: number; price: number | string; product?: { name?: string | null } | null }>;
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
            <Image src="/logo.svg" alt="Nora Hospital Supplies" width={150} height={48} />
          </div>
          <div className="text-right text-xs">
            <p className="font-semibold">Nora Hospital Supplies</p>
            <p className="text-muted-foreground">Tel: {ADMIN_PHONE}</p>
            <p className="text-muted-foreground">Order #{order.id}</p>
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
            {order.deliveryStatus ? (
              <p>Delivery: {order.deliveryStatus}</p>
            ) : null}
          </div>
        </div>

        <div className="mt-4 text-sm">
          <p>Customer: {order.user?.name || ""}</p>
        </div>

        <div className="mt-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2">Item</th>
                <th className="text-right py-2">Qty</th>
                <th className="text-right py-2">Price</th>
                <th className="text-right py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((it) => (
                <tr key={it.id} className="border-b last:border-0">
                  <td className="py-2">{it.product?.name || "Item"}</td>
                  <td className="text-right py-2">{it.quantity}</td>
                  <td className="text-right py-2">{formatCurrency(Number(it.price))}</td>
                  <td className="text-right py-2">{formatCurrency(Number(it.price) * it.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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

        {/* Optional note for paid orders */}
        {balance === 0 ? (
          <p className="mt-4 text-center text-xs text-muted-foreground">Thank you for your payment.</p>
        ) : null}
      </div>
    </div>
  );
}
