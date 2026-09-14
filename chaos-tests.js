/* ============================================================
   PG MANAGER — CHAOS TEST SUITE (QA regression guard)
   Paste this whole block into the browser console on the
   dashboard (index.html) while signed in.

   Guards against the 4 patched vulnerabilities:
     1. testRaceCondition()         — frozen snapshot, not live state
     2. testNetworkFailureCascade() — backoff + unload lock + modal
     3. testTerminalCrashAlert()    — instant DB rejection + webhook
     4. testLocalStorageFull()      — quota error surfaces a toast

   Quick start:  PGChaos.runAll()
   Or run one:   await PGChaos.testRaceCondition()
   Cleanup:      PGChaos.cleanup()   (safe to call anytime)

   NOTE: tests temporarily override SupabaseStorage.save,
   localStorage.setItem and console.error. cleanup() restores
   everything. Run on test data — tests make harmless edits.
   ============================================================ */
(function () {
  "use strict";

  if (!window.PGStore || !window.PGRender) {
    console.error("[PGChaos] App not loaded. Open the dashboard first.");
    return;
  }

  /* ---------------- results collector ---------------- */
  var results = [];
  function record(name, pass, detail) {
    results.push({ name: name, pass: pass, detail: detail });
    console.log("%c[PGChaos] " + (pass ? "✅ PASS" : "❌ FAIL") + " — " + name,
      "color:" + (pass ? "#16a34a" : "#dc2626") + ";font-weight:bold",
      "\n   " + detail);
  }

  /* ---------------- tiny helpers ---------------- */
  function waitFor(fn, timeoutMs, label) {
    return new Promise(function (resolve) {
      var started = Date.now();
      (function poll() {
        var v;
        try { v = fn(); } catch (e) { v = false; }
        if (v) { return resolve(v); }
        if (Date.now() - started > (timeoutMs || 5000)) { return resolve(null); }
        setTimeout(poll, 100);
      })();
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function modalVisible() {
    var m = document.getElementById("critical-sync-modal");
    return !!(m && !m.hidden);
  }
  function lastErrorToast() {
    var toasts = document.querySelectorAll("#toast-container .toast");
    return toasts.length ? toasts[toasts.length - 1] : null;
  }
  function criticalModalShown() {
    var m = document.getElementById("critical-sync-modal");
    if (!m) { return false; }
    var title = m.querySelector("#csm-title, .csm-card h3");
    return title && /Critical Sync Warning/i.test(title.textContent || "");
  }

  /* ============================================================
     TEST 1 — RACE CONDITION: payload must be the frozen snapshot
     ============================================================ */
  async function testRaceCondition() {
    var NAME = "testRaceCondition";
    if (!(window.SupabaseStorage && SupabaseStorage.isAvailable && SupabaseStorage.isAvailable())) {
      record(NAME, false, "Supabase not available (local mode) — this test needs the cloud DB.");
      return;
    }
    var original = PGStore.state().property;
    var captured = null;
    var realSave = SupabaseStorage.save;

    /* Spy: record the payload handed to the network layer */
    SupabaseStorage.save = function (snapshot) {
      captured = snapshot;
      return realSave.apply(this, arguments);
    };

    try {
      PGRender.commitNow();                       /* fires dispatchSave synchronously */
      PGStore.state().property = "MUTATED-MID-SAVE-" + Date.now();  /* mutate 1ms later */

      /* Wait for the real save promise chain to settle */
      await sleep(1500);

      var mutated = PGStore.state().property;
      var sent = captured && captured.property;

      if (!captured) {
        record(NAME, false, "No payload was captured — save never reached SupabaseStorage.save.");
      } else if (sent === mutated) {
        record(NAME, false,
          "Payload was MUTATED mid-flight (sent \"" + sent + "\"). Snapshot protection is broken!");
      } else {
        record(NAME, true,
          "Live state was \"" + mutated + "\" but the network payload kept \"" + sent +
          "\" — the deep snapshot froze the save correctly.");
      }
    } finally {
      SupabaseStorage.save = realSave;
      PGStore.state().property = original;        /* restore user's real data */
      PGRender.commitNow();
    }
  }

  /* ============================================================
     TEST 2 — NETWORK FAILURE CASCADE: backoff → unload lock → modal
     Uses the built-in chaos hook (same as fetch always 500).
     ============================================================ */
  async function testNetworkFailureCascade() {
    var NAME = "testNetworkFailureCascade";
    if (typeof window.simulateDatabaseFailure !== "function") {
      record(NAME, false, "simulateDatabaseFailure() not found — retry engine not loaded.");
      return;
    }
    var retryEvents = [];
    var statusTrail = [];
    function onRetry(e) { retryEvents.push(e.detail || {}); }
    function onStatus(e) { statusTrail.push((e.detail || {}).state); }
    window.addEventListener("pg:storage-retrying", onRetry);
    window.addEventListener("pg:sync-status", onStatus);

    window.simulateDatabaseFailure();               /* arm persistent failure */
    console.log("[PGChaos] Failure armed. Triggering commit — expect retries at 1s/2s/4s/8s…");

    PGRender.commitNow();

    /* While retries are sleeping, the unload lock must be engaged */
    await sleep(2500);
    var busyDuringRetry = PGRender.isSyncBusy();

    /* Backoff total = 1+2+4+8 = 15s. Give it 20s to hit permanent failure. */
    var modalShown = await waitFor(function () {
      return modalVisible() && SupabaseStorage.syncStatus &&
        SupabaseStorage.syncStatus().state === "sync_failed";
    }, 20000, "critical modal");

    window.removeEventListener("pg:storage-retrying", onRetry);
    window.removeEventListener("pg:sync-status", onStatus);

    var retryOk = retryEvents.length >= 4;
    var detail = retryEvents.length + " retry event(s) with backoff " +
      retryEvents.map(function (r) { return (r.delayMs / 1000) + "s"; }).join("→") +
      "; sync trail: " + (statusTrail.join("→") || "(none)") +
      "; unload lock engaged during retries: " + (busyDuringRetry ? "YES" : "NO") +
      "; blocking modal + sync_failed: " + (modalShown ? "YES" : "NO (timed out)");

    /* Keep the failure state so you can SEE the modal — run cleanup() to stand down */
    record(NAME, retryOk && busyDuringRetry && !!modalShown, detail);
    console.log("[PGChaos] Modal left visible for inspection. Run PGChaos.cleanup() to recover.");
  }

  /* ============================================================
     TEST 3 — TERMINAL CRASH ALERT: instant rejection → webhook POST
     Monkey-patches save to reject with a permanent-failure error
     (bypasses retries, like a hard schema error), then verifies the
     critical_error_log dispatch path fires.
     ============================================================ */
  async function testTerminalCrashAlert() {
    var NAME = "testTerminalCrashAlert";
    var webhookCalls = [];
    var noEndpointFallback = false;
    var realFetch = window.fetch;
    var realSave = SupabaseStorage.save;
    var realConsoleError = console.error;

    /* Instant, retry-free rejection — mimics Postgres 42703 (missing column) */
    var hardError = new Error('column beds.payment_info does not exist (42703)');
    hardError.isPermanentSaveFailure = true;
    hardError.failedTables = ["beds"];

    SupabaseStorage.save = function () { return Promise.reject(hardError); };

    /* Intercept the webhook POST */
    window.fetch = function (url, opts) {
      var body = opts && typeof opts.body === "string" ? opts.body : "";
      if (body.indexOf("critical_error_log") !== -1) {
        webhookCalls.push({ url: String(url), body: body });
      }
      return realFetch.apply(this, arguments);
    };
    /* Catch the "no endpoint configured" fallback */
    console.error = function () {
      var line = Array.prototype.join.call(arguments, " ");
      if (line.indexOf("no backup endpoint") !== -1) { noEndpointFallback = true; }
      return realConsoleError.apply(console, arguments);
    };

    try {
      PGRender.commitNow();
      await sleep(1200);   /* modal + dispatch happen synchronously-ish */

      var criticalShown = criticalModalShown();
      var sheetsConfigured = !!(window.PG_CONFIG && window.PG_CONFIG.SHEETS_URL);

      if (webhookCalls.length > 0) {
        var payload = JSON.parse(webhookCalls[0].body);
        record(NAME, criticalShown,
          "Webhook POST dispatched to " + webhookCalls[0].url +
          " with action=" + payload.action + ", error=\"" + payload.error + "\"" +
          "; blocking modal: " + (criticalShown ? "YES" : "NO"));
      } else if (noEndpointFallback) {
        record(NAME, criticalShown,
          "Alert path VERIFIED (console fallback fired) but no HTTP POST was possible: " +
          "SHEETS_URL is empty in config.js. Fill it in to get real email alerts. " +
          "Blocking modal: " + (criticalShown ? "YES" : "NO"));
      } else {
        record(NAME, false,
          "No webhook POST and no fallback log — the critical dispatch path did not run. " +
          "Modal visible: " + criticalShown);
      }
    } finally {
      SupabaseStorage.save = realSave;
      window.fetch = realFetch;
      console.error = realConsoleError;
      /* Stand the critical state down with a real save */
      PGRender.commitNow();
      await sleep(1000);
    }
  }

  /* ============================================================
     TEST 4 — LOCALSTORAGE FULL: quota error must surface a toast
     ============================================================ */
  async function testLocalStorageFull() {
    var NAME = "testLocalStorageFull";
    var realSetItem = Storage.prototype.setItem;
    var threw = 0;
    Storage.prototype.setItem = function () {
      threw += 1;
      var e = new DOMException("QuotaExceededError", "QuotaExceededError");
      throw e;
    };

    try {
      var marker = "QUOTA-TEST-" + Date.now();
      PGStore.setProperty(marker);          /* internally calls save() → setItem throws */
      await sleep(400);

      var t = lastErrorToast();
      var toastOk = !!(t && /Could not save|storage/i.test(t.textContent || ""));
      record(NAME, threw > 0 && toastOk,
        "setItem threw " + threw + "×; visible error toast: " +
        (toastOk ? "YES — \"" + (t.textContent || "").trim().slice(0, 80) + "\""
                 : "NO — the failure was silent!"));
    } catch (e) {
      record(NAME, false, "Unexpected crash during quota test: " + e.message);
    } finally {
      Storage.prototype.setItem = realSetItem;
      PGRender.commitNow();                 /* re-persist with storage restored */
    }
  }

  /* ---------------- runner + cleanup ---------------- */
  async function runAll() {
    console.log("%c[PGChaos] Running full suite…", "font-weight:bold;color:#6366f1");
    await testRaceCondition();
    await testLocalStorageFull();
    await testTerminalCrashAlert();
    await testNetworkFailureCascade();   /* slowest last; leaves modal up */
    var passed = results.filter(function (r) { return r.pass; }).length;
    console.log("%c[PGChaos] SUITE DONE — " + passed + "/" + results.length + " passed." +
      " Run PGChaos.cleanup() when finished inspecting.",
      "font-weight:bold;color:" + (passed === results.length ? "#16a34a" : "#dc2626"));
    console.table(results);
  }

  function cleanup() {
    if (typeof window.stopDatabaseFailureSimulation === "function") {
      window.stopDatabaseFailureSimulation();
    }
    /* A successful real save clears dbLocked, the modal, and the banner */
    PGRender.commitNow();
    console.log("[PGChaos] Cleaned up. Failure simulation disarmed; recovery save triggered.");
  }

  window.PGChaos = {
    testRaceCondition: testRaceCondition,
    testNetworkFailureCascade: testNetworkFailureCascade,
    testTerminalCrashAlert: testTerminalCrashAlert,
    testLocalStorageFull: testLocalStorageFull,
    runAll: runAll,
    cleanup: cleanup,
    results: function () { return results; }
  };

  console.log("%c[PGChaos] Ready. Tests: testRaceCondition · testNetworkFailureCascade · " +
    "testTerminalCrashAlert · testLocalStorageFull — or PGChaos.runAll(). " +
    "Always finish with PGChaos.cleanup().",
    "color:#6366f1;font-weight:bold");
})();
