/* views/beds.js — visual occupancy grid (mobile-first).
 *
 * Floors → Rooms → Bed chips. Chip color = status:
 *   vacant (green) · occupied (blue) · on notice (amber) · overdue rent (red)
 * Tap chip: vacant → add-tenant sheet; occupied → tenant detail sheet.
 * Subscribes only to the channels it owns (rooms/beds/tenants/ledger).
 */

import { store, mutations } from "../store/index.js";
import { esc, money, toast, openDrawer, closeDrawer, el } from "./ui.js";
import { tenantSheet } from "./tenant-sheet.js";

let host = null;

export function initBeds(container) {
  host = container;
  ["floors", "rooms", "beds", "tenants", "ledger", "*"].forEach((ch) =>
    store.subscribe(ch, render)
  );
  render();
}

export function render() {
  if (!host) { return; }
  const groups = store.occupancy();
  host.replaceChildren();

  if (!groups.length || !groups.some((g) => g.rooms.length)) {
    const empty = el("div", "empty");
    empty.appendChild(el("p", null, "No rooms yet."));
    const start = el("button", "btn btn-primary", "+ Add your first room");
    start.type = "button";
    start.addEventListener("click", () => addRoomSheet());
    empty.appendChild(start);
    host.appendChild(empty);
    return;
  }

  for (const g of groups) {
    const floorEl = el("section", "floor");
    floorEl.appendChild(el("h3", "floor-name", esc(g.floor.label || "Ground")));
    for (const r of g.rooms) {
      const roomEl = el("div", "room-card");
      const head = el("div", "room-head");
      head.innerHTML =
        '<span class="room-no">' + esc(r.room.number) + "</span>" +
        '<span class="room-rent">' + money(r.room.rent) + "/bed</span>";
      const rmBtn = el("button", "room-del", "✕");
      rmBtn.type = "button";
      rmBtn.title = "Remove room";
      rmBtn.setAttribute("aria-label", "Remove room " + r.room.number);
      rmBtn.addEventListener("click", () => {
        if (confirm("Remove room " + r.room.number + "?")) {
          const res = mutations.removeRoom(r.room.id);
          if (!res.ok) { toast(res.error, "error"); } else { toast("Room removed"); }
        }
      });
      head.appendChild(rmBtn);
      roomEl.appendChild(head);

      const grid = el("div", "bed-grid");
      for (const b of r.beds) {
        const chip = el("button", "bed-chip bed-" + b.status);
        chip.type = "button";
        chip.dataset.bedId = b.bed.id;
        chip.innerHTML =
          '<span class="bed-slot">' + esc(b.bedLabel) + "</span>" +
          '<span class="bed-name">' + (b.tenant ? esc(b.tenant.name) : "Vacant") + "</span>";
        chip.addEventListener("click", () => onChip(b));
        grid.appendChild(chip);
      }
      roomEl.appendChild(grid);
      floorEl.appendChild(roomEl);
    }
    host.appendChild(floorEl);
  }

  const add = el("button", "btn btn-ghost add-room-btn", "+ Add room");
  add.type = "button";
  add.addEventListener("click", () => addRoomSheet());
  host.appendChild(add);
}

function onChip(b) {
  if (b.tenant) { tenantSheet(b.tenant.id); return; }
  addTenantSheet(b.bed.id, b.bedLabel, b.room ? b.room.number : "");
}

/* ---- sheets ---- */

function addRoomSheet() {
  const f = el("form", "sheet-form");
  f.innerHTML =
    '<label>Room number / name<input name="number" required maxlength="12" placeholder="101"></label>' +
    '<label>Beds<input name="beds" type="number" min="1" max="12" value="2" required></label>' +
    '<label>Rent per bed (₹)<input name="rent" type="number" min="0" inputmode="numeric" placeholder="6000"></label>' +
    '<label>Floor<input name="level" type="number" min="0" max="20" value="0"></label>' +
    '<button class="btn btn-primary" type="submit">Add room</button>';
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const res = mutations.addRoom(fd.get("number"), fd.get("beds"),
      { rent: fd.get("rent"), level: fd.get("level") });
    if (!res.ok) { toast(res.error, "error"); return; }
    toast("Room " + res.room.number + " added");
    closeDrawer();
  });
  openDrawer("Add room", f);
}

function addTenantSheet(bedId, bedLabel, roomNo) {
  const f = el("form", "sheet-form");
  f.innerHTML =
    '<p class="sheet-sub">Room ' + esc(roomNo) + " · Bed " + esc(bedLabel) + "</p>" +
    '<label>Name<input name="name" required maxlength="60"></label>' +
    '<label>Phone<input name="phone" maxlength="24" inputmode="tel"></label>' +
    '<label>Join date<input name="joined" type="date"></label>' +
    '<label>Custom rent (₹, blank = room rent)<input name="rent" type="number" min="0" inputmode="numeric"></label>' +
    '<label>Deposit (₹)<input name="deposit" type="number" min="0" inputmode="numeric"></label>' +
    '<label>ID type<input name="idType" maxlength="30" placeholder="Aadhaar / PAN / Passport"></label>' +
    '<label>ID number<input name="idNumber" maxlength="40"></label>' +
    '<button class="btn btn-primary" type="submit">Add tenant</button>';
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const res = mutations.addTenant(bedId, Object.fromEntries(fd.entries()));
    if (!res.ok) { toast(res.error, "error"); return; }
    toast(res.tenant.name + " checked in");
    closeDrawer();
  });
  openDrawer("Add tenant", f);
}
