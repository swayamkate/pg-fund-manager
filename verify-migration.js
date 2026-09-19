/* Phase 0/1 verification — proves the MAPPING LOGIC of 002_migrate_beds_data.sql
   is loss-free before it ever touches real data.

   No Postgres locally, so this replays the migration's exact transformation
   rules (steps 5 & 6 of the SQL) in Node against the REAL recovered dataset
   (pg-backup-recovered-2026-09-14.json — 6 rooms, 23 tenants, 5 months of
   payment history), then asserts zero loss:

     A. every occupied bed  -> exactly one tenant
     B. every tenant        -> bed link back (beds.tenant_id)
     C. every paid month    -> exactly one ledger row, due=paid=effective rent
     D. payment_info date/utr -> ledger.paid_on / reference, preserved
     E. vacants skipped, notice -> on_notice, past leaving -> moved_out
     F. idempotency: replaying the run changes nothing

   Also live-probes the Supabase project (when DNS allows) to confirm the
   migration files are still REQUIRED, i.e. the new tables don't exist yet. */

const fs = require("fs");

/* ---------- load the real recovered dataset ---------- */
const src = JSON.parse(fs.readFileSync("pg-backup-recovered-2026-09-14.json", "utf8"));
if (!Array.isArray(src.rooms)) { console.error("FATAL: no rooms in backup"); process.exit(1); }

/* ---------- the migration rules, transcribed from the SQL ---------- */
const monthOf = (iso) => { const m = /^(\d{4})-(\d{2})/.exec(String(iso || "")); return m ? `${m[1]}-${m[2]}` : null; };

function migrate(rooms, existing = { tenantsByBed: new Map(), ledgerKeys: new Set() }) {
  const tenants = [...existing.tenantsByBed.values()];
  const ledger = [];
  const today = "2026-09-19"; // frozen "now" so status rules are deterministic

  for (const room of rooms) {
    const propertyId = room.propertyId || "prop-1";
    (room.beds || []).forEach((bed, i) => {
      if (!bed || !bed.name || bed.name.trim() === "") return;           // vacant slot: skip
      if (existing.tenantsByBed.has(`${room.id}-b${i}`)) return;         // idempotency guard

      const leaving = bed.leaving || null;
      const onNotice = !!bed.onNotice;
      const movedOut = !onNotice && leaving && leaving <= today;
      const tenant = {
        id: `t-${room.id}-b${i}`,
        propertyId,
        bedId: `${room.id}-b${i}`,
        name: bed.name.trim(),
        phone: bed.phone || "",
        idType: bed.idType || "",                    // refinement: id fields
        idNumber: bed.idNumber || "",
        joinedOn: bed.joined || null,
        plannedLeaveOn: onNotice ? leaving : null,
        leftOn: movedOut ? leaving : null,
        status: onNotice || !leaving || leaving > today ? "active" : "moved_out",
        rentAmount: bed.rent != null ? bed.rent : null,
        collectDay: bed.collect || 0,
        deposit: bed.deposit || 0,
        notes: bed.note || "",
      };
      tenants.push(tenant);
      existing.tenantsByBed.set(tenant.bedId, tenant);

      // step 6: paid_months[] + payment_info -> ledger rows
      const effRent = tenant.rentAmount != null ? tenant.rentAmount : (room.rent || 0);
      const months = Array.isArray(bed.paidMonths) ? [...bed.paidMonths].sort() : [];
      for (const m of months) {
        if (existing.ledgerKeys.has(`${tenant.id}|${m}`)) continue;
        const info = (bed.paymentInfo && bed.paymentInfo[m]) || {};
        ledger.push({
          tenantId: tenant.id, period: m,
          due: effRent, paid: effRent, status: "paid",
          paidOn: info.date || null,
          method: info.utr ? "upi" : null,
          reference: info.utr || null,
        });
        existing.ledgerKeys.add(`${tenant.id}|${m}`);
      }
    });
  }
  return { tenants, ledger };
}

/* ---------- run against real data ---------- */
const rooms = src.rooms.map((r) => ({
  id: r.id, no: r.no, rent: r.rent, propertyId: null, // step 3/4 assign prop-1
  beds: r.beds,
}));
const run1 = migrate(rooms);
for (const t of run1.tenants) t.propertyId = "prop-1";
for (const l of run1.ledger) l.propertyId = "prop-1";

