-- ============================================================================
-- supabase/fresh-project.sql — one paste for a BRAND-NEW Supabase project
-- ============================================================================
-- This is the schema the deployed app actually calls (assets/js/core/*.js).
-- Every table is keyed by `owner_id = auth.uid()`, money is paise-free integer
-- rupees, and Row Level Security is what stops one owner reading another's
-- rows. Nothing here needs a service_role key: run it in SQL Editor.
--
-- Run it once on an empty project. Re-running is safe (IF NOT EXISTS and
-- DROP POLICY IF EXISTS everywhere).
--
-- It is NOT compatible with the org model (`orgs`, `org_members`,
-- `properties.org_id`): if that schema is already in this project, create a
-- separate project instead of mixing the two. `properties` cannot hold both
-- `owner_id` and `org_id` meaningfully.
--
-- After running it, check three dashboard settings:
--   1. Authentication → Providers → Email → "Confirm email" OFF (otherwise a
--      new sign-up cannot sign in until the link is clicked).
--   2. Authentication → Providers → Email → "Allow new users to sign up" ON.
--   3. Project Settings → API → copy the Project URL and the anon / publishable
--      key. Those two values go into the site build, never the service_role
--      key.
-- ============================================================================

-- No extensions needed: gen_random_uuid() is core since PostgreSQL 13 and
-- Supabase runs a newer version than that.

-- ---------------------------------------------------------------------------
-- Refuse to half-apply on a project that already holds a different model
-- ---------------------------------------------------------------------------
-- `create table if not exists` would silently skip a mismatched table and leave
-- the app reading columns that are not there. Two shapes are known to conflict:
-- the org model (properties.org_id) and the old normalized one (profiles with
-- full_name instead of name). Stop with a readable message instead.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'properties'
                and column_name = 'org_id')
     and not exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'properties'
                and column_name = 'owner_id') then
    raise exception 'This project already has the org schema (properties.org_id). The app keys every row by owner_id, so the two cannot share tables. Use a separate project for this file.';
  end if;

  if exists (select 1 from information_schema.tables
              where table_schema = 'public' and table_name = 'profiles')
     and not exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profiles'
                and column_name = 'name') then
    raise exception 'public.profiles exists but has no name column, so it was created by a different schema. Use a project where this file has not been preceded by another model.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per auth account. `id` is the auth user id, which is also the
-- account the app keys every other table by.
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  name       text not null default '',
  username   text unique,
  role       text not null default 'staff' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now()
);

-- One property per owner. The client upserts with id = auth.uid(), so `id` is
-- the row it writes and UNIQUE(owner_id) is what makes that an update rather
-- than a second row (23505 otherwise).
create table if not exists public.properties (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  name          text not null default '',
  owner_name    text not null default '',
  address       text not null default '',
  phone         text not null default '',
  upi_id        text not null default '',
  pg_start_date date,
  property_id   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (owner_id)
);

create table if not exists public.rooms (
  id         text primary key,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  no         text not null default '',
  floor      integer not null default 0,
  rent       numeric(12, 2) not null default 0,
  created_at timestamptz not null default now()
);

-- A bed row exists even while vacant: the client writes empty tenant fields
-- so the slot survives a device change. Ids are `<roomId>-b<index>`.
create table if not exists public.beds (
  id                text primary key,
  room_id           text not null references public.rooms (id) on delete cascade,
  owner_id          uuid not null references auth.users (id) on delete cascade,
  bed_index         integer not null default 0,
  name              text not null default '',
  phone             text not null default '',
  joined            date,
  leaving           date,
  note              text not null default '',
  collect           numeric(12, 2) not null default 0,
  rent              numeric(12, 2),
  deposit           numeric(12, 2) not null default 0,
  id_type           text not null default '',
  id_number         text not null default '',
  emergency_contact text not null default '',
  workplace         text not null default '',
  on_notice         boolean not null default false,
  paid_months       text[] not null default '{}',
  payment_info      jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create table if not exists public.expenses (
  id         text primary key,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  date       date not null default current_date,
  category   text not null default 'Other',
  amount     numeric(12, 2) not null default 0,
  note       text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.rates (
  id         text primary key,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  label      text not null default '',
  amount     numeric(12, 2) not null default 0,
  note       text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.complaints (
  id          text primary key,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  title       text not null default '',
  room_id     text not null default '',
  room_no     text not null default '',
  category    text not null default 'General',
  priority    text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  status      text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  date        date not null default current_date,
  note        text not null default '',
  cost        numeric(12, 2) not null default 0,
  resolved_at date,
  expense_id  text,
  created_at  timestamptz not null default now()
);

create table if not exists public.activity (
  id       text primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  text     text not null default '',
  type     text not null default 'info',
  ts       timestamptz not null default now()
);

-- One row per owner, upserted on owner_id, so owner_id is the primary key.
create table if not exists public.settings (
  owner_id      uuid primary key references auth.users (id) on delete cascade,
  floors        boolean not null default true,
  bed_style     text not null default 'alpha',
  bed_numbering text not null default 'restart'
);

create table if not exists public.rules (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  visiting text not null default '',
  quiet    text not null default '',
  guests   text not null default '',
  lockout  text not null default '',
  other    text not null default ''
);

create index if not exists idx_rooms_owner      on public.rooms (owner_id);
create index if not exists idx_beds_owner       on public.beds (owner_id);
create index if not exists idx_beds_room        on public.beds (room_id);
create index if not exists idx_expenses_owner   on public.expenses (owner_id);
create index if not exists idx_rates_owner      on public.rates (owner_id);
create index if not exists idx_complaints_owner on public.complaints (owner_id);
create index if not exists idx_activity_owner   on public.activity (owner_id);
create index if not exists idx_activity_ts      on public.activity (owner_id, ts desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles   enable row level security;
alter table public.properties enable row level security;
alter table public.rooms      enable row level security;
alter table public.beds       enable row level security;
alter table public.expenses   enable row level security;
alter table public.rates      enable row level security;
alter table public.complaints enable row level security;
alter table public.activity   enable row level security;
alter table public.settings   enable row level security;
alter table public.rules      enable row level security;

-- profiles: you may read and write your own row and nothing else.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles
  for delete to authenticated using (id = auth.uid());

-- Every other table: owner_id must be the signed-in account, on the row you
-- read AND on the row you write. USING guards select/update/delete, WITH CHECK
-- guards insert/update, so a client cannot write a row owned by someone else.
do $$
declare
  t text;
begin
  foreach t in array array[
    'properties', 'rooms', 'beds', 'expenses', 'rates',
    'complaints', 'activity', 'settings', 'rules'
  ] loop
    execute format('drop policy if exists %I on public.%I', 'own_select', t);
    execute format('drop policy if exists %I on public.%I', 'own_insert', t);
    execute format('drop policy if exists %I on public.%I', 'own_update', t);
    execute format('drop policy if exists %I on public.%I', 'own_delete', t);
    execute format('drop policy if exists %I on public.%I', t || '_own', t);

    execute format(
      'create policy own_select on public.%I for select to authenticated using (owner_id = auth.uid())', t);
    execute format(
      'create policy own_insert on public.%I for insert to authenticated with check (owner_id = auth.uid())', t);
    execute format(
      'create policy own_update on public.%I for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
    execute format(
      'create policy own_delete on public.%I for delete to authenticated using (owner_id = auth.uid())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- RLS decides; these only open the door. authenticated gets the tables it
-- writes through RLS.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- The signed-out login page asks "does any account exist yet?" with
-- `select id from profiles limit 1` to decide owner-vs-staff. RLS needs a
-- policy for anon to see any row at all, and the column grant is what limits
-- that to ids — names, usernames and roles stay unreadable without a session.
drop policy if exists profiles_id_probe on public.profiles;
create policy profiles_id_probe on public.profiles
  for select to anon using (true);

revoke all on public.profiles from anon;
grant select (id) on public.profiles to anon;

-- ---------------------------------------------------------------------------
-- New account bootstrap: profile row, plus the property row for the first
-- account so the dashboard has something to open.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_role text;
begin
  v_name := coalesce(
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'name', ''),
    split_part(coalesce(new.email, 'owner'), '@', 1)
  );

  -- Server decides the role: the first account owns the place, later accounts
  -- are staff until the owner invites them.
  v_role := case when exists (select 1 from public.profiles) then 'staff' else 'owner' end;

  insert into public.profiles (id, name, role)
  values (new.id, v_name, v_role)
  on conflict (id) do nothing;

  if v_role = 'owner' then
    insert into public.properties (id, owner_id, name, owner_name)
    values (new.id, new.id, '', v_name)
    on conflict (owner_id) do nothing;
  end if;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Make PostgREST pick the new tables up without waiting for a restart.
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verify (read-only): expect 10 tables, every one with rowsecurity = true.
-- ---------------------------------------------------------------------------
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname in ('profiles','properties','rooms','beds','expenses',
                    'rates','complaints','activity','settings','rules')
order by c.relname;
