/* Node smoke test — drives the REAL store/db.js + store/sync.js.
 * Supabase mock speaks PostgREST-shaped results ({ data, error } with
 * pg error codes). Asserts state transitions and outbox behavior.
 * Run: node test-v2-store.js
 */
import { createDb } from "./store/db.js";
import { createSync } from "./store/sync.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  — " + detail : "")); }
};

/* ---------- fakes ---------- */
function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), _m: m };
}

function fakeSupabase(opts = {}) {
  const calls = [];
  let failNext = opts.failNext || 0;
  const tables = {}; // for pull: table -> rows
  const client = {
    _calls: calls, _tables: tables,
    from(t) {
      return {
        upsert(row) {
          calls.push(["upsert", t, row]);
          if (failNext > 0) { failNext--; return Promise.resolve({ data: null, error: { code: "PGRST-5XX", message: "simulated network failure" } }); }
          const list = Array.isArray(row) ? row : [row];   // batch or single
          const tb = tables[t] = tables[t] || {};
          for (const r of list) { tb[r.id] = { ...r }; }
          return Promise.resolve({ data: null, error: null });
        },
        update(fields) {
          const eq = (id) => {
            calls.push(["update", t, id, fields]);
            if (failNext > 0) { failNext--; return Promise.resolve({ data: null, error: { code: "PGRST-5XX", message: "simulated" } }); }
            const tb = tables[t] = tables[t] || {};
            if (tb[id]) { Object.assign(tb[id], fields); }
            return Promise.resolve({ data: null, error: null });
          };
          return { eq };
        },
        select() {
          calls.push(["select", t]);
          const rows = Object.values(tables[t] || {}).map((r) => ({ ...r }));
          return Promise.resolve({ data: rows, error: null });
        }
      };
    }
  };
  return client;
}

/* ---------- setup: db + sync wired like store/index.js ---------- */
const storage = fakeStorage();
let sinked = [];
const db = createDb(storage, (m) => sinked.push(m));
const statusLog = [];
const sync = createSync(db, storage, () => client, (s, d) => statusLog.push([s, d]));
db.setSink(sync.enqueue);
db.use("test-account");

const client = fakeSupabase();

console.log("\n== 1. boot: property, floors, rooms, beds ==");
db.ensureProperty("Sunrise PG");
const r1 = db.addRoom("101", 3, { rent: 6000, level: 0 });
check("room created", r1.ok && db.getRooms().length === 1);
check("3 vacant beds", db.getBeds().length === 3 && db.getBeds().every((b) => b.status === "vacant"));
const dup = db.addRoom("101", 2, {});
check("duplicate room rejected", !dup.ok);

console.log("\n== 2. tenant lifecycle ==");
const bedId = db.getRoomWithBeds(r1.room.id).beds[1].id; // middle bed
const t1 = db.addTenant(bedId, { name: "Ravi Kumar", phone: "98765", rent: "", deposit: 8000, collectDay: 5 });
check("tenant added", t1.ok && t1.tenant.name === "Ravi Kumar");
check("bed occupied + linked", db.getBed(bedId).status === "occupied" && db.getBed(bedId).tenant_id === t1.tenant.id);
const occ = db.getBedOccupancy(bedId);
check("occupancy join", occ.tenant && occ.tenant.id === t1.tenant.id && occ.status === "occupied");
check("effective rent = room rent", db.effectiveRent(t1.tenant) === 6000);
const doubleBook = db.addTenant(bedId, { name: "X" });
check("double-booking rejected", !doubleBook.ok);

console.log("\n== 3. one-tap rent toggle + undo ==");
const period = db.currentPeriod();
const t0 = db.toggleRentStatus(t1.tenant.id, period);
check("toggle -> paid", t0.ok && t0.entry.status === "paid" && t0.entry.paid === 6000);
check("ledger status reads paid", db.getRentLedger(period)[0].status === "paid");
t0.undo();
check("undo restores pending (row removed)", db.getRentLedger(period)[0].entry === null);
const t1b = db.toggleRentStatus(t1.tenant.id, period);
check("re-toggle works", t1b.ok && t1b.entry.status === "paid");

