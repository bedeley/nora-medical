"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type HealthSummary = {
  ledgerMismatches: number;
  arDifference: number;
  inventoryDifference: number;
  missingPostings: Record<string, number>;
};

type MomoPending = {
  settlement: "PENDING" | "SETTLED" | "FAILED";
  posted: boolean;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function MonitoringSummary() {
  const { data: health } = useClientQuery<HealthSummary>({
    queryKey: ["admin", "health", "summary"],
    queryFn: () => fetcher("/api/admin/health/summary"),
    refetchInterval: 60_000,
  });

  const { data: momoData } = useClientQuery<{ items: MomoPending[] }>({
    queryKey: ["admin", "payments", "momo", "pending"],
    queryFn: () => fetcher("/api/admin/payments/momo/pending"),
    refetchInterval: 60_000,
  });

  const momoCounts = useMemo(() => {
    const items = Array.isArray(momoData?.items) ? momoData?.items : [];
    return {
      pending: items.filter((i) => i.settlement === "PENDING").length,
      failed: items.filter((i) => i.settlement === "FAILED").length,
      unposted: items.filter((i) => !i.posted).length,
    };
  }, [momoData?.items]);

  const missing = health?.missingPostings;
  const missingTotal = missing ? Object.values(missing).reduce((sum, n) => sum + Number(n || 0), 0) : 0;
  const hasIssues =
    (health?.ledgerMismatches || 0) > 0 ||
    missingTotal > 0 ||
    momoCounts.pending > 0 ||
    momoCounts.failed > 0 ||
    momoCounts.unposted > 0;

  return (
    <Card className="min-w-0">
      <CardHeader className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <CardTitle>Monitoring</CardTitle>
          {!hasIssues ? <Badge variant="success">All clear</Badge> : null}
        </div>
        <Button asChild size="sm" variant="outline" className="w-full sm:w-auto">
          <Link href="/admin/health">Open health check</Link>
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">Ledger mismatches</div>
          <div className="text-lg font-semibold">{health?.ledgerMismatches ?? 0}</div>
          <div className="text-[11px] text-muted-foreground">
            AR {Number(health?.arDifference ?? 0).toFixed(2)} - Inventory {Number(health?.inventoryDifference ?? 0).toFixed(2)}
          </div>
        </div>
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">Missing postings</div>
          <div className="text-lg font-semibold">{missingTotal}</div>
          <div className="text-[11px] text-muted-foreground">
            Orders {missing?.orders ?? 0} - Payments {missing?.payments ?? 0} - Settlements {missing?.settlements ?? 0}
          </div>
        </div>
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">MoMo pending</div>
          <div className="text-lg font-semibold">{momoCounts.pending}</div>
          <div className="text-[11px] text-muted-foreground">Awaiting settlement</div>
        </div>
        <div className="rounded-md border p-3">
          <div className="text-xs text-muted-foreground">MoMo failures</div>
          <div className="text-lg font-semibold">{momoCounts.failed}</div>
          <div className="text-[11px] text-muted-foreground">Unposted {momoCounts.unposted}</div>
        </div>
      </CardContent>
    </Card>
  );
}
