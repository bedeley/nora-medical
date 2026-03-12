"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/currency";
import { toast } from "sonner";

type AccountRow = {
  accountId: string;
  code: string;
  name: string;
  debit: number;
  credit: number;
};

type PLResponse = {
  income: AccountRow[];
  expenses: AccountRow[];
  incomeTotal: number;
  expenseTotal: number;
  netProfit: number;
};

type AppSettingResponse = { key: string; value: unknown };

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

function percentChange(current: number, prior: number) {
  if (Math.abs(prior) < 0.0001) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

function getYtdRange(end: string) {
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(endDate.getTime())) return null;
  return { start: `${endDate.getFullYear()}-01-01`, end };
}

function getPriorYtdRange(end: string) {
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(endDate.getTime())) return null;
  const priorEnd = new Date(endDate);
  priorEnd.setFullYear(priorEnd.getFullYear() - 1);
  return { start: `${priorEnd.getFullYear()}-01-01`, end: priorEnd.toISOString().slice(0, 10) };
}

export default function ProfitLossReportPage() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [useYtd, setUseYtd] = useState(false);
  const [varianceNote, setVarianceNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
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

  const effectiveRange = useMemo(() => {
    if (!useYtd) return { start, end };
    const fallbackEnd = end || new Date().toISOString().slice(0, 10);
    return getYtdRange(fallbackEnd) || { start, end };
  }, [useYtd, start, end]);

  const noteKey = `${effectiveRange.start || ""}|${effectiveRange.end || ""}`;

  const { data: notesData } = useClientQuery<AppSettingResponse>({
    queryKey: ["app-setting", "accounting.reports.pl.varianceNotes"],
    queryFn: () =>
      fetch("/api/admin/settings/app?key=accounting.reports.pl.varianceNotes").then((r) => r.json()),
  });

  const { data, isLoading } = useClientQuery<PLResponse>({
    queryKey: ["accounting", "reports", "pl", { start: effectiveRange.start, end: effectiveRange.end, useYtd }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (effectiveRange.start) params.set("start", effectiveRange.start);
      if (effectiveRange.end) params.set("end", effectiveRange.end);
      return fetch(`/api/admin/accounting/reports/pl?${params.toString()}`).then((r) => r.json());
    },
  });

  const previousRange = useMemo(() => {
    if (useYtd) {
      if (!effectiveRange.end) return null;
      return getPriorYtdRange(effectiveRange.end);
    }
    if (!effectiveRange.start || !effectiveRange.end) return null;
    return getPreviousRange(effectiveRange.start, effectiveRange.end);
  }, [effectiveRange.start, effectiveRange.end, useYtd]);

  const { data: previousData } = useClientQuery<PLResponse>({
    queryKey: ["accounting", "reports", "pl", "previous", previousRange?.start || "", previousRange?.end || ""],
    queryFn: () => {
      const params = new URLSearchParams();
      if (previousRange?.start) params.set("start", previousRange.start);
      if (previousRange?.end) params.set("end", previousRange.end);
      return fetch(`/api/admin/accounting/reports/pl?${params.toString()}`).then((r) => r.json());
    },
    enabled: Boolean(previousRange?.start && previousRange?.end),
  });

  const isClosedRange = useMemo(() => {
    if (!effectiveRange.start || !effectiveRange.end) return false;
    const startDate = new Date(`${effectiveRange.start}T00:00:00`);
    const endDate = new Date(`${effectiveRange.end}T23:59:59`);
    return periods.some((period) => {
      if (period.status !== "CLOSED") return false;
      const periodStart = new Date(period.startDate);
      const periodEnd = new Date(period.endDate);
      return startDate >= periodStart && endDate <= periodEnd;
    });
  }, [periods, effectiveRange.start, effectiveRange.end]);

  const income = data?.income || [];
  const expenses = data?.expenses || [];

  const query = new URLSearchParams(
    effectiveRange.start
      ? { start: effectiveRange.start, ...(effectiveRange.end ? { end: effectiveRange.end } : {}) }
      : effectiveRange.end
        ? { end: effectiveRange.end }
        : {},
  ).toString();

  const priorProfit = previousData?.netProfit || 0;
  const currentProfit = data?.netProfit || 0;
  const profitDelta = currentProfit - priorProfit;
  const profitChange = percentChange(currentProfit, priorProfit);
  const bigSwing = Math.abs(profitChange || 0) >= 10;
  const incomeTotal = data?.incomeTotal || 0;

  useEffect(() => {
    const map =
      notesData?.value && typeof notesData.value === "object" && !Array.isArray(notesData.value)
        ? (notesData.value as Record<string, string>)
        : {};
    setVarianceNote(map[noteKey] || "");
  }, [notesData?.value, noteKey]);

  const saveVarianceNote = async () => {
    try {
      setSavingNote(true);
      const currentMap =
        notesData?.value && typeof notesData.value === "object" && !Array.isArray(notesData.value)
          ? ({ ...(notesData.value as Record<string, string>) } as Record<string, string>)
          : {};
      if (varianceNote.trim()) currentMap[noteKey] = varianceNote.trim();
      else delete currentMap[noteKey];
      const res = await fetch("/api/admin/settings/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "accounting.reports.pl.varianceNotes",
          value: currentMap,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to save variance note.");
      toast.success("Variance note saved.");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save variance note.");
    } finally {
      setSavingNote(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Profit &amp; Loss</h1>
        <p className="text-sm text-muted-foreground">Accrual-based income statement.</p>
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
            <input type="checkbox" checked={useYtd} onChange={(e) => setUseYtd(e.target.checked)} />
            YTD
          </label>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <a href={`/api/admin/accounting/reports/pl/export?${query}`}>Export CSV</a>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <a href={`/api/admin/accounting/reports/pack/export?${query}`}>Export reporting pack</a>
          </Button>
          <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
            <Link href="/admin/accounting/periods">Open Fiscal Periods</Link>
          </Button>
        </CardContent>
      </Card>

      {bigSwing ? (
        <Card>
          <CardHeader>
            <CardTitle>Variance Note</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Net profit moved by {profitChange?.toFixed(2)}% versus prior comparison period. Add explanation.
            </p>
            <textarea
              className="w-full min-h-[84px] rounded-md border bg-background p-2 text-sm"
              value={varianceNote}
              onChange={(e) => setVarianceNote(e.target.value)}
              placeholder="Explain major movement (price, volume, one-off expense, etc.)"
            />
            <Button size="sm" variant="outline" onClick={saveVarianceNote} disabled={savingNote}>
              {savingNote ? "Saving..." : "Save note"}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Comparison</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Current net profit</div>
            <div className="font-semibold">{formatCurrency(currentProfit)}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Prior net profit</div>
            <div className="font-semibold">{formatCurrency(priorProfit)}</div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">Delta</div>
            <div className="font-semibold">
              {profitDelta >= 0 ? "+" : ""}
              {formatCurrency(profitDelta)}
            </div>
          </div>
          <div className="rounded border p-3">
            <div className="text-muted-foreground">% change</div>
            <div className="font-semibold">
              {profitChange === null ? "N/A (prior = 0)" : `${profitChange >= 0 ? "+" : ""}${profitChange.toFixed(2)}%`}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Income</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : income.length === 0 ? (
            <p className="text-muted-foreground">No income entries.</p>
          ) : (
            income.map((row) => (
              <div key={row.accountId} className="flex justify-between gap-2">
                <Link
                  className="underline underline-offset-2"
                  href={`/admin/accounting/journal?account=${encodeURIComponent(row.code)}${effectiveRange.start ? `&start=${encodeURIComponent(effectiveRange.start)}` : ""}${effectiveRange.end ? `&end=${encodeURIComponent(effectiveRange.end)}` : ""}`}
                >
                  {row.code} · {row.name}
                </Link>
                <span className="text-right">
                  {formatCurrency(row.credit - row.debit)}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {incomeTotal ? `${(((row.credit - row.debit) / incomeTotal) * 100).toFixed(1)}%` : "0.0%"}
                  </span>
                </span>
              </div>
            ))
          )}
          <div className="flex justify-between font-semibold pt-2 border-t">
            <span>Total income</span>
            <span>{formatCurrency(data?.incomeTotal || 0)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Expenses</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-1">
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : expenses.length === 0 ? (
            <p className="text-muted-foreground">No expense entries.</p>
          ) : (
            expenses.map((row) => (
              <div key={row.accountId} className="flex justify-between gap-2">
                <Link
                  className="underline underline-offset-2"
                  href={`/admin/accounting/journal?account=${encodeURIComponent(row.code)}${effectiveRange.start ? `&start=${encodeURIComponent(effectiveRange.start)}` : ""}${effectiveRange.end ? `&end=${encodeURIComponent(effectiveRange.end)}` : ""}`}
                >
                  {row.code} · {row.name}
                </Link>
                <span className="text-right">
                  {formatCurrency(row.debit - row.credit)}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {incomeTotal ? `${(((row.debit - row.credit) / incomeTotal) * 100).toFixed(1)}%` : "0.0%"}
                  </span>
                </span>
              </div>
            ))
          )}
          <div className="flex justify-between font-semibold pt-2 border-t">
            <span>Total expenses</span>
            <span>{formatCurrency(data?.expenseTotal || 0)}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Net Profit</CardTitle>
        </CardHeader>
        <CardContent className="text-lg font-semibold">{formatCurrency(currentProfit)}</CardContent>
      </Card>
    </section>
  );
}

