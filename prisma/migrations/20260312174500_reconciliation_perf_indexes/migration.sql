CREATE INDEX IF NOT EXISTS "Reconciliation_status_createdAt_idx"
ON "Reconciliation"("status", "createdAt");

CREATE INDEX IF NOT EXISTS "Reconciliation_updatedAt_idx"
ON "Reconciliation"("updatedAt");

CREATE INDEX IF NOT EXISTS "Reconciliation_statementBalance_periodEnd_idx"
ON "Reconciliation"("statementBalance", "periodEnd");
