"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatDateGH } from "@/lib/currency";
import { chipToneClass } from "@/lib/status-chips";

type CollectionState = "CLEARED" | "PENDING";
type ReconciliationState = "SETTLED" | "UNSETTLED";

type ReconciliationRow = {
  id: string;
  invoiceNumber?: string | null;
  deliveredAt: string;
  ageDays: number;
  total: number;
  amountPaid: number;
  balance: number;
  collectionState: CollectionState;
  hasPendingClaim?: boolean;
  claimAmount?: number | null;
  claimMethod?: string | null;
  claimReference?: string | null;
  claimCollectorName?: string | null;
  claimCollectorId?: string | null;
  claimCreatedAt?: string | null;
  podMissing: boolean;
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryNote?: string | null;
  proofImageUrl?: string | null;
  reconciliationState: ReconciliationState;
  settlementId?: string | null;
  settlementReference?: string | null;
  settlementReceivedBy?: string | null;
  settledAt?: string | null;
  settledBy?: string | null;
  settlementPostingStatus?: "POSTED" | "UNPOSTED" | null;
  settlementJournalId?: string | null;
  customer: { id?: string | null; name?: string | null; phone?: string | null };
  riderName: string;
  riderPhone?: string | null;
};

type RiderRollup = {
  riderName: string;
  riderPhone?: string | null;
  deliveredOrders: number;
  pendingCollections: number;
  pendingBalance: number;
};

type ReconciliationResponse = {
  items: ReconciliationRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    deliveredOrders: number;
    pendingCollections: number;
    unsettledCollections: number;
    podMissing: number;
    unpostedSettlements: number;
    pendingBalance: number;
    avgPendingAgeDays: number;
  };
  riders: RiderRollup[];
};

function collectionTone(status: CollectionState) {
  return status === "CLEARED" ? chipToneClass("success") : chipToneClass("danger");
}

function reconcileTone(status: ReconciliationState) {
  return status === "SETTLED" ? chipToneClass("success") : chipToneClass("warning");
}

