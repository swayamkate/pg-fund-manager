# Architecture and editing guide

The deployed main app is a static site rooted at `index.html`. Serve the repository
root; no bundler or build step is required. Keep page URLs and root data/auth scripts
stable because the login pages, v2 app, and existing tests also use them.

## Dashboard JavaScript

`index.html` loads these classic scripts in order from `assets/js/dashboard/`:

| Module | Responsibility |
| --- | --- |
| `core.js` | Formatting, notifications, confirmation, tenant totals, expense helpers |
| `dashboard.js` | Stats, graphs, beds, tenants, rent, and expense rendering |
| `complaints.js` | Complaint rendering and editor |
| `owner-settings.js` | Property settings, rate card, bulk rent changes |
| `owner-actions.js` | Historical payments, deposits, rules, data management |
| `render.js` | Owner rendering and coordinated view updates |
| `sync.js` | Backup status, save pipeline, retries, sync events, `PGRender` API |
| `dialogs.js` | Tenant/room dialogs, offboarding, receipts, complaint forms, exports |
| `actions.js` | Dropdowns, delegated clicks, room creation |
| `forms.js` | Room, expense, property, and historical-payment submissions |
| `navigation.js` | Tabs, sidebar, filters, and navigation events |

Root `app.js` runs last to boot the session, render the dashboard, and wire theme
and logout. Existing analytics, import, account, profile, and rent scripts retain
their integration points.

These files intentionally share the existing global scope. Do not add `async`,
`type="module"`, or wrappers independently: shared bindings and external feature
scripts depend on the current loading order. This is a file-organization refactor,
not a change to the storage format or save behavior.

## Styles

`styles.css` imports `assets/css/` in cascade order: tokens, base, layout,
components, management, responsive. It remains the shared entry point for existing
pages. Keep responsive rules last. Page-specific `manage.css`, `analytics.css`, and
`dashboard-refresh.css` load afterward; the refresh file controls the current
palette and compact desktop spacing. Mobile navigation and touch targets retain
their existing behavior. Secondary analytics live inside a native `details` element
on the overview; opening Detailed reports reveals the existing report containers.

## Other implementations

`v2.html` uses the ES modules in `store/` and `views/`. The `pgmanager/` directory
contains a separate Next.js app. Neither is the entry point of the root static
site. Database migrations live in `supabase/migrations/`.

## Checking changes

Run the offline regression commands in the README. When changing dashboard script
order, also open the real HTML in a browser and exercise navigation, room/tenant
creation, rent editing, reload, and theme changes at desktop and mobile widths.
Use local test data and stub cloud integrations to keep smoke checks offline.
