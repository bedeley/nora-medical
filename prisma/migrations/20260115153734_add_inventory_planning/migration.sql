-- CreateTable
CREATE TABLE "InventoryPlan" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "reorderPoint" INTEGER NOT NULL DEFAULT 0,
    "safetyStock" INTEGER NOT NULL DEFAULT 0,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 14,
    "reviewPeriodDays" INTEGER NOT NULL DEFAULT 60,
    "minOrderQty" INTEGER NOT NULL DEFAULT 1,
    "targetStock" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemandSnapshot" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "unitsSold" INTEGER NOT NULL DEFAULT 0,
    "avgDailyDemand" DECIMAL(10,4) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'orders',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemandSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestockSuggestion" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "suggestedQty" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestockSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPlan_productId_key" ON "InventoryPlan"("productId");

-- CreateIndex
CREATE INDEX "InventoryPlan_productId_idx" ON "InventoryPlan"("productId");

-- CreateIndex
CREATE INDEX "DemandSnapshot_productId_periodStart_periodEnd_idx" ON "DemandSnapshot"("productId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "DemandSnapshot_createdAt_idx" ON "DemandSnapshot"("createdAt");

-- CreateIndex
CREATE INDEX "RestockSuggestion_productId_idx" ON "RestockSuggestion"("productId");

-- CreateIndex
CREATE INDEX "RestockSuggestion_status_idx" ON "RestockSuggestion"("status");

-- AddForeignKey
ALTER TABLE "InventoryPlan" ADD CONSTRAINT "InventoryPlan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandSnapshot" ADD CONSTRAINT "DemandSnapshot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestockSuggestion" ADD CONSTRAINT "RestockSuggestion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
