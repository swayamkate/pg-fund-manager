-- ============================================================================
-- PG MANAGER — 009_rls_audit_complete.sql  (Module 5: complete RLS audit)
-- ============================================================================
-- Every public table: RLS ENABLED + FORCED, with strict owner-scoped policies
-- for SELECT / INSERT / UPDATE / DELETE. Idempotent — replaces older looser
-- policies deterministically. Ends with an audit query: any row showing
-- rls_enabled = false or policies < 4 is a gap to fix immediately.

do $$
declare
  t text;
begin
  -- All tables the two apps read/write, including the legacy-only ones.
  foreach t in array array[
    'properties','floors','rooms','beds','tenants','rent_ledger',
    'expenses','complaints','activity','settings','rules','profiles'
  ] loop
    continue when to_regformat('public.' || t) is null;   -- table absent: skip

    execute format('alter table public.%I enable row level security;', t);
    execute format('alter table public.%I force row level security;', t);

    -- Drop older / looser policies, then apply the strict set.
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_all', t);

    execute format($f$
      create policy %I on public.%I for select to authenticated
      using (owner_id = auth.uid())
    $f$, t || '_select_own', t);

    execute format($f$
      create policy %I on public.%I for insert to authenticated
      with check (owner_id = auth.uid())
    $f$, t || '_insert_own', t);

    execute format($f$
      create policy %I on public.%I for update to authenticated
      using (owner_id = auth.uid())
      with check (owner_id = auth.uid())
    $f$, t || '_update_own', t);

    execute format($f$
      create policy %I on public.%I for delete to authenticated
      using (owner_id = auth.uid())
    $f$, t || '_delete_own', t);
  end loop;
end $$;

-- ---------- AUDIT: run this any time to prove complete isolation ----------
select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relname;
