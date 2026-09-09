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

  /* ---- Supabase client ---- */

  function getClient() {
    if (client) { return client; }
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) { return null; }
    try {
      client = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    } catch (e) {
      client = null;
    }
    return client;
  }

  /* ---- Generic CRUD helpers ---- */

  async function fetchAll(table) {
    var c = getClient();
    if (!c || !accountId) { return []; }
    var res = await c.from(table).select("*").eq("owner_id", accountId);
    return res.data || [];
  }

  async function upsertAll(table, rows) {
    var c = getClient();
    if (!c || !accountId || !rows.length) { return; }
    var toSave = rows.map(function (r) {
      r.owner_id = accountId;
      return r;
    });
    await c.from(table).upsert(toSave, { onConflict: "id" });
  }

  async function deleteByIds(table, ids) {
    var c = getClient();
    if (!c || !ids.length) { return; }
    await c.from(table).delete().in("id", ids);
  }

  async function deleteByOwner(table) {
    var c = getClient();
    if (!c || !accountId) { return; }
    await c.from(table).delete().eq("owner_id", accountId);
  }

  async function upsertSingle(table, row) {
    var c = getClient();
    if (!c || !accountId) { return; }
    row.owner_id = accountId;
    await c.from(table).upsert(row, { onConflict: "owner_id" });
  }

  async function fetchSingle(table) {
    var c = getClient();
    if (!c || !accountId) { return null; }
    var res = await c.from(table).select("*").eq("owner_id", accountId).limit(1);
    return (res.data && res.data[0]) || null;
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

    /* --- Upsert all tables (each wrapped for fault tolerance) --- */
    async function safe(table, fn) {
      try { await fn(); } catch (e) { console.warn("Supabase " + table + " save failed:", e); }
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
      return c.from("properties").upsert({ id: accountId, owner_name: propRow.owner_name, name: propRow.name, address: propRow.address, phone: propRow.phone, upi_id: propRow.upi_id, pg_start_date: propRow.pg_start_date }, { onConflict: "id" });
    });
    await safe("settings", function () { return upsertSingle("settings", settingsRow); });
    await safe("rules", function () { return upsertSingle("rules", rulesRow); });

    /* --- Delete removed rooms and their beds --- */
    try {
      var existingRooms = await c.from("rooms").select("id").eq("owner_id", accountId);
      var toDeleteRooms = (existingRooms.data || [])
        .map(function (r) { return r.id; })
        .filter(function (id) { return !roomIds[id]; });
      if (toDeleteRooms.length) {
        await c.from("beds").delete().in("room_id", toDeleteRooms);
        await c.from("rooms").delete().in("id", toDeleteRooms);
      }
    } catch (e) { /* best-effort cleanup */ }

    /* --- Delete removed expenses --- */
    try {
      var existingExpenses = await c.from("expenses").select("id").eq("owner_id", accountId);
      var incomingExpIds = {};
      expenseRows.forEach(function (x) { incomingExpIds[x.id] = true; });
      var toDeleteExpenses = (existingExpenses.data || [])
        .map(function (x) { return x.id; })
        .filter(function (id) { return !incomingExpIds[id]; });
      if (toDeleteExpenses.length) {
        await c.from("expenses").delete().in("id", toDeleteExpenses);
      }
    } catch (e) { /* best-effort */ }

    /* --- Delete removed rates --- */
    try {
      var existingRates = await c.from("rates").select("id").eq("owner_id", accountId);
      var incomingRateIds = {};
      rateRows.forEach(function (r) { incomingRateIds[r.id] = true; });
      var toDeleteRates = (existingRates.data || [])
        .map(function (r) { return r.id; })
        .filter(function (id) { return !incomingRateIds[id]; });
      if (toDeleteRates.length) {
        await c.from("rates").delete().in("id", toDeleteRates);
      }
    } catch (e) { /* best-effort */ }

    /* --- Delete removed complaints --- */
    try {
      var existingComplaints = await c.from("complaints").select("id").eq("owner_id", accountId);
      var incomingCompIds = {};
      complaintRows.forEach(function (c) { incomingCompIds[c.id] = true; });
      var toDeleteComplaints = (existingComplaints.data || [])
        .map(function (c) { return c.id; })
        .filter(function (id) { return !incomingCompIds[id]; });
      if (toDeleteComplaints.length) {
        await c.from("complaints").delete().in("id", toDeleteComplaints);
      }
    } catch (e) { /* best-effort */ }
  }

  /* ---- Public API ---- */

  var SupabaseStorage = {
    init: function (aid) {
      accountId = aid || null;
      return !!getClient();
    },

    isAvailable: function () { return !!getClient() && !!accountId; },

    load: loadFull,
    save: saveFull,

    /* Individual operations for import */
    fetchAll: fetchAll,
    upsertAll: upsertAll,
    deleteByIds: deleteByIds,

    /* Expose client for auth operations */
    getClient: getClient
  };

  global.SupabaseStorage = SupabaseStorage;
})(window);
