"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import Image from "next/image";
import { Loader2, Package, Printer, MessageSquareText } from "lucide-react";
import { ADMIN_PHONE } from "@/lib/config";
import { formatCurrency } from "@/lib/currency";
import { formatIdReadable } from "@/lib/utils";
import { chipToneBorderClass, chipToneClass, orderStatusTone } from "@/lib/status-chips";

interface OrderDetailsProps {
  orderId: string;
}

const fetcher = async (url: string) => {
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message =
      (data as { error?: string })?.error || "Failed to load order details.";
    throw new Error(message);
  }
  return data;
};

type OrderItem = {
  id: string;
  quantity: number;
  price: number;
  deliveredQuantity?: number;
  returnedQuantity?: number;
  product: { name: string; imageUrl: string | null } | null;
};

type OrderPayload = {
  id: string;
  status: string;
  deliveryStatus: "NOT_DELIVERED" | "PARTIALLY_DELIVERED" | "DELIVERED" | "RETURNED";
  deliveredAt: string | Date | null;
  total: number;
  amountPaid?: number;
  balance?: number;
  createdAt: string | Date;
  updatedAt?: string | Date;
  adminNote?: string | null;
  user?: { name: string | null; email: string | null } | null;
  items: OrderItem[];
  payments?: Array<{
    id: string;
    amount: number | string;
    note: string | null;
    status: string;
    createdAt: string | Date;
  }>;
};