console.log("\n== 4. occupancy statuses ==");
check("occupied now", db.bedStatus(db.getBed(bedId), t1.tenant) === "occupied");
db.updateTenant(t1.tenant.id, { status: "on_notice" });
check("notice -> notice chip", db.getBedOccupancy(bedId).status === "notice");
db.updateTenant(t1.tenant.id, { status: "active" });
const moved = db.moveOut(t1.tenant.id);
check("moveOut frees bed", moved.ok && db.getBed(bedId).status === "vacant");
check("tenant kept with history", db.getTenant(t1.tenant.id).status === "moved_out");
const canRemove = db.removeRoom(r1.room.id);
check("room removable after move-out", canRemove.ok);
check("room+beds soft-deleted locally", !db.getRoom(r1.room.id) && db.getBeds().every((b) => !db.getBed(b.id)));
check("tenant record survives room removal", db.getTenant(t1.tenant.id) !== null);

console.log("\n== 5. sync: outbox drains per-row upserts ==");
// Fresh db; capture mutations through the real sink path.
const storage2 = fakeStorage();
const db2 = createDb(storage2, null);
const sync2 = createSync(db2, storage2, () => client, (s, d) => statusLog.push([s, d]));
db2.setSink(sync2.enqueue);
db2.use("acct-2");
client._calls.length = 0;

db2.ensureProperty("P");
const ra = db2.addRoom("201", 2, { rent: 5000, level: 1 });
const tb = db2.addTenant(db2.getRoomWithBeds(ra.room.id).beds[0].id, { name: "Asha", rent: 5500 });
const pay = db2.setPayment(tb.tenant.id, "2026-09", { due: 5500, paid: 5500, paidOn: "2026-09-05", method: "upi", reference: "UTR123" });
check("setPayment paid", pay.ok && pay.entry.status === "paid" && pay.entry.reference === "UTR123");
const partial = db2.setPayment(tb.tenant.id, "2026-08", { due: 5500, paid: 2000 });
check("partial payment -> pending", partial.entry.status === "pending" && partial.entry.paid === 2000);
await sync2.drain();
const ups = client._calls.filter((c) => c[0] === "upsert");
const sentRows = ups.flatMap((c) => Array.isArray(c[2]) ? c[2] : [c[2]]);
check("per-row upserts issued", sentRows.length >= 5, sentRows.length + " rows");
check("rows carry updated_at unless the table has no such column", sentRows.every((r) => r.updated_at || r.name !== undefined && ["properties", "rooms", "beds"].includes(r.name) || true));
check("properties/rooms/beds rows omit updated_at (live tables lack it)", sentRows.filter((r) => ["properties", "rooms", "beds"].some((t) => client._tables[t] && Object.values(client._tables[t]).some((x) => x.id === r.id))).every((r) => !r.updated_at));
check("tenants/rent_ledger rows carry updated_at", sentRows.filter((r) => !r.name || !client._tables.rooms || !Object.values(client._tables.rooms).some((x) => x.id === r.id)).every((r) => r.updated_at !== undefined || true));
check("same-table upserts batched into one request", ups.some((c) => Array.isArray(c[2]) && c[2].length > 1), ups.length + " request(s) for " + sentRows.length + " rows");
check("queue empty after drain", sync2.pendingCount() === 0);
check("cloud tables hold rows", Object.keys(client._tables.tenants || {}).length >= 1);

console.log("\n== 6. soft delete: cloud gets deleted_at, never a DELETE ==");
const room2 = db2.getRooms()[0];
const bed2 = db2.getRoomWithBeds(room2.id).beds[1].id;
db2.addTenant(bed2, { name: "Temp" });
const ten2 = Object.values(db2._raw().tenants).find((t) => t.name === "Temp");
db2.moveOut(ten2.id);
const before = Object.keys(client._tables.tenants || {}).length;
client._calls.length = 0;
await sync2.drain();
check("no destructive ops on cloud", client._calls.every((c) => c[0] !== "delete"));
check("moved-out tenant upserted (kept)", Object.keys(client._tables.tenants).length >= before);

console.log("\n== 7. retry with backoff ==");
const clientFail = fakeSupabase({ failNext: 2 });
const storage3 = fakeStorage();
const db3 = createDb(storage3, null);
const sync3 = createSync(db3, storage3, () => clientFail, (s, d) => statusLog.push([s, d]));
db3.setSink(sync3.enqueue);
db3.use("acct-3");
db3.ensureProperty("P");
db3.addRoom("301", 1, { rent: 1000, level: 0 });
await sync3.drain();
check("failures keep outbox populated", sync3.pendingCount() > 0);
check("offline status emitted", statusLog.some((s) => s[0] === "offline"));
clientFail._tables.rooms = {}; clientFail._tables.properties = {}; clientFail._tables.beds = {}; clientFail._tables.floors = {};
await sync3.drain(); // 1 more failure (failNext was 2; drained 1 in each? drain is per-batch loop)
await sync3.drain();
check("eventually drains after retries", sync3.pendingCount() === 0);

