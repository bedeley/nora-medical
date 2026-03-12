"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/currency";

type Account = {
  id: string;
  code: string;
  name: string;
  type: string;
};

type ValuationRow = {
  id: string;
  name: string;
  sku: string | null;
  stock: number;
  cost: number;
  value: number;
};

type InventoryValuationResponse = {
  asOf: string;
  inventoryAccount: { code: string; name: string } | null;
  ledgerBalance: number;
  valuationTotal: number;
  delta: number;
  items: ValuationRow[];
};

export default function InventoryValuationPage() {
  const queryClient = useQueryClient();
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [offsetCode, setOffsetCode] = useState("");
  const [search, setSearch] = useState("");
  const [posting, setPosting] = useState(false);

  const params = useMemo(() => {
    const sp = new URLSearchParams();
    if (asOf) sp.set("asOf", asOf);
    return sp.toString();
  }, [asOf]);

  const { data } = useClientQuery<InventoryValuationResponse>({
    queryKey: ["accounting", "inventory-valuation", params],
    queryFn: () => fetch(`/api/admin/accounting/inventory-valuation?${params}`).then((r) => r.json()),
  });

  const { data: accountsData } = useClientQuery<Account[]>({
    queryKey: ["accounting", "accounts"],
    queryFn: () => fetch("/api/admin/accounting/accounts").then((r) => r.json()),
  });

  const expenseAccounts = (accountsData || []).filter((a) => a.type === "EXPENSE");
  const resolvedOffset = offsetCode;

  const items = useMemo(() => {
    const rows = Array.isArray(data?.items) ? data!.items : [];
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    return rows.filter((row) =>
      row.name.toLowerCase().includes(q) || (row.sku || "").toLowerCase().includes(q)
    );
  }, [data, search]);

  const postAdjustment = async () => {
    if (!asOf) {
      toast.error("Select an as-of date.");
      return;
    }
    if (!resolvedOffset) {
      toast.error("Select an offset account.");
      return;
    }
    try {
      setPosting(true);
      const res = await fetch("/api/admin/accounting/inventory-valuation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ asOf, offsetAccountCode: resolvedOffset }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || "Failed to post adjustment");
      toast.success("Inventory adjustment posted.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "inventory-valuation"] });
      queryClient.invalidateQueries({ queryKey: ["accounting", "reports", "overview"] });
      queryClient.invalidateQueries({ queryKey: ["accounting", "integrity"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to post adjustment.");
    } finally {
      setPosting(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Inventory Valuation &amp; Variance</h1>
        <p className="text-sm text-muted-foreground">
          Compare inventory ledger balance to stock valuation and post adjustments when needed.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">As of date</span>
            <Input className="w-full sm:w-auto" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Search</span>
            <Input
              className="w-full sm:w-auto"
              placeholder="Product name or SKU"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Inventory ledger</div>
            <div className="text-lg font-semibold">{formatCurrency(data?.ledgerBalance ?? 0)}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Stock valuation</div>
            <div className="text-lg font-semibold">{formatCurrency(data?.valuationTotal ?? 0)}</div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Variance</div>
            <div className={`text-lg font-semibold ${(data?.delta || 0) !== 0 ? "text-amber-700" : ""}`}>
              {formatCurrency(data?.delta ?? 0)}
            </div>
          </div>
          <div className="rounded-md border px-3 py-2">
            <div className="text-xs text-muted-foreground">Inventory account</div>
            <div className="text-sm font-medium">
              {data?.inventoryAccount ? `${data.inventoryAccount.code} · ${data.inventoryAccount.name}` : "—"}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Post adjustment</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Offset account</span>
            <select
              className="h-10 w-full sm:w-auto rounded-md border bg-background px-3 text-sm"
              value={resolvedOffset}
              onChange={(e) => setOffsetCode(e.target.value)}
            >
              <option value="" disabled>
                Select offset account
              </option>
              {expenseAccounts.map((acct) => (
                <option key={acct.id} value={acct.code}>
                  {acct.code} · {acct.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            className="w-full sm:w-auto"
            onClick={postAdjustment}
            disabled={posting || Math.abs(Number(data?.delta || 0)) < 0.01}
          >
            {posting ? "Posting..." : "Post adjustment"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Posts a journal entry to align the ledger with valuation as of the selected date.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Valuation detail</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {items.length === 0 ? (
            <div className="text-sm text-muted-foreground">No inventory found.</div>
          ) : (
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-3">Product</th>
                  <th className="py-2 pr-3 text-right">Stock</th>
                  <th className="py-2 pr-3 text-right">Cost</th>
                  <th className="py-2 pr-3 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <div>{row.name}</div>
                      <div className="text-xs text-muted-foreground">{row.sku || "No SKU"}</div>
                    </td>
                    <td className="py-2 pr-3 text-right">{row.stock}</td>
                    <td className="py-2 pr-3 text-right">{formatCurrency(row.cost)}</td>
                    <td className="py-2 pr-3 text-right">{formatCurrency(row.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
