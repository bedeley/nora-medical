-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('REGISTERED', 'WALK_IN');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "customerType" "CustomerType" NOT NULL DEFAULT 'REGISTERED',
ADD COLUMN     "walkInName" TEXT,
ADD COLUMN     "walkInPhone" TEXT;
