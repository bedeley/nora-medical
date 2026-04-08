-- AlterTable
ALTER TABLE "CashReconciliation" ADD COLUMN     "isOpeningBalance" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reconcileMode" TEXT NOT NULL DEFAULT 'operational';
