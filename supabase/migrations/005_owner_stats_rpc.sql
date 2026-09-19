-- ============================================================================
-- PG MANAGER — 005_owner_stats_rpc.sql
-- ============================================================================
-- One RPC call powers the whole dashboard on cold load: active tenants,
-- occupied beds, monthly collection progress (money + paid/total), overdue
-- count + amount. SECURITY INVOKER (spec): runs as the calling owner, so
-- RLS naturally scopes every number to auth.uid() — the parameter is only
-- a cross-check, not the authority.
--
-- p_period format: 'YYYY-MM' (defaults to the current month).
-- Returns a single JSON row so the client does zero post-processing.

create or replace function get_owner_stats(p_owner_id uuid, p_period text default null)
returns json
language sql
security invoker
stable
set search_path = public
as $$
  select json_build_object(
    'activeTenants', coalesce(t.active_tenants, 0),
    'occupiedBeds',  coalesce(b.occupied_beds, 0),
    'totalBeds',     coalesce(b.total_beds, 0),
    'collected',     coalesce(l.collected, 0),
    'paidCount',     coalesce(l.paid_count, 0),
    'dueCount',      coalesce(l.due_count, 0),
    'overdueCount',  coalesce(l.overdue_count, 0),
    'overdueAmount', coalesce(l.overdue_amount, 0),
    'period',        coalesce(p_period, to_char(now(), 'YYYY-MM'))
  )
  from
    (select count(*)::int as active_tenants
       from tenants
      where owner_id = p_owner_id
        and deleted_at is null
        and status = 'active') t,
    (select count(*) filter (where tenant_id is not null)::int as occupied_beds,
            count(*)::int as total_beds
       from beds
      where owner_id = p_owner_id
        and deleted_at is null) b,
    (select
       coalesce(sum(paid) filter (where status = 'paid'), 0)::numeric as collected,
       count(*) filter (where status = 'paid')::int as paid_count,
       count(*) filter (where status = 'pending')::int as due_count,
       count(*) filter (where status = 'overdue')::int as overdue_count,
       coalesce(sum(due - paid) filter (where status = 'overdue'), 0)::numeric as overdue_amount
       from rent_ledger
      where owner_id = p_owner_id
        and deleted_at is null
        and period = coalesce(p_period, to_char(now(), 'YYYY-MM'))) l;
$$;

-- Self-check: the function must exist and be invoker-run.
select proname, prosecdef as is_security_definer
from pg_proc
where proname = 'get_owner_stats';