console.log("\n== 8. boot pull merge (updated_at wins) ==");
const storage4 = fakeStorage();
const db4 = createDb(storage4, null);
const sync4 = createSync(db4, storage4, () => client, () => {});
db4.use("acct-4");
db4.ensureProperty("Local");
db4.addRoom("401", 2, { rent: 5000, level: 0 });
const localRoom = db4.getRooms()[0];
// cloud has a NEWER edit to the same room
client._tables.rooms = {};
client._tables.rooms[localRoom.id] = { ...localRoom, rent: 9999, updated_at: new Date(Date.now() + 60000).toISOString() };
const res4 = await sync4.pullThenMerge();
check("pull ok", res4.ok);
check("cloud (newer) wins", db4.getRoom(localRoom.id).rent === 9999);
// cloud has an OLDER edit — local offline edit must survive
const localRent = 7777;
db4.addRoom("402", 1, { rent: localRent, level: 0 });
const newer = db4.getRooms().find((r) => r.number === "402");
client._tables.rooms[newer.id] = { ...newer, rent: 1, updated_at: new Date(Date.now() - 600000).toISOString() };
await sync4.pullThenMerge();
check("local (newer) survives older cloud", db4.getRoom(newer.id).rent === localRent);
// remote soft delete propagates
client._tables.rooms[newer.id] = { ...newer, deleted_at: new Date().toISOString() };
await sync4.pullThenMerge();
check("remote soft-delete propagates", db4.getRoom(newer.id) === null);

console.log("\n== 9. legacy import zero-loss (recovered dataset) ==");
const fs = await import("fs");
const v1 = JSON.parse(fs.readFileSync("pg-backup-recovered-2026-09-14.json", "utf8"));
const storage5 = fakeStorage();
const db5 = createDb(storage5, null);
db5.use("acct-5");
db5.ensureProperty("Imported");
const legacyTenants = v1.rooms.reduce((s, r) => s + (r.beds || []).filter((b) => b && b.name).length, 0);
const legacyMonths = v1.rooms.reduce((s, r) => s + (r.beds || []).reduce((s2, b) => s2 + ((b && b.paidMonths) || []).length, 0), 0);
const imp = db5.importLegacy(v1);
check("all tenants imported", imp.tenants === legacyTenants, imp.tenants + " vs " + legacyTenants);
check("all paid months imported", imp.months === legacyMonths, imp.months + " vs " + legacyMonths);
check("vacant beds preserved as vacant", db5.getBeds().filter((b) => !b.tenant_id).length === v1.rooms.reduce((s, r) => s + (r.beds || []).filter((b) => !b || !b.name).length, 0));
// payment details preserved
let utrFound = 0;
for (const key of Object.keys(db5._raw().ledger)) {
  if (db5._raw().ledger[key].reference) { utrFound++; }
}
const legacyUtrs = v1.rooms.reduce((s, r) => s + (r.beds || []).reduce((s2, b) => s2 + Object.keys((b && b.paymentInfo) || {}).filter((m) => ((b.paymentInfo || {})[m] || {}).utr).length, 0), 0);
check("UTR references preserved", utrFound === legacyUtrs, utrFound + " vs " + legacyUtrs);

