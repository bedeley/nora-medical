"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchJsonOrThrow } from "@/lib/app-settings-client";

type PlanSummary = {
  id: string;
  name: string;
  supplier?: string | null;
  available: number;
  planSource: "manual" | "auto";
  demand: {
    unitsSold: number;
    avgDailyDemand: string;
  } | null;
  effectivePlan: {
    reorderPoint: number;
  };
  suggestion: {
    suggestedQty: number;
  } | null;
};

type PlanningResponse = {
  rows: PlanSummary[];
  meta?: {
    lastRecomputeAt?: string | null;
  } | null;
};

function formatNumber(value: number, maximumFractionDigits = 0) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
}

function formatDateTime(value?: string | null) {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Unknown";
  return parsed.toLocaleString();
}

export default function InventoryPlanningReportsPage() {
  const { data, error, isLoading, refetch } = useClientQuery<PlanningResponse>({
    queryKey: ["inventory-planning", "reports"],
    queryFn: async () => {
      const res = await fetch("/api/admin/inventory-planning", { cache: "no-store" });
      return fetchJsonOrThrow<PlanningResponse>(res, "Failed to load inventory planning reports.");
    },
  });

  const rows = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data?.rows]);
  const report = useMemo(() => {
    const coverageBuckets = {
      critical: 0,
      watch: 0,
      comfortable: 0,
      noDemand: 0,
    };
    const supplierRisk = new Map<string, { belowReorder: number; suggestions: number; products: number }>();
    const suggestionRows: Array<{ id: string; name: string; supplier: string; suggestedQty: number; available: number }> = [];

    for (const row of rows) {
      const avgDailyDemand = row.demand ? Number(row.demand.avgDailyDemand) : 0;
      const daysOfCover = avgDailyDemand > 0 ? Math.max(0, row.available) / avgDailyDemand : null;
      if (daysOfCover == null) {
        coverageBuckets.noDemand += 1;
      } else if (daysOfCover < 7) {
        coverageBuckets.critical += 1;
      } else if (daysOfCover < 14) {
        coverageBuckets.watch += 1;
      } else {
        coverageBuckets.comfortable += 1;
      }

      const supplierName = row.supplier || "Unassigned supplier";
      const supplierEntry = supplierRisk.get(supplierName) || {
        belowReorder: 0,
        suggestions: 0,
        products: 0,
      };
      supplierEntry.products += 1;
      if (row.available <= row.effectivePlan.reorderPoint) {
        supplierEntry.belowReorder += 1;
      }
      if (row.suggestion?.suggestedQty) {
        supplierEntry.suggestions += 1;
        suggestionRows.push({
          id: row.id,
          name: row.name,
          supplier: supplierName,
          suggestedQty: row.suggestion.suggestedQty,
          available: row.available,
        });
      }
      supplierRisk.set(supplierName, supplierEntry);
    }

    return {
      totalProducts: rows.length,
      manualPlans: rows.filter((row) => row.planSource === "manual").length,
      openSuggestions: rows.filter((row) => Boolean(row.suggestion?.suggestedQty)).length,
      withoutDemand: rows.filter((row) => !row.demand).length,
      coverageBuckets,
      topSuppliers: Array.from(supplierRisk.entries())
        .sort((left, right) => {
          if (right[1].belowReorder !== left[1].belowReorder) {
            return right[1].belowReorder - left[1].belowReorder;
          }
          return right[1].suggestions - left[1].suggestions;
        })
        .slice(0, 6),
      suggestionRows: suggestionRows
        .sort((left, right) => right.suggestedQty - left.suggestedQty)
        .slice(0, 8),
    };
  }, [rows]);

  return (
    <section className="container mx-auto space-y-6 py-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Inventory Planning Reports</h1>
          <p className="text-sm text-muted-foreground">
            Coverage distribution, supplier exposure, and suggestion workload from the current planning snapshot.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="outline">Last recompute: {formatDateTime(data?.meta?.lastRecomputeAt)}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/api/admin/inventory-planning/export?scope=all">Export snapshot CSV</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/api/admin/inventory-planning/export?scope=suggestions">Export suggestion CSV</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/inventory-planning">Back to planning</Link>
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          Loading planning reports...
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm">
          <div className="font-medium text-destructive">Planning reports could not be loaded.</div>
          <p className="mt-2 text-muted-foreground">
            {error instanceof Error ? error.message : "Unknown error."}
          </p>
          <Button className="mt-4" variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardHeader>
                <CardTitle>Products</CardTitle>
              </CardHeader>
              <CardContent className="text-3xl font-semibold">
                {formatNumber(report.totalProducts)}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Open Suggestions</CardTitle>
              </CardHeader>
              <CardContent className="text-3xl font-semibold">
                {formatNumber(report.openSuggestions)}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Manual Plans</CardTitle>
              </CardHeader>
              <CardContent className="text-3xl font-semibold">
                {formatNumber(report.manualPlans)}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>No Demand Data</CardTitle>
              </CardHeader>
              <CardContent className="text-3xl font-semibold">
                {formatNumber(report.withoutDemand)}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
            <Card>
              <CardHeader>
                <CardTitle>Coverage Distribution</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {[
                  { label: "Critical (< 7 days)", value: report.coverageBuckets.critical, tone: "bg-red-500" },
                  { label: "Watch (7-14 days)", value: report.coverageBuckets.watch, tone: "bg-amber-500" },
                  { label: "Comfortable (14+ days)", value: report.coverageBuckets.comfortable, tone: "bg-emerald-500" },
                  { label: "No demand snapshot", value: report.coverageBuckets.noDemand, tone: "bg-slate-400" },
                ].map((bucket) => {
                  const width = report.totalProducts > 0 ? (bucket.value / report.totalProducts) * 100 : 0;
                  return (
                    <div key={bucket.label} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span>{bucket.label}</span>
                        <span className="font-medium">{formatNumber(bucket.value)}</span>
                      </div>
                      <div className="h-2 rounded-full bg-muted">
                        <div
                          className={`h-2 rounded-full ${bucket.tone}`}
                          style={{ width: `${Math.max(width, bucket.value > 0 ? 6 : 0)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Supplier Exposure</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {report.topSuppliers.length ? (
                  report.topSuppliers.map(([supplier, stats]) => (
                    <div key={supplier} className="rounded-lg border p-3">
                      <div className="font-medium">{supplier}</div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <span>{formatNumber(stats.products)} tracked</span>
                        <span>{formatNumber(stats.belowReorder)} below reorder</span>
                        <span>{formatNumber(stats.suggestions)} suggestions</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground">No supplier exposure data available.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Largest Suggestions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {report.suggestionRows.length ? (
                  report.suggestionRows.map((row) => (
                    <div key={row.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                      <div>
                        <div className="font-medium">{row.name}</div>
                        <div className="text-xs text-muted-foreground">{row.supplier}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-semibold">{formatNumber(row.suggestedQty)}</div>
                        <div className="text-xs text-muted-foreground">
                          Available {formatNumber(row.available)}
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground">No active suggestions in the current snapshot.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Next Improvements</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>
                  This reports page now provides real coverage and workload reporting, but historical trend analysis still needs a dedicated demand-history view or chart layer.
                </p>
                <p>
                  If you want the next iteration, the highest-value additions would be demand trend deltas across snapshots and supplier lead-time reliability over time.
                </p>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </section>
  );
}
