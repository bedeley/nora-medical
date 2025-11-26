-- Add enums for payment status and refund destination
CREATE TYPE "PaymentStatus" AS ENUM ('NORMAL', 'REFUND', 'VOID');
CREATE TYPE "RefundDestination" AS ENUM ('CASH', 'CREDIT');

ALTER TABLE "Payment"
  ADD COLUMN "status" "PaymentStatus" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "refundDisposition" "RefundDestination";
