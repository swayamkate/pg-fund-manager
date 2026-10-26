/* store/index.js — assembles the v2 store for the browser.
 *
 * Wires db + sync + the shared Supabase client into one facade the views
 * import (views never touch supabase-js or localStorage directly):
 *
 *   import { store, onReady } from "./store/index.js";
 *   store.subscribe("beds", rerenderGrid);
 *   const rows = store.occupancy();       // [{ bed, tenant, status, room, floor }]
 *
 * Also has the boot sequence: account -> load local -> pull cloud -> merge.
 */

import { createDb } from "./db.js";
import { createSync } from "./sync.js";
import { createRealtime } from "./realtime.js";
import * as supa from "../lib/supabase.js";

/* ---- config (same project the legacy app uses) ---- */
function config() {
  const c = (typeof window !== "undefined" && window.PG_CONFIG) || {};
  return { url: c.SUPABASE_URL, key: c.SUPABASE_ANON_KEY };
}

/* ---- instances (singletons per page load) ---- */
export const db = createDb(
  typeof window !== "undefined" ? window.localStorage : null,
  null                                            // sink wired below after sync exists
);

function statusEmit(s, detail) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pgv2:sync", { detail: { status: s, detail } }));
  }
}

export const sync = createSync(db,
  typeof window !== "undefined" ? window.localStorage : null,
  () => supa.getClient(),
  statusEmit
);
db.setSink(sync.enqueue);

/* Browser hooks: back online -> drain immediately (skip the backoff wait);
   tab refocused -> schema health probe (releases parked mutations when the
   migration lands). No-op in Node. */
sync.installListeners(typeof window !== "undefined" ? window : null);

/* app2.js probes profiles through the same shared client. */
export function getProbeClient() { return supa.getClient(); }

/* ---- Feature 1: realtime (multi-device, multi-user) ----
   One postgres_changes channel; remote writes merge newest-wins and the
   pub/sub re-renders. Own echoes are no-ops (mergeRemote dedupe). */
export const realtime = createRealtime(db, () => supa.getClient(), (kind, d) => {
  if (kind === "remote-change" && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("pgv2:remote-change", { detail: d }));
  }
});

/* ---- Feature 5 / Module 2: single-RPC dashboard stats (cold-load) ----
   Prefers get_owner_dashboard_summary (008); falls back to get_owner_stats
   (005) or local computation whenever the RPCs are unavailable
   (migrations pending, offline, local mode). */
export async function ownerStats(period) {
  const client = supa.getClient();
  const p = period || db.currentPeriod();
  const uid = supa.getAccount();
  if (client && supa.isCloud()) {
    try {
      const { data, error } = await client.rpc("get_owner_dashboard_summary", {
        p_owner_id: uid, p_period: p
      });
      if (!error && data) {
        return { ...data, collected: data.current_month_collection, source: "rpc" };
      }
    } catch (e) { /* fall through */ }
    try {
      const { data, error } = await client.rpc("get_owner_stats", { p_owner_id: uid, p_period: p });
      if (!error && data) { return { ...data, source: "rpc" }; }
    } catch (e) { /* fall through to local */ }
  }
  return { ...localStats(p), source: "local" };
}

function localStats(period) {
  const p = period;
  const s = db._raw();
  const liveBeds = Object.values(s.beds || {}).filter((b) => !b.deleted_at);
  const active = Object.values(s.tenants || {}).filter((t) => !t.deleted_at && t.status === "active");
  const rows = db.getRentLedger(p);
  const paid = rows.filter((r) => r.status === "paid");
  const overdue = rows.filter((r) => r.status === "overdue");
  return {
    activeTenants: active.length,
    occupiedBeds: liveBeds.filter((b) => b.tenant_id).length,
    totalBeds: liveBeds.length,
    collected: paid.reduce((sum, r) => sum + (r.entry ? r.entry.paid : 0), 0),
    paidCount: paid.length,
    dueCount: rows.filter((r) => r.status === "pending").length,
    overdueCount: overdue.length,
    overdueAmount: overdue.reduce((sum, r) => sum + (r.dueAmount - (r.entry ? r.entry.paid : 0)), 0),
    period: p
  };
}

/* ---- facade over db (what views actually call) ---- */
function state() { return db._raw(); }

function subscribe(channel, fn) { return db.on(channel, fn); }

