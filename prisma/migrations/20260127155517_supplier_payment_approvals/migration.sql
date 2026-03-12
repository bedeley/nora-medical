-- AlterEnum
ALTER TYPE "SupplierPaymentStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "SupplierPayment" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "proofUrl" TEXT;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
