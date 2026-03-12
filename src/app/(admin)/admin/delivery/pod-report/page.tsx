"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateGH } from "@/lib/currency";
import { chipToneClass } from "@/lib/status-chips";

type PodStatus = "ALL" | "CAPTURED" | "MISSING";
type HasProof = "ALL" | "YES" | "NO";

type PodRow = {
  id: string;
  invoiceNumber?: string | null;
  deliveredAt: string;
  customerName?: string | null;
  customerPhone?: string | null;
  riderName?: string | null;
  riderPhone?: string | null;
  podStatus: "CAPTURED" | "MISSING";
  recipientName?: string | null;
  recipientPhone?: string | null;
  deliveryNote?: string | null;
  proofImageUrl?: string | null;
};

type PodResponse = {
  items: PodRow[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    delivered: number;
    podCaptured: number;
    podMissing: number;
  };
};

export default function DeliveryPodReportPage() {
  const [q, setQ] = useState("");
  const [riderUserId, setRiderUserId] = useState("ALL");
  const [podStatus, setPodStatus] = useState<PodStatus>("ALL");
  const [hasProof, setHasProof] = useState<HasProof>("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (q.trim()) sp.set("q", q.trim());
    if (riderUserId !== "ALL") sp.set("riderUserId", riderUserId);
    if (podStatus !== "ALL") sp.set("podStatus", podStatus);
    if (hasProof !== "ALL") sp.set("hasProof", hasProof);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    return sp.toString();
  }, [q, riderUserId, podStatus, hasProof, from, to, page, pageSize]);

  const { data, isLoading, isFetching, refetch } = useClientQuery<PodResponse>({
    queryKey: ["admin", "delivery-pod-report", params],
    queryFn: () => fetch(`/api/admin/delivery/pod-report?${params}`).then((r) => r.json()),
  });
  const { data: usersData } = useClientQuery<{
    rows?: Array<{
      user: { id: string; role: string; archived?: boolean; name?: string | null };
    }>;
  }>({
    queryKey: ["admin", "delivery-pod-report-dispatchers"],
    queryFn: () => fetch("/api/admin/users?includeArchived=0").then((r) => r.json()),
  });

  const rows = data?.items || [];
  const dispatchers = useMemo(
    () =>
      (usersData?.rows || [])
        .map((row) => row.user)
        .filter((user) => String(user.role) === "DISPATCHER" && !user.archived)
        .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
    [usersData?.rows],
  );
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const exportCsv = () => {
    const sp = new URLSearchParams(params);
    sp.set("format", "csv");
    window.open(`/api/admin/delivery/pod-report?${sp.toString()}`, "_blank");
  };

  const applyToday = () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    setFrom(day);
    setTo(day);
    setPage(1);
  };

  const applyLast7Days = () => {
    const now = new Date();
    const fromDate = new Date(now);
    fromDate.setUTCDate(fromDate.getUTCDate() - 6);
    setFrom(fromDate.toISOString().slice(0, 10));
    setTo(now.toISOString().slice(0, 10));
    setPage(1);
  };

  const applyThisMonth = () => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const day = now.toISOString().slice(0, 10);
    setFrom(`${year}-${month}-01`);
    setTo(day);
    setPage(1);
  };

  const clearDates = () => {
    setFrom("");
    setTo("");
    setPage(1);
  };

  return (
    <section className="container mx-auto py-8 space-y-4" data-slot="admin-page">
      <Card>
        <CardHeader>
          <CardTitle>Delivery POD Report</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">Delivered orders</div>
              <div className="font-semibold">{data?.summary.delivered ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">POD captured</div>
              <div className="font-semibold">{data?.summary.podCaptured ?? 0}</div>
            </div>
            <div className="rounded border p-2 text-sm">
              <div className="text-xs text-muted-foreground">POD missing</div>
              <div className="font-semibold">{data?.summary.podMissing ?? 0}</div>
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
                placeholder="Invoice, customer, recipient"
              />
            </div>
            <div className="w-full sm:w-[220px]">
              <Label>Rider</Label>
              <Select
                value={riderUserId}
                onValueChange={(value: string) => {
                  setRiderUserId(value);
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All riders" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All riders</SelectItem>
                  {dispatchers.map((dispatcher) => (
                    <SelectItem key={dispatcher.id} value={dispatcher.id}>
                      {dispatcher.name || dispatcher.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-full sm:w-[180px]">
              <Label>POD status</Label>
              <Select
                value={podStatus}
                onValueChange={(v: PodStatus) => {
                  setPodStatus(v);
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All</SelectItem>
                  <SelectItem value="CAPTURED">Captured</SelectItem>
                  <SelectItem value="MISSING">Missing</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-full sm:w-[180px]">
              <Label>Has proof image</Label>
              <Select
                value={hasProof}
                onValueChange={(v: HasProof) => {
                  setHasProof(v);
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All</SelectItem>
                  <SelectItem value="YES">Yes</SelectItem>
                  <SelectItem value="NO">No</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="from">From</Label>
              <Input
                id="from"
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div>
              <Label htmlFor="to">To</Label>
              <Input
                id="to"
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <Button className="w-full sm:w-auto" variant="outline" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? "Refreshing..." : "Refresh"}
            </Button>
            <Button className="w-full sm:w-auto" variant="outline" onClick={exportCsv}>
              Export CSV
            </Button>
            <div className="w-full flex flex-wrap gap-2 pt-1">
              <Button type="button" className="w-full sm:w-auto" variant="outline" size="sm" onClick={applyToday}>
                Today
              </Button>
              <Button type="button" className="w-full sm:w-auto" variant="outline" size="sm" onClick={applyLast7Days}>
                Last 7 days
              </Button>
              <Button type="button" className="w-full sm:w-auto" variant="outline" size="sm" onClick={applyThisMonth}>
                This month
              </Button>
              <Button type="button" className="w-full sm:w-auto" variant="outline" size="sm" onClick={clearDates}>
                Clear dates
              </Button>
            </div>
          </div>

          <div className="rounded border overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Delivered</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Rider</TableHead>
                  <TableHead>POD</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead>Proof</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={7}>Loading POD report...</TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7}>No matching records.</TableCell>
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
                      <TableCell>
                        <div>{row.customerName || "Unknown"}</div>
                        <div className="text-xs text-muted-foreground">{row.customerPhone || "-"}</div>
                      </TableCell>
                      <TableCell>
                        <div>{row.riderName || "-"}</div>
                        <div className="text-xs text-muted-foreground">{row.riderPhone || "-"}</div>
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex rounded px-2 py-1 text-xs ${
                            row.podStatus === "CAPTURED" ? chipToneClass("success") : chipToneClass("danger")
                          }`}
                        >
                          {row.podStatus.toLowerCase()}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div>{row.recipientName || "-"}</div>
                        <div className="text-xs text-muted-foreground">{row.recipientPhone || "-"}</div>
                        <div className="text-xs mt-1">
                          {row.deliveryNote ? (
                            <>
                              <span
                                className={`inline-flex rounded px-2 py-0.5 mr-1 ${
                                  row.deliveryNote.trim().length >= 10
                                    ? chipToneClass("success")
                                    : chipToneClass("warning")
                                }`}
                              >
                                {row.deliveryNote.trim().length >= 10 ? "note ok" : "note short"}
                              </span>
                              <span className="text-muted-foreground">
                                {row.deliveryNote.trim().slice(0, 60)}
                                {row.deliveryNote.trim().length > 60 ? "..." : ""}
                              </span>
                            </>
                          ) : (
                            <span className={`inline-flex rounded px-2 py-0.5 ${chipToneClass("danger")}`}>
                              note missing
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          {row.proofImageUrl ? (
                            <a href={row.proofImageUrl} target="_blank" rel="noreferrer" className="underline">
                              View proof
                            </a>
                          ) : (
                            "-"
                          )}
                          <Link
                            href={`/admin/delivery/dispatch?q=${encodeURIComponent(row.invoiceNumber || row.id)}&includeDelivered=1`}
                            className="underline text-xs"
                          >
                            Open in Dispatch
                          </Link>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div>
              Page {page} of {totalPages} ({total} rows)
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
