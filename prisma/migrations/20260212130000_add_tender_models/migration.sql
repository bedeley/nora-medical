-- CreateEnum
CREATE TYPE "TenderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'SENT', 'WON', 'LOST', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TenderMatchConfidence" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "TenderRecipientType" AS ENUM ('TO', 'CC', 'BCC');

-- CreateEnum
CREATE TYPE "TenderDeliveryChannel" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "TenderDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "Tender" (
    "id" TEXT NOT NULL,
    "tenderNumber" TEXT NOT NULL,
    "status" "TenderStatus" NOT NULL DEFAULT 'DRAFT',
    "buyerName" TEXT NOT NULL,
    "buyerContact" TEXT,
    "buyerEmail" TEXT,
    "tenderRef" TEXT,
    "lotTitle" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "validityDays" INTEGER NOT NULL DEFAULT 14,
    "notes" TEXT,
    "vatRatePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "freightAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "handlingAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "leadTimeDays" INTEGER,
    "paymentTerms" TEXT,
    "marginThresholdPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "itemsText" TEXT NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "preparedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenderItem" (
    "id" TEXT NOT NULL,
    "tenderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "requestedDescription" TEXT NOT NULL,
    "requestedUnit" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "matchedProductId" TEXT,
    "matchedProductName" TEXT,
    "matchedSku" TEXT,
    "availableStock" INTEGER,
    "baseCost" DECIMAL(10,2),
    "marginPct" DECIMAL(8,2),
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "lineTotal" DECIMAL(12,2) NOT NULL,
    "matchConfidence" "TenderMatchConfidence" NOT NULL DEFAULT 'NONE',
    "note" TEXT,
    "leadTimeDays" INTEGER,
    "supplyNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenderVersion" (
    "id" TEXT NOT NULL,
    "tenderId" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "status" "TenderStatus" NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changeNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenderVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenderRecipient" (
    "id" TEXT NOT NULL,
    "tenderId" TEXT NOT NULL,
    "recipientType" "TenderRecipientType" NOT NULL DEFAULT 'TO',
    "email" TEXT NOT NULL,
    "deliveryChannel" "TenderDeliveryChannel" NOT NULL DEFAULT 'EMAIL',
    "deliveryStatus" "TenderDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "lastSentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "sentById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenderRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tender_tenderNumber_key" ON "Tender"("tenderNumber");

-- CreateIndex
CREATE INDEX "Tender_status_idx" ON "Tender"("status");

-- CreateIndex
CREATE INDEX "Tender_preparedById_idx" ON "Tender"("preparedById");

-- CreateIndex
CREATE INDEX "Tender_createdAt_idx" ON "Tender"("createdAt");

-- CreateIndex
CREATE INDEX "Tender_deletedAt_idx" ON "Tender"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TenderItem_tenderId_lineNo_key" ON "TenderItem"("tenderId", "lineNo");

-- CreateIndex
CREATE INDEX "TenderItem_matchedProductId_idx" ON "TenderItem"("matchedProductId");

-- CreateIndex
CREATE INDEX "TenderItem_tenderId_lineNo_idx" ON "TenderItem"("tenderId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "TenderVersion_tenderId_versionNo_key" ON "TenderVersion"("tenderId", "versionNo");

-- CreateIndex
CREATE INDEX "TenderVersion_createdById_idx" ON "TenderVersion"("createdById");

-- CreateIndex
CREATE INDEX "TenderVersion_createdAt_idx" ON "TenderVersion"("createdAt");

-- CreateIndex
CREATE INDEX "TenderRecipient_tenderId_deliveryStatus_idx" ON "TenderRecipient"("tenderId", "deliveryStatus");

-- CreateIndex
CREATE INDEX "TenderRecipient_email_idx" ON "TenderRecipient"("email");

-- CreateIndex
CREATE INDEX "TenderRecipient_sentById_idx" ON "TenderRecipient"("sentById");

-- AddForeignKey
ALTER TABLE "Tender" ADD CONSTRAINT "Tender_preparedById_fkey" FOREIGN KEY ("preparedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenderItem" ADD CONSTRAINT "TenderItem_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenderItem" ADD CONSTRAINT "TenderItem_matchedProductId_fkey" FOREIGN KEY ("matchedProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenderVersion" ADD CONSTRAINT "TenderVersion_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenderVersion" ADD CONSTRAINT "TenderVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenderRecipient" ADD CONSTRAINT "TenderRecipient_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenderRecipient" ADD CONSTRAINT "TenderRecipient_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
