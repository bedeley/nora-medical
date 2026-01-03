-- Saved cart items for "save for later"
CREATE TABLE "SavedCartItem" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SavedCartItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SavedCartItem_userId_productId_key" ON "SavedCartItem"("userId", "productId");
CREATE INDEX "SavedCartItem_userId_idx" ON "SavedCartItem"("userId");
CREATE INDEX "SavedCartItem_productId_idx" ON "SavedCartItem"("productId");

ALTER TABLE "SavedCartItem" ADD CONSTRAINT "SavedCartItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SavedCartItem" ADD CONSTRAINT "SavedCartItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