/* Occupancy rows joined with room + floor, floors sorted, beds per slot. */
function occupancy() {
  const floors = db.getFloors();
  return floors.map((f) => ({
    floor: f,
    rooms: db.getRooms()
      .filter((r) => r.floor_id === f.id)
      .map((room) => {
        const wb = db.getRoomWithBeds(room.id);
        return {
          room,
          beds: wb.beds.map((b) => {
            const occ = db.getBedOccupancy(b.id);
            return { ...occ, bedLabel: label(b.slot) };
          })
        };
      })
  }));
}

/* A, B, C… per bed slot (matches legacy labeling). */
function label(slot) {
  return String.fromCharCode(65 + (slot % 26));
}

function rentLedger(period) { return db.getRentLedger(period || db.currentPeriod()); }

/* One-tap rent toggle + undo toast contract:
   returns { ok, entry, undo } — views render the toast with undo(). */
function toggleRent(tenantId, period) { return db.toggleRentStatus(tenantId, period); }

/* Boot: point store at the account, load local instantly, then pull cloud. */
export async function boot(accountId) {
  supa.init(config());
  supa.useAccount(accountId);
  db.use(accountId);
  window.__PGV2_UID__ = accountId;        // realtime server-side owner filter
  if (supa.isCloud()) {
    const res = await sync.pullThenMerge();
    realtime.start();                       // live updates from other devices
    return { local: true, cloud: res.ok, merged: res.merged || 0 };
  }
  return { local: true, cloud: false, merged: 0 };
}

/* Demo/seed helpers used by the v2 shell when starting empty. */
export const mutations = {
  addRoom: (number, beds, opts) => db.addRoom(number, beds, opts),
  removeRoom: (id) => db.removeRoom(id),
  addTenant: (bedId, t) => db.addTenant(bedId, t),
  updateTenant: (id, patch) => db.updateTenant(id, patch),
  moveOut: (id, date) => db.moveOut(id, date),
  setPayment: (tid, period, d) => db.setPayment(tid, period, d),
  markReminderSent: (tid, period) => db.markReminderSent(tid, period),
  importLegacy: (v1) => db.importLegacy(v1),
  ensureProperty: (name) => db.ensureProperty(name)
};

export const store = {
  state, subscribe, occupancy, rentLedger, toggleRent,
  tenant: (id) => db.getTenant(id),
  bedOccupancy: (id) => db.getBedOccupancy(id),
  roomWithBeds: (id) => db.getRoomWithBeds(id),
  effectiveRent: (t) => db.effectiveRent(t),
  currentPeriod: () => db.currentPeriod(),
  billedMonths: (t, upTo) => db.billedMonths(t, upTo),
  /* sync health + dead-letter management (UI pill / error drawer) */
  syncHealth: () => sync.health(),
  flushSync: () => sync.flush(),
  ownerStats: (period) => ownerStats(period),
  uploadDoc: (tenantId, file) => supa.uploadTenantDoc(tenantId, file),
  /* Module 6: 1-tap WhatsApp reminder (RPC builds message + wa.me URL;
     falls back to a local template when the RPC isn't applied yet). */
  whatsappReminder: async (tenantId, period) => {
    const client = supa.getClient();
    if (client && supa.isCloud()) {
      try {
        const { data, error } = await client.rpc("generate_whatsapp_reminder_payload", {
          p_tenant_id: tenantId, p_period: period || db.currentPeriod()
        });
        if (!error && data) { return { ok: true, ...data, source: "rpc" }; }
      } catch (e) { /* fall through to local template */ }
    }
    const t = db.getTenant(tenantId);
    if (!t) { return { ok: false, error: "Tenant not found." }; }
    const p = period || db.currentPeriod();
    const rows = db.getRentLedger(p).filter((r) => r.tenant.id === tenantId);
    const due = rows.length ? Math.max(rows[0].dueAmount - (rows[0].entry ? rows[0].entry.paid : 0), 0) : (store.effectiveRent(t) || 0);
    const phone = String(t.phone || "").replace(/[^0-9]/g, "");
    const msg = "Namaste " + t.name + " ji,\n\nThis is a friendly reminder for your " + p + " rent of Rs. " + due + ".\n\nThank you!";
    return { ok: true, period: p, tenant_name: t.name, due_amount: due, phone_e164: phone, message: msg,
      wa_url: "https://wa.me/" + phone + "?text=" + msg, source: "local" };
  },
  deadLetters: () => sync.getDeadLetters(),
  retryDeadLetters: () => sync.retryDeadLetters(),
  clearDeadLetters: () => sync.clearDeadLetters(),
  boot
};
