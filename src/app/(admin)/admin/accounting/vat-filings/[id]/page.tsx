"use client";

import { useParams } from "next/navigation";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/currency";

type VatFilingRun = {
  id: string;
  startDate: string;
  endDate: string;
  summary: {
    outputVat: number;
    inputVat: number;
    netVat: number;
    outputBase: number;
    inputBase: number;
    exemptBase: number;
    zeroBase: number;
  };
  details: {
    name: string;
    rate: number;
    type: string;
    baseTotal: number;
    vatTotal: number;
  }[];
  createdAt: string;
};

export default function VatFilingRunPage() {
  const params = useParams();
  const runId = String((params as { id?: string }).id || "");
  const { data, isLoading } = useClientQuery<VatFilingRun>({
    queryKey: ["accounting", "vat-filings", runId],
    queryFn: () => fetch(`/api/admin/accounting/vat-filings/${runId}`).then((r) => r.json()),
    enabled: Boolean(runId),
  });

  if (isLoading) {
    return (
      <section className="container mx-auto py-8">
        <p className="text-sm text-muted-foreground">Loading VAT filing run...</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="container mx-auto py-8">
        <p className="text-sm text-muted-foreground">VAT filing run not found.</p>
      </section>
    );
  }

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">VAT Filing Run</h1>
        <p className="text-sm text-muted-foreground">
          {new Date(data.startDate).toLocaleDateString()} - {new Date(data.endDate).toLocaleDateString()}
        </p>
        <p className="text-xs text-muted-foreground">
          Created {new Date(data.createdAt).toLocaleString()}
        </p>
        <div className="mt-2">
          <Button asChild size="sm" variant="outline">
            <a href={`/api/admin/accounting/vat-filings/${data.id}/export`}>
              Export CSV
            </a>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <div className="flex justify-between">
            <span>Output VAT</span>
            <span>{formatCurrency(data.summary.outputVat)}</span>
          </div>
          <div className="flex justify-between">
            <span>Input VAT</span>
            <span>{formatCurrency(data.summary.inputVat)}</span>
          </div>
          <div className="flex justify-between font-semibold">
            <span>Net VAT</span>
            <span>{formatCurrency(data.summary.netVat)}</span>
          </div>
          <div className="flex justify-between">
            <span>Output taxable base</span>
            <span>{formatCurrency(data.summary.outputBase)}</span>
          </div>
          <div className="flex justify-between">
            <span>Input taxable base</span>
            <span>{formatCurrency(data.summary.inputBase)}</span>
          </div>
          <div className="flex justify-between">
            <span>Zero-rated base</span>
            <span>{formatCurrency(data.summary.zeroBase)}</span>
          </div>
          <div className="flex justify-between">
            <span>Exempt base</span>
            <span>{formatCurrency(data.summary.exemptBase)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>VAT by tax code</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {data.details.length === 0 ? (
            <p className="text-muted-foreground">No VAT detail rows.</p>
          ) : (
            data.details.map((row) => (
              <div key={`${row.name}-${row.rate}`} className="grid gap-1 border-b py-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="font-medium">
                  {row.name} ({row.rate.toFixed(2)}%)
                </div>
                <div className="text-muted-foreground">{row.type}</div>
                <div className="flex justify-between lg:block">
                  <span className="text-muted-foreground">Base</span>{" "}
                  <span>{formatCurrency(row.baseTotal)}</span>
                </div>
                <div className="flex justify-between lg:block">
                  <span className="text-muted-foreground">VAT</span>{" "}
                  <span>{formatCurrency(row.vatTotal)}</span>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </section>
  );
}
