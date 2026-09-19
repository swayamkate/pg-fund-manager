/* views/dashboard.js — v2 dashboard: stat cards + occupancy bar.
 * Everything reads through the store; any relevant change re-renders it.
 */

import { store, mutations } from "../store/index.js";
import { esc, money, el } from "./ui.js";

let host = null;

export function initDashboard(container) {
  host = container;
  ["tenants", "beds", "rooms", "ledger", "*"].forEach((ch) => store.subscribe(ch, render));
  render();
  // Feature 5: on cold load the local numbers render instantly; one
  // get_owner_stats() RPC then refreshes them from the database.
  store.ownerStats().then((s) => {
    if (s && s.source === "rpc" && host) { render(s); }
  }).catch(() => { /* local numbers stay */ });
}

export function render(rpcStats) {
  if (!host) { return; }
  host.replaceChildren();

  if (rpcStats) {
    // RPC path: numbers straight from the database (single call).
    const occ2 = rpcStats.totalBeds ? Math.round((rpcStats.occupiedBeds / rpcStats.totalBeds) * 100) : 0;
    const grid = el("div", "stats");
    grid.appendChild(stat("Active tenants", String(rpcStats.activeTenants)));
    grid.appendChild(stat("Occupancy", occ2 + "%", occ2 + "% full"));
    grid.appendChild(stat("Collected this month", money(Number(rpcStats.collected)), rpcStats.paidCount + "/" + (rpcStats.paidCount + rpcStats.dueCount + rpcStats.overdueCount) + " paid"));
    grid.appendChild(stat("Overdue", Number(rpcStats.overdueCount) ? money(Number(rpcStats.overdueAmount)) : "—",
      Number(rpcStats.overdueCount) ? rpcStats.overdueCount + " tenant(s)" : "all clear"));
    host.appendChild(grid);
    const bar2 = el("div", "occ-bar");
    bar2.appendChild(Object.assign(el("div", "occ-fill"), { style: { width: occ2 + "%" } }));
    host.appendChild(el("p", "occ-note", esc(rpcStats.occupiedBeds + " of " + rpcStats.totalBeds + " beds filled")));
    return;
  }

  const tenants = store.state().tenants;
  const beds = store.state().beds;
  const live = Object.values(beds).filter((b) => !b.deleted_at);
  const occupied = live.filter((b) => b.tenant_id).length;
  const active = Object.values(tenants).filter((t) => !t.deleted_at && t.status !== "moved_out");
  const rows = store.rentLedger(store.currentPeriod());
  const paidRows = rows.filter((r) => r.status === "paid");
  const collected = paidRows.reduce((s, r) => s + (r.entry ? r.entry.paid : 0), 0);
  const overdue = rows.filter((r) => r.status === "overdue");
  const occ = live.length ? Math.round((occupied / live.length) * 100) : 0;

  const grid = el("div", "stats");
  grid.appendChild(stat("Active tenants", String(active.length)));
  grid.appendChild(stat("Occupancy", occ + "%", occ + "% full"));
  grid.appendChild(stat("Collected this month", money(collected), paidRows.length + "/" + rows.length + " paid"));
  grid.appendChild(stat("Overdue", overdue.length ? money(overdue.reduce((s, r) => s + r.dueAmount - (r.entry ? r.entry.paid : 0), 0)) : "—",
    overdue.length ? overdue.length + " tenant(s)" : "all clear"));
  host.appendChild(grid);

  const bar = el("div", "occ-bar");
  const fill = el("div", "occ-fill");
  fill.style.width = occ + "%";
  bar.appendChild(fill);
  host.appendChild(el("p", "occ-note", esc(occupied + " of " + live.length + " beds filled")));

  function stat(label, value, sub) {
    const c = el("div", "stat-card");
    c.innerHTML = "<strong>" + esc(value) + "</strong><span>" + esc(label) + "</span>" +
      (sub ? '<em>' + esc(sub) + "</em>" : "");
    return c;
  }
}
