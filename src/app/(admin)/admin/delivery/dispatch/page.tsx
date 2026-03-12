"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { chipToneClass } from "@/lib/status-chips";
import { formatCurrency, formatDateGH } from "@/lib/currency";
import { logAdminExportDownload } from "@/lib/admin-export-audit-client";

type DispatchStatus =
  | "PENDING"
  | "ASSIGNED"
  | "OUT_FOR_DELIVERY"
  | "FAILED_ATTEMPT"
  | "RESCHEDULED"
  | "PARTIALLY_DELIVERED"
  | "DELIVERED";

type CashCollectionStatus = "PAID_FULL" | "PARTIAL_COLLECTED" | "DELIVERED_UNPAID" | "UNPAID";

type DispatchRow = {
  id: string;
  invoiceNumber?: string | null;
  createdAt: string;
  total: number;
  amountPaid: number;
  balance: number;
  orderStatus: string;
  deliveryStatus?: string | null;
  dispatchStatus: DispatchStatus;
  fullyDelivered?: boolean;
  failedAttempts: number;
  lastFailureReason?: string | null;
  lastFailureAt?: string | null;
  nextScheduledAt?: string | null;
  needsAttention: boolean;
  podMissing: boolean;
  cashCollectionStatus: CashCollectionStatus;
  latestPaymentMethod?: string | null;
  latestPaymentProvider?: string | null;
  latestPaymentAt?: string | null;
  paymentEvents: Array<{
    amount: number;
    status: string;
    method: string;
    provider: string;
    createdAt: string;
  }>;
  pendingCollection?: {
    amount: number;
    method: string;
    reference?: string | null;
    note?: string | null;
    collectedAt?: string | null;
    collectorName?: string | null;
    collectorRole?: string | null;
    claimCreatedAt?: string | null;
  } | null;
  returnPending?: boolean;
  returnPendingAt?: string | null;
  items: Array<{
    id: string;
    name: string;
    quantity: number;
    deliveredQuantity: number;
  }>;
  customerType: string;
  customer: { id?: string | null; name?: string | null; phone?: string | null; email?: string | null };
  assignment?: {
    assignmentId?: string;
    assignmentMode?: "FULL" | "PARTIAL";
    partialPercent?: number;
    assignedItems?: Array<{
      itemId: string;
      productName?: string;
      assignedQty: number;
      remainingQtyAtAssign?: number;
    }>;
    riderUserId?: string;
    riderName?: string;
    riderPhone?: string;
    note?: string;
    assignedAt?: string;
    actorName?: string;
  } | null;
  dispatch?: {
    status?: DispatchStatus;
    reason?: string;
    note?: string;
    scheduledAt?: string;
    podRequired?: boolean;
    recipientName?: string;
    recipientPhone?: string;
    deliveryNote?: string;
    proofImageUrl?: string;
    attemptAt?: string;
    actorName?: string;
  } | null;
  timelineRecent?: Array<{
    at: string;
    action: string;
    actorName?: string | null;
    summary: string;
  }>;
};

type DispatchResponse = {
  items: DispatchRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    pending: number;
    assigned: number;
    outForDelivery: number;
    failedAttempt: number;
    rescheduled: number;
    delivered: number;
    needsAttention: number;
    podMissing: number;
    collectionPending: number;
    collectionClaimsPending?: number;
  };
};

type BulkPerOrderMode = "FULL" | "PARTIAL";

function statusTone(status: DispatchStatus) {
  if (status === "DELIVERED") return chipToneClass("success");
  if (status === "PARTIALLY_DELIVERED") return chipToneClass("warning");
  if (status === "OUT_FOR_DELIVERY") return chipToneClass("info");
  if (status === "FAILED_ATTEMPT") return chipToneClass("danger");
  if (status === "RESCHEDULED" || status === "ASSIGNED") return chipToneClass("warning");
  return chipToneClass("neutral");
}

function labelForStatus(status: DispatchStatus) {
  return status.replaceAll("_", " ").toLowerCase();
}

function collectionTone(status: CashCollectionStatus) {
  if (status === "PAID_FULL") return chipToneClass("success");
  if (status === "PARTIAL_COLLECTED") return chipToneClass("warning");
  if (status === "DELIVERED_UNPAID") return chipToneClass("danger");
  return chipToneClass("neutral");
}

function labelForCollection(status: CashCollectionStatus) {
  return status.replaceAll("_", " ").toLowerCase();
}

function isDeliveryComplete(row: DispatchRow) {
  if (row.fullyDelivered) return true;
  return String(row.deliveryStatus || "").toUpperCase() === "DELIVERED";
}

function csvCell(v: string | number) {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function slaToneClass(ageHours: number) {
  if (ageHours >= 48) return "text-rose-700";
  if (ageHours >= 24) return "text-amber-700";
  return "text-muted-foreground";
}

function shouldShowSla(row: DispatchRow) {
  const unresolvedCollection = Boolean(row.pendingCollection) || Number(row.balance || 0) > 0.01;
  const dispatchStatus = String(row.dispatchStatus || "").toUpperCase();
  if (dispatchStatus === "DELIVERED" && !unresolvedCollection) return false;
  return true;
}

type DatePreset = "ALL" | "TODAY" | "THIS_WEEK" | "THIS_MONTH" | "THIS_YEAR" | "CUSTOM";

function toYmd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function presetRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (preset === "TODAY") {
    const d = toYmd(today);
    return { from: d, to: d };
  }
  if (preset === "THIS_WEEK") {
    const day = today.getDay(); // 0=Sun
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);
    return { from: toYmd(monday), to: toYmd(today) };
  }
  if (preset === "THIS_MONTH") {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: toYmd(start), to: toYmd(today) };
  }
  if (preset === "THIS_YEAR") {
    const start = new Date(today.getFullYear(), 0, 1);
    return { from: toYmd(start), to: toYmd(today) };
  }
  return { from: "", to: "" };
}

