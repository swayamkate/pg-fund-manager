-- ============================================================
-- PG Manager — Complete Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- 1. PROFILES (extends Supabase auth.users)
-- Stores owner/staff display name and role
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  username TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'staff')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. PROPERTIES (one owner can have one PG property)
CREATE TABLE IF NOT EXISTS properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  address TEXT DEFAULT '',
  pg_start_date DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(owner_id)
);

-- 3. ROOMS
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  no TEXT NOT NULL DEFAULT '',
  floor INTEGER NOT NULL DEFAULT 0,
  rent INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. BEDS (each bed belongs to a room, may have a tenant)
CREATE TABLE IF NOT EXISTS beds (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bed_index INTEGER NOT NULL DEFAULT 0,
  name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  joined DATE,
  leaving DATE,
  note TEXT DEFAULT '',
  collect INTEGER DEFAULT 0,
  rent INTEGER,
  deposit INTEGER DEFAULT 0,
  id_type TEXT DEFAULT '',
  id_number TEXT DEFAULT '',
  emergency_contact TEXT DEFAULT '',
  workplace TEXT DEFAULT '',
  on_notice BOOLEAN DEFAULT false,
  paid_months TEXT[] DEFAULT '{}',
  payment_info JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. EXPENSES
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  category TEXT NOT NULL DEFAULT 'Other',
  amount INTEGER NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. RATES (rate card)
CREATE TABLE IF NOT EXISTS rates (
  id TEXT PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 7. COMPLAINTS (issues / maintenance)
CREATE TABLE IF NOT EXISTS complaints (
  id TEXT PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  room_id TEXT DEFAULT '',
  room_no TEXT DEFAULT '',
  category TEXT DEFAULT 'General',
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT DEFAULT '',
  cost INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. ACTIVITY (feed of recent actions)
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  text TEXT NOT NULL DEFAULT '',
  type TEXT DEFAULT 'info',
  ts TIMESTAMPTZ DEFAULT now()
);

-- 9. SETTINGS (app preferences)
CREATE TABLE IF NOT EXISTS settings (
  owner_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  floors BOOLEAN DEFAULT true,
  bed_style TEXT DEFAULT 'alpha',
  bed_numbering TEXT DEFAULT 'restart'
);

-- 10. RULES (PG house rules)
CREATE TABLE IF NOT EXISTS rules (
  owner_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  visiting TEXT DEFAULT '',
  quiet TEXT DEFAULT '',
  guests TEXT DEFAULT '',
  lockout TEXT DEFAULT '',
  other TEXT DEFAULT ''
);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- Each owner can only see/modify their own data
-- ============================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE beds ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rules ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read all profiles (for username lookup), write only their own
CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (true);
CREATE POLICY "profiles_insert" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);

-- All other tables: owner can only access their own rows
CREATE POLICY "properties_own" ON properties FOR ALL USING (owner_id = auth.uid());
CREATE POLICY "rooms_own" ON rooms FOR ALL USING (owner_id = auth.uid());
CREATE POLICY "beds_own" ON beds FOR ALL USING (owner_id = auth.uid());
CREATE POLICY "expenses_own" ON expenses FOR ALL USING (owner_id = auth.uid());
CREATE POLICY "rates_own" ON rates FOR ALL USING (owner_id = auth.uid());
CREATE POLICY "complaints_own" ON complaints FOR ALL USING (owner_id = auth.uid());
CREATE POLICY "activity_own" ON activity FOR ALL USING (owner_id = auth.uid());
CREATE POLICY "settings_own" ON settings FOR ALL USING (owner_id = auth.uid());
CREATE POLICY "rules_own" ON rules FOR ALL USING (owner_id = auth.uid());

-- ============================================================
-- INDEXES for fast queries
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(owner_id);
CREATE INDEX IF NOT EXISTS idx_beds_owner ON beds(owner_id);
CREATE INDEX IF NOT EXISTS idx_beds_room ON beds(room_id);
CREATE INDEX IF NOT EXISTS idx_expenses_owner ON expenses(owner_id);
CREATE INDEX IF NOT EXISTS idx_rates_owner ON rates(owner_id);
CREATE INDEX IF NOT EXISTS idx_complaints_owner ON complaints(owner_id);
CREATE INDEX IF NOT EXISTS idx_activity_owner ON activity(owner_id);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts DESC);
