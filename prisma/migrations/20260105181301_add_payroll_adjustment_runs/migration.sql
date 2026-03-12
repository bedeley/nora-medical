-- CreateEnum
CREATE TYPE "PayrollRunType" AS ENUM ('REGULAR', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "PayrollRun" ADD COLUMN     "adjustmentForId" TEXT,
ADD COLUMN     "adjustmentNote" TEXT,
ADD COLUMN     "runType" "PayrollRunType" NOT NULL DEFAULT 'REGULAR';

-- CreateIndex
CREATE INDEX "PayrollRun_runType_idx" ON "PayrollRun"("runType");

-- CreateIndex
CREATE INDEX "PayrollRun_adjustmentForId_idx" ON "PayrollRun"("adjustmentForId");

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_adjustmentForId_fkey" FOREIGN KEY ("adjustmentForId") REFERENCES "PayrollRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
