-- ============================================================================
-- PG MANAGER — 004_rls_and_cascade.sql
-- ============================================================================
-- Strict owner-scoped RLS for every table the v2 store syncs, plus the
-- cascade soft-delete trigger: tombstoning a tenant (deleted_at = now())
-- automatically frees their bed slot (status = 'vacant').
-- Idempotent: safe to run twice. SECURITY INVOKER throughout (no definer
-- escalation), matching the spec's "Security Invoker Policies".

-- ---------- 1. RLS on / on + force (policies apply even to table owners) ----
alter table properties  enable row level security;
alter table floors      enable row level security;
alter table rooms       enable row level security;
alter table beds        enable row level security;
alter table tenants     enable row level security;
alter table rent_ledger enable row level security;
alter table properties  force row level security;
alter table floors      force row level security;
alter table rooms       force row level security;
alter table beds        force row level security;
alter table tenants     force row level security;
alter table rent_ledger force row level security;

-- ---------- 2. Strict policies: every op requires owner_id = auth.uid() -----
do $$
declare
  t text;
begin
  foreach t in array array['properties','floors','rooms','beds','tenants','rent_ledger'] loop
    -- Replace any pre-existing (possibly looser) policies deterministically.
    execute format('drop policy if exists %I on %I', t || '_select_own',  t);
    execute format('drop policy if exists %I on %I', t || '_insert_own',  t);
    execute format('drop policy if exists %I on %I', t || '_update_own',  t);
    execute format('drop policy if exists %I on %I', t || '_delete_own',  t);
    execute format('drop policy if exists %I on %I', t || '_owner_all',   t);

    execute format($f$
      create policy %I on %I
      for select to authenticated
      using (owner_id = auth.uid())
    $f$, t || '_select_own', t);

    execute format($f$
      create policy %I on %I
      for insert to authenticated
      with check (owner_id = auth.uid())
    $f$, t || '_insert_own', t);

    execute format($f$
      create policy %I on %I
      for update to authenticated
      using (owner_id = auth.uid())
      with check (owner_id = auth.uid())
    $f$, t || '_update_own', t);

    -- DELETE exists only as a defense-in-depth backstop; the app never calls
    -- it (soft deletes travel as tombstone upserts through the outbox).
    execute format($f$
      create policy %I on %I
      for delete to authenticated
      using (owner_id = auth.uid())
    $f$, t || '_delete_own', t);
  end loop;
end $$;

-- ---------- 3. Cascade soft-delete: tombstoned tenant frees the bed ---------
create or replace function pg_tombstone_tenant_free_bed()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Fire only on the transition to deleted (not on every touch of a dead row).
  if new.deleted_at is not null and (old.deleted_at is null) then
    update beds
       set tenant_id = null,
           status = 'vacant',
           updated_at = now()
     where id = new.bed_id
       and owner_id = new.owner_id;   -- owner-scoped even inside the trigger
  end if;
  return new;   -- AFTER trigger: return value ignored, keep it simple
end;
$$;

drop trigger if exists trg_tenant_tombstone on tenants;
create trigger trg_tenant_tombstone
  after update of deleted_at on tenants
  for each row
  execute function pg_tombstone_tenant_free_bed();

-- ---------- 4. Self-check: every table must show 4 strict policies ----------
select t.table_name, count(p.policyname) as policies
from information_schema.tables t
left join pg_policies p
  on p.schemaname = t.table_schema and p.tablename = t.table_name
where t.table_schema = 'public'
  and t.table_name in ('properties','floors','rooms','beds','tenants','rent_ledger')
group by t.table_name
order by t.table_name;
