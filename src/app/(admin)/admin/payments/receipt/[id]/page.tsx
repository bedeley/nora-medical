"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { format } from "date-fns";
import { formatCurrency } from "@/lib/currency";
import { formatIdReadable } from "@/lib/utils";

type PaymentUser = { name?: string | null; email: string; phone?: string | null };

type PaymentMeta = {
  method?: string;
  reference?: string;
  receivedBy?: string;
  location?: string;
  status?: string;
  note?: string;
};

type AppliedRow = {
  orderId: string;
  applied: number;
  newAmountPaid: number;
  newBalance: number;
  newStatus: string;
};

type ReceiptData = {
  payment: { id: string; userId: string; user: PaymentUser; orderId?: string | null; amount: number; createdAt: string };
  meta: PaymentMeta;
  applied: AppliedRow[];
  totalsBefore: { totalDue: number; totalPaid: number; balance: number } | null;
  totals: { totalDue: number; totalPaid: number; balance: number };
  settlement: "FULL" | "PARTIAL" | "REFUND" | "VOID";
  delivery?: { orderId: string | null; deliveryStatus?: string; deliveredAt?: string | null } | null;
};

const normalizeBalance = (value: number) => (Math.abs(value) < 0.01 ? 0 : value);

export default function PaymentReceiptPage() {
  const params = useParams();
  const id = String(params?.id || "");
  const [data, setData] = useState<ReceiptData | null>(null);
  const [err, setErr] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<string>("");
  const [orderData, setOrderData] = useState<{
    id?: string;
    items?: Array<{ id: string; quantity: number; price: number | string; product?: { name?: string | null } | null }>;
  } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/admin/payments/receipt/${id}`);
        if (!res.ok) throw new Error("Failed to load receipt");
        const j = (await res.json()) as ReceiptData;
        if (active) setData(j);
        setTimeout(() => window.print(), 150);
      } catch (e: unknown) {
        if (!active) return;
        const message =
          e instanceof Error ? e.message : "Failed to load receipt";
        setErr(message);
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

  const singleOrderId =
    Array.isArray(data?.applied) && data?.applied.length === 1 ? data?.applied[0].orderId : null;

  useEffect(() => {
    let active = true;
    (async () => {
      if (!singleOrderId) return;
      try {
        const res = await fetch(`/api/orders/${singleOrderId}`);
        if (!res.ok) return;
        const j = await res.json();
        if (active) setOrderData(j?.data || null);
      } catch {
        // ignore order load errors
      }
    })();
    return () => {
      active = false;
    };
  }, [singleOrderId]);

  if (err) return <div className="p-6 text-red-600">{err}</div>;
  if (!data) return <div className="p-6 text-muted-foreground">Loading receipt…</div>;

  const { payment, meta, applied, totalsBefore, totals, settlement, delivery } = data;
  const createdAt = format(new Date(payment.createdAt), "PPpp");
  const displayBalance = normalizeBalance(Number(totals.balance || 0));

  return (
    <section className="container mx-auto py-8 max-w-2xl">
      <header className="mb-4">
        <h1 className="text-xl font-semibold">Payment Receipt</h1>
        <p className="text-sm text-muted-foreground">
          Receipt #{payment.id.slice(0,8)} • {createdAt}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4 text-sm mb-4">
        <div className="space-y-1">
          <p><strong>Customer:</strong> {payment.user?.name ? `${payment.user.name} (${payment.user.email})` : payment.user.email}</p>
          <p><strong>Method:</strong> {meta?.method || "—"}</p>
          <p><strong>Reference:</strong> {meta?.reference || "—"}</p>
        </div>
        <div className="space-y-1">
          <p><strong>Received By:</strong> {meta?.receivedBy || "—"}</p>
          <p><strong>Location:</strong> {meta?.location || "—"}</p>
          <p><strong>Status:</strong> {meta?.status || "normal"}</p>
        </div>
      </div>

      <div className="mb-4">
        <p className="text-lg"><strong>Amount:</strong> {formatCurrency(payment.amount)}</p>
        <p>
          <strong>Settlement:</strong> {settlement === "FULL" ? "Fully Paid" : settlement === "PARTIAL" ? "Partially Paid" : settlement === "REFUND" ? "Refund" : "Void"}
          {settlement !== "REFUND" && settlement !== "VOID" && (
            <span> • Remaining Balance: {formatCurrency(displayBalance)}</span>
          )}
        </p>
        {delivery && (
          <p>
            <strong>Delivery:</strong>{" "}
            {delivery.deliveryStatus === "DELIVERED"
              ? `Delivered${delivery.deliveredAt ? ` on ${new Date(delivery.deliveredAt).toLocaleString()}` : ""}`
              : delivery.deliveryStatus === "PARTIALLY_DELIVERED"
              ? "Partially Delivered"
              : "Not Delivered"}
          </p>
        )}
      </div>

      {applied && applied.length > 0 && (
        <div className="mb-4">
          <h2 className="font-medium mb-1">Applied To Orders</h2>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className="border px-2 py-1 text-left">Order</th>
                <th className="border px-2 py-1 text-right">Applied</th>
                <th className="border px-2 py-1 text-right">Order Paid</th>
                <th className="border px-2 py-1 text-right">Order Balance</th>
                <th className="border px-2 py-1 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {applied.map((a) => (
                <tr key={a.orderId}>
                  <td className="border px-2 py-1">
                    {formatIdReadable(a.orderId)}
                  </td>
                  <td className="border px-2 py-1 text-right">{formatCurrency(a.applied)}</td>
                  <td className="border px-2 py-1 text-right">{formatCurrency(a.newAmountPaid)}</td>
                  <td className="border px-2 py-1 text-right">{formatCurrency(normalizeBalance(a.newBalance))}</td>
                  <td className="border px-2 py-1">{a.newStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {orderData && (
        <div className="mb-4">
          <h2 className="font-medium mb-1">
            Items for Order {formatIdReadable(orderData.id)}
          </h2>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className="border px-2 py-1 text-left">Item</th>
                <th className="border px-2 py-1 text-right">Qty</th>
                <th className="border px-2 py-1 text-right">Price</th>
                <th className="border px-2 py-1 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {orderData.items?.map((it) => (
                <tr key={it.id}>
                  <td className="border px-2 py-1">{it.product?.name || 'Item'}</td>
                  <td className="border px-2 py-1 text-right">{it.quantity}</td>
                  <td className="border px-2 py-1 text-right">${Number(it.price).toFixed(2)}</td>
                  <td className="border px-2 py-1 text-right">${(Number(it.price) * it.quantity).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mb-2">
        <h2 className="font-medium mb-1">Account Summary</h2>
        {totalsBefore ? (
          <div className="text-sm space-y-0.5">
            <p>Before: Total Purchases {formatCurrency(totalsBefore.totalDue)} • Paid {formatCurrency(totalsBefore.totalPaid)} • Balance {formatCurrency(normalizeBalance(totalsBefore.balance))}</p>
            <p>Payment: {formatCurrency(payment.amount)}</p>
            <p>After: Total Purchases {formatCurrency(totals.totalDue)} • Paid {formatCurrency(totals.totalPaid)} • Balance {formatCurrency(displayBalance)}</p>
          </div>
        ) : (
          <p className="text-sm">Total Purchases: {formatCurrency(totals.totalDue)} • Total Paid: {formatCurrency(totals.totalPaid)} • Balance: {formatCurrency(displayBalance)}</p>
        )}
      </div>

      {meta?.note && <p className="text-xs text-muted-foreground">Note: {meta.note}</p>}

      <div className="mt-6 flex items-center gap-2 print:hidden">
        <button className="border rounded px-3 py-1 text-sm" onClick={() => window.print()}>Print</button>
        <button
          className="border rounded px-3 py-1 text-sm"
          disabled={sending}
          onClick={async () => {
            const defaultPhone = data?.payment.user?.phone || "";
            const to =
              window.prompt(
                "Enter phone number to text receipt:",
                defaultPhone || "+1"
              ) || "";
            if (!to) return;
            try {
              setSending(true);
              const res = await fetch(
                `/api/admin/payments/receipt/${payment.id}/text`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ to }),
                }
              );
              if (!res.ok) {
                const j = await res
                  .json()
                  .catch(async () => ({ error: await res.text().catch(() => "") }));
                throw new Error(j?.error || "Failed to send SMS");
              }
              setSendMsg("Receipt sent via SMS.");
              setTimeout(() => setSendMsg(""), 4000);
            } catch (e: unknown) {
              const message =
                e instanceof Error ? e.message : "Failed to send SMS";
              setSendMsg(message);
              setTimeout(() => setSendMsg(""), 5000);
            } finally {
              setSending(false);
            }
          }}
        >
          {sending ? "Sending…" : "Text Receipt"}
        </button>
        {sendMsg && <span className="text-xs text-muted-foreground">{sendMsg}</span>}
      </div>

      <style>{`@media print { body { -webkit-print-color-adjust: exact; } }`}</style>
    </section>
  );
}
