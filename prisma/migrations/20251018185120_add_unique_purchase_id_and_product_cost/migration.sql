-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "costAtSale" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "cost" DECIMAL(10,2) NOT NULL DEFAULT 0;
