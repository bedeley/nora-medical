"use client";

import { useMemo, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { formatCurrency, formatDateGH } from "@/lib/currency";

type DispatchStatus =
  | "PENDING"
  | "ASSIGNED"
  | "OUT_FOR_DELIVERY"
  | "FAILED_ATTEMPT"
  | "RESCHEDULED"
  | "PARTIALLY_DELIVERED"
  | "DELIVERED";

type Row = {
  id: string;
  invoiceNumber?: string | null;
  createdAt: string;
  total: number;
  amountPaid: number;
  balance: number;
  orderStatus: string;
  dispatchStatus: DispatchStatus;
  assignment?: {
    assignmentId?: string;
    assignmentMode?: "FULL" | "PARTIAL";
    assignedItems?: Array<{
      itemId: string;
      productName?: string;
      assignedQty: number;
      remainingQtyAtAssign?: number;
    }>;
  } | null;
  pendingCollection?: {
    amount: number;
    method: string;
    reference?: string;
    note?: string;
    collectedAt?: string;
    claimCreatedAt?: string;
  } | null;
  returnPending?: boolean;
  returnPendingAt?: string | null;
  customer: { name?: string | null; phone?: string | null; email?: string | null };
  items: Array<{ id: string; name: string; quantity: number; deliveredQuantity: number }>;
};

function statusLabel(v: DispatchStatus) {
  return String(v || "").replaceAll("_", " ").toLowerCase();
}

function toYmd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function DispatcherDeliveriesClient() {
  const [q, setQ] = useState("");
  const [historyQ, setHistoryQ] = useState("");
  const [historyStatus, setHistoryStatus] = useState<"ALL" | "DELIVERED" | "FAILED_ATTEMPT" | "RESCHEDULED">(
    "DELIVERED",
  );
  const [historyClaim, setHistoryClaim] = useState<"ALL" | "NONE" | "PENDING" | "CONFIRMED">("ALL");
  const [historyFrom, setHistoryFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return toYmd(d);
  });
  const [historyTo, setHistoryTo] = useState(() => toYmd(new Date()));
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusOrder, setStatusOrder] = useState<Row | null>(null);
  const [nextStatus, setNextStatus] = useState<DispatchStatus>("OUT_FOR_DELIVERY");
  const [reason, setReason] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [proofImageUrl, setProofImageUrl] = useState("");
  const [podUploading, setPodUploading] = useState(false);
  const [itemDeliveryQty, setItemDeliveryQty] = useState<Record<string, number>>({});

  const [claimOpen, setClaimOpen] = useState(false);
  const [claimOrder, setClaimOrder] = useState<Row | null>(null);
  const [claimAmount, setClaimAmount] = useState("");
  const [claimMethod, setClaimMethod] = useState<"cash" | "momo" | "transfer" | "card">("cash");
  const [claimReference, setClaimReference] = useState("");
  const [claimNote, setClaimNote] = useState("");

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    if (historyQ.trim()) sp.set("historyQ", historyQ.trim());
    if (historyFrom) sp.set("historyFrom", historyFrom);
    if (historyTo) sp.set("historyTo", historyTo);
    sp.set("historyStatus", historyStatus);
    sp.set("historyClaim", historyClaim);
    return sp.toString();
  }, [q, historyQ, historyFrom, historyTo, historyStatus, historyClaim]);

  const { data, isLoading, refetch, isFetching } = useClientQuery<{
    items: Row[];
    completedToday?: Row[];
    historyItems?: Row[];
  }>({
    queryKey: ["dispatch", "my-deliveries", params],
    queryFn: () => fetch(`/api/dispatch/my-deliveries?${params}`).then((r) => r.json()),
  });

  const rows = data?.items || [];
  const completedTodayRows = data?.completedToday || [];
  const historyRows = data?.historyItems || [];

  const openStatus = (row: Row) => {
    setStatusOrder(row);
    setNextStatus(row.dispatchStatus === "DELIVERED" ? "DELIVERED" : "OUT_FOR_DELIVERY");
    setReason("");
    setStatusNote("");
    setScheduledAt("");
    setRecipientName("");
    setRecipientPhone("");
    setDeliveryNote("");
    setProofImageUrl("");
    const nextItemQty: Record<string, number> = {};
    for (const item of row.items || []) {
      nextItemQty[item.id] = Number(item.deliveredQuantity || 0);
    }
    setItemDeliveryQty(nextItemQty);
    setStatusOpen(true);
  };

  const updateStatus = async () => {
    if (!statusOrder) return;
    const body: Record<string, unknown> = { status: nextStatus, note: statusNote };
    if (nextStatus === "FAILED_ATTEMPT" && reason) body.reason = reason;
    if (nextStatus === "RESCHEDULED" && scheduledAt) body.scheduledAt = new Date(scheduledAt).toISOString();
    if (nextStatus === "DELIVERED") {
      if (recipientName.trim()) body.recipientName = recipientName.trim();
      if (recipientPhone.trim()) body.recipientPhone = recipientPhone.trim();
      if (deliveryNote.trim()) body.deliveryNote = deliveryNote.trim();
      if (proofImageUrl.trim()) body.proofImageUrl = proofImageUrl.trim();
    }
    if (nextStatus === "PARTIALLY_DELIVERED") {
      const itemDeliveries = (statusOrder.items || []).map((item) => {
        const raw = Number(itemDeliveryQty[item.id] ?? item.deliveredQuantity ?? 0);
        const clamped = Math.max(0, Math.min(item.quantity, Number.isFinite(raw) ? raw : 0));
        return { itemId: item.id, deliveredQuantity: clamped };
      });
      if (!itemDeliveries.some((row) => row.deliveredQuantity > 0)) {
        toast.error("Enter delivered quantity for at least one item.");
        return;
      }
      body.itemDeliveries = itemDeliveries;
    }

    const res = await fetch(`/api/dispatch/orders/${statusOrder.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload?.error || "Failed to update status");
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
    } catch (error) {
      console.error(error);
      toast.error("POD image upload failed");
    } finally {
      setPodUploading(false);
    }
  };

  const openClaim = (row: Row) => {
    setClaimOrder(row);
    setClaimAmount(String(Math.max(0, Number(row.balance || 0)).toFixed(2)));
    setClaimMethod("cash");
    setClaimReference("");
    setClaimNote("Collected at delivery");
    setClaimOpen(true);
  };

  const submitClaim = async () => {
    if (!claimOrder) return;
    const amount = Number(claimAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid amount.");
      return;
    }
    if (amount > Number(claimOrder.balance || 0) + 0.01) {
      toast.error("Amount cannot exceed current balance.");
      return;
    }
    if (claimMethod !== "cash" && !claimReference.trim()) {
      toast.error("Reference is required for MoMo, transfer, or card.");
      return;
    }

    const res = await fetch(`/api/dispatch/orders/${claimOrder.id}/collection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount,
        method: claimMethod,
        reference: claimReference.trim() || undefined,
        note: claimNote.trim() || undefined,
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload?.error || "Failed to record collection claim");
      return;
    }
    toast.success("Collection claim recorded. Awaiting admin confirmation.");
    setClaimOpen(false);
    await refetch();
  };

  return (
    <section className="container mx-auto py-4 space-y-3" data-slot="dispatcher-page">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>My Deliveries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search order / customer / phone"
            />
            <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? "..." : "Refresh"}
            </Button>
          </div>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading deliveries...</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No assigned deliveries.</div>
          ) : (
            <div className="space-y-2">
              {rows.map((row) => (
                <Card key={row.id}>
                  <CardContent className="pt-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium">{row.invoiceNumber || row.id}</div>
                      <div className="text-xs rounded border px-2 py-1">{statusLabel(row.dispatchStatus)}</div>
                    </div>
                    <div className="text-sm">
                      <div>{row.customer?.name || "Unknown customer"}</div>
                      <div className="text-muted-foreground">{row.customer?.phone || "-"}</div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatDateGH(row.createdAt)} · Total {formatCurrency(row.total)} · Balance {formatCurrency(row.balance)}
                    </div>
                    {row.assignment?.assignedItems?.length ? (
                      <div className="text-xs text-muted-foreground">
                        Assigned manifest:{" "}
                        {row.assignment.assignedItems
                          .filter((x) => Number(x.assignedQty || 0) > 0)
                          .map((x) => `${x.productName || "Item"} x${x.assignedQty}`)
                          .join(", ")}
                      </div>
                    ) : null}
                    {row.pendingCollection ? (
                      <div className="text-xs text-amber-700">
                        Pending admin confirmation: {formatCurrency(row.pendingCollection.amount)} via{" "}
                        {String(row.pendingCollection.method || "").toUpperCase()}
                      </div>
                    ) : null}
                    {row.returnPending ? (
                      <div className="text-xs text-amber-700">
                        Return handover pending with admin/staff
                        {row.returnPendingAt ? ` · ${formatDateGH(row.returnPendingAt)}` : ""}
                      </div>
                    ) : null}
                    {row.dispatchStatus === "DELIVERED" &&
                    (row.items || []).some(
                      (it) => Number(it.deliveredQuantity || 0) < Number(it.quantity || 0),
                    ) ? (
                      <div className="text-xs text-muted-foreground">
                        Trip delivered. Order may still have pending items for future assignment.
                      </div>
                    ) : null}
                    <div className="text-xs text-muted-foreground">
                      Items:{" "}
                      {(row.items || [])
                        .map((it) => `${it.name} ${it.deliveredQuantity}/${it.quantity}`)
                        .join(", ")}
                    </div>
                    <div className="pt-1">
                      <div className="flex flex-wrap gap-2">
                        {row.dispatchStatus !== "DELIVERED" ? (
                          <Button size="sm" onClick={() => openStatus(row)}>
                            Update status
                          </Button>
                        ) : null}
                        {row.dispatchStatus === "DELIVERED" &&
                        Number(row.balance || 0) > 0 &&
                        !row.pendingCollection ? (
                          <Button size="sm" variant="outline" onClick={() => openClaim(row)}>
                            Record collection claim
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>My Completed Today</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : completedTodayRows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No completed deliveries today.</div>
          ) : (
            <div className="space-y-2">
              {completedTodayRows.map((row) => (
                <Card key={`completed-${row.id}`}>
                  <CardContent className="pt-4 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium">{row.invoiceNumber || row.id}</div>
                      <div className="text-xs rounded border px-2 py-1">delivered</div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatDateGH(row.createdAt)} · Total {formatCurrency(row.total)} · Balance {formatCurrency(row.balance)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Customer: {row.customer?.name || "Unknown"}{row.customer?.phone ? ` (${row.customer.phone})` : ""}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>My Delivery History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <Label htmlFor="historyQ">Search</Label>
              <Input
                id="historyQ"
                value={historyQ}
                onChange={(e) => setHistoryQ(e.target.value)}
                placeholder="Invoice / customer / phone"
              />
            </div>
            <div>
              <Label htmlFor="historyFrom">From</Label>
              <Input id="historyFrom" type="date" value={historyFrom} onChange={(e) => setHistoryFrom(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="historyTo">To</Label>
              <Input id="historyTo" type="date" value={historyTo} onChange={(e) => setHistoryTo(e.target.value)} />
            </div>
            <div>
              <Label>Status</Label>
              <Select
                value={historyStatus}
                onValueChange={(v: "ALL" | "DELIVERED" | "FAILED_ATTEMPT" | "RESCHEDULED") => setHistoryStatus(v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All</SelectItem>
                  <SelectItem value="DELIVERED">Delivered</SelectItem>
                  <SelectItem value="FAILED_ATTEMPT">Failed attempt</SelectItem>
                  <SelectItem value="RESCHEDULED">Rescheduled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Claim state</Label>
              <Select
                value={historyClaim}
                onValueChange={(v: "ALL" | "NONE" | "PENDING" | "CONFIRMED") => setHistoryClaim(v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All</SelectItem>
                  <SelectItem value="NONE">None</SelectItem>
                  <SelectItem value="PENDING">Pending</SelectItem>
                  <SelectItem value="CONFIRMED">Confirmed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading history...</div>
          ) : historyRows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No history rows for selected filters.</div>
          ) : (
            <div className="space-y-2">
              {historyRows.map((row) => (
                <Card key={`history-${row.id}`}>
                  <CardContent className="pt-3">
                    <details>
                      <summary className="cursor-pointer list-none">
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-medium">{row.invoiceNumber || row.id}</div>
                          <div className="text-xs rounded border px-2 py-1">{statusLabel(row.dispatchStatus)}</div>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {formatDateGH(row.createdAt)} · Total {formatCurrency(row.total)} · Balance {formatCurrency(row.balance)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Customer: {row.customer?.name || "Unknown"}{row.customer?.phone ? ` (${row.customer.phone})` : ""}
                        </div>
                      </summary>
                      <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                        {row.assignment?.assignedItems?.length ? (
                          <div>
                            Assigned manifest:{" "}
                            {row.assignment.assignedItems
                              .filter((x) => Number(x.assignedQty || 0) > 0)
                              .map((x) => `${x.productName || "Item"} x${x.assignedQty}`)
                              .join(", ")}
                          </div>
                        ) : null}
                        {row.pendingCollection ? (
                          <div>
                            Collection claim: {formatCurrency(row.pendingCollection.amount)} via{" "}
                            {String(row.pendingCollection.method || "").toUpperCase()}
                          </div>
                        ) : (
                          <div>Collection claim: none/past resolved</div>
                        )}
                        <div>
                          Items: {(row.items || []).map((it) => `${it.name} ${it.deliveredQuantity}/${it.quantity}`).join(", ")}
                        </div>
                      </div>
                    </details>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

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
                  <SelectItem value="OUT_FOR_DELIVERY">Out for delivery</SelectItem>
                  <SelectItem value="FAILED_ATTEMPT">Failed attempt</SelectItem>
                  <SelectItem value="RESCHEDULED">Rescheduled</SelectItem>
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

            {nextStatus === "DELIVERED" ? (
              <>
                <div>
                  <Label htmlFor="recipientName">Recipient name (optional)</Label>
                  <Input
                    id="recipientName"
                    value={recipientName}
                    onChange={(e) => setRecipientName(e.target.value)}
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
                    capture="environment"
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

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setStatusOpen(false)}>
                Cancel
              </Button>
              <Button onClick={updateStatus}>Save status</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={claimOpen} onOpenChange={setClaimOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record Collection Claim</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              {claimOrder?.invoiceNumber || claimOrder?.id} · Balance {claimOrder ? formatCurrency(claimOrder.balance) : "-"}
            </div>
            <div>
              <Label htmlFor="claimAmount">Amount collected</Label>
              <Input
                id="claimAmount"
                type="number"
                min="0.01"
                step="0.01"
                value={claimAmount}
                onChange={(e) => setClaimAmount(e.target.value)}
              />
            </div>
            <div>
              <Label>Method</Label>
              <Select value={claimMethod} onValueChange={(v: "cash" | "momo" | "transfer" | "card") => setClaimMethod(v)}>
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
            {claimMethod !== "cash" ? (
              <div>
                <Label htmlFor="claimReference">Reference</Label>
                <Input
                  id="claimReference"
                  value={claimReference}
                  onChange={(e) => setClaimReference(e.target.value)}
                  placeholder="Transaction reference"
                />
              </div>
            ) : null}
            <div>
              <Label htmlFor="claimNote">Note (optional)</Label>
              <Textarea
                id="claimNote"
                value={claimNote}
                onChange={(e) => setClaimNote(e.target.value)}
                rows={2}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setClaimOpen(false)}>
                Cancel
              </Button>
              <Button onClick={submitClaim}>Submit claim</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

