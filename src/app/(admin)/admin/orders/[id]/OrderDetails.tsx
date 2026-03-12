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
  const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);
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
        headers: { "Content-Type": "application/json" },
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

      toast.success(`Payment of ${formatCurrency(amount)} recorded.`);
      setPaymentAmount("");
      setPaymentNote("");
      setIsPaymentDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["order", orderId] });
    } catch (err) {
      console.error(err);
      toast.error("Error recording payment.");
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
      </CardHeader>

      <CardContent className="space-y-6">
        {isCreditHold ? (
          <div className="rounded-md border border-rose-200 bg-rose-50 text-rose-800 p-3 text-sm">
            Credit hold is active. Deliveries are blocked until the outstanding balance falls below the credit limit
            or an admin overrides the hold.
          </div>
        ) : null}
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
          {order.deliveryProof ? (
            <p className="text-sm text-muted-foreground">
              <strong>POD:</strong> {order.deliveryProof.recipientName || "Unknown recipient"}
              {order.deliveryProof.recipientPhone ? ` (${order.deliveryProof.recipientPhone})` : ""}
              {order.deliveryProof.proofImageUrl ? (
                <>
                  {" "}
                  -{" "}
                  <a
                    className="underline"
                    href={order.deliveryProof.proofImageUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View proof
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          {order.deliveryProof?.deliveryNote ? (
            <p className="text-xs text-muted-foreground">
              <strong>Delivery note:</strong> {order.deliveryProof.deliveryNote}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            <strong>Item total:</strong> {formatCurrency(lineTotal)}
          </p>
          <p className="text-sm text-muted-foreground">
            <strong>Subtotal:</strong> {formatCurrency(subtotal)}
          </p>
          {taxAmount > 0 ? (
            <p className="text-sm text-muted-foreground">
              <strong>Tax {taxRate > 0 ? `(${taxRate}%)` : ""}:</strong> {formatCurrency(taxAmount)}
            </p>
          ) : null}
          {discountAmount > 0 ? (
            <p className="text-sm text-muted-foreground">
              <strong>Discount:</strong> -{formatCurrency(discountAmount)}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            <strong>Total:</strong> {formatCurrency(orderTotal)}
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
          {isUnpaid ? (
            <div className="mt-2">
              <Button size="sm" onClick={openPaymentDialog}>
                Record payment
              </Button>
            </div>
          ) : null}
          {pendingMomoPayments.length > 0 && balance > 0 ? (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              MoMo payment pending approval ({pendingMomoPayments.length}). Do not release items until payment is
              confirmed.
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={checkAllPendingMomoStatuses}
                  disabled={checkingAllPendingMomo}
                >
                  {checkingAllPendingMomo ? "Checking..." : "Check status"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={cancelPendingMomoRequests}
                  disabled={cancelingPendingMomo}
                >
                  {cancelingPendingMomo ? "Canceling..." : "Cancel pending MoMo request(s)"}
                </Button>
              </div>
            </div>
          ) : null}
          {pendingMomoPayments.length > 0 && balance <= 0 ? (
            <div className="mt-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-900">
              MoMo provider request still shows pending ({pendingMomoPayments.length}), but this order is already
              settled by confirmed payments. Review pending MoMo references to avoid duplicate settlement.
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={checkAllPendingMomoStatuses}
                  disabled={checkingAllPendingMomo}
                >
                  {checkingAllPendingMomo ? "Checking..." : "Check status"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={cancelPendingMomoRequests}
                  disabled={cancelingPendingMomo}
                >
                  {cancelingPendingMomo ? "Canceling..." : "Cancel pending MoMo request(s)"}
                </Button>
              </div>
            </div>
          ) : null}
          {pendingMomoPayments.length === 0 &&
          unsettledProviderMomoCount > 0 &&
          balance > 0 ? (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              There are {unsettledProviderMomoCount} provider MoMo request record(s) not in settled state.
              Continue using confirmed payment methods only.
            </div>
          ) : null}
            <div className="mt-3">
              <h3 className="text-sm font-semibold">Payments Ledger</h3>
              {paymentPostingData?.totalPayments ? (
                <p className="text-xs text-muted-foreground mt-1">
                  Payment Journal:{" "}
                  {paymentPostingData.pendingCount > 0 ? (
                    <span className="font-medium text-amber-700">
                      Pending ({paymentPostingData.pendingCount}/{paymentPostingData.totalPayments})
                    </span>
                  ) : (
                    <span className="font-medium text-emerald-700">Posted</span>
                  )}
                </p>
              ) : null}
              {paymentLedger.length === 0 ? (
              <div className="text-xs text-muted-foreground mt-1">
                <p>No payments recorded for this order yet.</p>
                <div className="mt-2 flex flex-wrap gap-2">
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
                      <th className="text-right py-1 pr-4">Balance after</th>
                      <th className="text-right py-1 pr-4">Status</th>
                      <th className="text-right py-1">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentLedgerWithBalance.map((p) => (
                      <tr key={p.id} className="border-t">
                        <td className="py-1 pr-4">{p.createdAt.toLocaleString()}</td>
                        <td className="py-1 pr-4">{p.method}</td>
                        <td className="py-1 pr-4">{p.provider || "-"}</td>
                        <td className="py-1 pr-4">{p.reference || "-"}</td>
                        <td className="py-1 pr-4 text-right">
                          {formatCurrency(
                            p.isReturnAdjustment
                              ? -Math.abs(p.adjustmentAmount || 0)
                              : Number(p.amount || 0)
                          )}
                        </td>
                        <td className="py-1 pr-4 text-right">
                          {formatCurrency(p.remaining)}
                        </td>
                        <td className="py-1 pr-4 text-right">
                          {p.isReturnAdjustment
                            ? "ADJUSTMENT"
                            : Boolean((p as { pendingProviderMomo?: boolean }).pendingProviderMomo)
                            ? String((p as { momoProviderStatus?: string }).momoProviderStatus || "PENDING")
                            : p.status}
                        </td>
                        <td className="py-1 text-right">
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
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {paymentLedger.length > 0 ? (
              <p className="text-xs text-muted-foreground mt-2">
                Ledger total: {formatCurrency(ledgerTotal)}
                {nonLedgerReturnCreditTotal > 0 ? (
                  <>
                    {" "}
                    | Less non-ledger return credits: {formatCurrency(nonLedgerReturnCreditTotal)}{" "}
                    | Net paid: {formatCurrency(ledgerNetPaid)}
                  </>
                ) : null}
                {" "}
                {ledgerMatchesAmountPaid
                  ? "- matches Amount Paid"
                  : `- does not match Amount Paid (${formatCurrency(amountPaid)})`}
              </p>
            ) : null}
            {paymentLedger.some((p) => p.isReturnAdjustment) ? (
              <p className="text-xs text-muted-foreground mt-1">
                Return adjustments applied to balance are shown above but excluded
                from the ledger total. Non-ledger store-credit returns are also
                subtracted to compute net paid.
              </p>
            ) : null}
          </div>
          {returnAdjustments.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">Return Credits & Refunds</h3>
              <p className="text-xs text-muted-foreground mt-1">
                Store-credit returns appear here even when they are not tied to the order payment ledger.
              </p>
              {order.user?.id ? (
                <div className="mt-2 text-xs">
                  <Link href={`/admin/customers/${order.user.id}/view`} className="underline">
                    View customer account
                  </Link>
                </div>
              ) : null}
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-xs whitespace-nowrap">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left py-1 pr-4">Date</th>
                      <th className="text-left py-1 pr-4">Item</th>
                      <th className="text-right py-1 pr-4">Qty</th>
                      <th className="text-right py-1 pr-4">Amount</th>
                      <th className="text-left py-1 pr-4">Method</th>
                      <th className="text-left py-1 pr-4">Disposition</th>
                      <th className="text-left py-1 pr-4">Restock</th>
                      <th className="text-left py-1 pr-4">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {returnAdjustments.map((r) => (
                      <tr key={r.id} className="border-t">
                        <td className="py-1 pr-4">{r.createdAt.toLocaleString()}</td>
                        <td className="py-1 pr-4">
                          {r.itemLabel}
                          {r.inLedger ? "" : " (credit)"}
                        </td>
                        <td className="py-1 pr-4 text-right">
                          {r.quantity > 0 ? r.quantity : "-"}
                        </td>
                        <td className="py-1 pr-4 text-right">
                          {formatCurrency(Math.abs(r.amount))}
                        </td>
                        <td className="py-1 pr-4">{r.method}</td>
                        <td className="py-1 pr-4">{r.disposition}</td>
                        <td className="py-1 pr-4">
                          {r.restockToStock ? "Yes" : "No"}
                        </td>
                        <td className="py-1 pr-4">{r.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          {returnedValue > 0.005 && (
            <p className="text-xs text-muted-foreground mt-1">
              Note: Returned items value on this order: {formatCurrency(returnedValue)}.
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
              <span className="text-muted-foreground">
                {order.walkInName || "Walk-in"}{order.walkInPhone ? ` · ${order.walkInPhone}` : ""}
              </span>
            )}
          </p>
          {order.adminNote ? (
            <p className="text-sm text-muted-foreground">
              <strong>Admin Note:</strong> {order.adminNote}
            </p>
          ) : null}
          {backorderLines.length > 0 ? (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
              <h3 className="text-sm font-semibold text-amber-900">Backorder Lines</h3>
              <p className="mt-1 text-xs text-amber-900">
                Remaining quantities from this request that were not supplied in this order.
              </p>
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    router.push(
                      `/admin/orders/new?backorderOrderId=${encodeURIComponent(order.id)}`,
                    )
                  }
                >
                  Create Fulfillment Order
                </Button>
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-amber-300 text-left">
                      <th className="py-1 pr-3">Product</th>
                      <th className="py-1 pr-3 text-right">Requested</th>
                      <th className="py-1 pr-3 text-right">Supplied Now</th>
                      <th className="py-1 pr-3 text-right">Remaining</th>
                      <th className="py-1 pr-3">ETA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backorderLines.map((line, index) => (
                      <tr key={`backorder-${index}`} className="border-b border-amber-200 last:border-0">
                        <td className="py-1 pr-3">{line.productName || "-"}</td>
                        <td className="py-1 pr-3 text-right">{line.requested || "-"}</td>
                        <td className="py-1 pr-3 text-right">{line.supplyingNow || "-"}</td>
                        <td className="py-1 pr-3 text-right">{line.remaining || "-"}</td>
                        <td className="py-1 pr-3">
                          {line.etaDays != null && Number.isFinite(line.etaDays)
                            ? `${line.etaDays} day(s)`
                            : "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="mt-4 border-t pt-3">
            <h3 className="text-sm font-semibold mb-1">Customer Notifications</h3>
            <p className="text-xs text-muted-foreground">
              Notifications are sent automatically when orders are created, payments are
              recorded, store credit is issued/refunded, or delivery status changes.
            </p>
            {order.customerType === "WALK_IN" ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Walk-in sale: no customer notifications are sent.
              </p>
            ) : (
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
            )}
          </div>
        </div>

        <div className="border-t pt-4">
          <h3 className="text-sm font-semibold mb-3">Items</h3>
          {!canReturn ? (
            <p className="text-xs text-muted-foreground mb-3">
              Returns can only be initiated by admins. Staff can still record payments
              and update delivery status.
            </p>
          ) : null}
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
                        isCreditHold ||
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
                        isCreditHold ||
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
                      !canReturn ||
                      order.status === "CANCELLED" ||
                      returnSubmitting ||
                      (typeof item.deliveredQuantity === "number"
                        ? item.deliveredQuantity -
                            (item.returnedQuantity ?? 0) <=
                          0
                        : (item.returnedQuantity ?? 0) >= item.quantity)
                    }
                    onClick={() => {
                      if (!canReturn) {
                        toast.error("Only admins can process returns.");
                        return;
                      }
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
                      setReturnDisposition("");
                      setReturnReason("");
                      setReturnReasonNote("");
                    }}
                  >
                    Return item
                  </Button>
                  {!canReturn ? (
                    <span className="text-xs text-muted-foreground">Admin only</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>

      <CardFooter className="justify-end">
        <div className="flex flex-col lg:flex-row gap-2 w-full lg:w-auto lg:items-center lg:justify-end">
          <div className="flex flex-wrap gap-2 w-full lg:w-auto lg:justify-end">
            {isCreditHold && role === "ADMIN" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={releaseHoldSubmitting}
                onClick={() => setConfirmReleaseHold(true)}
              >
                {releaseHoldSubmitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
                Release credit hold
              </Button>
            ) : null}
            <Button
              variant={order.deliveryStatus === "DELIVERED" ? "default" : "outline"}
              size="sm"
              disabled={
                deliveryUpdating ||
                deleting ||
                order.deliveryStatus === "RETURNED" ||
                isCreditHold ||
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
      <Dialog
        open={isPaymentDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsPaymentDialogOpen(false);
            setPaymentError("");
            setPaymentMethodError("");
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-h-none">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Record Payment</DialogTitle>
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
              <select
                className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${
                  paymentMethodError ? "border-red-500" : ""
                }`}
                value={paymentMethod}
                onChange={(e) => {
                  setPaymentMethod(
                    e.target.value as "" | "cash" | "momo" | "transfer" | "card",
                  );
                  if (paymentMethodError) setPaymentMethodError("");
                }}
                disabled={isBalanceZero}
              >
                <option value="">Select payment method</option>
                <option value="cash">Cash</option>
                <option value="momo">MoMo</option>
                <option value="transfer">Bank Transfer</option>
                <option value="card">Card</option>
              </select>
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
                    {order.customerType === "WALK_IN"
                      ? "OTC returns must be refunded as cash/transfer (no store credit)."
                      : (
                        <>
                          Returns for this item are refunded as{" "}
                          <span className="font-medium">store credit</span>. If the
                          customer prefers cash instead, please contact the accounts
                          team so their store credit can be converted and refunded.
                        </>
                      )}
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">
                      RMA disposition
                    </label>
                    <select
                      value={returnDisposition}
                      onChange={(e) => {
                        setReturnDisposition(e.target.value);
                        if (returnDispositionError) setReturnDispositionError("");
                      }}
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="" disabled>
                        Select disposition
                      </option>
                      <option value="RESTOCK">Restock</option>
                      <option value="SCRAP">Scrap/Dispose</option>
                      <option value="RETURN_TO_SUPPLIER">Return to supplier</option>
                    </select>
                    {returnDispositionError ? (
                      <p className="text-xs text-red-600 mt-1">{returnDispositionError}</p>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Restock adds units back to inventory. Scrap/Return keeps them out of stock.
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">
                      Return reason
                    </label>
                    <select
                      value={returnReason}
                      onChange={(e) => {
                        setReturnReason(e.target.value);
                        if (returnReasonError) setReturnReasonError("");
                      }}
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    >
                      <option value="" disabled>
                        Select reason
                      </option>
                      <option value="DAMAGED">Damaged</option>
                      <option value="EXPIRED">Expired</option>
                      <option value="WRONG_ITEM">Wrong item shipped</option>
                      <option value="QUALITY_ISSUE">Quality issue</option>
                      <option value="CUSTOMER_CHANGED_MIND">Customer changed mind</option>
                      <option value="OTHER">Other</option>
                    </select>
                    {returnReasonError ? (
                      <p className="text-xs text-red-600 mt-1">{returnReasonError}</p>
                    ) : null}
                    <input
                      type="text"
                      placeholder="Optional reason details"
                      value={returnReasonNote}
                      onChange={(e) => setReturnReasonNote(e.target.value)}
                      className="mt-2 h-9 w-full rounded-md border bg-background px-2 text-sm"
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
    </Card>
  );
}

