"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export default function InventoryPlanningDetailPage() {
  const params = useParams();
  const productId = String((params as { id?: string }).id || "");
  const queryClient = useQueryClient();
  const { data } = useClientQuery<{ row?: PlanSummary }>({
    queryKey: ["inventory-planning", "detail", productId],
    queryFn: () => fetch(`/api/admin/inventory-planning/${productId}`).then((r) => r.json()),
    enabled: Boolean(productId),
  });
  const row = useMemo(() => data?.row ?? null, [data?.row]);

  const [reorderPoint, setReorderPoint] = useState("");
  const [safetyStock, setSafetyStock] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [reviewPeriodDays, setReviewPeriodDays] = useState("");
  const [minOrderQty, setMinOrderQty] = useState("");
  const [fallbackReorderPoint, setFallbackReorderPoint] = useState("");
  const [approvalThresholdQty, setApprovalThresholdQty] = useState("");
  const [targetStock, setTargetStock] = useState("");
  const [saving, setSaving] = useState(false);

  const loadValue = (value: number | undefined | null, fallback = "") => {
    if (value === null || value === undefined) return fallback;
    return String(value);
  };

  const handleSave = async () => {
    if (!productId) return;
    const payload = {
      reorderPoint: reorderPoint === "" ? undefined : Number(reorderPoint),
      fallbackReorderPoint: fallbackReorderPoint === "" ? undefined : Number(fallbackReorderPoint),
      safetyStock: safetyStock === "" ? undefined : Number(safetyStock),
      leadTimeDays: leadTimeDays === "" ? undefined : Number(leadTimeDays),
      reviewPeriodDays: reviewPeriodDays === "" ? undefined : Number(reviewPeriodDays),
      minOrderQty: minOrderQty === "" ? undefined : Number(minOrderQty),
      approvalThresholdQty: approvalThresholdQty === "" ? undefined : Number(approvalThresholdQty),
      targetStock: targetStock === "" ? undefined : Number(targetStock),
    };
    try {
      setSaving(true);
      const res = await fetch(`/api/admin/inventory-planning/${productId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to update plan.");
      toast.success("Planning settings updated.");
      setReorderPoint("");
      setFallbackReorderPoint("");
      setSafetyStock("");
      setLeadTimeDays("");
      setReviewPeriodDays("");
      setMinOrderQty("");
      setApprovalThresholdQty("");
      setTargetStock("");
      queryClient.invalidateQueries({ queryKey: ["inventory-planning"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-planning", "detail", productId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update plan.");
    } finally {
      setSaving(false);
    }
  };

  const dismissSuggestion = async () => {
    if (!row?.suggestion?.id) return;
    try {
      const res = await fetch(`/api/admin/inventory-planning/suggestions/${row.suggestion.id}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Dismissed from planning view" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || "Failed to dismiss suggestion.");
      toast.success("Suggestion dismissed.");
      queryClient.invalidateQueries({ queryKey: ["inventory-planning"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-planning", "detail", productId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to dismiss suggestion.");
    }
  };

  if (!row) {
    return (
      <section className="container mx-auto py-8 space-y-4">
        <h1 className="text-2xl font-semibold">Inventory Planning</h1>
        <p className="text-sm text-muted-foreground">Loading product plan...</p>
      </section>
    );
  }

  const plan = row.plan;
  const effectivePlan = row.effectivePlan;
  return (
    <section className="container mx-auto py-8 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">{row.name}</h1>
          <p className="text-sm text-muted-foreground">
            {row.sku ? `SKU ${row.sku}` : "No SKU"} · {row.category || "No category"} · {row.supplier || "No supplier"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/admin/purchases?product=${row.id}#new`}>Add purchase</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/inventory-planning">Back to planning</Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Demand snapshot</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          {row.demand ? (
            <>
              <div className="flex justify-between">
                <span>Period</span>
                <span>
                  {new Date(row.demand.periodStart).toLocaleDateString()} -{" "}
                  {new Date(row.demand.periodEnd).toLocaleDateString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Units sold</span>
                <span>{row.demand.unitsSold}</span>
              </div>
              <div className="flex justify-between">
                <span>Avg daily demand</span>
                <span>{Number(row.demand.avgDailyDemand).toFixed(2)}</span>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">No demand snapshot yet. Run recompute.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Restock suggestion</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Available</span>
            <span>
              {row.available} (Stock {row.stock} - Reserved {row.reserved} + On-order {row.onOrder})
            </span>
          </div>
          {row.suggestion ? (
            <>
              <div className="flex justify-between">
                <span>Suggested quantity</span>
                <span>{row.suggestion.suggestedQty}</span>
              </div>
              <div className="text-xs text-muted-foreground">{row.suggestion.reason}</div>
              <Button size="sm" variant="outline" onClick={dismissSuggestion}>
                Dismiss suggestion
              </Button>
            </>
          ) : (
            <p className="text-muted-foreground">No suggestion for this product.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Planning settings</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Input
            placeholder={`Reorder point (${loadValue(effectivePlan?.reorderPoint, "0")})`}
            value={reorderPoint}
            onChange={(e) => setReorderPoint(e.target.value)}
          />
          <Input
            placeholder={`Default reorder (no demand) (${loadValue(plan?.fallbackReorderPoint, "global default")})`}
            value={fallbackReorderPoint}
            onChange={(e) => setFallbackReorderPoint(e.target.value)}
          />
          <Input
            placeholder={`Safety stock (${loadValue(effectivePlan?.safetyStock, "0")})`}
            value={safetyStock}
            onChange={(e) => setSafetyStock(e.target.value)}
          />
          <Input
            placeholder={`Lead time days (${loadValue(effectivePlan?.leadTimeDays, "14")})`}
            value={leadTimeDays}
            onChange={(e) => setLeadTimeDays(e.target.value)}
          />
          <Input
            placeholder={`Review period days (${loadValue(effectivePlan?.reviewPeriodDays, "60")})`}
            value={reviewPeriodDays}
            onChange={(e) => setReviewPeriodDays(e.target.value)}
          />
          <Input
            placeholder={`Min order qty (${loadValue(effectivePlan?.minOrderQty, "1")})`}
            value={minOrderQty}
            onChange={(e) => setMinOrderQty(e.target.value)}
          />
          <Input
            placeholder={`Approval threshold qty (${loadValue(effectivePlan?.approvalThresholdQty, "global default")})`}
            value={approvalThresholdQty}
            onChange={(e) => setApprovalThresholdQty(e.target.value)}
          />
          <Input
            placeholder={`Target stock (${loadValue(effectivePlan?.targetStock, "0")})`}
            value={targetStock}
            onChange={(e) => setTargetStock(e.target.value)}
          />
          <div className="sm:col-span-2 lg:col-span-3">
            <Button className="w-full sm:w-auto" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save planning settings"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
