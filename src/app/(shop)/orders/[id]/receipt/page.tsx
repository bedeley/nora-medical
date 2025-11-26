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
    product?: { name?: string | null } | null;
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

  return (
    <div className="mx-auto max-w-2xl p-6 print:p-0">
      {/* Screen-only actions */}
      <div className="flex items-center justify-between mb-4 print:hidden">
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => { window.location.href = '/orders'; }}>Back to Orders</Button>
          <h1 className="text-xl font-semibold">Receipt</h1>
        </div>
        <div className="flex gap-2">
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
                  <td className="py-2">{it.product?.name || 'Item'}</td>
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
