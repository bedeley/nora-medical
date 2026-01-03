DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'SavedCartItem'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'SavedCartItem'
        AND constraint_name = 'SavedCartItem_productId_fkey'
    ) THEN
      ALTER TABLE "public"."SavedCartItem" DROP CONSTRAINT "SavedCartItem_productId_fkey";
    END IF;

    IF EXISTS (
      SELECT 1
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'SavedCartItem'
        AND constraint_name = 'SavedCartItem_userId_fkey'
    ) THEN
      ALTER TABLE "public"."SavedCartItem" DROP CONSTRAINT "SavedCartItem_userId_fkey";
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'SavedCartItem'
        AND constraint_name = 'SavedCartItem_userId_fkey'
    ) THEN
      ALTER TABLE "public"."SavedCartItem"
        ADD CONSTRAINT "SavedCartItem_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = 'SavedCartItem'
        AND constraint_name = 'SavedCartItem_productId_fkey'
    ) THEN
      ALTER TABLE "public"."SavedCartItem"
        ADD CONSTRAINT "SavedCartItem_productId_fkey"
        FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
  END IF;
END $$;
