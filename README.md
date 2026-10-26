# PG Manager

A responsive dashboard for managing paying-guest properties: rooms, beds, tenants,
rent, expenses, complaints, and reports.

**Live:** https://pg.swayamkate.com/

## Run locally

No build step is needed for the main app. From the repository root:

```sh
python3 -m http.server 8080
```

Open http://localhost:8080 and sign in. Configure Supabase in `config/config.js` for
real accounts. Never put a service-role key in browser code.

## Project map

| Path | Contents |
| --- | --- |
| `index.html`, `login.html`, `signup.html` | Main dashboard and authentication pages |
| `assets/js/dashboard/` | Dashboard startup, views, dialogs, and save pipeline |
| `assets/js/core/` | Authentication, data store, cloud storage, Sheets backup |
| `assets/js/features/` | Analytics, import, profiles, accounts, and rent |
| `assets/js/v2/` | Separate v2 app with its store, views, and components |
| `assets/css/` | Shared and page-specific stylesheets |
| `assets/images/` | Images and application icons |
| `config/` | Public browser configuration |
| `tests/` | Offline regression checks and live backend checks |
| `scripts/` | Maintenance and migration verification tools |
| `docs/` | Architecture, archived setup notes, and project backlog |
| `supabase/` | Database migrations and setup instructions |
| `apps-script/` | Google Sheets backup server |
| `mp14u/` | Admin page and its assets |
| `pgmanager/` | Separate Next.js implementation; has its own setup |

Page entry points and hosting metadata stay at the root to preserve public URLs.
`sw.js` stays there so old service-worker registrations can unregister themselves.

See [architecture and editing guide](docs/architecture.md) for module boundaries
and loading order. [Setup reference](docs/setup.md) preserves the earlier setup
notes; some descriptions there refer to older versions. For the database, use
[Supabase documentation](supabase/README.md).

## Next.js app and database repair

The `pgmanager/` rewrite includes its own database, rent engine, imports, and
reports. Follow its [quick start](pgmanager/README.md) to run it separately.
Migration [`013_consolidated_repair.sql`](supabase/migrations/013_consolidated_repair.sql)
contains repairs for the existing Supabase schema. Merging this code does not
apply database migrations.

## Offline regression checks

```sh
node tests/test-historical-payments.js
node tests/test-expense-edits.js
node tests/test-complaint-rate-edits.js
node tests/test-schema-check.js
node tests/test-asset-paths.js
```

Other end-to-end scripts contact Supabase; read their headers before
running them against a configured project.
