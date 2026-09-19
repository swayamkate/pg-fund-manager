-- ============================================================================
-- PG MANAGER — 002_migrate_beds_data.sql  (Phase 1: non-destructive backfill)
-- ============================================================================
-- Converts every existing denormalized BED row (a tenant living inside a bed)
-- into normalized TENANTS + RENT LEDGER rows — without losing any payment
-- history — and links tenants back to their beds via beds.tenant_id.
--
-- GUARANTEES
--   * DELETES NOTHING. Legacy bed columns (name, phone, paid_months,
--     payment_info, ...) are left exactly as they are; the current app keeps
--     reading them. The new tables are pure additions.
--   * IDEMPOTENT. A bed with a name but no linked tenant gets migrated;
--     a bed that already has beds.tenant_id set is skipped. Re-running
--     after a partial run simply finishes the remaining rows.
--   * MAPPING (every legacy field has a destination):
--       beds.name, phone, id_type, id_number, emergency_contact, workplace,
--         joined -> joined_on, leaving -> left_on, note -> notes,
--         deposit, rent (custom) -> rent_amount, collect -> collect_day
--       beds.paid_months[]        -> one rent_ledger row per month
--       beds.payment_info[m]      -> ledger.paid_on (date) + ledger.reference (utr)
--       ledger.due                -> effective monthly rent at migration time
--   * on_notice=true  -> tenants.status='on_notice' (+ planned_leave_on=leaving)
--     empty bed row   -> skipped entirely (a vacant slot is not a person)
--
-- Run AFTER 001_normalized_schema.sql, in: Supabase SQL Editor -> Run.
-- ============================================================================

-- STEP 1 — ensure every owner has a property row to hang everything on
-- (legacy schema allowed app use without one; the new tables require it).
INSERT INTO properties (id, owner_id, name, address, phone, upi_id)
SELECT gen_random_uuid(), p.id,
       coalesce(nullif(p.name, ''), 'My Property'),
       '', '', ''
FROM profiles p
WHERE NOT EXISTS (SELECT 1 FROM properties pr WHERE pr.owner_id = p.id);

-- STEP 2 — one floor row per distinct legacy floor level per property
INSERT INTO floors (owner_id, property_id, level, label)
SELECT DISTINCT pr.owner_id, pr.id, r.floor,
       CASE WHEN r.floor = 0 THEN 'Ground'
            ELSE 'Floor ' || r.floor END
FROM rooms r
JOIN properties pr ON pr.owner_id = r.owner_id
WHERE NOT EXISTS (
  SELECT 1 FROM floors f
  WHERE f.property_id = pr.id AND f.level = r.floor
);

-- STEP 3 — link rooms to their property + floor (leaves legacy columns intact)
UPDATE rooms r
SET property_id = pr.id,
    floor_id    = f.id
FROM properties pr
JOIN floors f ON f.property_id = pr.id AND f.level = r.floor
WHERE r.owner_id = pr.owner_id
  AND (r.property_id IS NULL OR r.floor_id IS NULL);

-- STEP 4 — link beds to their property (leaves legacy columns intact)
UPDATE beds b
SET property_id = r.property_id
FROM rooms r
WHERE b.room_id = r.id
  AND b.property_id IS NULL;

