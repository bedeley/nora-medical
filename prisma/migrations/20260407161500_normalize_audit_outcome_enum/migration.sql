DO $$
BEGIN
  CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILED', 'PARTIAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
DECLARE
  outcome_data_type TEXT;
  outcome_udt_name TEXT;
BEGIN
  SELECT data_type, udt_name
  INTO outcome_data_type, outcome_udt_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'AuditLog'
    AND column_name = 'outcome';

  IF outcome_data_type IS NULL THEN
    ALTER TABLE "AuditLog" ADD COLUMN "outcome" "AuditOutcome";
  ELSIF outcome_data_type = 'USER-DEFINED' AND outcome_udt_name = 'AuditOutcome' THEN
    NULL;
  ELSE
    ALTER TABLE "AuditLog"
      ALTER COLUMN "outcome" TYPE "AuditOutcome"
      USING CASE
        WHEN "outcome" IS NULL THEN NULL
        WHEN UPPER(BTRIM("outcome")) IN ('SUCCESS', 'FAILED', 'PARTIAL')
          THEN UPPER(BTRIM("outcome"))::"AuditOutcome"
        ELSE NULL
      END;
  END IF;
END $$;
