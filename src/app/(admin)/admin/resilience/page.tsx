"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function PlatformResiliencePage() {
  return (
    <section className="container mx-auto py-8 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Platform Resilience</h1>
        <p className="text-sm text-muted-foreground">
          Monitoring, reconciliation, and backup practices to keep the system healthy.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Monitoring & Health Checks</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Track ledger mismatches, missing postings, and MoMo settlement issues.
            </p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/health">Open Health Check</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Backup & Restore Runbook</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Use the documented procedures before major changes or during incident recovery.
            </p>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/resilience/runbook">Open runbook</Link>
            </Button>
            <p className="text-xs text-muted-foreground">
              Runbook: <code>docs/runbooks/backup-restore.text</code>
            </p>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
