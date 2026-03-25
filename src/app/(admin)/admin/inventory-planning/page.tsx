"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchAppSetting, saveAppSetting } from "@/lib/app-settings-client";
import { toast } from "sonner";

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
    safetyStock: number;
    leadTimeDays: number;
    reviewPeriodDays: number;
    minOrderQty: number;
    targetStock: number;
  } | null;
  effectivePlan: {
    reorderPoint: number;
    safetyStock: number;
    leadTimeDays: number;
    reviewPeriodDays: number;
    minOrderQty: number;
    targetStock: number;
  };
  planSource: "manual" | "auto";
  demand: {
    periodStart: string;
    periodEnd: string;
    unitsSold: number;
    avgDailyDemand: string;
  } | null;
  suggestion: {
    id: string;
    suggestedQty: number;
    reason?: string | null;
    createdAt: string;
  } | null;
};

export default function InventoryPlanningPage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [autoRecompute, setAutoRecompute] = useState<"off" | "daily" | "weekly">("off");
  const [savingAuto, setSavingAuto] = useState(false);
  const [defaultReorderPoint, setDefaultReorderPoint] = useState("10");
  const [savingDefaultReorder, setSavingDefaultReorder] = useState(false);
  const { data } = useClientQuery<{ rows: PlanSummary[] }>({
    queryKey: ["inventory-planning"],
    queryFn: () => fetch("/api/admin/inventory-planning").then((r) => r.json()),
  });
  const { data: autoSetting } = useClientQuery<{ value?: unknown }>({
    queryKey: ["app-setting", "inventoryPlanning.autoRecompute"],
    queryFn: () => fetchAppSetting<string>("inventoryPlanning.autoRecompute"),
  });
  const { data: defaultReorderSetting } = useClientQuery<{ value?: unknown }>({
    queryKey: ["app-setting", "inventoryPlanning.defaultReorderPoint"],
    queryFn: () => fetchAppSetting<number>("inventoryPlanning.defaultReorderPoint"),
  });
  const rows = useMemo(() => (Array.isArray(data?.rows) ? data?.rows : []), [data]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((row) => {
      return (
        row.name.toLowerCase().includes(term) ||
        (row.sku || "").toLowerCase().includes(term) ||
        (row.category || "").toLowerCase().includes(term) ||
        (row.supplier || "").toLowerCase().includes(term)
      );
    });
  }, [rows, query]);

  const recompute = async () => {
    try {
      const res = await fetch("/api/admin/inventory-planning/recompute", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to recompute");
      toast.success(`Recomputed. ${j.suggestions || 0} suggestion(s).`);
      queryClient.invalidateQueries({ queryKey: ["inventory-planning"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to recompute");
    }
  };

  useEffect(() => {
    const value = typeof autoSetting?.value === "string" ? autoSetting.value : "";
    if (value === "daily" || value === "weekly" || value === "off") {
      setAutoRecompute(value);
    }
  }, [autoSetting?.value]);

  useEffect(() => {
    const value = defaultReorderSetting?.value;
    if (typeof value === "number" && Number.isFinite(value)) {
      setDefaultReorderPoint(String(value));
    }
  }, [defaultReorderSetting?.value]);

  const saveAutoRecompute = async (value: "off" | "daily" | "weekly") => {
    setAutoRecompute(value);
    setSavingAuto(true);
    try {
      await saveAppSetting({ key: "inventoryPlanning.autoRecompute", value }, "Failed to save setting.");
      toast.success("Auto recompute setting updated.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save setting.");
    } finally {
      setSavingAuto(false);
    }
  };

  const saveDefaultReorderPoint = async () => {
    const parsed = Number(defaultReorderPoint);
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error("Default reorder point must be 0 or higher.");
      return;
    }
    setSavingDefaultReorder(true);
    try {
      await saveAppSetting(
        { key: "inventoryPlanning.defaultReorderPoint", value: parsed },
        "Failed to save default reorder point.",
      );
      toast.success("Default reorder point updated.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save default reorder point.");
    } finally {
      setSavingDefaultReorder(false);
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Inventory Planning</h1>
          <p className="text-sm text-muted-foreground">
            Plan reorder points using the last 60 days of demand.
          </p>
        </div>
        <div className="flex w-full flex-wrap gap-3 items-end sm:w-auto">
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <label className="text-xs font-medium text-foreground" htmlFor="defaultReorderPoint">
              Default reorder point
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="defaultReorderPoint"
                type="number"
                min={0}
                value={defaultReorderPoint}
                onChange={(e) => setDefaultReorderPoint(e.target.value)}
                className="h-8 w-full sm:w-24"
              />
              <Button
                size="sm"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={saveDefaultReorderPoint}
                disabled={savingDefaultReorder}
              >
                {savingDefaultReorder ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <label className="text-xs font-medium text-foreground" htmlFor="autoRecomputeSelect">
              Auto recompute
            </label>
            <select
              id="autoRecomputeSelect"
              className="h-8 w-full sm:w-auto rounded border bg-background px-2 text-sm"
              value={autoRecompute}
              onChange={(e) => saveAutoRecompute(e.target.value as "off" | "daily" | "weekly")}
              disabled={savingAuto}
            >
              <option value="off">Off</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={recompute}>
            Recompute demand
          </Button>
          <Button variant="outline" size="sm" className="w-full sm:w-auto" asChild>
            <Link href="/api/admin/inventory-planning/export">Export CSV</Link>
          </Button>
          <Button variant="outline" size="sm" className="w-full sm:w-auto" asChild>
            <Link href="/admin/inventory-planning/reports">Reports</Link>
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Auto recompute requires a cron job calling `/api/admin/inventory-planning/recompute` with
        `Authorization: Bearer CRON_SECRET`.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Planning list</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            placeholder="Search by product, SKU, category, or supplier"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">No products found.</p>
          ) : (
            <div className="grid gap-2 text-sm">
              {filtered.map((row) => (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded border px-3 py-2"
                >
                  <div>
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.sku ? `SKU ${row.sku}` : "No SKU"} · {row.category || "No category"} · {row.supplier || "No supplier"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Available {row.available} (Stock {row.stock} - Reserved {row.reserved} + On-order {row.onOrder}) · Reorder {row.effectivePlan.reorderPoint} · Safety {row.effectivePlan.safetyStock} · {row.planSource === "auto" ? "Auto" : "Manual"}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {row.suggestion ? (
                      <>Suggest {row.suggestion.suggestedQty}</>
                    ) : (
                      <>No suggestion</>
                    )}
                  </div>
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/admin/inventory-planning/${row.id}`}>View</Link>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
