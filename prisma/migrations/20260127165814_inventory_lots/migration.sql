-- DropIndex
DROP INDEX "public"."InventoryMovement_purchaseId_key";

-- AlterTable
ALTER TABLE "InventoryMovement" ADD COLUMN     "lotId" TEXT;

-- CreateTable
CREATE TABLE "InventoryLot" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "supplierId" TEXT,
    "lotCode" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quantityReceived" INTEGER NOT NULL,
    "quantityRemaining" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryLot_productId_expiryDate_idx" ON "InventoryLot"("productId", "expiryDate");

-- CreateIndex
CREATE INDEX "InventoryLot_lotCode_idx" ON "InventoryLot"("lotCode");

-- CreateIndex
CREATE INDEX "InventoryLot_purchaseId_idx" ON "InventoryLot"("purchaseId");

-- CreateIndex
CREATE INDEX "InventoryLot_supplierId_idx" ON "InventoryLot"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLot_productId_lotCode_key" ON "InventoryLot"("productId", "lotCode");

-- CreateIndex
CREATE INDEX "InventoryMovement_purchaseId_idx" ON "InventoryMovement"("purchaseId");

-- CreateIndex
CREATE INDEX "InventoryMovement_lotId_idx" ON "InventoryMovement"("lotId");

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "InventoryLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLot" ADD CONSTRAINT "InventoryLot_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
