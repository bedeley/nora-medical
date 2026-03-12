-- CreateEnum
CREATE TYPE "CompensationStatus" AS ENUM ('DRAFT', 'PENDING', 'ACTIVE');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('PENDING', 'COMPLETE');

-- AlterTable
ALTER TABLE "Compensation" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "status" "CompensationStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "OnboardingTask" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "OnboardingStatus" NOT NULL DEFAULT 'PENDING',
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnboardingTask_employeeId_idx" ON "OnboardingTask"("employeeId");

-- CreateIndex
CREATE INDEX "OnboardingTask_status_idx" ON "OnboardingTask"("status");

-- CreateIndex
CREATE INDEX "Compensation_status_idx" ON "Compensation"("status");

-- AddForeignKey
ALTER TABLE "OnboardingTask" ADD CONSTRAINT "OnboardingTask_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
