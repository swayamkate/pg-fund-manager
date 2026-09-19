-- PG Manager — make an account work from any device
--
-- Run this once: Supabase → SQL Editor → New query → paste → Run.
-- Safe to run more than once. Every statement checks before it acts.
--
-- Run supabase/schema.sql first if you have not already. This file builds on
-- the profiles table that one creates.
--
--
-- WHAT THIS FIXES
--
-- Signing in already worked on any device — that is Supabase Auth doing its
-- job. What did not travel was everything the account actually contains.
-- Rooms, tenants, rent and the payment history were kept in the browser's
-- own storage, so a new phone would sign in correctly and then show an empty
-- property. The Google Sheet backup could be restored by hand, but a backup
-- you have to remember to restore is not the same as your data being with
-- you.
--
-- After this, the data lives in the database under your account id, and any
-- device you sign in on gets the same property.


-- ---------------------------------------------------------------------------
-- 1. One row per account, holding that account's property
-- ---------------------------------------------------------------------------

-- The whole property is stored as a single JSON document rather than being
-- split into rooms, beds and payment tables.
--
-- That is a deliberate trade. The site already reads and writes exactly this
-- shape, so nothing above the storage layer has to change and there is no
-- migration to get wrong on a deadline. The cost is that the database cannot
-- answer questions like "who owes rent" on its own — only the site can read
-- the contents. If that is ever needed, this table becomes the source to
-- split apart, and nothing else has to move.

create table if not exists public.pg_data (
  owner_id   uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- 2. Keep updated_at honest
-- ---------------------------------------------------------------------------

-- Set in the database rather than sent up by the browser, because a device
-- with the wrong clock should not be able to claim its copy is the newest.

create or replace function public.touch_pg_data()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pg_data_touch on public.pg_data;

create trigger pg_data_touch
  before update on public.pg_data
  for each row execute function public.touch_pg_data();


-- ---------------------------------------------------------------------------
-- 3. Row Level Security
-- ---------------------------------------------------------------------------

-- The anon key sits in config.js where anyone can read it. Without the
-- policies below, that key would read every property in this table.

alter table public.pg_data enable row level security;

drop policy if exists "read own data" on public.pg_data;
create policy "read own data"
  on public.pg_data for select
  using (auth.uid() = owner_id);

drop policy if exists "insert own data" on public.pg_data;
create policy "insert own data"
  on public.pg_data for insert
  with check (auth.uid() = owner_id);

drop policy if exists "update own data" on public.pg_data;
create policy "update own data"
  on public.pg_data for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- No delete policy on purpose. Clearing a property is something the site does
-- by saving an empty one, which leaves the row and its history in place. A
-- mis-click should not be able to remove the record entirely.


-- ---------------------------------------------------------------------------
-- 4. Roles that travel with the account
-- ---------------------------------------------------------------------------

-- Until now "owner" or "staff" was remembered only in the browser that
-- created the account. Sign in somewhere else and you were not the owner any
-- more. It belongs next to the username, where every device can see it.

alter table public.profiles
  add column if not exists role text not null default 'staff';

alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('owner', 'staff'));


-- ---------------------------------------------------------------------------
-- 5. The first account is the owner
-- ---------------------------------------------------------------------------

-- Replaces the version in schema.sql. Same job, plus the role.
--
-- The very first account to exist is yours, so it becomes the owner and
-- everyone invited afterwards is staff. The count is taken inside the
-- database as the row is created, so two people signing up at the same
-- moment cannot both come out as owner.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  first_account boolean;
begin
  select count(*) = 0 into first_account from public.profiles;

  insert into public.profiles (id, role)
  values (new.id, case when first_account then 'owner' else 'staff' end)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Any account made before this file was run still needs a row.
insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

-- And if every existing account came out as staff — which is what would have
-- happened if you signed up before this file existed — promote the oldest one
-- so somebody is the owner.
update public.profiles
set role = 'owner'
where id = (
  select id from public.profiles order by created_at asc limit 1
)
and not exists (
  select 1 from public.profiles where role = 'owner'
);


-- ---------------------------------------------------------------------------
-- 6. Check it worked
-- ---------------------------------------------------------------------------

-- Run this on its own afterwards. It should list your account as the owner.
--
--   select p.id, p.username, p.role, u.email
--   from public.profiles p
--   join auth.users u on u.id = p.id
--   order by p.created_at;
