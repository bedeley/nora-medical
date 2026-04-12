"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchJsonOrThrow } from "@/lib/app-settings-client";
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

type DetailResponse = {
  row?: PlanSummary;
};

type PlanFormState = {
  reorderPoint: string;
  fallbackReorderPoint: string;
  safetyStock: string;
  leadTimeDays: string;
  reviewPeriodDays: string;
  minOrderQty: string;
  approvalThresholdQty: string;
  targetStock: string;
};

function toFormState(row: PlanSummary): PlanFormState {
  return {
    reorderPoint: String(row.plan?.reorderPoint ?? row.effectivePlan.reorderPoint),
    fallbackReorderPoint:
      row.plan?.fallbackReorderPoint == null ? "" : String(row.plan.fallbackReorderPoint),
    safetyStock: String(row.plan?.safetyStock ?? row.effectivePlan.safetyStock),
    leadTimeDays: String(row.plan?.leadTimeDays ?? row.effectivePlan.leadTimeDays),
    reviewPeriodDays: String(row.plan?.reviewPeriodDays ?? row.effectivePlan.reviewPeriodDays),
    minOrderQty: String(row.plan?.minOrderQty ?? row.effectivePlan.minOrderQty),
    approvalThresholdQty:
      row.plan?.approvalThresholdQty == null ? "" : String(row.plan.approvalThresholdQty),
    targetStock: String(row.plan?.targetStock ?? row.effectivePlan.targetStock),
  };
}

function formatDateTime(value?: string | null) {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Unknown";
  return parsed.toLocaleString();
}

function formatNumber(value: number, maximumFractionDigits = 0) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
}

function parseInteger(raw: string, label: string, min: number) {
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new Error(`${label} must be a whole number of ${min} or higher.`);
  }
  return value;
}

function parseNullableInteger(raw: string, label: string, min: number) {
  if (!raw.trim()) return null;
  return parseInteger(raw, label, min);
}

