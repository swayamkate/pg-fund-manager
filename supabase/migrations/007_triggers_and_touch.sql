-- ============================================================================
-- PG MANAGER — 007_triggers_and_touch.sql  (Module 1: zero-latency cascades)
-- ============================================================================
-- 1) on_tenant_checkout: a tenant row updated with left_on / deleted_at set
--    automatically frees its bed (status='vacant', tenant_id=NULL).
--    (Supersedes 004's tombstone-only trigger with the wider checkout rule.)
-- 2) updated_at touch triggers on all six synced tables — every UPDATE
--    stamps updated_at = now(), which the outbox sync uses for newest-wins
--    merge. 001 only covered tenants + rent_ledger; this completes the set.
-- Idempotent: safe to run twice.

-- ---------- 1. Checkout / tombstone cascade ----------
create or replace function pg_tenant_checkout_free_bed()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Fire on the transition into checked-out or deleted (not on every touch).
  if (new.left_on is not null and old.left_on is null)
     or (new.deleted_at is not null and old.deleted_at is null) then
    update beds
       set tenant_id = null,
           status = 'vacant',
           updated_at = now()
     where id = new.bed_id
       and owner_id = new.owner_id;   -- owner-scoped even inside the trigger
  end if;
  return new;   -- AFTER trigger: return value ignored
end;
$$;

drop trigger if exists trg_tenant_tombstone on tenants;   -- replaced by the wider rule
drop trigger if exists trg_tenant_checkout on tenants;
create trigger trg_tenant_checkout
  after update of left_on, deleted_at on tenants
  for each row
  execute function pg_tenant_checkout_free_bed();

-- ---------- 2. updated_at touch triggers (complete the set) ----------
create or replace function set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['properties','floors','rooms','beds','tenants','rent_ledger'] loop
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format($f$
      create trigger %I before update on %I
      for each row execute function set_updated_at()
    $f$, t || '_touch', t);
  end loop;
end $$;

-- ---------- 3. Self-check ----------
select tgrelid::regclass as table_name, tgname
from pg_trigger
where not tgisinternal
  and (tgname like '%_touch' or tgname = 'trg_tenant_checkout')
order by tgrelid::regclass::text, tgname;
