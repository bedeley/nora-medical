"use client";

export const dynamic = "force-dynamic";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { useEffect, useRef, useState, useId, useMemo } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";
import { RefreshCcw, HelpCircle, MoreVertical, CheckCircle2, XCircle, MessageCircle } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";

const fetcher = async (u: string) => {
  const r = await fetch(u);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `Request failed (${r.status})`);
  return j;
};

type CustomerRow = {
  user: {
    id: string;
    email: string;
    name?: string | null;
    role?: string | null;
  };
  phoneVerified?: boolean;
  whatsappReady?: boolean;
  ordersTotal?: number;
  paidTotal?: number;
  paymentsTotal?: number;
  refundedCash?: number;
  cart?: {
    total?: number;
    totalItems?: number;
    items?: Array<{
      id: string;
      productName: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
    }>;
    updatedAt?: string | Date | null;
  } | null;
  delivery?: {
    delivered?: number;
    partial?: number;
    pending?: number;
  };
};

type CartItem = NonNullable<NonNullable<CustomerRow["cart"]>["items"]>[number];

type PaymentApplied = {
  orderId: string;
  applied: number;
};

type PaymentRow = {
  id: string;
  amount: number;
  orderId: string | null;
  createdAt: string;
  applied: PaymentApplied[];
  meta?: {
    status?: string;
    refundDisposition?: string;
  } | null;
  status: string | null;
  refundDisposition: string | null;
};

type OrderOption = {
  id: string;
  label: string;
  status: string;
  balance: number;
};

