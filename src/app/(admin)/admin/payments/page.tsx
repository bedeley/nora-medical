"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/currency";

type PaymentRow = {
  id: string;
  amount: number;
  status: string | null;
  refundDisposition: string | null;
  createdAt: string;
  user: { id: string; name: string | null; email: string | null } | null;
  order: { id: string; invoiceNumber: string | null; receiptHash: string | null } | null;
  method: string;
  provider: string;
  reference: string;
  location: string;
  note: string;
};

const fetcher = async (url: string) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data as { error?: string })?.error || "Failed to load payments.";
    throw new Error(message);
  }
  return data;
};

function currentMonth() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export default function AdminPaymentsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialized = useRef(false);
  const [q, setQ] = useState("");
  const [month, setMonth] = useState(currentMonth());
  const [exactId, setExactId] = useState("");
  const [method, setMethod] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [disposition, setDisposition] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => {
    if (initialized.current) return;
    const sp = new URLSearchParams(searchParams.toString());
    const incomingId = sp.get("id") || "";
    setExactId(incomingId);
    setQ(sp.get("q") || "");
    setMonth(sp.get("month") || (incomingId ? "" : currentMonth()));
    setMethod(sp.get("method") || "all");
    setStatus(sp.get("status") || "all");
    setDisposition(sp.get("disposition") || "all");
    setPage(Math.max(1, parseInt(sp.get("page") || "1", 10) || 1));
    setPageSize(Math.max(1, Math.min(200, parseInt(sp.get("pageSize") || "25", 10) || 25)));
    initialized.current = true;
  }, [searchParams]);

  useEffect(() => {
    if (!initialized.current) return;
    const sp = new URLSearchParams();
    if (exactId) sp.set("id", exactId);
    if (q) sp.set("q", q);
    if (month) sp.set("month", month);
    if (method !== "all") sp.set("method", method);
    if (status !== "all") sp.set("status", status);
    if (disposition !== "all") sp.set("disposition", disposition);
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    const next = `${window.location.pathname}?${sp.toString()}`.replace(/\?$/, "");
    router.replace(next, { scroll: false });
  }, [exactId, q, month, method, status, disposition, page, pageSize, router]);

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (exactId) sp.set("id", exactId);
    if (q) sp.set("q", q);
    if (month) sp.set("month", month);
    if (method !== "all") sp.set("method", method);
    if (status !== "all") sp.set("status", status);
    if (disposition !== "all") sp.set("disposition", disposition);
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    return sp.toString();
  }, [exactId, q, month, method, status, disposition, page, pageSize]);

  const { data, error, isLoading } = useClientQuery<{
    rows: PaymentRow[];
    total: number;
    totalAmount: number;
    totals: {
      cashIn: number;
      cashOut: number;
      storeCreditIssued: number;
      storeCreditApplied: number;
      netCash: number;
    };
    page: number;
    pageSize: number;
  }>({
    queryKey: ["admin", "payments", q, month, method, status, disposition, page, pageSize],
    queryFn: () => fetcher(`/api/admin/payments?${params}`),
  });

  const rows = (data?.rows || []) as PaymentRow[];
  const total = data?.total || 0;
  const totalAmount = data?.totalAmount || 0;
  const cashIn = data?.totals?.cashIn || 0;
  const cashOut = data?.totals?.cashOut || 0;
  const storeCreditIssued = data?.totals?.storeCreditIssued || 0;
  const storeCreditApplied = data?.totals?.storeCreditApplied || 0;
  const netCash = data?.totals?.netCash || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const resetFilters = () => {
    setQ("");
    setMonth(currentMonth());
    setExactId("");
    setMethod("all");
    setStatus("all");
    setDisposition("all");
    setPage(1);
  };

  const openExport = () => {
    const sp = new URLSearchParams();
    if (month) sp.set("month", month);
    if (method !== "all") sp.set("method", method);
    if (status !== "all") sp.set("status", status);
    window.open(`/api/admin/payments/export?${sp.toString()}`, "_blank");
  };

  const openPrint = () => {
    const sp = new URLSearchParams();
    if (month) sp.set("month", month);
    if (method !== "all") sp.set("method", method);
    if (status !== "all") sp.set("status", status);
    window.open(`/admin/payments/export/print?${sp.toString()}`, "_blank");
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Payments</h1>
          <p className="text-sm text-muted-foreground">
            Central view of payments, refunds, and store credits.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button className="w-full sm:w-auto" variant="outline" onClick={openExport}>Export CSV</Button>
          <Button className="w-full sm:w-auto" variant="outline" onClick={openPrint}>Print</Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setExactId("");
                setPage(1);
              }}
              placeholder="Search by customer, order, or payment ID"
            />
            <Input
              type="month"
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                setExactId("");
                setPage(1);
              }}
            />
            <Select
              value={method}
              onValueChange={(v) => {
                setMethod(v);
                setExactId("");
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Payment method" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All methods</SelectItem>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="momo">MoMo</SelectItem>
                <SelectItem value="transfer">Transfer</SelectItem>
                <SelectItem value="adjustment">Adjustment</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v);
                setExactId("");
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="refund">Refund</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={disposition}
              onValueChange={(v) => {
                setDisposition(v);
                setExactId("");
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Refund disposition" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All dispositions</SelectItem>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="credit">Store credit</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => {
                setPageSize(Number(v));
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Rows" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10 rows</SelectItem>
                <SelectItem value="25">25 rows</SelectItem>
                <SelectItem value="50">50 rows</SelectItem>
                <SelectItem value="100">100 rows</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Total: {total}</span>
            <span>•</span>
            <span>Total amount: {formatCurrency(totalAmount)}</span>
            <span>•</span>
            <span>Cash in: {formatCurrency(cashIn)}</span>
            <span>•</span>
            <span>Cash out: {formatCurrency(cashOut)}</span>
            <span>•</span>
            <span>Store credit issued: {formatCurrency(storeCreditIssued)}</span>
            <span>•</span>
            <span>Store credit applied: {formatCurrency(storeCreditApplied)}</span>
            <span>•</span>
            <span>Net cash: {formatCurrency(netCash)}</span>
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              Clear filters
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Payment Ledger</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading payments…</p>
          ) : error ? (
            <p className="text-sm text-red-600">
              {error instanceof Error ? error.message : "Failed to load payments."}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments found for the current filters.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm whitespace-nowrap">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left py-2 pr-4">Date</th>
                    <th className="text-left py-2 pr-4">Customer</th>
                    <th className="text-left py-2 pr-4">Order</th>
                    <th className="text-left py-2 pr-4">Method</th>
                    <th className="text-left py-2 pr-4">Provider</th>
                    <th className="text-left py-2 pr-4">Reference</th>
                    <th className="text-right py-2 pr-4">Amount</th>
                    <th className="text-left py-2 pr-4">Status</th>
                    <th className="text-left py-2 pr-4">Disposition</th>
                    <th className="text-left py-2 pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="py-2 pr-4">{new Date(row.createdAt).toLocaleString()}</td>
                      <td className="py-2 pr-4">
                        {row.user ? (
                          <Link className="underline" href={`/admin/customers/${row.user.id}/view`}>
                            {row.user.name || row.user.email || "Customer"}
                          </Link>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {row.order ? (
                          <Link className="underline" href={`/admin/orders/${row.order.id}`}>
                            {row.order.invoiceNumber || row.order.id}
                          </Link>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="py-2 pr-4">{row.method || "-"}</td>
                      <td className="py-2 pr-4">{row.provider || "-"}</td>
                      <td className="py-2 pr-4">{row.reference || "-"}</td>
                      <td className="py-2 pr-4 text-right">{formatCurrency(row.amount)}</td>
                      <td className="py-2 pr-4">{row.status || "-"}</td>
                      <td className="py-2 pr-4">{row.refundDisposition || "-"}</td>
                      <td className="py-2 pr-4">
                        <Link
                          className="underline"
                          href={`/admin/payments/receipt/${row.id}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Receipt
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 flex items-center gap-2 text-sm">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <span>
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
