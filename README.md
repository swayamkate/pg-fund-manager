# PG Manager

Owner dashboard for a paying-guest property: beds, tenants and rent collection.
No build step, no framework — plain HTML, CSS and JavaScript, hosted on Cloudflare Pages.

Live: https://pg.swayamkate.com/

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Dashboard with four views: Overview, Beds, Tenants, Rent |
| `login.html` | Sign-in page |
| `signup.html` | Account creation page |
| `config.js` | **Supabase project URL and anon key go here** |
| `auth.js` | Shared auth layer (Supabase, with demo fallback) |
| `store.js` | Per-account data store: rooms, tenants, payments, activity |
| `sheets.js` | Google Sheets backup client |
| `app.js` | Rendering, dialogs, tabs, theme and logout |
| `styles.css` | Light + dark theme, all components |
| `manage.css` | Empty states, dialogs and row actions |
| `404.html` | Not-found page |
| `apps-script/Code.gs` | The Google Apps Script that writes the backup sheet |

## Data

There is **no sample data anywhere in this app**. Every account signs in to an
empty property and builds it up through the UI:

1. **Property name** in the header sets the label under the logo.
2. **Beds → Add room** creates a room with a floor, a bed count (1–8) and a rent
   per bed.
3. Clicking a vacant bed, or **Tenants → Add tenant**, moves someone in.
4. **Rent → Mark paid** records a payment. **On notice** and **Check out** are on
   each tenant row.

Everything is saved by `store.js` under `localStorage["pgData:<account id>"]`, so
two different logins never see each other's rooms or tenants. Occupancy, expected
rent, collections and the activity feed are all derived from what you enter.

Unpaid rent shows as **Due**, and as **Overdue** once the month is past the 10th.
Paid flags reset automatically at the start of each month.

### Limits of browser storage

The data lives in one browser on one device. Clearing site data wipes it, and it
does not sync between your phone and laptop.

The Google Sheets backup below covers the first risk: if the browser is cleared,
the data can be pulled back out of the sheet. It does not fix the second — the
site still reads from local storage on load, not from the sheet. Moving rooms and
tenants into Supabase tables is the real fix for that.

## Google Sheets backup

Every change is copied into a Google Sheet a couple of seconds after you make it.
Each account gets **its own tab**, named after the account, plus a `_data` tab
holding the exact JSON used for restores.

The status sits at the bottom of the Overview tab, with **Back up now** and
**Restore from sheet** beside it.

### Setting it up

1. Create a new Google Sheet. This one spreadsheet holds every account's tab.
2. In that sheet, open **Extensions → Apps Script**.
3. Delete the placeholder code and paste in all of `apps-script/Code.gs`.
4. Change `TOKEN` at the top to any random string.
5. **Deploy → New deployment → Web app**, with:
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Authorise it when Google asks. The "unverified app" warning is expected for
   your own script — open **Advanced** and continue.
7. Copy the **/exec** URL it gives you into `config.js`:

   ```js
   SHEETS_URL: "https://script.google.com/macros/s/AKfy.../exec",
   SHEETS_TOKEN: "the-same-token-you-set-in-the-script"
   ```

8. Commit and push. Until `SHEETS_URL` is filled in, the bar reads "Sheet backup
   is not set up yet" and nothing is sent anywhere.

If you edit the script later, deploy again with **Manage deployments → Edit →
Version: New version**, or the old code keeps serving.

### What this is not

The spreadsheet is **yours**, not each user's. Everyone's data lands in tabs of
one sheet in your Drive.

More importantly: the script URL and token are both visible in the page source,
because a static site has nowhere private to keep them. Anyone who reads the
source can write to — or read — any account's tab. The token only keeps random
crawlers out; it is not a password. Fine for a backup of your own property, not
fine if you ever have real, unrelated customers. That is the point at which the
Supabase tables below stop being optional.

## Connecting Supabase

Authentication runs through `auth.js`, which uses **Supabase Auth** when
`config.js` holds real values and otherwise falls back to demo mode.

1. Create a project at [supabase.com](https://supabase.com).
2. Open **Project Settings → API** and copy:
   - **Project URL**
   - **Project API keys → `anon` `public`**
3. Paste both into `config.js`:

   ```js
   window.PG_CONFIG = {
     SUPABASE_URL: "https://xxxxxxxxxxxx.supabase.co",
     SUPABASE_ANON_KEY: "eyJhbGciOi..."
   };
   ```

4. In **Authentication → Providers → Email**, make sure Email is enabled.
5. In **Authentication → URL Configuration**, set the Site URL to
   `https://pg.swayamkate.com` so confirmation links come back to the site.
6. Commit and push. Cloudflare redeploys in about a minute.

The `anon` key is designed to be public and shipped to the browser — access is
restricted by Row Level Security. **Never put the `service_role` key in this
repo**; it bypasses all security rules.

Only sign-in and sign-up talk to Supabase today. Rooms and tenants are still
browser-side.

### Email confirmation

Supabase confirms email addresses by default. With it on, sign-up shows
"check your email for a confirmation link" and sign-in only works after the link
is clicked. To skip that while demoing, turn off **Confirm email** in
**Authentication → Providers → Email**.

## Logins

| Login | How |
| --- | --- |
| Demo owner | Email `admin`, password `pass` — always works, in either mode |
| Real account | Create one on `signup.html` (email + password, minimum 6 characters) |

The demo login is a deliberate escape hatch so the preview can always be opened.
It starts with an empty property like every other account. Remove it from
`auth.js` (`DEMO_ID` / `DEMO_PW`) before real use.

## Demo mode vs Supabase mode

| | Demo mode (`config.js` empty) | Supabase mode |
| --- | --- | --- |
| Accounts stored | `localStorage` in one browser, plain text | Supabase `auth.users`, hashed |
| Works across devices | No | Yes |
| Session | `sessionStorage`, lost on tab close | Supabase session, persists |
| Suitable for real users | **No** | Yes |

Demo mode exists only so the preview never breaks. It is not secure: passwords
are readable in DevTools and disappear when browser data is cleared.

## Theme

Light and dark palettes are driven by `data-theme` on `<html>`.
Dark is the default. The toggle in the top-right saves the choice to
`localStorage["pgTheme"]`, which then overrides the default on every page.

## Next steps

- Move rooms, tenants and payments into Supabase tables with Row Level Security
  so data follows the account instead of the browser
- Edit a tenant, or move one between beds, without checking out first
- Rent receipts and payment history per month
- Complaints and expense tracking

## Editing saved records

On **Rent**, use **Month to review** to choose a month, then **Edit** beside a tenant. Payment history rows and month chips open the same editor. Choose any month and correct its rent amount, paid/unpaid status, payment date, and transaction reference. Each month retains its own amount; changing current room or tenant rent preserves previous amounts and settled months. Receipts and ledger CSV exports include the edited month and payment details.

Expenses and complaints have an **Edit** action with their original dates and values. The rate card also supports editing existing entries. Tenant profiles, rooms, and owner details remain editable through their existing controls. These controls edit retained records; they cannot recover tenant history that was already deleted at checkout.

Migration `supabase/migrations/014_complaint_edit_metadata.sql` adds nullable resolution-date and linked-expense fields without removing data. This keeps complaint edits and their repair expenses consistent across devices.

Regression checks: `node test-historical-payments.js`, `node test-expense-edits.js`, and `node test-complaint-rate-edits.js`.
