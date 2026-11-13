/* PG Manager — configuration

   THIS FILE IS GENERATED AT BUILD TIME. Do not paste keys into it.

   Cloudflare Pages runs `node scripts/build-config.mjs` before uploading, which
   rewrites this file from the project's build environment variables:

     SUPABASE_URL        https://<project-ref>.supabase.co
     SUPABASE_ANON_KEY   the "anon public" key, or a newer sb_publishable_… key
     SHEETS_URL          optional — Apps Script /exec URL for sheet backup
     SHEETS_TOKEN        optional — must match TOKEN inside that script

   Set those in Pages → Settings → Environment variables for Production AND
   Preview, with `node scripts/build-config.mjs` as the build command. The
   generator refuses to build when they are missing, so a deploy can no longer
   ship a site that points at a database that has moved or gone away.

   Which key is safe here?
   -----------------------
   The anon / publishable key is DESIGNED to be public: it only identifies the
   project, and Row Level Security decides what the signed-in user can read.
   The service_role / sb_secret_ key bypasses RLS entirely — it must never
   appear here, in the repo, or in the browser.

   Leaving both values empty is a supported local mode: auth.js falls back to
   browser-only accounts, which is handy for offline development and is NOT
   suitable for real users. The login page says so when it is in that mode.

   The database side is one file: supabase/fresh-project.sql. Run it once in a
   new project's SQL Editor and the tables, RLS policies and sign-up bootstrap
   trigger all match what assets/js/core/*.js calls.

   Google Sheets backup: SHEETS_URL and SHEETS_TOKEN are visible in the page
   source of any static site. That token keeps crawlers out; it is not a
   password. Anyone who reads the source can reach the sheet.
*/
window.PG_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",

  /* Optional Google Sheets backup. Empty = disabled. */
  SHEETS_URL: "",
  SHEETS_TOKEN: ""
};
