CREATE UNIQUE INDEX IF NOT EXISTS "Reconciliation_bankAccountId_periodStart_periodEnd_key"
ON "Reconciliation"("bankAccountId", "periodStart", "periodEnd");
