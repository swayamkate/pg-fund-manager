# PG Manager

A responsive dashboard for managing paying-guest properties: rooms, beds, tenants,
rent, expenses, complaints, and reports.

**Live:** https://pg.swayamkate.com/

## Run locally

No build step is needed for the main app. From the repository root:

```sh
python3 -m http.server 8080
```

Open http://localhost:8080 and sign in. With `config/config.js` empty the site runs
in browser-only mode, and the login page says so; for real accounts, generate the
file from your project's values instead of editing it:

```sh
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon or publishable key> \
  node scripts/build-config.mjs
```

Never put a service-role or `sb_secret_` key in browser code — the generator
rejects one.

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

## Deploy

Cloudflare Pages builds this repository from git, so a push is the deploy.
Settings → Build configuration:

```
Build command:            node scripts/build-config.mjs
Build output directory:   .
```

Environment variables, for **Production and Preview**: `SUPABASE_URL`,
`SUPABASE_ANON_KEY` (anon public / `sb_publishable_…`), optionally `SHEETS_URL`
and `SHEETS_TOKEN`. The build refuses to produce a site that points at nothing,
so a deploy can no longer ship a config for a database that has moved or been
deleted. `ALLOW_LOCAL_MODE=1` overrides that, deliberately, for browser-only
builds.

For a new Supabase project, run [`supabase/fresh-project.sql`](supabase/fresh-project.sql)
once in its SQL Editor: tables, RLS policies and the sign-up bootstrap trigger
all match what `assets/js/core/*.js` calls.

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
