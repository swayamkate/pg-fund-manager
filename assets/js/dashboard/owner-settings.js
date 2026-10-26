/* ---------- owner tab ---------- */

const SETTINGS_ROWS = [
  {
    key: "floors",
    title: "Floors",
    note: "Turn this off for a single-storey PG. Rooms stop asking for a floor, and the overview counts by room instead.",
    opts: [{ v: true, label: "Use floors" }, { v: false, label: "No floors" }]
  },
  {
    key: "bedStyle",
    title: "Bed labels",
    note: "How every bed is named \u2014 on the bed tiles, in the rent list and on each tenant profile.",
    opts: [{ v: "alpha", label: "Letters" }, { v: "number", label: "Numbers" }]
  },
  {
    key: "bedNumbering",
    title: "Beds in a new room",
    note: "Start every room again from the first label, or carry on counting from the room before it.",
    opts: [{ v: "restart", label: "Start again" }, { v: "continue", label: "Carry on" }]
  }
];

function ownerName() {
  const o = PGStore.state().owner || {};
  return o.name || (window.PG_SESSION && PG_SESSION.name) || "Owner";
}

function renderOwner() {
  const s = PGStore.state();
  const o = s.owner || {};
  const t = totals();
  const tel = String(o.phone || "").replace(/[^0-9+]/g, "");
  const name = ownerName();

  el("owner-card").innerHTML = `
    <div class="own-top">
      <span class="av own-av">${esc(initials(name))}</span>
      <span class="own-id">
        <b>${esc(name)}</b>
        <span>${esc(s.property || "Property not named yet")}</span>
      </span>
    </div>
    <div class="own-grid">
      <div class="own-cell"><b>Phone</b><span>${
        tel ? `<a href="tel:${esc(tel)}">${esc(o.phone)}</a>` : "<i>Not added yet</i>"
      }</span></div>
      <div class="own-cell"><b>Address</b><span>${
        o.address ? esc(o.address) : "<i>Not added yet</i>"
      }</span></div>
      <div class="own-cell"><b>Property</b><span>${t.rooms} ${t.rooms === 1 ? "room" : "rooms"} · ${t.beds} beds · ${t.occupied} filled</span></div>
      <div class="own-cell"><b>Rent this month</b><span>${money(t.collected)} of ${money(t.expected)}</span></div>
      ${o.pgStartDate ? `<div class="own-cell"><b>PG Started</b><span>${prettyDate(o.pgStartDate)} · ${pgDuration(o.pgStartDate)}</span></div>` : ""}
    </div>`;

  /* The greeting and the avatar follow whatever name the owner saved. */
  el("greet").textContent = greeting() + ", " + String(name).split(" ")[0];
  el("avatar").textContent = initials(name);
  el("avatar").title = name;

  /* Show PG starting date below the greeting */
  const pgDate = el("pg-start-info");
  if (pgDate) {
    const sd = o.pgStartDate;
    pgDate.textContent = sd ? "Running for " + pgDuration(sd) + " since " + prettyDate(sd) : "";
    pgDate.style.display = sd ? "" : "none";
  }
}

/* Shows the labels the current choices actually produce, using real rooms. */
function bedPreview() {
  const rooms = PGStore.state().rooms;
  if (!rooms.length) { return "Add a room and the labels will preview here."; }

  const a = rooms[0];
  const first = a.beds.map((bed, i) => PGStore.bedLabel(i, a.id)).join(", ");
  if (rooms.length < 2) { return "Beds read " + first + " in room " + a.no + "."; }

  const b = rooms[1];
  return "Beds read " + first + " in room " + a.no +
    ", then " + PGStore.bedLabel(0, b.id) + " in room " + b.no + ".";
}

function renderSettings() {
  const s = PGStore.state().settings;

  el("settings-list").innerHTML = SETTINGS_ROWS.map((row) => {
    const opts = row.opts.map((o) => {
      const on = o.v === s[row.key];
      return `<button class="seg${on ? " is-on" : ""}" type="button" aria-pressed="${on}" data-act="set-opt" data-key="${row.key}" data-val="${String(o.v)}">${o.label}</button>`;
    }).join("");

    return `
      <div class="set-row">
        <div class="set-text"><b>${row.title}</b><span>${row.note}</span></div>
        <div class="seg-group">${opts}</div>
      </div>`;
  }).join("");

  el("set-preview").textContent = bedPreview();
}

/* The rents your rooms are actually set to, so the card can be sanity-checked. */
function roomRates() {
  const map = {};
  PGStore.state().rooms.forEach((r) => {
    const k = String(r.rent);
    if (!map[k]) { map[k] = { amount: r.rent, beds: 0, rooms: [] }; }
    map[k].beds += r.beds.length;
    map[k].rooms.push(r.no);
  });
  return Object.keys(map).map((k) => map[k]).sort((a, b) => b.amount - a.amount);
}

function rateRow(label, sub, amount) {
  return `
    <div class="rc-row">
      <div><b>${esc(label)}</b><span>${esc(sub)}</span></div>
      <span class="rc-amt">${money(amount)}</span>
    </div>`;
}

