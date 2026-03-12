"use client";

import Link from "next/link";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type AnalyticsResponse = {
  summary: {
    totalRequests: number;
    openCount: number;
    unassignedOpenCount: number;
    convertedToDraftCount: number;
    convertedToDraftRatePct: number;
    avgHoursToAssignment: number | null;
    avgHoursToQuoted: number | null;
    avgHoursToApproved: number | null;
    statusCounts: Record<string, number>;
  };
  topRequested: Array<{ itemRef: string; count: number }>;
  oldestOpen: Array<{ id: string; status: string; clinicName: string; ageDays: number; hasAssignment: boolean }>;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function B2BProcurementAnalyticsPage() {
  const { data, isFetching, refetch } = useClientQuery<AnalyticsResponse>({
    queryKey: ["admin", "b2b-procurement-analytics"],
    queryFn: () => fetcher("/api/admin/b2b/procurement/analytics"),
  });

  const summary = data?.summary;

  return (
    <section className="container mx-auto py-8 max-w-6xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">B2B Procurement Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Track workflow performance, aging, and demand trends.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/b2b/procurement">
            <Button className="w-full sm:w-auto" variant="outline">Back to Workflow</Button>
          </Link>
          <Button className="w-full sm:w-auto" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-sm font-medium">Request Volume</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div>Total: {summary?.totalRequests ?? 0}</div>
            <div>Open: {summary?.openCount ?? 0}</div>
            <div>Unassigned Open: {summary?.unassignedOpenCount ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm font-medium">Cycle Time (Hours)</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div>To Assignment: {summary?.avgHoursToAssignment ?? "-"}</div>
            <div>To Quoted: {summary?.avgHoursToQuoted ?? "-"}</div>
            <div>To Approved: {summary?.avgHoursToApproved ?? "-"}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm font-medium">Draft Conversion</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div>Drafts Prepared: {summary?.convertedToDraftCount ?? 0}</div>
            <div>Conversion Rate: {summary?.convertedToDraftRatePct ?? 0}%</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm font-medium">Status Mix</CardTitle></CardHeader>
          <CardContent>
            {summary ? (
              <div className="space-y-1 text-sm">
                {Object.entries(summary.statusCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([status, count]) => (
                    <div key={status} className="flex items-center justify-between rounded border px-2 py-1">
                      <span>{status}</span>
                      <span>{count}</span>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No data yet.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm font-medium">Top Requested Items</CardTitle></CardHeader>
          <CardContent>
            {data?.topRequested?.length ? (
              <div className="space-y-1 text-sm">
                {data.topRequested.map((row) => (
                  <div key={`${row.itemRef}-${row.count}`} className="flex items-center justify-between rounded border px-2 py-1">
                    <span className="truncate pr-2">{row.itemRef}</span>
                    <span>{row.count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No item trend data yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm font-medium">Oldest Open Requests</CardTitle></CardHeader>
        <CardContent>
          {data?.oldestOpen?.length ? (
            <div className="space-y-1 text-sm">
              {data.oldestOpen.map((row) => (
                <div key={row.id} className="rounded border p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">{row.clinicName}</div>
                    <div>{row.ageDays} days open</div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {row.id} | {row.status} | {row.hasAssignment ? "Assigned" : "Unassigned"}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No open requests.</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
