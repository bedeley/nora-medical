"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";

type ReturnRow = {
  id: string;
  date: string;
  orderId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  itemLabel: string | null;
  quantity: number | null;
  refundTotal: number;
  refundDisposition: string | null;
  appliedToBalance: number;
  restock: boolean | null;
  rmaDisposition: string | null;
  returnReason: string | null;
  returnReasonNote: string | null;
  source: "PAYMENT" | "ORDER";
};

type ReturnsResponse = {
  rows: ReturnRow[];
  total: number;
  totals: {
    totalReturns: number;
    totalApplied: number;
    totalCredit: number;
    totalCash: number;
    storeCreditUsed?: number;
  };
  baseTotals?: {
    totalReturns: number;
    totalApplied: number;
    totalCredit: number;
    totalCash: number;
  };
};

export default function AdminReturnsPage() {
  const [q, setQ] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [type, setType] = useState("all");
  const [source, setSource] = useState("all");
  const [rmaDisposition, setRmaDisposition] = useState("all");

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (start) sp.set("start", start);
    if (end) sp.set("end", end);
    if (type !== "all") sp.set("type", type);
    if (source !== "all") sp.set("source", source);
    if (rmaDisposition !== "all") sp.set("rmaDisposition", rmaDisposition);
    return sp.toString();
  }, [q, start, end, type, source, rmaDisposition]);

  const { data, error, isLoading } = useClientQuery<ReturnsResponse>({
    queryKey: ["admin", "returns", q, start, end, type, source, rmaDisposition],
    queryFn: () =>
      fetch(`/api/admin/returns?${params}`).then(async (r) => {
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error((payload as { error?: string }).error || "Failed to load returns.");
        }
        return payload as ReturnsResponse;
      }),
  });

  const rows = data?.rows || [];
  const totals = data?.totals || {
    totalReturns: 0,
    totalApplied: 0,
    totalCredit: 0,
    totalCash: 0,
    storeCreditUsed: 0,
  };
  const baseTotals = data?.baseTotals || totals;
  const expectedRemainingCredit = Math.max(
    0,
    (baseTotals.totalCredit || 0) - (totals.storeCreditUsed || 0),
  );

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Returns &amp; RMA</h1>
        <p className="text-sm text-muted-foreground">
          Track item returns, restocks, and refund dispositions.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6 text-sm">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Search</span>
            <Input
              placeholder="Search order, customer, item"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">From Date</span>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">To Date</span>
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Return Type</span>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="all">All types</option>
              <option value="credit">Store credit</option>
              <option value="cash">Cash refund</option>
              <option value="applied">Applied to balance</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Source</span>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="all">All sources</option>
              <option value="PAYMENT">Payment</option>
              <option value="ORDER">Order (journal)</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">RMA Disposition</span>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm text-foreground"
              value={rmaDisposition}
              onChange={(e) => setRmaDisposition(e.target.value)}
            >
              <option value="all">All dispositions</option>
              <option value="RESTOCK">Restock</option>
              <option value="SCRAP">Scrap</option>
              <option value="RETURN_TO_SUPPLIER">Return to Supplier</option>
            </select>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Store credit reflects credit created at return time (after any balance reduction).
            Remaining credit may be lower once customers use it on new orders.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Total returns</div>
              <div className="text-lg font-semibold">{formatCurrency(totals.totalReturns)}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Applied to balance</div>
              <div className="text-lg font-semibold">{formatCurrency(totals.totalApplied)}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Store credit</div>
              <div className="text-lg font-semibold">{formatCurrency(totals.totalCredit)}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Credit used on orders</div>
              <div className="text-lg font-semibold">
                {formatCurrency(totals.storeCreditUsed || 0)}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Expected remaining credit</div>
              <div className="text-lg font-semibold">
                {formatCurrency(expectedRemainingCredit)}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Cash refunds</div>
              <div className="text-lg font-semibold">{formatCurrency(totals.totalCash)}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent returns</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {isLoading ? (
            <div className="text-muted-foreground">Loading returns...</div>
          ) : error ? (
            <div className="text-red-600">Failed to load returns.</div>
          ) : rows.length === 0 ? (
            <div className="text-muted-foreground">No returns found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 px-3 text-center">Date</th>
                    <th className="py-2 px-3 text-center">Order</th>
                    <th className="py-2 px-3 text-center">Customer</th>
                    <th className="py-2 px-3 text-center">Item</th>
                    <th className="py-2 px-3 text-center">Qty</th>
                    <th className="py-2 px-3 text-center">Return</th>
                    <th className="py-2 px-3 text-center">Refund</th>
                    <th className="py-2 px-3 text-center">RMA disposition</th>
                    <th className="py-2 px-3 text-center">Reason</th>
                    <th className="py-2 px-3 text-center">Applied</th>
                    <th className="py-2 px-3 text-center">Restock</th>
                    <th className="py-2 px-3 text-center">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-2 px-3 text-center">
                        {new Date(row.date).toLocaleDateString()}
                      </td>
                      <td className="py-2 px-3 text-center">
                        {row.orderId ? (
                          <Link href={`/admin/orders/${row.orderId}`} className="underline">
                            {row.orderId.slice(0, 8)}...
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-center">
                        <div>{row.customerName || "-"}</div>
                        {row.customerEmail ? (
                          <div className="text-xs text-muted-foreground">{row.customerEmail}</div>
                        ) : null}
                      </td>
                      <td className="py-2 px-3 text-center">{row.itemLabel || "-"}</td>
                      <td className="py-2 px-3 text-center">{row.quantity ?? "-"}</td>
                      <td className="py-2 px-3 text-center">{formatCurrency(row.refundTotal)}</td>
                      <td className="py-2 px-3 text-center">{row.refundDisposition || "-"}</td>
                      <td className="py-2 px-3 text-center">{row.rmaDisposition || "-"}</td>
                      <td className="py-2 px-3 text-center">
                        {row.returnReason
                          ? `${row.returnReason}${row.returnReasonNote ? ` | ${row.returnReasonNote}` : ""}`
                          : "-"}
                      </td>
                      <td className="py-2 px-3 text-center">
                        {formatCurrency(row.appliedToBalance)}
                      </td>
                      <td className="py-2 px-3 text-center">
                        {row.restock === null ? "-" : row.restock ? "Yes" : "No"}
                      </td>
                      <td className="py-2 px-3 text-center">{row.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Total: {data?.total || 0}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQ("");
                setStart("");
                setEnd("");
                setType("all");
                setSource("all");
                setRmaDisposition("all");
              }}
            >
              Clear filters
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
