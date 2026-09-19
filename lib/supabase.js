/* Supabase singleton for the rebuilt app (v2).
 *
 * The legacy app's "Multiple GoTrueClient instances" warning came from
 * creating clients in several files. Everything v2 needs hangs off ONE
 * shared instance created here. store/sync.js is the only consumer in the
 * app shell; tests import it with a mocked factory.
 *
 * Also loads standalone under Node (no window, no localStorage) so the
 * smoke tests can drive it with an injected mock factory.
 */

let client = null;      // supabase-js client (or test mock)
let accountId = null;   // owner uuid, set by useAccount()
let ready = false;

export function init(cfg, createClientFn) {
  if (ready) { return client; }
  ready = true;

  const url = cfg && cfg.url;
  const key = cfg && cfg.key;

  if (!url || !key) { return null; }              // offline/demo mode: local-only

  if (createClientFn) {
    client = createClientFn(url, key);            // injected (tests / custom)
  } else if (typeof window !== "undefined" && window.supabase) {
    client = window.supabase.createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  }
  return client;
}

/* Point the sync layer at one owner account (same id the legacy app uses). */
export function useAccount(id) {
  accountId = id || "local";
  return accountId;
}

export function getAccount() { return accountId; }
export function getClient() { return client; }
export function isCloud() { return !!client && !!accountId && accountId !== "local"; }

/* Current auth user id, or the local account id when signed out. */
export async function currentUserId() {
  if (!client) { return accountId || "local"; }
  try {
    const res = await client.auth.getSession();
    const uid = res && res.data && res.data.session && res.data.session.user && res.data.session.user.id;
    return uid || accountId || "local";
  } catch (e) {
    return accountId || "local";
  }
}

/* Sign out (clears the GoTrue session; local data stays for next sign-in). */
export async function signOut() {
  if (client) {
    try { await client.auth.signOut(); } catch (e) { /* session may be gone */ }
  }
}

/* ---- Feature 4: tenant verification documents (Supabase Storage) ----
   Private bucket 'tenant-documents'; path <owner_id>/<tenant_id>/<file>.
   RLS (migration 006) pins every op to the owner's own folder. Only the
   SIGNED URL + stable path land on the tenant row — never a public URL. */
export const BUCKET = "tenant-documents";
const MAX_DOC_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export async function uploadTenantDoc(tenantId, file) {
  if (!client) { return { ok: false, error: "Sign in to upload documents." }; }
  if (!file) { return { ok: false, error: "Choose a file first." }; }
  if (file.size > MAX_DOC_BYTES) { return { ok: false, error: "File too large (max 5 MB)." }; }
  if (!ALLOWED_TYPES.includes(file.type)) { return { ok: false, error: "Use JPG, PNG, WebP or PDF." }; }
  const uid = accountId && accountId !== "local" ? accountId : null;
  if (!uid) { return { ok: false, error: "No signed-in owner — cannot upload." }; }
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  const path = uid + "/" + tenantId + "/id-proof-" + Date.now() + "." + ext;
  try {
    const { error: upErr } = await client.storage.from(BUCKET).upload(path, file, {
      cacheControl: "3600", upsert: false, contentType: file.type
    });
    if (upErr) { return { ok: false, error: upErr.message }; }
    // Signed URL (1 h) — the bucket is private; this URL is the safe shareable.
    const { data: signed, error: signErr } = await client.storage.from(BUCKET).createSignedUrl(path, 3600);
    if (signErr) { return { ok: false, error: signErr.message, path }; }
    return { ok: true, path, url: signed && signed.signedUrl };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "upload failed" };
  }
}

export async function refreshDocUrl(tenantId, path) {
  if (!client || !path) { return null; }
  try {
    const { data } = await client.storage.from(BUCKET).createSignedUrl(path, 3600);
    return data && data.signedUrl;
  } catch (e) { return null; }
}
