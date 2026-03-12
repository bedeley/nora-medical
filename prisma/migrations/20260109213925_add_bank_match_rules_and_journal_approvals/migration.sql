-- CreateEnum
CREATE TYPE "BankMatchMode" AS ENUM ('CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'REGEX');

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT;

-- CreateTable
CREATE TABLE "BankMatchRule" (
    "id" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "matchText" TEXT NOT NULL,
    "matchMode" "BankMatchMode" NOT NULL DEFAULT 'CONTAINS',
    "accountId" TEXT,
    "minAmount" DECIMAL(12,2),
    "maxAmount" DECIMAL(12,2),
    "amountTolerance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankMatchRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankMatchRule_bankAccountId_idx" ON "BankMatchRule"("bankAccountId");

-- CreateIndex
CREATE INDEX "BankMatchRule_accountId_idx" ON "BankMatchRule"("accountId");

-- CreateIndex
CREATE INDEX "JournalEntry_approvedById_idx" ON "JournalEntry"("approvedById");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMatchRule" ADD CONSTRAINT "BankMatchRule_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMatchRule" ADD CONSTRAINT "BankMatchRule_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
