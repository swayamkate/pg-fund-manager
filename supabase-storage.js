/* PG Manager — Supabase data storage (complete rewrite).

   PRIMARY data store: every room, bed, expense, rate, complaint,
   activity entry, setting, and rule lives in Supabase with RLS.

   Falls back to localStorage when Supabase is unreachable, so the
   app still works offline.
*/
(function (global) {
  "use strict";

  var cfg = global.PG_CONFIG || {};
  var client = null;
  var accountId = null;

  /* ---- helpers ---- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function now() {
    return new Date().toISOString();
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  function isMonth(v) {
    return typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function cycleId() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1);
  }

  function thisMonth() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1);
  }

  /* ================================================================
     DATA SAFETY LAYER — retry engine, chaos mode, error events
     ================================================================ */

  /* ---- Sync status machine (Directive 2) ----
     idle -> syncing -> synced | sync_failed
     "syncing" covers normal uploads AND retry backoff windows, so the UI can
     always distinguish "work in progress" from "permanently broken". */
  var syncStatus = { state: "idle", since: null, detail: null };

  function setSyncStatus(state, detail) {
    if (syncStatus.state === state && syncStatus.detail === detail) { return; }
    syncStatus.state = state;
    syncStatus.since = new Date().toISOString();
    syncStatus.detail = detail || null;
    try {
      global.dispatchEvent(new CustomEvent("pg:sync-status", {
        detail: { state: state, detail: syncStatus.detail }
      }));
    } catch (e) { /* status events must never break saving */ }
  }

  function getSyncStatus() { return syncStatus; }

  /* Every failure (and every permanent failure) is announced on this event so
     the UI layer in app.js can show toasts/banners without this file knowing
     anything about the DOM. */
  function emitStorageEvent(kind, detail) {
    try {
      global.dispatchEvent(new CustomEvent("pg:storage-" + kind, { detail: detail || {} }));
    } catch (e) { /* event bus must never be the thing that breaks */ }
    if (kind === "error" || kind === "permanent-failure") {
      console.error("[SupabaseStorage]", kind, detail);
    }
  }

  /* ---- CHAOS MODE (testing) ----
     window.simulateDatabaseFailure() arms a persistent mock failure. The next
     N network calls from this module throw "TypeError: Failed to fetch" as if
     the network were down, so the full failure cascade (retries, backoff,
     beforeunload lock, blocking modal, email alert) can be verified visually. */
  var chaos = { armed: false, remaining: 0 };

  function chaosShouldFail() {
    if (!chaos.armed) { return false; }
    chaos.remaining -= 1;
    if (chaos.remaining <= 0) { chaos.armed = false; }
    var err = new TypeError("Failed to fetch");
    err.isChaos = true;
    return err;
  }

  global.simulateDatabaseFailure = function (calls) {
    chaos.armed = true;
    chaos.remaining = Number(calls) || 9999; /* default: stay broken until disarmed */
    console.warn("[CHAOS] Database failure simulation ARMED for " + chaos.remaining + " calls. " +
      "Make any edit to trigger commit(). Call window.stopDatabaseFailureSimulation() to disarm.");
  };

  global.stopDatabaseFailureSimulation = function () {
    chaos.armed = false;
    chaos.remaining = 0;
    console.warn("[CHAOS] Database failure simulation DISARMED.");
  };

  /* ---- Retry engine: exponential backoff 1s, 2s, 4s, 8s (4 retries = 5 attempts) */
  var RETRY_DELAYS = [1000, 2000, 4000, 8000];
  var _retryActive = false;   /* true while any retry loop is sleeping/retrying */
  var _inFlight = 0;          /* number of unresolved save operations */

  function isRetryActive() { return _retryActive; }
  function inflightCount() { return _inFlight; }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* A single awaited network operation, retried with exponential backoff.
     - fn must return a promise (the supabase-js call).
     - supabase-js does NOT reject on HTTP errors: it resolves { data, error }.
       So both paths are handled: thrown exceptions AND res.error objects. */
  async function withRetry(label, fn) {
    var attempt = 0;
    /* loop runs at most 1 + RETRY_DELAYS.length times */
    while (true) {
      var chaosErr = chaosShouldFail();
      try {
        if (chaosErr) { throw chaosErr; }
        var res = await fn();
        if (res && res.error) {
          var dbErr = new Error((res.error.message || "Database error") +
            (res.error.code ? " (" + res.error.code + ")" : ""));
          dbErr.code = res.error.code;
          throw dbErr;
        }
        if (attempt > 0) {
          _retryActive = false;
          emitStorageEvent("recovered", { label: label, attempts: attempt + 1 });
        }
        return res;
    } catch (err) {
      /* Schema errors (missing column, 42703) are deterministic — retrying
         cannot fix them. Fail fast so the adaptive fallback can strip the
         column immediately instead of burning 15s of backoff. */
      if (missingColumn(err)) {
        _retryActive = false;
        err.label = label;
        err.attempts = attempt + 1;
        throw err;
      }
      if (attempt >= RETRY_DELAYS.length) {
          _retryActive = false;
          err.label = label;
          err.attempts = attempt + 1;
          throw err; /* permanent failure — caller decides what to do */
        }
        var delay = RETRY_DELAYS[attempt];
        _retryActive = true;
        /* Still working — backoff window counts as "Syncing", not failed */
        setSyncStatus("syncing", "retrying " + label + " in " + Math.round(delay / 1000) + "s");
        emitStorageEvent("retrying", {
          label: label,
          attempt: attempt + 1,
          maxAttempts: RETRY_DELAYS.length + 1,
          delayMs: delay,
          error: (err && err.message) || String(err)
        });
        await sleep(delay);
        attempt += 1;
      }
    }
  }

  /* ---- Supabase client ---- */
  /* Reuse the singleton from auth.js to avoid multiple GoTrueClient instances. */

  function getClient() {
    if (client) { return client; }
    /* Prefer the shared client from PGAuth */
    if (global.PGAuth && typeof global.PGAuth.getClient === "function") {
      client = global.PGAuth.getClient();
    }
    return client || null;
  }

  /* ---- Generic CRUD helpers (all wrapped in the retry engine) ---- */

  async function fetchAll(table) {
    var c = getClient();
    if (!c || !accountId) { return []; }
    var res = await withRetry("fetch:" + table, function () {
      return c.from(table).select("*").eq("owner_id", accountId);
    });
    return (res && res.data) || [];
  }

  /* ---- Adaptive save fallback (schema drift resilience) ----
     If a table rejects writes because of a missing column (Postgres 42703,
     e.g. the live DB predates the payment_info migration), strip that column
     and retry once so the save still goes through instead of failing 5x,
     throwing a permanent failure, and locking the whole app. The migration
     (supabase/migrate-schema.sql) restores the full column set afterwards. */
  var _schemaFallbacks = {};   /* table -> true, once a column has been stripped */
  var _COL = /column (?:"?\w+"?\.)?"?([a-z_][a-z0-9_]*)"? does not exist/i;

  function missingColumn(err) {
    var m = err && err.message ? String(err.message).match(_COL) : null;
    return m ? m[1] : null;
  }

  async function upsertAll(table, rows) {
    var c = getClient();
    if (!c || !accountId || !rows.length) { return; }
    var toSave = rows.map(function (r) {
      r.owner_id = accountId;
      return r;
    });
    _inFlight += 1;
    try {
      try {
        await withRetry("upsert:" + table, function () {
          return c.from(table).upsert(toSave, { onConflict: "id" });
        });
      } catch (err) {
        var col = missingColumn(err);
        if (!col || _schemaFallbacks[table]) { throw err; }
        /* One-time fallback: drop the offending column from the payload. */
        _schemaFallbacks[table] = true;
        emitStorageEvent("schema-fallback", {
          table: table, column: col,
          message: "Saving without missing column " + col + " — run supabase/migrate-schema.sql"
        });
        var slim = toSave.map(function (r) {
          var copy = {};
          for (var k in r) { if (k !== col) { copy[k] = r[k]; } }
          return copy;
        });
        await withRetry("upsert:" + table + "(fallback)", function () {
          return c.from(table).upsert(slim, { onConflict: "id" });
        });
      }
    } finally {
      _inFlight -= 1;
    }
  }

  async function deleteByIds(table, ids) {
    var c = getClient();
    if (!c || !ids.length) { return; }
    await withRetry("delete:" + table, function () {
      return c.from(table).delete().in("id", ids);
    });
  }

  async function deleteByOwner(table) {
    var c = getClient();
    if (!c || !accountId) { return; }
    await withRetry("deleteByOwner:" + table, function () {
      return c.from(table).delete().eq("owner_id", accountId);
    });
  }

  async function upsertSingle(table, row) {
    var c = getClient();
    if (!c || !accountId) { return; }
    row.owner_id = accountId;
    _inFlight += 1;
    try {
      await withRetry("upsertSingle:" + table, function () {
        return c.from(table).upsert(row, { onConflict: "owner_id" });
      });
    } finally {
      _inFlight -= 1;
    }
  }

  async function fetchSingle(table) {
    var c = getClient();
    if (!c || !accountId) { return null; }
    var res = await withRetry("fetchSingle:" + table, function () {
      return c.from(table).select("*").eq("owner_id", accountId).limit(1);
    });
    return (res && res.data && res.data[0]) || null;
  }

  /* ---- Rebuild app state from flat Supabase rows ---- */

  function rebuildState(rooms, beds, expenses, rates, complaints, activity, settings, rules, properties) {
    var roomsById = {};
    rooms.forEach(function (r) {
      roomsById[r.id] = {
        id: r.id,
        no: r.no,
        floor: r.floor,
        rent: r.rent,
        beds: []
      };
    });

    beds.forEach(function (b) {
      var room = roomsById[b.room_id];
      if (!room) { return; }
      while (room.beds.length <= b.bed_index) { room.beds.push(null); }

      var months = (b.paid_months || []).filter(isMonth).sort();
      var seed = thisMonth();
      if (!months.length && b.paid) { months = [seed]; }

      /* Vacant marker: empty name means the bed slot exists but no tenant */
      if (!b.name) {
        room.beds[b.bed_index] = null;
        return;
      }

      room.beds[b.bed_index] = {
        name: b.name || "",
        phone: b.phone || "",
        joined: b.joined || "",
        leaving: b.leaving || "",
        note: b.note || "",
        collect: b.collect || 0,
        rent: b.rent,
        deposit: b.deposit || 0,
        idType: b.id_type || "",
        idNumber: b.id_number || "",
        emergencyContact: b.emergency_contact || "",
        workplace: b.workplace || "",
        onNotice: b.on_notice || false,
        paidMonths: months,
        paid: months.indexOf(thisMonth()) !== -1,
        paymentInfo: b.payment_info || {}
      };
    });

    var roomList = Object.values(roomsById);
    roomList.sort(function (a, b) {
      return a.floor - b.floor || String(a.no).localeCompare(String(b.no), undefined, { numeric: true });
    });

    var prop = properties && properties[0] ? properties[0] : {};

    return {
      property: prop.name || "",
      rooms: roomList,
      activity: (activity || []).map(function (a) {
        return { text: a.text, type: a.type, ts: a.ts };
      }),
      expenses: (expenses || []).map(function (x) {
        return { id: x.id, date: x.date, category: x.category, amount: x.amount, note: x.note };
      }),
      rates: (rates || []).map(function (r) {
        return { id: r.id, label: r.label, amount: r.amount, note: r.note };
      }),
      complaints: (complaints || []).map(function (c) {
        return { id: c.id, title: c.title, roomId: c.room_id, roomNo: c.room_no, category: c.category, priority: c.priority, status: c.status, date: c.date, note: c.note, cost: c.cost };
      }),
      owner: {
        name: (prop.owner_name || ""),
        phone: (prop.phone || ""),
        address: (prop.address || ""),
        upiId: (prop.upi_id || ""),
        pgStartDate: (prop.pg_start_date || "")
      },
      rules: {
        visiting: (rules && rules.visiting) || "",
        quiet: (rules && rules.quiet) || "",
        guests: (rules && rules.guests) || "",
        lockout: (rules && rules.lockout) || "",
        other: (rules && rules.other) || ""
      },
      settings: {
        floors: settings ? settings.floors !== false : true,
        bedStyle: (settings && settings.bed_style) || "alpha",
        bedNumbering: (settings && settings.bed_numbering) || "restart"
      },
      cycle: cycleId()
    };
  }

  /* ---- High-level: load full state from Supabase ---- */

  async function loadFull() {
    var rooms, beds, expenses, rates, complaints, activity, settings, rules, properties;
    try { rooms = await fetchAll("rooms"); } catch (e) { rooms = []; }
    try { beds = await fetchAll("beds"); } catch (e) { beds = []; }
    try { expenses = await fetchAll("expenses"); } catch (e) { expenses = []; }
    try { rates = await fetchAll("rates"); } catch (e) { rates = []; }
    try { complaints = await fetchAll("complaints"); } catch (e) { complaints = []; }
    try { activity = (await fetchAll("activity")).sort(function (a, b) { return (b.ts || "").localeCompare(a.ts || ""); }).slice(0, 50); } catch (e) { activity = []; }
    try { settings = await fetchSingle("settings"); } catch (e) { settings = null; }
    try { rules = await fetchSingle("rules"); } catch (e) { rules = null; }
    try { properties = await fetchAll("properties"); } catch (e) { properties = []; }

    return rebuildState(rooms, beds, expenses, rates, complaints, activity, settings, rules, properties);
  }

  /* ---- High-level: save full state to Supabase ---- */

  async function saveFull(state) {
    if (!accountId) { return; }
    var c = getClient();
    if (!c) { return; }

    setSyncStatus("syncing", "full save");

    /* --- Rooms --- */
    var roomIds = {};
    var roomRows = (state.rooms || []).map(function (r) {
      roomIds[r.id] = true;
      return { id: r.id, no: r.no, floor: r.floor, rent: r.rent };
    });

    /* --- Beds --- */
    /* Null beds are "vacant markers" — they preserve room structure in
       Supabase so the slot isn't deleted. We write them with empty name
       and all tenant fields cleared. */
    var bedRows = [];
    (state.rooms || []).forEach(function (room) {
      (room.beds || []).forEach(function (bed, i) {
        if (bed) {
          bedRows.push({
            id: room.id + "-b" + i,
            room_id: room.id,
            bed_index: i,
            name: bed.name || "",
            phone: bed.phone || "",
            joined: bed.joined || null,
            leaving: bed.leaving || null,
            note: bed.note || "",
            collect: bed.collect || 0,
            rent: bed.rent != null ? bed.rent : null,
            deposit: bed.deposit || 0,
            id_type: bed.idType || "",
            id_number: bed.idNumber || "",
            emergency_contact: bed.emergencyContact || "",
            workplace: bed.workplace || "",
            on_notice: bed.onNotice || false,
            paid_months: bed.paidMonths || [],
            payment_info: bed.paymentInfo || {}
          });
        } else {
          /* Vacant slot — keep the bed row alive in Supabase */
          bedRows.push({
            id: room.id + "-b" + i,
            room_id: room.id,
            bed_index: i,
            name: "",
            phone: "",
            joined: null,
            leaving: null,
            note: "",
            collect: 0,
            rent: null,
            deposit: 0,
            id_type: "",
            id_number: "",
            emergency_contact: "",
            workplace: "",
            on_notice: false,
            paid_months: []
          });
        }
      });
    });

    /* --- Expenses --- */
    var expenseRows = (state.expenses || []).map(function (x) {
      return { id: x.id, date: x.date, category: x.category, amount: x.amount, note: x.note || "" };
    });

    /* --- Rates --- */
    var rateRows = (state.rates || []).map(function (r) {
      return { id: r.id, label: r.label, amount: r.amount, note: r.note || "" };
    });

    /* --- Complaints --- */
    var complaintRows = (state.complaints || []).map(function (c) {
      return { id: c.id, title: c.title, room_id: c.roomId || "", room_no: c.roomNo || "", category: c.category, priority: c.priority, status: c.status, date: c.date, note: c.note || "", cost: c.cost || 0 };
    });

    /* --- Activity (last 50) --- */
    var activityRows = (state.activity || []).slice(0, 50).map(function (a) {
      return { id: uid(), text: a.text, type: a.type || "info", ts: a.ts || now() };
    });

    /* --- Property (name + owner details) --- */
    var owner = state.owner || {};
    var propRow = {
      name: state.property || "",
      owner_name: owner.name || "",
      phone: owner.phone || "",
      address: owner.address || "",
      upi_id: owner.upiId || "",
      pg_start_date: owner.pgStartDate || null
    };

    /* --- Settings --- */
    var s = state.settings || {};
    var settingsRow = {
      floors: s.floors !== false,
      bed_style: s.bedStyle || "alpha",
      bed_numbering: s.bedNumbering || "restart"
    };

    /* --- Rules --- */
    var r = state.rules || {};
    var rulesRow = {
      visiting: r.visiting || "",
      quiet: r.quiet || "",
      guests: r.guests || "",
      lockout: r.lockout || "",
      other: r.other || ""
    };

    /* --- Upsert all tables ---
       Every table goes through the retry engine. A table that still fails
       after all retries is NOT silently skipped: it is reported as an error
       event immediately, collected, and the whole save rejects at the end so
       the UI can raise the blocking warning. */
    var saveErrors = [];
    _inFlight += 1;
    async function safe(table, fn) {
      try {
        await fn();
      } catch (e) {
        var msg = (e && e.message) ? e.message : String(e);
        saveErrors.push(table + ": " + msg);
        emitStorageEvent("error", { table: table, message: msg, attempts: e.attempts || null });
      }
    }

    await safe("rooms", function () { if (roomRows.length) return upsertAll("rooms", roomRows); });
    await safe("beds", function () { if (bedRows.length) return upsertAll("beds", bedRows); });
    await safe("expenses", function () { if (expenseRows.length) return upsertAll("expenses", expenseRows); });
    await safe("rates", function () { if (rateRows.length) return upsertAll("rates", rateRows); });
    await safe("complaints", function () { if (complaintRows.length) return upsertAll("complaints", complaintRows); });
    await safe("activity", function () {
      /* Clear old activity and insert fresh */
      return deleteByOwner("activity").then(function () { if (activityRows.length) return upsertAll("activity", activityRows); });
    });

    await safe("properties", function () {
      return withRetry("upsert:properties", function () {
        return c.from("properties").upsert({ id: accountId, owner_id: accountId, owner_name: propRow.owner_name, name: propRow.name, address: propRow.address, phone: propRow.phone, upi_id: propRow.upi_id, pg_start_date: propRow.pg_start_date }, { onConflict: "id" });
      });
    });
    await safe("settings", function () { return upsertSingle("settings", settingsRow); });
    await safe("rules", function () { return upsertSingle("rules", rulesRow); });

    /* --- Delete removed rooms and their beds ---
       Cleanup paths retry too, but a failed cleanup never fails the save:
       leaving an orphan row is recoverable and better than blocking the owner. */
    try {
      /* DATA SAFETY GUARD: refuse the room cleanup when the snapshot is
         empty but the cloud has rooms. An empty snapshot almost always
         means state was cleared or the cloud load never finished — not a
         genuine "deleted every room" action. Deleting then would wipe
         the owner's entire database from one bad save. */
      var existingRoomsRes = await withRetry("cleanup:rooms-select", function () {
        return c.from("rooms").select("id").eq("owner_id", accountId);
      });
      var cloudRoomIds = ((existingRoomsRes && existingRoomsRes.data) || []).map(function (r) { return r.id; });
      if (roomRows.length === 0 && cloudRoomIds.length > 0) {
        emitStorageEvent("error", {
          table: "cleanup-rooms",
          message: "Refused to mass-delete " + cloudRoomIds.length + " cloud room(s): the app state is empty. If you really want to wipe everything, do it from Account settings.",
          isMassDeleteGuard: true
        });
      } else {
      var toDeleteRooms = cloudRoomIds
        .filter(function (id) { return !roomIds[id]; });
      if (toDeleteRooms.length) {
        await withRetry("cleanup:beds-delete", function () { return c.from("beds").delete().in("room_id", toDeleteRooms); });
        await withRetry("cleanup:rooms-delete", function () { return c.from("rooms").delete().in("id", toDeleteRooms); });
      }
      }
    } catch (e) {
      emitStorageEvent("error", { table: "cleanup-rooms", message: (e && e.message) || String(e) });
    }

    /* --- Delete removed expenses --- */
    try {
      var existingExpensesRes = await withRetry("cleanup:expenses-select", function () {
        return c.from("expenses").select("id").eq("owner_id", accountId);
      });
      var incomingExpIds = {};
      expenseRows.forEach(function (x) { incomingExpIds[x.id] = true; });
      var toDeleteExpenses = ((existingExpensesRes && existingExpensesRes.data) || [])
        .map(function (x) { return x.id; })
        .filter(function (id) { return !incomingExpIds[id]; });
      if (toDeleteExpenses.length) {
        await withRetry("cleanup:expenses-delete", function () { return c.from("expenses").delete().in("id", toDeleteExpenses); });
      }
    } catch (e) {
      emitStorageEvent("error", { table: "cleanup-expenses", message: (e && e.message) || String(e) });
    }

    /* --- Delete removed rates --- */
    try {
      var existingRatesRes = await withRetry("cleanup:rates-select", function () {
        return c.from("rates").select("id").eq("owner_id", accountId);
      });
      var incomingRateIds = {};
      rateRows.forEach(function (r) { incomingRateIds[r.id] = true; });
      var toDeleteRates = ((existingRatesRes && existingRatesRes.data) || [])
        .map(function (r) { return r.id; })
        .filter(function (id) { return !incomingRateIds[id]; });
      if (toDeleteRates.length) {
        await withRetry("cleanup:rates-delete", function () { return c.from("rates").delete().in("id", toDeleteRates); });
      }
    } catch (e) {
      emitStorageEvent("error", { table: "cleanup-rates", message: (e && e.message) || String(e) });
    }

    /* --- Delete removed complaints --- */
    try {
      var existingComplaintsRes = await withRetry("cleanup:complaints-select", function () {
        return c.from("complaints").select("id").eq("owner_id", accountId);
      });
      var incomingCompIds = {};
      complaintRows.forEach(function (c) { incomingCompIds[c.id] = true; });
      var toDeleteComplaints = ((existingComplaintsRes && existingComplaintsRes.data) || [])
        .map(function (c) { return c.id; })
        .filter(function (id) { return !incomingCompIds[id]; });
      if (toDeleteComplaints.length) {
        await withRetry("cleanup:complaints-delete", function () { return c.from("complaints").delete().in("id", toDeleteComplaints); });
      }
    } catch (e) {
      emitStorageEvent("error", { table: "cleanup-complaints", message: (e && e.message) || String(e) });
    }

    _inFlight -= 1;

    /* Permanent failure: any table that still failed after all retries makes
       the whole save reject. The caller (app.js) owns the blocking UI. */
    if (saveErrors.length) {
      setSyncStatus("sync_failed", saveErrors.join(", "));
      var err = new Error("Database save failed for: " + saveErrors.join(", "));
      err.failedTables = saveErrors.map(function (s) { return s.split(":")[0]; });
      err.isPermanentSaveFailure = true;
      throw err;
    }

    setSyncStatus("synced");
  }

  /* ================================================================
     STARTUP SCHEMA CHECK
     Probes every table with a select of exactly the columns the client
     writes (PostgREST validates column names before RLS, so this works
     with the anon key even with no rows). Any 42703 becomes a precise
     "table: missing column" drift report surfaced in the UI.
     ================================================================ */

  /* Expected columns per table — derived from the row shapes in saveFull().
     Keep in sync with saveFull and supabase/schema.sql. */
  var EXPECTED_SCHEMA = {
    rooms: ["id", "no", "floor", "rent"],
    beds: ["id", "room_id", "bed_index", "name", "phone", "joined", "leaving", "note", "collect", "rent", "deposit", "id_type", "id_number", "emergency_contact", "workplace", "on_notice", "paid_months", "payment_info"],
    expenses: ["id", "date", "category", "amount", "note"],
    rates: ["id", "label", "amount", "note"],
    complaints: ["id", "title", "room_id", "room_no", "category", "priority", "status", "date", "note", "cost"],
    activity: ["id", "text", "type", "ts"],
    properties: ["id", "owner_id", "owner_name", "name", "address", "phone", "upi_id", "pg_start_date"],
    settings: ["owner_id", "floors", "bed_style", "bed_numbering"],
    rules: ["owner_id", "visiting", "quiet", "guests", "lockout", "other"]
  };

  var _schemaResult = { checked: false, ok: true, drift: [] };

  async function checkSchema() {
    var c = getClient();
    if (!c || !accountId) {
      _schemaResult = { checked: false, ok: true, drift: [], skipped: true };
      return _schemaResult;
    }
    var drift = [];
    var tables = Object.keys(EXPECTED_SCHEMA);
    /* Fire all probes concurrently — 9 cheap selects, done in ~1 round trip. */
    await Promise.all(tables.map(async function (table) {
      var cols = EXPECTED_SCHEMA[table];
      try {
        var res = await c.from(table).select(cols.join(",")).limit(1);
        if (res && res.error) {
          var col = missingColumn(res.error);
          if (col) {
            drift.push({ table: table, column: col, message: res.error.message });
          } else {
            /* Not a column problem (RLS denial, network, etc.) — report it
               but don't call it drift; the health check covers reachability. */
            drift.push({ table: table, column: null, message: res.error.message });
          }
        }
      } catch (e) {
        drift.push({ table: table, column: null, message: (e && e.message) || String(e) });
      }
    }));
    _schemaResult = { checked: true, ok: drift.length === 0, drift: drift };
    emitStorageEvent(_schemaResult.ok ? "schema-ok" : "schema-drift", {
      drift: drift.slice(),
      ok: _schemaResult.ok
    });
    if (!_schemaResult.ok) {
      var cols = drift.filter(function (d) { return d.column; })
        .map(function (d) { return d.table + "." + d.column; });
      console.error("[SupabaseStorage] SCHEMA DRIFT DETECTED — the live database is missing columns the app writes:",
        cols.join(", "), "| Run supabase/migrate-schema.sql. Full report:", drift);
    }
    return _schemaResult;
  }

  function getSchemaResult() { return _schemaResult; }

  /* ---- Public API ---- */

  /* ---- Health check: quick read to verify DB is reachable ---- */
  var _dbOk = true;
  var _dbChecked = false;

  async function healthCheck() {
    var c = getClient();
    if (!c || !accountId) { _dbOk = false; _dbChecked = true; return false; }
    try {
      var res = await c.from("rooms").select("id").eq("owner_id", accountId).limit(1);
      _dbOk = !res.error;
      _dbChecked = true;
      return _dbOk;
    } catch (e) {
      _dbOk = false;
      _dbChecked = true;
      return false;
    }
  }

  var SupabaseStorage = {
    init: function (aid) {
      accountId = aid || null;
      return !!getClient();
    },

    isAvailable: function () { return !!getClient() && !!accountId; },

    isDbOk: function () { return _dbOk; },
    isDbChecked: function () { return _dbChecked; },

    /* Data-safety telemetry for the UI layer */
    isRetryActive: isRetryActive,
    inflightCount: inflightCount,
    syncStatus: getSyncStatus,
    checkSchema: checkSchema,
    schemaResult: getSchemaResult,

    load: loadFull,
    save: saveFull,
    healthCheck: healthCheck,

    /* Individual operations for import */
    fetchAll: fetchAll,
    upsertAll: upsertAll,
    deleteByIds: deleteByIds,

    /* Expose client for auth operations */
    getClient: getClient
  };

  global.SupabaseStorage = SupabaseStorage;
})(window);
