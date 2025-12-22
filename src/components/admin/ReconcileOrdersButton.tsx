"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type ReconcileOrdersButtonProps = {
  orderIds: string[];
  label?: string;
};

export default function ReconcileOrdersButton({
  orderIds,
  label = "Reconcile mismatches",
}: ReconcileOrdersButtonProps) {
  const [running, setRunning] = useState(false);
  const router = useRouter();

  const handleRun = async () => {
    if (!orderIds.length) return;
    if (!confirm(`Recalculate totals for ${orderIds.length} order(s)?`)) return;
    setRunning(true);
    try {
      const res = await fetch("/api/admin/health/reconcile-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds }),
      });
      if (!res.ok) {
        throw new Error("Failed to reconcile orders");
      }
      toast.success("Order totals recomputed.");
      router.refresh();
    } catch {
      toast.error("Could not reconcile orders.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleRun} disabled={running || !orderIds.length}>
      {running ? "Reconciling..." : label}
    </Button>
  );
}
