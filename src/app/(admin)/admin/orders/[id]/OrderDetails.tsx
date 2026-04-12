"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { hasPermission } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import Image from "next/image";
import {
  Loader2, Package, Printer, MessageSquareText, ChevronRight,
  Pencil, Check, X, Truck, RotateCcw, CheckCircle2,
} from "lucide-react";
import { ADMIN_PHONE } from "@/lib/config";
import { formatCurrency, formatDateTimeGH } from "@/lib/currency";
import { formatIdReadable } from "@/lib/utils";
import { chipToneBorderClass, chipToneClass, orderStatusTone } from "@/lib/status-chips";
import { getOrderDeliveryState } from "@/lib/order-delivery-state";
import { buildAdminAuditHref } from "@/lib/admin-audit-links";
import {
  EmptyTabState,
  OrderKpiStrip,
  OrderNotificationEstimateCard,
  OrderSectionTabs,
  OrderTimelineCard,
  type OrderDetailTabId,
} from "./OrderDetailUi";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function formatStatus(status: string): string {
  switch (String(status || "").toUpperCase()) {
    case "UNPAID": return "Unpaid";
    case "PARTIALLY_PAID": return "Partially Paid";
    case "PAID": return "Paid";
    case "ON_HOLD_CREDIT": return "On Hold (Credit)";
    case "CANCELLED": return "Cancelled";
    case "NOT_DELIVERED": return "Not Delivered";
    case "PARTIALLY_DELIVERED": return "Partially Delivered";
    case "DELIVERED": return "Delivered";
    case "RETURNED": return "Returned";
    default: return status;
  }
}

function formatMethod(method: string): string {
  switch (String(method || "").toLowerCase()) {
    case "cash": return "Cash";
    case "momo": return "MoMo";
    case "transfer": return "Transfer";
    case "card": return "Card";
    case "credit": return "Store Credit";
    case "return": return "Return Adj.";
    case "adjustment": return "Adjustment";
    case "unknown": return "Unknown";
    default: return method || "—";
  }
}

function formatDisposition(d: string): string {
  switch (String(d || "").toUpperCase()) {
    case "RESTOCK": return "Restock";
    case "SCRAP": return "Scrap/Dispose";
    case "RETURN_TO_SUPPLIER": return "Return to Supplier";
    case "CREDIT": return "Store Credit";
    case "CASH": return "Cash Refund";
    case "NORMAL": return "Normal";
    case "REFUND": return "Refund";
    default: return d || "—";
  }
}

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

