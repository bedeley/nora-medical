"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpDown } from "lucide-react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchAppSetting, fetchJsonOrThrow, saveAppSetting } from "@/lib/app-settings-client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const INVENTORY_PLANNING_SOURCE_PAGE = "admin/inventory-planning";
const inventoryPlanningAuditHref = `/admin/audit?sourcePage=${encodeURIComponent(INVENTORY_PLANNING_SOURCE_PAGE)}`;

type PlanSummary = {
  id: string;
  name: string;
  sku?: string | null;
  category?: string | null;
  supplier?: string | null;
  stock: number;
  reserved: number;
  onOrder: number;
  available: number;
  plan: {
    reorderPoint: number;
    fallbackReorderPoint?: number | null;
    safetyStock: number;
    leadTimeDays: number;
    reviewPeriodDays: number;
    minOrderQty: number;
    approvalThresholdQty?: number | null;
    targetStock: number;
  } | null;
  effectivePlan: {
    reorderPoint: number;
    safetyStock: number;
    leadTimeDays: number;
    reviewPeriodDays: number;
    minOrderQty: number;
    approvalThresholdQty?: number | null;
    targetStock: number;
  };
  planSource: "manual" | "auto";
  demand: {
    periodStart: string;
    periodEnd: string;
    capturedAt: string;
    unitsSold: number;
    avgDailyDemand: string;
  } | null;
  suggestion: {
    id: string | null;
    suggestedQty: number;
    reason?: string | null;
    createdAt: string | null;
  } | null;
};

type PlanningResponse = {
  rows: PlanSummary[];
  meta?: {
    generatedAt?: string | null;
    lastRecomputeAt?: string | null;
    lastRecomputeMode?: string | null;
  } | null;
};

type SortKey =
  | "name"
  | "available"
  | "avgDailyDemand"
  | "daysOfCover"
  | "reorderPoint"
  | "suggestedQty";
type QuickFilter = "all" | "needs-reorder" | "suggested" | "manual" | "no-demand";

function formatDateTime(value?: string | null) {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Unknown";
  return parsed.toLocaleString();
}

function formatNumber(value: number, maximumFractionDigits = 0) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
}

function formatDaysOfCover(value: number | null) {
  if (value == null) return "No demand";
  if (value >= 999) return "999+d";
  return `${value.toFixed(value >= 10 ? 0 : 1)}d`;
}

function getCoverageTone(value: number | null) {
  if (value == null) {
    return { label: "No demand", variant: "outline" as const };
  }
  if (value < 7) {
    return { label: "Critical", variant: "destructive" as const };
  }
  if (value < 14) {
    return { label: "Watch", variant: "warning" as const };
  }
  return { label: "Comfortable", variant: "success" as const };
}

