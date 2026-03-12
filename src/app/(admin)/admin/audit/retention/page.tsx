"use client";

import { useState } from "react";
import { useClientQuery } from "@/hooks/use-client-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";

type RetentionStatus = {
  retentionDays: number;
  cutoff: string;
  eligibleCount: number;
  reviewGuard?: {
    blockedCriticalHigh: number;
    blockedMedium: number;
    eligibleAfterGuard: number;
  } | null;
};

export default function AuditRetentionPage() {
  const [overrideMediumUnreviewed, setOverrideMediumUnreviewed] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const { data, isLoading, refetch } = useClientQuery<RetentionStatus>({
    queryKey: ["admin", "audit", "retention-status"],
    queryFn: () => fetch("/api/admin/audit/retention").then((r) => r.json()),
  });

  const runRetention = async () => {
    try {
      const res = await fetch("/api/admin/audit/retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          overrideMediumUnreviewed,
          overrideReason: overrideReason.trim() || undefined,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 409 && payload?.blocked) {
          const parts: string[] = [];
          if (Number(payload.blocked.criticalHigh || 0) > 0) {
            parts.push(`${payload.blocked.criticalHigh} unreviewed High/Critical`);
          }
          if (Number(payload.blocked.medium || 0) > 0) {
            parts.push(`${payload.blocked.medium} unreviewed Medium`);
          }
          throw new Error(
            `${payload?.error || "Retention blocked."}${
              parts.length ? ` Blocked rows: ${parts.join(", ")}.` : ""
            }`,
          );
        }
        throw new Error(payload?.error || "Failed to run retention.");
      }
      toast.success(
        `Retention complete. Deleted ${payload.deleted} log(s) older than ${payload.retentionDays} days.`,
      );
      setConfirmOpen(false);
      refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to run retention.");
    }
  };

  return (
    <section className="container mx-auto py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Audit Log Retention</h1>
        <p className="text-sm text-muted-foreground">
          Review retention settings and run an on-demand purge of old audit logs.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Retention status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {isLoading ? (
            <p className="text-muted-foreground">Loading retention status...</p>
          ) : (
            <>
              <div>
                <span className="font-medium">Retention days:</span>{" "}
                {data?.retentionDays ?? "-"}
              </div>
              <div>
                <span className="font-medium">Cutoff date:</span>{" "}
                {data?.cutoff ? new Date(data.cutoff).toLocaleString() : "-"}
              </div>
              <div>
                <span className="font-medium">Eligible logs:</span>{" "}
                {data?.eligibleCount ?? "-"}
              </div>
              <div>
                <span className="font-medium">Blocked (unreviewed High/Critical):</span>{" "}
                {data?.reviewGuard?.blockedCriticalHigh ?? 0}
              </div>
              <div>
                <span className="font-medium">Blocked (unreviewed Medium):</span>{" "}
                {data?.reviewGuard?.blockedMedium ?? 0}
              </div>
              <div>
                <span className="font-medium">Eligible after review guard:</span>{" "}
                {data?.reviewGuard?.eligibleAfterGuard ?? "-"}
              </div>
            </>
          )}

          <div className="rounded border bg-muted/20 p-3 space-y-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={overrideMediumUnreviewed}
                onChange={(event) => setOverrideMediumUnreviewed(event.target.checked)}
              />
              Allow purge of unreviewed Medium-risk rows for this run (High/Critical remains blocked)
            </label>
            <Input
              placeholder="Override reason (required when checkbox is enabled)"
              value={overrideReason}
              onChange={(event) => setOverrideReason(event.target.value)}
              disabled={!overrideMediumUnreviewed}
            />
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={overrideMediumUnreviewed && overrideReason.trim().length < 8}
            >
              Run retention now
            </Button>
            <Button asChild variant="outline">
              <a href="/admin/import-export">Export audit log</a>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Retention uses the <code>AUDIT_LOG_RETENTION_DAYS</code> environment variable and the
            scheduled cron endpoint for routine cleanup.
          </p>
          <p className="text-xs text-muted-foreground">
            For production, configure a Vercel Cron to call{" "}
            <code>POST /api/admin/audit/retention</code> with{" "}
            <code>Authorization: Bearer &lt;CRON_SECRET&gt;</code>.
          </p>
          <p className="text-xs text-muted-foreground">
            Recommended cadence: nightly (e.g., 2:00 AM local time).
          </p>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Run audit retention now?</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>This will purge logs older than the configured retention window.</p>
            <p>
              High/Critical unreviewed rows are blocked automatically. Medium unreviewed rows
              {overrideMediumUnreviewed ? " will be purged for this run." : " will also be blocked."}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={runRetention}>
              Confirm run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
