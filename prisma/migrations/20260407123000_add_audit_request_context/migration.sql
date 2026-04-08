ALTER TABLE "AuditLog"
ADD COLUMN IF NOT EXISTS "ipAddress" TEXT,
ADD COLUMN IF NOT EXISTS "userAgent" TEXT,
ADD COLUMN IF NOT EXISTS "requestId" TEXT,
ADD COLUMN IF NOT EXISTS "outcome" TEXT;

CREATE INDEX IF NOT EXISTS "AuditLog_requestId_idx" ON "AuditLog"("requestId");
CREATE INDEX IF NOT EXISTS "AuditLog_outcome_idx" ON "AuditLog"("outcome");