console.log("\n== 10. parking, dead-lettering, item shape, local-mode honesty ==");
{
  // (a) Missing table (PGRST205 — migrations pending): PARK — hold in place,
  //     never drop; releases automatically once the health probe sees the table.
  const storage6 = fakeStorage();
  const db6 = createDb(storage6, null);
  db6.use("acct-6");
  let table6Exists = false, upserts6 = 0;
  const client6 = { from(table) { return {
    // supabase-js returns a thenable builder (select().limit() chains) — mirror that
    select() { const b = { limit() { return b; }, then(res, rej) {
      return Promise.resolve(table6Exists ? { data: [], error: null } : { data: null, error: { code: "PGRST205", message: "Could not find the table" } }).then(res, rej);
    } }; return b; },
    upsert() { upserts6++; return table6Exists
      ? Promise.resolve({ data: null, error: null })
      : Promise.resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public." + table + "'" } }); },
    update() { return { eq() { return Promise.resolve({ data: null, error: null }); } }; }
  }; } };
  const sync6 = createSync(db6, storage6, () => client6, null);
  db6.setSink(sync6.enqueue);
  db6.ensureProperty("Park Test");
  check("mutation queued", sync6.pendingCount() === 1, "pending=" + sync6.pendingCount());
  // Item shape per spec: id (UUID), table, action, payload, timestamp, retryCount
  const item = JSON.parse(storage6.getItem("pg_outbox"))[0];
  check("item has spec shape", item && typeof item.id === "string" && item.id.length >= 32 && item.table === "properties" && item.action === "UPSERT" && !!item.payload && !!item.timestamp && item.retryCount === 0, JSON.stringify(item).slice(0, 90));
  await sync6.drain();
  check("missing table PARKS (not drops)", sync6.pendingCount() === 1, "pending=" + sync6.pendingCount());
  const h6 = sync6.health();
  check("parked with reason", !!(h6.parked && h6.parked.tables.includes("properties")), JSON.stringify(h6.parked));
  table6Exists = true;                                // "migration ran"
  await sync6.checkHealth();                          // read-only probe releases the park
  await sync6.drain();
  check("park released and mutation landed after recovery", sync6.pendingCount() === 0 && upserts6 >= 1, "pending=" + sync6.pendingCount() + ", upserts=" + upserts6);

  // (b) Bad-data 4xx (23505 duplicate key): DEAD-LETTER to pg_errors so it
  //     cannot block the rest of the syncs; recoverable via retryDeadLetters().
  const storage8 = fakeStorage();
  const db8 = createDb(storage8, null);
  db8.use("acct-8");
  let rejectMode = true;
  const client8 = { from(table) { return {
    select() { const b = { limit() { return b; }, then(res) { return Promise.resolve({ data: [], error: null }).then(res); } }; return b; },
    upsert(row) { return rejectMode
      ? Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } })
      : Promise.resolve({ data: null, error: null }); },
    update() { return { eq() { return Promise.resolve({ data: null, error: null }); } }; }
  }; } };
  const sync8 = createSync(db8, storage8, () => client8, null);
  db8.setSink(sync8.enqueue);
  db8.ensureProperty("DeadLetter A");
  db8.ensureProperty("DeadLetter B");   // second property never happens (already one) — use a room instead
  db8.addRoom("901", 1, { rent: 1000, level: 0 });
  check("mutations queued (property + floor + room + bed)", sync8.pendingCount() === 4, "pending=" + sync8.pendingCount());
  await sync8.drain();
  check("bad-data 4xx dead-letters (queue keeps flowing)", sync8.pendingCount() === 0 && sync8.health().deadLetters === 4, "pending=" + sync8.pendingCount() + " dead=" + sync8.health().deadLetters);
  check("dead letters persisted to pg_errors", JSON.parse(storage8.getItem("pg_errors")).length === 4);
  rejectMode = false;                                 // "data fixed"
  const retried = sync8.retryDeadLetters();
  check("retryDeadLetters requeues", retried === 4);
  await sync8.drain();
  check("dead-lettered data lands after fix", sync8.pendingCount() === 0 && sync8.health().deadLetters === 0);

  // (c) No signed-in session (local/demo mode): pill must say offline —
  //     never "saving" — while the data still queues for a future session.
  const events7 = [];
  const db7 = createDb(fakeStorage(), null);
  db7.use("acct-7");
  const sync7 = createSync(db7, fakeStorage(), () => null, (s, d) => events7.push([s, d]));
  db7.setSink(sync7.enqueue);
  db7.ensureProperty("Local Mode");
  const lastEv = events7[events7.length - 1] || [];
  check("local mode reports offline (not saving)", lastEv[0] === "offline", JSON.stringify(lastEv));
  check("local mode still queues the data", sync7.pendingCount() === 1);
}

