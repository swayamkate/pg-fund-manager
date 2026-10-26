/* ---------- backup ---------- */

function backupLabel(s) {
  if (s.state === "off") { return "Sheet backup is not set up yet."; }
  if (s.state === "saving") { return "Auto-syncing to Google Sheets\u2026"; }
  if (s.state === "error") { return "Auto-sync error: " + (s.error || ""); }
  if (s.at) { return "Auto-saved \u00b7 Synced with Google Sheets " + sinceLabel(s.at) + "."; }
  return "Auto-sync active. Every change is saved to Google Sheets automatically.";
}

function renderBackup(s) {
  const bar = el("backup");
  if (!bar) { return; }
  bar.className = "backup is-" + s.state;
  el("backup-text").textContent = backupLabel(s);
  el("backup-actions").hidden = !(window.PGSheets && PGSheets.enabled);
}

/* ================================================================
   DATA SAFETY PIPELINE
   Directive 1: deep snapshot before every async save
   Directive 2: retries with exponential backoff (in supabase-storage.js)
   Directive 3: beforeunload lock + blocking modal with Retry Now
   Directive 4: permanent failure → email alert via Apps Script
   Directive 5: every failure surfaces as a toast — no silent catches
   ================================================================ */
var _commitTimer = null;
var _criticalFailure = false;  /* at least one save has failed permanently (drives toasts + auto-retry) */
var _consecutiveFails = 0;

function dbSyncBusy() {
  /* Busy while a debounced commit is pending, a retry loop is sleeping,
     or any save request is in flight. Drives the beforeunload trap. */
  if (_commitTimer) { return true; }
  if (window.SupabaseStorage && SupabaseStorage.isAvailable && SupabaseStorage.isAvailable()) {
    if (SupabaseStorage.isRetryActive && SupabaseStorage.isRetryActive()) { return true; }
    if (SupabaseStorage.inflightCount && SupabaseStorage.inflightCount() > 0) { return true; }
  }
  return false;
}

/* ---- Directive 3: unload protection ---- */
window.addEventListener("beforeunload", function (e) {
  if (dbSyncBusy() || _criticalFailure) {
    var msg = _criticalFailure
      ? "A database save FAILED. Closing now may LOSE your latest changes."
      : "Your latest changes are still being saved.";    e.preventDefault();
    e.returnValue = msg; /* Chrome/Edge */
    return msg;          /* Firefox/Safari */
  }
});

/* ---- The single save pipeline. Takes an immutable snapshot and fans out. */
function dispatchSave() {
  /* Directive 1: immutable snapshot — live edits mid-upload cannot corrupt it */
  var snapshot = (PGStore.snapshot)
    ? PGStore.snapshot()
    : JSON.parse(JSON.stringify(PGStore.state()));

  if (window.PGSheets) { PGSheets.schedule(snapshot); }

  if (window.SupabaseStorage && SupabaseStorage.isAvailable()) {
    SupabaseStorage.save(snapshot).then(function () {
      _consecutiveFails = 0;
      if (_criticalFailure) {
        /* A previously failing save finally went through — stand down. */
        _criticalFailure = false;
        toast("Database connection restored — all data is synced.", "success", 5000);
      }
    }).catch(function (e) {
      onPermanentSaveFailure(e);
    });
  }
}

function commit() {
  /* Debounce: if multiple changes happen within 30ms, only render once. */
  if (_commitTimer) { clearTimeout(_commitTimer); }
  _commitTimer = setTimeout(function () {
    _commitTimer = null;
    renderAll();
    dispatchSave();
  }, 30);
}

/* Immediate commit — bypasses debounce, used for critical saves. */
function commitNow() {
  if (_commitTimer) { clearTimeout(_commitTimer); _commitTimer = null; }
  renderAll();
  dispatchSave();
}

/* ---- Directive 4: permanent failure → surface + email alert ----
   Blocking modals are RESERVED for data-threatening failures. Recoverable
   schema gaps (42703 — adaptive stripping already saved the row minus the
   unknown columns) and ordinary network outages must NEVER block the owner:
   they route to toasts/banner and the sync retry engine instead. */
function onPermanentSaveFailure(e) {
  _consecutiveFails += 1;
  var msg = e && e.message ? e.message : "Unknown database error";
  var isSchemaGap = /column .* does not exist|42703/i.test(msg) ||
    (e && e.failedTables && e.failedTables.length && /schema/i.test(msg));
  var isNetworkish = !/column |schema|RLS|permission|duplicate|violates/i.test(msg);

  if (isSchemaGap) {
    /* Non-fatal: row saved minus unknown fields; the banner (already up)
       carries the fix instruction. Keep the owner editing. */
    toast("Saved with reduced fields — run supabase/migrate-schema.sql to sync 100%.", "warn", 6000);
    _consecutiveFails = 0;            /* do not escalate toward the modal */
    return;
  }
  if (isNetworkish && _criticalFailure) {
    /* Already modal'ed once — do not re-block on every subsequent network
       blip; the online/focus auto-retry resumes the sync. */
    toast("Still offline — changes are safe locally and will sync automatically.", "warn", 5000);
    return;
  }

  /* Every permanent failure is visible (Directive 5)... */
  toast("Save failed after all retries: " + msg, "error", 8000);

  if (_consecutiveFails >= 3 || (e && e.isPermanentSaveFailure)) {
    _criticalFailure = true;
    /* No blocking modal, no edit lock: changes stay safe locally and auto-retry
       when connectivity returns; the user just sees a toast. */
    toast("Database save failed — changes are saved locally and will retry automatically. Keep this tab open if possible.", "warn", 8000);
    /* Directive 4: emergency email dispatch through the Apps Script endpoint */
    if (window.PGSheets && typeof PGSheets.criticalErrorLog === "function") {
      PGSheets.criticalErrorLog({
        error: msg,
        tables: (e && e.failedTables) || [],
        attempts: (e && e.attempts) || null
      });
    } else {
      console.error("[CRITICAL] Database save failed and no alert channel exists:", msg);
    }
  }
}