const nextClientRequestKey = () =>
  globalThis.crypto?.randomUUID?.() ||
  `pay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

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
  subtotal?: number;
  taxRate?: number;
  taxAmount?: number;
  customerType?: "REGISTERED" | "WALK_IN";
  walkInName?: string | null;
  walkInPhone?: string | null;
  deliveryStatus: "NOT_DELIVERED" | "PARTIALLY_DELIVERED" | "DELIVERED" | "RETURNED";
  deliveredAt: string | Date | null;
  total: number;
  amountPaid?: number;
  balance?: number;
  createdAt: string | Date;
  updatedAt?: string | Date;
  adminNote?: string | null;
  user?: { id: string; name: string | null; email: string | null } | null;
  items: OrderItem[];
  payments?: Array<{
    id: string;
    amount: number | string;
    note: string | null;
    status: string;
    createdAt: string | Date;
  }>;
  returnCredits?: Array<{
    id: string;
    amount: number | string;
    note: string | null;
    status: string;
    createdAt: string | Date;
  }>;
  deliveryProof?: {
    recipientName?: string | null;
    recipientPhone?: string | null;
    deliveryNote?: string | null;
    proofImageUrl?: string | null;
    updatedAt?: string | Date | null;
  } | null;
};

export default function OrderDetails({ orderId }: OrderDetailsProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const canReturn = hasPermission(role, "orders.return");
  const queryClient = useQueryClient();
  const { data, error, isLoading } = useClientQuery<{ data: OrderPayload }>({
    queryKey: ["order", orderId],
    queryFn: () => fetcher(`/api/orders/${orderId}`),
    refetchInterval: 30000,
    enabled: !!orderId,
  });
  const { data: paymentPostingData } = useClientQuery<{
    orderId: string;
    totalPayments: number;
    postedCount: number;
    pendingCount: number;
    postedPaymentIds: string[];
    pendingPaymentIds: string[];
  }>({
    queryKey: ["admin", "order", orderId, "payment-posting-status"],
    queryFn: () => fetcher(`/api/admin/orders/${orderId}/payment-posting-status`),
    refetchInterval: 15000,
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
  const [returnDisposition, setReturnDisposition] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const [returnReasonNote, setReturnReasonNote] = useState("");
  const [returnHoldCredit, setReturnHoldCredit] = useState(false);
  const [returnDispositionError, setReturnDispositionError] = useState("");
  const [returnReasonError, setReturnReasonError] = useState("");
  const [deliveryItem, setDeliveryItem] = useState<OrderItem | null>(null);
  const [deliveryMode, setDeliveryMode] = useState<"delivered" | "partial">("delivered");
  const [deliveryQty, setDeliveryQty] = useState<string>("1");
  const [deliveryItemSubmitting, setDeliveryItemSubmitting] = useState(false);
  const [deliveryQtyError, setDeliveryQtyError] = useState("");
  const [activeTab, setActiveTab] = useState<OrderDetailTabId>("items");
  const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);
  const [paymentRequestKey, setPaymentRequestKey] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentNote, setPaymentNote] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"" | "cash" | "momo" | "transfer" | "card">("");
  const [paymentError, setPaymentError] = useState("");
  const [paymentMethodError, setPaymentMethodError] = useState("");
  const [paymentTab, setPaymentTab] = useState<"custom" | "full">("custom");
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [releaseHoldSubmitting, setReleaseHoldSubmitting] = useState(false);
  const [confirmReleaseHold, setConfirmReleaseHold] = useState(false);
  const [releaseHoldForce, setReleaseHoldForce] = useState(false);
  const [releaseHoldNote, setReleaseHoldNote] = useState("");
  const [cancelingPendingMomo, setCancelingPendingMomo] = useState(false);
  const [checkingPendingMomoId, setCheckingPendingMomoId] = useState<string | null>(null);
  const [checkingAllPendingMomo, setCheckingAllPendingMomo] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [noteValue, setNoteValue] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    if (!confirmCancel) {
      setCancelError("");
    }
  }, [confirmCancel]);

  useEffect(() => {
    if (!returningItem) {
      setReturnQtyError("");
      setReturnDisposition("");
      setReturnReason("");
      setReturnReasonNote("");
      setReturnDispositionError("");
      setReturnReasonError("");
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
  const parsedReturnQty = Number(returnQuantity);
  const safeReturnQty = Number.isFinite(parsedReturnQty) && parsedReturnQty > 0 ? parsedReturnQty : 0;
  const returnRequestedAmount = returningItem ? Math.max(0, safeReturnQty * Number(returningItem.price || 0)) : 0;
  const orderOutstandingForReturn = Math.max(0, Number(order.balance || 0));
  const returnAppliedToCurrentOrder = Math.min(returnRequestedAmount, orderOutstandingForReturn);
  const returnCreditCreated = Math.max(0, returnRequestedAmount - returnAppliedToCurrentOrder);
  const returnAutoApplyEstimate = returnHoldCredit ? 0 : returnCreditCreated;
  const amountPaid = Number(order.amountPaid ?? 0);
  const rawBalance = Number(order.balance ?? Math.max(0, order.total - amountPaid));
  const balance = Math.abs(rawBalance) < 0.01 ? 0 : rawBalance;
  const isBalanceZero = balance <= 0;
  const isCreditHold = String(order.status || "").toUpperCase() === "ON_HOLD_CREDIT";
  const lineTotal = order.items.reduce(
    (sum, it) => sum + Number(it.price || 0) * Number(it.quantity || 0),
    0,
  );
  const subtotal = Number(order.subtotal ?? lineTotal);
  const taxRate = Number(order.taxRate ?? 0);
  const taxAmount = Number(order.taxAmount ?? 0);
  const orderTotal = Number(order.total || 0);
  const discountAmount = Math.max(0, subtotal + taxAmount - orderTotal);
  const returnedValue = order.items.reduce(
    (sum, it) => sum + Number(it.price || 0) * Number(it.returnedQuantity || 0),
    0,
  );
  const deliveryState = getOrderDeliveryState(order.items);
  const allDelivered = deliveryState.allDelivered;
  const anyDelivered = deliveryState.anyDelivered;
  const hasOutstandingDeliveredUnits = deliveryState.hasOutstandingDeliveredUnits;
  const deliveryStatusLabel = formatStatus(order.deliveryStatus || "NOT_DELIVERED");
  const canManageOrderState = role === "ADMIN";
  const canDeleteOrder =
    role === "ADMIN" &&
    amountPaid <= 0 &&
    String(order.deliveryStatus || "NOT_DELIVERED") === "NOT_DELIVERED";
  const canCancelOrder = role === "ADMIN" && order.status !== "CANCELLED";

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
          status?: string;
          providerRef?: string;
        };
        if (meta.reference === "AUTO_APPLY" && Array.isArray(meta.applied)) {
          for (const a of meta.applied) {
            if (a && a.orderId === order.id) {
              storeCreditApplied += Number(a.applied || 0);
            }
          }
        }
        const momoStatus = String(meta.status || "").toUpperCase();
        const isProviderLinkedMomo =
          meta.method === "momo" && Boolean(String(meta.providerRef || "").trim());
        const isProviderMomoSettled = momoStatus === "SUCCESS" || momoStatus === "SUCCESSFUL";
        const isProviderMomoUnsettled = isProviderLinkedMomo && !isProviderMomoSettled;
        if (meta.method === "momo" && !isProviderMomoUnsettled) {
          momoPaid += amount;
        }
        if (meta.method === "cash" || meta.method === "transfer" || meta.method === "card") {
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
          Number(p.amount) > 0 &&
          (p.status || "").toUpperCase() === "NORMAL"
        ) {
          hasPaymentRecorded = true;
        }
        if (
          meta.reference === "AUTO_APPLY" ||
          meta.reference === "ITEM_RETURN" ||
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
      let isReturnAdjustment = false;
      let adjustmentAmount = 0;
      if (p.note) {
        try {
          const meta = JSON.parse(p.note as string) as {
            method?: string;
            provider?: string;
            reference?: string;
            appliedToBalance?: number;
            balanceAdjustment?: boolean;
            adjustmentAmount?: number;
            status?: string;
            providerRef?: string;
          };
          if (meta.method) method = meta.method;
          if (meta.provider) provider = meta.provider;
          if (meta.reference) reference = meta.reference;
          const momoStatus = String(meta.status || "").toUpperCase();
          const isProviderLinkedMomo =
            meta.method === "momo" &&
            Boolean(String(meta.providerRef || "").trim());
          const isProviderMomoSettled =
            momoStatus === "SUCCESS" || momoStatus === "SUCCESSFUL";
          const providerMomoUnsettled = Boolean(
            isProviderLinkedMomo && !isProviderMomoSettled,
          );
          const applied = Number(
            meta.adjustmentAmount ?? meta.appliedToBalance ?? 0
          );
          if (
            meta.reference === "ITEM_RETURN" &&
            (meta.balanceAdjustment || applied > 0) &&
            Number(p.amount || 0) === 0
          ) {
            isReturnAdjustment = true;
            adjustmentAmount = applied;
          }
          return {
            ...p,
            method: isReturnAdjustment ? "return" : method,
            provider,
            reference: isReturnAdjustment ? "APPLIED_TO_BALANCE" : reference,
            createdAt: new Date(p.createdAt),
            isReturnAdjustment,
            adjustmentAmount,
            pendingProviderMomo: providerMomoUnsettled,
            momoProviderStatus: momoStatus,
          };
        } catch {
          // ignore malformed notes
        }
      }
      return {
        ...p,
        method: isReturnAdjustment ? "return" : method,
        provider,
        reference: isReturnAdjustment ? "APPLIED_TO_BALANCE" : reference,
        createdAt: new Date(p.createdAt),
        isReturnAdjustment,
        adjustmentAmount,
        pendingProviderMomo: false,
        momoProviderStatus: "",
      };
    });
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  })();
  const pendingMomoPayments = (() => {
    const rows: Array<{ id: string; provider: string; ref: string }> = [];
    for (const p of order.payments || []) {
      if (!p.note) continue;
      try {
        const meta = JSON.parse(p.note as string) as {
          method?: string;
          provider?: string;
          providerRef?: string;
          status?: string;
        };
        if (meta.method !== "momo") continue;
        if (String(meta.status || "").toUpperCase() !== "PENDING") continue;
        rows.push({
          id: p.id,
          provider: meta.provider || "momo",
          ref: meta.providerRef || "-",
        });
      } catch {
        // ignore malformed notes
      }
    }
    return rows;
  })();
  const unsettledProviderMomoCount = paymentLedger.filter((p) =>
    Boolean((p as { pendingProviderMomo?: boolean }).pendingProviderMomo),
  ).length;

  const cancelPendingMomoRequests = async () => {
    if (pendingMomoPayments.length === 0) return;
    setCancelingPendingMomo(true);
    try {
      const results = await Promise.all(
        pendingMomoPayments.map(async (row) => {
          const res = await fetch(`/api/admin/payments/momo/${row.id}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "Order settled through another confirmed payment path" }),
          });
          const payload = await res.json().catch(() => ({} as { error?: string }));
          return { ok: res.ok, error: payload?.error || "Failed", id: row.id };
        }),
      );
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        toast.error(`Canceled ${results.length - failed.length}/${results.length}. ${failed[0].error}`);
      } else {
        toast.success(`Canceled ${results.length} pending MoMo request(s).`);
      }
      await queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      await queryClient.invalidateQueries({ queryKey: ["admin","payments","momo","pending"] });
    } finally {
      setCancelingPendingMomo(false);
    }
  };
  const checkPendingMomoStatus = async (paymentId: string) => {
    try {
      setCheckingPendingMomoId(paymentId);
      const res = await fetch(`/api/payments/momo/status/${paymentId}`);
      const payload = await res.json().catch(() => ({} as { error?: string; status?: string }));
      if (!res.ok) {
        toast.error(payload?.error || "Failed to check MoMo status.");
        return;
      }
      const normalized = String(payload?.status || "").toUpperCase();
      if (normalized === "SUCCESSFUL" || normalized === "SUCCESS") {
        toast.success("MoMo payment confirmed and applied.");
      } else if (normalized === "PENDING" || normalized === "PENDING_FORCED_TEST") {
        toast.message("MoMo payment is still pending.");
      } else if (normalized) {
        toast.warning(`MoMo status: ${normalized}`);
      } else {
        toast.message("Status checked.");
      }
      await queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "order", orderId, "payment-posting-status"] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "payments", "momo", "pending"] });
    } finally {
      setCheckingPendingMomoId(null);
    }
  };
  const checkAllPendingMomoStatuses = async () => {
    if (pendingMomoPayments.length === 0) return;
    try {
      setCheckingAllPendingMomo(true);
      const results = await Promise.all(
        pendingMomoPayments.map(async (row) => {
          const res = await fetch(`/api/payments/momo/status/${row.id}`);
          const payload = await res.json().catch(() => ({} as { status?: string; error?: string }));
          return {
            ok: res.ok,
            status: String(payload?.status || "").toUpperCase(),
            error: payload?.error || "",
          };
        }),
      );
      const failed = results.filter((r) => !r.ok);
      const succeeded = results.filter((r) => r.status === "SUCCESS" || r.status === "SUCCESSFUL").length;
      if (failed.length > 0) {
        toast.error(`Checked ${results.length - failed.length}/${results.length}. ${failed[0].error || "Some checks failed."}`);
      } else if (succeeded > 0) {
        toast.success(`Checked ${results.length} pending request(s). ${succeeded} confirmed successful.`);
      } else {
        toast.message(`Checked ${results.length} pending request(s).`);
      }
      await queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "order", orderId, "payment-posting-status"] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "payments", "momo", "pending"] });
    } finally {
      setCheckingAllPendingMomo(false);
    }
  };
  const returnAdjustments = (() => {
    const itemNameById = new Map(order.items.map((item) => [item.id, item.product?.name || "Item"]));
    const paymentIds = new Set(paymentLedger.map((p) => p.id));
    const all = [...(order.payments || []), ...(order.returnCredits || [])];
    const rows = all
      .map((p) => {
        if (!p.note) return null;
        try {
          const meta = JSON.parse(p.note) as {
            reference?: string;
            refundDisposition?: string | null;
            method?: string;
            status?: string;
            restockToStock?: boolean;
            item?: { id?: string; quantity?: number; lineRefund?: number };
          };
          if (meta.reference !== "ITEM_RETURN") return null;
          const itemId = meta.item?.id || "";
          const itemLabel = itemNameById.get(itemId) || "Item return";
          const quantity = Number(meta.item?.quantity || 0);
          const amount = Number(meta.item?.lineRefund || p.amount || 0);
          return {
            id: p.id,
            createdAt: new Date(p.createdAt),
            itemLabel,
            quantity,
            amount,
            method: meta.method || "adjustment",
            disposition: meta.refundDisposition || meta.status || p.status,
            status: p.status,
            restockToStock: meta.restockToStock !== false,
            inLedger: paymentIds.has(p.id),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<{
      id: string;
      createdAt: Date;
      itemLabel: string;
      quantity: number;
      amount: number;
      method: string;
      disposition: string;
      status: string;
      restockToStock: boolean;
      inLedger: boolean;
    }>;
    return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  })();
  const paymentLedgerWithBalance = (() => {
    let remaining = Number(order.total || 0);
    return paymentLedger.map((p) => {
      const isProviderMomoUnsettled = Boolean((p as { pendingProviderMomo?: boolean }).pendingProviderMomo);
      if (!p.isReturnAdjustment && !isProviderMomoUnsettled) {
        const amount = Number(p.amount || 0);
        const isRefund =
          amount < 0 || String(p.status || "").toUpperCase() === "REFUND";
        if (isRefund) {
          remaining += Math.abs(amount);
        } else {
          remaining -= amount;
        }
      }
      const normalized = Math.abs(remaining) < 0.01 ? 0 : Math.max(0, remaining);
      return { ...p, remaining: normalized };
    });
  })();
  const ledgerTotal = paymentLedger.reduce(
    (sum, p) =>
      sum +
      (p.isReturnAdjustment || (p as { pendingProviderMomo?: boolean }).pendingProviderMomo
        ? 0
        : Number(p.amount || 0)),
    0
  );
  const nonLedgerReturnCreditTotal = returnAdjustments.reduce((sum, r) => {
    const disposition = String(r.disposition || "").toUpperCase();
    const isCredit = disposition.includes("CREDIT");
    return sum + (!r.inLedger && isCredit ? Math.abs(Number(r.amount || 0)) : 0);
  }, 0);
  const ledgerNetPaid = ledgerTotal - nonLedgerReturnCreditTotal;
  const ledgerMatchesAmountPaid = Math.abs(ledgerNetPaid - amountPaid) < 0.01;
  const backorderLines = (() => {
    const note = String(order.adminNote || "").trim();
    if (!note) return [] as Array<{
      productName: string;
      requested: number;
      supplyingNow: number;
      remaining: number;
      etaDays: number | null;
      raw: string;
    }>;
    return note
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().startsWith("backorder pending:"))
      .map((line) => {
        const m = line.match(
          /^Backorder pending:\s*(.+?)\s*requested\s*(\d+)\s*,\s*supplying\s*(\d+)\s*now\s*,\s*remaining\s*(\d+)\.\s*(?:ETA\s*(\d+)\s*day\(s\)\.)?$/i,
        );
        if (!m) {
          return {
            productName: line.replace(/^Backorder pending:\s*/i, ""),
            requested: 0,
            supplyingNow: 0,
            remaining: 0,
            etaDays: null,
            raw: line,
          };
        }
        return {
          productName: m[1].trim(),
          requested: Number(m[2] || 0),
          supplyingNow: Number(m[3] || 0),
          remaining: Number(m[4] || 0),
          etaDays: m[5] ? Number(m[5]) : null,
          raw: line,
        };
      });
  })();

  const openPaymentDialog = () => {
    setPaymentAmount("");
    setPaymentNote("");
    setPaymentMethod("");
    setPaymentError("");
    setPaymentMethodError("");
    setPaymentTab("custom");
    setPaymentRequestKey(nextClientRequestKey());
    setIsPaymentDialogOpen(true);
  };

  const recordPayment = async () => {
    if (isBalanceZero) {
      setPaymentError("No outstanding balance to pay.");
      return;
    }
    const amount = Number(paymentAmount);
    if (!paymentAmount || !Number.isFinite(amount) || amount <= 0) {
      setPaymentError("Enter a valid amount.");
      return;
    }
    if (!paymentMethod) {
      setPaymentMethodError("Select payment method.");
      return;
    }
    if (amount > balance) {
      setPaymentError("Amount cannot exceed remaining balance.");
      return;
    }

    try {
      setPaymentSubmitting(true);
      setPaymentError("");
      setPaymentMethodError("");
      const res = await fetch(`/api/orders/${orderId}/payment`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "idempotency-key": paymentRequestKey || nextClientRequestKey(),
        },
        body: JSON.stringify({
          amount,
          method: paymentMethod,
          note: paymentNote || undefined,
        }),
      });

      if (!res.ok) {
        const j = await res
          .json()
          .catch(async () => ({ error: await res.text().catch(() => "") }));
        const msg = j?.error || "Failed to record payment";
        throw new Error(msg);
      }

      const payload = (await res.json().catch(() => ({} as { duplicate?: boolean }))) as {
        duplicate?: boolean;
      };
      toast.success(
        payload.duplicate
          ? `Payment request already recorded for ${formatCurrency(amount)}.`
          : `Payment of ${formatCurrency(amount)} recorded.`,
      );
      setPaymentAmount("");
      setPaymentNote("");
      setPaymentMethod("");
      setPaymentRequestKey("");
      setIsPaymentDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["order", orderId] });
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Error recording payment.");
    } finally {
      setPaymentSubmitting(false);
    }
  };
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
      const isUnsettledProviderMomo = Boolean(
        (p as { pendingProviderMomo?: boolean }).pendingProviderMomo,
      );
      const momoProviderStatus = String(
        (p as { momoProviderStatus?: string }).momoProviderStatus || "",
      ).toUpperCase();
      const amount = Number(p.amount || 0);
      const status = String(p.status || "").toUpperCase();
      const isRefund = status === "REFUND" || amount < 0;
      const method = p.method || "unknown";
      const ref = p.reference ? ` · Ref ${p.reference}` : "";
      if (isUnsettledProviderMomo) {
        const label =
          momoProviderStatus === "CANCELLED_BY_STAFF"
            ? "MoMo request canceled"
            : "MoMo request pending";
        events.push({
          time: p.createdAt,
          label,
          detail: `${formatCurrency(Math.abs(amount))} via ${method}${ref}`,
        });
        continue;
      }
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
      toast.success(`Order marked as ${formatStatus(newStatus)}`);
    } catch (err) {
      console.error(err);
      toast.error("Unexpected error updating order.");
    } finally {
      setUpdating(false);
    }
  }

  async function updateDelivery(
    newDelivery: "NOT_DELIVERED" | "PARTIALLY_DELIVERED" | "DELIVERED",
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
          : "Marked as Not Delivered",
      );
    } catch (err) {
      console.error(err);
      toast.error("Unexpected error updating delivery.");
    } finally {
      setDeliveryUpdating(false);
    }
  }

  async function releaseCreditHold() {
    try {
      setReleaseHoldSubmitting(true);
      const res = await fetch(`/api/admin/orders/${orderId}/release-hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          force: releaseHoldForce,
          note: releaseHoldNote || undefined,
        }),
      });
      const j = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) {
        throw new Error(j?.error || "Failed to release credit hold");
      }
      queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      toast.success("Credit hold released.");
      setConfirmReleaseHold(false);
      setReleaseHoldForce(false);
      setReleaseHoldNote("");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to release credit hold";
      toast.error(message);
    } finally {
      setReleaseHoldSubmitting(false);
    }
  }

  async function deleteOrder() {
    try {
      setDeleting(true);
      const res = await fetch(`/api/orders/${orderId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const j = await res
          .json()
          .catch(async () => ({ error: await res.text().catch(() => "") }));
        toast.error(j?.error || "Failed to delete order");
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
    if (!returnDisposition) {
      setReturnDispositionError("Select an RMA disposition.");
      return;
    }
    setReturnDispositionError("");
    if (!returnReason) {
      setReturnReasonError("Select a return reason.");
      return;
    }
    setReturnReasonError("");
    try {
      const refundMode = order.customerType === "WALK_IN" ? "cash" : "credit";
      setReturnSubmitting(true);
      const res = await fetch(`/api/admin/orders/${orderId}/return-item`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: returningItem.id,
          quantity: qty,
          refundMode,
          disposition: returnDisposition,
          reason: returnReason,
          reasonNote: returnReasonNote.trim() || undefined,
          restock: returnDisposition === "RESTOCK",
          skipAutoApplyCredit: returnHoldCredit,
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
      setReturnHoldCredit(false);
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
      const remaining = Math.max(
        0,
        deliveryItem.quantity - (deliveryItem.deliveredQuantity ?? 0),
      );
      qty = Number(deliveryQty);
      if (!Number.isInteger(qty) || qty <= 0) {
        setDeliveryQtyError("Enter a valid additional delivered quantity.");
        return;
      }
      if (qty > remaining) {
        setDeliveryQtyError("Delivered quantity cannot exceed the remaining units.");
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

  async function saveNote() {
    try {
      setSavingNote(true);
      const res = await fetch(`/api/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminNote: noteValue }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as { error?: string }));
        toast.error(j?.error || "Failed to save note.");
        return;
      }
      toast.success("Note saved.");
      setEditingNote(false);
      queryClient.invalidateQueries({ queryKey: ["order", orderId] });
    } catch (e) {
      console.error(e);
      toast.error("Unexpected error saving note.");
    } finally {
      setSavingNote(false);
    }
  }

  return (
    <>
    <div className="max-w-5xl mx-auto w-full space-y-4">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/admin/orders" className="hover:text-foreground transition-colors">Orders</Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium">{formatIdReadable(order.id)}</span>
      </nav>

      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Package className="w-5 h-5 text-primary shrink-0" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-tight truncate">
              Order {formatIdReadable(order.id)}
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Created {formatDateTimeGH(order.createdAt)}
              {order.updatedAt ? ` · Updated ${formatDateTimeGH(order.updatedAt)}` : ""}
            </p>
          </div>
          <span
            className={`shrink-0 inline-flex items-center px-2 py-1 text-xs rounded-full border ${
              chipToneClass(orderStatusTone(order.status))
            } ${chipToneBorderClass(orderStatusTone(order.status))}`}
          >
            {formatStatus(order.status)}
          </span>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2 items-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.open(`/admin/orders/${orderId}/receipt`, "_blank")}
          >
            <Printer className="w-4 h-4 mr-1" />
            Print
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">Send Receipt</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={async () => {
                  try {
                    const res = await fetch(`/api/orders/${orderId}/receipt/sms`, { method: "POST" });
                    const j = await res.json().catch(async () => ({ error: await res.text().catch(() => "") }));
                    if (!res.ok) throw new Error(j?.error || "Failed to send receipt");
                    toast.success("Receipt sent via WhatsApp/SMS");
                  } catch (e: unknown) {
                    toast.error(e instanceof Error ? e.message : "Could not send receipt");
                  }
                }}
              >
                <MessageSquareText className="w-4 h-4 mr-2" />
                WhatsApp / SMS
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  try {
                    const r = await fetch(`/api/orders/${orderId}/receipt/email`, { method: "POST" });
                    const j = await r.json().catch(() => ({} as { error?: string; simulated?: boolean }));
                    if (!r.ok) throw new Error(j?.error || "Failed to email receipt");
                    toast.success(`Receipt emailed${j?.simulated ? " (simulated)" : ""}`);
                  } catch (e: unknown) {
                    toast.error(e instanceof Error ? e.message : "Email failed");
                  }
                }}
              >
                Email
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {role === "ADMIN" ? (
            <Button variant="outline" size="sm" asChild>
              <Link
                href={buildAdminAuditHref({
                  entityType: "ORDER",
                  entityId: order.id,
                  sourcePage: "admin/orders/[id]",
                })}
              >
                Audit Log
              </Link>
            </Button>
          ) : null}
          {canManageOrderState ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={updating || deleting || (!canCancelOrder && !canDeleteOrder)}
                >
                  Actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    if (hasOutstandingDeliveredUnits) {
                      toast.error("Process item returns for all delivered units before cancelling this order.");
                      return;
                    }
                    setConfirmCancel(true);
                  }}
                  disabled={updating || deleting || !canCancelOrder}
                >
                  Cancel order
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setConfirmDelete(true)}
                  disabled={deleting || !canDeleteOrder}
                >
                  Delete order
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      {/* Alert banners */}
      {isCreditHold ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 text-rose-800 p-3 text-sm flex items-start justify-between gap-3">
          <div>
            <p className="font-medium">Credit Hold Active</p>
            <p className="text-xs mt-0.5">
              Deliveries are blocked until the outstanding balance falls below the credit limit or an admin overrides the hold.
              {order.user?.id ? (
                <> <Link href={`/admin/customers/${order.user.id}/view`} className="underline">View customer account</Link> for credit limit details.</>
              ) : null}
            </p>
          </div>
          {role === "ADMIN" ? (
            <Button size="sm" variant="outline" className="shrink-0 border-rose-300 text-rose-800 hover:bg-rose-100"
              disabled={releaseHoldSubmitting} onClick={() => setConfirmReleaseHold(true)}>
              {releaseHoldSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Release hold
            </Button>
          ) : null}
        </div>
      ) : null}
      {isUnpaid && !isCreditHold ? (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 text-yellow-800 p-3 text-sm">
          Unpaid order. Customer sees instructions to call {ADMIN_PHONE} to complete payment.
        </div>
      ) : null}
      {pendingMomoPayments.length > 0 && balance > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p className="font-medium">MoMo payment pending approval ({pendingMomoPayments.length})</p>
          <p className="mt-0.5">Do not release items until payment is confirmed.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={checkAllPendingMomoStatuses} disabled={checkingAllPendingMomo}>
              {checkingAllPendingMomo ? "Checking..." : "Check status"}
            </Button>
            <Button size="sm" variant="outline" onClick={cancelPendingMomoRequests} disabled={cancelingPendingMomo}>
              {cancelingPendingMomo ? "Canceling..." : "Cancel pending MoMo request(s)"}
            </Button>
          </div>
        </div>
      ) : null}
      {pendingMomoPayments.length > 0 && balance <= 0 ? (
        <div className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-900">
          <p className="font-medium">MoMo provider request still pending ({pendingMomoPayments.length})</p>
          <p className="mt-0.5">This order is already settled. Review pending MoMo references to avoid duplicate settlement.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={checkAllPendingMomoStatuses} disabled={checkingAllPendingMomo}>
              {checkingAllPendingMomo ? "Checking..." : "Check status"}
            </Button>
            <Button size="sm" variant="outline" onClick={cancelPendingMomoRequests} disabled={cancelingPendingMomo}>
              {cancelingPendingMomo ? "Canceling..." : "Cancel pending MoMo request(s)"}
            </Button>
          </div>
        </div>
      ) : null}
      {pendingMomoPayments.length === 0 && unsettledProviderMomoCount > 0 && balance > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {unsettledProviderMomoCount} provider MoMo record(s) not in settled state. Use confirmed payment methods only.
        </div>
      ) : null}

      <OrderKpiStrip
        totalLabel={formatCurrency(orderTotal)}
        paidLabel={formatCurrency(amountPaid)}
        balanceLabel={formatCurrency(balance)}
        balanceTone={balance > 0 ? "warning" : "positive"}
        deliveryLabel={deliveryStatusLabel}
        deliveryStatus={order.deliveryStatus || "NOT_DELIVERED"}
      />

      <OrderSectionTabs activeTab={activeTab} onChange={setActiveTab} />

      {/* Two-column body */}
      <div className="grid gap-4 lg:grid-cols-12">

        {/* LEFT: order summary + items + payments */}
        <div className="space-y-4 lg:col-span-8">

          {/* Order summary card */}
          {false ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Order Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Financial summary grid */}
              <div className="rounded-md bg-muted/40 p-3 space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{formatCurrency(subtotal)}</span>
                </div>
                {taxAmount > 0 ? (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tax{taxRate > 0 ? ` (${taxRate}%)` : ""}</span>
                    <span>{formatCurrency(taxAmount)}</span>
                  </div>
                ) : null}
                {discountAmount > 0 ? (
                  <div className="flex justify-between text-amber-700">
                    <span>Discount</span>
                    <span>-{formatCurrency(discountAmount)}</span>
                  </div>
                ) : null}
                <div className="flex justify-between font-semibold border-t pt-1.5 mt-1">
                  <span>Total</span>
                  <span>{formatCurrency(orderTotal)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Amount Paid</span>
                  <span className="text-green-700">{formatCurrency(amountPaid)}</span>
                </div>
                {(paymentBreakdown.cashPaid > 0 || paymentBreakdown.momoPaid > 0 || paymentBreakdown.storeCreditApplied > 0) ? (
                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground pl-2">
                    {paymentBreakdown.cashPaid > 0 ? <span>Cash/card/transfer: {formatCurrency(paymentBreakdown.cashPaid)}</span> : null}
                    {paymentBreakdown.momoPaid > 0 ? <span>MoMo: {formatCurrency(paymentBreakdown.momoPaid)}</span> : null}
                    {paymentBreakdown.storeCreditApplied > 0 ? <span>Store credit: {formatCurrency(paymentBreakdown.storeCreditApplied)}</span> : null}
                  </div>
                ) : null}
                <div className={`flex justify-between font-medium border-t pt-1.5 mt-1 ${balance > 0 ? "text-red-700" : "text-green-700"}`}>
                  <span>Outstanding Balance</span>
                  <span>{formatCurrency(balance)}</span>
                </div>
              </div>

              {/* Record payment CTA */}
              {isUnpaid ? (
                <Button className="w-full sm:w-auto" onClick={openPaymentDialog}>
                  Record Payment
                </Button>
              ) : null}
            </CardContent>
          </Card>
          ) : null}

          {/* Items card */}
          {activeTab === "items" ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Items ({order.items.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {!canReturn ? (
                <p className="text-xs text-muted-foreground mb-3">
                  Returns can only be initiated by admins. Staff can still record payments and update delivery status.
                </p>
              ) : null}
              <div className="grid gap-3">
                {order.items.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border rounded-lg p-3"
                  >
                    <div className="flex items-start gap-3 w-full sm:w-auto">
                      <div className="relative w-14 h-14 shrink-0">
                        <Image
                          src={item.product?.imageUrl || "/placeholder.png"}
                          alt={item.product?.name || "Product"}
                          fill
                          className="object-cover rounded"
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{item.product?.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Qty: {item.quantity} · {formatCurrency(item.price)} each
                        </p>
                        <div className="flex flex-wrap gap-2 mt-1 text-[11px]">
                          {typeof item.deliveredQuantity === "number" && item.deliveredQuantity > 0 ? (
                            <span className="text-green-700">Delivered: {item.deliveredQuantity}/{item.quantity}</span>
                          ) : (
                            <span className="text-muted-foreground">Not yet delivered</span>
                          )}
                          {typeof item.returnedQuantity === "number" && item.returnedQuantity > 0 ? (
                            <span className="text-amber-700">Returned: {item.returnedQuantity}</span>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-2 w-full sm:w-auto">
                      <p className="font-semibold text-sm">{formatCurrency(item.quantity * item.price)}</p>
                      <div className="flex flex-wrap gap-2 justify-end">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            order.status === "CANCELLED" || isCreditHold || deliveryItemSubmitting ||
                            (item.deliveredQuantity ?? 0) >= item.quantity
                          }
                          title={(item.deliveredQuantity ?? 0) >= item.quantity ? "All units already delivered" : undefined}
                          onClick={() => {
                            setDeliveryItem(item);
                            setDeliveryMode("delivered");
                            setDeliveryQty(String(item.quantity));
                          }}
                        >
                          Mark Delivered
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            order.status === "CANCELLED" || isCreditHold || deliveryItemSubmitting ||
                            (item.deliveredQuantity ?? 0) >= item.quantity
                          }
                          title={(item.deliveredQuantity ?? 0) >= item.quantity ? "All units already delivered" : "Record a partial delivery"}
                          onClick={() => {
                            setDeliveryItem(item);
                            setDeliveryMode("partial");
                            const remaining = item.quantity - (item.deliveredQuantity ?? 0);
                            setDeliveryQty(String(remaining > 0 ? remaining : item.quantity));
                          }}
                        >
                          Partial Delivery
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            !canReturn || order.status === "CANCELLED" || returnSubmitting ||
                            (typeof item.deliveredQuantity === "number"
                              ? item.deliveredQuantity - (item.returnedQuantity ?? 0) <= 0
                              : (item.returnedQuantity ?? 0) >= item.quantity)
                          }
                          title={!canReturn ? "Admin only" : undefined}
                          onClick={() => {
                            if (!canReturn) { toast.error("Only admins can process returns."); return; }
                            const delivered = item.deliveredQuantity ?? 0;
                            const alreadyReturned = item.returnedQuantity ?? 0;
                            const maxReturnable = Math.max(0, delivered - alreadyReturned);
                            if (maxReturnable <= 0) {
                              toast.info("No delivered units are available to return for this item.");
                              return;
                            }
                            setReturningItem(item);
                            setReturnQuantity("1");
                            setReturnDisposition("");
                            setReturnReason("");
                            setReturnReasonNote("");
                          }}
                        >
                          Return
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          ) : null}

          {/* Payments & Ledger card */}
          {activeTab === "payments" ? (
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold">
                Payments
                {paymentPostingData?.totalPayments ? (
                  <span className={`ml-2 text-xs font-normal ${paymentPostingData.pendingCount > 0 ? "text-amber-600" : "text-emerald-600"}`}>
                    · Journal: {paymentPostingData.pendingCount > 0
                      ? `Pending (${paymentPostingData.pendingCount}/${paymentPostingData.totalPayments})`
                      : "Posted"}
                  </span>
                ) : null}
              </CardTitle>
              {isUnpaid ? (
                <Button size="sm" variant="outline" onClick={openPaymentDialog}>Record Payment</Button>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              {paymentLedger.length === 0 ? (
                <p className="text-xs text-muted-foreground">No payments recorded for this order yet.</p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-xs whitespace-nowrap">
                      <thead className="text-muted-foreground border-b">
                        <tr>
                          <th className="text-left py-2 pr-4">Date</th>
                          <th className="text-left py-2 pr-4">Method</th>
                          <th className="text-left py-2 pr-4">Reference</th>
                          <th className="text-right py-2 pr-4">Amount</th>
                          <th className="text-right py-2 pr-4">Balance After</th>
                          <th className="text-right py-2 pr-4">Status</th>
                          <th className="text-right py-2">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paymentLedgerWithBalance.map((p) => (
                          <tr key={p.id} className="border-t">
                            <td className="py-2 pr-4">{formatDateTimeGH(p.createdAt)}</td>
                            <td className="py-2 pr-4">{formatMethod(p.method)}{p.provider ? ` (${p.provider})` : ""}</td>
                            <td className="py-2 pr-4">{p.reference || "—"}</td>
                            <td className="py-2 pr-4 text-right">
                              {formatCurrency(
                                p.isReturnAdjustment
                                  ? -Math.abs(p.adjustmentAmount || 0)
                                  : Number(p.amount || 0)
                              )}
                            </td>
                            <td className="py-2 pr-4 text-right">{formatCurrency(p.remaining)}</td>
                            <td className="py-2 pr-4 text-right">
                              {p.isReturnAdjustment
                                ? "Adjustment"
                                : Boolean((p as { pendingProviderMomo?: boolean }).pendingProviderMomo)
                                ? String((p as { momoProviderStatus?: string }).momoProviderStatus || "Pending")
                                : formatDisposition(p.status)}
                            </td>
                            <td className="py-2 text-right">
                              {Boolean((p as { pendingProviderMomo?: boolean }).pendingProviderMomo) ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-[11px]"
                                  onClick={() => void checkPendingMomoStatus(p.id)}
                                  disabled={checkingPendingMomoId === p.id || checkingAllPendingMomo}
                                >
                                  {checkingPendingMomoId === p.id ? "Checking..." : "Check status"}
                                </Button>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Ledger total: {formatCurrency(ledgerTotal)}
                    {nonLedgerReturnCreditTotal > 0 ? (
                      <> · Less non-ledger return credits: {formatCurrency(nonLedgerReturnCreditTotal)} · Net paid: {formatCurrency(ledgerNetPaid)}</>
                    ) : null}
                    {" · "}
                    {ledgerMatchesAmountPaid
                      ? "Matches amount paid"
                      : <span className="text-amber-700">Does not match amount paid ({formatCurrency(amountPaid)})</span>}
                  </p>
                  {paymentLedger.some((p) => p.isReturnAdjustment) ? (
                    <p className="text-xs text-muted-foreground">
                      Return adjustments applied to balance are excluded from the ledger total.
                    </p>
                  ) : null}
                </>
              )}

              {/* Return credits */}
              {returnAdjustments.length > 0 ? (
                <div className="border-t pt-3">
                  <h4 className="text-xs font-semibold mb-1">Return Credits &amp; Refunds</h4>
                  <p className="text-xs text-muted-foreground mb-2">
                    Store-credit returns appear here even when not tied to the payment ledger.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-xs whitespace-nowrap">
                      <thead className="text-muted-foreground border-b">
                        <tr>
                          <th className="text-left py-1.5 pr-4">Date</th>
                          <th className="text-left py-1.5 pr-4">Item</th>
                          <th className="text-right py-1.5 pr-4">Qty</th>
                          <th className="text-right py-1.5 pr-4">Amount</th>
                          <th className="text-left py-1.5 pr-4">Method</th>
                          <th className="text-left py-1.5 pr-4">Disposition</th>
                          <th className="text-left py-1.5 pr-4">Restock</th>
                          <th className="text-left py-1.5">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {returnAdjustments.map((r) => (
                          <tr key={r.id} className="border-t">
                            <td className="py-1.5 pr-4">{formatDateTimeGH(r.createdAt)}</td>
                            <td className="py-1.5 pr-4">{r.itemLabel}{r.inLedger ? "" : " (credit)"}</td>
                        <td className="py-1 pr-4 text-right">
                          {r.quantity > 0 ? r.quantity : "—"}
                        </td>
                        <td className="py-1.5 pr-4 text-right">{formatCurrency(Math.abs(r.amount))}</td>
                        <td className="py-1.5 pr-4">{formatMethod(r.method)}</td>
                        <td className="py-1.5 pr-4">{formatDisposition(r.disposition)}</td>
                        <td className="py-1.5 pr-4">{r.restockToStock ? "Yes" : "No"}</td>
                        <td className="py-1.5">{formatDisposition(r.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
                {returnedValue > 0.005 ? (
                  <p className="text-xs text-muted-foreground mt-2">
                    Total returned value on this order: {formatCurrency(returnedValue)}.
                  </p>
                ) : null}
              </div>
            ) : null}
            </CardContent>
          </Card>
          ) : null}

          {activeTab === "returns" ? (
            returnAdjustments.length > 0 ? (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold">Returns, Credits, and Refunds</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Returned lines, store-credit issuance, and cash refunds tied to this order.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-xs whitespace-nowrap">
                      <thead className="text-muted-foreground border-b">
                        <tr>
                          <th className="text-left py-1.5 pr-4">Date</th>
                          <th className="text-left py-1.5 pr-4">Item</th>
                          <th className="text-right py-1.5 pr-4">Qty</th>
                          <th className="text-right py-1.5 pr-4">Amount</th>
                          <th className="text-left py-1.5 pr-4">Method</th>
                          <th className="text-left py-1.5 pr-4">Disposition</th>
                          <th className="text-left py-1.5 pr-4">Restock</th>
                          <th className="text-left py-1.5">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {returnAdjustments.map((r) => (
                          <tr key={`returns-tab-${r.id}`} className="border-t">
                            <td className="py-1.5 pr-4">{formatDateTimeGH(r.createdAt)}</td>
                            <td className="py-1.5 pr-4">
                              {r.itemLabel}
                              {r.inLedger ? "" : " (credit)"}
                            </td>
                            <td className="py-1.5 pr-4 text-right">
                              {r.quantity > 0 ? r.quantity : "-"}
                            </td>
                            <td className="py-1.5 pr-4 text-right">
                              {formatCurrency(Math.abs(r.amount))}
                            </td>
                            <td className="py-1.5 pr-4">{formatMethod(r.method)}</td>
                            <td className="py-1.5 pr-4">{formatDisposition(r.disposition)}</td>
                            <td className="py-1.5 pr-4">{r.restockToStock ? "Yes" : "No"}</td>
                            <td className="py-1.5">{formatDisposition(r.status)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {returnedValue > 0.005 ? (
                    <p className="text-xs text-muted-foreground">
                      Total returned value on this order: {formatCurrency(returnedValue)}.
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            ) : (
              <EmptyTabState
                title="No returns recorded"
                body="Process item returns from the Items tab when a delivered line needs to be credited or refunded."
                actionLabel="Go to Items"
                onAction={() => setActiveTab("items")}
              />
            )
          ) : null}

          {activeTab === "activity" ? (
            <>
              <OrderTimelineCard
                events={timelineEvents}
                formatDate={(value) => formatDateTimeGH(value)}
              />
              <OrderNotificationEstimateCard
                customerType={order.customerType}
                hasPaymentRecorded={notificationSummary.hasPaymentRecorded}
                hasStoreCreditIssued={notificationSummary.hasStoreCreditIssued}
                deliveryStatus={String(order.deliveryStatus || "NOT_DELIVERED")}
              />
            </>
          ) : null}

        </div>{/* end left column */}

        {/* RIGHT: customer, delivery, and internal context */}
        <div className="space-y-4 lg:col-span-4 lg:sticky lg:top-4 self-start">

          {/* Customer card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Customer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {order.user ? (
                <>
                  <p className="font-medium">{order.user.name || "—"}</p>
                  {order.user.email ? <p className="text-xs text-muted-foreground">{order.user.email}</p> : null}
                  <Link href={`/admin/customers/${order.user.id}/view`} className="text-xs underline text-primary">
                    View customer account
                  </Link>
                </>
              ) : (
                <>
                  <p className="font-medium">{order.walkInName || "Walk-in"}</p>
                  {order.walkInPhone ? <p className="text-xs text-muted-foreground">{order.walkInPhone}</p> : null}
                  <p className="text-xs text-muted-foreground">OTC / Walk-in sale</p>
                </>
              )}
            </CardContent>
          </Card>

          {/* Delivery card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Delivery</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Status</span>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                  chipToneClass(orderStatusTone(order.deliveryStatus || "NOT_DELIVERED"))
                } ${chipToneBorderClass(orderStatusTone(order.deliveryStatus || "NOT_DELIVERED"))}`}>
                  {formatStatus(order.deliveryStatus || "NOT_DELIVERED")}
                </span>
              </div>
              {order.deliveredAt ? (
                <p className="text-xs text-muted-foreground">
                  Updated: {formatDateTimeGH(order.deliveredAt)}
                </p>
              ) : null}
              {order.deliveryProof ? (
                <div className="rounded-md border bg-muted/30 p-2 text-xs space-y-1">
                  <p className="font-medium">Proof of Delivery</p>
                  <p className="text-muted-foreground">
                    {order.deliveryProof.recipientName || "Unknown recipient"}
                    {order.deliveryProof.recipientPhone ? ` · ${order.deliveryProof.recipientPhone}` : ""}
                  </p>
                  {order.deliveryProof.deliveryNote ? (
                    <p className="text-muted-foreground italic">{order.deliveryProof.deliveryNote}</p>
                  ) : null}
                  {order.deliveryProof.proofImageUrl ? (
                    <a
                      href={order.deliveryProof.proofImageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="block mt-1"
                    >
                      <Image
                        src={order.deliveryProof.proofImageUrl}
                        alt="Delivery proof"
                        width={200}
                        height={120}
                        className="rounded border object-cover w-full max-h-32"
                      />
                      <span className="text-primary underline text-[11px]">View full image</span>
                    </a>
                  ) : null}
                </div>
              ) : null}
              {/* Delivery status actions */}
              {order.status !== "CANCELLED" ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground font-medium">
                    Set full delivery here. Use item actions for partial delivery and returns.
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Button
                      variant={order.deliveryStatus === "DELIVERED" ? "default" : "outline"}
                      size="sm"
                      className="text-xs"
                      disabled={deliveryUpdating || isCreditHold || allDelivered || order.deliveryStatus === "RETURNED" || order.deliveryStatus === "DELIVERED"}
                      onClick={() => updateDelivery("DELIVERED")}
                    >
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                      Delivered
                    </Button>
                    <Button
                      variant={order.deliveryStatus === "PARTIALLY_DELIVERED" ? "default" : "outline"}
                      size="sm"
                      className="text-xs"
                      disabled={deliveryUpdating || isCreditHold || allDelivered || order.deliveryStatus === "RETURNED" || order.deliveryStatus === "PARTIALLY_DELIVERED" || order.deliveryStatus === "DELIVERED"}
                      onClick={() => updateDelivery("PARTIALLY_DELIVERED")}
                    >
                      <Truck className="w-3 h-3 mr-1" />
                      Partial
                    </Button>
                    <Button
                      variant={order.deliveryStatus === "NOT_DELIVERED" ? "secondary" : "outline"}
                      size="sm"
                      className="text-xs"
                      disabled={deliveryUpdating || anyDelivered || order.deliveryStatus === "NOT_DELIVERED" || order.deliveryStatus === "RETURNED"}
                      onClick={() => updateDelivery("NOT_DELIVERED")}
                    >
                      Not Delivered
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => setActiveTab("items")}
                    >
                      <RotateCcw className="w-3 h-3 mr-1" />
                      Review Returns
                    </Button>
                  </div>
                  {deliveryUpdating ? (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" /> Updating…
                    </p>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Admin note card */}
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold">Admin Note</CardTitle>
              {!editingNote && (role === "ADMIN" || role === "STAFF") ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => {
                    setNoteValue(order.adminNote || "");
                    setEditingNote(true);
                  }}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
              ) : null}
            </CardHeader>
            <CardContent>
              {editingNote ? (
                <div className="space-y-2">
                  <Textarea
                    value={noteValue}
                    onChange={(e) => setNoteValue(e.target.value)}
                    rows={4}
                    maxLength={2000}
                    placeholder="Internal note (not visible to customer)"
                    className="text-sm resize-y"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveNote} disabled={savingNote}>
                      {savingNote ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1" />}
                      Save
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingNote(false)} disabled={savingNote}>
                      <X className="w-3.5 h-3.5 mr-1" />
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {order.adminNote || <span className="italic">No note.</span>}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Backorder card */}
          {backorderLines.length > 0 ? (
            <Card className="border-amber-300 bg-amber-50">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-amber-900">Backorder Lines</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-amber-900">
                  Remaining quantities not supplied in this order.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => router.push(`/admin/orders/new?backorderOrderId=${encodeURIComponent(order.id)}`)}
                >
                  Create Fulfillment Order
                </Button>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-amber-300 text-left">
                        <th className="py-1 pr-2">Product</th>
                        <th className="py-1 pr-2 text-right">Req.</th>
                        <th className="py-1 pr-2 text-right">Supplied</th>
                        <th className="py-1 pr-2 text-right">Remaining</th>
                        <th className="py-1">ETA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {backorderLines.map((line, index) => (
                        <tr key={`backorder-${index}`} className="border-b border-amber-200 last:border-0">
                          <td className="py-1 pr-2">{line.productName || "—"}</td>
                          <td className="py-1 pr-2 text-right">{line.requested || "—"}</td>
                          <td className="py-1 pr-2 text-right">{line.supplyingNow || "—"}</td>
                          <td className="py-1 pr-2 text-right">{line.remaining || "—"}</td>
                          <td className="py-1">{line.etaDays != null && Number.isFinite(line.etaDays) ? `${line.etaDays}d` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* Timeline card */}
          {false ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">Activity Timeline</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3 text-xs">
                  {timelineEvents.map((event, idx) => (
                    <li key={`${event.time.toISOString()}-${idx}`} className="flex items-start gap-2">
                      <span className="mt-1 h-2 w-2 rounded-full bg-primary/70 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{event.label}</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground">{formatDateTimeGH(event.time)}</p>
                        {event.detail ? (
                          <p className="text-[11px] text-muted-foreground">{event.detail}</p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {/* Notifications card */}
          {false ? (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Notification Estimate</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground">
                Estimated from order activity only. This page does not confirm message delivery.
              </p>
              {order.customerType === "WALK_IN" ? (
                <p className="text-xs text-muted-foreground">Walk-in sale — no customer notifications are sent.</p>
              ) : (
                <ul className="space-y-2 text-xs">
                  <li className="flex items-start gap-2">
                    <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${order.createdAt ? "bg-green-500" : "bg-muted"}`} />
                    <span><span className="font-medium">Order confirmation</span> — {order.createdAt ? "Sent." : "Not available."}</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${notificationSummary.hasPaymentRecorded ? "bg-green-500" : "bg-muted"}`} />
                    <span>
                      <span className="font-medium">Payments</span> — {notificationSummary.hasPaymentRecorded
                        ? "At least one notification sent."
                        : <><span className="text-muted-foreground">None detected.</span> <Link href="/admin/settings/communications" className="underline">Check comms settings</Link>.</>}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${notificationSummary.hasStoreCreditIssued ? "bg-green-500" : "bg-muted"}`} />
                    <span>
                      <span className="font-medium">Store credit issued</span> — {notificationSummary.hasStoreCreditIssued
                        ? "Customer notified."
                        : <><span className="text-muted-foreground">None detected.</span></>}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${
                      order.deliveryStatus === "DELIVERED" || order.deliveryStatus === "PARTIALLY_DELIVERED" || order.deliveryStatus === "RETURNED"
                        ? "bg-green-500" : "bg-muted"}`} />
                    <span>
                      <span className="font-medium">Delivery</span> — {
                        order.deliveryStatus === "DELIVERED" || order.deliveryStatus === "PARTIALLY_DELIVERED" || order.deliveryStatus === "RETURNED"
                          ? "Customer notified of latest update."
                          : <span className="text-muted-foreground">Not yet delivered.</span>}
                    </span>
                  </li>
                </ul>
              )}
            </CardContent>
          </Card>
          ) : null}

          {/* Back to orders */}
          <Button variant="outline" className="w-full" onClick={() => router.push("/admin/orders")}>
            ← Back to Orders
          </Button>

        </div>{/* end right column */}
      </div>{/* end grid */}
    </div>
      {/* Dialogs */}
      <Dialog
        open={confirmReleaseHold}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmReleaseHold(false);
            setReleaseHoldForce(false);
            setReleaseHoldNote("");
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Release credit hold</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Holds are automatically released once the customer&apos;s outstanding balance
              drops below their credit limit. Use this only for special cases.
              {order.user?.id ? (
                <> <Link href={`/admin/customers/${order.user.id}/view`} className="underline">View customer account</Link> for credit limit details.</>
              ) : null}
            </p>
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={releaseHoldForce}
                onChange={(e) => setReleaseHoldForce(e.target.checked)}
              />
              Release anyway, even if the customer is still over their credit limit.
            </label>
            <div className="space-y-1">
              <label className="text-xs uppercase text-muted-foreground">Reason (optional)</label>
              <Textarea
                value={releaseHoldNote}
                onChange={(e) => setReleaseHoldNote(e.target.value)}
                placeholder="Reason for manual release"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={releaseHoldSubmitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              onClick={releaseCreditHold}
              disabled={releaseHoldSubmitting}
            >
              {releaseHoldSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Release hold
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
          <>
              <p className="text-sm text-muted-foreground">
                Are you sure you want to mark this order as cancelled? This does not
                automatically refund payments.
              </p>
              {hasOutstandingDeliveredUnits ? (
                <p className="text-xs text-amber-700">
                  This order still has delivered units that have not been processed through returns.
                  Cancel is blocked until those returns are handled.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Delivered lines must be returned from the Items tab before cancellation. Stock
                  changes for returns are handled item-by-item, not in this dialog.
                </p>
              )}
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
                  disabled={updating || hasOutstandingDeliveredUnits}
                >
                  Yes, cancel
                </Button>
              </DialogFooter>
          </>
        </DialogContent>
      </Dialog>
      <Dialog
        open={isPaymentDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsPaymentDialogOpen(false);
            setPaymentError("");
            setPaymentMethodError("");
            setPaymentRequestKey("");
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Record Payment</DialogTitle>
            <DialogDescription>
              Record a payment against this order&apos;s remaining balance.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div className="grid gap-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Order ID</span>
                <span className="font-mono">{order.id.slice(0, 8)}…</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Total</span>
                <span className="font-mono">{formatCurrency(Number(order.total || 0))}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Already Paid</span>
                <span className="font-mono">{formatCurrency(amountPaid)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Remaining Balance</span>
                <span className="font-mono">{formatCurrency(balance)}</span>
              </div>
            </div>
            {isBalanceZero ? (
              <p className="text-xs text-muted-foreground">
                This order has no outstanding balance. New payments cannot be recorded.
              </p>
            ) : null}

            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted-foreground">Amount Mode</span>
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Payment amount mode">
                <Button
                  type="button"
                  size="sm"
                  variant={paymentTab === "custom" ? "default" : "outline"}
                  role="tab"
                  aria-selected={paymentTab === "custom"}
                  onClick={() => {
                    setPaymentTab("custom");
                    setPaymentAmount("");
                    setPaymentError("");
                  }}
                  disabled={isBalanceZero}
                  className="w-full sm:w-auto"
                >
                  Custom
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={paymentTab === "full" ? "default" : "outline"}
                  role="tab"
                  aria-selected={paymentTab === "full"}
                  onClick={() => {
                    setPaymentTab("full");
                    setPaymentAmount(balance.toFixed(2));
                    setPaymentError("");
                  }}
                  disabled={isBalanceZero}
                  className="w-full sm:w-auto"
                >
                  Pay Full ({formatCurrency(balance)})
                </Button>
              </div>
            </div>

            <Input
              type="number"
              placeholder="Enter payment amount"
              value={paymentAmount}
              onChange={(e) => {
                setPaymentAmount(e.target.value);
                if (paymentError) setPaymentError("");
              }}
              aria-invalid={!!paymentError}
              className={paymentError ? "border-red-500" : ""}
              disabled={isBalanceZero}
            />
            {paymentError && <p className="text-xs text-red-600">{paymentError}</p>}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Payment Method</label>
              <Select
                value={paymentMethod}
                onValueChange={(val) => {
                  setPaymentMethod(val as "" | "cash" | "momo" | "transfer" | "card");
                  if (paymentMethodError) setPaymentMethodError("");
                }}
                disabled={isBalanceZero}
              >
                <SelectTrigger className={`w-full ${paymentMethodError ? "border-red-500" : ""}`}>
                  <SelectValue placeholder="Select payment method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="momo">MoMo</SelectItem>
                  <SelectItem value="transfer">Bank Transfer</SelectItem>
                  <SelectItem value="card">Card</SelectItem>
                </SelectContent>
              </Select>
              {paymentMethodError ? (
                <p className="text-xs text-red-600">{paymentMethodError}</p>
              ) : null}
            </div>

            <Textarea
              placeholder="Optional note (e.g., MoMo ref / teller details)"
              value={paymentNote}
              onChange={(e) => setPaymentNote(e.target.value)}
              disabled={isBalanceZero}
            />

            <DialogFooter className="mt-4">
              <Button
                variant="outline"
                onClick={() => setIsPaymentDialogOpen(false)}
                disabled={paymentSubmitting}
              >
                Cancel
              </Button>
              <Button
                onClick={recordPayment}
                disabled={!paymentAmount || paymentSubmitting || isBalanceZero}
              >
                {paymentSubmitting ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : null}
                Confirm Payment
              </Button>
            </DialogFooter>
          </div>
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
                {deliveryItem.product?.name} · {formatCurrency(deliveryItem.price)} each
              </p>
              {deliveryMode === "partial" ? (
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">
                      Additional units delivered
                    </label>
                    <Input
                      type="number"
                      min={1}
                      max={Math.max(0, deliveryItem.quantity - (deliveryItem.deliveredQuantity ?? 0))}
                      value={deliveryQty}
                      onChange={(e) => {
                        setDeliveryQty(e.target.value);
                        if (deliveryQtyError) setDeliveryQtyError("");
                      }}
                      aria-invalid={!!deliveryQtyError}
                      className={deliveryQtyError ? "border-red-500" : undefined}
                    />
                    {deliveryQtyError && (
                      <p className="text-xs text-red-600 mt-1">{deliveryQtyError}</p>
                    )}
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Ordered: {deliveryItem.quantity}
                      {(deliveryItem.deliveredQuantity ?? 0) > 0 ? ` - Already delivered: ${deliveryItem.deliveredQuantity}` : ""}
                      {` - Remaining: ${Math.max(0, deliveryItem.quantity - (deliveryItem.deliveredQuantity ?? 0))}`}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  This will mark all {deliveryItem.quantity} unit(s) as delivered for this item.
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
            setReturnHoldCredit(false);
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
                {returningItem.product?.name} · {formatCurrency(returningItem.price)} each
              </p>
              <div className="flex flex-col gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">
                    Quantity to return (max {Math.max(0, (returningItem.deliveredQuantity ?? 0) - (returningItem.returnedQuantity ?? 0))})
                  </label>
                  <Input
                    type="number"
                    min={1}
                    max={Math.max(0, (returningItem.deliveredQuantity ?? 0) - (returningItem.returnedQuantity ?? 0))}
                    value={returnQuantity}
                    onChange={(e) => {
                      setReturnQuantity(e.target.value);
                      if (returnQtyError) setReturnQtyError("");
                    }}
                    aria-invalid={!!returnQtyError}
                    className={returnQtyError ? "border-red-500" : undefined}
                  />
                  {returnQtyError && (
                    <p className="text-xs text-red-600 mt-1">{returnQtyError}</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {order.customerType === "WALK_IN"
                      ? "OTC returns must be refunded as cash/transfer (no store credit)."
                      : (
                        <>
                          Returns are refunded as <span className="font-medium">store credit</span>. For cash refunds, contact the accounts team.
                        </>
                      )}
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">RMA disposition</label>
                    <Select
                      value={returnDisposition}
                      onValueChange={(val) => {
                        setReturnDisposition(val);
                        if (returnDispositionError) setReturnDispositionError("");
                      }}
                    >
                      <SelectTrigger className={`w-full ${returnDispositionError ? "border-red-500" : ""}`}>
                        <SelectValue placeholder="Select disposition" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="RESTOCK">Restock (add back to stock)</SelectItem>
                        <SelectItem value="SCRAP">Scrap / Dispose</SelectItem>
                        <SelectItem value="RETURN_TO_SUPPLIER">Return to supplier</SelectItem>
                      </SelectContent>
                    </Select>
                    {returnDispositionError ? (
                      <p className="text-xs text-red-600 mt-1">{returnDispositionError}</p>
                    ) : null}
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Return reason</label>
                    <Select
                      value={returnReason}
                      onValueChange={(val) => {
                        setReturnReason(val);
                        if (returnReasonError) setReturnReasonError("");
                      }}
                    >
                      <SelectTrigger className={`w-full ${returnReasonError ? "border-red-500" : ""}`}>
                        <SelectValue placeholder="Select reason" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="DAMAGED">Damaged</SelectItem>
                        <SelectItem value="EXPIRED">Expired</SelectItem>
                        <SelectItem value="WRONG_ITEM">Wrong item shipped</SelectItem>
                        <SelectItem value="QUALITY_ISSUE">Quality issue</SelectItem>
                        <SelectItem value="CUSTOMER_CHANGED_MIND">Customer changed mind</SelectItem>
                        <SelectItem value="OTHER">Other</SelectItem>
                      </SelectContent>
                    </Select>
                    {returnReasonError ? (
                      <p className="text-xs text-red-600 mt-1">{returnReasonError}</p>
                    ) : null}
                    <Input
                      type="text"
                      placeholder="Optional details"
                      value={returnReasonNote}
                      onChange={(e) => setReturnReasonNote(e.target.value)}
                      className="mt-2"
                    />
                  </div>
                </div>
                {order.customerType !== "WALK_IN" ? (
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={returnHoldCredit}
                      onChange={(e) => setReturnHoldCredit(e.target.checked)}
                    />
                    Hold as store credit (do not auto-apply to outstanding balances)
                  </label>
                ) : null}
                {order.customerType !== "WALK_IN" ? (
                  <div className="rounded border bg-muted/30 p-2 text-xs text-muted-foreground space-y-1">
                    <div>
                      Return value: <span className="font-medium">{formatCurrency(returnRequestedAmount)}</span>
                    </div>
                    <div>
                      Applied to this order balance:{" "}
                      <span className="font-medium">{formatCurrency(returnAppliedToCurrentOrder)}</span>
                    </div>
                    <div>
                      Store credit created:{" "}
                      <span className="font-medium">{formatCurrency(returnCreditCreated)}</span>
                    </div>
                    <div>
                      Auto-apply estimate (other older balances):{" "}
                      <span className="font-medium">{formatCurrency(returnAutoApplyEstimate)}</span>
                    </div>
                  </div>
                ) : null}
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
    </>
  );
}