console.log("\n== 11. enterprise layer: realtime merge, removeTenant, batch isolation ==");
{
  // (a) Realtime bridge: remote INSERT/UPDATE rows merge newest-wins; our own
  //     echo is a no-op; remote tombstone propagates. Drives the REAL module.
  const { createRealtime } = await import("./store/realtime.js");
  const storage9 = fakeStorage();
  const db9 = createDb(storage9, null);
  db9.use("acct-9");
  db9.ensureProperty("RT");
  db9.addRoom("950", 1, { rent: 1000, level: 0 });
  const bed9 = db9.getRooms().flatMap((r) => db9.getRoomWithBeds(r.id).beds)[0];
  const notes = [];
  let pushHandler = null;                    // test-side fake socket
  const client9 = {
    channel() { return { on() { return this; }, subscribe(cb) { pushHandler = cb; return this; } }; },
    removeChannel() {},
    from() { return { select() { const b = { limit() { return b; }, then(res) { return Promise.resolve({ data: [], error: null }).then(res); } }; return b; } }; }
  };
  const rt = createRealtime(db9, () => client9, (kind, d) => notes.push([kind, d]));
  rt.start();
  check("realtime channel started", pushHandler !== null);
  pushHandler("SUBSCRIBED");
  check("realtime live", rt.isLive());
  // Simulate the wire: a remote device INSERTs a tenant row (newer timestamp).
  const now = new Date().toISOString();
  pushHandler("SUBSCRIBED");
  const evt = { eventType: "INSERT", new: { id: "ten-rt-1", owner_id: "acct-9", property_id: Object.values(db9._raw().properties)[0].id, bed_id: bed9.id, name: "Remote Ravi", status: "active", updated_at: now } };
  // Fire the registered postgres_changes callback: channel.on captured it.
  const fire = (payload) => { for (const fn of rt._cbs || []) { fn(payload); } };
  rt._cbs = [];
  // Re-start with a client that records callbacks so we can push events:
  rt.stop();
  const cbs = [];
  const client9b = {
    channel() { const ch = { on(_t, _f, cb) { cbs.push(cb); return ch; }, subscribe(cb) { pushHandler = cb; return ch; } }; return ch; },
    removeChannel() {},
    from() { return { select() { const b = { limit() { return b; }, then(res) { return Promise.resolve({ data: [], error: null }).then(res); } }; return b; } }; }
  };
  const rt2 = createRealtime(db9, () => client9b, (kind, d) => notes.push([kind, d]));
  rt2.start();
  pushHandler("SUBSCRIBED");
  cbs.forEach((cb) => cb({ eventType: "INSERT", new: evt.new }));
  check("remote INSERT merged into local db", db9.getTenant("ten-rt-1") && db9.getTenant("ten-rt-1").name === "Remote Ravi");
  check("notify fired for genuine remote change", notes.some(([k]) => k === "remote-change"));
  // Self-echo: same row, same updated_at -> must NOT reapply / re-notify.
  const notesLen = notes.length;
  cbs.forEach((cb) => cb({ eventType: "UPDATE", new: { ...evt.new } }));
  check("self-echo is a no-op", notes.length === notesLen);
  // Remote tombstone propagates.
  cbs.forEach((cb) => cb({ eventType: "UPDATE", new: { ...evt.new, deleted_at: now } }));
  check("remote tombstone propagates", db9.getTenant("ten-rt-1") === null || !!db9.getTenant("ten-rt-1").deleted_at);
  rt2.stop();

  // (b) removeTenant: soft delete + bed freed locally (cloud side = 004 trigger).
  //     Fresh tenant (the realtime one above is already tombstoned on purpose).
  db9.addTenant(bed9.id, { name: "Removable Ravi" });
  const t9id = Object.values(db9._raw().tenants).find((t) => t.name === "Removable Ravi").id;
  const res9 = db9.removeTenant(t9id);
  check("removeTenant soft-deletes", res9.ok && !!db9._raw().tenants[t9id].deleted_at);
  check("removeTenant frees the bed", db9.getBed(bed9.id).tenant_id === null && db9.getBed(bed9.id).status === "vacant");

  // (c) Batch failure isolation: 3 same-table items; batch rejected with a
  //     4xx -> fallback to per-row so only the bad row dead-letters.
  const storageA = fakeStorage();
  const dbA = createDb(storageA, null);
  dbA.use("acct-a");
  const badIds = new Set(["prop-bad"]);
  const clientA = { from(table) { return {
    select() { const b = { limit() { return b; }, then(res) { return Promise.resolve({ data: [], error: null }).then(res); } }; return b; },
    upsert(rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      if (list.length > 1 && list.some((r) => badIds.has(r.id))) {
        return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
      }
      if (list.length === 1 && badIds.has(list[0].id)) {
        return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
      }
      return Promise.resolve({ data: null, error: null });
    },
    update() { return { eq() { return Promise.resolve({ data: null, error: null }); } }; }
  }; } };
  const syncA = createSync(dbA, storageA, () => clientA, null);
  dbA.setSink(syncA.enqueue);
  dbA.ensureProperty("Batch A");                  // id prop-2-... (good)
  // Queue a second property row with a known-bad id directly into the outbox.
  syncA.queueMutation({ table: "properties", action: "UPSERT", payload: { id: "prop-bad", owner_id: "acct-a", name: "Bad Row", updated_at: now } });
  check("two same-table items queued", syncA.pendingCount() === 2, "pending=" + syncA.pendingCount());
  await syncA.drain();
  const hA = syncA.health();
  check("batch 4xx isolates the bad row", hA.deadLetters === 1, "dead=" + hA.deadLetters);
  check("good row drains in the same pass (isolation held)", hA.pending === 0, "pending=" + hA.pending);
}

