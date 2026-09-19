-- ============================================================================
-- VERIFY-MIGRATION.sql — is 001_normalized_schema.sql applied? (30 seconds)
-- ============================================================================
-- Run in Supabase SQL Editor. Read-only. Interpretation:
--   setup_complete = true                        -> 001 (and 003) applied
--   setup_complete = false + missing[] rows      -> run those migrations
--   policies = 4 per table                        -> 004 applied
--   trigger_exists = true                         -> 004 cascade trigger live
--   function_exists = true                        -> 005 RPC live

-- 1. Do the three new tables exist?
select
  to_regclass('public.floors')      is not null as floors_ok,
  to_regclass('public.tenants')     is not null as tenants_ok,
  to_regclass('public.rent_ledger') is not null as rent_ledger_ok,
  (to_regclass('public.floors')      is not null
   and to_regclass('public.tenants')     is not null
   and to_regclass('public.rent_ledger') is not null) as setup_complete;

-- 2. Column spot-checks (the exact fields 001 adds to EXISTING tables)
select
  exists (select 1 from information_schema.columns
          where table_schema='public' and table_name='rooms'  and column_name='floor_id')  as rooms_floor_id,
  exists (select 1 from information_schema.columns
          where table_schema='public' and table_name='beds'   and column_name='tenant_id')   as beds_tenant_id,
  exists (select 1 from information_schema.columns
          where table_schema='public' and table_name='beds'   and column_name='payment_info') as beds_payment_info,
  exists (select 1 from information_schema.columns
          where table_schema='public' and table_name='tenants' and column_name='id_proof_url') as tenants_id_proof_url;

-- 3. Strict RLS in place? (expect 4 policies per table, all owner-scoped)
select tablename, count(*) as policies
from pg_policies
where schemaname='public'
  and tablename in ('properties','floors','rooms','beds','tenants','rent_ledger')
group by tablename order by tablename;

-- 4. Cascade tombstone trigger + stats RPC (004 / 005)
select
  exists (select 1 from pg_trigger where tgname='trg_tenant_tombstone' and not tgisinternal) as trigger_exists,
  exists (select 1 from pg_proc where proname='get_owner_stats') as function_exists;

-- 5. Live smoke: call the RPC for your own account (must not error)
select get_owner_stats(auth.uid(), to_char(now(), 'YYYY-MM')) as dashboard_stats;
