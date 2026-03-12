"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";

type BucketTotals = {
  "0-30": number;
  "31-60": number;
  "61-90": number;
  "90+": number;
};

type AgingResponse = {
  type: "ar" | "ap";
  asOf: string;
  rows: unknown[];
  totals: {
    total: number;
    buckets: BucketTotals;
  };
};

export default function AgingHomePage() {
  const [asOf, setAsOf] = useState("");
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string>("");

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (asOf) sp.set("asOf", asOf);
    return sp.toString();
  }, [asOf]);

  const {
    data: arData,
    isLoading: arLoading,
    error: arError,
  } = useClientQuery<AgingResponse>({
    queryKey: ["admin", "accounting", "aging", "home", "ar", asOf],
    queryFn: () =>
      fetch(`/api/admin/accounting/aging?type=ar${params ? `&${params}` : ""}`).then(async (r) => {
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((payload as { error?: string }).error || "Failed to load AR summary.");
        setLastRefreshedAt(new Date().toISOString());
        return payload as AgingResponse;
      }),
  });

  const {
    data: apData,
    isLoading: apLoading,
    error: apError,
  } = useClientQuery<AgingResponse>({
    queryKey: ["admin", "accounting", "aging", "home", "ap", asOf],
    queryFn: () =>
      fetch(`/api/admin/accounting/aging?type=ap${params ? `&${params}` : ""}`).then(async (r) => {
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((payload as { error?: string }).error || "Failed to load AP summary.");
        setLastRefreshedAt(new Date().toISOString());
        return payload as AgingResponse;
      }),
  });

  const emptyTotals: BucketTotals = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  const arTotals = arData?.totals?.buckets || emptyTotals;
  const apTotals = apData?.totals?.buckets || emptyTotals;
  const arTotal = Number(arData?.totals?.total || 0);
  const apTotal = Number(apData?.totals?.total || 0);
  const netExposure = arTotal - apTotal;
  const loading = arLoading || apLoading;
  const asOfSuffix = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  const nearZero = Math.abs(netExposure) <= 0.01;
  const netExposureTone = nearZero
    ? "text-amber-700"
    : netExposure > 0
      ? "text-emerald-700"
      : "text-rose-700";

  const copySnapshot = async () => {
    const asOfLabel = asOf || "today";
    const payload = [
      `Aging snapshot (as-of: ${asOfLabel})`,
      `AR Total: ${formatCurrency(arTotal)}`,
      `AP Total: ${formatCurrency(apTotal)}`,
      `Net Exposure (AR - AP): ${formatCurrency(netExposure)}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(payload);
      toast.success("Snapshot copied.");
    } catch {
      toast.error("Failed to copy snapshot.");
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">AR/AP aging</h1>
        <p className="text-sm text-muted-foreground">
          Review overdue customer balances and supplier payables by aging bucket.
        </p>
      </div>

      <Card>
        <CardHeader className="flex items-center justify-between gap-3 sm:flex-row">
          <CardTitle>Scope</CardTitle>
          <Button size="sm" variant="outline" onClick={copySnapshot}>
            Copy snapshot
          </Button>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-[220px]"
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
            <Button size="sm" variant="outline" onClick={() => setAsOf("")}>
              Today
            </Button>
            <span className="text-xs text-muted-foreground">
              {asOf ? `As-of date: ${asOf}` : "As-of date: today"}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            Use this page as a quick aging control tower, then drill into AR/AP pages for detailed filters and exports.
          </div>
          {lastRefreshedAt ? (
            <div className="text-xs text-muted-foreground">
              Last refreshed: {new Date(lastRefreshedAt).toLocaleString()}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Accounts receivable (AR)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Outstanding customer balances grouped by age.</p>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Total</div>
              <div className="text-lg font-semibold">{formatCurrency(arTotal)}</div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div>0-30: {formatCurrency(arTotals["0-30"])}</div>
                <div>31-60: {formatCurrency(arTotals["31-60"])}</div>
                <div>61-90: {formatCurrency(arTotals["61-90"])}</div>
                <div>90+: {formatCurrency(arTotals["90+"])}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href={`/admin/accounting/aging/ar${asOfSuffix}`}>Open AR aging</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/orders?outstandingOnly=1&sortKey=balance&sortDir=desc">
                  Open collections queue
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/customers?balance=due&sort=balance_desc">Open customers</Link>
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Journal drill:</span>
              <Link href="/admin/accounting/journal?account=1100" className="underline">
                1100 AR
              </Link>
              <span>·</span>
              <Link href="/admin/accounting/journal?account=1000" className="underline">
                1000 Cash
              </Link>
              <span>·</span>
              <Link href="/admin/accounting/journal?account=1030" className="underline">
                1030 MoMo Clearing
              </Link>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Accounts payable (AP)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Unpaid supplier balances grouped by age.</p>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Total</div>
              <div className="text-lg font-semibold">{formatCurrency(apTotal)}</div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <div>0-30: {formatCurrency(apTotals["0-30"])}</div>
                <div>31-60: {formatCurrency(apTotals["31-60"])}</div>
                <div>61-90: {formatCurrency(apTotals["61-90"])}</div>
                <div>90+: {formatCurrency(apTotals["90+"])}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href={`/admin/accounting/aging/ap${asOfSuffix}`}>Open AP aging</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/supplier-payments?outstandingOnly=1&agingFilter=all&sortMode=amount_desc&exposureView=full">
                  Open supplier follow-up
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/suppliers?sort=name_asc">Open suppliers</Link>
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Journal drill:</span>
              <Link href="/admin/accounting/journal?account=2000" className="underline">
                2000 AP
              </Link>
              <span>·</span>
              <Link href="/admin/accounting/journal?account=1000" className="underline">
                1000 Cash
              </Link>
              <span>·</span>
              <Link href="/admin/accounting/journal?account=2300" className="underline">
                2300 Accrued Expenses
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Net exposure</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <div className="text-xs text-muted-foreground">AR total - AP total</div>
          <div className={`text-lg font-semibold ${netExposureTone}`}>{formatCurrency(netExposure)}</div>
          <p className="text-xs text-muted-foreground">
            {netExposure >= 0
              ? "Positive: customers owe you more than you currently owe suppliers."
              : "Negative: supplier obligations currently exceed customer receivables."}
          </p>
        </CardContent>
      </Card>

      {loading ? <p className="text-xs text-muted-foreground">Refreshing aging snapshot...</p> : null}
      {arError || apError ? (
        <p className="text-xs text-red-600">Unable to refresh one or more snapshots. Please reload the page.</p>
      ) : null}
    </section>
  );
}
