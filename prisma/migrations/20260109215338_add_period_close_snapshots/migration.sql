-- CreateTable
CREATE TABLE "PeriodCloseSnapshot" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeriodCloseSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PeriodCloseSnapshot_periodId_idx" ON "PeriodCloseSnapshot"("periodId");

-- AddForeignKey
ALTER TABLE "PeriodCloseSnapshot" ADD CONSTRAINT "PeriodCloseSnapshot_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "FiscalPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
