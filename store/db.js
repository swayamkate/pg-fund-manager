/* store/db.js — normalized, local-first state (v2 rebuild)
 *
 * One module owns ALL app state: properties, floors, rooms, beds, tenants,
 * rent_ledger. Every mutation persists to localStorage IMMEDIATELY
 * (local-first: the UI never waits on the network), then notifies:
 *   - subscribers (views) via a tiny pub/sub, tagged with a change channel
 *     so a view re-renders only what it owns
 *   - the outbox (store/sync.js) via a sink function — db never imports sync
 *
 * Collections are flat Maps keyed by id (the shape the Supabase tables use);
 * relationships are plain ids (bed.tenantId, room.floorId, tenant.bedId).
 * Inactive rows (deleted_at set by sync) are hidden from every read here —
 * soft deletes cannot leak into the UI.
 *
 * Loads standalone under Node for smoke tests (storage injected).
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function createDb(storage, sink) {
  /* storage: { getItem, setItem, removeItem } (localStorage or a Node shim)
     sink:    (mutation) => void — called AFTER commit for every mutation.
     setSink() allows late binding (sync.js needs db, db must not import
     sync — the shell wires db.setSink(sync.enqueue) after both load). */
  let sinkFn = sink;

  const KEY = "pgv2:<account>";
  let account = "local";
  let data = null;
  const subs = new Map();   // channel -> Set<fn>

  /* ---------------- persistence ---------------- */

  function load() {
    try {
      const raw = storage.getItem(KEY.replace("<account>", account));
      data = raw ? JSON.parse(raw) : blank();
    } catch (e) {
      data = blank();
    }
    return data;
  }

  function blank() {
    return {
      properties: {}, floors: {}, rooms: {}, beds: {},
      tenants: {}, ledger: {},                       // ledger: "<tenantId>|<period>" -> row
      propertyId: null,
      seq: 1                                         // local id counter (ids become uuids in cloud)
    };
  }

  function commit(channels, mutations) {
    try {
      storage.setItem(KEY.replace("<account>", account), JSON.stringify(data));
    } catch (e) {
      // Storage full/blocked is surfaced, never swallowed silently.
      emit("error", [{ ok: false, error: "Could not save locally: " + (e && e.message) }]);
    }
    (mutations || []).forEach((m) => { try { sinkFn && sinkFn(m); } catch (e) { /* sink owns its errors */ } });
    (channels || []).forEach((ch) => emit(ch, null));
  }

  /* ---------------- pub/sub ---------------- */

  function on(channel, fn) {
    if (!subs.has(channel)) { subs.set(channel, new Set()); }
    subs.get(channel).add(fn);
    return () => subs.get(channel).delete(fn);       // unsubscribe
  }

  function emit(channel, payload) {
    const set = subs.get(channel);
    if (set) { [...set].forEach((fn) => { try { fn(payload); } catch (e) { /* one bad view must not kill the rest */ } }); }
  }

  /* ---------------- lifecycle ---------------- */

  function use(newAccount) {
    account = String(newAccount || "local");
    load();
    emit("*", null);
    return data;
  }

  const live = (coll) => Object.values(data[coll]).filter((r) => !r.deleted_at);

  function nextId(prefix) { return prefix + "-" + (data.seq++) + "-" + Date.now().toString(36); }

  /* ---------------- queries (all respect soft deletes) ---------------- */

  const getProperty   = () => live("properties")[0] || null;
  const getFloors     = () => live("floors").sort((a, b) => a.level - b.level);
  function getRooms() {
    return live("rooms").sort((a, b) =>
      (floorsLevel(a.floor_id) - floorsLevel(b.floor_id)) ||
      String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  }
  const getBeds       = () => live("beds");
  const getTenants    = () => live("tenants");
  const getTenant     = (id) => { const t = data.tenants[id]; return t && !t.deleted_at ? t : null; };
  const getBed        = (id) => { const b = data.beds[id]; return b && !b.deleted_at ? b : null; };
  const getRoom       = (id) => { const r = data.rooms[id]; return r && !r.deleted_at ? r : null; };

  function floorsLevel(floorId) {
    const f = floorId && data.floors[floorId];
    return f && !f.deleted_at ? f.level : 0;
  }

  function floorsLabel(floorId) {
    const f = floorId && data.floors[floorId];
    return f && !f.deleted_at && f.label ? f.label : "Ground";
  }

  /* Room with its beds (beds sorted by slot) — the occupancy grid's unit. */
  function getRoomWithBeds(roomId) {
    const room = getRoom(roomId);
    if (!room) { return null; }
    const beds = live("beds").filter((b) => b.room_id === roomId).sort((a, b) => a.slot - b.slot);
    return { room, beds };
  }

  /* Bed + its current tenant + computed chip status for the grid. */
  function getBedOccupancy(bedId) {
    const bed = getBed(bedId);
    if (!bed) { return null; }
    const tenant = bed.tenant_id ? getTenant(bed.tenant_id) : null;
    return { bed, tenant, status: bedStatus(bed, tenant) };
  }

  function bedStatus(bed, tenant) {
    if (!tenant) { return "vacant"; }
    if (tenant.status === "on_notice") { return "notice"; }
    const period = currentPeriod();
    const l = data.ledger[tenant.id + "|" + period];
    if (l && l.status === "overdue") { return "overdue"; }
    return "occupied";
  }

  function currentPeriod(d) {
    const t = d || new Date();
    return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0");
  }

  /* All ledger rows for one month, joined with tenants (the rent view). */
  function getRentLedger(period) {
    const p = PERIOD_RE.test(period || "") ? period : currentPeriod();
    const rows = [];
    for (const t of getTenants()) {
      if (t.status === "moved_out") { continue; }
      const key = t.id + "|" + p;
      rows.push({
        tenant: t,
        entry: data.ledger[key] || null,
        dueAmount: effectiveRent(t),
        status: ledgerStatus(t, data.ledger[key], p)
      });
    }
    return rows.sort((a, b) => a.tenant.name.localeCompare(b.tenant.name));
  }

  /* An unset month: overdue only once the collect day has passed. */
  function ledgerStatus(tenant, entry, period) {
    if (entry && entry.status === "paid") { return "paid"; }
    if (entry && entry.status === "overdue") { return "overdue"; }
    const day = tenant.collect_day || 10;
    const today = new Date();
    const due = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, day);
    if (period < currentPeriod() || due < today) { return "overdue"; }
    return "pending";
  }

  function effectiveRent(tenant) {
    if (tenant.rent_amount != null) { return tenant.rent_amount; }
    const bed = tenant.bed_id && data.beds[tenant.bed_id];
    const room = bed && data.rooms[bed.room_id];
    return (room && room.rent) || 0;
  }

  /* ---------------- mutations (each: local write -> commit -> outbox) ---------------- */

  function ensureProperty(name) {
    let p = getProperty();
    if (!p) {
      p = { id: nextId("prop"), owner_id: account, name: name || "My Property", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      data.properties[p.id] = p;
      data.propertyId = p.id;
      // Guard: only enqueue the cloud upsert when the owner row exists in
      // auth.users (properties.owner_id is an FK to it). Sessions without a
      // profiles row stay local-only; sync reports why instead of retrying.
      // Node (no window) is a test environment — the guard only applies in
      // the browser, where the boot probe always sets the flag.
      const hasProfile = (typeof window !== "undefined") ? window.__PGV2_HAS_PROFILE__ === true : true;
      commit(["property", "*"], hasProfile ? [upsert("properties", p)] : []);
    }
    return p;
  }

  /* Mutation shapes consumed by store/sync.js queueMutation().
     UPSERT: { table, action: "UPSERT", payload: <full row> }
     SOFT_DELETE: { table, action: "SOFT_DELETE", payload: <full row with deleted_at set> }
     The cloud write for BOTH is an upsert — a SQL DELETE is never sent. */
  function upsert(table, row) {
    return { table, action: "UPSERT", payload: row };
  }

  function addFloor(level, label) {
    const p = ensureProperty();
    let f = live("floors").find((x) => x.level === level);
    if (!f) {
      f = { id: nextId("floor"), owner_id: account, property_id: p.id, level, label: label || floorLabel(level), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      data.floors[f.id] = f;
      commit(["floors", "*"], [upsert("floors", f)]);
    }
    return f;
  }

  function floorLabel(level) { return level === 0 ? "Ground" : "Floor " + level; }

  function addRoom(number, bedCount, opts) {
    const o = opts || {};
    if (!number || !String(number).trim()) { return { ok: false, error: "Room needs a number or name." }; }
    const n = Number(bedCount);
    if (!(n >= 1 && n <= 12)) { return { ok: false, error: "A room needs between 1 and 12 beds." }; }
    const dup = live("rooms").some((r) => String(r.number).toLowerCase() === String(number).toLowerCase());
    if (dup) { return { ok: false, error: "Room " + number + " already exists." }; }

    const p = ensureProperty();
    const floor = addFloor(Number(o.level) || 0);
    const room = {
      id: nextId("room"), owner_id: account, property_id: p.id, floor_id: floor.id,
      number: String(number).trim(), rent: Math.max(0, Number(o.rent) || 0),
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    data.rooms[room.id] = room;
    const mutations = [upsert("rooms", room)];
    for (let i = 0; i < n; i++) {
      const bed = { id: room.id + "-b" + i, owner_id: account, room_id: room.id, property_id: p.id, slot: i, tenant_id: null, status: "vacant", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      data.beds[bed.id] = bed;
      mutations.push(upsert("beds", bed));
    }
    commit(["rooms", "beds", "*"], mutations);
    return { ok: true, room };
  }

  function removeRoom(roomId) {
    const room = getRoom(roomId);
    if (!room) { return { ok: false, error: "Room not found." }; }
    const beds = live("beds").filter((b) => b.room_id === roomId);
    const tenants = beds.map((b) => b.tenant_id && getTenant(b.tenant_id)).filter(Boolean);
    if (tenants.length) { return { ok: false, error: "Move out the " + tenants.length + " tenant(s) in room " + room.number + " first." }; }
    const now = new Date().toISOString();
    const mutations = [];
    for (const b of beds) {
      data.beds[b.id].deleted_at = now;
      mutations.push(softDelete("beds", b.id, now));
    }
    data.rooms[roomId].deleted_at = now;
    mutations.push(softDelete("rooms", roomId, now));
    commit(["rooms", "beds", "*"], mutations);
    return { ok: true };
  }

  /* Tombstone: the FULL row with deleted_at set (pushed as an UPSERT, never
     a DELETE). Falls back to a minimal tombstone when the local row is
     already gone (ledger rows are keyed "tenantId|period", not by id). */
  function softDelete(table, id, at, row) {
    const map = table === "rent_ledger" ? "ledger" : table;
    const full = row || (data[map] && data[map][id]) || null;
    const payload = full ? { ...full, deleted_at: at } : { id, deleted_at: at, updated_at: at };
    return { table, action: "SOFT_DELETE", payload };
  }

  /* Assign a tenant to a vacant bed. */
  function addTenant(bedId, t) {
    const bed = getBed(bedId);
    if (!bed) { return { ok: false, error: "Bed not found." }; }
    if (bed.tenant_id) { return { ok: false, error: "That bed is already taken." }; }
    const name = String(t && t.name || "").trim();
    if (!name) { return { ok: false, error: "Enter the tenant's name." }; }

    const p = ensureProperty();
    const now = new Date().toISOString();
    const tenant = {
      id: nextId("ten"), owner_id: account, property_id: p.id, bed_id: bedId,
      name, phone: String(t.phone || "").trim(),
      id_type: String(t.idType || "").trim(), id_number: String(t.idNumber || "").trim(),
      emergency_contact: String(t.emergencyContact || "").trim(), workplace: String(t.workplace || "").trim(),
      joined_on: t.joined || todayISO(), planned_leave_on: t.plannedLeave || null, left_on: null,
      status: t.onNotice ? "on_notice" : "active",
      rent_amount: t.rent != null && t.rent !== "" ? Math.max(0, Number(t.rent)) : null,
      collect_day: clampDay(t.collectDay), deposit: Math.max(0, Number(t.deposit) || 0),
      notes: String(t.notes || "").trim(),
      created_at: now, updated_at: now
    };
    data.tenants[tenant.id] = tenant;
    data.beds[bedId].tenant_id = tenant.id;
    data.beds[bedId].status = "occupied";
    data.beds[bedId].updated_at = now;
    commit(["tenants", "beds", "*"], [upsert("tenants", tenant), upsert("beds", data.beds[bedId])]);
    return { ok: true, tenant };
  }

  function clampDay(v) {
    const n = Math.floor(Number(v));
    return (n >= 1 && n <= 31) ? n : 0;
  }

  function todayISO(d) { return (d || new Date()).toISOString().slice(0, 10); }

  function updateTenant(tenantId, patch) {
    const t = getTenant(tenantId);
    if (!t) { return { ok: false, error: "Tenant not found." }; }
    const editable = ["name", "phone", "id_type", "id_number", "emergency_contact", "workplace", "notes"];
    const now = new Date().toISOString();
    for (const k of editable) {
      if (patch[k] !== undefined) { t[k] = String(patch[k]).trim(); }
    }
    if (patch.rentAmount !== undefined) { t.rent_amount = patch.rentAmount === "" || patch.rentAmount == null ? null : Math.max(0, Number(patch.rentAmount)); }
    if (patch.collectDay !== undefined) { t.collect_day = clampDay(patch.collectDay); }
    if (patch.deposit !== undefined) { t.deposit = Math.max(0, Number(patch.deposit) || 0); }
    if (patch.status && ["active", "on_notice", "moved_out"].includes(patch.status)) { t.status = patch.status; }
    if (patch.id_proof_url !== undefined) { t.id_proof_url = String(patch.id_proof_url || ""); }
    if (patch.id_proof_path !== undefined) { t.id_proof_path = String(patch.id_proof_path || ""); }
    t.updated_at = now;
    commit(["tenants", "*"], [upsert("tenants", t)]);
    return { ok: true, tenant: t };
  }

  /* Remove a tenant: SOFT delete only (identity + ledger history survive as
     tombstones). The local bed frees immediately; on the cloud side the
     004 trigger frees the bed when the tombstone lands. */
  function removeTenant(tenantId) {
    const t = getTenant(tenantId);
    if (!t) { return { ok: false, error: "Tenant not found." }; }
    const now = new Date().toISOString();
    const bed = t.bed_id && data.beds[t.bed_id];
    if (bed) {
      bed.tenant_id = null;
      bed.status = "vacant";
      bed.updated_at = now;
    }
    t.deleted_at = now;
    t.updated_at = now;
    const m = [softDelete("tenants", t.id, now, t)];
    if (bed) { m.push(upsert("beds", bed)); }
    commit(["tenants", "beds", "*"], m);
    return { ok: true };
  }

  /* Move out: bed is freed, tenant history is kept (identity survives). */
  function moveOut(tenantId, date) {
    const t = getTenant(tenantId);
    if (!t) { return { ok: false, error: "Tenant not found." }; }
    const now = new Date().toISOString();
    t.status = "moved_out";
    t.left_on = date || todayISO();
    t.updated_at = now;
    const bed = t.bed_id && data.beds[t.bed_id];
    if (bed) {
      bed.tenant_id = null;
      bed.status = "vacant";
      bed.updated_at = now;
    }
    commit(["tenants", "beds", "*"], [upsert("tenants", t), bed ? upsert("beds", bed) : null].filter(Boolean));
    return { ok: true };
  }

  /* THE one-tap action: paid <=> pending in one call.
     Returns the undo function (capturing the previous state). */
  function toggleRentStatus(tenantId, period) {
    const t = getTenant(tenantId);
    if (!t) { return { ok: false, error: "Tenant not found." }; }
    if (!PERIOD_RE.test(period || "")) { return { ok: false, error: "Bad period." }; }
    const key = tenantId + "|" + period;
    const prev = data.ledger[key] || null;
    const nowISO = new Date().toISOString();
    let entry;

    if (prev && prev.status === "paid") {
      entry = { ...prev, status: "pending", paid: 0, paid_on: null, method: null, reference: null, updated_at: nowISO };
    } else {
      entry = {
        id: prev ? prev.id : nextId("led"), owner_id: account, property_id: t.property_id,
        tenant_id: tenantId, period,
        due: effectiveRent(t), paid: effectiveRent(t), status: "paid",
        paid_on: todayISO(), method: "cash", reference: null,
        reminder_sent_at: null, note: "",
        created_at: prev ? prev.created_at : nowISO, updated_at: nowISO
      };
    }
    data.ledger[key] = entry;
    commit(["ledger", "*"], [upsert("rent_ledger", entry)]);
    return {
      ok: true, entry,
      undo: () => {
        if (prev) { data.ledger[key] = prev; } else { delete data.ledger[key]; }
        commit(["ledger", "*"], prev
          ? [upsert("rent_ledger", prev)]
          : [softDelete("rent_ledger", entry.id, new Date().toISOString(), entry)]);
      }
    };
  }

  /* Payment details (from the modal): amount, date, method, UTR. */
  function setPayment(tenantId, period, details) {
    const t = getTenant(tenantId);
    if (!t) { return { ok: false, error: "Tenant not found." }; }
    if (!PERIOD_RE.test(period || "")) { return { ok: false, error: "Bad period." }; }
    const key = tenantId + "|" + period;
    const prev = data.ledger[key];
    const nowISO = new Date().toISOString();
    const entry = {
      id: prev ? prev.id : nextId("led"), owner_id: account, property_id: t.property_id,
      tenant_id: tenantId, period,
      due: details.due != null ? Math.max(0, Number(details.due)) : (prev ? prev.due : effectiveRent(t)),
      paid: details.paid != null ? Math.max(0, Number(details.paid)) : (prev ? prev.paid : 0),
      status: (details.paid != null ? Number(details.paid) : 0) >= (details.due != null ? Number(details.due) : effectiveRent(t)) && Number(details.paid || 0) > 0 ? "paid" : (prev && prev.status === "overdue" ? "overdue" : "pending"),
      paid_on: details.paidOn || null, method: details.method || null, reference: details.reference || null,
      reminder_sent_at: prev ? prev.reminder_sent_at : null, note: String(details.note || ""),
      created_at: prev ? prev.created_at : nowISO, updated_at: nowISO
    };
    if (entry.paid > 0 && entry.paid < entry.due && entry.status === "paid") { entry.status = "pending"; } // partial
    data.ledger[key] = entry;
    commit(["ledger", "*"], [upsert("rent_ledger", entry)]);
    return { ok: true, entry };
  }

  /* WhatsApp reminder bookkeeping (1-tap reminders land here later). */
  function markReminderSent(tenantId, period) {
    const key = tenantId + "|" + period;
    const entry = data.ledger[key];
    if (!entry) { return { ok: false, error: "No ledger entry." }; }
    entry.reminder_sent_at = new Date().toISOString();
    entry.updated_at = entry.reminder_sent_at;
    commit(["ledger", "*"], [upsert("rent_ledger", entry)]);
    return { ok: true };
  }

  /* Import legacy v1 data (the bed-as-tenant shape) into the new model. */
  function importLegacy(v1) {
    const rooms = (v1 && v1.rooms) || [];
    let tenants = 0, months = 0;
    for (const r of rooms) {
      const added = addRoom(r.no, (r.beds || []).length, { level: Number(r.floor) || 0, rent: r.rent });
      if (!added.ok) { continue; }
      const beds = live("beds").filter((b) => b.room_id === added.room.id).sort((a, b) => a.slot - b.slot);
      (r.beds || []).forEach((legacyBed, i) => {
        if (!legacyBed || !legacyBed.name) { return; }
        const res = addTenant(beds[i].id, {
          name: legacyBed.name, phone: legacyBed.phone, deposit: legacyBed.deposit,
          rent: legacyBed.rent, collectDay: legacyBed.collect,
          idType: legacyBed.idType, idNumber: legacyBed.idNumber,
          emergencyContact: legacyBed.emergencyContact, workplace: legacyBed.workplace,
          joined: legacyBed.joined, onNotice: !!legacyBed.onNotice,
          plannedLeave: legacyBed.onNotice ? legacyBed.leaving : null,
        });
        if (!res.ok) { return; }
        tenants++;
        for (const m of (Array.isArray(legacyBed.paidMonths) ? legacyBed.paidMonths : [])) {
          if (!PERIOD_RE.test(m)) { continue; }
          const info = (legacyBed.paymentInfo && legacyBed.paymentInfo[m]) || {};
          setPayment(res.tenant.id, m, { due: effectiveRent(res.tenant), paid: effectiveRent(res.tenant), paidOn: info.date || null, method: info.utr ? "upi" : null, reference: info.utr || null });
          months++;
        }
      });
    }
    commit(["*"], []); // importer calls commit per op already; final notify for safety
    return { ok: true, rooms: rooms.length, tenants, months };
  }

  /* Boot pull merge (called by sync.js): apply cloud rows to local state.
     Cloud wins only when strictly newer (offline local edits survive).
     Remote soft-deletes (deleted_at set) propagate to local. Tables the v2
     model does not consume (activity etc.) are ignored here. rent_ledger is
     keyed by "<tenantId>|<period>" locally, so its rows are matched that way
     (same tenant + period = the same row, regardless of id scheme). */
  function mergeRemote(table, rows) {
    if (!data || !Array.isArray(rows)) { return 0; }
    const mapName = table === "rent_ledger" ? "ledger" : table;
    if (!data[mapName]) { return 0; }
    let applied = 0;
    for (const row of rows) {
      if (!row || !row.id) { continue; }
      const key = table === "rent_ledger" ? row.tenant_id + "|" + row.period : row.id;
      const local = data[mapName][key];
      if (row.deleted_at) {
        if (local && !local.deleted_at) { local.deleted_at = row.deleted_at; applied++; }
        continue;
      }
      if (!local || new Date(row.updated_at || 0) > new Date(local.updated_at || 0)) {
        data[mapName][key] = row;
        applied++;
      }
    }
    if (applied) {
      try { storage.setItem(KEY.replace("<account>", account), JSON.stringify(data)); } catch (e) { /* retried next boot */ }
      emit(mapName, null); emit("*", null);
    }
    return applied;
  }

  /* Legacy monthly-window helpers the views need. */
  function billedMonths(tenant, upTo) {
    const out = [];
    if (!tenant.joined_on) { return out; }
    const start = tenant.joined_on.slice(0, 7);
    const end = upTo || currentPeriod();
    let [y, m] = start.split("-").map(Number);
    const [ey, em] = end.split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
      out.push(y + "-" + String(m).padStart(2, "0"));
      m++; if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  function setSink(fn) { sinkFn = fn; }

  return {
    use, on, currentPeriod, setSink,
    getProperty, getFloors, getRooms, getBeds, getRoom, getBed,
    getRoomWithBeds, getBedOccupancy, getTenants, getTenant,
    getRentLedger, ledgerStatus, effectiveRent, billedMonths, bedStatus, floorsLabel,
    ensureProperty, addFloor, addRoom, removeRoom,
    addTenant, updateTenant, moveOut, removeTenant,
    toggleRentStatus, setPayment, markReminderSent,
    importLegacy, mergeRemote, blank, _raw: () => data
  };
}

/* Browser default instance (Node tests call createDb directly). */
const hasWindow = typeof window !== "undefined";
const LS = hasWindow ? window.localStorage : null;
export const db = LS ? createDb(LS, null) : null;
