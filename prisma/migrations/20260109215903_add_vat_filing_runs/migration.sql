-- CreateTable
CREATE TABLE "VatFilingRun" (
    "id" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "summary" JSONB NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VatFilingRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VatFilingRun_startDate_endDate_idx" ON "VatFilingRun"("startDate", "endDate");
