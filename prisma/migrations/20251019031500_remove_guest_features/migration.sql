-- Remove guest-related schema: drop FKs, columns, and table

-- Drop foreign key from Order.guestCustomerId if present
ALTER TABLE "Order" DROP CONSTRAINT IF EXISTS "Order_guestCustomerId_fkey";

-- Drop guestCustomerId column on Order if present
ALTER TABLE "Order" DROP COLUMN IF EXISTS "guestCustomerId";

-- Drop isGuest column on User if present
ALTER TABLE "User" DROP COLUMN IF EXISTS "isGuest";

-- Drop GuestCustomer table and related indexes/constraints
DROP TABLE IF EXISTS "GuestCustomer" CASCADE;

