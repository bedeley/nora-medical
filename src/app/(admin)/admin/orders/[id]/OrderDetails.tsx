"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import Image from "next/image";
import { Loader2, Package, Trash2, Printer, MessageSquareText } from "lucide-react";
import { ADMIN_PHONE } from "@/lib/config";

interface OrderDetailsProps {
  orderId: string;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type OrderItem = {
  id: string;
  quantity: number;
  price: number;
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

  if (isLoading)
    return (
      <div className="flex justify-center items-center py-10">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );

  if (error || !data)
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

  const paymentBreakdown = (() => {
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
    return { storeCreditApplied, momoPaid, cashPaid };
  })();

  async function updateStatus(
    newStatus: string,
    opts?: { restockReturned?: boolean },
  ) {
    try {
      setUpdating(true);
      const res = await fetch(`/api/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: newStatus,
          ...(opts?.restockReturned ? { restockReturned: true } : {}),
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

      toast.success("Order deleted successfully");
      router.push("/admin/orders");
    } catch (err) {
      console.error(err);
      toast.error("Unexpected error deleting order");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card className="max-w-4xl mx-auto w-full">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <CardTitle className="flex items-center gap-2 min-w-0 max-w-full">
          <Package className="w-5 h-5 text-primary shrink-0" />
          <span className="truncate">Order #{order.id}</span>
        </CardTitle>

        <div className="flex flex-wrap gap-2 justify-start sm:justify-end w-full">
          {["PENDING_PAYMENT", "PAID", "CANCELLED"].map((s) => (
            <Button
              key={s}
              variant={order.status === s ? "default" : "outline"}
              size="sm"
              onClick={() => {
                if (s === "CANCELLED") {
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
                  return;
                }
                updateStatus(s);
              }}
              disabled={
                updating ||
                deleting ||
                order.status === s ||
                order.status === "CANCELLED"
              }
            >
              {updating && order.status !== s ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : null}
              {s}
            </Button>
          ))}

          <Button
            variant="destructive"
            size="sm"
            disabled={deleting}
            onClick={() => setConfirmDelete(true)}
          >
            {deleting ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4 mr-1" />
            )}
            Delete
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
            <strong>Total:</strong> ${order.total.toFixed(2)}
          </p>
          <p className="text-sm text-muted-foreground">
            <strong>Amount Paid:</strong> ${amountPaid.toFixed(2)}
          </p>
          {(paymentBreakdown.cashPaid > 0 ||
            paymentBreakdown.momoPaid > 0 ||
            paymentBreakdown.storeCreditApplied > 0) && (
            <p className="text-xs text-muted-foreground mt-1">
              {paymentBreakdown.cashPaid > 0 && (
                <>
                  Cash/transfer: ${paymentBreakdown.cashPaid.toFixed(2)}{" "}
                </>
              )}
              {paymentBreakdown.momoPaid > 0 && (
                <>
                  {paymentBreakdown.cashPaid > 0 ? "· " : ""}
                  MoMo: ${paymentBreakdown.momoPaid.toFixed(2)}{" "}
                </>
              )}
              {paymentBreakdown.storeCreditApplied > 0 && (
                <>
                  {paymentBreakdown.cashPaid > 0 ||
                  paymentBreakdown.momoPaid > 0
                    ? "· "
                    : ""}
                  Store credit: $
                  {paymentBreakdown.storeCreditApplied.toFixed(2)}
                </>
              )}
            </p>
          )}
          <p className={`text-sm ${balance > 0 ? "text-red-600" : "text-green-700"}`}>
            <strong>Outstanding Balance:</strong> ${balance.toFixed(2)}
          </p>
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
        </div>

        <div className="border-t pt-4">
          <h3 className="font-semibold mb-3">Items</h3>
          <div className="grid gap-3">
            {order.items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between border rounded-lg p-3"
              >
                <div className="flex items-center gap-3">
                  <div className="relative w-16 h-16">
                    <Image
                      src={item.product?.imageUrl || "/placeholder.png"}
                      alt={item.product?.name || "Product"}
                      fill
                      className="object-cover rounded"
                    />
                  </div>
                  <div>
                    <p className="font-medium">{item.product?.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Qty: {item.quantity} A- ${item.price.toFixed(2)}
                    </p>
                  </div>
                </div>

                <p className="font-semibold">
                  ${(item.quantity * item.price).toFixed(2)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </CardContent>

      <CardFooter className="justify-end">
          <div className="flex flex-col md:flex-row gap-2 w-full md:w-auto md:items-center md:justify-end">
          <div className="flex gap-2">
            <Button
              variant={order.deliveryStatus === "PARTIALLY_DELIVERED" ? "default" : "outline"}
              size="sm"
              disabled={
                deliveryUpdating ||
                deleting ||
                order.deliveryStatus === "RETURNED" ||
                order.status === "CANCELLED"
              }
              onClick={() => updateDelivery("PARTIALLY_DELIVERED")}
            >
              {deliveryUpdating ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Mark Partial Delivery
            </Button>
            <Button
              variant={order.deliveryStatus === "DELIVERED" ? "default" : "outline"}
              size="sm"
              disabled={
                deliveryUpdating ||
                deleting ||
                order.deliveryStatus === "RETURNED" ||
                order.status === "CANCELLED"
              }
              onClick={() => updateDelivery("DELIVERED")}
            >
              {deliveryUpdating ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Mark Delivered
            </Button>
            <Button
              variant={order.deliveryStatus === "RETURNED" ? "default" : "outline"}
              size="sm"
              disabled={deliveryUpdating || deleting || order.status === "CANCELLED"}
              onClick={() => updateDelivery("RETURNED")}
            >
              {deliveryUpdating ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Mark Returned
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
      <Dialog open={confirmCancel} onOpenChange={(o) => { if (!o) setConfirmCancel(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel Order</DialogTitle>
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
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setConfirmCancel(false)}
                  disabled={updating}
                >
                  Close
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setConfirmCancel(false);
                    updateStatus("CANCELLED");
                  }}
                  disabled={updating}
                >
                  Cancel only (no restock)
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirmCancel(false);
                    updateStatus("CANCELLED", { restockReturned: true });
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
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setConfirmCancel(false)}
                  disabled={updating}
                >
                  No
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirmCancel(false);
                    updateStatus("CANCELLED");
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Order</DialogTitle>
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
    </Card>
  );
}
