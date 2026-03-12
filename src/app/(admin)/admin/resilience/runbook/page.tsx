"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const runbookText = `Backup & Restore Runbook (PostgreSQL)

Scope
- This runbook covers database backups and restores for production and staging.
- Keep backups encrypted and access-controlled.

Backup cadence (recommended)
- Daily: full logical backup (pg_dump)
- Weekly: full snapshot + offsite copy
- Before risky changes: manual backup

Environment variables used
- DATABASE_URL (Postgres connection string)
- BACKUP_DIR (optional local folder)

Create a backup (logical)
1) Set a destination:
   - Windows: set BACKUP_DIR=C:\\backups\\nora
   - macOS/Linux: export BACKUP_DIR=~/backups/nora
2) Run:
   - pg_dump --format=custom --file "%BACKUP_DIR%/nora_YYYYMMDD.dump" "%DATABASE_URL%"

Restore a backup (logical)
1) Verify target DB is correct (staging vs production).
2) Run:
   - pg_restore --clean --if-exists --dbname "%DATABASE_URL%" "%BACKUP_DIR%/nora_YYYYMMDD.dump"

Verify after restore
- Open /admin/health and confirm mismatches are zero.
- Check latest order, inventory counts, and payments.

Notes
- Use a restricted admin account for backup/restore.
- Store backup metadata (date, environment, operator) in an internal log.`;

export default function ResilienceRunbookPage() {
  const downloadTxt = () => {
    const blob = new Blob([runbookText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `backup-restore-runbook-${Date.now()}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="container mx-auto py-8 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Backup & Restore Runbook</h1>
          <p className="text-sm text-muted-foreground">
            Operational checklist for database backups and restores.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={downloadTxt}>
            Download TXT
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/resilience">Back to Resilience</Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">Runbook</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-sm leading-relaxed">
            {runbookText}
          </pre>
        </CardContent>
      </Card>
    </section>
  );
}
