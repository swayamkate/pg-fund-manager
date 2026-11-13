#!/usr/bin/env node
/* Writes config/config.js from the build environment.
 *
 * Why this exists: config/config.js used to be edited by hand, so the project
 * URL and anon key lived in git and in every cached copy of the page. When the
 * Supabase project behind them went away, the deployed site kept pointing at a
 * host that no longer resolves and every sign-in failed with "Failed to fetch".
 * Generating the file at build time makes the deployed values reproducible and
 * keeps a stale key out of the repo.
 *
 * Cloudflare Pages → Settings → Build configuration
 *   Build command:          node scripts/build-config.mjs
 *   Build output directory: .
 *
 * Environment variables (set for BOTH Production and Preview):
 *   SUPABASE_URL        https://<project-ref>.supabase.co   (required)
 *   SUPABASE_ANON_KEY   anon public JWT or sb_publishable_… (required)
 *   SHEETS_URL          optional Apps Script /exec URL
 *   SHEETS_TOKEN        optional, visible in page source by design
 *   ALLOW_LOCAL_MODE=1  permit a build with no database (browser-only accounts)
 *
 * Refuses to build when the values are missing (unless ALLOW_LOCAL_MODE=1), when
 * the URL is not a Supabase host, or when the key is a secret key. A
 * service_role JWT is caught by decoding its role claim — the string
 * "service_role" never appears in the token text itself.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "config", "config.js");

function die(message) {
  console.error("[build-config] " + message);
  console.error("[build-config] refusing to write config/config.js");
  process.exit(1);
}

const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const key = String(process.env.SUPABASE_ANON_KEY || "").trim();
const sheetsUrl = String(process.env.SHEETS_URL || "").trim();
const sheetsToken = String(process.env.SHEETS_TOKEN || "").trim();
const localMode = String(process.env.ALLOW_LOCAL_MODE || "").trim() === "1";

function decodeRole(token) {
  const parts = token.split(".");
  if (parts.length !== 3) { return null; }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

function checkKey(value) {
  if (value.startsWith("sb_secret_")) {
    die("SUPABASE_ANON_KEY is a secret key (sb_secret_…). That bypasses Row Level Security and must never reach a browser. Use the anon / sb_publishable_ key.");
  }
  if (value.startsWith("sb_publishable_")) { return; }
  if (value.split(".").length === 3) {
    const role = decodeRole(value);
    if (role === null) { die("SUPABASE_ANON_KEY looks like a JWT but its payload cannot be read."); }
    if (role !== "anon") {
      die("SUPABASE_ANON_KEY is a JWT with role \"" + role + "\". Only the anon role belongs in a browser.");
    }
    return;
  }
  die("SUPABASE_ANON_KEY is neither a publishable key nor an anon JWT.");
}

if (url || key) {
  if (!url || !key) { die("Set both SUPABASE_URL and SUPABASE_ANON_KEY, or neither."); }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
    die("SUPABASE_URL must look like https://<project-ref>.supabase.co (got \"" + url + "\").");
  }
  checkKey(key);
} else if (!localMode) {
  die("SUPABASE_URL and SUPABASE_ANON_KEY are not set, so the build would deploy a site nobody can sign in to. Set them in the Pages environment, or set ALLOW_LOCAL_MODE=1 for a deliberate browser-only build.");
}

const content = `/* PG Manager — runtime configuration.
 *
 * GENERATED FILE. Do not edit and do not commit values here: Cloudflare Pages
 * runs scripts/build-config.mjs, which rewrites this file from the project's
 * build environment variables. Local edits are overwritten on the next build.
 *
 * The anon / publishable key below is public by design — it only identifies the
 * Supabase project, and Row Level Security decides what a signed-in user can
 * read. The service_role / sb_secret_ key must never appear here.
 *
 * Empty values mean this build has no database: auth.js falls back to
 * browser-only accounts, which is for local development, not for real users.
 */
window.PG_CONFIG = {
  SUPABASE_URL: ${JSON.stringify(url)},
  SUPABASE_ANON_KEY: ${JSON.stringify(key)},

  /* Optional Google Sheets backup. Empty = disabled. */
  SHEETS_URL: ${JSON.stringify(sheetsUrl)},
  SHEETS_TOKEN: ${JSON.stringify(sheetsToken)}
};
`;

writeFileSync(target, content, "utf8");

if (url) {
  console.log("[build-config] wrote config/config.js — supabase: configured (" + url + ")");
} else {
  console.warn("[build-config] wrote config/config.js — supabase: NOT configured (browser-only accounts). ALLOW_LOCAL_MODE=1 was set; never use this for production.");
}
