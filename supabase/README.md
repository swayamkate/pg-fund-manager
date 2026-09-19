# PG Manager — Supabase

Single source of truth for the database. Everything lives in `migrations/`,
numbered in execution order. All scripts are **idempotent** (safe to run twice)
and **non-destructive** (no column is ever dropped; deletes are soft
`deleted_at` tombstones only — the app never sends SQL `DELETE`).

## New deployment — exact execution order

Run each file top-to-bottom in **Supabase Dashboard → SQL Editor**, in this order:

| # | File | What it creates |
|---|--------|-----------------|
| 0 | `legacy/schema.sql` | Legacy base: `profiles`, `properties`, `rooms`, `beds` (tenant-in-bed), `expenses`, `rates`, `complaints`, `activity`, `settings`, `rules` |
| 0 | `legacy/data-schema.sql` | Legacy data tables (only for restores from very old backups) |
| 1 | `migrations/001_normalized_schema.sql` | Normalized model: `floors`, `tenants`, `rent_ledger` (TEXT ids); extends `rooms`/`beds`/`properties` additively |
| 2 | `migrations/002_migrate_beds_data.sql` | Non-destructive backfill: denormalized bed rows → `tenants` + `rent_ledger` (keeps all payment history; review its 3 verification queries) |
| 3 | `migrations/003_soft_deletes.sql` | `deleted_at` columns + partial hot-path indexes on all synced tables |
| 4 | `migrations/004_rls_and_cascade.sql` | Strict owner-scoped RLS on the six synced tables + tenant-tombstone→bed-freed trigger |
| 5 | `migrations/005_owner_stats_rpc.sql` | `get_owner_stats()` dashboard RPC |
| 6 | `migrations/006_tenant_documents_storage.sql` | Private `tenant-documents` storage bucket, owner-folder RLS, `tenants.id_proof_url`/`id_proof_path` |
| 7 | `migrations/007_triggers_and_touch.sql` | `trg_tenant_checkout` cascade (left_on/deleted_at frees bed) + `updated_at` touch triggers on all six tables |
| 8 | `migrations/008_dashboard_summary_rpc.sql` | `get_owner_dashboard_summary()` — full dashboard in one round-trip |
| 9 | `migrations/009_rls_audit_complete.sql` | Complete RLS audit: ENABLE+FORCE on every public table, strict 4-policy set, ends with an audit query |
| 10 | `migrations/010_whatsapp_reminder_rpc.sql` | `generate_whatsapp_reminder_payload()` — wa.me-ready reminder text + URL |

Existing deployment that already ran the legacy files? Start at **1** — every
script detects what exists and only adds what's missing. `verify-migration-applied.sql`
(read-only) tells you how far you got; run it after each step.

## Verify

```sql
-- inside Supabase SQL Editor:
\i is not supported in the web editor — paste the file contents instead:
--   supabase/verify-migration-applied.sql
-- Expected: setup_complete = true, 4 policies per table,
--           trigger_exists = true, function_exists = true
```

Also enable **Database → Replication** for `tenants`, `beds`, `rent_ledger`
(+ `properties`, `rooms`, `floors`) so Realtime (the `pg_live_updates`
channel) delivers changes.

## Legacy folder

`legacy/` holds the pre-rebuild scripts kept for history and old-restore
support. They are superseded by `migrations/001` — do **not** run them on a
database that already has the normalized schema. `legacy/migrate-schema.sql`
(Add `beds.payment_info`) is still the fastest fix if the **legacy app**
reports the red schema-drift banner on an old deployment.
