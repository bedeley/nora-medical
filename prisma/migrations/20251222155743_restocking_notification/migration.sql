-- DropForeignKey
ALTER TABLE "public"."StockAlert" DROP CONSTRAINT "StockAlert_productId_fkey";

-- AddForeignKey
ALTER TABLE "StockAlert" ADD CONSTRAINT "StockAlert_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
