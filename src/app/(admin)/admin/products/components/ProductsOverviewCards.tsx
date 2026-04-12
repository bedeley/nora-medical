"use client";

import { Card, CardContent } from "@/components/ui/card";
import type { ProductsOverviewStats } from "../types";

export function ProductsOverviewCards({
  stats,
  isAdmin,
  canShowCost,
}: {
  stats: ProductsOverviewStats;
  isAdmin: boolean;
  canShowCost: boolean;
}) {
  return (
    <div className={`grid gap-3 ${isAdmin ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
      <Card className="shadow-sm">
        <CardContent className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Filtered products</p>
          <p className="mt-2 text-2xl font-semibold">{stats.filteredTotal}</p>
          <p className="mt-1 text-xs text-muted-foreground">Across all matching pages</p>
        </CardContent>
      </Card>
      <Card className="shadow-sm">
        <CardContent className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Stock watch</p>
          <p className="mt-2 text-2xl font-semibold">{stats.lowStockCount + stats.outOfStockCount}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {stats.outOfStockCount} out, {stats.lowStockCount} low
          </p>
        </CardContent>
      </Card>
      <Card className="shadow-sm">
        <CardContent className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Suppliers shown</p>
          <p className="mt-2 text-2xl font-semibold">{stats.supplierCount}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {stats.archivedCount > 0 ? `${stats.archivedCount} archived in results` : "Active catalog focus"}
          </p>
        </CardContent>
      </Card>
      {isAdmin ? (
        <Card className="shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Margin risk</p>
            <p className="mt-2 text-2xl font-semibold">{stats.marginRiskCount ?? 0}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {canShowCost ? "Below cost or minimum margin" : "Enable cost visibility to inspect"}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
