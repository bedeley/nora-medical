-- CreateEnum
CREATE TYPE "TenderBidDisposition" AS ENUM ('AVAILABLE', 'SUBSTITUTE', 'NO_BID');

-- AlterTable
ALTER TABLE "TenderItem"
ADD COLUMN "bidDisposition" "TenderBidDisposition" NOT NULL DEFAULT 'AVAILABLE';
