# PG Manager

A responsive dashboard for managing paying-guest properties: rooms, beds, tenants,
rent, expenses, complaints, and reports.

**Live:** https://pg.swayamkate.com/

## Run locally

No build step is needed for the main app. From the repository root:

```sh
python3 -m http.server 8080
```

Open http://localhost:8080 and sign in. Configure Supabase in `config.js` for
real accounts. Never put a service-role key in browser code.

## Project map

| Path | Contents |
| --- | --- |
| `index.html`, `login.html`, `signup.html` | Main dashboard and authentication pages |
| `app.js` | Dashboard startup, session, and theme |
| `assets/js/dashboard/` | Dashboard features, forms, rendering, and save pipeline |
| `styles.css` → `assets/css/` | Shared style entry point and focused stylesheets |
| `dashboard-refresh.css` | Dashboard palette and compact spacing |
| `store.js`, `auth.js`, `supabase-storage.js` | Current app data, authentication, and cloud storage |
| `analytics.js`, `import.js`, `profile.js`, `account.js`, `rent.js` | Additional feature scripts |
| `supabase/` | Database migrations and setup instructions |
| `apps-script/`, `sheets.js` | Optional Google Sheets backup |
| `v2.html`, `app2.js`, `store/`, `views/` | Separate v2 app and its data layer |
| `pgmanager/` | Separate Next.js implementation; has its own setup |
| `test-*.js` | Regression checks |

See [architecture and editing guide](docs/architecture.md) for module boundaries
and loading order. [Setup reference](docs/setup.md) preserves the earlier setup
notes; some descriptions there refer to older versions. For the database, use
[Supabase documentation](supabase/README.md).

## Offline regression checks

```sh
node test-historical-payments.js
node test-expense-edits.js
node test-complaint-rate-edits.js
```

Other schema and end-to-end scripts contact Supabase; read their headers before
running them against a configured project.