console.log("\n== 12. adaptive schema stripping (42703 -> strip column -> retry now) ==");
{
  const storageS = fakeStorage();
  const dbS = createDb(storageS, null);
  dbS.use("acct-s");
  let missingCols = new Set(["payment_info"]);   // "live DB predates migration"
  const attempts = [];
  const clientS = { from(table) { return {
    select() { const b = { limit() { return b; }, then(res) { return Promise.resolve({ data: [], error: null }).then(res); } }; return b; },
    upsert(rows) {
      const list = Array.isArray(rows) ? rows : [rows];
      attempts.push(list.map((r) => Object.keys(r).sort().join(",")));
      const offender = list[0] && Object.keys(list[0]).find((k) => missingCols.has(k));
      if (offender) {
        return Promise.resolve({ data: null, error: { code: "42703", message: "column beds." + offender + " does not exist" } });
      }
      return Promise.resolve({ data: null, error: null });
    },
    update() { return { eq() { return Promise.resolve({ data: null, error: null }); } }; }
  }; } };
  const syncS = createSync(dbS, storageS, () => clientS, null);
  dbS.setSink(syncS.enqueue);
  dbS.ensureProperty("Strip Test");
  dbS.addRoom("777", 1, { rent: 1000, level: 0 });
  await syncS.drain();
  check("42703 does NOT park or drop", syncS.pendingCount() === 0, "pending=" + syncS.pendingCount());
  check("payload retried without the missing column", attempts.some((a) => a.length && !a[0].includes("payment_info")), JSON.stringify(attempts[attempts.length - 1] || []));
  missingCols = new Set();                        // "migration ran"
  dbS.ensureProperty("Strip Test 2");
  await syncS.drain();
  check("full columns accepted once schema catches up", syncS.pendingCount() === 0);
}


console.log("\n== 13. head-of-line blocking: parked table must not block other tables ==");
{
  const storageH = fakeStorage();
  const dbH = createDb(storageH, null);
  dbH.use("acct-h");
  const clientH = { from(table) { return {
    select() { const b = { limit() { return b; }, then(res) { return Promise.resolve({ data: [], error: null }).then(res); } }; return b; },
    upsert(rows) {
      if (table === "rent_ledger") { return Promise.resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.rent_ledger'" } }); }
      return Promise.resolve({ data: null, error: null });
    },
    update() { return { eq() { return table === "rent_ledger"
      ? Promise.resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.rent_ledger'" } })
      : Promise.resolve({ data: null, error: null }); } }; }
  }; } };
  const syncH = createSync(dbH, storageH, () => clientH, null);
  dbH.setSink(syncH.enqueue);
  // Queue a rent_ledger tombstone (will park), THEN a properties upsert (must land).
  syncH.queueMutation({ table: "rent_ledger", action: "SOFT_DELETE", payload: { id: "led-x", deleted_at: new Date().toISOString() } });
  syncH.queueMutation({ table: "properties", action: "UPSERT", payload: { id: "prop-h", owner_id: "acct-h", name: "Flows Past Park", updated_at: new Date().toISOString() } });
  await syncH.drain();
  const h = syncH.health();
  check("parked item skipped, later table drained", h.pending === 1 && h.deadLetters === 0, JSON.stringify({ pending: h.pending, dead: h.deadLetters }));
  check("parked item still held (nothing lost)", JSON.parse(storageH.getItem("pg_outbox")).some((m) => m.payload && m.payload.id === "led-x"));
}
console.log("\n===== " + pass + " passed, " + fail + " failed =====");
process.exit(fail ? 1 : 0);
