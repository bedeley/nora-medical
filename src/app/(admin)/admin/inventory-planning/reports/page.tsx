"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function InventoryPlanningReportsPage() {
  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Inventory Planning Reports</h1>
        <p className="text-sm text-muted-foreground">
          Export restock suggestions and planning summaries.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Exports</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/api/admin/inventory-planning/export">
              Export restock suggestions (CSV)
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/inventory-planning">Back to planning</Link>
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}
