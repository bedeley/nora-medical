-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "isReversal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reversalOfId" TEXT;

-- CreateIndex
CREATE INDEX "Expense_reversalOfId_idx" ON "Expense"("reversalOfId");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
