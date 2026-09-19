-- ============================================================================
-- PG MANAGER — 008_dashboard_summary_rpc.sql  (Module 2: one-call dashboard)
-- ============================================================================
-- get_owner_dashboard_summary(p_owner_id) = the WHOLE dashboard in one
-- database round-trip: bed counts, current-month collection, pending due
-- money, overdue tenant count. SECURITY INVOKER — runs as the calling
-- owner, so RLS scopes every number; the parameter is a cross-check.
-- Supersedes 005's get_owner_stats (kept for compatibility).

create or replace function get_owner_dashboard_summary(p_owner_id uuid, p_period text default null)
returns json
language sql
security invoker
stable
set search_path = public
as $$
  select json_build_object(
    'period',            coalesce(p_period, to_char(now(), 'YYYY-MM')),
    'total_beds',        coalesce(b.total_beds, 0),
    'occupied_beds',     coalesce(b.occupied_beds, 0),
    'active_tenants',    coalesce(t.active_tenants, 0),
    'current_month_collection', coalesce(l.collected, 0),
    'pending_due_amount',coalesce(l.pending_due, 0),
    'overdue_tenants_count',    coalesce(l.overdue_count, 0),
    'paid_count',        coalesce(l.paid_count, 0),
    'due_count',         coalesce(l.due_count, 0)
  )
  from
    (select count(*)::int as total_beds,
            count(*) filter (where tenant_id is not null)::int as occupied_beds
       from beds
      where owner_id = p_owner_id and deleted_at is null) b,
    (select count(*)::int as active_tenants
       from tenants
      where owner_id = p_owner_id and deleted_at is null and status = 'active') t,
    (select
       coalesce(sum(paid) filter (where status = 'paid'), 0)::numeric as collected,
       coalesce(sum(due - paid) filter (where status in ('pending','overdue')), 0)::numeric as pending_due,
       count(*) filter (where status = 'overdue')::int as overdue_count,
       count(*) filter (where status = 'paid')::int as paid_count,
       count(*) filter (where status = 'pending')::int as due_count
       from rent_ledger
      where owner_id = p_owner_id
        and deleted_at is null
        and period = coalesce(p_period, to_char(now(), 'YYYY-MM'))) l;
$$;

-- Self-check: exists + invoker-run
select proname, prosecdef as is_security_definer
from pg_proc
where proname = 'get_owner_dashboard_summary';