function renderRates() {
  const rates = PGStore.state().rates;

  el("rate-list").innerHTML = rates.length
    ? rates.map((r) => `
      <div class="rc-row">
        <div><b>${esc(r.label)}</b><span>${esc(r.note || "per bed, per month")}</span></div>
        <span class="pay-right">
          <span class="rc-amt">${money(r.amount)}</span>
          <button class="link-btn" type="button" data-act="edit-rate" data-rate="${esc(r.id)}">Edit</button>
          <button class="link-btn link-danger" type="button" data-act="del-rate" data-rate="${esc(r.id)}">Remove</button>
        </span>
      </div>`).join("")
    : '<p class="rate-blank">Nothing on the card yet. Add what you charge for a single, a two sharing, an AC room \u2014 then you can pull it up in front of anyone who asks.</p>';
}

function openRateDialog(rateId) {
  const rate = rateId ? PGStore.state().rates.find((r) => r.id === rateId) : null;
  if (rateId && !rate) { toast("That rate is gone already.", "error"); return; }
  closeDlg("dlg-rates");
  el("form-rate").dataset.rateId = rate ? rate.id : "";
  el("ra-title").textContent = rate ? "Edit rate" : "Add a rate";
  el("ra-save").textContent = rate ? "Save changes" : "Add rate";
  el("ra-label").value = rate ? rate.label : "";
  el("ra-amt").value = rate ? rate.amount : "";
  el("ra-note").value = rate ? rate.note || "" : "";
  el("ra-err").hidden = true;
  openDlg("dlg-rate");
}

/* ---- Bulk set rents ---- */
function openSetRents() {
  const s = PGStore.state();
  const list = el('setrents-list');
  if (!list) return;
  let html = '';
  s.rooms.forEach(room => {
    const occupied = (room.beds || []).filter(b => b && b.name);
    if (!occupied.length) return;
    html += '<div style="margin-bottom:14px"><b style="font-size:13px;color:var(--muted)">Room ' + esc(room.no) + ' — ₹' + (room.rent || 0).toLocaleString('en-IN') + '/mo base</b></div>';
    occupied.forEach((bed, i) => {
      const idx = room.beds.indexOf(bed);
      const key = room.id + '-' + idx;
      const curRent = (bed.rent != null && bed.rent > 0) ? bed.rent : (room.rent || 0);
      html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">';
      html += '<span style="flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(bed.name) + '</span>';
      html += '<span style="font-size:12px;color:var(--muted);white-space:nowrap">₹</span>';
      html += '<input type="number" min="0" step="100" value="' + curRent + '" data-rent-key="' + key + '" style="width:100px;font-size:13px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface-2);color:var(--text);text-align:right">';
      html += '</div>';
    });
  });
  if (!html) {
    html = '<p style="color:var(--muted);font-size:13px;padding:16px 0">No occupied beds found. Add tenants first.</p>';
  }
  list.innerHTML = html;
  openDlg('dlg-setrents');
}

function saveSetRents() {
  const s = PGStore.state();
  const inputs = document.querySelectorAll('[data-rent-key]');
  inputs.forEach(inp => {
    const parts = inp.dataset.rentKey.split('-');
    const roomId = parts[0];
    const bedIdx = parseInt(parts[1], 10);
    const newRent = Math.round(Number(inp.value) || 0);
    const room = s.rooms.find(r => r.id === roomId);
    if (room && room.beds[bedIdx]) {
      room.beds[bedIdx].rent = newRent > 0 ? newRent : null;
    }
  });
  commit();
  toast('Bed rents updated', 'success');
  closeDlg('dlg-setrents');
  renderAll();
}

function openRateCard() {
  const rates = PGStore.state().rates;
  const rooms = roomRates();

  const mine = '<div class="rc-sec"><h4>What you charge</h4>' + (rates.length
    ? rates.map((r) => rateRow(r.label, r.note || "per bed, per month", r.amount)).join("")
    : '<p class="rate-blank">No rates added yet.</p>') + "</div>";

  const actual = rooms.length
    ? '<div class="rc-sec"><h4>What your rooms are set to</h4>' +
      rooms.map((d) => rateRow(
        d.beds + (d.beds === 1 ? " bed" : " beds"),
        "Room " + d.rooms.join(", "),
        d.amount
      )).join("") + "</div>"
    : "";

  el("rates-body").innerHTML = mine + actual;
  openDlg("dlg-rates");
}

function openOwnerDialog() {
  const o = PGStore.state().owner || {};
  el("o-name").value = o.name || (window.PG_SESSION && PG_SESSION.name) || "";
  el("o-phone").value = o.phone || "";
  if (el("o-upi")) { el("o-upi").value = o.upiId || ""; }
  el("o-address").value = o.address || "";
  if (el("o-pgdate")) { el("o-pgdate").value = o.pgStartDate || ""; }
  openDlg("dlg-owner");
}

