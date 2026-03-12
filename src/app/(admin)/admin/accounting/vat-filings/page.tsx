"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";

type VatFilingRun = {
  id: string;
  startDate: string;
  endDate: string;
  summary: {
    outputVat: number;
    inputVat: number;
    netVat: number;
  };
  createdAt: string;
};

export default function VatFilingsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useClientQuery<VatFilingRun[]>({
    queryKey: ["accounting", "vat-filings"],
    queryFn: () => fetch("/api/admin/accounting/vat-filings").then((r) => r.json()),
  });
  const runs = Array.isArray(data) ? data : [];

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [saving, setSaving] = useState(false);

  const createRun = async () => {
    if (!startDate || !endDate) {
      toast.error("Select start and end dates.");
      return;
    }
    try {
      setSaving(true);
      const res = await fetch("/api/admin/accounting/vat-filings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to create filing run.");
      toast.success("VAT filing run saved.");
      queryClient.invalidateQueries({ queryKey: ["accounting", "vat-filings"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create filing run.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">VAT Filing Runs</h1>
        <p className="text-sm text-muted-foreground">
          Save VAT filing snapshots for audit and review.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create filing run</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Input className="w-full sm:w-auto" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <Input className="w-full sm:w-auto" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          <Button className="w-full sm:w-auto" onClick={createRun} disabled={saving}>
            {saving ? "Saving..." : "Save filing run"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          {isLoading ? (
            <p className="text-muted-foreground">Loading filings...</p>
          ) : runs.length === 0 ? (
            <p className="text-muted-foreground">No filing runs yet.</p>
          ) : (
            runs.map((run) => (
              <div key={run.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2">
                <div>
                  <div className="font-medium">
                    {new Date(run.startDate).toLocaleDateString()} - {new Date(run.endDate).toLocaleDateString()}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Created {new Date(run.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">Net VAT</div>
                    <div className="font-medium">{formatCurrency(run.summary?.netVat || 0)}</div>
                  </div>
                  <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
                    <a href={`/admin/accounting/vat-filings/${run.id}`}>View</a>
                  </Button>
                  <Button asChild size="sm" variant="ghost" className="w-full sm:w-auto">
                    <a href={`/api/admin/accounting/vat-filings/${run.id}/export`}>Export</a>
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </section>
  );
}