export default function AdminCustomers() {
  const queryClient = useQueryClient();
  const [confirmClear, setConfirmClear] = useState<{ id: string; email?: string|null } | null>(null);
  const [deliveryFilter, setDeliveryFilter] = useState<string>("all");
  const [editing, setEditing] = useState(false);
  const { data, error, isFetching: isValidating } = useClientQuery({
    queryKey: ["admin", "customers", { editing }],
    queryFn: () => fetcher("/api/admin/customers"),
    refetchInterval: editing ? false : 8000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [pay, setPay] = useState({
    userId: "",
    orderId: "",
    amount: "",
    note: "",
    method: "cash" as "cash" | "card" | "transfer" | "adjustment",
    reference: "",
    receivedBy: "",
    location: "",
    status: "normal" as "normal" | "refund" | "void",
    refundDisposition: undefined as "cash" | "credit" | undefined,
  });
  const amountInputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  const [explain, setExplain] = useState<{ userId: string; email: string; paymentsTotal: number; paidTotal: number } | null>(null);
  const [exportMonth, setExportMonth] = useState(() => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  });
  const [exportMethod, setExportMethod] = useState<string>("");
  const [exportStatus, setExportStatus] = useState<string>("");
  const [autoText, setAutoText] = useState<boolean>(true);
  const [smsPhone, setSmsPhone] = useState<string>("");
  const [orderRemaining, setOrderRemaining] = useState<number | null>(null);
  const [orderPaid, setOrderPaid] = useState<number | null>(null);
  const [orderOptions, setOrderOptions] = useState<OrderOption[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [refundCredit, setRefundCredit] = useState<{ userId: string; email: string; credit: number } | null>(null);
  const [refundAmount, setRefundAmount] = useState<string>("");
  const [refundMethod, setRefundMethod] = useState<"cash" | "transfer">("cash");
  const [refundRef, setRefundRef] = useState("");
  const [refundNote, setRefundNote] = useState("");
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const orderListId = useId();
  const [viewCart, setViewCart] = useState<{ user: CustomerRow["user"]; cart: CustomerRow["cart"] } | null>(null);

  // Payments summary for current export filters
  const summaryParams = new URLSearchParams({ month: exportMonth });
  if (exportMethod) summaryParams.set("method", exportMethod);
  if (exportStatus) summaryParams.set("status", exportStatus);
  const { data: paymentsSummary, isFetching: isValidatingSummary } = useClientQuery({
    queryKey: ["admin", "payments", "summary", exportMonth, exportMethod, exportStatus],
    queryFn: () => fetcher(`/api/admin/payments/summary?${summaryParams.toString()}`),
    refetchInterval: 15000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const refreshing = isValidating || isValidatingSummary;
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const rows: CustomerRow[] = useMemo(
    () => (data?.rows || []) as CustomerRow[],
    [data],
  );
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      const d = r.delivery || { delivered: 0, partial: 0, pending: 0 };
      if (deliveryFilter === "pending") return (d.pending || 0) > 0;
      if (deliveryFilter === "partial") return (d.partial || 0) > 0;
      if (deliveryFilter === "delivered") return (d.delivered || 0) > 0;
      return true;
    });
  }, [rows, deliveryFilter]);

  const renderActionsMenu = (r: CustomerRow, buttonClass = "") => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={`flex items-center gap-1 ${buttonClass}`}>
          Actions <MoreVertical className="ml-1 h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => {
            setPay((v) => ({ ...v, userId: r.user.id, orderId: "", amount: "", note: "" }));
            setSmsPhone((r as CustomerRow & { user: CustomerRow["user"] & { phone?: string | null } }).user.phone || "");
            setAutoText(true);
            setTimeout(() => {
              formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              amountInputRef.current?.focus();
            }, 0);
          }}
        >
          Add Payment
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            setExplain({
              userId: r.user.id,
              email: r.user.email,
              paymentsTotal: Number(r.paymentsTotal || 0),
              paidTotal: Number(r.paidTotal || 0),
            });
          }}
        >
          Explain totals
        </DropdownMenuItem>
        {Math.max(0, (r.paymentsTotal ?? 0) - (r.paidTotal || 0)) > 0.005 && (
          <DropdownMenuItem
            onClick={async () => {
              const unapplied = Math.max(0, (r.paymentsTotal ?? 0) - (r.paidTotal || 0));
              const outstanding = Math.max(0, Number(r.ordersTotal || 0) - Number(r.paidTotal || 0));
              const EPSILON = 0.005;

              if (outstanding <= EPSILON) {
                toast.info("No outstanding balance to apply this payment to.");
                return;
              }
              if (unapplied <= EPSILON) {
                toast.info("No unapplied funds to apply.");
                return;
              }

              const amount = Math.min(unapplied, outstanding);
              const res = await fetch("/api/payments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  userId: r.user.id,
                  amount,
                  note: "Auto-apply remaining",
                  method: "adjustment",
                  reference: "AUTO_APPLY",
                  receivedBy: "system",
                  location: "admin/customers",
                  status: "normal",
                }),
              });
              if (!res.ok) {
                const msg =
                  (
                    await res.json().catch(async () => ({ error: await res.text().catch(() => "") }))
                  ).error || "Failed to apply remaining";
                toast.error(msg);
              } else {
                toast.success("Remaining payments applied.");
                queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
              }
            }}
          >
            Apply to Balance
          </DropdownMenuItem>
        )}
        {(() => {
          const credit = Math.max(0, (r.paymentsTotal ?? 0) - (r.paidTotal || 0));
          if (credit <= 0.005) return null;
          return (
            <DropdownMenuItem
              onClick={() => {
                setRefundCredit({ userId: r.user.id, email: r.user.email, credit });
                setRefundAmount(credit.toFixed(2));
                setRefundMethod("cash");
                setRefundRef("");
                setRefundNote("");
              }}
            >
              Refund credit
            </DropdownMenuItem>
          );
        })()}
        {process.env.NEXT_PUBLIC_ADMIN_ROLE_MANAGEMENT_ENABLED === "1" && (
          <DropdownMenuItem
            onClick={async () => {
              try {
                const currentRole = String(r.user.role || "CUSTOMER").toUpperCase();
                const nextRole = currentRole === "ADMIN" ? "CUSTOMER" : "ADMIN";
                const res = await fetch(`/api/admin/users/${r.user.id}/role`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ role: nextRole }),
                });
                const j = await res.json().catch(() => ({}));
                if (!res.ok) {
                  throw new Error(j?.error || "Failed to update role");
                }
                toast.success(
                  nextRole === "ADMIN"
                    ? "User promoted to admin."
                    : "User set to customer."
                );
                queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
              } catch (e: unknown) {
                const message =
                  e instanceof Error ? e.message : "Failed to update role";
                toast.error(message);
              }
            }}
          >
            {String(r.user.role || "CUSTOMER").toUpperCase() === "ADMIN"
              ? "Set as customer"
              : "Make admin"}
          </DropdownMenuItem>
        )}
        {r.cart?.items?.length ? (
          <DropdownMenuItem
            onClick={() => {
              setViewCart({ user: r.user, cart: r.cart });
            }}
          >
            View Cart ({r.cart.totalItems ?? r.cart.items.length})
          </DropdownMenuItem>
        ) : null}
        {(() => {
          if (!r.cart) return null;
          const outstanding = Math.max(0, Number(r.ordersTotal || 0) - Number(r.paidTotal || 0));
          const deliveredAll = (r.delivery?.pending || 0) === 0 && (r.delivery?.partial || 0) === 0;
          const canDeleteCart = outstanding <= 0.0001 && deliveredAll;
          return (
            <DropdownMenuItem
              disabled={!canDeleteCart}
              onClick={() => {
                if (!canDeleteCart) {
                  toast.info("Cart can be deleted only after full payment and delivery");
                  return;
                }
                setConfirmClear({ id: r.user.id, email: r.user.email });
              }}
            >
              Delete Cart
            </DropdownMenuItem>
          );
        })()}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Fetch order remaining when an Order ID is entered to show accurate max for order-scoped payments
  useEffect(() => {
    let active = true;
    (async () => {
      if (!pay.orderId) {
        if (active) {
          setOrderRemaining(null);
          setOrderPaid(null);
        }
        return;
      }
      try {
        const res = await fetch(`/api/orders/${pay.orderId}`);
        if (res.ok) {
          const payload = await res.json();
          const ord = payload?.data;
          if (!ord) {
            if (active) {
              setOrderRemaining(null);
              setOrderPaid(null);
            }
            return;
          }
          const total = Number(ord.total);
          const alreadyPaid = Number(ord.amountPaid ?? 0);
          const remaining = Math.max(0, total - alreadyPaid);
          if (active) {
            setOrderRemaining(remaining);
            setOrderPaid(alreadyPaid);
          }
        } else if (active) {
          setOrderRemaining(null);
          setOrderPaid(null);
        }
      } catch {
        if (active) {
          setOrderRemaining(null);
          setOrderPaid(null);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [pay.orderId]);

  useEffect(() => {
    let active = true;
    if (!pay.userId) {
      setOrderOptions([]);
      setOrdersError(null);
      setOrdersLoading(false);
      return;
    }
    setOrdersLoading(true);
    setOrdersError(null);
    (async () => {
      try {
        const res = await fetch(`/api/admin/orders/user/${pay.userId}/list`);
        if (!active) return;
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        if (!res.ok) {
          const msg =
            (body as { error?: string } | null | undefined)?.error ||
            `Failed to load orders (${res.status})`;
          setOrdersError(msg);
          setOrderOptions([]);
          return;
        }
        const orders = Array.isArray((body as { orders?: unknown })?.orders)
          ? ((body as { orders: Array<{ id: string; total?: number; amountPaid?: number; balance?: number; status: string }> }).orders)
          : [];
        const mapped: OrderOption[] = orders.map((o) => {
          const balance = Math.max(
            0,
            Number(o.balance ?? Number(o.total ?? 0) - Number(o.amountPaid ?? 0))
          );
          const label = `${formatOrderId(o.id)} | ${formatOrderStatus(o.status)} | Balance ${formatCurrency(
            balance
          )}`;
          return { id: o.id, label, status: formatOrderStatus(o.status), balance };
        });
        setOrderOptions(mapped);
      } catch (err: unknown) {
        if (!active) return;
        const message =
          err instanceof Error ? err.message : "Failed to load orders";
        setOrdersError(message);
        setOrderOptions([]);
      } finally {
        if (active) setOrdersLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [pay.userId]);

  // Compute max allowed payment based on order or user outstanding
  const userOutstanding = (() => {
    if (!pay.userId || !data?.rows) return null;
    const row = data.rows.find(
      (r: CustomerRow) => r.user.id === pay.userId,
    ) as CustomerRow | undefined;
    if (!row) return null;
    return Math.max(0, Number(row.ordersTotal || 0) - Number(row.paidTotal || 0));
  })();
  const isRefund = pay.status === "refund";
  const amountNumber = Math.abs(Number(pay.amount || 0));
  const maxAllowed: number | null = isRefund ? null : pay.orderId ? (orderRemaining ?? null) : userOutstanding;
  const invalidOverpay = !isRefund && !!maxAllowed && amountNumber > maxAllowed;
  const disableSubmit =
    !pay.amount ||
    (!pay.orderId && !pay.userId) ||
    invalidOverpay ||
    (isRefund && (!pay.orderId || !pay.refundDisposition));

  async function submitPayment() {
    const amountRaw = Math.abs(Number(pay.amount || 0));
    const note = pay.note || undefined;
    if (isRefund && !pay.orderId) {
      toast.error("Select an order when recording a refund.");
      return;
    }
    if (isRefund && !pay.refundDisposition) {
      toast.error("Choose how the refund should be handled.");
      return;
    }
    if (!amountRaw || isNaN(amountRaw) || amountRaw <= 0) {
      toast.error("Enter a valid amount greater than 0.");
      return;
    }
    const amount = isRefund ? -Math.abs(amountRaw) : amountRaw;
    try {
      if (!pay.userId && !pay.orderId) {
        toast.error("Provide a User ID or an Order ID.");
        return;
      }
      // Prevent over/under payment by validating amounts
      try {
        if (pay.orderId) {
          const check = await fetch(`/api/orders/${pay.orderId}`);
          if (check.ok) {
            const payload = await check.json();
            const ord = payload?.data as {
              total: number;
              amountPaid?: number;
            } | null;
            if (ord) {
              const total = Number(ord.total);
              const alreadyPaid = Number(ord.amountPaid ?? 0);
              const remaining = Math.max(0, total - alreadyPaid);
              if (!isRefund && amount > remaining) {
                toast.error(
                  `Amount exceeds order remaining: ${formatCurrency(remaining)}`,
                );
                return;
              }
              if (isRefund && amountRaw > alreadyPaid + 0.0001) {
                toast.error(
                  `Refund exceeds what has been paid: ${formatCurrency(
                    alreadyPaid,
                  )}`,
                );
                return;
              }
            }
          }
        } else if (!isRefund && pay.userId && data?.rows) {
          const row = data.rows.find(
            (r: CustomerRow) => r.user.id === pay.userId,
          );
          if (row) {
            const outstanding = Math.max(
              0,
              Number(row.ordersTotal || 0) - Number(row.paidTotal || 0),
            );
            if (amount > outstanding) {
              toast.error(
                `Amount exceeds customer's outstanding balance: ${formatCurrency(
                  outstanding,
                )}`,
              );
              return;
            }
          }
        }
      } catch {}
      const res = await fetch(`/api/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: pay.userId,
          orderId: pay.orderId || undefined,
          amount,
          note,
          method: pay.method,
          reference: pay.reference || undefined,
          receivedBy: pay.receivedBy || undefined,
          location: pay.location || undefined,
          status: pay.status,
          refundDisposition: isRefund ? pay.refundDisposition : undefined,
        }),
      });
      if (!res.ok) {
        const msg =
          (
            await res.json().catch(async () => ({
              error: await res.text().catch(() => ""),
            }))
          ).error || "Failed to record payment";
        throw new Error(msg);
      }
      const result = await res.json();
      toast.success("Payment recorded successfully.");
      // If recorded against a specific order, redirect to its details for delivery updates
      if (pay.orderId) {
        window.location.href = `/admin/orders/${pay.orderId}`;
        return;
      }
      if (result?.payment?.id) {
        const receiptId = result.payment.id as string;
        // Open printable receipt in new tab
        window.open(`/admin/payments/receipt/${receiptId}`, "_blank");
        // Optionally auto-send receipt via SMS; if it fails, notify admin
        if (autoText) {
          try {
            const payload: { to?: string } = {};
            if (smsPhone) payload.to = smsPhone;
            const smsRes = await fetch(
              `/api/admin/payments/receipt/${receiptId}/text`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              },
            );
            if (!smsRes.ok) {
              const msg =
                (
                  await smsRes
                    .json()
                    .catch(
                      async () => ({
                        error: await smsRes.text().catch(() => ""),
                      }),
                    )
                ).error || "Could not send SMS";
              toast.warning(`${msg}. Receipt opened to print manually.`);
            } else {
              toast.success("Receipt text sent to customer.");
            }
          } catch {
            toast.warning(
              "SMS failed. Receipt opened to print manually.",
            );
          }
        }
      }
      setPay({
        userId: "",
        orderId: "",
        amount: "",
        note: "",
        method: "cash",
        reference: "",
        receivedBy: "",
        location: "",
        status: "normal",
        refundDisposition: undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
    } catch (e: unknown) {
      const message =
        e instanceof Error ? e.message : "Failed to record payment";
      toast.error(message);
    }
  }

  if (error) {
    const msg = String((error as Error)?.message || "Error");
    const unauthorized = /unauthorized/i.test(msg);
    return (
      <div className="container mx-auto py-8 max-w-3xl">
        <h1 className="text-2xl font-semibold mb-4">Customer Cart</h1>
        <div className="rounded-md border p-6 text-sm">
          {unauthorized ? (
            <p>Admin access required. Please sign in with an admin account.</p>
          ) : (
            <p>Failed to load customers: {msg}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="grid gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold">Customer Cart</h2>
          </div>
          <div className="flex flex-col gap-2 w-full lg:w-auto">
            <div className="flex flex-wrap gap-3">
              <div className="flex flex-col gap-1 min-w-[150px] flex-1 sm:flex-none">
                <label className="text-xs text-muted-foreground">Month</label>
                <input
                  type="month"
                  className="h-9 rounded-md border px-2 text-sm w-full"
                  value={exportMonth}
                  onChange={(e) => setExportMonth(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1 min-w-[150px] flex-1 sm:flex-none">
                <label className="text-xs text-muted-foreground">Method</label>
                <Select value={exportMethod || "all"} onValueChange={(v) => setExportMethod(v === "all" ? "" : v)}>
                  <SelectTrigger className="h-9 w-full"><SelectValue placeholder="All" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="card">Card</SelectItem>
                    <SelectItem value="transfer">Transfer</SelectItem>
                    <SelectItem value="adjustment">Adjustment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1 min-w-[150px] flex-1 sm:flex-none">
                <label className="text-xs text-muted-foreground">Status</label>
                <Select value={exportStatus || "all"} onValueChange={(v) => setExportStatus(v === "all" ? "" : v)}>
                  <SelectTrigger className="h-9 w-full"><SelectValue placeholder="All" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="refund">Refund</SelectItem>
                    <SelectItem value="void">Void</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1 min-w-[180px] flex-1 sm:flex-none">
                <label className="text-xs text-muted-foreground">Delivery</label>
                <Select value={deliveryFilter} onValueChange={setDeliveryFilter}>
                  <SelectTrigger className="h-9 w-full"><SelectValue placeholder="All deliveries" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="pending">Not Delivered</SelectItem>
                    <SelectItem value="partial">Partially Delivered</SelectItem>
                    <SelectItem value="delivered">Delivered</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                className="h-9 w-full sm:w-auto"
                variant="outline"
                size="sm"
                onClick={() => {
                  const params = new URLSearchParams({ month: exportMonth });
                  if (exportMethod) params.set("method", exportMethod);
                  if (exportStatus) params.set("status", exportStatus);
                  if (deliveryFilter && deliveryFilter !== "all") {
                    const d = deliveryFilter === "pending" ? "not-delivered" : deliveryFilter;
                    params.set("delivery", d);
                  }
                  window.open(`/api/admin/payments/export?${params.toString()}`, "_blank");
                }}
              >
                Export CSV
              </Button>
              <Button
                className="h-9 w-full sm:w-auto"
                variant="outline"
                size="sm"
                onClick={() => {
                  const params = new URLSearchParams({ month: exportMonth });
                  if (exportMethod) params.set("method", exportMethod);
                  if (exportStatus) params.set("status", exportStatus);
                  if (deliveryFilter && deliveryFilter !== "all") {
                    const d = deliveryFilter === "pending" ? "not-delivered" : deliveryFilter;
                    params.set("delivery", d);
                  }
                  window.open(`/admin/payments/export/print?${params.toString()}`, "_blank");
                }}
              >
                Export PDF
              </Button>
              <Button
                className="h-9 w-full sm:w-9"
                variant="outline"
                size="icon"
                onClick={async () => {
                  queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
                  queryClient.invalidateQueries({ queryKey: ["admin", "payments", "summary"] });
                }}
                aria-label="Refresh"
                title="Refresh"
              >
                <RefreshCcw className={`h-4 w-4 ${mounted && refreshing ? "animate-spin" : ""}`} />
              </Button>
              {paymentsSummary && (
                <div className="w-full sm:w-auto">
                  <PaymentsSummaryButton
                    month={exportMonth}
                    method={exportMethod}
                    status={exportStatus}
                    total={Number(paymentsSummary.total || 0)}
                    count={Number(paymentsSummary.count || 0)}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
        {data?.partial && (data as { errors?: Array<{ step: string; error: string }> })?.errors?.length ? (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            Some data could not be loaded:
            <ul className="list-disc pl-5 space-y-0.5 mt-1">
              {(data.errors as Array<{ step: string; error: string }>).map((err, idx: number) => (
                <li key={idx}>
                  <span className="font-semibold">{err.step}:</span> {err.error}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <div className="grid gap-4">
        <div
          ref={formRef}
          onFocusCapture={() => setEditing(true)}
          onBlurCapture={() => setEditing(false)}
          className="p-4 rounded-xl shadow-md grid gap-2 max-w-2xl"
        >
          <h3 className="font-medium">Record Payment</h3>
          <Input
            placeholder="User ID"
            value={pay.userId}
            onChange={(e) =>
              setPay((v) => ({
                ...v,
                userId: e.target.value,
                orderId: "",
              }))
            }
          />
          <div className="space-y-1">
            <Input
              list={orderListId}
              placeholder={pay.status === "refund" ? "Order ID (required for refunds)" : "Order ID (optional)"}
              value={pay.orderId}
              onChange={(e) => setPay((v) => ({ ...v, orderId: e.target.value }))}
              className={pay.status === "refund" && !pay.orderId ? "border-red-500" : undefined}
            />
            <datalist id={orderListId}>
              {orderOptions.map((opt) => (
                <option key={opt.id} value={opt.id} label={opt.label} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              {ordersLoading
                ? "Loading orders..."
                : ordersError
                ? `Could not load orders: ${ordersError}`
                : pay.userId
                ? orderOptions.length
                  ? "Pick an order from the dropdown or paste an ID."
                  : "No orders found for this customer."
                : "Enter a User ID to load their orders."}
            </p>
            {isRefund && orderPaid !== null && (
              <p className="text-xs text-muted-foreground">
                Paid on this order: {formatCurrency(orderPaid)}. Refunds cannot exceed this amount.
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground">Method</label>
              <Select
                value={pay.method}
                onValueChange={(val: "cash" | "card" | "transfer" | "adjustment") =>
                  setPay((v) => ({ ...v, method: val }))
                }
              >
                <SelectTrigger className="h-9"><SelectValue placeholder="Select method" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="card">Card</SelectItem>
                  <SelectItem value="transfer">Transfer</SelectItem>
                  <SelectItem value="adjustment">Adjustment</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Status</label>
              <Select
                value={pay.status}
                onValueChange={(val: "normal" | "refund" | "void") =>
                  setPay((v) => ({
                    ...v,
                    status: val,
                    refundDisposition: val === "refund" ? v.refundDisposition || "cash" : undefined,
                  }))
                }
              >
                <SelectTrigger className="h-9"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="refund">Refund</SelectItem>
                  <SelectItem value="void">Void</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {pay.status === "refund" && (
            <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs space-y-2">
              <p className="font-semibold text-foreground">Refund destination</p>
              <label className="flex items-start gap-2 text-foreground">
                <input
                  type="radio"
                  className="mt-0.5"
                  checked={pay.refundDisposition === "cash"}
                  onChange={() => setPay((v) => ({ ...v, refundDisposition: "cash" }))}
                />
                <span>
                  Return to customer &mdash; cash/leverage handed back. Does <strong>not</strong> change Unapplied Funds.
                </span>
              </label>
              <label className="flex items-start gap-2 text-foreground">
                <input
                  type="radio"
                  className="mt-0.5"
                  checked={pay.refundDisposition === "credit"}
                  onChange={() => setPay((v) => ({ ...v, refundDisposition: "credit" }))}
                />
                <span>
                  Add to Unapplied Funds &mdash; keep as store credit that can be applied to future orders.
                </span>
              </label>
            </div>
          )}
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground space-y-1">
            <p className="font-semibold text-foreground">Payment method</p>
            <ul className="list-disc pl-4 space-y-0.5">
              <li><span className="font-semibold text-foreground">Cash:</span> Walk-in cash counted at the desk.</li>
              <li><span className="font-semibold text-foreground">Card:</span> POS or online card transaction with a receipt number.</li>
              <li><span className="font-semibold text-foreground">Transfer:</span> Bank or mobile-money transfer (reference the slip/SMS).</li>
              <li><span className="font-semibold text-foreground">Adjustment:</span> Back-office move such as applying credits or correcting unapplied funds.</li>
            </ul>
            <p className="mt-2 font-semibold text-foreground">Status</p>
            <ul className="list-disc pl-4 space-y-0.5">
              <li><span className="font-semibold text-foreground">Normal:</span> Standard payment that increases the customer&rsquo;s paid amount.</li>
              <li><span className="font-semibold text-foreground">Refund:</span> Money returned to the customer (usually entered as a negative amount).</li>
              <li><span className="font-semibold text-foreground">Void:</span> Entry captured in error that should be excluded from reporting while keeping an audit trail.</li>
            </ul>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="Reference/Receipt" value={pay.reference} onChange={(e) => setPay((v) => ({ ...v, reference: e.target.value }))} />
            <Input placeholder="Received By" value={pay.receivedBy} onChange={(e) => setPay((v) => ({ ...v, receivedBy: e.target.value }))} />
          </div>
          <Input placeholder="Location" value={pay.location} onChange={(e) => setPay((v) => ({ ...v, location: e.target.value }))} />
          <div className="flex items-center gap-2">
            <Input
              type="number"
              step="0.01"
              placeholder="Amount (required)"
              value={pay.amount}
              onChange={(e) => setPay((v) => ({ ...v, amount: e.target.value }))}
              required
              ref={amountInputRef}
              className={invalidOverpay ? "border-red-500" : undefined}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!(typeof maxAllowed === "number") || (maxAllowed ?? 0) <= 0 || Number(pay.amount || 0) === Number(maxAllowed)}
              onClick={() => {
                if (typeof maxAllowed === "number") {
                  setPay((v) => ({ ...v, amount: String(maxAllowed.toFixed(2)) }));
                }
              }}
            >
              Use Max
            </Button>
          </div>
          {typeof maxAllowed === "number" && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span>Max: {formatCurrency(maxAllowed)}</span>
              <HelpCircle className="h-3 w-3" aria-label="Max amount explanation" />
            </div>
          )}
          <Input
            placeholder="Note"
            value={pay.note}
            onChange={(e) => setPay((v) => ({ ...v, note: e.target.value }))}
          />
          <div className="grid sm:grid-cols-2 gap-2 items-center">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoText}
                onChange={(e) => setAutoText(e.target.checked)}
              />
              Auto-text receipt to customer
            </label>
            <Input
              placeholder="Customer phone (optional override)"
              value={smsPhone}
              onChange={(e) => setSmsPhone(e.target.value)}
            />
          </div>
          <Button onClick={submitPayment} disabled={disableSubmit}>
            Add Payment
          </Button>
        </div>
        <div className="hidden md:block overflow-x-auto">
          <Table className="w-full table-auto min-w-[1120px] admin-customers-table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[260px] text-left">User</TableHead>
                <TableHead className="w-[140px] text-center">
                  <div className="inline-flex items-center justify-center gap-1">
                    <span>Orders</span>
                    <Tooltip content="Total value of all orders">
                      <HelpCircle
                        className="h-3.5 w-3.5 text-muted-foreground"
                        aria-label="Orders total"
                      />
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead className="w-[160px] text-center">
                  <div className="inline-flex items-center justify-center gap-1">
                    <span>Paid</span>
                    <Tooltip content="Payments applied to orders (sum of amountPaid across non-cancelled orders)">
                      <HelpCircle
                        className="h-3.5 w-3.5 text-muted-foreground"
                        aria-label="Paid total"
                      />
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead className="w-[140px] text-center">
                  <div className="inline-flex items-center justify-center gap-1">
                    <span>Payments</span>
                    <Tooltip content="All payments received (may include unapplied)">
                      <HelpCircle
                        className="h-3.5 w-3.5 text-muted-foreground"
                        aria-label="Payments total"
                      />
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead className="w-[160px] text-center">
                  <div className="inline-flex items-center justify-center gap-1">
                    <span>Unapplied Funds</span>
                    <Tooltip content="Credits held for this customer (Payments - Paid).">
                      <HelpCircle
                        className="h-3.5 w-3.5 text-muted-foreground"
                        aria-label="Unapplied funds"
                      />
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead className="w-[140px] text-center">
                  <div className="inline-flex items-center justify-center gap-1">
                    <span>Refunded</span>
                    <Tooltip content="Cash physically returned to the customer.">
                      <HelpCircle
                        className="h-3.5 w-3.5 text-muted-foreground"
                        aria-label="Refunded cash"
                      />
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead className="w-[140px] text-center">
                  <div className="inline-flex items-center justify-center gap-1">
                    <span>Balance</span>
                    <Tooltip content="Outstanding = Orders - Paid">
                      <HelpCircle
                        className="h-3.5 w-3.5 text-muted-foreground"
                        aria-label="Balance"
                      />
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead className="w-[180px] text-center">
                  <div className="inline-flex items-center justify-center gap-1">
                    <span>Cart</span>
                    <Tooltip content="Live cart total and items currently in their basket">
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Cart totals" />
                    </Tooltip>
                  </div>
                </TableHead>
                <TableHead className="w-[220px] text-center">Delivery</TableHead>
                <TableHead className="w-[220px] text-center">Actions</TableHead>
              </TableRow>
            </TableHeader>
              <TableBody>
              {filteredRows.map((r: CustomerRow) => (
                <TableRow key={r.user.id}>
                  <TableCell className="max-w-[320px] text-left">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="truncate">{r.user.email}</span>
                      <div className="flex items-center gap-1 text-xs">
                        {r.phoneVerified ? (
                          <span title="Phone verified" className="inline-flex items-center gap-0.5 text-green-700"><CheckCircle2 className="w-3 h-3" /></span>
                        ) : (
                          <span title="Phone not verified" className="inline-flex items-center gap-0.5 text-red-700"><XCircle className="w-3 h-3" /></span>
                        )}
                        {r.whatsappReady && (
                          <span title="WhatsApp reachable" className="inline-flex items-center gap-0.5 text-emerald-700"><MessageCircle className="w-3 h-3" /></span>
                        )}
                      </div>
                      {pay.userId === r.user.id && (() => {
                        const outstanding = Math.max(0, Number(r.ordersTotal || 0) - Number(r.paidTotal || 0));
                        return (
                          <span
                            role="button"
                            title="Click to use max outstanding"
                            onClick={() => {
                              setPay((v) => ({ ...v, amount: String(outstanding.toFixed(2)) }));
                              setTimeout(() => {
                                formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                                amountInputRef.current?.focus();
                              }, 0);
                            }}
                            className="cursor-pointer text-[10px] md:text-xs bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 rounded px-1.5 py-0.5 whitespace-nowrap"
                          >
                            Outstanding: {formatCurrency(outstanding)}
                          </span>
                        );
                      })()}
                    </div>
                  </TableCell>
                  <TableCell className="text-center whitespace-nowrap tabular-nums font-mono px-2">{formatCurrency(r.ordersTotal || 0)}</TableCell>
                  <TableCell className="text-center whitespace-nowrap tabular-nums font-mono px-2">{formatCurrency(r.paidTotal || 0)}</TableCell>
                  <TableCell className="text-center whitespace-nowrap tabular-nums font-mono px-2">
                    {formatCurrency(r.paymentsTotal ?? 0)}
                  </TableCell>
                  <TableCell className="text-center whitespace-nowrap tabular-nums font-mono px-2">
                    {(() => {
                      const delta = Math.max(0, (r.paymentsTotal ?? 0) - (r.paidTotal || 0));
                      const cls = delta > 0.005 ? "text-amber-700" : "text-muted-foreground";
                      return <span className={cls}>{formatCurrency(delta)}</span>;
                    })()}
                  </TableCell>
                  <TableCell className="text-center whitespace-nowrap tabular-nums font-mono px-2">
                    <span
                      className={
                        (r.refundedCash ?? 0) > 0 ? "text-red-700" : "text-muted-foreground"
                      }
                    >
                      {formatCurrency(r.refundedCash || 0)}
                    </span>
                  </TableCell>
                  <TableCell className="text-center whitespace-nowrap tabular-nums font-mono px-2">{formatCurrency((r.ordersTotal || 0) - (r.paidTotal || 0))}</TableCell>
                  <TableCell className="text-center whitespace-nowrap px-2 text-sm">
                    {r.cart?.totalItems ? (
                      <div className="flex flex-col leading-tight">
                        <span className="font-medium">{formatCurrency(r.cart.total || 0)}</span>
                        <span className="text-xs text-muted-foreground">{r.cart.totalItems} item{r.cart.totalItems === 1 ? "" : "s"}</span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">Empty</span>
                    )}
                  </TableCell>
                  <TableCell className="text-center whitespace-nowrap">
                    {(() => {
                      const d = r.delivery || { delivered: 0, partial: 0, pending: 0 };
                      return (
                        <span className="text-xs">
                          <span className="bg-green-100 text-green-800 rounded px-1.5 py-0.5 mr-1">
                            Full {d.delivered || 0}
                          </span>
                          <span className="bg-yellow-100 text-yellow-800 rounded px-1.5 py-0.5 mr-1">
                            Partial {d.partial || 0}
                          </span>
                          <span className="bg-gray-100 text-gray-800 rounded px-1.5 py-0.5">
                            Pending {d.pending || 0}
                          </span>
                        </span>
                      );
                    })()}
                  </TableCell>
              <TableCell className="text-center w-[220px] min-w-[220px] overflow-visible whitespace-normal">
                <div className="flex w-full justify-center">
                  {renderActionsMenu(r)}
                </div>
              </TableCell>
            </TableRow>
          ))}
          {filteredRows.length === 0 && (
            <TableRow>
              <TableCell colSpan={10} className="text-center text-sm text-muted-foreground py-6">
                No customers found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
        <div className="md:hidden space-y-4">
          {filteredRows.map((r: CustomerRow) => {
            const outstanding = Math.max(0, Number(r.ordersTotal || 0) - Number(r.paidTotal || 0));
            const credit = Math.max(0, (r.paymentsTotal ?? 0) - (r.paidTotal || 0));
            const delivery = r.delivery || { delivered: 0, partial: 0, pending: 0 };
            return (
              <div key={r.user.id} className="rounded-lg !border-0 shadow-md p-4 space-y-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold break-all">{r.user.email}</p>
                    <p className="text-xs text-muted-foreground">{r.user.name || "Unnamed customer"}</p>
                    <div className="flex items-center gap-2 mt-1 text-xs">
                      {r.phoneVerified ? (
                        <span className="inline-flex items-center gap-0.5 text-green-700">
                          <CheckCircle2 className="w-3 h-3" /> Verified
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-0.5 text-red-700">
                          <XCircle className="w-3 h-3" /> Unverified
                        </span>
                      )}
                      {r.whatsappReady && (
                        <span className="inline-flex items-center gap-0.5 text-emerald-700">
                          <MessageCircle className="w-3 h-3" /> WhatsApp
                        </span>
                      )}
                    </div>
                  </div>
                  {pay.userId === r.user.id && (
                    <button
                      type="button"
                      className="text-[10px] bg-amber-50 border border-amber-200 text-amber-800 rounded px-2 py-0.5"
                      onClick={() => {
                        setPay((v) => ({ ...v, amount: String(outstanding.toFixed(2)) }));
                        setTimeout(() => {
                          formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                          amountInputRef.current?.focus();
                        }, 0);
                      }}
                    >
                      Outstanding: {formatCurrency(outstanding)}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Orders</p>
                    <p className="font-mono">{formatCurrency(r.ordersTotal || 0)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Paid</p>
                    <p className="font-mono">{formatCurrency(r.paidTotal || 0)}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Unapplied</p>
                    <p className="font-mono">{formatCurrency(Math.max(0, credit))}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-muted-foreground">Balance</p>
                    <p className="font-mono">{formatCurrency(outstanding)}</p>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {r.cart?.totalItems ? (
                    <>
                      Cart: {r.cart.totalItems} item{r.cart.totalItems === 1 ? "" : "s"} · {formatCurrency(r.cart.total || 0)}
                    </>
                  ) : (
                    <>Cart empty</>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="bg-green-100 text-green-800 rounded px-1.5 py-0.5">
                    Full {delivery.delivered || 0}
                  </span>
                  <span className="bg-yellow-100 text-yellow-800 rounded px-1.5 py-0.5">
                    Partial {delivery.partial || 0}
                  </span>
                  <span className="bg-gray-100 text-gray-800 rounded px-1.5 py-0.5">
                    Pending {delivery.pending || 0}
                  </span>
                </div>
                <div className="flex justify-end">
                  {renderActionsMenu(r, "w-full justify-center")}
                </div>
              </div>
            );
          })}
          {filteredRows.length === 0 && (
            <p className="text-center text-sm text-muted-foreground">No customers match the selected filters.</p>
          )}
        </div>
      </div>
    </div>
    <Dialog open={!!viewCart} onOpenChange={(open) => { if (!open) setViewCart(null); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cart for {viewCart?.user?.email || "customer"}</DialogTitle>
        </DialogHeader>
        {viewCart?.cart?.items?.length ? (
          <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
            {viewCart.cart.items.map((item: CartItem) => (
              <div key={item.id} className="flex items-center justify-between text-sm border rounded-md px-3 py-2">
                <div>
                  <p className="font-medium">{item.productName}</p>
                  <p className="text-xs text-muted-foreground">Qty: {item.quantity}</p>
                </div>
                <div className="text-right font-mono">
                  <p>{formatCurrency(item.unitPrice)}</p>
                  <p className="text-xs text-muted-foreground">Subtotal: {formatCurrency(item.subtotal)}</p>
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between border-t pt-3 font-semibold">
              <span>Total</span>
              <span>{formatCurrency(viewCart.cart.total || 0)}</span>
            </div>
            {viewCart.cart.updatedAt && (
              <p className="text-xs text-muted-foreground">Updated {new Date(viewCart.cart.updatedAt).toLocaleString()}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Cart is empty.</p>
        )}
      </DialogContent>
    </Dialog>
    <Dialog open={!!confirmClear} onOpenChange={(o) => { if (!o) setConfirmClear(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Cart</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Are you sure you want to delete this customer&apos;s cart
          {confirmClear?.email ? ` (${confirmClear.email})` : ""}? This action cannot be undone.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmClear(null)}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (!confirmClear) return;
              try {
                const res = await fetch(`/api/admin/carts/${confirmClear.id}/clear`, { method: "POST" });
                if (!res.ok) {
                  const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
                  throw new Error(j?.error || "Failed to clear cart");
                }
                toast.success("Cart cleared");
                setConfirmClear(null);
                queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
              } catch (e: unknown) {
                const message =
                  e instanceof Error ? e.message : "Failed to clear cart";
                toast.error(message);
              }
            }}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={!!refundCredit} onOpenChange={(open) => {
      if (!open) {
        setRefundCredit(null);
        setRefundAmount("");
      }
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Refund Unapplied Funds</DialogTitle>
        </DialogHeader>
        {refundCredit && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Customer: <span className="font-medium">{refundCredit.email}</span>
            </p>
            <p className="text-muted-foreground">
              Available credit: <span className="font-semibold">{formatCurrency(refundCredit.credit)}</span>
            </p>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Amount to refund</label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Method</label>
              <Select value={refundMethod} onValueChange={(val) => setRefundMethod(val as "cash" | "transfer")}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="transfer">Transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Input
              placeholder="Reference (optional)"
              value={refundRef}
              onChange={(e) => setRefundRef(e.target.value)}
            />
            <Input
              placeholder="Note (optional)"
              value={refundNote}
              onChange={(e) => setRefundNote(e.target.value)}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setRefundCredit(null)} disabled={refundSubmitting}>Cancel</Button>
              <Button
                onClick={async () => {
                  if (!refundCredit) return;
                  const value = Number(refundAmount);
                  if (!value || isNaN(value) || value <= 0) {
                    toast.error("Enter a valid refund amount");
                    return;
                  }
                  if (value > refundCredit.credit + 0.0001) {
                    toast.error("Amount exceeds customer's credit");
                    return;
                  }
                  try {
                    setRefundSubmitting(true);
                    const res = await fetch(`/api/admin/customers/${refundCredit.userId}/refund-credit`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        amount: value,
                        method: refundMethod,
                        reference: refundRef || undefined,
                        note: refundNote || undefined,
                      }),
                    });
                    if (!res.ok) {
                      const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
                      throw new Error(j?.error || "Failed to refund credit");
                    }
                    toast.success("Credit refunded successfully");
                    setRefundCredit(null);
                    setRefundAmount("");
                    queryClient.invalidateQueries({ queryKey: ["admin", "customers"] });
                  } catch (e: unknown) {
                    const message =
                      e instanceof Error ? e.message : "Failed to refund credit";
                    toast.error(message);
                  } finally {
                    setRefundSubmitting(false);
                  }
                }}
                disabled={refundSubmitting}
              >
                Refund
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
    {/* Explain totals dialog */}
    <Dialog open={!!explain} onOpenChange={(o) => { if (!o) setExplain(null); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Explain Totals {explain?.email ? `for ${explain.email}` : ""}</DialogTitle>
        </DialogHeader>
        {explain && (
          <ExplainTotals userId={explain.userId} paymentsTotal={explain.paymentsTotal} paidTotal={explain.paidTotal} />
        )}
      </DialogContent>
    </Dialog>
    {/* Close Account functionality moved to Customer Accounts page */}
    </>
  );
}

function PaymentsSummaryButton(props: { month: string; method: string; status: string; total: number; count: number }) {
  const { month, method, status, total, count } = props;
  const [open, setOpen] = useState(false);
  const showBreakdown = !method;

  const cashSummary = useClientQuery({
    queryKey: ["admin", "payments", "summary", month, "cash", status],
    queryFn: async () => {
      const params = new URLSearchParams({ month });
      params.set("method", "cash");
      if (status) params.set("status", status);
      const r = await fetch(`/api/admin/payments/summary?${params.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load summary (${r.status})`);
      return j as { total: number; count: number };
    },
    enabled: showBreakdown && !!month,
    staleTime: 30000,
  });

  const cardSummary = useClientQuery({
    queryKey: ["admin", "payments", "summary", month, "card", status],
    queryFn: async () => {
      const params = new URLSearchParams({ month });
      params.set("method", "card");
      if (status) params.set("status", status);
      const r = await fetch(`/api/admin/payments/summary?${params.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load summary (${r.status})`);
      return j as { total: number; count: number };
    },
    enabled: showBreakdown && !!month,
    staleTime: 30000,
  });

  const transferSummary = useClientQuery({
    queryKey: ["admin", "payments", "summary", month, "transfer", status],
    queryFn: async () => {
      const params = new URLSearchParams({ month });
      params.set("method", "transfer");
      if (status) params.set("status", status);
      const r = await fetch(`/api/admin/payments/summary?${params.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load summary (${r.status})`);
      return j as { total: number; count: number };
    },
    enabled: showBreakdown && !!month,
    staleTime: 30000,
  });

  const adjustmentSummary = useClientQuery({
    queryKey: ["admin", "payments", "summary", month, "adjustment", status],
    queryFn: async () => {
      const params = new URLSearchParams({ month });
      params.set("method", "adjustment");
      if (status) params.set("status", status);
      const r = await fetch(`/api/admin/payments/summary?${params.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load summary (${r.status})`);
      return j as { total: number; count: number };
    },
    enabled: showBreakdown && !!month,
    staleTime: 30000,
  });

  const breakdown = [
    { m: "cash" as const, q: cashSummary },
    { m: "card" as const, q: cardSummary },
    { m: "transfer" as const, q: transferSummary },
    { m: "adjustment" as const, q: adjustmentSummary },
  ];

  return (
    <>
      <div className="flex items-center gap-2">
        <Tooltip content="Click for more info">
          <Button variant="outline" size="sm" onClick={() => setOpen(true)} title="Click for breakdown">
            Payments Total: {formatCurrency(total)} ({count})
          </Button>
        </Tooltip>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Payments Summary</DialogTitle>
          </DialogHeader>
          <div className="text-xs text-muted-foreground mb-2">
            Month: <strong>{month}</strong> • Method: <strong>{method || 'All'}</strong> • Status: <strong>{status || 'All'}</strong>
          </div>
          <div className="grid gap-2 text-sm">
            <div className="flex justify-between"><span>Payments Total</span><span className="font-mono tabular-nums">{formatCurrency(total)} ({count})</span></div>
            {method ? null : (
              <div className="rounded border">
                <div className="px-3 py-2 text-xs text-muted-foreground border-b">Breakdown by method</div>
                <div className="p-3 grid gap-1">
                  {(() => {
                    const knownTotal = breakdown.reduce((s, b) => s + Number(b.q.data?.total || 0), 0);
                    const knownCount = breakdown.reduce((s, b) => s + Number(b.q.data?.count || 0), 0);
                    const otherTotal = Math.max(0, Number(total || 0) - knownTotal);
                    const otherCount = Math.max(0, Number(count || 0) - knownCount);
                    return (
                      <>
                        {breakdown.map(({ m, q }) => (
                          <div key={m} className="flex justify-between text-sm">
                            <span className="capitalize">{m}</span>
                            <span className="font-mono tabular-nums">{formatCurrency(Number(q.data?.total || 0))} ({Number(q.data?.count || 0)})</span>
                          </div>
                        ))}
                        {(otherTotal > 0 || otherCount > 0) && (
                          <div className="flex justify-between text-sm">
                            <span>Other/Unspecified</span>
                            <span className="font-mono tabular-nums">{formatCurrency(otherTotal)} ({otherCount})</span>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ExplainTotals({ userId, paymentsTotal, paidTotal }: { userId: string; paymentsTotal: number; paidTotal: number }) {
  const { data: payData, error: payErr, isFetching: fetchingPayments } = useClientQuery({
    queryKey: ["admin", "payments", "by-user", userId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/payments/user/${userId}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load payments (${r.status})`);
      return j as { payments: PaymentRow[]; total: number };
    },
  });
  const { data: ordData, error: ordErr, isFetching: fetchingOrders } = useClientQuery({
    queryKey: ["admin", "orders", "summary", userId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/orders/user/${userId}/summary`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || `Failed to load order summary (${r.status})`);
      return j as { ordersTotal: number; paidTotal: number; balance: number };
    },
  });
  const list: PaymentRow[] = payData?.payments ?? [];
  const paymentsSum = Number(payData?.total ?? paymentsTotal ?? 0);
  const paidSum = Number(ordData?.paidTotal ?? paidTotal ?? 0);
  const unapplied = Math.max(0, paymentsSum - paidSum);
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-3 gap-3 text-sm">
        <div className="rounded border p-3 text-center">
          <div className="text-muted-foreground">Payments total</div>
          <div className="font-mono tabular-nums font-semibold">{formatCurrency(paymentsSum)}</div>
        </div>
        <div className="rounded border p-3 text-center">
          <div className="text-muted-foreground">Paid (sum of amountPaid)</div>
          <div className="font-mono tabular-nums font-semibold">{formatCurrency(paidSum)}</div>
        </div>
        <div className="rounded border p-3 text-center">
          <div className="text-muted-foreground">Unapplied funds</div>
          <div className={`font-mono tabular-nums font-semibold ${unapplied > 0.005 ? "text-amber-700" : "text-muted-foreground"}`}>{formatCurrency(unapplied)}</div>
        </div>
        <div className="rounded border p-3 text-center">
          <div className="text-muted-foreground">Refunded (cash)</div>
          <div className="font-mono tabular-nums font-semibold text-red-700">
            {formatCurrency(
              list
                .filter((p) => {
                  const status = String(p.status || p.meta?.status || "").toUpperCase();
                  const disposition = String(p.refundDisposition || p.meta?.refundDisposition || "").toUpperCase();
                  return status === "REFUND" && disposition === "CASH";
                })
                .reduce((sum: number, p) => sum + Math.abs(Number(p.amount || 0)), 0)
            )}
          </div>
        </div>
      </div>
      <div className="rounded border overflow-hidden">
        <div className="max-h-[420px] overflow-y-auto">
          <Table className="w-full table-auto">
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead className="text-left">Date</TableHead>
                <TableHead className="text-center">Amount</TableHead>
                <TableHead className="text-left">Applied breakdown</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-left text-sm">{new Date(p.createdAt).toLocaleString()}</TableCell>
                  <TableCell className="text-center font-mono tabular-nums">{formatCurrency(Number(p.amount || 0))}</TableCell>
                  <TableCell className="text-left text-xs">
                    {Array.isArray(p.applied) && p.applied.length > 0 ? (
                      <div className="space-x-2">
                        {p.applied.map((a: PaymentApplied, idx: number) => (
                          <span key={idx} className="inline-block bg-muted rounded px-1.5 py-0.5">
                            {formatOrderId(a.orderId)}: {formatCurrency(Number(a.applied || 0))}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">Not applied to any order</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {list.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-4">
                    {fetchingPayments || fetchingOrders ? "Loading..." : (payErr || ordErr) ? "Failed to load details" : "No payments found"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

function formatOrderStatus(status?: string) {
  return String(status || "UNKNOWN").replace(/_/g, " ").toUpperCase();
}

function formatOrderId(orderId: string) {
  if (!orderId) return "UNKNOWN";
  const clean = orderId.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (clean.length <= 6) return clean || "UNKNOWN";
  const start = clean.slice(0, 3);
  const end = clean.slice(-3);
  return `${start}...${end}`;
}
