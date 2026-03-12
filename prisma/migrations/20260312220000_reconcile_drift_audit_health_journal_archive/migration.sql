-- Reconcile migration history with existing dev database objects.
-- This migration is intentionally additive and represents objects that already
-- exist in local databases created via db push/manual drift.

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AuditSavedFilter" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditSavedFilter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthIncident" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "issueCount" INTEGER NOT NULL DEFAULT 0,
    "issueSummary" TEXT NOT NULL,
    "followUpDueAt" TIMESTAMP(3),
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" TEXT,
    "ownerId" TEXT,
    "ownerName" TEXT,
    "resolvedById" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusUpdatedAt" TIMESTAMP(3),
    "statusUpdatedById" TEXT,
    "statusUpdatedByName" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthIncidentNote" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthIncidentNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JournalEntry_archivedAt_entryDate_idx" ON "JournalEntry"("archivedAt", "entryDate");

-- CreateIndex
CREATE UNIQUE INDEX "AuditSavedFilter_ownerId_name_key" ON "AuditSavedFilter"("ownerId", "name");

-- CreateIndex
CREATE INDEX "AuditSavedFilter_ownerId_isShared_idx" ON "AuditSavedFilter"("ownerId", "isShared");

-- CreateIndex
CREATE INDEX "AuditSavedFilter_isShared_createdAt_idx" ON "AuditSavedFilter"("isShared", "createdAt");

-- CreateIndex
CREATE INDEX "HealthIncident_fingerprint_createdAt_idx" ON "HealthIncident"("fingerprint", "createdAt");

-- CreateIndex
CREATE INDEX "HealthIncident_isManual_createdAt_idx" ON "HealthIncident"("isManual", "createdAt");

-- CreateIndex
CREATE INDEX "HealthIncident_status_createdAt_idx" ON "HealthIncident"("status", "createdAt");

-- CreateIndex
CREATE INDEX "HealthIncident_ownerId_createdAt_idx" ON "HealthIncident"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "HealthIncident_openedAt_idx" ON "HealthIncident"("openedAt");

-- CreateIndex
CREATE INDEX "HealthIncidentNote_incidentId_createdAt_idx" ON "HealthIncidentNote"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "HealthIncidentNote_createdById_idx" ON "HealthIncidentNote"("createdById");

-- AddForeignKey
ALTER TABLE "AuditSavedFilter" ADD CONSTRAINT "AuditSavedFilter_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthIncident" ADD CONSTRAINT "HealthIncident_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthIncident" ADD CONSTRAINT "HealthIncident_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthIncident" ADD CONSTRAINT "HealthIncident_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthIncidentNote" ADD CONSTRAINT "HealthIncidentNote_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "HealthIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthIncidentNote" ADD CONSTRAINT "HealthIncidentNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
