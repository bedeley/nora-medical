"use client";

export const dynamic = "force-dynamic";

import { useMemo, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatDateGH } from "@/lib/currency";
import { toast } from "sonner";
import { chipToneClass } from "@/lib/status-chips";

type SettlementRow = {
  sourceType?: "SETTLEMENT_BATCH" | "COLLECTION_CONFIRMATION";
  id: string;
  settledAt: string;
  receivedBy?: string | null;
  reference?: string | null;
  note?: string | null;
  orderCount: number;
  totalBalance: number;
  actorName?: string | null;
  postingStatus?: "POSTED" | "UNPOSTED";
  postingJournalId?: string | null;
  postingPostedAt?: string | null;
  postingError?: string | null;
};

type SettlementsResponse = {
  items: SettlementRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    settlements: number;
    settledAmount: number;
    ordersCovered: number;
    unpostedSettlements: number;
  };
};

export default function DeliverySettlementHistoryPage() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    return sp.toString();
  }, [q, page, pageSize]);

  const { data, isLoading, isFetching, refetch } = useClientQuery<SettlementsResponse>({
    queryKey: ["admin", "delivery-settlements", params],
    queryFn: () => fetch(`/api/admin/delivery/reconciliation/settlements?${params}`).then((r) => r.json()),
  });

  const rows = data?.items || [];
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const retryPost = async (id: string) => {
    const res = await fetch(`/api/admin/delivery/reconciliation/settlements/${id}/post`, {
      method: "POST",
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(payload?.error || "Failed to post settlement");
      return;
    }
    toast.success(payload?.posted ? "Settlement posted to journal." : "No posting needed.");
    await refetch();
  };

  return (
    <section className="container mx-auto py-8 space-y-4" data-slot="admin-page">
      <Card>
        <CardHeader>
          <CardTitle>Delivery Collection History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Settlements</div>
              <div className="font-semibold">{data?.summary.settlements ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Orders covered</div>
              <div className="font-semibold">{data?.summary.ordersCovered ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Settled balance</div>
              <div className="font-semibold">{formatCurrency(data?.summary.settledAmount ?? 0)}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Unposted settlements</div>
              <div className="font-semibold">{data?.summary.unpostedSettlements ?? 0}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="w-full sm:w-[240px]">
              <Label htmlFor="q">Search</Label>
              <Input
                id="q"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
                placeholder="Record ID, order, reference, receiver"
              />
            </div>
            <Button className="w-full sm:w-auto" variant="outline" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? "Refreshing..." : "Refresh"}
            </Button>
          </div>

          <div className="rounded border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Record</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Received by</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead>Balance settled</TableHead>
                  <TableHead>Recorded by</TableHead>
                  <TableHead>Ledger</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={9}>Loading collection history...</TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9}>No collection records found.</TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <div className="font-medium">{row.id}</div>
                        <div className="text-xs text-muted-foreground">{row.reference || "-"}</div>
                      </TableCell>
                      <TableCell>
                        {row.sourceType === "COLLECTION_CONFIRMATION" ? "order confirm" : "settlement batch"}
                      </TableCell>
                      <TableCell>{formatDateGH(row.settledAt)}</TableCell>
                      <TableCell>{row.receivedBy || "-"}</TableCell>
                      <TableCell>{row.orderCount}</TableCell>
                      <TableCell>{formatCurrency(row.totalBalance)}</TableCell>
                      <TableCell>{row.actorName || "-"}</TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex rounded px-2 py-1 text-xs ${
                            row.postingStatus === "POSTED" ? chipToneClass("success") : chipToneClass("warning")
                          }`}
                        >
                          {row.postingStatus === "POSTED" ? "posted" : "unposted"}
                        </span>
                        {row.postingError ? (
                          <div className="text-xs text-rose-700 mt-1">{row.postingError}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {row.sourceType !== "COLLECTION_CONFIRMATION" && row.postingStatus !== "POSTED" ? (
                          <Button size="sm" variant="outline" onClick={() => void retryPost(row.id)}>
                            Retry post
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
              Page {page} of {totalPages} ({total} settlements)
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
