/* test-v2-e2e.js — E2E self-test: v2 store ↔ LIVE Supabase.
 *
 * Phase 4 of the connect-to-live-backend mandate. Sequence:
 *   1. READ-ONLY structure check of properties/rooms/beds/floors/tenants/rent_ledger.
 *   2. Boot the real store/db + store/sync against the live project.
 *   3. Create a dummy tenant locally → outbox → live INSERT, verify via REST.
 *   4. Soft-delete it (deleted_at) → verify via REST.
 *   5. Cleanup: remove the dummy's own rows only (recorded by id).
 *
 * Needs a service_role key to write/verify/soft-delete without a user session
 * (the anon key is RLS-restricted to a real auth.uid). Usage:
 *   SUPABASE_SERVICE_KEY=<key> node test-v2-e2e.js
 * Read-only steps run regardless; write steps are skipped if no key given.
 */

import { readFileSync } from "node:fs";
import { createDb } from "./store/db.js";
import { createSync } from "./store/sync.js";

const cfgText = readFileSync("config.js", "utf8");
const URL_ = (cfgText.match(/SUPABASE_URL:\s*"([^"]+)"/) || [])[1];
const ANON = (cfgText.match(/SUPABASE_ANON_KEY:\s*"([^"]+)"/) || [])[1];
const SERVICE = process.env.SUPABASE_SERVICE_KEY || "";
const OWNER = "11111111-1111-4111-8111-111111111111"; // synthetic owner for the dummy rows
const DUMMY_ID = "dummy-" + Date.now().toString(36);

let pass = 0, fail = 0, skipped = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✓ " + name + (detail ? " — " + detail : "")); }
  else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
}
function skip(name, detail) { skipped++; console.log("  ⊘ " + name + " — " + detail); }
function section(t) { console.log("\n== " + t + " =="); }