export default function OrderDetails({ orderId }: OrderDetailsProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data, error, isLoading } = useClientQuery<{ data: OrderPayload }>({
    queryKey: ["order", orderId],
    queryFn: () => fetcher(`/api/orders/${orderId}`),
    refetchInterval: 30000,
    enabled: !!orderId,
  });

  const [updating, setUpdating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deliveryUpdating, setDeliveryUpdating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [returningItem, setReturningItem] = useState<OrderItem | null>(null);
  const [returnQuantity, setReturnQuantity] = useState<string>("1");
  const [returnSubmitting, setReturnSubmitting] = useState(false);
  const [returnQtyError, setReturnQtyError] = useState("");
  const [restockReturnToStock, setRestockReturnToStock] = useState(true);
  const [deliveryItem, setDeliveryItem] = useState<OrderItem | null>(null);
  const [deliveryMode, setDeliveryMode] = useState<"delivered" | "partial">("delivered");
  const [deliveryQty, setDeliveryQty] = useState<string>("1");
  const [deliveryItemSubmitting, setDeliveryItemSubmitting] = useState(false);
  const [deliveryQtyError, setDeliveryQtyError] = useState("");

  useEffect(() => {
    if (!confirmCancel) {
      setCancelError("");
    }
  }, [confirmCancel]);

  useEffect(() => {
    if (!returningItem) {
      setReturnQtyError("");
    }
  }, [returningItem]);

  useEffect(() => {
    if (!deliveryItem) {
      setDeliveryQtyError("");
    }
  }, [deliveryItem]);

  if (isLoading)
    return (
      <div className="flex justify-center items-center py-10">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );

  if (error || !data || !data.data)
    return (
      <p className="text-center text-red-500 py-10">
        Failed to load order details.
      </p>
    );

  const order = data.data;
  const isUnpaid =
    Number(order.balance ?? (order.total - (order.amountPaid ?? 0))) > 0 &&
    order.status !== "PAID" &&
    order.status !== "CANCELLED";
  const amountPaid = Number(order.amountPaid ?? 0);
  const balance = Number(order.balance ?? Math.max(0, order.total - amountPaid));
  const lineTotal = order.items.reduce(
    (sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0),
    0,
  );
  const returnAdjustment = Math.max(0, lineTotal - Number(order.total || 0));
  const allDelivered = order.items.every(
    (item) => (item.deliveredQuantity ?? 0) >= item.quantity
  );

  const paymentBreakdown = (() => {
    const payments = order.payments || [];
    let storeCreditApplied = 0;
    let momoPaid = 0;
    let cashPaid = 0;
    for (const p of payments) {
      const amount = Number(p.amount || 0);
      if (!p.note) {
        if (
          amount > 0 &&
          typeof p.status === "string" &&
          p.status.toUpperCase() === "NORMAL"
        ) {
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
        if (meta.method === "momo") {
          momoPaid += amount;
        }
        if (meta.method === "cash" || meta.method === "transfer") {
          cashPaid += amount;
        }
      } catch {
        if (
          amount > 0 &&
          typeof p.status === "string" &&
          p.status.toUpperCase() === "NORMAL"
        ) {
          cashPaid += amount;
        }
      }
    }
    return { storeCreditApplied, momoPaid, cashPaid };
  })();

  const notificationSummary = (() => {
    const payments = order.payments || [];
    let hasPaymentRecorded = false;
    let hasStoreCreditIssued = false;
    let hasStoreCreditRefunded = false;

    for (const p of payments) {
      if (!p.note) continue;
      try {
        const meta = JSON.parse(p.note as string) as {
          reference?: string;
          status?: string;
          refundDisposition?: string | null;
        };
        if (
          typeof p.amount === "number" &&
          p.amount > 0 &&
          (p.status || "").toUpperCase() === "NORMAL"
        ) {
          hasPaymentRecorded = true;
        }
        if (
          meta.reference === "AUTO_APPLY" ||
          (meta.status === "normal" && meta.refundDisposition === "CREDIT")
        ) {
          hasStoreCreditIssued = true;
        }
        if ((p.status || "").toUpperCase() === "REFUND") {
          hasStoreCreditRefunded = true;
        }
      } catch {
        // ignore malformed notes
      }
    }

    return { hasPaymentRecorded, hasStoreCreditIssued, hasStoreCreditRefunded };
  })();

  const paymentLedger = (() => {
    const payments = order.payments || [];
    const rows = payments.map((p) => {
      let method = "unknown";
      let provider = "";
      let reference = "";
      if (p.note) {
        try {
          const meta = JSON.parse(p.note as string) as {
            method?: string;
            provider?: string;
            reference?: string;
          };
          if (meta.method) method = meta.method;
          if (meta.provider) provider = meta.provider;
          if (meta.reference) reference = meta.reference;
        } catch {
          // ignore malformed notes
        }
      }
      return {
        ...p,
        method,
        provider,
        reference,
        createdAt: new Date(p.createdAt),
      };
    });
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  })();
  const ledgerTotal = paymentLedger.reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const timelineEvents = (() => {
    const events: Array<{ time: Date; label: string; detail?: string }> = [];
    const createdAt = new Date(order.createdAt);
    events.push({ time: createdAt, label: "Order created" });
    if (order.deliveredAt && order.deliveryStatus !== "NOT_DELIVERED") {
      events.push({
        time: new Date(order.deliveredAt),
        label: `Delivery updated (${order.deliveryStatus})`,
      });
    }
    for (const p of paymentLedger) {
      const amount = Number(p.amount || 0);
      const status = String(p.status || "").toUpperCase();
      const isRefund = status === "REFUND" || amount < 0;
      const method = p.method || "unknown";
      const ref = p.reference ? ` · Ref ${p.reference}` : "";
      events.push({
        time: p.createdAt,
        label: isRefund ? "Payment refund" : "Payment received",
        detail: `${formatCurrency(Math.abs(amount))} via ${method}${ref}`,
      });
    }
    return events.sort((a, b) => b.time.getTime() - a.time.getTime());
  })();

  async function updateStatus(
    newStatus: string,
    opts?: { restockReturned?: boolean; cancelReason?: string },
  ) {
    try {
      if (newStatus === "CANCELLED") {
        const reason = String(opts?.cancelReason || "").trim();
        if (reason.length < 5) {
          setCancelError("Please add a brief cancellation reason.");
          return;
        }
      }
      setUpdating(true);
      setCancelError("");
      const res = await fetch(`/api/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: newStatus,
          ...(opts?.restockReturned ? { restockReturned: true } : {}),
          ...(opts?.cancelReason ? { cancelReason: opts.cancelReason } : {}),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Failed to update status");
        return;
      }

      queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      toast.success(`Order marked as ${newStatus}`);
    } catch (err) {
      console.error(err);
      toast.error("Unexpected error updating order.");
    } finally {
      setUpdating(false);
    }
  }

  async function updateDelivery(
    newDelivery: "NOT_DELIVERED" | "PARTIALLY_DELIVERED" | "DELIVERED" | "RETURNED",
  ) {
    try {
      setDeliveryUpdating(true);
      const res = await fetch(`/api/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryStatus: newDelivery }),
      });
      if (!res.ok) {
        const err = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
        toast.error(err?.error || "Failed to update delivery status");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      toast.success(
        newDelivery === "DELIVERED"
          ? "Order marked as Delivered"
          : newDelivery === "PARTIALLY_DELIVERED"
          ? "Order marked as Partially Delivered"
          : newDelivery === "RETURNED"
          ? "Order marked as Returned"
          : "Marked as Not Delivered",
      );
    } catch (err) {
      console.error(err);
      toast.error("Unexpected error updating delivery.");
    } finally {
      setDeliveryUpdating(false);
    }
  }

  async function deleteOrder() {
    try {
      setDeleting(true);
      const res = await fetch(`/api/orders/${orderId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        toast.error("Failed to delete order");
        return;
      }

      const deletedId = orderId;
      toast.warning("Order deleted", {
        action: {
          label: "Undo",
          onClick: async () => {
            const restore = await fetch(`/api/orders/${deletedId}`, { method: "POST" });
            if (!restore.ok) {
              const j = await restore.json().catch(async () => ({ error: await restore.text().catch(() => "") }));
              toast.error(j?.error || "Failed to restore order");
              return;
            }
            toast.success("Order restored");
            router.push(`/admin/orders/${deletedId}`);
          },
        },
      });
      router.push("/admin/orders");
    } catch (err) {
      console.error(err);
      toast.error("Unexpected error deleting order");
    } finally {
      setDeleting(false);
    }
  }

  async function submitItemReturn() {
    if (!returningItem) return;
    const qty = Number(returnQuantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      setReturnQtyError("Enter a valid quantity to return.");
      return;
    }
    setReturnQtyError("");
    try {
      setReturnSubmitting(true);
      const res = await fetch(`/api/admin/orders/${orderId}/return-item`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: returningItem.id,
          quantity: qty,
          refundMode: "credit",
          restock: restockReturnToStock,
        }),
      });
      const j = await res
        .json()
        .catch(async () => ({ error: await res.text().catch(() => "") }));
      if (!res.ok) {
        toast.error(j?.error || "Failed to process item return");
        return;
      }
      toast.success("Item return processed.");
      setReturningItem(null);
      setReturnQuantity("1");
      queryClient.invalidateQueries({ queryKey: ["order", orderId] });
    } catch (e) {
      console.error(e);
      toast.error("Unexpected error processing item return.");
    } finally {
      setReturnSubmitting(false);
    }
  }

  async function submitItemDelivery() {
    if (!deliveryItem) return;
    const mode = deliveryMode;
    let qty: number | undefined;
    if (mode === "partial") {
      qty = Number(deliveryQty);
      if (!Number.isInteger(qty) || qty < 0) {
        setDeliveryQtyError("Enter a valid delivered quantity.");
        return;
      }
      if (qty > deliveryItem.quantity) {
        setDeliveryQtyError("Delivered quantity cannot exceed ordered quantity.");
        return;
      }
    }
    setDeliveryQtyError("");
    try {
      setDeliveryItemSubmitting(true);
      const res = await fetch(`/api/admin/orders/${orderId}/item-delivery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: deliveryItem.id,
          mode,
          ...(typeof qty === "number" ? { quantity: qty } : {}),
        }),
      });
      const j = await res
        .json()
        .catch(async () => ({ error: await res.text().catch(() => "") }));
      if (!res.ok) {
        toast.error(j?.error || "Failed to update item delivery");
        return;
      }
      toast.success("Item delivery updated.");
      setDeliveryItem(null);
      setDeliveryQty("1");
      setDeliveryMode("delivered");
      queryClient.invalidateQueries({ queryKey: ["order", orderId] });
    } catch (e) {
      console.error(e);
      toast.error("Unexpected error updating item delivery.");
    } finally {
      setDeliveryItemSubmitting(false);
    }
  }

  return (
    <Card className="max-w-4xl mx-auto w-full">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <CardTitle className="text-lg font-semibold flex items-center gap-2 min-w-0 max-w-full">
          <Package className="w-5 h-5 text-primary shrink-0" />
          <span className="truncate">
            Order {formatIdReadable(order.id)}
          </span>
        </CardTitle>

        <div className="flex flex-wrap gap-2 justify-start sm:justify-end w-full">
          <span className="text-[11px] text-muted-foreground self-center">
            Updated {new Date(order.updatedAt || order.createdAt).toLocaleString()}
          </span>
          <span
            className={`inline-flex items-center px-2 py-1 text-xs rounded-full border ${
              chipToneClass(orderStatusTone(order.status))
            }`}
          >
            {order.status}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                disabled={updating || deleting || order.status === "CANCELLED"}
              >
                Actions
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  const delivery = order.deliveryStatus || "NOT_DELIVERED";
                  if (
                    delivery === "DELIVERED" ||
                    delivery === "PARTIALLY_DELIVERED"
                  ) {
                    toast.error(
                      "Change delivery status to Returned before cancelling this order.",
                    );
                    return;
                  }
                  setConfirmCancel(true);
                }}
                disabled={updating || deleting || order.status === "CANCELLED"}
              >
                Cancel order
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setConfirmDelete(true)}
                disabled={deleting}
              >
                Delete order
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push(`/admin/audit?entityType=ORDER&entityId=${order.id}`)}
          >
            Audit Log
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(`/admin/orders/${orderId}/receipt`, "_blank")}
          >
            <Printer className="w-4 h-4 mr-1" />
            Print Receipt
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              try {
                const res = await fetch(`/api/orders/${orderId}/receipt/sms`, { method: "POST" });
                const j = await res
                  .json()
                  .catch(async () => ({ error: await res.text().catch(() => "") }));
                if (!res.ok) {
                  throw new Error(j?.error || "Failed to send receipt");
                }
                toast.success("Receipt sent via WhatsApp/SMS or Email");
              } catch (e: unknown) {
                const message =
                  e instanceof Error ? e.message : "Could not send receipt";
                toast.error(message);
              }
            }}
          >
            <MessageSquareText className="w-4 h-4 mr-1" />
            Send WhatsApp/SMS
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const r = await fetch(`/api/orders/${orderId}/receipt/email`, {
                  method: "POST",
                });
                const j = await r.json().catch(() => ({} as { error?: string }));
                if (!r.ok) throw new Error(j?.error || "Failed to email receipt");
                toast.success("Receipt emailed");
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
      </CardHeader>

      <CardContent className="space-y-6">
        {isUnpaid && (
          <div className="rounded-md border border-yellow-300 bg-yellow-50 text-yellow-800 p-3 text-sm">
            Unpaid order. Customer sees instructions to call {ADMIN_PHONE} to complete payment.
          </div>
        )}
        <div>
          {timelineEvents.length > 0 ? (
            <div className="mb-4 rounded-lg border bg-muted/40 p-3">
              <h3 className="text-sm font-semibold">Activity Timeline</h3>
              <ul className="mt-2 space-y-2 text-xs">
                {timelineEvents.map((event, idx) => (
                  <li key={`${event.time.toISOString()}-${idx}`} className="flex items-start gap-2">
                    <span className="mt-0.5 h-2 w-2 rounded-full bg-primary/70" />
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{event.label}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {event.time.toLocaleString()}
                        </span>
                      </div>
                      {event.detail ? (
                        <div className="text-[11px] text-muted-foreground">
                          {event.detail}
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-sm text-muted-foreground">
            <strong>Status:</strong> {order.status}
          </p>
          <p className="text-sm text-muted-foreground">
            <strong>Delivery:</strong>{" "}
            {order.deliveryStatus === "DELIVERED"
              ? "Delivered"
              : order.deliveryStatus === "PARTIALLY_DELIVERED"
              ? "Partially Delivered"
              : order.deliveryStatus === "RETURNED"
              ? "Returned"
              : "Not Delivered"}
            {order.deliveredAt ? ` on ${new Date(order.deliveredAt).toLocaleString()}` : ""}
          </p>
          <p className="text-sm text-muted-foreground">
            <strong>Total:</strong> {formatCurrency(lineTotal)}
          </p>
          <p className="text-sm text-muted-foreground">
            <strong>Subtotal:</strong> {formatCurrency(order.total)}
          </p>
          <p className="text-sm text-muted-foreground">
            <strong>Amount Paid:</strong> {formatCurrency(amountPaid)}
          </p>
          {(paymentBreakdown.cashPaid > 0 ||
            paymentBreakdown.momoPaid > 0 ||
            paymentBreakdown.storeCreditApplied > 0) && (
            <p className="text-xs text-muted-foreground mt-1">
              {paymentBreakdown.cashPaid > 0 && (
                <>
                  Cash/transfer: {formatCurrency(paymentBreakdown.cashPaid)}{" "}
                </>
              )}
              {paymentBreakdown.momoPaid > 0 && (
                <>
                  {paymentBreakdown.cashPaid > 0 ? "· " : ""}
                  MoMo: {formatCurrency(paymentBreakdown.momoPaid)}{" "}
                </>
              )}
              {paymentBreakdown.storeCreditApplied > 0 && (
                <>
                  {paymentBreakdown.cashPaid > 0 ||
                  paymentBreakdown.momoPaid > 0
                    ? "· "
                    : ""}
                  Store credit: {formatCurrency(paymentBreakdown.storeCreditApplied)}
                </>
              )}
            </p>
          )}
          <div
            className={`mt-2 rounded-md border px-3 py-2 text-sm font-medium ${
              balance > 0
                ? `${chipToneClass("danger")} ${chipToneBorderClass("danger")}`
                : `${chipToneClass("success")} ${chipToneBorderClass("success")}`
            }`}
          >
            Outstanding Balance: {formatCurrency(balance)}
          </div>
          <div className="mt-3">
            <h3 className="text-sm font-semibold">Payments Ledger</h3>
            {paymentLedger.length === 0 ? (
              <div className="text-xs text-muted-foreground mt-1">
                <p>No payments recorded for this order yet.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button asChild size="sm">
                    <Link href={`/admin/orders?q=${order.id}`}>Record payment</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/admin/orders">View all orders</Link>
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-xs whitespace-nowrap">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-1 pr-4">Date</th>
                      <th className="text-left py-1 pr-4">Method</th>
                      <th className="text-left py-1 pr-4">Provider</th>
                      <th className="text-left py-1 pr-4">Reference</th>
                      <th className="text-right py-1 pr-4">Amount</th>
                      <th className="text-right py-1 pr-4">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentLedger.map((p) => (
                      <tr key={p.id} className="border-t">
                        <td className="py-1 pr-4">{p.createdAt.toLocaleString()}</td>
                        <td className="py-1 pr-4">{p.method}</td>
                        <td className="py-1 pr-4">{p.provider || "-"}</td>
                        <td className="py-1 pr-4">{p.reference || "-"}</td>
                        <td className="py-1 pr-4 text-right">
                          {formatCurrency(Number(p.amount || 0))}
                        </td>
                        <td className="py-1 pr-4 text-right">{p.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {paymentLedger.length > 0 ? (
              <p className="text-xs text-muted-foreground mt-2">
                Ledger total: {formatCurrency(ledgerTotal)}{" "}
                {Math.abs(ledgerTotal - amountPaid) < 0.01
                  ? "— matches Amount Paid"
                  : `— does not match Amount Paid (${formatCurrency(amountPaid)})`}
              </p>
            ) : null}
          </div>
          {returnAdjustment > 0.005 && (
            <p className="text-xs text-muted-foreground mt-1">
              Note: Subtotal is lower than the original total because returned items reduced this order by{" "}
              {formatCurrency(returnAdjustment)}.
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            <strong>Date:</strong> {new Date(order.createdAt).toLocaleString()}
          </p>
          <p className="text-sm text-muted-foreground">
            <strong>Customer:</strong>{" "}
            {order.user ? (
              <>
                {order.user.name} ({order.user.email})
              </>
            ) : (
              <span className="text-muted-foreground">Unknown</span>
            )}
          </p>
          {order.adminNote ? (
            <p className="text-sm text-muted-foreground">
              <strong>Admin Note:</strong> {order.adminNote}
            </p>
          ) : null}

          <div className="mt-4 border-t pt-3">
            <h3 className="text-sm font-semibold mb-1">Customer Notifications</h3>
            <p className="text-xs text-muted-foreground">
              Notifications are sent automatically when orders are created, payments are
              recorded, store credit is issued/refunded, or delivery status changes.
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              <li>
                <span className="font-medium">Order confirmation:</span>{" "}
                {order.createdAt
                  ? "Sent when this order was created."
                  : "Not available"}
              </li>
              <li>
                <span className="font-medium">Payments received:</span>{" "}
                {notificationSummary.hasPaymentRecorded
                  ? "At least one payment notification has been sent."
                  : (
                    <>
                      No payment notifications detected yet.{" "}
                      <Link href="/admin/settings/communications" className="underline">
                        Check comms settings
                      </Link>
                      .
                    </>
                  )}
              </li>
              <li>
                <span className="font-medium">Store credit issued:</span>{" "}
                {notificationSummary.hasStoreCreditIssued
                  ? "Customer has been notified about store credit on their account."
                  : (
                    <>
                      No store-credit notifications detected.{" "}
                      <Link href="/admin/settings/communications" className="underline">
                        Check comms settings
                      </Link>
                      .
                    </>
                  )}
              </li>
              <li>
                <span className="font-medium">Store credit refunded:</span>{" "}
                {notificationSummary.hasStoreCreditRefunded
                  ? "Customer has been notified about a credit refund."
                  : (
                    <>
                      No credit-refund notifications detected.{" "}
                      <Link href="/admin/settings/communications" className="underline">
                        Check comms settings
                      </Link>
                      .
                    </>
                  )}
              </li>
              <li>
                <span className="font-medium">Delivery status:</span>{" "}
                {order.deliveryStatus === "DELIVERED" ||
                order.deliveryStatus === "PARTIALLY_DELIVERED" ||
                order.deliveryStatus === "RETURNED"
                  ? "Customer has been notified about the latest delivery update."
                  : (
                    <>
                      No delivery notifications yet (status is Not Delivered).{" "}
                      <Link href="/admin/orders" className="underline">
                        View orders
                      </Link>
                      .
                    </>
                  )}
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t pt-4">
          <h3 className="text-sm font-semibold mb-3">Items</h3>
          <div className="grid gap-3">
            {order.items.map((item) => (
              <div
                key={item.id}
                className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border rounded-lg p-3"
              >
                <div className="flex items-start gap-3 w-full sm:w-auto">
                  <div className="relative w-16 h-16 shrink-0">
                    <Image
                      src={item.product?.imageUrl || "/placeholder.png"}
                      alt={item.product?.name || "Product"}
                      fill
                      className="object-cover rounded"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{item.product?.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Qty: {item.quantity} · {formatCurrency(item.price)}
                      {typeof item.returnedQuantity === "number" &&
                      item.returnedQuantity > 0 ? (
                        <span className="ml-2 text-[11px] text-muted-foreground">
                          Returned: {item.returnedQuantity}
                        </span>
                      ) : null}
                      {typeof item.deliveredQuantity === "number" &&
                      item.deliveredQuantity > 0 ? (
                        <span className="ml-2 text-[11px] text-muted-foreground">
                          Delivered: {item.deliveredQuantity}/{item.quantity}
                        </span>
                      ) : (
                        <span className="ml-2 text-[11px] text-muted-foreground">
                          Delivered: 0/{item.quantity}
                        </span>
                      )}
                    </p>
                  </div>
                </div>

                <div className="flex flex-col items-end gap-2 w-full sm:w-auto">
                  <p className="font-semibold">
                    {formatCurrency(item.quantity * item.price)}
                  </p>
                  <div className="flex flex-wrap gap-2 justify-end w-full">
                    <Button
                      variant="outline"
                      size="sm"
                      className="px-2"
                      disabled={
                        order.status === "CANCELLED" ||
                        deliveryItemSubmitting ||
                        (item.deliveredQuantity ?? 0) >= item.quantity
                      }
                      onClick={() => {
                        setDeliveryItem(item);
                        setDeliveryMode("delivered");
                        setDeliveryQty(String(item.quantity));
                      }}
                    >
                      Mark delivered
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="px-2"
                      disabled={
                        order.status === "CANCELLED" ||
                        deliveryItemSubmitting ||
                        (item.deliveredQuantity ?? 0) >= item.quantity
                      }
                      onClick={() => {
                        setDeliveryItem(item);
                        setDeliveryMode("partial");
                        const remaining =
                          item.quantity -
                          (item.deliveredQuantity ?? 0);
                        setDeliveryQty(
                          String(
                            remaining > 0 ? remaining : item.quantity,
                          ),
                        );
                      }}
                    >
                      Partial
                    </Button>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="px-2"
                    disabled={
                      order.status === "CANCELLED" ||
                      returnSubmitting ||
                      (typeof item.deliveredQuantity === "number"
                        ? item.deliveredQuantity -
                            (item.returnedQuantity ?? 0) <=
                          0
                        : (item.returnedQuantity ?? 0) >= item.quantity)
                    }
                    onClick={() => {
                      const delivered = item.deliveredQuantity ?? 0;
                      const alreadyReturned = item.returnedQuantity ?? 0;
                      const maxReturnable = Math.max(
                        0,
                        delivered - alreadyReturned,
                      );
                      if (maxReturnable <= 0) {
                        toast.info(
                          "No delivered units are available to return for this item.",
                        );
                        return;
                      }
                      setReturningItem(item);
                      setReturnQuantity("1");
                      setRestockReturnToStock(true);
                    }}
                  >
                    Return item
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>

      <CardFooter className="justify-end">
        <div className="flex flex-col md:flex-row gap-2 w-full md:w-auto md:items-center md:justify-end">
          <div className="flex flex-wrap gap-2 w-full md:w-auto md:justify-end">
            <Button
              variant={order.deliveryStatus === "DELIVERED" ? "default" : "outline"}
              size="sm"
              disabled={
                deliveryUpdating ||
                deleting ||
                order.deliveryStatus === "RETURNED" ||
                order.status === "CANCELLED" ||
                allDelivered
              }
              onClick={() => updateDelivery("DELIVERED")}
            >
              {deliveryUpdating ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Mark Delivered
            </Button>
          </div>
          <Button
            variant="secondary"
            onClick={() => router.push("/admin/orders")}
          >
            Back to Orders
          </Button>
        </div>
      </CardFooter>
      <Dialog
        open={confirmCancel}
        onOpenChange={(o) => {
          if (!o) {
            setConfirmCancel(false);
            setCancelReason("");
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Cancel Order</DialogTitle>
          </DialogHeader>
          {order.deliveryStatus === "RETURNED" ? (
            <>
              <p className="text-sm text-muted-foreground">
                This order has been marked as <strong>Returned</strong>. When cancelling,
                do you want to add the returned items back into inventory?
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                If you choose to restock, product stock levels will be increased and a
                RETURN inventory movement will be recorded. This does not automatically
                refund any payments.
              </p>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Cancellation reason</label>
                <Input
                  value={cancelReason}
                  onChange={(e) => {
                    setCancelReason(e.target.value);
                    if (cancelError) setCancelError("");
                  }}
                  placeholder="e.g., duplicate order / customer request"
                  aria-invalid={!!cancelError}
                  className={cancelError ? "border-red-500" : ""}
                />
                {cancelError && <p className="text-xs text-red-600">{cancelError}</p>}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setConfirmCancel(false);
                    setCancelReason("");
                  }}
                  disabled={updating}
                >
                  Close
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setConfirmCancel(false);
                    updateStatus("CANCELLED", { cancelReason });
                    setCancelReason("");
                  }}
                  disabled={updating}
                >
                  Cancel only (no restock)
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirmCancel(false);
                    updateStatus("CANCELLED", { restockReturned: true, cancelReason });
                    setCancelReason("");
                  }}
                  disabled={updating}
                >
                  Cancel &amp; Restock
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Are you sure you want to mark this order as cancelled? This does not
                automatically refund payments.
              </p>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Cancellation reason</label>
                <Input
                  value={cancelReason}
                  onChange={(e) => {
                    setCancelReason(e.target.value);
                    if (cancelError) setCancelError("");
                  }}
                  placeholder="e.g., customer request / stock issue"
                  aria-invalid={!!cancelError}
                  className={cancelError ? "border-red-500" : ""}
                />
                {cancelError && <p className="text-xs text-red-600">{cancelError}</p>}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setConfirmCancel(false);
                    setCancelReason("");
                  }}
                  disabled={updating}
                >
                  No
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirmCancel(false);
                    updateStatus("CANCELLED", { cancelReason });
                    setCancelReason("");
                  }}
                  disabled={updating}
                >
                  Yes, cancel
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={confirmDelete} onOpenChange={(o) => { if (!o) setConfirmDelete(false); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Delete Order</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will permanently remove the order and its history. Continue?
          </p>
              <p className="text-xs text-muted-foreground">
                Only orders with no payments and no delivery can be deleted.
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                setConfirmDelete(false);
                deleteOrder();
              }}
              disabled={deleting}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deliveryItem}
        onOpenChange={(open) => {
          if (!open) {
            setDeliveryItem(null);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              {deliveryMode === "partial"
                ? "Update item partial delivery"
                : "Mark item delivered"}
            </DialogTitle>
          </DialogHeader>
          {deliveryItem && (
            <>
              <p className="text-sm text-muted-foreground mb-2">
                {deliveryItem.product?.name} · $
                {deliveryItem.price.toFixed(2)} each
              </p>
              {deliveryMode === "partial" ? (
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">
                      Units delivered
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={deliveryItem.quantity}
                      value={deliveryQty}
                      onChange={(e) => {
                        setDeliveryQty(e.target.value);
                        if (deliveryQtyError) setDeliveryQtyError("");
                      }}
                      aria-invalid={!!deliveryQtyError}
                      className={`w-full border rounded px-2 py-1 text-sm ${deliveryQtyError ? "border-red-500" : ""}`}
                    />
                    {deliveryQtyError && (
                      <p className="text-xs text-red-600 mt-1">{deliveryQtyError}</p>
                    )}
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Ordered: {deliveryItem.quantity}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  This will mark all {deliveryItem.quantity} unit(s) as
                  delivered for this item.
                </p>
              )}
              <DialogFooter className="mt-4">
                <Button
                  variant="outline"
                  onClick={() => setDeliveryItem(null)}
                  disabled={deliveryItemSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  onClick={submitItemDelivery}
                  disabled={deliveryItemSubmitting}
                >
                  {deliveryItemSubmitting ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : null}
                  Save
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!returningItem}
        onOpenChange={(open) => {
          if (!open) {
            setReturningItem(null);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Return item</DialogTitle>
          </DialogHeader>
          {returningItem && (
            <>
              <p className="text-sm text-muted-foreground mb-2">
                {returningItem.product?.name} · $
                {returningItem.price.toFixed(2)} each
              </p>
              <div className="flex flex-col gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Quantity to return
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={
                      Math.max(
                        0,
                        (returningItem.deliveredQuantity ?? 0) -
                          (returningItem.returnedQuantity ?? 0),
                      )
                    }
                    value={returnQuantity}
                    onChange={(e) => {
                      setReturnQuantity(e.target.value);
                      if (returnQtyError) setReturnQtyError("");
                    }}
                    aria-invalid={!!returnQtyError}
                    className={`w-full border rounded px-2 py-1 text-sm ${returnQtyError ? "border-red-500" : ""}`}
                  />
                  {returnQtyError && (
                    <p className="text-xs text-red-600 mt-1">{returnQtyError}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Available to return (delivered units not yet
                    returned):{" "}
                    {Math.max(
                      0,
                      (returningItem.deliveredQuantity ?? 0) -
                        (returningItem.returnedQuantity ?? 0),
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    Returns for this item are refunded as{" "}
                    <span className="font-medium">store credit</span>. If the
                    customer prefers cash instead, please contact the accounts
                    team so their store credit can be converted and refunded.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="restock-return"
                    type="checkbox"
                    className="h-3 w-3"
                    checked={restockReturnToStock}
                    onChange={(e) => setRestockReturnToStock(e.target.checked)}
                  />
                  <label
                    htmlFor="restock-return"
                    className="text-xs text-muted-foreground"
                  >
                    Add returned units back into inventory
                  </label>
                </div>
              </div>
              <DialogFooter className="mt-4">
                <Button
                  variant="outline"
                  onClick={() => setReturningItem(null)}
                  disabled={returnSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  onClick={submitItemReturn}
                  disabled={returnSubmitting}
                >
                  {returnSubmitting ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : null}
                  Process return
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