export default function InventoryPlanningDetailPage() {
  const params = useParams();
  const productId = String((params as { id?: string }).id || "");
  const detailSourcePage = productId
    ? `admin/inventory-planning/${productId}`
    : "admin/inventory-planning/[id]";
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const role = String(session?.user?.role || "");
  const canManagePlanning = role === "ADMIN" || role === "ACCOUNTANT";
  const canDismissSuggestion = canManagePlanning;
  const canEditPlans = role === "ADMIN";
  const canCreatePurchases = role === "ADMIN";

  const [form, setForm] = useState<PlanFormState>({
    reorderPoint: "",
    fallbackReorderPoint: "",
    safetyStock: "",
    leadTimeDays: "",
    reviewPeriodDays: "",
    minOrderQty: "",
    approvalThresholdQty: "",
    targetStock: "",
  });
  const [saving, setSaving] = useState(false);
  const [recomputeBusy, setRecomputeBusy] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [resettingPlan, setResettingPlan] = useState(false);

  const {
    data,
    error,
    isLoading,
    refetch,
  } = useClientQuery<DetailResponse>({
    queryKey: ["inventory-planning", "detail", productId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/inventory-planning/${productId}`, { cache: "no-store" });
      return fetchJsonOrThrow<DetailResponse>(res, "Failed to load product planning.");
    },
    enabled: Boolean(productId),
  });
  const row = useMemo(() => data?.row ?? null, [data?.row]);

  useEffect(() => {
    if (!row) return;
    setForm(toFormState(row));
  }, [row]);

  const avgDailyDemand = row?.demand ? Number(row.demand.avgDailyDemand) : 0;
  const daysOfCover =
    row && avgDailyDemand > 0 ? Math.max(0, row.available) / avgDailyDemand : null;

  const updateField = (key: keyof PlanFormState, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const recompute = async () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm("This recomputes demand for the entire catalog, not just this product. Continue?")
    ) {
      return;
    }
    try {
      setRecomputeBusy(true);
      const res = await fetch(
        `/api/admin/inventory-planning/recompute?sourcePage=${encodeURIComponent(detailSourcePage)}`,
        { method: "POST" },
      );
      const payload = await fetchJsonOrThrow<{ suggestions?: number }>(res, "Failed to recompute demand.");
      toast.success(`Recomputed demand. ${payload.suggestions || 0} open suggestion(s).`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inventory-planning"] }),
        queryClient.invalidateQueries({ queryKey: ["inventory-planning", "detail", productId] }),
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to recompute demand.");
    } finally {
      setRecomputeBusy(false);
    }
  };

  const resetToAutoPlan = async () => {
    if (!productId) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm("Reset this product to auto planning? Manual overrides will be removed.")
    ) {
      return;
    }
    try {
      setResettingPlan(true);
      const res = await fetch(
        `/api/admin/inventory-planning/${productId}?sourcePage=${encodeURIComponent(detailSourcePage)}`,
        { method: "DELETE" },
      );
      await fetchJsonOrThrow<{ ok: true }>(res, "Failed to reset inventory plan.");
      toast.success("Product planning reset to auto mode.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inventory-planning"] }),
        queryClient.invalidateQueries({ queryKey: ["inventory-planning", "detail", productId] }),
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset inventory plan.");
    } finally {
      setResettingPlan(false);
    }
  };

  const dismissSuggestion = async () => {
    if (!row?.suggestion?.id) return;
    try {
      setDismissing(true);
      const res = await fetch(
        `/api/admin/inventory-planning/suggestions/${row.suggestion.id}/dismiss?sourcePage=${encodeURIComponent(detailSourcePage)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Dismissed from planning detail view" }),
        },
      );
      await fetchJsonOrThrow<{ ok: true }>(res, "Failed to dismiss suggestion.");
      toast.success("Suggestion dismissed.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inventory-planning"] }),
        queryClient.invalidateQueries({ queryKey: ["inventory-planning", "detail", productId] }),
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to dismiss suggestion.");
    } finally {
      setDismissing(false);
    }
  };

  const handleSave = async () => {
    if (!productId) return;
    try {
      const payload = {
        reorderPoint: parseInteger(form.reorderPoint, "Reorder point", 0),
        fallbackReorderPoint: parseNullableInteger(
          form.fallbackReorderPoint,
          "Fallback reorder point",
          0,
        ),
        safetyStock: parseInteger(form.safetyStock, "Safety stock", 0),
        leadTimeDays: parseInteger(form.leadTimeDays, "Lead time days", 1),
        reviewPeriodDays: parseInteger(form.reviewPeriodDays, "Review period days", 1),
        minOrderQty: parseInteger(form.minOrderQty, "Minimum order quantity", 1),
        approvalThresholdQty: parseNullableInteger(
          form.approvalThresholdQty,
          "Approval threshold quantity",
          1,
        ),
        targetStock: parseInteger(form.targetStock, "Target stock", 0),
      };
      setSaving(true);
      const res = await fetch(
        `/api/admin/inventory-planning/${productId}?sourcePage=${encodeURIComponent(detailSourcePage)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      await fetchJsonOrThrow(res, "Failed to update planning settings.");
      toast.success("Planning settings updated.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inventory-planning"] }),
        queryClient.invalidateQueries({ queryKey: ["inventory-planning", "detail", productId] }),
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update planning settings.");
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) {
    return (
      <section className="container mx-auto space-y-4 py-8">
        <h1 className="text-2xl font-semibold">Inventory Planning</h1>
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          Loading product planning...
        </div>
      </section>
    );
  }

  if (error || !row) {
    return (
      <section className="container mx-auto space-y-4 py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">Inventory Planning</h1>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/inventory-planning">Back to planning</Link>
          </Button>
        </div>
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm">
          <div className="font-medium text-destructive">Product planning could not be loaded.</div>
          <p className="mt-2 text-muted-foreground">
            {error instanceof Error ? error.message : "The requested product may not exist or you may not have access."}
          </p>
          <Button className="mt-4" variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="container mx-auto space-y-6 py-8">
      <header className="space-y-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">{row.name}</h1>
              <p className="text-sm text-muted-foreground">
                {(row.sku && `SKU ${row.sku}`) || "No SKU"}
                {" / "}
                {row.category || "No category"}
                {" / "}
                {row.supplier || "No supplier"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={row.planSource === "manual" ? "outline" : "secondary"}>
                {row.planSource === "manual" ? "Manual plan" : "Auto plan"}
              </Badge>
              {row.available <= row.effectivePlan.reorderPoint ? (
                <Badge variant={row.suggestion ? "warning" : "destructive"}>Below reorder</Badge>
              ) : (
                <Badge variant="success">Covered</Badge>
              )}
              {!row.demand ? <Badge variant="outline">No demand snapshot</Badge> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {canManagePlanning ? (
              <Button variant="outline" size="sm" onClick={recompute} disabled={recomputeBusy}>
                {recomputeBusy ? "Recomputing..." : "Recompute all demand"}
              </Button>
            ) : null}
            {canCreatePurchases ? (
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={
                    row.suggestion?.suggestedQty
                      ? `/admin/purchases?product=${row.id}&qty=${row.suggestion.suggestedQty}&new=1`
                      : `/admin/purchases?product=${row.id}&new=1`
                  }
                >
                  Add purchase
                </Link>
              </Button>
            ) : null}
            <Button variant="outline" size="sm" asChild>
              <Link href="/admin/inventory-planning">Back to planning</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/admin/audit?sourcePage=${encodeURIComponent(detailSourcePage)}`}>
                Open audit log
              </Link>
            </Button>
          </div>
        </div>
        {canManagePlanning ? (
          <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            Recompute from this page still runs the planning job across the entire catalog so suggestion counts and demand snapshots stay consistent.
          </div>
        ) : null}
      </header>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Coverage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Available</span>
              <span className="font-medium">{formatNumber(row.available)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Stock</span>
              <span>{formatNumber(row.stock)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Reserved</span>
              <span>{formatNumber(row.reserved)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">On-order</span>
              {row.onOrder > 0 ? (
                <Link
                  href={`/admin/purchases?product=${row.id}`}
                  className="font-medium underline underline-offset-2"
                >
                  {formatNumber(row.onOrder)}
                </Link>
              ) : (
                <span>{formatNumber(row.onOrder)}</span>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Days of cover</span>
              <span>{daysOfCover == null ? "No demand" : `${daysOfCover.toFixed(daysOfCover >= 10 ? 0 : 1)}d`}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Demand snapshot</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {row.demand ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Period</span>
                  <span>
                    {new Date(row.demand.periodStart).toLocaleDateString()}
                    {" - "}
                    {new Date(row.demand.periodEnd).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Units sold</span>
                  <span>{formatNumber(row.demand.unitsSold)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Avg daily demand</span>
                  <span>{formatNumber(avgDailyDemand, 2)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Captured</span>
                  <span>{formatDateTime(row.demand.capturedAt)}</span>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">No demand snapshot yet. Run recompute to create one.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Restock suggestion</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {row.suggestion ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Suggested quantity</span>
                  <span className="font-medium">{formatNumber(row.suggestion.suggestedQty)}</span>
                </div>
                <p className="text-xs text-muted-foreground">{row.suggestion.reason || "No reason provided."}</p>
                <div className="text-xs text-muted-foreground">
                  {row.suggestion.createdAt
                    ? `Generated ${formatDateTime(row.suggestion.createdAt)}`
                    : "Computed live from the effective plan"}
                </div>
                {canDismissSuggestion && row.suggestion.id ? (
                  <Button size="sm" variant="outline" onClick={dismissSuggestion} disabled={dismissing}>
                    {dismissing ? "Dismissing..." : "Dismiss suggestion"}
                  </Button>
                ) : canDismissSuggestion ? (
                  <p className="text-xs text-muted-foreground">
                    Live computed suggestions are not persisted yet, so they cannot be dismissed from audit history. Recompute or stock changes will refresh this recommendation.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">No suggestion for this product.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Effective plan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Reorder point</span>
              <span>{formatNumber(row.effectivePlan.reorderPoint)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Safety stock</span>
              <span>{formatNumber(row.effectivePlan.safetyStock)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Lead time</span>
              <span>{formatNumber(row.effectivePlan.leadTimeDays)}d</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Review period</span>
              <span>{formatNumber(row.effectivePlan.reviewPeriodDays)}d</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Min order qty</span>
              <span>{formatNumber(row.effectivePlan.minOrderQty)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Target stock</span>
              <span>{formatNumber(row.effectivePlan.targetStock)}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Manual overrides</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {canEditPlans ? (
            <>
              <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                Fields are preloaded with the current effective plan. Clearing the optional fields below removes that override and falls back to the global default. Use reset to auto to remove the manual plan entirely.
              </div>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-2">
                  <Label htmlFor="reorderPoint">Reorder point</Label>
                  <Input
                    id="reorderPoint"
                    type="number"
                    min={0}
                    step={1}
                    value={form.reorderPoint}
                    onChange={(event) => updateField("reorderPoint", event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="fallbackReorderPoint">Fallback reorder point</Label>
                  <Input
                    id="fallbackReorderPoint"
                    type="number"
                    min={0}
                    step={1}
                    value={form.fallbackReorderPoint}
                    onChange={(event) => updateField("fallbackReorderPoint", event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Leave blank to use the global default.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="safetyStock">Safety stock</Label>
                  <Input
                    id="safetyStock"
                    type="number"
                    min={0}
                    step={1}
                    value={form.safetyStock}
                    onChange={(event) => updateField("safetyStock", event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="leadTimeDays">Lead time days</Label>
                  <Input
                    id="leadTimeDays"
                    type="number"
                    min={1}
                    step={1}
                    value={form.leadTimeDays}
                    onChange={(event) => updateField("leadTimeDays", event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reviewPeriodDays">Review period days</Label>
                  <Input
                    id="reviewPeriodDays"
                    type="number"
                    min={1}
                    step={1}
                    value={form.reviewPeriodDays}
                    onChange={(event) => updateField("reviewPeriodDays", event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="minOrderQty">Minimum order quantity</Label>
                  <Input
                    id="minOrderQty"
                    type="number"
                    min={1}
                    step={1}
                    value={form.minOrderQty}
                    onChange={(event) => updateField("minOrderQty", event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="approvalThresholdQty">Approval threshold quantity</Label>
                  <Input
                    id="approvalThresholdQty"
                    type="number"
                    min={1}
                    step={1}
                    value={form.approvalThresholdQty}
                    onChange={(event) => updateField("approvalThresholdQty", event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">Leave blank to remove the threshold.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="targetStock">Target stock</Label>
                  <Input
                    id="targetStock"
                    type="number"
                    min={0}
                    step={1}
                    value={form.targetStock}
                    onChange={(event) => updateField("targetStock", event.target.value)}
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? "Saving..." : "Save overrides"}
                </Button>
                <Button
                  variant="outline"
                  onClick={resetToAutoPlan}
                  disabled={saving || resettingPlan || row.planSource !== "manual"}
                >
                  {resettingPlan ? "Resetting..." : "Reset to auto"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      fallbackReorderPoint: "",
                      approvalThresholdQty: "",
                    }))
                  }
                  disabled={saving}
                >
                  Clear optional overrides
                </Button>
                <Button variant="outline" onClick={() => setForm(toFormState(row))} disabled={saving}>
                  Reset form
                </Button>
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              Manual overrides are admin-only. You can still review the effective plan and suggestions from this page.
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
