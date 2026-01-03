-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "reason" TEXT,
ADD COLUMN     "vendor" TEXT;

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "reason" TEXT;
