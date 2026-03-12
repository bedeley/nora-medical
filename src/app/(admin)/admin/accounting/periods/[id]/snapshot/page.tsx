"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";

type SnapshotPayload = {
  id: string;
  data: {
    period: { name: string; startDate: string; endDate: string };
    generatedAt: string;
    profitAndLoss: {
      income: { code: string; name: string; amount: number }[];
      expenses: { code: string; name: string; amount: number }[];
      incomeTotal: number;
      expenseTotal: number;
      netProfit: number;
    };
    balanceSheet: {
      assets: { code: string; name: string; balance: number }[];
      liabilities: { code: string; name: string; balance: number }[];
      equity: { code: string; name: string; balance: number }[];
      totals: {
        assets: number;
        liabilities: number;
        equity: number;
        liabilitiesPlusEquity: number;
      };
      asOf: string;
    };
  };
  createdAt: string;
};

export default function PeriodSnapshotPage() {
  const params = useParams();
  const periodId = String((params as { id?: string }).id || "");
  const [creating, setCreating] = useState(false);

  const { data, isLoading, refetch } = useClientQuery<SnapshotPayload>({
    queryKey: ["accounting", "period", periodId, "snapshot"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/accounting/periods/${periodId}/snapshot`);
      if (res.status === 404) {
        return Promise.reject(new Error("not_found"));
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to load snapshot.");
      return j;
    },
    enabled: Boolean(periodId),
    retry: false,
  });

  const createSnapshot = async () => {
    if (!periodId) return;
    try {
      setCreating(true);
      const res = await fetch(`/api/admin/accounting/periods/${periodId}/snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to create snapshot.");
      toast.success("Snapshot generated.");
      refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create snapshot.");
    } finally {
      setCreating(false);
    }
  };

  if (isLoading) {
    return (
      <section className="container mx-auto py-8">
        <p className="text-sm text-muted-foreground">Loading snapshot...</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="container mx-auto py-8 space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Period Close Report</h1>
          <p className="text-sm text-muted-foreground">No snapshot exists yet.</p>
        </div>
        <Button onClick={createSnapshot} disabled={creating}>
          {creating ? "Generating..." : "Generate snapshot"}
        </Button>
      </section>
    );
  }

  const snapshot = data.data;
  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Period Close Report</h1>
        <p className="text-sm text-muted-foreground">
          {snapshot.period.name} · {new Date(snapshot.period.startDate).toLocaleDateString()} -{" "}
          {new Date(snapshot.period.endDate).toLocaleDateString()}
        </p>
        <p className="text-xs text-muted-foreground">
          Generated {new Date(snapshot.generatedAt).toLocaleString()}
        </p>
        <div className="mt-2">
          <Button asChild size="sm" variant="outline">
            <a href={`/api/admin/accounting/periods/${periodId}/snapshot/export`}>
              Export CSV
            </a>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profit &amp; Loss</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <div className="font-medium">Income</div>
          {snapshot.profitAndLoss.income.map((row) => (
            <div key={row.code} className="flex justify-between">
              <span>{row.code} · {row.name}</span>
              <span>{formatCurrency(row.amount)}</span>
            </div>
          ))}
          <div className="flex justify-between font-semibold border-t pt-2">
            <span>Total income</span>
            <span>{formatCurrency(snapshot.profitAndLoss.incomeTotal)}</span>
          </div>
          <div className="font-medium pt-2">Expenses</div>
          {snapshot.profitAndLoss.expenses.map((row) => (
            <div key={row.code} className="flex justify-between">
              <span>{row.code} · {row.name}</span>
              <span>{formatCurrency(row.amount)}</span>
            </div>
          ))}
          <div className="flex justify-between font-semibold border-t pt-2">
            <span>Total expenses</span>
            <span>{formatCurrency(snapshot.profitAndLoss.expenseTotal)}</span>
          </div>
          <div className="flex justify-between font-semibold border-t pt-2">
            <span>Net profit</span>
            <span>{formatCurrency(snapshot.profitAndLoss.netProfit)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Balance Sheet</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <div className="font-medium">Assets</div>
          {snapshot.balanceSheet.assets.map((row) => (
            <div key={row.code} className="flex justify-between">
              <span>{row.code} · {row.name}</span>
              <span>{formatCurrency(row.balance)}</span>
            </div>
          ))}
          <div className="flex justify-between font-semibold border-t pt-2">
            <span>Total assets</span>
            <span>{formatCurrency(snapshot.balanceSheet.totals.assets)}</span>
          </div>
          <div className="font-medium pt-2">Liabilities</div>
          {snapshot.balanceSheet.liabilities.map((row) => (
            <div key={row.code} className="flex justify-between">
              <span>{row.code} · {row.name}</span>
              <span>{formatCurrency(row.balance)}</span>
            </div>
          ))}
          <div className="flex justify-between font-semibold border-t pt-2">
            <span>Total liabilities</span>
            <span>{formatCurrency(snapshot.balanceSheet.totals.liabilities)}</span>
          </div>
          <div className="font-medium pt-2">Equity</div>
          {snapshot.balanceSheet.equity.map((row) => (
            <div key={row.code} className="flex justify-between">
              <span>{row.code} · {row.name}</span>
              <span>{formatCurrency(row.balance)}</span>
            </div>
          ))}
          <div className="flex justify-between font-semibold border-t pt-2">
            <span>Total equity</span>
            <span>{formatCurrency(snapshot.balanceSheet.totals.equity)}</span>
          </div>
          <div className="flex justify-between font-semibold border-t pt-2">
            <span>Liabilities + Equity</span>
            <span>{formatCurrency(snapshot.balanceSheet.totals.liabilitiesPlusEquity)}</span>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
