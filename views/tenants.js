/* views/tenants.js — instant tenant search (client-side, offline-friendly).
 * One input filters by name / phone / room number / bed slot as you type.
 * Results are buttons — tapping opens the shared tenant sheet.
 */

import { store } from "../store/index.js";
import { esc, money, el } from "./ui.js";
import { tenantSheet } from "./tenant-sheet.js";

let host = null;
let query = "";

export function initTenants(container) {
  host = container;
  ["tenants", "beds", "rooms", "*"].forEach((ch) => store.subscribe(ch, render));
  render();
}

export function render() {
  if (!host) { return; }
  host.replaceChildren();

  const input = el("input", "search-input");
  input.type = "search";
  input.placeholder = "Search name, phone, room, bed…";
  input.value = query;
  input.setAttribute("aria-label", "Search tenants");
  const deb = debounce(() => { query = input.value.trim().toLowerCase(); results(); }, 120);
  input.addEventListener("input", deb);
  host.appendChild(input);

  const box = el("div", "search-results");
  host.appendChild(box);
  resultsInto(box);
}

function resultsInto(box) {
  box.replaceChildren();
  const all = store.state().tenants;
  const rooms = store.state().rooms;

  const tenants = Object.values(all)
    .filter((t) => !t.deleted_at && t.status !== "moved_out")
    .map((t) => {
      const bed = t.bed_id && store.bedOccupancy(t.bed_id);
      const room = bed && store.roomWithBeds(bed.bed.room_id);
      return {
        t,
        roomNo: room ? room.room.number : "",
        bedLabel: bed ? String.fromCharCode(65 + (bed.bed.slot % 26)) : ""
      };
    })
    .filter((x) => matches(x, query))
    .sort((a, b) => a.t.name.localeCompare(b.t.name));

  if (!tenants.length) {
    box.appendChild(el("p", "empty", query ? "No tenants match “" + query + "”." : "No tenants yet — add one from the Beds tab."));
    return;
  }

  const list = el("ul", "tenant-list");
  for (const x of tenants) {
    const li = el("li");
    const b = el("button", "tenant-row");
    b.type = "button";
    b.innerHTML =
      '<span class="t-name">' + esc(x.t.name) + "</span>" +
      '<span class="t-meta">' + esc(x.roomNo || "—") + " · Bed " + esc(x.bedLabel || "—") +
      (x.t.phone ? " · " + esc(x.t.phone) : "") + "</span>" +
      '<span class="t-rent">' + money(store.effectiveRent(x.t)) + "</span>";
    b.addEventListener("click", () => tenantSheet(x.t.id));
    li.appendChild(b);
    list.appendChild(li);
  }
  box.appendChild(list);
}

/* Kept separate from resultsInto's box path for the debounced input case:
   the input must NOT be rebuilt (focus loss), only the results. */
function results() {
  const box = host && host.querySelector(".search-results");
  if (box) { resultsInto(box); }
}

function matches(x, q) {
  if (!q) { return true; }
  return (x.t.name || "").toLowerCase().includes(q) ||
    (x.t.phone || "").includes(q) ||
    x.roomNo.toLowerCase().includes(q) ||
    ("bed " + x.bedLabel).toLowerCase().includes(q) ||
    x.bedLabel.toLowerCase() === q;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
