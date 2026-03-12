"use client";

import { useMemo, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/currency";
import { Input } from "@/components/ui/input";

const normalizeAmount = (value: number) => (Math.abs(value) < 0.01 ? 0 : value);
const formatDisplayCurrency = (value?: number) =>
  formatCurrency(normalizeAmount(value ?? 0));

type IntegrityResponse = {
  draftEntries: number;
  arLedger: number;
  customerBalances: number;
  arDifference: number;
  inventoryLedger: number;
  inventoryValuation: number;
  inventoryDifference: number;
  negativeStockCount: number;
  missingPostings?: {
    orders: number;
    payments: number;
    expenses: number;
    purchases: number;
    supplierPayments: number;
    creditPayouts: number;
    settlements: number;
  };
  missingPostingItems?: {
    orders: Array<{
      id: string;
      invoiceNumber: string | null;
      total: number;
      amountPaid: number;
      status: string;
      createdAt: string;
    }>;
    payments: Array<{
      id: string;
      amount: number;
      status: string | null;
      refundDisposition: string | null;
      createdAt: string;
      order: { id: string; invoiceNumber: string | null } | null;
      user: { id: string; name: string | null; email: string | null } | null;
      note: string | null;
      noteMeta?: {
        reference?: string;
        method?: string;
        balanceAdjustment?: boolean;
      } | null;
      postingFailure?: {
        action: string;
        reason?: string;
        meta?: Record<string, unknown> | null;
        createdAt: string;
      } | null;
    }>;
    expenses: Array<{
      id: string;
      amount: number;
      note: string | null;
      createdAt: string;
    }>;
    purchases: Array<{
      id: string;
      quantity: number;
      unitCost: number;
      status: string;
      createdAt: string;
      supplier: string | null;
      supplierRef: { name: string } | null;
      product: { name: string | null; sku: string | null } | null;
    }>;
    settlements: Array<{
      id: string;
      totalBalance: number;
      receivedBy: string | null;
      createdAt: string;
    }>;
    supplierPayments: Array<{
      id: string;
      amount: number;
      method: string | null;
      reference: string | null;
      createdAt: string;
    }>;
    creditPayouts: Array<{
      id: string;
      amount: number;
      note: string | null;
      createdAt: string;
    }>;
  };
  recentPostFailures?: Array<{
    id: string;
    action: string;
    entityType: string;
    entityId: string;
    meta: string | null;
    createdAt: string;
  }>;
};

type ThresholdConfig = {
  arDifference: number;
  inventoryDifference: number;
  draftEntries: boolean;
  negativeStock: boolean;
};

export default function AccountingIntegrityPage() {
  const { data: prefData } = useClientQuery<{ value: ThresholdConfig | null }>({
    queryKey: ["accounting", "integrity-thresholds", "global"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.integrity.thresholds").then((r) => r.json()),
  });
  const thresholds: ThresholdConfig = {
    arDifference: prefData?.value?.arDifference ?? 0.01,
    inventoryDifference: prefData?.value?.inventoryDifference ?? 0.01,
    draftEntries: prefData?.value?.draftEntries ?? true,
    negativeStock: prefData?.value?.negativeStock ?? true,
  };

  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (asOf) sp.set("asOf", asOf);
    return sp.toString();
  }, [asOf]);
  const todayYmd = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const asOfIsStale = Boolean(asOf && asOf < todayYmd);
  const { data, isLoading, refetch, isFetching, error, isError } = useClientQuery<IntegrityResponse>({
    queryKey: ["accounting", "integrity", "asOf", asOf],
    queryFn: async () => {
      const res = await fetch(`/api/admin/accounting/integrity?${params}`);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof payload?.error === "string" ? payload.error : "Failed to load integrity checks.",
        );
      }
      return payload as IntegrityResponse;
    },
  });
  const missingPostingTotal = useMemo(() => {
    const m = data?.missingPostings;
    if (!m) return 0;
    return (
      Number(m.orders || 0) +
      Number(m.payments || 0) +
      Number(m.expenses || 0) +
      Number(m.purchases || 0) +
      Number(m.supplierPayments || 0) +
      Number(m.creditPayouts || 0) +
      Number(m.settlements || 0)
    );
  }, [data]);

  const [syncing, setSyncing] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  const runSync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/admin/accounting/sync", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to sync accounting.");
      toast.success("Accounting sync complete.");
      refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to sync accounting.");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Data Integrity</h1>
        <p className="text-sm text-muted-foreground">
          Quick checks to spot accounting inconsistencies.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Checks</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">As of date</span>
              <Input
                className="w-full sm:w-auto"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
            {asOfIsStale ? (
              <Button size="sm" variant="secondary" className="w-full sm:w-auto" onClick={() => setAsOf(todayYmd)}>
                Use today
              </Button>
            ) : null}
            <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
              <a href={`/admin/accounting/inventory-valuation?asOf=${encodeURIComponent(asOf)}`}>
                Post inventory adjustment
              </a>
            </Button>
            <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => setSyncOpen(true)} disabled={syncing}>
              {syncing ? "Syncing..." : "Sync ledger"}
            </Button>
            <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? "Refreshing..." : "Recalculate"}
            </Button>
            <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
              <a href={`/api/admin/accounting/integrity/export?${params}`}>Export CSV</a>
            </Button>
            </div>
          </div>
          {asOfIsStale ? (
            <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs">
              This view is filtered as of {asOf}. Newer payments and posting gaps after this date are hidden.
            </div>
          ) : null}
          {isError ? (
            <div className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-700">
              {error instanceof Error ? error.message : "Failed to load integrity checks."}
            </div>
          ) : null}
          {isLoading ? (
            <p className="text-muted-foreground">Loading checks...</p>
          ) : (
            <>
              {missingPostingTotal > 0 ? (
                <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                  Warning: {missingPostingTotal} posting gap(s) detected. Review the ledger readiness counts below.
                </div>
              ) : null}
              <div className="flex justify-between">
                <span>Draft journal entries</span>
                <span>{data?.draftEntries ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span>AR ledger balance</span>
                <span>{formatDisplayCurrency(data?.arLedger)}</span>
              </div>
              <div className="flex justify-between">
                <span>Customer balances total</span>
                <span>{formatDisplayCurrency(data?.customerBalances)}</span>
              </div>
              <div className="flex justify-between">
                <span>AR difference</span>
                <span>
                  {formatDisplayCurrency(data?.arDifference)}
                  {Math.abs(data?.arDifference ?? 0) > thresholds.arDifference ? " ⚠" : ""}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Inventory ledger balance</span>
                <span>{formatDisplayCurrency(data?.inventoryLedger)}</span>
              </div>
              <div className="flex justify-between">
                <span>Inventory valuation (stock × cost)</span>
                <span>{formatDisplayCurrency(data?.inventoryValuation)}</span>
              </div>
              <div className="flex justify-between">
                <span>Inventory difference</span>
                <span>
                  {formatDisplayCurrency(data?.inventoryDifference)}
                  {Math.abs(data?.inventoryDifference ?? 0) > thresholds.inventoryDifference ? " ⚠" : ""}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Products with negative stock</span>
                <span>
                  {data?.negativeStockCount ?? 0}
                  {thresholds.negativeStock && (data?.negativeStockCount ?? 0) > 0 ? " ⚠" : ""}
                </span>
              </div>
              <div className="mt-3 border-t pt-3">
                <div className="text-xs font-semibold text-muted-foreground mb-2">
                  Ledger readiness
                </div>
                <div className="flex justify-between">
                  <span>Orders missing postings</span>
                  <span>{data?.missingPostings?.orders ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span>Payments missing postings</span>
                  <span>{data?.missingPostings?.payments ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span>Expenses missing postings</span>
                  <span>{data?.missingPostings?.expenses ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span>Purchases missing postings</span>
                  <span>{data?.missingPostings?.purchases ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span>Supplier payments missing postings</span>
                  <span>{data?.missingPostings?.supplierPayments ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span>Credit payouts missing postings</span>
                  <span>{data?.missingPostings?.creditPayouts ?? 0}</span>
                </div>
                <div className="flex justify-between">
                  <span>Settlements missing postings</span>
                  <span>{data?.missingPostings?.settlements ?? 0}</span>
                </div>
              </div>
              {data?.missingPostingItems ? (
                <div className="mt-3 border-t pt-3">
                  <div className="text-xs font-semibold text-muted-foreground mb-2">
                    Missing postings (sample)
                  </div>
                  <div className="space-y-3 text-xs">
                    {data.missingPostingItems.orders?.length ? (
                      <div>
                        <div className="font-medium mb-1">Orders</div>
                        <div className="space-y-1">
                          {data.missingPostingItems.orders.map((o) => (
                            <div key={o.id} className="flex flex-wrap items-center gap-2">
                              <a href={`/admin/orders/${o.id}`} className="underline">
                                {o.invoiceNumber || o.id}
                              </a>
                              <span className="text-muted-foreground">
                                {formatDisplayCurrency(o.total)} · {o.status}
                              </span>
                              <span className="text-muted-foreground">
                                {new Date(o.createdAt).toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {data.missingPostingItems.payments?.length ? (
                      <div>
                        <div className="font-medium mb-1">Payments</div>
                        <div className="space-y-1">
                          {data.missingPostingItems.payments.map((p) => (
                            <div key={p.id} className="flex flex-wrap items-center gap-2">
                              <a href={`/admin/payments?id=${p.id}`} className="underline">
                                {p.id}
                              </a>
                              <span className="text-muted-foreground">
                                {formatDisplayCurrency(p.amount)} · {p.status || "NORMAL"}
                              </span>
                              {p.order?.invoiceNumber ? (
                                <span className="text-muted-foreground">
                                  {p.order.invoiceNumber}
                                </span>
                              ) : null}
                              {p.postingFailure ? (
                                <span className="text-muted-foreground">
                                  Post {p.postingFailure.action.replace("ACCOUNTING_POST_", "").toLowerCase()}
                                  {p.postingFailure.reason ? ` (${p.postingFailure.reason})` : ""}
                                </span>
                              ) : null}
                              <span className="text-muted-foreground">
                                {new Date(p.createdAt).toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {data.missingPostingItems.expenses?.length ? (
                      <div>
                        <div className="font-medium mb-1">Expenses</div>
                        <div className="space-y-1">
                          {data.missingPostingItems.expenses.map((e) => (
                            <div key={e.id} className="flex flex-wrap items-center gap-2">
                              <a href={`/admin/expenses?q=${e.id}`} className="underline">
                                {e.id}
                              </a>
                              <span className="text-muted-foreground">
                                {formatDisplayCurrency(e.amount)}
                              </span>
                              {e.note ? (
                                <span className="text-muted-foreground">{e.note}</span>
                              ) : null}
                              <span className="text-muted-foreground">
                                {new Date(e.createdAt).toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {data.missingPostingItems.purchases?.length ? (
                      <div>
                        <div className="font-medium mb-1">Purchases</div>
                        <div className="space-y-1">
                          {data.missingPostingItems.purchases.map((p) => {
                            const supplierName = p.supplierRef?.name || p.supplier || "Supplier";
                            const productLabel = p.product?.name || p.product?.sku || "Product";
                            const total = Number(p.unitCost || 0) * Number(p.quantity || 0);
                            return (
                              <div key={p.id} className="flex flex-wrap items-center gap-2">
                                <a href={`/admin/purchases?purchaseId=${p.id}`} className="underline">
                                  {p.id}
                                </a>
                                <span className="text-muted-foreground">
                                  {supplierName} · {productLabel}
                                </span>
                                <span className="text-muted-foreground">
                                  {formatDisplayCurrency(total)} · {p.status}
                                </span>
                                <span className="text-muted-foreground">
                                  {new Date(p.createdAt).toLocaleString()}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                    {data.missingPostingItems.settlements?.length ? (
                      <div>
                        <div className="font-medium mb-1">Delivery settlements</div>
                        <div className="space-y-1">
                          {data.missingPostingItems.settlements.map((s) => (
                            <div key={s.id} className="flex flex-wrap items-center gap-2">
                              <a href={`/admin/delivery/reconciliation/settlements`} className="underline">
                                {s.id}
                              </a>
                              <span className="text-muted-foreground">
                                {formatDisplayCurrency(s.totalBalance)}
                              </span>
                              {s.receivedBy ? (
                                <span className="text-muted-foreground">Received by {s.receivedBy}</span>
                              ) : null}
                              <span className="text-muted-foreground">
                                {new Date(s.createdAt).toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {data.missingPostingItems.supplierPayments?.length ? (
                      <div>
                        <div className="font-medium mb-1">Supplier payments</div>
                        <div className="space-y-1">
                          {data.missingPostingItems.supplierPayments.map((s) => (
                            <div key={s.id} className="flex flex-wrap items-center gap-2">
                              <a href={`/admin/supplier-payments?paymentId=${s.id}`} className="underline">
                                {s.id}
                              </a>
                              <span className="text-muted-foreground">
                                {formatDisplayCurrency(s.amount)} · {s.method || "payment"}
                              </span>
                              <span className="text-muted-foreground">
                                {new Date(s.createdAt).toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {data.missingPostingItems.creditPayouts?.length ? (
                      <div>
                        <div className="font-medium mb-1">Store-credit cash payouts</div>
                        <div className="space-y-1">
                          {data.missingPostingItems.creditPayouts.map((p) => (
                            <div key={p.id} className="flex flex-wrap items-center gap-2">
                              <a href={`/admin/payments?id=${p.id}`} className="underline">
                                {p.id}
                              </a>
                              <span className="text-muted-foreground">{formatDisplayCurrency(p.amount)}</span>
                              <span className="text-muted-foreground">
                                {new Date(p.createdAt).toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {!data.missingPostingItems.orders?.length &&
                    !data.missingPostingItems.payments?.length &&
                    !data.missingPostingItems.expenses?.length &&
                    !data.missingPostingItems.purchases?.length &&
                    !data.missingPostingItems.supplierPayments?.length &&
                    !data.missingPostingItems.creditPayouts?.length &&
                    !data.missingPostingItems.settlements?.length ? (
                      <div className="text-muted-foreground">No missing postings found.</div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {data?.recentPostFailures?.length ? (
                <div className="mt-3 border-t pt-3">
                  <div className="text-xs font-semibold text-muted-foreground mb-2">
                    Recent posting failures
                  </div>
                  <div className="space-y-2 text-xs">
                    {data.recentPostFailures.map((row) => {
                      let link = "";
                      const type = row.entityType?.toUpperCase?.() || "";
                      if (type === "ORDER") link = `/admin/orders/${row.entityId}`;
                      if (type === "PAYMENT") link = `/admin/payments?id=${row.entityId}`;
                      if (type === "EXPENSE") link = `/admin/expenses?q=${row.entityId}`;
                      if (type === "PURCHASE") link = `/admin/purchases?purchaseId=${row.entityId}`;
                      if (type === "DELIVERY_SETTLEMENT") link = "/admin/delivery/reconciliation/settlements";
                      return (
                        <div key={row.id} className="flex flex-wrap items-center gap-2">
                          {link ? (
                            <a href={link} className="underline">
                              {row.entityType} {row.entityId}
                            </a>
                          ) : (
                            <span>{row.entityType} {row.entityId}</span>
                          )}
                          <span className="text-muted-foreground">{row.action}</span>
                          <span className="text-muted-foreground">
                            {new Date(row.createdAt).toLocaleString()}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
      <Dialog
        open={syncOpen}
        onOpenChange={(open) => {
          setSyncOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Sync ledger</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will backfill missing journal entries and post an inventory valuation adjustment if needed.
          </p>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setSyncOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                await runSync();
                setSyncOpen(false);
              }}
            >
              Run sync
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
