-- Add supplier column for product sourcing
ALTER TABLE "Product" ADD COLUMN "supplier" TEXT;

-- Index to speed up supplier filtering/reporting
CREATE INDEX "Product_supplier_idx" ON "Product"("supplier");