export default function DeliveryReconciliationPage() {
  const [q, setQ] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [podMissingOnly, setPodMissingOnly] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    if (onlyOpen) sp.set("onlyOpen", "1");
    if (podMissingOnly) sp.set("podMissingOnly", "1");
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    return sp.toString();
  }, [q, onlyOpen, podMissingOnly, page, pageSize]);

  const { data, isLoading, isFetching, refetch } = useClientQuery<ReconciliationResponse>({
    queryKey: ["admin", "delivery-reconciliation", params],
    queryFn: () => fetch(`/api/admin/delivery/reconciliation?${params}`).then((r) => r.json()),
  });

  const rows = useMemo(() => data?.items || [], [data?.items]);
  const riders = useMemo(() => data?.riders || [], [data?.riders]);
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <section className="container mx-auto py-8 space-y-4" data-slot="admin-page">
      <Card>
        <CardHeader>
          <CardTitle>Delivery Collection Review</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Orders in view</div>
              <div className="font-semibold">{data?.summary.deliveredOrders ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Pending collections</div>
              <div className="font-semibold">{data?.summary.pendingCollections ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Unsettled collections</div>
              <div className="font-semibold">{data?.summary.unsettledCollections ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">POD missing</div>
              <div className="font-semibold">{data?.summary.podMissing ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Unposted settlements</div>
              <div className="font-semibold">{data?.summary.unpostedSettlements ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Pending balance</div>
              <div className="font-semibold">{formatCurrency(data?.summary.pendingBalance ?? 0)}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Avg pending age</div>
              <div className="font-semibold">{data?.summary.avgPendingAgeDays ?? 0} days</div>
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
                placeholder="Invoice, customer, rider"
              />
            </div>
            <Button
              variant={onlyOpen ? "default" : "outline"}
              className="w-full sm:w-auto"
              onClick={() => {
                setOnlyOpen((v) => !v);
                setPage(1);
              }}
            >
              {onlyOpen ? "Actionable only: ON" : "Show all delivered"}
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
            <Button className="w-full sm:w-auto" variant="outline" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? "Refreshing..." : "Refresh"}
            </Button>
            <Button className="w-full sm:w-auto" variant="outline" asChild>
              <Link href="/admin/delivery/reconciliation/settlements">Settlement history</Link>
            </Button>
          </div>
          <div className="rounded border border-blue-200 bg-blue-50/50 p-2 text-xs text-blue-900">
            Read-only collection review board. Default view shows only items that need follow-up (pending claim or unposted settlement).
          </div>

          <div className="rounded border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rider</TableHead>
                  <TableHead>{onlyOpen ? "Actionable" : "Delivered"}</TableHead>
                  <TableHead>Pending claims</TableHead>
                  <TableHead>Pending balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {riders.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4}>No rider rollups.</TableCell>
                  </TableRow>
                ) : (
                  riders.map((r) => (
                    <TableRow key={`${r.riderName}-${r.riderPhone || ""}`}>
                      <TableCell>
                        <div>{r.riderName}</div>
                        <div className="text-xs text-muted-foreground">{r.riderPhone || "-"}</div>
                      </TableCell>
                      <TableCell>{r.deliveredOrders}</TableCell>
                      <TableCell>{r.pendingCollections}</TableCell>
                      <TableCell>{formatCurrency(r.pendingBalance)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="rounded border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Delivered</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Rider</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead>Balance</TableHead>
                  <TableHead>Collection</TableHead>
                  <TableHead>POD</TableHead>
                  <TableHead>Settlement</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={12}>Loading reconciliation...</TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={12}>
                      {onlyOpen ? "No actionable delivered orders." : "No matching delivered orders."}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Link href={`/admin/orders/${row.id}`} className="underline">
                          {row.invoiceNumber || row.id}
                        </Link>
                      </TableCell>
                      <TableCell>{formatDateGH(row.deliveredAt)}</TableCell>
                      <TableCell>{row.ageDays}d</TableCell>
                      <TableCell>
                        <div>{row.customer?.name || "Unknown"}</div>
                        <div className="text-xs text-muted-foreground">{row.customer?.phone || "-"}</div>
                      </TableCell>
                      <TableCell>
                        <div>{row.riderName || "-"}</div>
                        <div className="text-xs text-muted-foreground">{row.riderPhone || "-"}</div>
                      </TableCell>
                      <TableCell>{formatCurrency(row.total)}</TableCell>
                      <TableCell>{formatCurrency(row.amountPaid)}</TableCell>
                      <TableCell>{formatCurrency(row.balance)}</TableCell>
                      <TableCell>
                        <span className={`inline-flex rounded px-2 py-1 text-xs ${collectionTone(row.collectionState)}`}>
                          {row.hasPendingClaim ? "claim pending" : row.collectionState === "CLEARED" ? "cleared" : "pending"}
                        </span>
                        {row.hasPendingClaim ? (
                          <div className="text-xs text-muted-foreground mt-1">
                            Claimed {formatCurrency(Number(row.claimAmount || 0))} via {String(row.claimMethod || "").toUpperCase()}
                            {row.claimCollectorName ? ` by ${row.claimCollectorName}` : ""}
                          </div>
                        ) : row.balance > 0.01 ? (
                          <div className="text-xs text-muted-foreground mt-1">No dispatcher claim yet</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex rounded px-2 py-1 text-xs ${row.podMissing ? chipToneClass("danger") : chipToneClass("success")}`}>
                          {row.podMissing ? "missing" : "captured"}
                        </span>
                        {row.recipientName || row.recipientPhone ? (
                          <div className="text-xs text-muted-foreground mt-1">
                            {row.recipientName || "Unknown"}
                            {row.recipientPhone ? ` (${row.recipientPhone})` : ""}
                          </div>
                        ) : null}
                        {row.proofImageUrl ? (
                          <div className="text-xs mt-1">
                            <a className="underline" href={row.proofImageUrl} target="_blank" rel="noreferrer">
                              View proof
                            </a>
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {row.reconciliationState === "SETTLED" ? (
                          <span className={`inline-flex rounded px-2 py-1 text-xs ${reconcileTone("SETTLED")}`}>settled</span>
                        ) : row.hasPendingClaim ? (
                          <span className={`inline-flex rounded px-2 py-1 text-xs ${reconcileTone("UNSETTLED")}`}>unsettled</span>
                        ) : (
                          <span className={`inline-flex rounded px-2 py-1 text-xs ${chipToneClass("neutral")}`}>n/a</span>
                        )}
                        {row.settledAt ? (
                          <div className="text-xs text-muted-foreground mt-1">
                            {formatDateGH(row.settledAt)}{row.settlementReference ? ` - ${row.settlementReference}` : ""}
                          </div>
                        ) : null}
                        {row.reconciliationState === "SETTLED" ? (
                          <div className="text-xs text-muted-foreground">
                            Ledger: {row.settlementPostingStatus === "POSTED" ? "posted" : "unposted"}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {row.hasPendingClaim ? (
                          <Button size="sm" variant="outline" asChild>
                            <Link
                              href={`/admin/delivery/dispatch?collectionState=CLAIM_PENDING&q=${encodeURIComponent(
                                row.invoiceNumber || row.id,
                              )}`}
                            >
                              Open in Dispatch
                            </Link>
                          </Button>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              Page {page} of {totalPages} ({total} orders)
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button className="w-full sm:w-auto" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Prev
              </Button>
              <Button
                className="w-full sm:w-auto"
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
    </section>
  );
}
