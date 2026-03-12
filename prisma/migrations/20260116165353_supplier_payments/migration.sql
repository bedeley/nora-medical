-- CreateEnum
CREATE TYPE "SupplierPaymentStatus" AS ENUM ('NORMAL', 'VOID');

-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT,
    "purchaseId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "method" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "status" "SupplierPaymentStatus" NOT NULL DEFAULT 'NORMAL',
    "paidAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierPayment_supplierId_idx" ON "SupplierPayment"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierPayment_purchaseId_idx" ON "SupplierPayment"("purchaseId");

-- CreateIndex
CREATE INDEX "SupplierPayment_createdAt_idx" ON "SupplierPayment"("createdAt");

-- CreateIndex
CREATE INDEX "SupplierPayment_deletedAt_idx" ON "SupplierPayment"("deletedAt");

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
