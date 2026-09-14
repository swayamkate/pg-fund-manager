-- PG Manager — Supabase data tables
--
-- Run this once in your project: Supabase → SQL Editor → New query → paste → Run.
-- Safe to run more than once; every statement checks first.
--
-- Stores rooms, beds (tenants), and expenses per account. Row Level Security
-- ensures one account can never read or write another's data.

-- ---------------------------------------------------------------------------
-- 1. Rooms
-- ---------------------------------------------------------------------------

create table if not exists public.rooms (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.users(id) on delete cascade,
  no         text not null,
  floor      integer not null default 0,
  rent       integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists rooms_account_idx on public.rooms (account_id);

-- ---------------------------------------------------------------------------
-- 2. Beds (one row per bed slot; tenant data lives here when occupied)
-- ---------------------------------------------------------------------------

create table if not exists public.beds (
  id               uuid primary key default gen_random_uuid(),
  room_id          uuid not null references public.rooms(id) on delete cascade,
  account_id       uuid not null references auth.users(id) on delete cascade,
  bed_index        integer not null default 0,
  name             text,
  phone            text,
  joined           text,
  leaving          text,
  note             text default '',
  collect          integer default 0,
  rent             integer,
  deposit          integer default 0,
  id_type          text default '',
  id_number        text default '',
  emergency_contact text default '',
  workplace        text default '',
  on_notice        boolean default false,
  paid_months      text[] default '{}',
  payment_info     jsonb default '{}'::jsonb,
  created_at       timestamptz not null default now(),

  unique (room_id, bed_index)
);

create index if not exists beds_account_idx on public.beds (account_id);
create index if not exists beds_room_idx on public.beds (room_id);

-- ---------------------------------------------------------------------------
-- 3. Expenses
-- ---------------------------------------------------------------------------

create table if not exists public.expenses (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.users(id) on delete cascade,
  date       text,
  category   text default 'Other',
  note       text default '',
  amount     integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists expenses_account_idx on public.expenses (account_id);

-- ---------------------------------------------------------------------------
-- 4. Row Level Security
-- ---------------------------------------------------------------------------

alter table public.rooms enable row level security;
alter table public.beds enable row level security;
alter table public.expenses enable row level security;

-- Rooms: read / insert / update / delete own only
drop policy if exists "rooms_select" on public.rooms;
create policy "rooms_select" on public.rooms for select using (auth.uid() = account_id);
drop policy if exists "rooms_insert" on public.rooms;
create policy "rooms_insert" on public.rooms for insert with check (auth.uid() = account_id);
drop policy if exists "rooms_update" on public.rooms;
create policy "rooms_update" on public.rooms for update using (auth.uid() = account_id) with check (auth.uid() = account_id);
drop policy if exists "rooms_delete" on public.rooms;
create policy "rooms_delete" on public.rooms for delete using (auth.uid() = account_id);

-- Beds: read / insert / update / delete own only
drop policy if exists "beds_select" on public.beds;
create policy "beds_select" on public.beds for select using (auth.uid() = account_id);
drop policy if exists "beds_insert" on public.beds;
create policy "beds_insert" on public.beds for insert with check (auth.uid() = account_id);
drop policy if exists "beds_update" on public.beds;
create policy "beds_update" on public.beds for update using (auth.uid() = account_id) with check (auth.uid() = account_id);
drop policy if exists "beds_delete" on public.beds;
create policy "beds_delete" on public.beds for delete using (auth.uid() = account_id);

-- Expenses: read / insert / update / delete own only
drop policy if exists "expenses_select" on public.expenses;
create policy "expenses_select" on public.expenses for select using (auth.uid() = account_id);
drop policy if exists "expenses_insert" on public.expenses;
create policy "expenses_insert" on public.expenses for insert with check (auth.uid() = account_id);
drop policy if exists "expenses_update" on public.expenses;
create policy "expenses_update" on public.expenses for update using (auth.uid() = account_id) with check (auth.uid() = account_id);
drop policy if exists "expenses_delete" on public.expenses;
create policy "expenses_delete" on public.expenses for delete using (auth.uid() = account_id);
