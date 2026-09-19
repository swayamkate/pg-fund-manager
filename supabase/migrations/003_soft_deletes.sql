-- ============================================================================
-- PG MANAGER — 003_soft_deletes.sql  (Phase 2 prerequisite)
-- ============================================================================
-- The outbox sync engine (store/sync.js) deletes by setting deleted_at, never
-- by issuing SQL DELETEs — this is the structural fix for the mass-deletion
-- bug class (an empty snapshot can no longer wipe the cloud: rows only ever
-- get a timestamp). Adds the column to every synced table and swaps indexes
-- so hot queries (RLS scans, occupancy, ledger lookups) skip deleted rows.
--
-- SAFE TO RUN AGAIN (idempotent), DELETES NOTHING, legacy client unaffected
-- (it ignores columns it does not know).
-- Run in: Supabase SQL Editor, AFTER 001 and 002.
-- ============================================================================

ALTER TABLE floors      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE rooms       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE beds        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tenants     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE rent_ledger ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE expenses    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE complaints  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE activity    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Hot-path partial indexes: server-side filtering on the queries the new
-- store actually runs (deleted rows are rare -> partial index stays tiny).
CREATE INDEX IF NOT EXISTS idx_ledger_active_tenant_period
  ON rent_ledger(tenant_id, period) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_active
  ON tenants(property_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_beds_active
  ON beds(property_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rooms_active
  ON rooms(property_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_floors_active
  ON floors(property_id) WHERE deleted_at IS NULL;

-- Self-check: confirm the column landed everywhere
SELECT 'floors' AS tbl, count(*) AS has_deleted_at FROM information_schema.columns
 WHERE table_name = 'floors'      AND column_name = 'deleted_at'
UNION ALL SELECT 'rooms',    count(*) FROM information_schema.columns
 WHERE table_name = 'rooms'       AND column_name = 'deleted_at'
UNION ALL SELECT 'beds',     count(*) FROM information_schema.columns
 WHERE table_name = 'beds'        AND column_name = 'deleted_at'
UNION ALL SELECT 'tenants',  count(*) FROM information_schema.columns
 WHERE table_name = 'tenants'     AND column_name = 'deleted_at'
UNION ALL SELECT 'rent_ledger', count(*) FROM information_schema.columns
 WHERE table_name = 'rent_ledger' AND column_name = 'deleted_at';