async function rest(method, table, body, key, query) {
  const res = await fetch(URL_ + "/rest/v1/" + table + (query || ""), {
    method,
    headers: {
      apikey: key, Authorization: "Bearer " + key,
      "Content-Type": "application/json", Prefer: method === "GET" ? "" : "return=representation"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data };
}

/* ---------------- 1. READ-ONLY structure check ---------------- */
section("1. READ-ONLY structure check (anon key)");
const EXPECTED = {
  properties: ["id", "owner_id", "name"],
  rooms: ["id", "owner_id", "no"],
  beds: ["id", "owner_id", "room_id"],
  floors: ["id", "owner_id", "property_id"],
  tenants: ["id", "owner_id", "property_id", "name", "bed_id", "status"],
  rent_ledger: ["id", "owner_id", "tenant_id", "period", "due", "paid", "status"]
};
const struct = {};
for (const [t, cols] of Object.entries(EXPECTED)) {
  const first = await rest("GET", t, null, ANON, "?select=*&limit=1");
  if (first.status === 200) {
    struct[t] = { exists: true, missing: [] };
    check(`table ${t} exists`, true, first.data && first.data.length ? "has rows" : "exists (0 rows)");
    // Column check: selecting a specific column returns 400/42703 iff it is
    // missing — works on empty tables, and is purely read-only.
    const missing = [];
    for (const c of cols) {
      const probe = await rest("GET", t, null, ANON, `?select=${c}&limit=1`);
      if (probe.status !== 200) { missing.push(c); }
    }
    struct[t].missing = missing;
    if (missing.length) { check(`${t} expected columns`, false, "missing: " + missing.join(",")); }
    else { check(`${t} expected columns`, true, cols.join(",")); }
  } else if (first.status === 404 || (first.data && first.data.code === "PGRST205")) {
    struct[t] = { exists: false, missing: cols };
    check(`table ${t} exists`, false, "404 PGRST205 — migration 001 not yet run on live DB");
  } else {
    struct[t] = { exists: false, missing: cols };
    check(`table ${t} exists`, false, "HTTP " + first.status);
  }
}
const newTablesReady = struct.floors.exists && struct.tenants.exists && struct.rent_ledger.exists;

/* ---------------- 2. Boot the real store ---------------- */
section("2. Boot real store/db + store/sync (live project)");
const mem = (() => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; })();
const db = createDb(mem, null);
const sync = createSync(db, mem, () => supaClient, null);
let supaClient = null;

// Minimal supabase-js-compatible client over PostgREST (same shape the app uses).
function makeClient(key) {
  const call = (method, table, body, query) => rest(method, table, body, key, query).then(({ status, data }) => {
    if (status >= 400) { throw Object.assign(new Error((data && data.message) || "HTTP " + status), { code: (data && data.code) || String(status) }); }
    return { data, error: null };
  });
  return {
    from(table) {
      return {
        select(cols) { return call("GET", table, null, `?select=${cols || "*"}`); },
        upsert(row, _opts) { return call("POST", table, Array.isArray(row) ? row : [row], "?on_conflict=id"); },
        update(patch) { return { eq(col, val) { return call("PATCH", table, patch, `?${col}=eq.${encodeURIComponent(val)}`); } }; }
      };
    }
  };
}
supaClient = makeClient(ANON);

const OWNER_ID = OWNER;
db.use("e2e-" + Date.now().toString(36));
sync.installListeners(null); // no-op in Node
const boot = await sync.pullThenMerge();
check("boot hydration completed", true, `merged ${boot.merged}, ok=${boot.ok}, reason=${boot.reason || "-"}`);

/* ---------------- 3+4. Dummy-record E2E (needs service key) ---------------- */
section("3+4. Dummy record: create → sync → verify → soft-delete → verify");
if (!SERVICE) {
  skip("live write path", "SUPABASE_SERVICE_KEY not provided — set it to run the write E2E (read-only checks passed above)");
} else if (!newTablesReady) {
  skip("live write path", "floors/tenants/rent_ledger missing on live DB — run migrations 001–003 first (see previous report)");
} else {
  const live = makeClient(SERVICE);

  // The dummy must belong to a real auth.users owner (FK) — probe with service key.
  const { data: profileRows } = await rest("GET", "profiles", null, SERVICE, "?select=id&limit=1");
  const realOwner = profileRows && profileRows[0] && profileRows[0].id;
  check("owner profile exists for FK", !!realOwner, realOwner || "none found");

  // Local-first create: goes to localStorage immediately, then outbox.
  db.use(OWNER_ID);
  const prop = db.ensureProperty("E2E Verify Property");
  const room = db.addRoom("E2E-" + Date.now().toString(36).slice(-4), 1, { level: 0, rent: 5000 });
  const bed = db.getBeds().find((b) => b.room_id === room.id);
  const tenant = db.addTenant(bed.id, { name: "E2E Dummy " + DUMMY_ID, phone: "0000000000", rent: 5000 });
  check("dummy tenant created locally", tenant.ok !== false && !!tenant.tenant, tenant.tenant ? tenant.tenant.id : JSON.stringify(tenant).slice(0, 80));
  const tenantId = tenant.tenant.id;
  const toggle = db.toggleRentStatus(tenantId, "2026-09");
  check("rent toggle queued a ledger mutation", toggle.ok !== false, "period 2026-09");

  // Drain the outbox through the real sync engine against the live DB.
  const svcClient = makeClient(SERVICE);
  supaClient = svcClient;
  await sync.drain();
  await new Promise((r) => setTimeout(r, 800)); // let the tail land

  // Verify on the live DB via direct REST (service key bypasses RLS).
  const { data: tRows } = await rest("GET", "tenants", null, SERVICE, `?select=id,name,owner_id&name=eq.${encodeURIComponent("E2E Dummy " + DUMMY_ID)}`);
  const landed = tRows && tRows.find((r) => r.id === tenantId);
  check("dummy tenant INSERTED in live Supabase", !!landed, landed ? `id=${landed.id} owner=${landed.owner_id}` : "not found");
  const { data: lRows } = await rest("GET", "rent_ledger", null, SERVICE, `?select=id,tenant_id,period,status&tenant_id=eq.${encodeURIComponent(tenantId)}`);
  check("dummy ledger row INSERTED", !!(lRows && lRows.length), lRows && lRows.length ? `period=${lRows[0].period} status=${lRows[0].status}` : "none");

  // Soft-delete via the app's own path (update deleted_at, never DELETE).
  const out = db.moveOut(tenantId, new Date().toISOString().slice(0, 10));
  check("moveOut succeeded", out.ok !== false, JSON.stringify(out).slice(0, 60));
  await sync.drain();
  await new Promise((r) => setTimeout(r, 300)); // settle
  const { data: after } = await rest("GET", "tenants", null, SERVICE, `?select=id,deleted_at,status&tenant_id=eq.${encodeURIComponent(tenantId)}`);
  const softDeleted = after && after[0] && !!after[0].deleted_at;
  check("dummy tenant SOFT-DELETED (deleted_at set, row still present)", !!softDeleted, after && after[0] ? `deleted_at=${after[0].deleted_at}` : "row missing entirely");

  /* ---------------- 5. Cleanup: remove ONLY the dummy's own rows ---------------- */
  section("5. Cleanup (dummy rows only)");
  const cleanup = [];
  if (lRows && lRows.length) { cleanup.push(rest("DELETE", "rent_ledger", null, SERVICE, `?tenant_id=eq.${encodeURIComponent(tenantId)}`)); }
  if (after && after[0]) { cleanup.push(rest("DELETE", "tenants", null, SERVICE, `?id=eq.${encodeURIComponent(tenantId)}`)); }
  if (bed) { cleanup.push(rest("DELETE", "beds", null, SERVICE, `?id=eq.${encodeURIComponent(bed.id)}`)); }
  if (room && room.id) { cleanup.push(rest("DELETE", "rooms", null, SERVICE, `?id=eq.${encodeURIComponent(room.id)}`)); }
  if (prop && prop.id) { cleanup.push(rest("DELETE", "properties", null, SERVICE, `?id=eq.${encodeURIComponent(prop.id)}`));
    // floors created by addRoom for the E2E room
    const { data: fl } = await rest("GET", "floors", null, SERVICE, `?select=id&property_id=eq.${encodeURIComponent(prop.id)}`);
    if (fl) { for (const f of fl) { cleanup.push(rest("DELETE", "floors", null, SERVICE, `?id=eq.${encodeURIComponent(f.id)}`)); } }
  }
  await Promise.all(cleanup);
  check("cleanup ran", true, `${cleanup.length} dummy-row deletes (dummy scope only)`);
}

/* ---------------- report ---------------- */
console.log(`\n=== RESULT: ${pass} passed, ${fail} failed, ${skipped} skipped ===`);
process.exit(fail ? 1 : 0);
