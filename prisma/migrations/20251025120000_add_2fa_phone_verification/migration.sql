-- Add 2FA and phone verification columns
ALTER TABLE "User" ADD COLUMN "phoneVerifiedAt" TIMESTAMP NULL;
ALTER TABLE "User" ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "twoFactorSecret" TEXT NULL;

-- Create UserOtp table
CREATE TABLE "UserOtp" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "UserOtp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX "UserOtp_userId_idx" ON "UserOtp" ("userId");
CREATE INDEX "UserOtp_purpose_idx" ON "UserOtp" ("purpose");
CREATE INDEX "UserOtp_expiresAt_idx" ON "UserOtp" ("expiresAt");