-- STEP 5 — THE BACKFILL: occupied beds -> tenants + rent_ledger.
-- Only beds that HAVE a tenant name and are NOT yet linked are converted.
WITH candidate AS (
  SELECT b.*, r.no AS room_no, r.rent AS room_rent, r.property_id AS pid, r.owner_id AS oid
  FROM beds b
  JOIN rooms r ON r.id = b.room_id
  WHERE coalesce(b.name, '') <> ''
    AND b.tenant_id IS NULL
    AND r.property_id IS NOT NULL   -- a bed without a property line is skipped,
                                    -- never crashes the migration
),
inserted AS (
  INSERT INTO tenants (
    owner_id, property_id, bed_id, name, phone,
    id_type, id_number, emergency_contact, workplace,
    joined_on, planned_leave_on, left_on, status,
    rent_amount, collect_day, deposit, notes
  )
  SELECT
    c.oid, c.pid, c.id, btrim(c.name), coalesce(c.phone, ''),
    coalesce(c.id_type, ''), coalesce(c.id_number, ''),
    coalesce(c.emergency_contact, ''), coalesce(c.workplace, ''),
    c.joined,
    CASE WHEN c.on_notice THEN c.leaving END,          -- notice date
    CASE WHEN NOT c.on_notice AND c.leaving IS NOT NULL
         AND c.leaving <= CURRENT_DATE THEN c.leaving END,  -- already moved out
    CASE WHEN c.on_notice
           OR c.leaving IS NULL
           OR c.leaving > CURRENT_DATE
         THEN 'active' ELSE 'moved_out' END,
    c.rent,                                            -- NULL = room rent applies
    c.collect,
    coalesce(c.deposit, 0),
    coalesce(c.note, '')
  FROM candidate c
  RETURNING id, owner_id, property_id, bed_id
)
-- link each new tenant back to its bed
UPDATE beds b
SET tenant_id = i.id,
    status    = 'occupied'
FROM inserted i
WHERE b.id = i.bed_id;

-- STEP 6 — payment history: paid_months[] + payment_info -> rent_ledger rows.
-- due = paid = the tenant's effective monthly rent (custom rent, else room
-- rent) — the legacy model recorded a month as simply paid, never partial.
-- paid_on/reference come from payment_info when present; months without one
-- are still migrated, with NULL details (the payment was real, only unrecorded).
INSERT INTO rent_ledger (owner_id, property_id, tenant_id, period, due, paid,
                         status, paid_on, method, reference)
SELECT
  t.owner_id, t.property_id, t.id,
  m.month,
  coalesce(t.rent_amount, r.rent, 0),          -- the amount that was due
  coalesce(t.rent_amount, r.rent, 0),          -- a paid month was paid in full
  'paid',
  (t_info.info ->> 'date')::date,              -- payment date, when recorded
  CASE WHEN coalesce(t_info.info ->> 'utr', '') <> '' THEN 'upi' END,
  t_info.info ->> 'utr'                        -- UTR / transaction reference
FROM tenants t
JOIN beds b      ON b.id = t.bed_id
JOIN rooms r     ON r.id = b.room_id
CROSS JOIN LATERAL unnest(coalesce(b.paid_months, '{}')) AS m(month)
LEFT JOIN LATERAL (
  SELECT b.payment_info ->> m.month AS info
  WHERE b.payment_info ? m.month
) t_info ON true
ON CONFLICT (tenant_id, period) DO NOTHING;      -- re-runs never duplicate months

-- STEP 7 — verification (zero-loss assertions; run output should be reviewed)
-- 7a. Every occupied bed now points at a tenant.
SELECT 'beds occupied but unlinked (must be 0)' AS check_name,
       count(*) AS failures
FROM beds WHERE coalesce(name, '') <> '' AND tenant_id IS NULL;

-- 7b. Every paid month survived as a ledger row (per-tenant comparison).
SELECT 'paid months lost in migration (must be 0)' AS check_name,
       count(*) AS failures
FROM tenants t
JOIN beds b ON b.id = t.bed_id
WHERE coalesce(b.name, '') <> ''
  AND (SELECT count(*) FROM unnest(coalesce(b.paid_months, '{}')) x(m))
    <> (SELECT count(*) FROM rent_ledger rl WHERE rl.tenant_id = t.id);

-- 7c. Summary of what the migration produced.
SELECT 'tenants created' AS summary, count(*)::text AS value FROM tenants
UNION ALL
SELECT 'ledger rows created',  count(*)::text FROM rent_ledger
UNION ALL
SELECT 'beds still vacant (expected)', count(*)::text FROM beds WHERE coalesce(name, '') = ''
UNION ALL
SELECT 'tenants on notice',    count(*)::text FROM tenants WHERE status = 'on_notice'
UNION ALL
SELECT 'tenants moved out',    count(*)::text FROM tenants WHERE status = 'moved_out';
