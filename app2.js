/* app2.js — v2 bootstrap.
 * Boots the store for the current account (same account id the legacy app
 * uses), mounts the four views onto the tab shell, and reflects sync status.
 */

import { store, sync, db } from "./store/index.js";
import { realtime } from "./store/index.js";
import { initDashboard, render as renderDashboard } from "./views/dashboard.js";
import { initBeds } from "./views/beds.js";
import { initRent } from "./views/rent.js";
import { initTenants } from "./views/tenants.js";
import { initSyncPing } from "./components/sync-ping.js";
import { toast, closeDrawer, money } from "./views/ui.js";

const $ = (id) => document.getElementById(id);
const views = {};

/* ---------- boot ---------- */

async function start() {
  wireShell();

  /* Live Sync Ping: bottom-left badge mirroring store/sync.js state. */
  initSyncPing({ store, realtime, toast });

  // Account: reuse the legacy session if present (same Supabase uid);
  // otherwise run as the shared local demo account.
  const accountId = legacyAccountId() || "local";
  await probeProfile(accountId);
  const res = await store.boot(accountId);
  mount("dashboard");
  renderSyncPill({ status: res.cloud ? "synced" : "offline", detail: null });

  // First run on a fresh account: offer to pull in the legacy v1 data.
  if (!hasAnyData()) {
    const legacy = readLegacy();
    if (legacy && legacy.rooms && legacy.rooms.length) {
      offerImport(legacy);
    } else if (!store.state().properties || !Object.keys(store.state().properties).length) {
      mutations().ensureProperty("My Property");
    }
  }
}

/* properties.owner_id is an FK to auth.users; the v2 tables can only sync
   when the signed-in user actually has a profiles row (the legacy app creates
   it at signup). Probe once at boot; without it the store runs local-only. */
async function probeProfile(accountId) {
  window.__PGV2_HAS_PROFILE__ = false;
  if (accountId === "local") { return; }
  try {
    const { getProbeClient } = await import("./store/index.js");
    const client = getProbeClient();
    if (!client) { return; }
    const { data, error } = await client.from("profiles").select("id").eq("id", accountId).limit(1);
    // A clean empty select (error=null, data=[]) still means "no profile row".
    window.__PGV2_HAS_PROFILE__ = !error && Array.isArray(data) && data.length > 0;
  } catch (e) { /* stays local-only */ }
}

function legacyAccountId() {
  try {
    const s = JSON.parse(sessionStorage.getItem("pgSession") || "null");
    return s && s.id;
  } catch (e) { return null; }
}

function readLegacy() {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("pgData:"));
    if (!keys.length) { return null; }
    // Most recently written legacy blob wins.
    let best = null;
    for (const k of keys) {
      const v = JSON.parse(localStorage.getItem(k) || "null");
      if (v && v.rooms && (!best || v.rooms.length >= best.rooms.length)) { best = v; }
    }
    return best;
  } catch (e) { return null; }
}

function hasAnyData() {
  const s = store.state();
  return (s.rooms && Object.keys(s.rooms).length) || (s.tenants && Object.keys(s.tenants).length);
}

function mutations() {
  return {
    ensureProperty: (n) => db.ensureProperty(n),
    importLegacy: (v1) => db.importLegacy(v1)
  };
}

function offerImport(legacy) {
  const counts = legacy.rooms.reduce(
    (acc, r) => {
      acc.beds += (r.beds || []).length;
      acc.tenants += (r.beds || []).filter((b) => b && b.name).length;
      acc.months += (r.beds || []).reduce((s, b) => s + ((b && b.paidMonths) || []).length, 0);
      return acc;
    }, { beds: 0, tenants: 0, months: 0 });

  toast("Legacy data found: " + counts.tenants + " tenants, " + counts.months + " payments",
    "info", 8000, { label: "Import", fn: () => {
      const res = db.importLegacy(legacy);
      if (res.ok) { toast("Imported " + res.tenants + " tenants · " + res.months + " payments"); }
    } });
}

/* ---------- shell ---------- */

function wireShell() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      mount(tab.dataset.view);
    });
  });
  document.addEventListener("click", (e) => {
    if (e.target && e.target.dataset && e.target.dataset.act === "close-drawer") { closeDrawer(); }
  });
  window.addEventListener("pgv2:sync", (e) => renderSyncPill(e.detail));
  window.addEventListener("pgv2:storage-error", (e) => toast(e.detail, "error", 6000));
}

function mount(name) {
  const host = $("view");
  host.replaceChildren();
  if (name === "beds" && views.beds) { views.beds(host); }
  else if (name === "rent" && views.rent) { views.rent(host); }
  else if (name === "tenants" && views.tenants) { views.tenants(host); }
  else if (views.dashboard) { views.dashboard(host); }
}

function renderSyncPill({ status }) {
  const pill = $("sync-pill");
  if (!pill) { return; }
  pill.className = "pill pill-" + (status === "draining" ? "draining" : status);
  pill.textContent = { queued: "saving…", draining: "syncing…", synced: "synced", offline: "offline", error: "sync error" }[status] || status;
}

/* ---------- mount view renderers (lazy init) ---------- */

views.dashboard = (host) => initDashboard(host);
views.beds = (host) => initBeds(host);
views.rent = (host) => initRent(host);
views.tenants = (host) => initTenants(host);

start();