export default function InventoryPlanningPage() {
  const queryClient = useQueryClient();
  const { data: session, status: sessionStatus } = useSession();
  const role = String(session?.user?.role || "");
  const canManagePlanning = role === "ADMIN" || role === "ACCOUNTANT";
  const canEditPlans = role === "ADMIN";
  const canCreatePurchases = role === "ADMIN";

  const [query, setQuery] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("suggestedQty");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25);
  const [autoRecompute, setAutoRecompute] = useState<"off" | "daily" | "weekly">("off");
  const [defaultReorderPoint, setDefaultReorderPoint] = useState("10");
  const [savingAuto, setSavingAuto] = useState(false);
  const [savingDefaultReorder, setSavingDefaultReorder] = useState(false);
  const [recomputeBusy, setRecomputeBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDismissBusy, setBulkDismissBusy] = useState(false);

  const {
    data,
    error,
    isLoading,
    refetch,
  } = useClientQuery<PlanningResponse>({
    queryKey: ["inventory-planning"],
    queryFn: async () => {
      const res = await fetch("/api/admin/inventory-planning", { cache: "no-store" });
      return fetchJsonOrThrow<PlanningResponse>(res, "Failed to load inventory planning.");
    },
  });
  const autoSettingQuery = useClientQuery<{ value?: unknown }>({
    queryKey: ["app-setting", "inventoryPlanning.autoRecompute"],
    queryFn: () => fetchAppSetting<string>("inventoryPlanning.autoRecompute"),
    enabled: sessionStatus !== "loading" && canManagePlanning,
  });
  const defaultReorderSettingQuery = useClientQuery<{ value?: unknown }>({
    queryKey: ["app-setting", "inventoryPlanning.defaultReorderPoint"],
    queryFn: () => fetchAppSetting<number>("inventoryPlanning.defaultReorderPoint"),
    enabled: sessionStatus !== "loading" && canManagePlanning,
  });

  useEffect(() => {
    const value = typeof autoSettingQuery.data?.value === "string" ? autoSettingQuery.data.value : "";
    if (value === "off" || value === "daily" || value === "weekly") {
      setAutoRecompute(value);
    }
  }, [autoSettingQuery.data?.value]);

  useEffect(() => {
    const value = defaultReorderSettingQuery.data?.value;
    if (typeof value === "number" && Number.isFinite(value)) {
      setDefaultReorderPoint(String(value));
    }
  }, [defaultReorderSettingQuery.data?.value]);

  const rows = useMemo(() => (Array.isArray(data?.rows) ? data?.rows : []), [data?.rows]);
  const enrichedRows = useMemo(() => {
    return rows.map((row) => {
      const avgDailyDemand = row.demand ? Number(row.demand.avgDailyDemand) : 0;
      const daysOfCover = avgDailyDemand > 0 ? Math.max(0, row.available) / avgDailyDemand : null;
      const needsReorder = row.available <= row.effectivePlan.reorderPoint;
      const hasSuggestion = Boolean(row.suggestion?.suggestedQty);
      const hasSavedSuggestion = Boolean(row.suggestion?.id);
      const isSuggestionStale = hasSuggestion && !needsReorder;
      return {
        ...row,
        avgDailyDemand,
        daysOfCover,
        needsReorder,
        hasSuggestion,
        hasSavedSuggestion,
        isSuggestionStale,
      };
    });
  }, [rows]);

  const summary = useMemo(() => {
    return {
      totalProducts: enrichedRows.length,
      belowReorder: enrichedRows.filter((row) => row.needsReorder).length,
      suggestions: enrichedRows.filter((row) => row.hasSuggestion).length,
      noDemand: enrichedRows.filter((row) => !row.demand).length,
      manualPlans: enrichedRows.filter((row) => row.planSource === "manual").length,
    };
  }, [enrichedRows]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    const visibleRows = enrichedRows
      .filter((row) => {
        if (!term) return true;
        return (
          row.name.toLowerCase().includes(term) ||
          (row.sku || "").toLowerCase().includes(term) ||
          (row.category || "").toLowerCase().includes(term) ||
          (row.supplier || "").toLowerCase().includes(term)
        );
      })
      .filter((row) => {
        if (quickFilter === "all") return true;
        if (quickFilter === "needs-reorder") return row.needsReorder;
        if (quickFilter === "suggested") return row.hasSuggestion;
        if (quickFilter === "manual") return row.planSource === "manual";
        if (quickFilter === "no-demand") return !row.demand;
        return true;
      })
      .sort((left, right) => {
        const direction = sortDir === "asc" ? 1 : -1;
        if (sortKey === "name") {
          return left.name.localeCompare(right.name) * direction;
        }
        if (sortKey === "available") {
          return (left.available - right.available) * direction;
        }
        if (sortKey === "avgDailyDemand") {
          return (left.avgDailyDemand - right.avgDailyDemand) * direction;
        }
        if (sortKey === "daysOfCover") {
          return ((left.daysOfCover ?? -1) - (right.daysOfCover ?? -1)) * direction;
        }
        if (sortKey === "reorderPoint") {
          return (left.effectivePlan.reorderPoint - right.effectivePlan.reorderPoint) * direction;
        }
        return ((left.suggestion?.suggestedQty ?? 0) - (right.suggestion?.suggestedQty ?? 0)) * direction;
      });
    return visibleRows;
  }, [enrichedRows, query, quickFilter, sortDir, sortKey]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pagedRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, page, pageSize]);
  const selectedSavedSuggestionRows = useMemo(
    () =>
      enrichedRows.filter(
        (row) => selectedIds.has(row.id) && Boolean(row.suggestion?.id),
      ),
    [enrichedRows, selectedIds],
  );
  const allVisibleSelected =
    pagedRows.length > 0 && pagedRows.every((row) => selectedIds.has(row.id));

  const lastRecomputeLabel = useMemo(() => {
    return formatDateTime(data?.meta?.lastRecomputeAt ?? null);
  }, [data?.meta?.lastRecomputeAt]);
  const lastRecomputeMode = String(data?.meta?.lastRecomputeMode || "").trim().toLowerCase();
  const scheduledRunStatus = useMemo(() => {
    if (autoRecompute === "off") {
      return "Auto recompute is off.";
    }
    if (lastRecomputeMode === "cron") {
      return `Auto recompute is enabled and the last recorded run came from cron on ${lastRecomputeLabel}.`;
    }
    if (data?.meta?.lastRecomputeAt) {
      return "Auto recompute is enabled, but the last recorded run was manual. Cron has not recorded a successful run yet.";
    }
    return "Auto recompute is enabled, but no successful run has been recorded yet.";
  }, [autoRecompute, data?.meta?.lastRecomputeAt, lastRecomputeLabel, lastRecomputeMode]);

  const settingsError = autoSettingQuery.error || defaultReorderSettingQuery.error;
  const settingsReady =
    canManagePlanning &&
    !autoSettingQuery.isLoading &&
    !defaultReorderSettingQuery.isLoading &&
    !settingsError;

  useEffect(() => {
    setPage(1);
  }, [query, quickFilter, sortDir, sortKey, pageSize]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  useEffect(() => {
    setSelectedIds((current) => {
      const next = new Set(
        Array.from(current).filter((id) => rows.some((row) => row.id === id)),
      );
      return next.size === current.size ? current : next;
    });
  }, [rows]);

  const toggleSort = (nextKey: SortKey) => {
    if (sortKey === nextKey) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(nextKey);
    setSortDir(nextKey === "name" ? "asc" : "desc");
  };

  const recompute = async () => {
    try {
      setRecomputeBusy(true);
      const res = await fetch(
        `/api/admin/inventory-planning/recompute?sourcePage=${encodeURIComponent(INVENTORY_PLANNING_SOURCE_PAGE)}`,
        { method: "POST" },
      );
      const payload = await fetchJsonOrThrow<{ suggestions?: number }>(res, "Failed to recompute demand.");
      toast.success(`Recomputed demand. ${payload.suggestions || 0} open suggestion(s).`);
      await queryClient.invalidateQueries({ queryKey: ["inventory-planning"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to recompute demand.");
    } finally {
      setRecomputeBusy(false);
    }
  };

  const saveAutoRecompute = async (value: "off" | "daily" | "weekly") => {
    const previous = autoRecompute;
    setAutoRecompute(value);
    setSavingAuto(true);
    try {
      await saveAppSetting(
        {
          key: "inventoryPlanning.autoRecompute",
          value,
          audit: {
            sourcePage: "admin/inventory-planning",
            section: "auto-recompute",
          },
        },
        "Failed to save auto recompute setting.",
      );
      await queryClient.invalidateQueries({ queryKey: ["app-setting", "inventoryPlanning.autoRecompute"] });
      toast.success("Auto recompute updated.");
    } catch (err) {
      setAutoRecompute(previous);
      toast.error(err instanceof Error ? err.message : "Failed to save auto recompute setting.");
    } finally {
      setSavingAuto(false);
    }
  };

  const saveDefaultReorder = async () => {
    const parsed = Number(defaultReorderPoint);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      toast.error("Default reorder point must be a whole number of 0 or higher.");
      return;
    }
    setSavingDefaultReorder(true);
    try {
      await saveAppSetting(
        {
          key: "inventoryPlanning.defaultReorderPoint",
          value: parsed,
          audit: {
            sourcePage: "admin/inventory-planning",
            section: "default-reorder-point",
          },
        },
        "Failed to save default reorder point.",
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["app-setting", "inventoryPlanning.defaultReorderPoint"] }),
        queryClient.invalidateQueries({ queryKey: ["inventory-planning"] }),
      ]);
      toast.success("Default reorder point updated.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save default reorder point.");
    } finally {
      setSavingDefaultReorder(false);
    }
  };

  const toggleSelected = (productId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(productId)) {
        next.delete(productId);
      } else {
        next.add(productId);
      }
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const row of pagedRows) {
          next.delete(row.id);
        }
        return next;
      }
      for (const row of pagedRows) {
        next.add(row.id);
      }
      return next;
    });
  };

  const dismissSelectedSuggestions = async () => {
    if (!selectedSavedSuggestionRows.length) return;
    try {
      setBulkDismissBusy(true);
      await Promise.all(
        selectedSavedSuggestionRows.map(async (row) =>
          fetchJsonOrThrow(
            await fetch(
              `/api/admin/inventory-planning/suggestions/${row.suggestion?.id}/dismiss?sourcePage=${encodeURIComponent(INVENTORY_PLANNING_SOURCE_PAGE)}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason: "Bulk dismissed from planning overview" }),
              },
            ),
            `Failed to dismiss suggestion for ${row.name}.`,
          ),
        ),
      );
      toast.success(`Dismissed ${selectedSavedSuggestionRows.length} saved suggestion(s).`);
      setSelectedIds(new Set());
      await queryClient.invalidateQueries({ queryKey: ["inventory-planning"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to dismiss selected suggestions.");
    } finally {
      setBulkDismissBusy(false);
    }
  };

  return (
    <section className="container mx-auto space-y-6 py-8">
      <header className="space-y-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Inventory Planning</h1>
              <p className="text-sm text-muted-foreground">
                Review reorder risk, demand coverage, and suggested restocks across the catalog.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={summary.belowReorder > 0 ? "warning" : "success"}>
                {summary.belowReorder} below reorder
              </Badge>
              <Badge variant="outline">{summary.manualPlans} manual plans</Badge>
              <Badge variant="outline">{summary.noDemand} without demand data</Badge>
              <Badge variant="outline">Last recompute: {lastRecomputeLabel}</Badge>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canManagePlanning ? (
              <Button variant="outline" size="sm" onClick={recompute} disabled={recomputeBusy}>
                {recomputeBusy ? "Recomputing..." : "Recompute demand"}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" asChild>
              <Link
                href={`/api/admin/inventory-planning/export?scope=all&sourcePage=${encodeURIComponent(INVENTORY_PLANNING_SOURCE_PAGE)}`}
              >
                Export snapshot CSV
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href="/admin/inventory-planning/reports">Reports</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={inventoryPlanningAuditHref}>Open audit log</Link>
            </Button>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.25fr,0.95fr]">
          <Card>
            <CardHeader>
              <CardTitle>Planning snapshot</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Products</div>
                <div className="mt-2 text-2xl font-semibold">{formatNumber(summary.totalProducts)}</div>
              </div>
              <div className="rounded-lg border bg-amber-50 p-3">
                <div className="text-xs uppercase tracking-wide text-amber-700">Needs reorder</div>
                <div className="mt-2 text-2xl font-semibold text-amber-900">{formatNumber(summary.belowReorder)}</div>
              </div>
              <div className="rounded-lg border bg-sky-50 p-3">
                <div className="text-xs uppercase tracking-wide text-sky-700">Open suggestions</div>
                <div className="mt-2 text-2xl font-semibold text-sky-900">{formatNumber(summary.suggestions)}</div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Manual overrides</div>
                <div className="mt-2 text-2xl font-semibold">{formatNumber(summary.manualPlans)}</div>
              </div>
              <div className="rounded-lg border bg-rose-50 p-3">
                <div className="text-xs uppercase tracking-wide text-rose-700">No demand data</div>
                <div className="mt-2 text-2xl font-semibold text-rose-900">{formatNumber(summary.noDemand)}</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Operations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-lg border border-dashed p-3 text-sm">
                <div className="font-medium">Recompute cadence</div>
                <p className="mt-1 text-muted-foreground">
                  Uses the last 60 days of order demand. Cron should call
                  {" "}
                  <code>/api/admin/inventory-planning/recompute</code>
                  {" "}
                  with
                  {" "}
                  <code>Authorization: Bearer CRON_SECRET</code>.
                </p>
                <p className="mt-2 text-xs text-muted-foreground">{scheduledRunStatus}</p>
              </div>

              {canManagePlanning ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="defaultReorderPoint">Default reorder point</Label>
                    <div className="flex gap-2">
                      <Input
                        id="defaultReorderPoint"
                        type="number"
                        min={0}
                        step={1}
                        value={defaultReorderPoint}
                        onChange={(event) => setDefaultReorderPoint(event.target.value)}
                        disabled={!settingsReady || savingDefaultReorder}
                      />
                      <Button
                        variant="outline"
                        onClick={saveDefaultReorder}
                        disabled={!settingsReady || savingDefaultReorder}
                      >
                        {savingDefaultReorder ? "Saving..." : "Save"}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Used when a product has no recent demand snapshot.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="autoRecomputeSelect">Auto recompute</Label>
                    <Select
                      value={autoRecompute}
                      onValueChange={(value) =>
                        saveAutoRecompute(value as "off" | "daily" | "weekly")
                      }
                      disabled={!settingsReady || savingAuto}
                    >
                      <SelectTrigger
                        id="autoRecomputeSelect"
                        className={cn("w-full", !settingsReady && "cursor-not-allowed opacity-60")}
                      >
                        <SelectValue placeholder="Select cadence" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="daily">Daily</SelectItem>
                        <SelectItem value="weekly">Weekly</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Current setting applies only when the cron route is actually wired and invoking the recompute endpoint.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                  This workspace is read-only for your role. Planning settings remain hidden, but you can still review demand and restock recommendations.
                </div>
              )}

              {settingsError ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  Planning settings could not be loaded. Actions stay disabled until that request succeeds.
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </header>

      <Card>
        <CardHeader className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <CardTitle>Planning list</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {filtered.length} matching products, showing page {page} of {totalPages}
              </p>
            </div>
            <div className="flex w-full flex-col gap-3 lg:max-w-2xl lg:flex-row lg:items-end lg:justify-end">
              <div className="w-full max-w-md">
                <Label htmlFor="planningSearch" className="mb-2">
                  Search
                </Label>
                <Input
                  id="planningSearch"
                  placeholder="Search by product, SKU, category, or supplier"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className="w-full max-w-[180px]">
                <Label htmlFor="planningPageSize" className="mb-2">
                  Rows per page
                </Label>
                <Select
                  value={String(pageSize)}
                  onValueChange={(value) => setPageSize(Number(value) as 25 | 50 | 100)}
                >
                  <SelectTrigger id="planningPageSize" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="25">25 rows</SelectItem>
                    <SelectItem value="50">50 rows</SelectItem>
                    <SelectItem value="100">100 rows</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { key: "all" as const, label: "All products" },
              { key: "needs-reorder" as const, label: "Needs reorder" },
              { key: "suggested" as const, label: "Open suggestion" },
              { key: "manual" as const, label: "Manual plan" },
              { key: "no-demand" as const, label: "No demand" },
            ].map((item) => (
              <Button
                key={item.key}
                variant={quickFilter === item.key ? "default" : "outline"}
                size="sm"
                onClick={() => setQuickFilter(item.key)}
              >
                {item.label}
              </Button>
            ))}
          </div>
          {canManagePlanning ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-3 text-sm">
              <span className="text-muted-foreground">
                {selectedIds.size} selected
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={dismissSelectedSuggestions}
                disabled={bulkDismissBusy || selectedSavedSuggestionRows.length === 0}
              >
                {bulkDismissBusy
                  ? "Dismissing..."
                  : `Dismiss saved suggestions (${selectedSavedSuggestionRows.length})`}
              </Button>
              <span className="text-xs text-muted-foreground">
                Bulk dismiss applies only to saved open suggestions, not live computed recommendations.
              </span>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              Loading planning data...
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm">
              <div className="font-medium text-destructive">Planning data could not be loaded.</div>
              <p className="mt-2 text-muted-foreground">
                {error instanceof Error ? error.message : "Unknown error."}
              </p>
              <Button className="mt-4" variant="outline" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              No products match the current search or filter.
            </div>
          ) : (
            <div className="space-y-4">
              <Table className="min-w-[1160px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={allVisibleSelected}
                      onChange={toggleVisibleSelection}
                      aria-label="Select visible planning rows"
                    />
                  </TableHead>
                  <TableHead>
                    <button type="button" className="inline-flex items-center gap-1" onClick={() => toggleSort("name")}>
                      Product
                      <ArrowUpDown className="h-3.5 w-3.5" />
                    </button>
                  </TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                      onClick={() => toggleSort("available")}
                    >
                      Available
                      <ArrowUpDown className="h-3.5 w-3.5" />
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                      onClick={() => toggleSort("avgDailyDemand")}
                    >
                      Avg / day
                      <ArrowUpDown className="h-3.5 w-3.5" />
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                      onClick={() => toggleSort("daysOfCover")}
                    >
                      Days cover
                      <ArrowUpDown className="h-3.5 w-3.5" />
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                      onClick={() => toggleSort("reorderPoint")}
                    >
                      Reorder
                      <ArrowUpDown className="h-3.5 w-3.5" />
                    </button>
                  </TableHead>
                  <TableHead className="text-right">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1"
                      onClick={() => toggleSort("suggestedQty")}
                    >
                      Suggestion
                      <ArrowUpDown className="h-3.5 w-3.5" />
                    </button>
                  </TableHead>
                  <TableHead>Snapshot</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedRows.map((row) => {
                  const coverageTone = getCoverageTone(row.daysOfCover);
                  const purchaseHref = row.suggestion?.suggestedQty
                    ? `/admin/purchases?product=${row.id}&qty=${row.suggestion.suggestedQty}&new=1`
                    : `/admin/purchases?product=${row.id}&new=1`;
                  return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={selectedIds.has(row.id)}
                        onChange={() => toggleSelected(row.id)}
                        aria-label={`Select ${row.name}`}
                      />
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="space-y-1">
                        <div className="font-medium">{row.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {(row.sku && `SKU ${row.sku}`) || "No SKU"}
                          {" / "}
                          {row.category || "No category"}
                          {" / "}
                          {row.supplier || "No supplier"}
                        </div>
                        <div className="flex flex-wrap gap-1">
                          <Badge variant={row.planSource === "manual" ? "outline" : "secondary"}>
                            {row.planSource === "manual" ? "Manual plan" : "Auto plan"}
                          </Badge>
                          {row.effectivePlan.targetStock > 0 ? (
                            <Badge variant="outline">Target stock {formatNumber(row.effectivePlan.targetStock)}</Badge>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-wrap gap-1">
                        {row.needsReorder ? (
                          <Badge variant={row.hasSuggestion ? "warning" : "destructive"}>
                            {row.hasSuggestion ? "Needs review" : "Below reorder"}
                          </Badge>
                        ) : (
                          <Badge variant="success">Covered</Badge>
                        )}
                        {row.isSuggestionStale ? <Badge variant="outline">Suggestion still open</Badge> : null}
                        {!row.demand ? <Badge variant="outline">No demand</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <div>{formatNumber(row.available)}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatNumber(row.stock)} stock /{" "}
                        {row.onOrder > 0 ? (
                          <Link
                            href={`/admin/purchases?product=${row.id}`}
                            className="underline underline-offset-2"
                          >
                            {formatNumber(row.onOrder)} on-order
                          </Link>
                        ) : (
                          `${formatNumber(row.onOrder)} on-order`
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.demand ? formatNumber(row.avgDailyDemand, 2) : "-"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <div>{formatDaysOfCover(row.daysOfCover)}</div>
                      <div className="mt-1 flex justify-end">
                        <Badge variant={coverageTone.variant}>{coverageTone.label}</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <div>{formatNumber(row.effectivePlan.reorderPoint)}</div>
                      <div className="text-xs text-muted-foreground">
                        Safety {formatNumber(row.effectivePlan.safetyStock)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums whitespace-normal">
                      {row.suggestion ? (
                        <div>
                          <div className="font-medium">{formatNumber(row.suggestion.suggestedQty)}</div>
                          <div className="text-xs text-muted-foreground">
                            MOQ {formatNumber(row.effectivePlan.minOrderQty)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {row.demand ? (
                        <div className="text-sm">
                          <div>
                            {new Date(row.demand.periodStart).toLocaleDateString()}
                            {" - "}
                            {new Date(row.demand.periodEnd).toLocaleDateString()}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Captured {formatDateTime(row.demand.capturedAt)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">Run recompute</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {canCreatePurchases ? (
                          <Button variant="outline" size="sm" asChild>
                            <Link href={purchaseHref}>Purchase</Link>
                          </Button>
                        ) : null}
                        <Button variant="outline" size="sm" asChild>
                          <Link href={`/admin/inventory-planning/${row.id}`}>
                            {canEditPlans ? "Review" : "View"}
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )})}
              </TableBody>
              </Table>

              <div className="flex flex-col gap-3 text-sm text-muted-foreground lg:flex-row lg:items-center lg:justify-between">
                <div>
                  Showing {(page - 1) * pageSize + 1} to {Math.min(page * pageSize, filtered.length)} of {filtered.length} matching products
                </div>
                <Pagination aria-label="Inventory planning pagination">
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        href="#"
                        onClick={(event) => {
                          event.preventDefault();
                          if (page > 1) setPage(page - 1);
                        }}
                      />
                    </PaginationItem>
                    {Array.from({ length: totalPages }, (_, index) => index + 1)
                      .filter((pageNumber) =>
                        pageNumber === 1 ||
                        pageNumber === totalPages ||
                        Math.abs(pageNumber - page) <= 1,
                      )
                      .map((pageNumber, index, visiblePages) => (
                        <PaginationItem key={pageNumber}>
                          {index > 0 && pageNumber - visiblePages[index - 1] > 1 ? (
                            <span className="px-2">...</span>
                          ) : null}
                          <PaginationLink
                            href="#"
                            isActive={pageNumber === page}
                            onClick={(event) => {
                              event.preventDefault();
                              setPage(pageNumber);
                            }}
                          >
                            {pageNumber}
                          </PaginationLink>
                        </PaginationItem>
                      ))}
                    <PaginationItem>
                      <PaginationNext
                        href="#"
                        onClick={(event) => {
                          event.preventDefault();
                          if (page < totalPages) setPage(page + 1);
                        }}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
