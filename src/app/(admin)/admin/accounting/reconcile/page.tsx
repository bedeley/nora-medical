"use client";

import { useMemo, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";

type SummaryResponse = {
  summary?: {
    totalRevenue: number;
    totalRefunds: number;
    netRevenue: number;
    totalCOGS: number;
    totalExpense: number;
    profit: number;
    margin: number;
  };
};

type LedgerSummaryResponse = {
  summary?: {
    totalRevenue: number;
    totalCOGS: number;
    totalExpense: number;
    profit: number;
    margin: number;
  };
};

type ReconcileResponse = {
  manualEntries: Array<{
    id: string;
    entryDate: string;
    memo: string | null;
    lines: Array<{
      id: string;
      accountCode: string;
      accountName: string;
      accountType: string;
      debit: number;
      credit: number;
      description: string | null;
    }>;
  }>;
  autoApply: Array<{ id: string; orderId: string | null; amount: number; createdAt: string }>;
  returns: Array<{ id: string; orderId: string | null; amount: number; refundDisposition: string | null; createdAt: string }>;
};

const metrics = [
  { key: "totalRevenue", label: "Revenue" },
  { key: "totalCOGS", label: "COGS" },
  { key: "totalExpense", label: "Expenses" },
  { key: "profit", label: "Net Profit" },
  { key: "margin", label: "Margin %" },
] as const;

export default function AccountingReconcilePage() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (start) p.set("start", start);
    if (end) p.set("end", end);
    p.set("groupBy", "day");
    return p.toString();
  }, [start, end]);

  const { data: operational, refetch: refetchOperational } = useClientQuery<SummaryResponse>({
    queryKey: ["accounting", "reconcile", "operational", params],
    queryFn: () => fetch(`/api/admin/summary?${params}`).then((r) => r.json()),
  });
  const { data: ledger, refetch: refetchLedger } = useClientQuery<LedgerSummaryResponse>({
    queryKey: ["accounting", "reconcile", "ledger", params],
    queryFn: () => fetch(`/api/admin/accounting/reports/ledger-summary?${params}`).then((r) => r.json()),
  });
  const { data: reconcile, refetch: refetchReconcile } = useClientQuery<ReconcileResponse>({
    queryKey: ["accounting", "reconcile", "details", params],
    queryFn: () => fetch(`/api/admin/accounting/reconcile?${params}`).then((r) => r.json()),
  });

  const operationalSummary = operational?.summary || {};
  const ledgerSummary = ledger?.summary || {};

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Operational vs Ledger Reconcile</h1>
        <p className="text-sm text-muted-foreground">
          Compare operational totals to ledger totals and review entries that most often explain deltas.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Start date</span>
            <Input className="w-full sm:w-auto" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">End date</span>
            <Input className="w-full sm:w-auto" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <Button
            size="sm"
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => {
              refetchOperational();
              refetchLedger();
              refetchReconcile();
            }}
          >
            Refresh
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Totals</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 text-sm">
            {metrics.map((row) => {
              const operationalValue = Number((operationalSummary as Record<string, number>)[row.key] || 0);
              const ledgerValue = Number((ledgerSummary as Record<string, number>)[row.key] || 0);
              const delta = row.key === "margin" ? ledgerValue - operationalValue : ledgerValue - operationalValue;
              return (
                <div key={row.key} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 items-center">
                  <div className="font-medium">{row.label}</div>
                  <div>{row.key === "margin" ? `${operationalValue.toFixed(2)}%` : formatCurrency(operationalValue)}</div>
                  <div>{row.key === "margin" ? `${ledgerValue.toFixed(2)}%` : formatCurrency(ledgerValue)}</div>
                  <div className="text-muted-foreground">
                    {row.key === "margin"
                      ? `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%`
                      : formatCurrency(delta)}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Manual journal entries in range</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {reconcile?.manualEntries?.length ? (
            reconcile.manualEntries.map((entry) => (
              <div key={entry.id} className="border rounded-md p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">
                    {new Date(entry.entryDate).toLocaleDateString()} · {entry.memo || "Manual entry"}
                  </div>
                  <div className="text-xs text-muted-foreground">ID: {entry.id}</div>
                </div>
                <div className="grid gap-2 text-xs">
                  {entry.lines.map((line) => (
                    <div key={line.id} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      <div>{line.accountCode} · {line.accountName}</div>
                      <div>Dr {formatCurrency(line.debit || 0)}</div>
                      <div>Cr {formatCurrency(line.credit || 0)}</div>
                      <div className="text-muted-foreground">{line.description || "—"}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="text-muted-foreground">No manual journal entries found.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Store credit auto-apply entries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {reconcile?.autoApply?.length ? (
            reconcile.autoApply.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 border rounded-md px-3 py-2">
                <span>
                  {new Date(row.createdAt).toLocaleDateString()} · {formatCurrency(row.amount)}
                </span>
                <span className="text-xs text-muted-foreground">Order: {row.orderId || "—"}</span>
              </div>
            ))
          ) : (
            <div className="text-muted-foreground">No auto-apply entries found.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Return credits/refunds</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {reconcile?.returns?.length ? (
            reconcile.returns.map((row) => (
              <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 border rounded-md px-3 py-2">
                <span>
                  {new Date(row.createdAt).toLocaleDateString()} · {formatCurrency(row.amount)} · {row.refundDisposition || "—"}
                </span>
                <span className="text-xs text-muted-foreground">Order: {row.orderId || "—"}</span>
              </div>
            ))
          ) : (
            <div className="text-muted-foreground">No return entries found.</div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
