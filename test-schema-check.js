/* Headless verification of the startup schema check (checkSchema).
   Drives the REAL supabase-storage.js module with a mock supabase-js client
   whose responses mirror PostgREST exactly:
     - missing column -> resolves { error: { code:"42703", message:"column beds.payment_info does not exist" } }
     - healthy table  -> resolves { data: [], error: null }
     - other failure  -> resolves { error: { message: "..." } } (no code)
   ASSERTS: result shape, drift detection per table, pg:storage-schema-drift
   and pg:storage-schema-ok events, skip mode when not initialized, and that
   withRetry fail-fast does not sleep on 42703. */
"use strict";
const assert = require("assert");

/* ---- browser shims ---- */
global.window = global;
global.CustomEvent = class {
  constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; }
};

/* ---- load the REAL module ---- */
require("./supabase-storage.js");
const S = global.SupabaseStorage;

/* ---- event capture: full DOM-ish bus (addEventListener + dispatchEvent) ---- */
const listeners = {};
global.addEventListener = function (type, fn) {
  (listeners[type] = listeners[type] || []).push(fn);
};
global.dispatchEvent = function (evt) {
  (listeners[evt.type] || []).slice().forEach(function (fn) {
    try { fn(evt); } catch (e) { /* listener errors must not break dispatch */ }
  });
  return true;
};

/* PostgREST-faithful mock: emulate the exact resolution shape supabase-js v2 uses. */
function makeMockClient(failTables) {
  return {
    from(table) {
      return {
        select() {
          return {
            eq() { return { limit: async () => ({ data: [], error: null }) }; },
            limit: async () => ({ data: [], error: null })
          };
        },
        upsert: async () => ({ data: null, error: null }),
        delete() { return { in: async () => ({ data: null, error: null }), eq: async () => ({ data: null, error: null }) }; }
      };
    }
  };
}
/* inject drift/health behavior per table by wrapping from() */
function mockClientWith(tableBehavior) {
  const base = makeMockClient();
  base.from = function (table) {
    const behavior = tableBehavior[table] || "ok";
    if (behavior === "ok") {
      return {
        select: () => ({ limit: async () => ({ data: [], error: null }) }),
        upsert: async () => ({ data: null, error: null })
      };
    }
    if (behavior === "missing-column") {
      return {
        select: () => ({
          limit: async () => ({
            data: null,
            error: { code: "42703", message: "column beds.payment_info does not exist", details: null, hint: null }
          })
        })
      };
    }
    if (behavior === "other-error") {
      return {
        select: () => ({ limit: async () => ({ data: null, error: { message: "permission denied for table secrets" } }) })
      };
    }
    throw new Error("unknown behavior " + behavior);
  };
  return base;
}

/* Override getClient so the real module talks to our mock. */
function injectClient(mock) {
  global.PGAuth = {
    getClient: function () { return mock; }
  };
}

/* SupabaseStorage has no setter for client/accountId; init() reads PGAuth.getClient(). */
function reset() {
  delete global.PGAuth;
  /* Re-require the module to reset internal state. */
  delete require.cache[require.resolve("./supabase-storage.js")];
  require("./supabase-storage.js");
  return global.SupabaseStorage;
}

(async () => {
  let pass = 0, fail = 0;
  function check(name, fn) {
    return Promise.resolve()
      .then(fn)
      .then(() => { pass++; console.log("  PASS", name); })
      .catch(e => { fail++; console.log("  FAIL", name, "—", e.message); });
  }

  console.log("== A. skip mode (no client / no accountId) ==");
  let S2 = reset();
  await check("not initialized -> checked:false, ok:true, skipped:true", async () => {
    const r = await S2.checkSchema();
    assert.strictEqual(r.checked, false);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.skipped, true);
  });

  console.log("== B. drift path (beds missing payment_info — mirrors the live DB) ==");
  S2 = reset();
  injectClient(mockClientWith({ beds: "missing-column" }));
  const initOk = S2.init("acc-123");
  assert.ok(initOk, "init should succeed with mock client");
  let driftEvent = null, okEvent = false;
  global.addEventListener("pg:storage-schema-drift", (e) => { driftEvent = e.detail; });
  global.addEventListener("pg:storage-schema-ok", () => { okEvent = true; });
  await check("checkSchema reports exactly beds.payment_info", async () => {
    const r = await S2.checkSchema();
    assert.strictEqual(r.checked, true);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.drift.length, 1);
    assert.strictEqual(r.drift[0].table, "beds");
    assert.strictEqual(r.drift[0].column, "payment_info");
    assert.match(r.drift[0].message, /does not exist/);
  });
  await check("pg:storage-schema-drift event fired with drift payload", () => {
    assert.ok(driftEvent, "drift event never fired");
    assert.strictEqual(driftEvent.ok, false);
    assert.strictEqual(driftEvent.drift[0].column, "payment_info");
  });
  await check("pg:storage-schema-ok NOT fired on drift", () => {
    assert.strictEqual(okEvent, false);
  });
  await check("schemaResult() exposes the same result object", () => {
    const r = S2.schemaResult();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.drift[0].table, "beds");
  });

  console.log("== C. healthy path (all tables OK) ==");
  S2 = reset();
  injectClient(mockClientWith({}));
  S2.init("acc-123");
  let okFired = false;
  global.addEventListener("pg:storage-schema-ok", () => { okFired = true; });
  let driftFiredC = false;
  global.addEventListener("pg:storage-schema-drift", () => { driftFiredC = true; });
  await check("all 9 tables healthy -> ok:true, drift:[]", async () => {
    const r = await S2.checkSchema();
    assert.strictEqual(r.checked, true);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.drift, []);
  });
  await check("pg:storage-schema-ok fired", () => { assert.ok(okFired); });
  await check("no drift event on healthy DB", () => { assert.strictEqual(driftFiredC, false); });

  console.log("== D. non-column errors are reported but not drift-labelled ==");
  S2 = reset();
  injectClient(mockClientWith({ complaints: "other-error" }));
  S2.init("acc-123");
  await check("non-42703 error -> column:null entry, ok:false", async () => {
    const r = await S2.checkSchema();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.drift.length, 1);
    assert.strictEqual(r.drift[0].table, "complaints");
    assert.strictEqual(r.drift[0].column, null);
    assert.match(r.drift[0].message, /permission denied/);
  });

  console.log("== E. withRetry fail-fast on 42703 (no 15s backoff) ==");
  S2 = reset();
  injectClient(mockClientWith({}));
  S2.init("acc-123");
  await check("schema error thrown by upsert reaches caller immediately", async () => {
    /* A client whose upsert always fails with 42703 */
    const c = S2.getClient();
    c.from = () => ({
      upsert: async () => ({
        data: null,
        error: { code: "42703", message: 'column beds.payment_info does not exist' }
      })
    });
    const t0 = Date.now();
    let caught = null;
    try {
      await S2.upsertAll("beds", [{ id: "x", name: "t" }]);
    } catch (e) { caught = e; }
    const dt = Date.now() - t0;
    assert.ok(caught, "expected upsertAll to reject on permanent schema error");
    assert.match(caught.message, /does not exist/);
    assert.ok(dt < 2000, "schema errors must fail fast, took " + dt + "ms (backoff would be 15s)");
  });

  console.log("\n== RESULT ==");
  console.log("passed:", pass, "| failed:", fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("runner crashed:", e); process.exit(1); });
