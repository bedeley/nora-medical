-- AlterTable
ALTER TABLE "InventoryMovement" ADD COLUMN     "reasonCode" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "requiresExpiryDate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requiresLotTracking" BOOLEAN NOT NULL DEFAULT false;