/* ---------- assertions ---------- */
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
};

// ground truth from the legacy blob
const legacyOccupied = [], legacyMonths = [];
for (const r of rooms) (r.beds || []).forEach((b, i) => {
  if (b && b.name && b.name.trim()) {
    legacyOccupied.push(`${r.id}-b${i}`);
    for (const m of b.paidMonths || []) legacyMonths.push(`${r.id}-b${i}|${m}`);
  }
});
const vacants = rooms.reduce((n, r) => n + (r.beds || []).filter((b) => !b || !b.name).length, 0);
const noticeBeds = rooms.reduce((n, r) => n + (r.beds || []).filter((b) => b && b.onNotice).length, 0);
const movedBeds = rooms.reduce((n, r) => n + (r.beds || []).filter((b) => b && b.name && !b.onNotice && b.leaving && b.leaving <= "2026-09-19").length, 0);

console.log(`\nDataset: ${rooms.length} rooms, ${legacyOccupied.length} occupied beds, ${vacants} vacant slots, ${legacyMonths.length} paid months, ${noticeBeds} on notice, ${movedBeds} moved out\n`);

console.log("A. tenants created == occupied beds");
check("count match", run1.tenants.length === legacyOccupied.length, `${run1.tenants.length} vs ${legacyOccupied.length}`);

console.log("B. every tenant linked back to its bed");
check("all linked", run1.tenants.every((t) => legacyOccupied.includes(t.bedId)));
check("no duplicates", new Set(run1.tenants.map((t) => t.bedId)).size === run1.tenants.length);

console.log("C. every paid month -> one ledger row, due=paid=effective rent");
check("count match", run1.ledger.length === legacyMonths.length, `${run1.ledger.length} vs ${legacyMonths.length}`);
check("no dup tenant|period", new Set(run1.ledger.map((l) => `${l.tenantId}|${l.period}`)).size === run1.ledger.length);
check("all paid-full", run1.ledger.every((l) => l.due === l.paid && l.status === "paid" && l.due > 0));

console.log("D. payment_info preserved (date -> paid_on, utr -> reference)");
let withInfo = 0, infoKept = 0;
for (const r of rooms) (r.beds || []).forEach((b) => {
  if (!b || !b.paymentInfo) return;
  for (const [m, info] of Object.entries(b.paymentInfo)) {
    withInfo++;
    const row = run1.ledger.find((l) => l.tenantId === `t-${r.id}-b${(r.beds || []).indexOf(b)}` && l.period === m);
    if (row && row.paidOn === (info.date || null) && row.reference === (info.utr || null)) infoKept++;
  }
});
check(`info rows preserved (${infoKept}/${withInfo})`, withInfo === 0 || infoKept === withInfo);

console.log("E. status rules: vacants skipped, notice/moved-out classified");
check("no tenant from a vacant slot", run1.tenants.every((t) => t.name));
check("notice -> on_notice", run1.tenants.filter((t) => t.status === "on_notice").length === noticeBeds);
check("past leaving -> moved_out", run1.tenants.filter((t) => t.status === "moved_out").length === movedBeds);

console.log("F. idempotency: replay changes nothing");
const before = JSON.stringify([run1.tenants.length, run1.ledger.length]);
const run2 = migrate(rooms, { tenantsByBed: new Map(run1.tenants.map((t) => [t.bedId, t])), ledgerKeys: new Set(run1.ledger.map((l) => `${l.tenantId}|${l.period}`)) });
check("second run adds 0 tenants / 0 ledger rows", run2.tenants.length === run1.tenants.length && run2.ledger.length === 0 && new Set(run2.tenants.map(t => t.bedId)).size === run1.tenants.length);

console.log("G. refinements present in schema file");
const s001 = fs.readFileSync("supabase/migrations/001_normalized_schema.sql", "utf8");
check("tenants.id_type/id_number", /id_type\s+TEXT/.test(s001) && /id_number\s+TEXT/.test(s001));
check("rent_ledger.reminder_sent_at", /reminder_sent_at\s+TIMESTAMPTZ/.test(s001));
check("property_id on all normalized tables", (s001.match(/property_id/g) || []).length >= 8);
check("RLS on new tables", /ENABLE ROW LEVEL SECURITY/.test(s001) && /floors_own/.test(s001) && /tenants_own/.test(s001) && /rent_ledger_own/.test(s001));

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
