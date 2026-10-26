/* PG Manager — configuration

   Supabase (sign-in and sign-up):
     Project Settings → API → Project URL  and  Project API keys → anon public

   These are filled in, so accounts live in Supabase rather than in the browser.
   Sign in with your EMAIL and password. New accounts are controlled from the
   Supabase dashboard: Authentication → Providers → Email → "Allow new users to
   sign up". Turn that OFF and nobody can create a login without you.

   Usernames are claimed through the profiles table in supabase/schema.sql.
   Run that file once in the SQL editor or the username field will say so.

   The anon key is meant to be public and shipped in the browser — access is
   controlled by Row Level Security. NEVER put the service_role key in this file.

   Leaving SUPABASE_URL and SUPABASE_ANON_KEY empty drops the site back to
   browser-only accounts, which is useful for local testing.

   Google Sheets backup:
     SHEETS_URL is the /exec address of the Apps Script web app in
     apps-script/Code.gs. SHEETS_TOKEN must match the TOKEN inside that script.

   The Sheets values in this file are public. That token only keeps random
   crawlers out; it is not a password, because anyone reading the page source
   can see it.
*/
window.PG_CONFIG = {
  /* Supabase — PRIMARY database for all data.
     1. Go to https://supabase.com/dashboard → New Project
     2. Go to Settings → API → Copy Project URL and anon key
     3. Go to SQL Editor → paste supabase/schema.sql → Run
     4. Paste your values below */
  SUPABASE_URL: "https://lkuuwoocxchjisodegur.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxrdXV3b29jeGNoamlzb2RlZ3VyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5MzU5MjMsImV4cCI6MjEwMTUxMTkyM30.dGLxbkGIOfJ6Mo3BPKIEZZ6mjVZe3m1H56oaQam95KA",

  /* Google Sheets — optional BACKUP only.
     Leave empty to disable. */
  SHEETS_URL: "",
  SHEETS_TOKEN: ""
};
