-- Add brand column for product branding
ALTER TABLE "Product" ADD COLUMN "brand" TEXT;

-- Index to speed up brand filtering/reporting
CREATE INDEX "Product_brand_idx" ON "Product"("brand");