/* Auto-resume: when connectivity returns (or the tab regains focus after a
   suspected outage), retry the failed save automatically. */
window.addEventListener("online", function () {
  if (_criticalFailure) {
    toast("Connection back — retrying database save\u2026", "info", 3000);
    manualRetrySave();
  }
});
window.addEventListener("focus", function () {
  if (_criticalFailure) { manualRetrySave(); }
});

function manualRetrySave() {
  toast("Retrying database save\u2026", "info", 3000);
  _consecutiveFails = 0;
  commitNow();
}

/* ---- Directive 2 telemetry: retry chatter surfaces as soft toasts ---- */
window.addEventListener("pg:storage-retrying", function (ev) {
  var d = ev.detail || {};
  toast("Save retry " + (d.attempt || "?") + "/" + (d.maxAttempts || "?") +
    " for " + (d.label || "data") + " — waiting " + Math.round((d.delayMs || 0) / 1000) + "s\u2026",
    "warn", 2500);
});

window.addEventListener("pg:storage-recovered", function () {
  toast("Database save recovered.", "success", 3000);
});

window.addEventListener("pg:storage-error", function (ev) {
  var d = ev.detail || {};
  console.error("[Storage]", d.table, d.message);
  /* Per-table errors are logged here; the full save rejection raises the
     blocking UI via onPermanentSaveFailure, so no extra toast is needed. */
});

/* Schema-drift fallback: the save went through but without one column. */
window.addEventListener("pg:storage-schema-fallback", function (ev) {
  var d = ev.detail || {};
  console.warn("[Storage] schema fallback:", d.table, d.message);
  toast("Saved with reduced fields — run supabase/migrate-schema.sql to fix the database.", "warn", 7000);
});

/* Directive 5: sheets failures warn but never lock (Supabase is primary) */
window.addEventListener("pg:sheets-error", function (ev) {
  toast((ev.detail && ev.detail.message) || "Sheet backup failed.", "warn", 6000);
});

/* ---- Directive 2: Syncing / Synced / Sync_Failed status indicator ---- */
var SYNC_LABELS = {
  idle: "Not synced yet",
  syncing: "Syncing\u2026",
  synced: "Synced",
  sync_failed: "Sync failed"
};

function renderSyncStatus(state, detail) {
  var pill = el("sync-status-pill");
  if (!pill) { return; }
  pill.dataset.state = state;
  pill.textContent = SYNC_LABELS[state] || state;
  pill.title = detail || SYNC_LABELS[state] || "";
}

window.addEventListener("pg:sync-status", function (ev) {
  var d = ev.detail || {};
  renderSyncStatus(d.state, d.detail);
  /* Mirror into the bottom-left Live Sync Ping (v2 event channel) so the
     legacy app drives the same non-blocking indicator. */
  try {
    var mapped = { syncing: "draining", synced: "synced", sync_failed: "error", saving: "draining" }[d.state] || null;
    if (mapped) { window.dispatchEvent(new CustomEvent("pgv2:sync", { detail: { status: mapped, detail: null } })); }
  } catch (e2) { /* indicator is optional */ }
});

/* Schema-fallback events (adaptive stripping) -> subtle toast + ping,
   NEVER a modal. The row IS saved; only unknown fields were dropped. */
window.addEventListener("pg:storage-schema-fallback", function (ev) {
  var d = ev.detail || {};
  toast("Saved minus " + (d.column || "a missing field") + " — run supabase/migrate-schema.sql for full sync.", "warn", 6000);
});

/* ---- Warning banners removed ----
   The old top-of-page strips (db-error-banner / schema-drift-banner) are
   gone; sync state lives in the bottom-left Live Sync Ping badge and
   toasts only. Schema drift still surfaces as a one-time toast. */
window.addEventListener("pg:storage-schema-drift", function () {
  toast("Database schema out of date — some fields will not save until the migration runs.", "warn", 8000);
});

/* Expose for other files (rent.js) that need to trigger a full save. */
window.PGRender = {
  commit: commit,
  commitNow: commitNow,
  isDbLocked: function () { return false; },
  isSyncBusy: dbSyncBusy,
  manualRetrySave: manualRetrySave
};

