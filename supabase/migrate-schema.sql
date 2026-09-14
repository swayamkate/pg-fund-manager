-- PG Manager — schema alignment migration (run once in Supabase SQL Editor)
-- Aligns the LIVE database with what supabase-storage.js writes today.
-- Safe to run multiple times; every statement checks before acting.
--
-- WHY: supabase-storage.js upserts beds WITH payment_info (jsonb). The live DB
-- is missing `beds.payment_info`, so every tenant (bed) write fails with
-- Postgres 42703 after 5 retries — that failure locks the whole app
-- ("Database unreachable — all edits blocked") and new tenants never persist.
--
-- After running: hard-reload the app (Ctrl+Shift+R) and add the tenant again.

-- 1. beds: payment_info (the confirmed missing column)
ALTER TABLE public.beds
  ADD COLUMN IF NOT EXISTS payment_info JSONB DEFAULT '{}'::jsonb;

-- 2. Defensive: make sure every table the client writes has owner_id.
--    (The live DB was built from schema.sql, which already has owner_id on all
--    tables — these are no-ops there, but they repair a DB built from the
--    older data-schema.sql, which used account_id instead.)
DO $$
DECLARE
  t text;
  has_owner boolean;
  has_account boolean;
  tables text[] := ARRAY['rooms','expenses','rates','complaints','activity','settings','rules'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=t AND column_name='owner_id')
      INTO has_owner;
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name=t AND column_name='account_id')
      INTO has_account;

    IF NOT has_owner THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE', t);
      has_owner := true;
    END IF;

    -- Backfill from account_id only when that column actually exists.
    IF has_account THEN
      EXECUTE format(
        'UPDATE public.%I SET owner_id = account_id WHERE owner_id IS NULL AND account_id IS NOT NULL', t);
    END IF;

    -- Fill any still-null owner_id rows from bed/room linkage is not needed:
    -- owner_id is NOT NULL in schema.sql builds, and new writes always set it.
  END LOOP;
END $$;

-- 3. Sanity report (shows in the SQL editor Messages tab)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='beds' AND column_name='payment_info') THEN
    RAISE NOTICE 'OK: beds.payment_info exists — tenant saves will work';
  ELSE
    RAISE NOTICE 'WARNING: beds.payment_info still missing';
  END IF;
END $$;
