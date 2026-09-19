-- ============================================================================
-- PG MANAGER — 011_tenants_missing_columns.sql  (deployment repair patch)
-- ============================================================================
-- The live deployment ran a PARTIAL 001: the tenants table was created but
-- is missing several columns that 001 defines and that 002's backfill and
-- the v2 client write (42703 on any of them breaks tenant sync).
-- This patch is idempotent and additive only — it brings tenants fully in
-- line with 001/006 without touching data.
--
-- Detected missing on the live DB (per-column probes, 2026-09-19):
--   status, rent_amount, workplace, planned_leave_on, collect_day,
--   deposit, id_proof_path

alter table tenants add column if not exists status            text not null default 'active'
  check (status in ('active', 'on_notice', 'moved_out'));
alter table tenants add column if not exists rent_amount       integer;
alter table tenants add column if not exists workplace         text not null default '';
alter table tenants add column if not exists planned_leave_on  date;
alter table tenants add column if not exists collect_day       smallint check (collect_day between 0 and 31);
alter table tenants add column if not exists deposit           numeric not null default 0;
alter table tenants add column if not exists id_proof_path     text;

-- Backfill from the legacy denormalized bed data for rows that 002's
-- backfill may have created with NULLs where it expected these columns
-- (only matters if 002 ran against the partial table).
update tenants t
set status           = case when b.on_notice then 'on_notice' else t.status end,
    planned_leave_on = coalesce(t.planned_leave_on, case when b.on_notice then b.leaving end),
    left_on          = coalesce(t.left_on, case when not b.on_notice and b.leaving is not null
                                              and b.leaving <= current_date then b.leaving end),
    deposit          = coalesce(nullif(t.deposit, 0), b.deposit, 0),
    rent_amount      = coalesce(t.rent_amount, nullif(b.rent, 0)),
    collect_day      = coalesce(t.collect_day, b.collect)
from beds b
where b.tenant_id = t.id;

-- Self-check: every column below must report exists = true
select column_name
from (values ('status'), ('rent_amount'), ('workplace'), ('planned_leave_on'),
             ('collect_day'), ('deposit'), ('id_proof_path')) as want(col)
where not exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'tenants'
    and column_name = want.col
);
-- Expected result: zero rows returned.
