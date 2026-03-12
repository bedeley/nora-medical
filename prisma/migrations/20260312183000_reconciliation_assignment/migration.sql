ALTER TABLE "Reconciliation"
ADD COLUMN IF NOT EXISTS "assignedToId" TEXT;

CREATE INDEX IF NOT EXISTS "Reconciliation_assignedToId_status_idx"
ON "Reconciliation"("assignedToId", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'Reconciliation_assignedToId_fkey'
      AND table_name = 'Reconciliation'
  ) THEN
    ALTER TABLE "Reconciliation"
    ADD CONSTRAINT "Reconciliation_assignedToId_fkey"
    FOREIGN KEY ("assignedToId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
