"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";

type VatRow = {
  taxCodeId: string;
  name: string;
  rate: number;
  type: "OUTPUT" | "INPUT" | "EXEMPT" | "ZERO";
  baseTotal: number;
  vatTotal: number;
};

type VatResponse = {
  totals: VatRow[];
  summary: {
    outputVat: number;
    inputVat: number;
    netVat: number;
    outputBase: number;
    inputBase: number;
    exemptBase: number;
    zeroBase: number;
  };
};

type FiscalPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
};

export default function VatReportPage() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const hasUserEdited = useRef(false);

  const { data: periodsData } = useClientQuery<FiscalPeriod[]>({
    queryKey: ["accounting", "periods"],
    queryFn: () => fetch("/api/admin/accounting/periods").then((r) => r.json()),
  });
  const periods = useMemo(() => (Array.isArray(periodsData) ? periodsData : []), [periodsData]);
  const currentOpenPeriod = useMemo(() => {
    const today = new Date();
    return periods.find((period) => {
      if (period.status !== "OPEN") return false;
      const startDate = new Date(period.startDate);
      const endDate = new Date(period.endDate);
      return today >= startDate && today <= endDate;
    });
  }, [periods]);

  useEffect(() => {
    if (hasUserEdited.current) return;
    if (!currentOpenPeriod) return;
    setStart(currentOpenPeriod.startDate.slice(0, 10));
    setEnd(currentOpenPeriod.endDate.slice(0, 10));
  }, [currentOpenPeriod]);

  const { data, isLoading } = useClientQuery<VatResponse>({
    queryKey: ["accounting", "reports", "vat", { start, end }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      return fetch(`/api/admin/accounting/reports/vat?${params.toString()}`).then((r) => r.json());
    },
  });

  const totals = data?.totals || [];

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">VAT Report</h1>
        <p className="text-sm text-muted-foreground">Summarizes VAT by tax code for the period.</p>
        <p className="text-xs text-muted-foreground mt-1">
          {currentOpenPeriod
            ? `Current period: ${currentOpenPeriod.name}`
            : "No open fiscal period."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Input
            className="w-full sm:w-auto"
            type="date"
            value={start}
            onChange={(e) => {
              hasUserEdited.current = true;
              setStart(e.target.value);
            }}
          />
          <Input
            className="w-full sm:w-auto"
            type="date"
            value={end}
            onChange={(e) => {
              hasUserEdited.current = true;
              setEnd(e.target.value);
            }}
          />
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <a
              href={`/api/admin/accounting/reports/vat/export?${new URLSearchParams(
                start ? { start, ...(end ? { end } : {}) } : end ? { end } : {},
              ).toString()}`}
            >
              Export CSV
            </a>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <a
              href={`/api/admin/accounting/reports/vat/filing/export?${new URLSearchParams(
                start ? { start, ...(end ? { end } : {}) } : end ? { end } : {},
              ).toString()}`}
            >
              Filing pack CSV
            </a>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="text-sm grid gap-2 sm:grid-cols-2">
          <div className="flex justify-between">
            <span>Output VAT</span>
            <span>{formatCurrency(data?.summary?.outputVat || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span>Input VAT</span>
            <span>{formatCurrency(data?.summary?.inputVat || 0)}</span>
          </div>
          <div className="flex justify-between font-semibold">
            <span>Net VAT due</span>
            <span>{formatCurrency(data?.summary?.netVat || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span>Output taxable base</span>
            <span>{formatCurrency(data?.summary?.outputBase || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span>Input taxable base</span>
            <span>{formatCurrency(data?.summary?.inputBase || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span>Zero-rated base</span>
            <span>{formatCurrency(data?.summary?.zeroBase || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span>Exempt base</span>
            <span>{formatCurrency(data?.summary?.exemptBase || 0)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>VAT by tax code</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : totals.length === 0 ? (
            <p className="text-muted-foreground">No VAT activity for this period.</p>
          ) : (
            totals.map((row) => (
              <div key={row.taxCodeId} className="grid gap-1 border-b py-2 sm:grid-cols-2 lg:grid-cols-4">
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
