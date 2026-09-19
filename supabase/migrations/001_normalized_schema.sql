-- ============================================================================
-- PG MANAGER — 001_normalized_schema.sql  (Phase 0: single source of truth)
-- ============================================================================
-- Rebuild, Pillar 1: Property -> Floors -> Rooms -> Beds -> Tenants -> Ledger.
--
-- SAFE TO RUN AGAIN (idempotent) and SAFE TO RUN ON THE LIVE DATABASE:
--   * New tables use CREATE TABLE IF NOT EXISTS.
--   * Existing tables are only touched with ADD COLUMN IF NOT EXISTS — every
--     added column is nullable or defaulted, so the CURRENT app (which still
--     writes the legacy denormalized shape) keeps working untouched.
--   * No column is ever dropped or rewritten here. Legacy columns on `beds`
--     stay in place until the Phase-4 cutover retires them.
--
-- Run in: Supabase Dashboard -> SQL Editor -> paste -> Run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PROPERTIES (exists; additive: owner contact + UPI fields)
-- One property per owner for now (UNIQUE(owner_id) stays). Multi-property
-- later = drop that one constraint; every table already carries property_id.
-- ---------------------------------------------------------------------------
ALTER TABLE properties ADD COLUMN IF NOT EXISTS phone   TEXT NOT NULL DEFAULT '';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS upi_id  TEXT NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- FLOORS (new entity — the missing layer between property and rooms)
-- NOTE ON IDS: new tables use TEXT primary keys (client-generated), with a
-- uuid default for server-side inserts. property_id is a soft link (TEXT,
-- no FK) — ownership is enforced by owner_id + RLS on every row, which also
-- lets the offline-first client create parents and children in one batch.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS floors (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  level       INTEGER NOT NULL DEFAULT 0,          -- 0 = ground
  label       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (property_id, level)
);

-- ---------------------------------------------------------------------------
-- ROOMS (exists; additive: property + floor links. Legacy `floor INT` and
-- `rent INT` stay until cutover so the current client keeps reading them.)
-- ---------------------------------------------------------------------------
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS property_id TEXT NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS floor_id    TEXT REFERENCES floors(id)    ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- TENANTS (new — a tenant is a PERSON with history, not a bed slot)
-- Verification fields are optional (refinement #1): id_type / id_number.
-- rent_amount NULL = "use the room's rent" (per-tenant override otherwise).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_id       TEXT NOT NULL,
  name              TEXT NOT NULL CHECK (length(trim(name)) > 0),
  phone             TEXT NOT NULL DEFAULT '',
  id_type           TEXT NOT NULL DEFAULT '',    -- Aadhaar / PAN / Passport / ''
  id_number         TEXT NOT NULL DEFAULT '',
  emergency_contact TEXT NOT NULL DEFAULT '',
  workplace         TEXT NOT NULL DEFAULT '',
  joined_on         DATE,
  planned_leave_on  DATE,                        -- notice date, billing continues
  left_on           DATE,                        -- actual move-out, billing stops
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'on_notice', 'moved_out')),
  rent_amount       INTEGER,                     -- NULL = room rent applies
  collect_day       SMALLINT CHECK (collect_day BETWEEN 0 AND 31),  -- 0 = not set
  deposit           INTEGER NOT NULL DEFAULT 0,
  notes             TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- bed link added AFTER beds.tenant_id below (circular FK resolved by ALTER order).

-- ---------------------------------------------------------------------------
-- BEDS (exists; additive: becomes a SLOT that points at its current tenant.
-- All legacy tenant columns (name, phone, paid_months, ...) remain untouched
-- and keep working until Phase 4 retires them.)
-- ---------------------------------------------------------------------------
ALTER TABLE beds ADD COLUMN IF NOT EXISTS property_id TEXT NOT NULL DEFAULT '';
ALTER TABLE beds ADD COLUMN IF NOT EXISTS tenant_id   TEXT REFERENCES tenants(id) ON DELETE SET NULL;
ALTER TABLE beds ADD COLUMN IF NOT EXISTS status      TEXT CHECK (status IN ('vacant', 'occupied'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bed_id   TEXT REFERENCES beds(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- RENT LEDGER (new — the real money table the legacy paid_months[] replaces)
-- One row per tenant per month. The UNIQUE constraint is what makes the sync
-- layer's upserts safe (no duplicate months, ever).
--   reminder_sent_at (refinement #2) supports 1-tap WhatsApp reminders later.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rent_ledger (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_id      TEXT NOT NULL,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period           TEXT NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),  -- 'YYYY-MM'
  due              INTEGER NOT NULL DEFAULT 0,
  paid             INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('paid', 'pending', 'overdue')),
  paid_on          DATE,
  method           TEXT,      -- 'cash' / 'upi' / ... (legacy rows: NULL = unknown)
  reference        TEXT,      -- UTR / transaction reference
  note             TEXT NOT NULL DEFAULT '',
  reminder_sent_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period)
);

-- ---------------------------------------------------------------------------
-- EXPENSES / COMPLAINTS / ACTIVITY (exist; additive property link only)
-- ---------------------------------------------------------------------------
ALTER TABLE expenses   ADD COLUMN IF NOT EXISTS property_id TEXT NOT NULL DEFAULT '';
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS property_id TEXT NOT NULL DEFAULT '';
ALTER TABLE activity   ADD COLUMN IF NOT EXISTS property_id TEXT NOT NULL DEFAULT '';

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY — every owner sees exactly their own rows
-- (policies wrapped in DO blocks so re-running never errors)
-- ---------------------------------------------------------------------------
ALTER TABLE floors      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE rent_ledger ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'floors_own') THEN
    CREATE POLICY "floors_own" ON floors FOR ALL USING (owner_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenants_own') THEN
    CREATE POLICY "tenants_own" ON tenants FOR ALL USING (owner_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'rent_ledger_own') THEN
    CREATE POLICY "rent_ledger_own" ON rent_ledger FOR ALL USING (owner_id = auth.uid());
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_floors_property  ON floors(property_id);
CREATE INDEX IF NOT EXISTS idx_rooms_property   ON rooms(property_id);
CREATE INDEX IF NOT EXISTS idx_rooms_floor      ON rooms(floor_id);
CREATE INDEX IF NOT EXISTS idx_beds_property    ON beds(property_id);
CREATE INDEX IF NOT EXISTS idx_beds_tenant      ON beds(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenants_property ON tenants(property_id);
CREATE INDEX IF NOT EXISTS idx_tenants_bed      ON tenants(bed_id);
CREATE INDEX IF NOT EXISTS idx_tenants_status   ON tenants(property_id, status);
CREATE INDEX IF NOT EXISTS idx_ledger_property  ON rent_ledger(property_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tenant    ON rent_ledger(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ledger_period    ON rent_ledger(property_id, period);

-- ---------------------------------------------------------------------------
-- updated_at maintenance (the sync layer's change detection depends on it)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tenants_touch') THEN
    CREATE TRIGGER tenants_touch BEFORE UPDATE ON tenants
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ledger_touch') THEN
    CREATE TRIGGER ledger_touch BEFORE UPDATE ON rent_ledger
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- SELF-CHECK: prints the normalized schema state after the run
-- ---------------------------------------------------------------------------
SELECT 'floors' AS tbl, count(*) AS row_count FROM floors
UNION ALL SELECT 'tenants',     count(*) FROM tenants
UNION ALL SELECT 'rent_ledger', count(*) FROM rent_ledger;
