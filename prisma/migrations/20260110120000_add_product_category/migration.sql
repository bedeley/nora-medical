-- Add category column for product filtering
ALTER TABLE "Product" ADD COLUMN "category" TEXT;

-- Index to speed up category filtering
CREATE INDEX "Product_category_idx" ON "Product"("category");