export default function DeliveryDispatchPage() {
  const searchParams = useSearchParams();
  const initialQ = (searchParams.get("q") || "").trim();
  const initialIncludeDelivered = (() => {
    const raw = String(searchParams.get("includeDelivered") || "").trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
  })();
  const initialCollectionState = (() => {
    const raw = String(searchParams.get("collectionState") || "ALL").toUpperCase();
    const allowed = new Set([
      "ALL",
      "PAID_FULL",
      "PARTIAL_COLLECTED",
      "DELIVERED_UNPAID",
      "UNPAID",
      "CLAIM_PENDING",
    ]);
    return allowed.has(raw)
      ? (raw as "ALL" | "PAID_FULL" | "PARTIAL_COLLECTED" | "DELIVERED_UNPAID" | "UNPAID" | "CLAIM_PENDING")
      : "ALL";
  })();

  const [q, setQ] = useState(initialQ);
  const [status, setStatus] = useState<"ALL" | DispatchStatus>("ALL");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [podMissingOnly, setPodMissingOnly] = useState(false);
  const [datePreset, setDatePreset] = useState<DatePreset>("ALL");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [customerTypeFilter, setCustomerTypeFilter] = useState<"ALL" | "REGISTERED" | "WALK_IN">("ALL");
  const [orderStatusFilter, setOrderStatusFilter] = useState<
    "ALL" | "UNPAID" | "PARTIALLY_PAID" | "PAID" | "ON_HOLD_CREDIT"
  >("ALL");
  const [collectionStateFilter, setCollectionStateFilter] = useState<
    "ALL" | "PAID_FULL" | "PARTIAL_COLLECTED" | "DELIVERED_UNPAID" | "UNPAID" | "CLAIM_PENDING"
  >(initialCollectionState);
  const [assignmentScopeFilter, setAssignmentScopeFilter] = useState<"ALL" | "FULL" | "PARTIAL" | "UNASSIGNED">(
    "ALL",
  );
  const [includeDelivered, setIncludeDelivered] = useState(initialIncludeDelivered);
  const [riderFilter, setRiderFilter] = useState("");

  const [assignOpen, setAssignOpen] = useState(false);
  const [assigningOrder, setAssigningOrder] = useState<DispatchRow | null>(null);
  const [riderName, setRiderName] = useState("");
  const [riderPhone, setRiderPhone] = useState("");
  const [riderUserId, setRiderUserId] = useState("");
  const [assignNote, setAssignNote] = useState("");
  const [assignMode, setAssignMode] = useState<"FULL" | "PARTIAL">("FULL");
  const [assignItemQty, setAssignItemQty] = useState<Record<string, number>>({});

  const [statusOpen, setStatusOpen] = useState(false);
  const [statusOrder, setStatusOrder] = useState<DispatchRow | null>(null);
  const [nextStatus, setNextStatus] = useState<DispatchStatus>("OUT_FOR_DELIVERY");
  const [reason, setReason] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [proofImageUrl, setProofImageUrl] = useState("");
  const [podRequired, setPodRequired] = useState(false);
  const [itemDeliveryQty, setItemDeliveryQty] = useState<Record<string, number>>({});
  const [podUploading, setPodUploading] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const [collectOrder, setCollectOrder] = useState<DispatchRow | null>(null);
  const [collectAmount, setCollectAmount] = useState("");
  const [collectMethod, setCollectMethod] = useState<"cash" | "momo" | "transfer" | "card">("cash");
  const [collectReference, setCollectReference] = useState("");
  const [collectNote, setCollectNote] = useState("");
  const [unassignOpen, setUnassignOpen] = useState(false);
  const [unassignOrder, setUnassignOrder] = useState<DispatchRow | null>(null);
  const [unassignReason, setUnassignReason] = useState("");
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [timelineOrder, setTimelineOrder] = useState<DispatchRow | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkRiderName, setBulkRiderName] = useState("");
  const [bulkRiderPhone, setBulkRiderPhone] = useState("");
  const [bulkRiderUserId, setBulkRiderUserId] = useState("");
  const [bulkNote, setBulkNote] = useState("");
  const [bulkAllSelectedFull, setBulkAllSelectedFull] = useState(false);
  const [bulkEditorOpen, setBulkEditorOpen] = useState(false);
  const [bulkPerOrderModes, setBulkPerOrderModes] = useState<Record<string, BulkPerOrderMode>>({});
  const [bulkPerOrderItemQty, setBulkPerOrderItemQty] = useState<Record<string, Record<string, number>>>({});
  const [exportingCsv, setExportingCsv] = useState(false);
  const [stickyTopPx, setStickyTopPx] = useState(72);

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    if (status !== "ALL") sp.set("status", status);
    if (attentionOnly) sp.set("attentionOnly", "1");
    if (podMissingOnly) sp.set("podMissingOnly", "1");
    if (dateFrom) sp.set("dateFrom", dateFrom);
    if (dateTo) sp.set("dateTo", dateTo);
    if (customerTypeFilter !== "ALL") sp.set("customerType", customerTypeFilter);
    if (orderStatusFilter !== "ALL") sp.set("orderStatus", orderStatusFilter);
    if (collectionStateFilter !== "ALL") sp.set("collectionState", collectionStateFilter);
    if (assignmentScopeFilter !== "ALL") sp.set("assignmentScope", assignmentScopeFilter);
    sp.set("fulfillment", includeDelivered ? "ALL" : "OPEN");
    if (riderFilter.trim()) sp.set("rider", riderFilter.trim());
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    return sp.toString();
  }, [
    q,
    status,
    attentionOnly,
    podMissingOnly,
    dateFrom,
    dateTo,
    customerTypeFilter,
    orderStatusFilter,
    collectionStateFilter,
    assignmentScopeFilter,
    includeDelivered,
    riderFilter,
    page,
    pageSize,
  ]);

  const { data, isLoading, refetch, isFetching } = useClientQuery<DispatchResponse>({
    queryKey: ["admin", "delivery-dispatch", params],
    queryFn: () => fetch(`/api/admin/delivery?${params}`).then((r) => r.json()),
  });
  const { data: usersData } = useClientQuery<{
    rows?: Array<{
      user: { id: string; role: string; archived?: boolean; name?: string | null; phone?: string | null };
    }>;
  }>({
    queryKey: ["admin", "delivery-dispatch-dispatchers"],
    queryFn: () => fetch("/api/admin/users?includeArchived=0").then((r) => r.json()),
  });

  const rows = useMemo(() => data?.items || [], [data?.items]);
  const dispatchers = useMemo(
    () =>
      (usersData?.rows || [])
        .map((row) => row.user)
        .filter((u) => String(u.role) === "DISPATCHER" && !u.archived),
    [usersData?.rows],
  );
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.id)),
    [rows, selectedIds],
  );
  const selectedSummary = useMemo(() => {
    const selectedCount = selectedRows.length;
    const pendingClaims = selectedRows.filter((r) => Boolean(r.pendingCollection)).length;
    const unpaidCount = selectedRows.filter((r) => Number(r.balance || 0) > 0.01).length;
    const unpaidTotal = selectedRows.reduce((sum, r) => sum + Number(r.balance || 0), 0);
    return { selectedCount, pendingClaims, unpaidCount, unpaidTotal };
  }, [selectedRows]);

  useEffect(() => {
    const update = () => {
      const header = document.querySelector(
        "div[data-slot='admin-page'] > header.sticky",
      ) as HTMLElement | null;
      const h = header ? Math.ceil(header.getBoundingClientRect().height) : 64;
      setStickyTopPx(h + 4);
    };
    update();
    const header = document.querySelector(
      "div[data-slot='admin-page'] > header.sticky",
    ) as HTMLElement | null;
    const ro = header && typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (ro && header) ro.observe(header);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      if (ro) ro.disconnect();
    };
  }, []);

  const openAssign = (row: DispatchRow) => {
    setAssigningOrder(row);
    setRiderName(row.assignment?.riderName || "");
    setRiderPhone(row.assignment?.riderPhone || "");
    setRiderUserId(row.assignment?.riderUserId || "");
    setAssignNote("");
    setAssignMode((row.assignment?.assignmentMode as "FULL" | "PARTIAL" | undefined) || "FULL");
    const next: Record<string, number> = {};
    for (const item of row.items || []) {
      const remaining = Math.max(0, Number(item.quantity || 0) - Number(item.deliveredQuantity || 0));
      next[item.id] = remaining;
    }
    setAssignItemQty(next);
    setAssignOpen(true);
  };

  const openStatus = (row: DispatchRow) => {
    setStatusOrder(row);
    setNextStatus(
      row.dispatchStatus === "DELIVERED" || row.dispatchStatus === "PARTIALLY_DELIVERED"
        ? row.dispatchStatus
        : "OUT_FOR_DELIVERY",
    );
    setReason("");
    setStatusNote("");
    setScheduledAt("");
    setRecipientName(row.dispatch?.recipientName || "");
    setRecipientPhone(row.dispatch?.recipientPhone || "");
    setDeliveryNote(row.dispatch?.deliveryNote || "");
    setProofImageUrl(row.dispatch?.proofImageUrl || "");
    setPodRequired(Boolean(row.dispatch?.podRequired));
    const nextItemQty: Record<string, number> = {};
    for (const item of row.items || []) {
      nextItemQty[item.id] = Number(item.deliveredQuantity || 0);
    }
    setItemDeliveryQty(nextItemQty);
    setStatusOpen(true);
  };

  const assign = async () => {
    if (!assigningOrder) return;
    const assignedItems =
      assignMode === "PARTIAL"
        ? (assigningOrder.items || [])
            .map((item) => {
              const remaining = Math.max(0, Number(item.quantity || 0) - Number(item.deliveredQuantity || 0));
              const raw = Number(assignItemQty[item.id] ?? 0);
              const qty = Math.max(0, Math.min(remaining, Number.isFinite(raw) ? Math.floor(raw) : 0));
              return { itemId: item.id, quantity: qty };
            })
            .filter((row) => row.quantity > 0)
        : undefined;
    if (assignMode === "PARTIAL" && (!assignedItems || assignedItems.length === 0)) {
      toast.error("Partial assignment requires at least one item quantity.");
      return;
    }
    const res = await fetch(`/api/admin/delivery/${assigningOrder.id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        riderName,
        riderPhone,
        riderUserId: riderUserId || undefined,
        note: assignNote,
        assignmentMode: assignMode,
        assignedItems,
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload?.error || "Failed to assign rider");
      return;
    }
    toast.success("Rider assigned.");
    setAssignOpen(false);
    await refetch();
  };

  const updateStatus = async () => {
    if (!statusOrder) return;
    const body: Record<string, unknown> = {
      status: nextStatus,
      note: statusNote,
    };
    if (nextStatus === "FAILED_ATTEMPT" && reason) body.reason = reason;
    if (nextStatus === "RESCHEDULED" && scheduledAt) body.scheduledAt = new Date(scheduledAt).toISOString();
    if (nextStatus === "DELIVERED") {
      body.podRequired = podRequired;
      if (recipientName.trim()) body.recipientName = recipientName.trim();
      if (recipientPhone.trim()) body.recipientPhone = recipientPhone.trim();
      if (deliveryNote.trim()) body.deliveryNote = deliveryNote.trim();
      if (proofImageUrl.trim()) body.proofImageUrl = proofImageUrl.trim();
    }
    if (nextStatus === "PARTIALLY_DELIVERED" && statusOrder) {
      body.podRequired = podRequired;
      const itemDeliveries = (statusOrder.items || []).map((item) => {
        const raw = Number(itemDeliveryQty[item.id] ?? item.deliveredQuantity ?? 0);
        const clamped = Math.max(0, Math.min(item.quantity, Number.isFinite(raw) ? raw : 0));
        return {
          itemId: item.id,
          deliveredQuantity: clamped,
        };
      });
      if (!itemDeliveries.some((row) => row.deliveredQuantity > 0)) {
        toast.error("Enter delivered quantity for at least one item.");
        return;
      }
      body.itemDeliveries = itemDeliveries;
    }

    const res = await fetch(`/api/admin/delivery/${statusOrder.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload?.error || "Failed to update delivery status");
      return;
    }
    toast.success("Delivery status updated.");
    setStatusOpen(false);
    await refetch();
  };

  const uploadPodImage = async (file: File | null) => {
    if (!file) return;
    try {
      setPodUploading(true);
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const payload = await res.json().catch(() => ({} as { url?: string; error?: string }));
      if (!res.ok || !payload?.url) {
        toast.error(payload?.error || "POD image upload failed");
        return;
      }
      setProofImageUrl(payload.url);
      toast.success("POD image uploaded.");
    } catch (e) {
      console.error(e);
      toast.error("POD image upload failed");
    } finally {
      setPodUploading(false);
    }
  };

  const openCollect = (row: DispatchRow) => {
    setCollectOrder(row);
    const claimedAmount = Number(row.pendingCollection?.amount || 0);
    setCollectAmount(
      String(
        Math.max(
          0,
          Number.isFinite(claimedAmount) && claimedAmount > 0 ? claimedAmount : Number(row.balance || 0),
        ).toFixed(2),
      ),
    );
    const method = String(row.pendingCollection?.method || "cash").toLowerCase();
    setCollectMethod(method === "momo" || method === "transfer" || method === "card" ? method : "cash");
    setCollectReference(String(row.pendingCollection?.reference || ""));
    setCollectNote(
      row.pendingCollection
        ? String(row.pendingCollection.note || "Confirm dispatcher collection")
        : "Delivery collection",
    );
    setCollectOpen(true);
  };

  const openTimeline = (row: DispatchRow) => {
    setTimelineOrder(row);
    setTimelineOpen(true);
  };

  const openUnassign = (row: DispatchRow) => {
    setUnassignOrder(row);
    setUnassignReason("");
    setUnassignOpen(true);
  };

  const confirmUnassign = async () => {
    if (!unassignOrder) return;
    const res = await fetch(`/api/admin/delivery/${unassignOrder.id}/unassign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: unassignReason.trim() || undefined }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload?.error || "Failed to unassign");
      return;
    }
    toast.success("Rider unassigned.");
    setUnassignOpen(false);
    await refetch();
  };

  const confirmReturnReceived = async (row: DispatchRow) => {
    const res = await fetch(`/api/admin/delivery/${row.id}/return-received`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload?.error || "Failed to confirm return handover");
      return;
    }
    toast.success("Return handover confirmed. Order is now unassigned.");
    await refetch();
  };

  const submitCollection = async () => {
    if (!collectOrder) return;
    const amount = Number(collectAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid payment amount.");
      return;
    }
    const remaining = Number(collectOrder.balance || 0);
    if (amount > remaining + 0.01) {
      toast.error("Amount cannot exceed current balance.");
      return;
    }
    if (collectMethod !== "cash" && !collectReference.trim()) {
      toast.error("Reference is required for MoMo, transfer, or card.");
      return;
    }
    const confirmRoute = collectOrder.pendingCollection
      ? `/api/admin/delivery/${collectOrder.id}/collection/confirm`
      : `/api/orders/${collectOrder.id}/payment`;
    const body = collectOrder.pendingCollection
      ? {
          amount,
          method: collectMethod,
          reference: collectReference.trim() || undefined,
          note: collectNote.trim() || undefined,
          claimCreatedAt: collectOrder.pendingCollection.claimCreatedAt || undefined,
        }
      : {
          amount,
          method: collectMethod,
          note:
            collectMethod === "cash"
              ? collectNote
              : `${collectNote}${collectNote.trim() ? " | " : ""}Ref: ${collectReference.trim()}`,
        };
    const method = collectOrder.pendingCollection ? "POST" : "PATCH";
    const res = await fetch(confirmRoute, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload?.error || "Failed to confirm collection");
      return;
    }
    toast.success(
      collectOrder.pendingCollection ? "Collection confirmed and payment posted." : "Payment recorded.",
    );
    setCollectOpen(false);
    await refetch();
  };

  const bulkAssign = async () => {
    const orderIds = Array.from(selectedIds);
    if (orderIds.length === 0) {
      toast.error("Select at least one order.");
      return;
    }
    if (!bulkRiderName.trim()) {
      toast.error("Enter rider name for bulk assignment.");
      return;
    }
    const perOrderAssignments =
      selectedRows
        .map((row) => {
          const mode = bulkAllSelectedFull ? "FULL" : (bulkPerOrderModes[row.id] || "FULL");
          if (mode === "FULL") {
            return {
              orderId: row.id,
              assignmentMode: "FULL" as const,
            };
          }
          const assignedItems = (row.items || [])
            .map((item) => {
              const remaining = Math.max(0, Number(item.quantity || 0) - Number(item.deliveredQuantity || 0));
              const requestedRaw = bulkPerOrderItemQty[row.id]?.[item.id];
              const requested = Number.isFinite(Number(requestedRaw))
                ? Number(requestedRaw)
                : remaining;
              const quantity = Math.max(0, Math.min(remaining, Math.floor(requested)));
              return {
                itemId: item.id,
                quantity,
              };
            })
            .filter((x) => x.quantity > 0);
          return {
            orderId: row.id,
            assignmentMode: "PARTIAL" as const,
            assignedItems,
          };
        })
        .filter((row) => row.assignmentMode === "FULL" || (row.assignedItems || []).length > 0);
    if (!perOrderAssignments || perOrderAssignments.length === 0) {
      toast.error("Set at least one assignable quantity in per-order mode.");
      return;
    }
    const res = await fetch("/api/admin/delivery/bulk-assign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderIds,
        riderName: bulkRiderName.trim(),
        riderPhone: bulkRiderPhone.trim() || undefined,
        riderUserId: bulkRiderUserId || undefined,
        note: bulkNote.trim() || undefined,
        perOrderAssignments,
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload?.error || "Failed bulk assign");
      return;
    }
    const assigned = Number(payload?.assigned || 0);
    const skipped = Number(payload?.skipped || 0);
    if (assigned > 0 && skipped > 0) {
      toast.success(`Assigned ${assigned}, skipped ${skipped}.`);
    } else if (assigned > 0) {
      toast.success(`Assigned ${assigned} order(s).`);
    } else {
      toast.error("No orders were assigned.");
    }
    setSelectedIds(new Set());
    setBulkRiderUserId("");
    setBulkRiderName("");
    setBulkRiderPhone("");
    setBulkNote("");
    setBulkAllSelectedFull(false);
    setBulkEditorOpen(false);
    setBulkPerOrderModes({});
    setBulkPerOrderItemQty({});
    await refetch();
  };

  const exportCurrentRowsCsv = async () => {
    setExportingCsv(true);
    let allRows: DispatchRow[] = [];
    try {
      const qp = new URLSearchParams(params);
      qp.set("page", "1");
      qp.set("pageSize", "100");
      const first = await fetch(`/api/admin/delivery?${qp.toString()}`);
      const firstPayload = (await first.json().catch(() => ({}))) as DispatchResponse;
      if (!first.ok) {
        throw new Error((firstPayload as { error?: string })?.error || "Failed to export CSV");
      }
      allRows = firstPayload.items || [];
      const totalRows = Number(firstPayload.total || allRows.length);
      const perPage = Number(firstPayload.pageSize || 100);
      const pages = Math.max(1, Math.ceil(totalRows / perPage));
      for (let p = 2; p <= pages; p += 1) {
        qp.set("page", String(p));
        const res = await fetch(`/api/admin/delivery?${qp.toString()}`);
        const payload = (await res.json().catch(() => ({}))) as DispatchResponse;
        if (!res.ok) {
          throw new Error((payload as { error?: string })?.error || "Failed to export CSV");
        }
        allRows = allRows.concat(payload.items || []);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to export CSV");
      setExportingCsv(false);
      return;
    }

    if (!allRows.length) {
      toast.error("No rows to export.");
      setExportingCsv(false);
      return;
    }
    const headers = [
      "Order ID",
      "Invoice",
      "Customer",
      "Phone",
      "Placed",
      "SLA Age (h)",
      "Dispatch Status",
      "Payment Status",
      "Total",
      "Balance",
      "Rider",
      "Pending Claim",
    ];
    const now = Date.now();
    const lines = allRows.map((r) => {
      const ageHours = Math.max(0, Math.floor((now - new Date(r.createdAt).getTime()) / (1000 * 60 * 60)));
      return [
        r.id,
        r.invoiceNumber || "",
        r.customer?.name || "",
        r.customer?.phone || "",
        formatDateGH(r.createdAt),
        ageHours,
        r.dispatchStatus,
        r.orderStatus,
        Number(r.total || 0).toFixed(2),
        Number(r.balance || 0).toFixed(2),
        r.assignment?.riderName || "",
        r.pendingCollection ? "yes" : "no",
      ]
        .map((v) => csvCell(v))
        .join(",");
    });
    const csv = [headers.map((h) => csvCell(h)).join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    const filename = `dispatch-queue-page-${stamp}.csv`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    void logAdminExportDownload({
      area: "delivery-dispatch",
      format: "CSV",
      fileName: filename,
      rowCount: allRows.length,
      columnCount: headers.length,
      byteSize: blob.size,
      scopeSnapshot: "Dispatch queue filtered export",
    });
    toast.success(`CSV exported (${allRows.length} rows).`);
    setExportingCsv(false);
  };

  const startBulkAssignFlow = () => {
    if (selectedIds.size === 0) {
      toast.error("Select at least one order.");
      return;
    }
    if (!bulkRiderName.trim()) {
      toast.error("Enter rider name for bulk assignment.");
      return;
    }
    if (bulkAllSelectedFull) {
      void bulkAssign();
      return;
    }
    setBulkPerOrderModes((prev) => {
      const next = { ...prev };
      for (const row of selectedRows) {
        if (!next[row.id]) next[row.id] = "PARTIAL";
      }
      return next;
    });
    setBulkPerOrderItemQty((prev) => {
      const next = { ...prev };
      for (const row of selectedRows) {
        const rowMap = { ...(next[row.id] || {}) };
        for (const item of row.items || []) {
          const remaining = Math.max(0, Number(item.quantity || 0) - Number(item.deliveredQuantity || 0));
          if (!Number.isFinite(Number(rowMap[item.id]))) {
            rowMap[item.id] = remaining;
          }
        }
        next[row.id] = rowMap;
      }
      return next;
    });
    setBulkEditorOpen(true);
  };

  return (
    <section className="container mx-auto py-8 space-y-4" data-slot="admin-page">
      <Card>
        <CardHeader>
          <CardTitle>Delivery Dispatch Board</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Pending</div>
              <div className="font-semibold">{data?.summary.pending ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Assigned</div>
              <div className="font-semibold">{data?.summary.assigned ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Out for delivery</div>
              <div className="font-semibold">{data?.summary.outForDelivery ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Failed attempt</div>
              <div className="font-semibold">{data?.summary.failedAttempt ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Rescheduled</div>
              <div className="font-semibold">{data?.summary.rescheduled ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Delivered</div>
              <div className="font-semibold">{data?.summary.delivered ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Needs attention</div>
              <div className="font-semibold">{data?.summary.needsAttention ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">POD missing</div>
              <div className="font-semibold">{data?.summary.podMissing ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Balance pending</div>
              <div className="font-semibold">{data?.summary.collectionPending ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Claims pending confirm</div>
              <div className="font-semibold">{data?.summary.collectionClaimsPending ?? 0}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="w-full sm:w-[220px]">
              <Label htmlFor="q">Search</Label>
              <Input
                id="q"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
                placeholder="Invoice, customer, phone"
              />
            </div>
            <div className="w-full sm:w-[220px]">
              <Label>Status</Label>
              <Select
                value={status}
                onValueChange={(v: "ALL" | DispatchStatus) => {
                  setStatus(v);
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All statuses</SelectItem>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="ASSIGNED">Assigned</SelectItem>
                  <SelectItem value="OUT_FOR_DELIVERY">Out for delivery</SelectItem>
                  <SelectItem value="FAILED_ATTEMPT">Failed attempt</SelectItem>
                  <SelectItem value="RESCHEDULED">Rescheduled</SelectItem>
                  <SelectItem value="PARTIALLY_DELIVERED">Partially delivered</SelectItem>
                  <SelectItem value="DELIVERED">Delivered</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-full sm:w-[140px]">
              <Label>Page size</Label>
              <Select
                value={String(pageSize)}
                onValueChange={(v) => {
                  setPageSize(Number(v));
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="25">25</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-full sm:w-[180px]">
              <Label>Date preset</Label>
              <Select
                value={datePreset}
                onValueChange={(v: DatePreset) => {
                  setDatePreset(v);
                  if (v !== "CUSTOM") {
                    const range = presetRange(v);
                    setDateFrom(range.from);
                    setDateTo(range.to);
                  }
                  if (v === "ALL") {
                    setDateFrom("");
                    setDateTo("");
                  }
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Date preset" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All dates</SelectItem>
                  <SelectItem value="TODAY">Today</SelectItem>
                  <SelectItem value="THIS_WEEK">This week</SelectItem>
                  <SelectItem value="THIS_MONTH">This month</SelectItem>
                  <SelectItem value="THIS_YEAR">This year</SelectItem>
                  <SelectItem value="CUSTOM">Custom range</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-full sm:w-[170px]">
              <Label htmlFor="dateFrom">From</Label>
              <Input
                id="dateFrom"
                type="date"
                value={dateFrom}
                onChange={(e) => {
                  setDatePreset("CUSTOM");
                  setDateFrom(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div className="w-full sm:w-[170px]">
              <Label htmlFor="dateTo">To</Label>
              <Input
                id="dateTo"
                type="date"
                value={dateTo}
                onChange={(e) => {
                  setDatePreset("CUSTOM");
                  setDateTo(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Button
              variant={attentionOnly ? "default" : "outline"}
              className="w-full sm:w-auto"
              onClick={() => {
                setAttentionOnly((v) => !v);
                setPage(1);
              }}
            >
              {attentionOnly ? "Attention only: ON" : "Attention only"}
            </Button>
            <Button
              variant={podMissingOnly ? "default" : "outline"}
              className="w-full sm:w-auto"
              onClick={() => {
                setPodMissingOnly((v) => !v);
                setPage(1);
              }}
            >
              {podMissingOnly ? "POD missing: ON" : "POD missing"}
            </Button>
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? "Refreshing..." : "Refresh"}
            </Button>
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => void exportCurrentRowsCsv()} disabled={exportingCsv}>
              {exportingCsv ? "Exporting..." : "Export CSV (filtered)"}
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-full sm:w-[210px]">
              <Label>Customer type</Label>
              <Select
                value={customerTypeFilter}
                onValueChange={(v: "ALL" | "REGISTERED" | "WALK_IN") => {
                  setCustomerTypeFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All customers</SelectItem>
                  <SelectItem value="REGISTERED">Registered</SelectItem>
                  <SelectItem value="WALK_IN">Walk-in</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-full sm:w-[210px]">
              <Label>Order payment status</Label>
              <Select
                value={orderStatusFilter}
                onValueChange={(v: "ALL" | "UNPAID" | "PARTIALLY_PAID" | "PAID" | "ON_HOLD_CREDIT") => {
                  setOrderStatusFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All payment status</SelectItem>
                  <SelectItem value="UNPAID">Unpaid</SelectItem>
                  <SelectItem value="PARTIALLY_PAID">Partially paid</SelectItem>
                  <SelectItem value="PAID">Paid</SelectItem>
                  <SelectItem value="ON_HOLD_CREDIT">On hold credit</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-full sm:w-[210px]">
              <Label>Collection state</Label>
              <Select
                value={collectionStateFilter}
                onValueChange={(
                  v: "ALL" | "PAID_FULL" | "PARTIAL_COLLECTED" | "DELIVERED_UNPAID" | "UNPAID" | "CLAIM_PENDING",
                ) => {
                  setCollectionStateFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All collection</SelectItem>
                  <SelectItem value="PAID_FULL">Paid full</SelectItem>
                  <SelectItem value="PARTIAL_COLLECTED">Partial collected</SelectItem>
                  <SelectItem value="DELIVERED_UNPAID">Delivered unpaid</SelectItem>
                  <SelectItem value="UNPAID">Unpaid</SelectItem>
                  <SelectItem value="CLAIM_PENDING">Claim pending</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-full sm:w-[210px]">
              <Label>Assignment scope</Label>
              <Select
                value={assignmentScopeFilter}
                onValueChange={(v: "ALL" | "FULL" | "PARTIAL" | "UNASSIGNED") => {
                  setAssignmentScopeFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All scopes</SelectItem>
                  <SelectItem value="FULL">Full</SelectItem>
                  <SelectItem value="PARTIAL">Partial</SelectItem>
                  <SelectItem value="UNASSIGNED">Unassigned</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              variant={includeDelivered ? "default" : "outline"}
              className="w-full sm:w-auto"
              onClick={() => {
                setIncludeDelivered((v) => !v);
                setPage(1);
              }}
            >
              {includeDelivered ? "Hide delivered history" : "Show delivered history"}
            </Button>
            <div className="w-full sm:w-[180px]">
              <Label htmlFor="riderFilter">Rider</Label>
              <Input
                id="riderFilter"
                placeholder="Rider name/phone"
                value={riderFilter}
                onChange={(e) => {
                  setRiderFilter(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => {
                setQ("");
                setStatus("ALL");
                setAttentionOnly(false);
                setPodMissingOnly(false);
                setDatePreset("ALL");
                setDateFrom("");
                setDateTo("");
                setCustomerTypeFilter("ALL");
                setOrderStatusFilter("ALL");
                setCollectionStateFilter("ALL");
                setAssignmentScopeFilter("ALL");
                setIncludeDelivered(false);
                setRiderFilter("");
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          </div>

          <div className="rounded border p-3 space-y-2">
            <div className="text-sm font-medium">Bulk assign ({selectedIds.size} selected)</div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_auto] items-end">
              <div className="space-y-1">
                <Label>Dispatcher</Label>
                <Select
                  value={bulkRiderUserId || "__manual__"}
                  onValueChange={(v) => {
                    if (v === "__manual__") {
                      setBulkRiderUserId("");
                      return;
                    }
                    const selected = dispatchers.find((d) => d.id === v);
                    setBulkRiderUserId(v);
                    setBulkRiderName(selected?.name || "");
                    setBulkRiderPhone(selected?.phone || "");
                  }}
                >
                  <SelectTrigger className="h-10">
                    <SelectValue placeholder="Select dispatcher" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__manual__">Manual entry (type name/phone)</SelectItem>
                    {dispatchers.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name || "Unnamed"}{d.phone ? ` (${d.phone})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Rider name</Label>
                <Input
                  placeholder="Rider name"
                  value={bulkRiderName}
                  onChange={(e) => {
                    setBulkRiderUserId("");
                    setBulkRiderName(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label>Rider phone</Label>
                <Input
                  placeholder="Optional"
                  value={bulkRiderPhone}
                  onChange={(e) => {
                    setBulkRiderUserId("");
                    setBulkRiderPhone(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label>Bulk note</Label>
                <Input
                  placeholder="Optional"
                  value={bulkNote}
                  onChange={(e) => setBulkNote(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>Per-order scope</Label>
                <div className="h-10 rounded border px-3 flex items-center text-sm text-muted-foreground">
                  Full for all or modal item qty
                </div>
              </div>
              <Button
                variant="outline"
                onClick={startBulkAssignFlow}
                disabled={selectedIds.size === 0 || !bulkRiderName.trim()}
                className="h-10 w-full sm:w-auto"
              >
                Apply bulk assign
              </Button>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <input
                id="bulkAllSelectedFull"
                type="checkbox"
                checked={bulkAllSelectedFull}
                onChange={(e) => setBulkAllSelectedFull(e.target.checked)}
              />
              <Label htmlFor="bulkAllSelectedFull" className="font-normal">
                Set all selected to Full
              </Label>
            </div>
            <div className="text-xs text-muted-foreground">
              If unchecked, clicking Apply bulk assign opens item-level quantity editor.
            </div>
          </div>

          <div
            className="sticky z-30 rounded border bg-background/95 backdrop-blur px-3 py-2 text-xs flex flex-wrap gap-3 shadow-sm"
            style={{ top: `${stickyTopPx}px` }}
          >
            <span>Selected: {selectedSummary.selectedCount}</span>
            <span>Unpaid selected: {selectedSummary.unpaidCount}</span>
            <span>Unpaid amount: {formatCurrency(selectedSummary.unpaidTotal)}</span>
            <span>Pending claims: {selectedSummary.pendingClaims}</span>
          </div>

          <div className="rounded border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">
                    <input
                      type="checkbox"
                      aria-label="Select all orders"
                      checked={
                        rows.some(
                          (r) =>
                            !isDeliveryComplete(r),
                        ) &&
                        rows
                          .filter(
                            (r) => !isDeliveryComplete(r),
                          )
                          .every((r) => selectedIds.has(r.id))
                      }
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (checked) {
                            for (const row of rows) {
                              const fullyDelivered = isDeliveryComplete(row);
                              if (!fullyDelivered) next.add(row.id);
                            }
                          } else {
                            for (const row of rows) next.delete(row.id);
                          }
                          return next;
                        });
                      }}
                    />
                  </TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Placed</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Balance</TableHead>
                  <TableHead>Dispatch</TableHead>
                  <TableHead>Collection</TableHead>
                  <TableHead>Retry</TableHead>
                  <TableHead>Rider</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={11}>Loading dispatch queue...</TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11}>No matching orders.</TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => {
                    const fullyDelivered = isDeliveryComplete(row);
                    const ageHours = Math.max(0, Math.floor((Date.now() - new Date(row.createdAt).getTime()) / (1000 * 60 * 60)));
                    return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.invoiceNumber || row.id}`}
                          disabled={fullyDelivered}
                          checked={selectedIds.has(row.id)}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (checked) next.add(row.id);
                              else next.delete(row.id);
                              return next;
                            });
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">
                          <Link href={`/admin/orders/${row.id}`} className="underline">
                            {row.invoiceNumber || row.id}
                          </Link>
                        </div>
                        <div className="text-xs text-muted-foreground">{row.orderStatus}</div>
                      </TableCell>
                      <TableCell>
                        <div>{row.customer?.name || "Unknown"}</div>
                        <div className="text-xs text-muted-foreground">{row.customer?.phone || "-"}</div>
                      </TableCell>
                      <TableCell>
                        <div>{formatDateGH(row.createdAt)}</div>
                        {shouldShowSla(row) ? (
                          <div className={`text-xs ${slaToneClass(ageHours)}`}>
                            SLA age: {ageHours}h
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>{formatCurrency(row.total)}</TableCell>
                      <TableCell>{formatCurrency(row.balance)}</TableCell>
                      <TableCell>
                        <span className={`inline-flex rounded px-2 py-1 text-xs ${statusTone(row.dispatchStatus)}`}>
                          {labelForStatus(row.dispatchStatus)}
                        </span>
                        {row.dispatch?.reason ? (
                          <div className="text-xs text-muted-foreground mt-1">{row.dispatch.reason}</div>
                        ) : null}
                        {row.needsAttention ? (
                          <div className="text-xs text-rose-700 mt-1 font-medium">Needs follow-up</div>
                        ) : null}
                          {row.dispatchStatus === "DELIVERED" ? (
                          <div className="text-xs text-muted-foreground mt-1">
                            POD: {row.podMissing ? "missing" : "captured"}
                          </div>
                        ) : null}
                        {row.dispatch?.recipientName || row.dispatch?.recipientPhone ? (
                          <div className="text-xs text-muted-foreground">
                            Receiver: {row.dispatch?.recipientName || "Unknown"}
                            {row.dispatch?.recipientPhone ? ` (${row.dispatch.recipientPhone})` : ""}
                          </div>
                        ) : null}
                        {row.dispatch?.proofImageUrl ? (
                          <div className="text-xs mt-1">
                            <a
                              className="underline"
                              href={row.dispatch.proofImageUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              View proof
                            </a>
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex rounded px-2 py-1 text-xs ${collectionTone(row.cashCollectionStatus)}`}>
                          {labelForCollection(row.cashCollectionStatus)}
                        </span>
                        {row.pendingCollection ? (
                          <div className="text-xs text-amber-700 mt-1">
                            Claimed {formatCurrency(row.pendingCollection.amount)} via{" "}
                            {String(row.pendingCollection.method || "").toUpperCase()}
                            {row.pendingCollection.collectorName
                              ? ` by ${row.pendingCollection.collectorName}`
                              : ""}
                          </div>
                        ) : null}
                        {row.latestPaymentAt ? (
                          <div className="text-xs text-muted-foreground mt-1">
                            Last: {formatDateGH(row.latestPaymentAt)}
                          </div>
                        ) : null}
                        {row.latestPaymentMethod || row.latestPaymentProvider ? (
                          <div className="text-xs text-muted-foreground">
                            {(row.latestPaymentMethod || "").toUpperCase()}
                            {row.latestPaymentProvider ? ` / ${row.latestPaymentProvider}` : ""}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="text-xs">Attempts: {row.failedAttempts}</div>
                        {row.lastFailureReason ? (
                          <div className="text-xs text-muted-foreground">
                            Last: {row.lastFailureReason} {row.lastFailureAt ? `(${formatDateGH(row.lastFailureAt)})` : ""}
                          </div>
                        ) : null}
                        {row.nextScheduledAt ? (
                          <div className="text-xs text-muted-foreground">
                            Next: {formatDateGH(row.nextScheduledAt)}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div>{row.assignment?.riderName || "-"}</div>
                        <div className="text-xs text-muted-foreground">{row.assignment?.riderPhone || ""}</div>
                        {row.returnPending ? (
                          <div className="text-xs text-amber-700 mt-1">
                            Return pending handover
                            {row.returnPendingAt ? ` · ${formatDateGH(row.returnPendingAt)}` : ""}
                          </div>
                        ) : null}
                        {row.assignment?.assignmentMode ? (
                          <div className="text-xs text-muted-foreground">
                            Scope: {String(row.assignment.assignmentMode).toLowerCase()}
                            {row.assignment.assignmentMode === "PARTIAL" && row.assignment.partialPercent
                              ? ` (${row.assignment.partialPercent}%)`
                              : ""}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="outline">Actions</Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {!fullyDelivered ? (
                              <DropdownMenuItem onSelect={() => openAssign(row)}>
                                {row.assignment?.riderName ? "Reassign" : "Assign rider"}
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                              onSelect={() => openStatus(row)}
                              disabled={fullyDelivered}
                            >
                              Update status
                            </DropdownMenuItem>
                            {row.pendingCollection ? (
                              <DropdownMenuItem onSelect={() => openCollect(row)}>
                                Confirm collection
                              </DropdownMenuItem>
                            ) : row.balance > 0 ? (
                              <DropdownMenuItem onSelect={() => openCollect(row)}>
                                Collect payment
                              </DropdownMenuItem>
                            ) : null}
                            {row.assignment?.riderName && !fullyDelivered && !row.returnPending ? (
                              <DropdownMenuItem onSelect={() => openUnassign(row)}>
                                Unassign
                              </DropdownMenuItem>
                            ) : null}
                            {row.returnPending && row.assignment?.riderName && !fullyDelivered ? (
                              <DropdownMenuItem onSelect={() => void confirmReturnReceived(row)}>
                                Confirm return received
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem onSelect={() => openTimeline(row)}>
                              Timeline
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between gap-2 text-sm">
            <div>
              Page {page} of {totalPages} ({total} orders)
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Assign Rider</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="min-w-0">
                <Label>Dispatcher</Label>
                <Select
                  value={riderUserId || "__manual__"}
                  onValueChange={(v) => {
                    if (v === "__manual__") {
                      setRiderUserId("");
                      return;
                    }
                    const selected = dispatchers.find((d) => d.id === v);
                    setRiderUserId(v);
                    setRiderName(selected?.name || "");
                    setRiderPhone(selected?.phone || "");
                  }}
                >
                  <SelectTrigger className="h-10 w-full">
                    <SelectValue placeholder="Select dispatcher" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__manual__">Manual entry</SelectItem>
                    {dispatchers.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name || "Unnamed"}{d.phone ? ` (${d.phone})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="mt-1 text-xs text-muted-foreground">
                  Manual entry lets you type a non-staff rider name/phone.
                </div>
              </div>
              <div className="min-w-0">
                <Label htmlFor="riderName">Rider name</Label>
                <Input
                  id="riderName"
                  value={riderName}
                  onChange={(e) => {
                    setRiderUserId("");
                    setRiderName(e.target.value);
                  }}
                />
              </div>
              <div className="min-w-0">
                <Label htmlFor="riderPhone">Rider phone</Label>
                <Input
                  id="riderPhone"
                  value={riderPhone}
                  onChange={(e) => {
                    setRiderUserId("");
                    setRiderPhone(e.target.value);
                  }}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[220px_1fr] items-start">
              <div className="min-w-0">
                <Label>Assignment scope</Label>
                <Select value={assignMode} onValueChange={(v: "FULL" | "PARTIAL") => setAssignMode(v)}>
                  <SelectTrigger className="h-10 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="FULL">Full order</SelectItem>
                    <SelectItem value="PARTIAL">Partial by item</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {assignMode === "PARTIAL" && assigningOrder ? (
                <div className="rounded border p-2 space-y-2">
                  <div className="text-xs text-muted-foreground">
                    Enter quantities to assign for this trip.
                  </div>
                  {(assigningOrder.items || []).map((item) => {
                    const remaining = Math.max(
                      0,
                      Number(item.quantity || 0) - Number(item.deliveredQuantity || 0),
                    );
                    return (
                      <div key={item.id} className="grid grid-cols-[1fr_110px] gap-2 items-center">
                        <div className="text-sm">
                          <div className="font-medium">{item.name}</div>
                          <div className="text-xs text-muted-foreground">Remaining {remaining}</div>
                        </div>
                        <Input
                          type="number"
                          min={0}
                          max={remaining}
                          value={String(assignItemQty[item.id] ?? 0)}
                          onChange={(e) => {
                            const raw = Number(e.target.value);
                            const next = Math.max(
                              0,
                              Math.min(remaining, Number.isFinite(raw) ? Math.floor(raw) : 0),
                            );
                            setAssignItemQty((prev) => ({ ...prev, [item.id]: next }));
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground pt-6">
                  Full order assignment sends all remaining undelivered items.
                </div>
              )}
            </div>
            <div>
              <Label htmlFor="assignNote">Note</Label>
              <Textarea id="assignNote" value={assignNote} onChange={(e) => setAssignNote(e.target.value)} rows={3} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAssignOpen(false)}>
                Cancel
              </Button>
              <Button onClick={assign}>Save assignment</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={timelineOpen} onOpenChange={setTimelineOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Dispatch Timeline</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              {timelineOrder?.invoiceNumber || timelineOrder?.id}
            </div>
            {!(timelineOrder?.timelineRecent || []).length ? (
              <div className="text-sm text-muted-foreground">No dispatch events found.</div>
            ) : (
              <div className="space-y-2 max-h-[55vh] overflow-auto">
                {(timelineOrder?.timelineRecent || []).map((ev, idx) => (
                  <div key={`${ev.at}-${idx}`} className="rounded border p-2">
                    <div className="text-xs text-muted-foreground">
                      {formatDateGH(ev.at)}{ev.actorName ? ` · ${ev.actorName}` : ""}
                    </div>
                    <div className="text-sm">{ev.summary}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={unassignOpen} onOpenChange={setUnassignOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Unassign Rider</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              {unassignOrder?.invoiceNumber || unassignOrder?.id}
              {unassignOrder?.assignment?.riderName ? ` · ${unassignOrder.assignment.riderName}` : ""}
            </div>
            <div>
              <Label htmlFor="unassignReason">Reason (optional)</Label>
              <Textarea
                id="unassignReason"
                value={unassignReason}
                onChange={(e) => setUnassignReason(e.target.value)}
                rows={3}
                placeholder="e.g., rider unavailable / wrong assignment"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setUnassignOpen(false)}>
                Cancel
              </Button>
              <Button onClick={confirmUnassign}>Confirm unassign</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkEditorOpen} onOpenChange={setBulkEditorOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Bulk Assignment Item Quantities</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setBulkPerOrderModes((prev) => {
                    const next = { ...prev };
                    for (const row of selectedRows) next[row.id] = "FULL";
                    return next;
                  });
                }}
              >
                Set all selected to Full
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setBulkPerOrderModes((prev) => {
                    const next = { ...prev };
                    for (const row of selectedRows) next[row.id] = "PARTIAL";
                    return next;
                  });
                }}
              >
                Set all selected to Partial
              </Button>
            </div>
            <div className="rounded border p-2 space-y-2 max-h-[55vh] overflow-auto">
              {selectedRows.map((row) => (
                <div key={row.id} className="rounded border p-2 space-y-2">
                  <div className="flex flex-wrap items-center gap-2 justify-between">
                    <div className="text-xs font-medium">
                      {row.invoiceNumber || row.id} - {row.customer?.name || "Unknown"}
                    </div>
                    <div className="w-56">
                      <Select
                        value={bulkPerOrderModes[row.id] || "FULL"}
                        onValueChange={(v: "FULL" | "PARTIAL") =>
                          setBulkPerOrderModes((prev) => ({ ...prev, [row.id]: v }))
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="FULL">Full (all remaining)</SelectItem>
                          <SelectItem value="PARTIAL">Partial (item qty)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {(bulkPerOrderModes[row.id] || "FULL") === "PARTIAL" ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(row.items || []).map((item) => {
                        const remaining = Math.max(
                          0,
                          Number(item.quantity || 0) - Number(item.deliveredQuantity || 0),
                        );
                        return (
                          <div key={item.id} className="space-y-1">
                            <Label className="text-xs">
                              {item.name} (remaining {remaining})
                            </Label>
                            <Input
                              type="number"
                              min={0}
                              max={remaining}
                              value={String(bulkPerOrderItemQty[row.id]?.[item.id] ?? remaining)}
                              onChange={(e) => {
                                const raw = Number(e.target.value);
                                const value = Math.max(
                                  0,
                                  Math.min(remaining, Number.isFinite(raw) ? Math.floor(raw) : 0),
                                );
                                setBulkPerOrderItemQty((prev) => ({
                                  ...prev,
                                  [row.id]: {
                                    ...(prev[row.id] || {}),
                                    [item.id]: value,
                                  },
                                }));
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setBulkEditorOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => void bulkAssign()}>Apply bulk assign</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Update Delivery Status</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Status</Label>
              <Select value={nextStatus} onValueChange={(v: DispatchStatus) => setNextStatus(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="ASSIGNED">Assigned</SelectItem>
                  <SelectItem value="OUT_FOR_DELIVERY">Out for delivery</SelectItem>
                  <SelectItem value="FAILED_ATTEMPT">Failed attempt</SelectItem>
                  <SelectItem value="RESCHEDULED">Rescheduled</SelectItem>
                  <SelectItem value="PARTIALLY_DELIVERED">Partially delivered</SelectItem>
                  <SelectItem value="DELIVERED">Delivered</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {nextStatus === "FAILED_ATTEMPT" ? (
              <div>
                <Label>Failure reason</Label>
                <Select value={reason} onValueChange={setReason}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select reason" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NO_ANSWER">No answer</SelectItem>
                    <SelectItem value="WRONG_LOCATION">Wrong location</SelectItem>
                    <SelectItem value="CUSTOMER_NOT_AVAILABLE">Customer not available</SelectItem>
                    <SelectItem value="WEATHER">Weather</SelectItem>
                    <SelectItem value="OTHER">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {nextStatus === "RESCHEDULED" ? (
              <div>
                <Label htmlFor="scheduledAt">Reschedule for</Label>
                <Input
                  id="scheduledAt"
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                />
              </div>
            ) : null}
            <div>
              <Label htmlFor="statusNote">Note</Label>
              <Textarea id="statusNote" value={statusNote} onChange={(e) => setStatusNote(e.target.value)} rows={3} />
            </div>
            {(nextStatus === "DELIVERED" || nextStatus === "PARTIALLY_DELIVERED") ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={podRequired}
                  onChange={(e) => setPodRequired(e.target.checked)}
                />
                Require POD for this delivery
              </label>
            ) : null}
            {statusOrder?.assignment?.assignedItems?.length ? (
              <div className="rounded border p-3 space-y-2">
                <div className="text-sm font-medium">Assigned manifest (current trip)</div>
                <div className="text-xs text-muted-foreground">
                  Scope: {String(statusOrder.assignment.assignmentMode || "FULL").toLowerCase()}
                  {statusOrder.assignment.assignmentMode === "PARTIAL" &&
                  statusOrder.assignment.partialPercent
                    ? ` (${statusOrder.assignment.partialPercent}%)`
                    : ""}
                </div>
                {(statusOrder.assignment.assignedItems || [])
                  .filter((row) => Number(row.assignedQty || 0) > 0)
                  .map((row) => (
                    <div key={row.itemId} className="grid grid-cols-[1fr_auto] text-sm gap-2">
                      <div>{row.productName || "Item"}</div>
                      <div className="font-medium">x{Number(row.assignedQty || 0)}</div>
                    </div>
                  ))}
              </div>
            ) : null}
            {nextStatus === "DELIVERED" ? (
              <>
                <div>
                  <Label htmlFor="recipientName">Recipient name (POD)</Label>
                  <Input
                    id="recipientName"
                    value={recipientName}
                    onChange={(e) => setRecipientName(e.target.value)}
                    placeholder="Person who received the order"
                  />
                </div>
                <div>
                  <Label htmlFor="recipientPhone">Recipient phone (optional)</Label>
                  <Input
                    id="recipientPhone"
                    value={recipientPhone}
                    onChange={(e) => setRecipientPhone(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="deliveryNote">Delivery note (optional)</Label>
                  <Textarea
                    id="deliveryNote"
                    value={deliveryNote}
                    onChange={(e) => setDeliveryNote(e.target.value)}
                    rows={2}
                  />
                </div>
                <div>
                  <Label htmlFor="proofImageUrl">Proof image URL (optional)</Label>
                  <Input
                    id="proofImageUrl"
                    value={proofImageUrl}
                    onChange={(e) => setProofImageUrl(e.target.value)}
                    placeholder="https://..."
                  />
                </div>
                <div>
                  <Label htmlFor="proofImageFile">Upload proof image</Label>
                  <Input
                    id="proofImageFile"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => void uploadPodImage(e.target.files?.[0] || null)}
                    disabled={podUploading}
                  />
                  <div className="text-xs text-muted-foreground mt-1">
                    {podUploading ? "Uploading image..." : "Accepted: JPG, PNG, WEBP up to 5MB."}
                  </div>
                </div>
                {proofImageUrl ? (
                  <div className="text-xs">
                    <a className="underline" href={proofImageUrl} target="_blank" rel="noreferrer">
                      Preview uploaded proof
                    </a>
                  </div>
                ) : null}
              </>
            ) : null}
            {nextStatus === "PARTIALLY_DELIVERED" && statusOrder ? (
              <div className="space-y-2 rounded border p-3">
                <div className="text-sm font-medium">Item-level delivered quantities</div>
                {(statusOrder.items || []).map((item) => (
                  <div key={item.id} className="grid grid-cols-[1fr_120px] items-center gap-2">
                    <div className="text-sm">
                      <div className="font-medium">{item.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Ordered {item.quantity} Â· Current delivered {item.deliveredQuantity}
                      </div>
                    </div>
                    <Input
                      type="number"
                      min={0}
                      max={item.quantity}
                      value={String(itemDeliveryQty[item.id] ?? item.deliveredQuantity ?? 0)}
                      onChange={(e) => {
                        const raw = Number(e.target.value);
                        const next = Math.max(0, Math.min(item.quantity, Number.isFinite(raw) ? raw : 0));
                        setItemDeliveryQty((prev) => ({ ...prev, [item.id]: next }));
                      }}
                    />
                  </div>
                ))}
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const all: Record<string, number> = {};
                      for (const item of statusOrder.items || []) {
                        all[item.id] = item.quantity;
                      }
                      setItemDeliveryQty(all);
                    }}
                  >
                    Set all delivered
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setStatusOpen(false)}>
                Cancel
              </Button>
              <Button onClick={updateStatus}>Save status</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={collectOpen} onOpenChange={setCollectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{collectOrder?.pendingCollection ? "Confirm Collection" : "Collect Payment"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              {collectOrder?.invoiceNumber || collectOrder?.id} · Balance:{" "}
              {collectOrder ? formatCurrency(collectOrder.balance) : "-"}
            </div>
            {collectOrder?.pendingCollection ? (
              <div className="rounded border p-2 text-xs">
                <div className="font-medium">Dispatcher claim</div>
                <div>
                  {formatCurrency(Number(collectOrder.pendingCollection.amount || 0))} via{" "}
                  {String(collectOrder.pendingCollection.method || "").toUpperCase()}
                </div>
                {collectOrder.pendingCollection.reference ? (
                  <div>Ref: {collectOrder.pendingCollection.reference}</div>
                ) : null}
                {collectOrder.pendingCollection.collectorName ? (
                  <div>Collector: {collectOrder.pendingCollection.collectorName}</div>
                ) : null}
              </div>
            ) : null}
            <div>
              <Label htmlFor="collectAmount">Amount</Label>
              <Input
                id="collectAmount"
                type="number"
                min="0.01"
                step="0.01"
                value={collectAmount}
                onChange={(e) => setCollectAmount(e.target.value)}
              />
            </div>
            <div>
              <Label>Method</Label>
              <Select
                value={collectMethod}
                onValueChange={(v: "cash" | "momo" | "transfer" | "card") => setCollectMethod(v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="momo">MoMo</SelectItem>
                  <SelectItem value="transfer">Transfer</SelectItem>
                  <SelectItem value="card">Card</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {collectMethod !== "cash" ? (
              <div>
                <Label htmlFor="collectReference">Reference</Label>
                <Input
                  id="collectReference"
                  value={collectReference}
                  onChange={(e) => setCollectReference(e.target.value)}
                  placeholder="Transaction reference"
                />
              </div>
            ) : null}
            <div>
              <Label htmlFor="collectNote">Note</Label>
              <Textarea
                id="collectNote"
                value={collectNote}
                onChange={(e) => setCollectNote(e.target.value)}
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCollectOpen(false)}>
                Cancel
              </Button>
              <Button onClick={submitCollection}>
                {collectOrder?.pendingCollection ? "Confirm + Post Payment" : "Save payment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}


