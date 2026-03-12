"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/currency";

type AccountRow = {
  accountId: string;
  code: string;
  name: string;
  openingDebit: number;
  openingCredit: number;
  movementDebit: number;
  movementCredit: number;
  closingDebit: number;
  closingCredit: number;
  unusualBalance: boolean;
  patternSeverity?: "FLAG" | "INFO" | "NONE";
  patternNote?: string | null;
  type: string;
};

type TrialBalanceResponse = {
  totals: AccountRow[];
  summary: {
    openingDebit: number;
    openingCredit: number;
    movementDebit: number;
    movementCredit: number;
    closingDebit: number;
    closingCredit: number;
  };
};

type FiscalPeriod = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
};

function getPreviousRange(start: string, end: string) {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  if (endDate.getTime() < startDate.getTime()) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  const spanDays = Math.floor((endDate.getTime() - startDate.getTime()) / dayMs) + 1;
  const prevEnd = new Date(startDate.getTime() - dayMs);
  const prevStart = new Date(prevEnd.getTime() - (spanDays - 1) * dayMs);
  return { start: prevStart.toISOString().slice(0, 10), end: prevEnd.toISOString().slice(0, 10) };
}

export default function TrialBalancePage() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [includeZero, setIncludeZero] = useState(false);
  const [selectedPatternRow, setSelectedPatternRow] = useState<AccountRow | null>(null);
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

  const { data, isLoading } = useClientQuery<TrialBalanceResponse>({
    queryKey: ["accounting", "reports", "trial-balance", { start, end, includeZero }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      if (includeZero) params.set("includeZero", "1");
      return fetch(`/api/admin/accounting/reports/trial-balance?${params.toString()}`).then((r) => r.json());
    },
  });

  const previousRange = useMemo(() => {
    if (!start || !end) return null;
    return getPreviousRange(start, end);
  }, [start, end]);
  const { data: previousData } = useClientQuery<TrialBalanceResponse>({
    queryKey: [
      "accounting",
      "reports",
      "trial-balance",
      "previous",
      previousRange?.start || "",
      previousRange?.end || "",
      includeZero ? "z1" : "z0",
    ],
    queryFn: () => {
      const params = new URLSearchParams();
      if (previousRange?.start) params.set("start", previousRange.start);
      if (previousRange?.end) params.set("end", previousRange.end);
      if (includeZero) params.set("includeZero", "1");
      return fetch(`/api/admin/accounting/reports/trial-balance?${params.toString()}`).then((r) => r.json());
    },
    enabled: Boolean(previousRange?.start && previousRange?.end),
  });

  const isClosedRange = useMemo(() => {
    if (!start || !end) return false;
    const startDate = new Date(`${start}T00:00:00`);
    const endDate = new Date(`${end}T23:59:59`);
    return periods.some((period) => {
      if (period.status !== "CLOSED") return false;
      const periodStart = new Date(period.startDate);
      const periodEnd = new Date(period.endDate);
      return startDate >= periodStart && endDate <= periodEnd;
    });
  }, [periods, start, end]);

  const query = new URLSearchParams(
    start ? { start, ...(end ? { end } : {}) } : end ? { end } : {},
  ).toString();
  const currentDebit = data?.summary?.closingDebit || 0;
  const priorDebit = previousData?.summary?.closingDebit || 0;
  const debitDelta = currentDebit - priorDebit;
  const outOfPatternCount = (data?.totals || []).filter((row) => row.patternSeverity === "FLAG").length;
  const infoPatternCount = (data?.totals || []).filter((row) => row.patternSeverity === "INFO").length;
  const selectedQuery = new URLSearchParams({
    account: selectedPatternRow?.code || "",
    status: "POSTED",
    entryDir:
      selectedPatternRow && (selectedPatternRow.type === "ASSET" || selectedPatternRow.type === "EXPENSE")
        ? "credit"
        : "debit",
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  }).toString();

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Trial Balance</h1>
        <p className="text-sm text-muted-foreground">Debits and credits by account.</p>
        <p className="text-xs text-muted-foreground mt-1">
          {currentOpenPeriod ? `Current period: ${currentOpenPeriod.name}` : "No open fiscal period."}
        </p>
        {!isClosedRange ? (
          <p className="text-xs text-amber-700 mt-1">
            Period not closed. Results can still change as entries are posted/edited.
          </p>
        ) : null}
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
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} />
            Include zero-balance accounts
          </label>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <a href={`/api/admin/accounting/reports/trial-balance/export?${query}${query ? "&" : ""}${includeZero ? "includeZero=1" : ""}`}>Export CSV</a>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <a href={`/api/admin/accounting/reports/pack/export?${query}`}>Export reporting pack</a>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <Link href="/admin/accounting/periods">Open Fiscal Periods</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Comparison</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Current closing debits</div>
            <div className="font-semibold">{formatCurrency(currentDebit)}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Prior closing debits</div>
            <div className="font-semibold">{formatCurrency(priorDebit)}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Delta</div>
            <div className="font-semibold">{debitDelta >= 0 ? "+" : ""}{formatCurrency(debitDelta)}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Out-of-pattern balances</div>
            <div className="font-semibold">{outOfPatternCount}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Expected exceptions</div>
            <div className="font-semibold">{infoPatternCount}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[1200px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Pattern</TableHead>
                    <TableHead className="text-right">Opening Dr</TableHead>
                    <TableHead className="text-right">Opening Cr</TableHead>
                    <TableHead className="text-right">Movement Dr</TableHead>
                    <TableHead className="text-right">Movement Cr</TableHead>
                    <TableHead className="text-right">Closing Dr</TableHead>
                    <TableHead className="text-right">Closing Cr</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.totals || []).map((row) => (
                    <TableRow
                      key={row.accountId}
                      className={
                        row.patternSeverity === "FLAG"
                          ? "bg-amber-50"
                          : row.patternSeverity === "INFO"
                            ? "bg-blue-50"
                            : undefined
                      }
                    >
                      <TableCell className="font-mono">{row.code}</TableCell>
                      <TableCell>
                        <Link
                          className="underline underline-offset-2"
                          href={`/admin/accounting/journal?account=${encodeURIComponent(row.code)}${start ? `&start=${encodeURIComponent(start)}` : ""}${end ? `&end=${encodeURIComponent(end)}` : ""}`}
                        >
                          {row.name}
                        </Link>
                      </TableCell>
                      <TableCell>{row.type}</TableCell>
                      <TableCell>
                        {row.patternSeverity === "FLAG" ? (
                          <button
                            type="button"
                            className="text-amber-800 font-medium underline underline-offset-2"
                            onClick={() => setSelectedPatternRow(row)}
                          >
                            Flag
                          </button>
                        ) : row.patternSeverity === "INFO" ? (
                          <button
                            type="button"
                            className="text-blue-800 underline underline-offset-2"
                            onClick={() => setSelectedPatternRow(row)}
                          >
                            Info
                          </button>
                        ) : (
                          <span className="text-muted-foreground">Normal</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{formatCurrency(row.openingDebit)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(row.openingCredit)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(row.movementDebit)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(row.movementCredit)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(row.closingDebit)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(row.closingCredit)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm font-semibold sm:grid-cols-2 lg:grid-cols-4">
          <span>Opening totals (Dr/Cr)</span>
          <span>
            {formatCurrency(data?.summary?.openingDebit || 0)} / {formatCurrency(data?.summary?.openingCredit || 0)}
          </span>
          <span>Movement totals (Dr/Cr)</span>
          <span>
            {formatCurrency(data?.summary?.movementDebit || 0)} / {formatCurrency(data?.summary?.movementCredit || 0)}
          </span>
          <span>Closing totals (Dr/Cr)</span>
          <span>
            {formatCurrency(data?.summary?.closingDebit || 0)} / {formatCurrency(data?.summary?.closingCredit || 0)}
          </span>
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedPatternRow)} onOpenChange={(open) => (!open ? setSelectedPatternRow(null) : null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Pattern details</DialogTitle>
          </DialogHeader>
          {selectedPatternRow ? (
            <div className="space-y-3 text-sm">
              <div>
                <div className="font-medium">
                  {selectedPatternRow.code} · {selectedPatternRow.name}
                </div>
                <div className="text-muted-foreground">Type: {selectedPatternRow.type}</div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs uppercase text-muted-foreground mb-1">Classification</div>
                <div className="font-medium">
                  {selectedPatternRow.patternSeverity === "FLAG" ? "Flag (needs review)" : "Info (expected exception)"}
                </div>
                <div className="text-muted-foreground mt-1">{selectedPatternRow.patternNote || "No additional note."}</div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs uppercase text-muted-foreground mb-1">Recommended checks</div>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Review latest journal lines for this account in selected range.</li>
                  <li>Confirm posting rules and source documents are correct.</li>
                  <li>Confirm reconciliation status where applicable.</li>
                </ul>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/admin/accounting/journal?${selectedQuery}`}>Open Journal (filtered)</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/admin/accounting/reconciliations">Open Reconciliations</Link>
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}

