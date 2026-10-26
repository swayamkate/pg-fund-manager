/* ---------- render ---------- */

function renderStats() {
  const t = totals();
  el("stats").innerHTML = [
    { label: "Total beds", value: t.beds, note: t.rooms === 1 ? "1 room" : t.rooms + " rooms", icon: "bed", tone: "brand" },
    { label: "Occupied", value: t.occupied, note: t.beds ? t.rate + "% occupancy" : "No beds yet", cls: "up", icon: "users", tone: "green" },
    { label: "Vacant", value: t.vacant, note: t.onNotice + " on notice", cls: "warn", icon: "door", tone: "amber" },
    { label: "Collected", value: money(t.collected), note: money(t.pending) + " pending", cls: "warn", icon: "wallet", tone: "brand" }
  ].map(statCard).join("");
}

function occBar(name, filled, total) {
  const pct = total ? Math.round((filled / total) * 100) : 0;
  return `
    <div>
      <div class="bar-row-top"><span>${esc(name)}</span><b>${filled}/${total} · ${pct}%</b></div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
    </div>`;
}

/* An owner with floors switched off gets the same bars counted by room. */
function renderFloors() {
  const state = PGStore.state();
  const rooms = state.rooms;
  const t = totals();
  const useFloors = state.settings.floors !== false;

  el("occ-head").textContent = useFloors ? "Occupancy by floor" : "Occupancy by room";
  el("occ-total").textContent = t.beds ? t.occupied + " of " + t.beds + " beds filled" : "";

  if (!rooms.length) {
    el("floor-bars").innerHTML = '<p class="muted-sm">Add a room to see occupancy here.</p>';
    return;
  }

  if (!useFloors) {
    el("floor-bars").innerHTML = rooms
      .map((r) => occBar("Room " + r.no, r.beds.filter(Boolean).length, r.beds.length))
      .join("");
    return;
  }

  const floors = [];
  rooms.forEach((r) => { if (floors.indexOf(r.floor) === -1) { floors.push(r.floor); } });
  floors.sort((a, b) => a - b);

  el("floor-bars").innerHTML = floors.map((f) => {
    const on = rooms.filter((r) => r.floor === f);
    const total = on.reduce((sum, r) => sum + r.beds.length, 0);
    const filled = on.reduce((sum, r) => sum + r.beds.filter(Boolean).length, 0);
    return occBar("Floor " + f, filled, total);
  }).join("");
}

var _feedExpanded = false;
var _FEED_INITIAL = 5;

function renderFeed() {
  const items = PGStore.state().activity;
  const glyph = { pay: "\u20b9", in: "\u2192", out: "\u2190" };

  if (!items.length) {
    el("feed").innerHTML = '<li class="feed-blank">Nothing yet. Adding rooms, tenants and payments will show up here.</li>';
    return;
  }

  var showItems = _feedExpanded ? items : items.slice(0, _FEED_INITIAL);
  var hasMore = items.length > _FEED_INITIAL;

  var html = showItems.map((a) => {
    const meta = [a.meta, sinceLabel(a.at)].filter(Boolean).join(" · ");
    return `
    <li>
      <span class="ico ico-${esc(a.type)}" aria-hidden="true">${glyph[a.type] || "\u2022"}</span>
      <span class="feed-body">${esc(a.text)}<span>${esc(meta)}</span></span>
    </li>`;
  }).join("");

  if (hasMore) {
    if (_feedExpanded) {
      html += '<li class="feed-see-more"><button class="link-btn" type="button" onclick="_feedExpanded=false;renderFeed()">Show less</button></li>';
    } else {
      html += '<li class="feed-see-more"><button class="link-btn" type="button" onclick="_feedExpanded=true;renderFeed()">See ' + (items.length - _FEED_INITIAL) + ' more updates</button></li>';
    }
  }

  el("feed").innerHTML = html;
}

/* ---------- dashboard graphs ---------- */

function renderGraph() {
  const rooms = PGStore.state().rooms;
  const expenses = PGStore.state().expenses || [];
  const mk = monthKey();

  /* Build last 6 months of data */
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    const label = d.toLocaleDateString("en-IN", { month: "short" });

    /* Count collected rent for this month */
    let collected = 0;
    let expected = 0;
    rooms.forEach((room) => {
      room.beds.forEach((bed, bedIndex) => {
        if (!bed) return;
        const rent = PGStore.monthRent(room, bed, key);
        if (PGStore.ledger(room.id, bedIndex).some((entry) => entry.month === key)) {
          expected += rent;
          if (isArray(bed.paidMonths) && bed.paidMonths.indexOf(key) !== -1) {
            collected += rent;
          }
        }
      });
    });

    /* Count expenses for this month */
    const exp = expenses.filter((x) => String(x.date).slice(0, 7) === key)
      .reduce((s, x) => s + x.amount, 0);

    months.push({ key, label, collected, expected, expenses: exp });
  }

  const maxVal = Math.max(...months.map((m) => Math.max(m.collected, m.expected, m.expenses)), 1);
  const barW = 32;
  const gap = 16;
  const chartH = 140;
  const chartW = months.length * (barW * 2 + gap + 8) + 40;
  const totalCollected = months.reduce((s, m) => s + m.collected, 0);

  el("graph-total").textContent = totalCollected > 0
    ? "Total: " + money(totalCollected) + " (6 months)"
    : "Last 6 months";

  el("chart-container").innerHTML = `
    <svg viewBox="0 0 ${chartW} ${chartH + 30}" width="100%" style="min-width:${chartW}px;display:block">
      <!-- Grid lines -->
      ${[0, 0.25, 0.5, 0.75, 1].map((pct) => {
        const y = chartH - pct * chartH;
        return `<line x1="30" y1="${y}" x2="${chartW - 10}" y2="${y}" stroke="var(--border)" stroke-width="0.5" />
                <text x="26" y="${y + 4}" text-anchor="end" fill="var(--faint)" font-size="9">${pct === 0 ? "" : money(maxVal * pct)}</text>`;
      }).join("")}
      ${months.map((m, i) => {
        const x = 36 + i * (barW * 2 + gap + 8);
        const collectedH = (m.collected / maxVal) * chartH;
        const expectedH = (m.expected / maxVal) * chartH;
        const expH = (m.expenses / maxVal) * chartH;
        return `
          <!-- Expected (gray) -->
          <rect x="${x}" y="${chartH - expectedH}" width="${barW}" height="${expectedH}" rx="4" fill="var(--surface-3)" />
          <!-- Collected (blue) -->
          <rect x="${x}" y="${chartH - collectedH}" width="${barW}" height="${collectedH}" rx="4" fill="var(--brand)" opacity="0.9" />
          <!-- Expenses (amber) -->
          <rect x="${x + barW + 4}" y="${chartH - expH}" width="${barW}" height="${expH}" rx="4" fill="var(--amber)" opacity="0.8" />
          <!-- Month label -->
          <text x="${x + barW + 2}" y="${chartH + 18}" text-anchor="middle" fill="var(--muted)" font-size="11" font-weight="500">${esc(m.label)}</text>
          ${m.key === mk ? `<circle cx="${x + barW}" cy="${chartH + 26}" r="2.5" fill="var(--brand)" />` : ""}`;
      }).join("")}
    </svg>
    <div style="display:flex;gap:16px;margin-top:8px;font-size:11px;color:var(--muted)">
      <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:3px;background:var(--surface-3);display:inline-block"></span>Expected</span>
      <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:3px;background:var(--brand);display:inline-block"></span>Collected</span>
      <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;border-radius:3px;background:var(--amber);display:inline-block"></span>Expenses</span>
    </div>`;
}

function renderRentStatus() {
  const list = tenants();
  const paid = list.filter((t) => t.paid).length;
  const overdue = list.filter((t) => !t.paid && new Date().getDate() > 10).length;
  const due = list.length - paid - overdue;
  const total = list.length;
  const expected = list.reduce((s, t) => s + t.rent, 0);
  const collected = list.filter((t) => t.paid).reduce((s, t) => s + t.rent, 0);
  const pending = expected - collected;

  if (!total) {
    el("rent-status-bars").innerHTML = '<p class="muted-sm">No tenants yet.</p>';
    return;
  }

  const barH = 8;
  const segments = [
    { label: "Paid", count: paid, color: "var(--green)", pct: (paid / total) * 100 },
    { label: "Due", count: due, color: "var(--amber)", pct: (due / total) * 100 },
    { label: "Overdue", count: overdue, color: "var(--red)", pct: (overdue / total) * 100 }
  ].filter((s) => s.count > 0);

  el("rent-status-bars").innerHTML = `
    <div style="margin-bottom:16px">
      <div style="display:flex;height:${barH}px;border-radius:99px;overflow:hidden;background:var(--surface-3)">
        ${segments.map((s) => `<div style="width:${s.pct}%;background:${s.color}"></div>`).join("")}
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px">
      ${segments.map((s) => `
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500">
            <span style="width:8px;height:8px;border-radius:50%;background:${s.color};flex-shrink:0"></span>
            ${s.label}
          </span>
          <span style="font-size:13px;font-weight:600">${s.count} tenant${s.count !== 1 ? "s" : ""}</span>
        </div>`).join("")}
    </div>
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:13px">
      <span style="color:var(--muted)">Expected this month</span>
      <span style="font-weight:600">${money(expected)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:13px;margin-top:6px">
      <span style="color:var(--muted)">Collected</span>
      <span style="font-weight:600;color:var(--green)">${money(collected)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:13px;margin-top:6px">
      <span style="color:var(--muted)">Pending</span>
      <span style="font-weight:600;color:${pending > 0 ? "var(--amber)" : "var(--green)"}">${money(pending)}</span>
    </div>`;
}

function renderExpDashboard() {
  const x = expenseSummary();
  if (!x.list.length) {
    el("exp-dashboard").innerHTML = '<p class="muted-sm">No expenses logged yet.</p>';
    el("exp-summary").textContent = "";
    return;
  }
  el("exp-summary").textContent = x.monthTotal > 0 ? "This month: " + money(x.monthTotal) : "";
  const topCats = Object.keys(x.byCat || {}).length > 0
    ? Object.entries(x.byCat).sort((a, b) => b[1] - a[1]).slice(0, 4)
    : [];
  /* Build a simple breakdown */
  const allByCat = {};
  x.list.forEach((e) => { allByCat[e.category] = (allByCat[e.category] || 0) + e.amount; });
  const sorted = Object.entries(allByCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxCat = sorted.length ? sorted[0][1] : 1;

  el("exp-dashboard").innerHTML = sorted.map(([cat, amt]) => `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
        <span style="color:var(--muted);font-weight:500">${esc(cat)}</span>
        <span style="font-weight:600">${money(amt)}</span>
      </div>
      <div style="height:5px;border-radius:99px;background:var(--surface-3);overflow:hidden">
        <div style="height:100%;width:${(amt / maxCat) * 100}%;border-radius:99px;background:var(--amber);opacity:0.7"></div>
      </div>
    </div>`).join("") + `
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:12.5px">
      <span style="color:var(--muted)">Total all time</span>
      <span style="font-weight:600">${money(x.allTotal)}</span>
    </div>`;
}

function renderRooms() {
  const rooms = PGStore.state().rooms;

  if (!rooms.length) {
    el("rooms").innerHTML = emptyState(
      "No rooms yet",
      "Add your first room and the beds inside it. Everything else builds on this.",
      '<button class="btn-primary btn-sm" data-act="add-room" type="button">Add a room</button>'
    );
    return;
  }

  el("rooms").innerHTML = rooms.map((room) => {
    const filled = room.beds.filter(Boolean).length;

    const beds = room.beds.map((bed, i) => {
      const label = PGStore.bedLabel(i, room.id);
      if (!bed) {
        return `<button class="bed bed-add" type="button" data-act="fill-bed" data-room="${esc(room.id)}" data-bed="${i}">
          <b>Bed ${label}</b><span>+ Add tenant</span>
        </button>`;
      }
      const cls = bed.onNotice ? "bed bed-notice" : "bed bed-occupied";
      return `<button class="${cls}" type="button" data-act="profile" data-room="${esc(room.id)}" data-bed="${i}">
        <b>Bed ${label}</b><span>${esc(bed.name)}</span>
      </button>`;
    }).join("");

    return `
      <div class="room">
        <div class="room-head">
          <b>Room ${esc(room.no)}</b>
          <span class="room-head-right">
            <span class="muted-sm">${filled}/${room.beds.length} · ${money(room.rent)}</span>
            <button class="x-btn" type="button" data-act="edit-room" data-room="${esc(room.id)}" title="Edit room ${esc(room.no)}" aria-label="Edit room ${esc(room.no)}">✎</button>
            <button class="x-btn" type="button" data-act="del-room" data-room="${esc(room.id)}" title="Remove room ${esc(room.no)}" aria-label="Remove room ${esc(room.no)}">×</button>
          </span>
        </div>
        <div class="room-beds">${beds}</div>
      </div>`;
  }).join("");
}

var _tenantsExpanded = false;

function renderTenants() {
  const list = tenants();
  const table = document.querySelector(".table-card");
  const blank = el("tenants-empty");
  const tableWrap = el("tenant-table-wrap");
  const toggleBtn = el("tenant-toggle");
  const toggleText = el("tenant-toggle-text");

  if (!list.length) {
    table.hidden = true;
    el("tenant-cards").innerHTML = "";
    blank.hidden = false;
    blank.innerHTML = emptyState(
      "No tenants yet",
      PGStore.isEmpty()
        ? "Add a room first, then move tenants into its beds."
        : "Move someone into a vacant bed to see them listed here.",
      PGStore.isEmpty()
        ? '<button class="btn-primary btn-sm" data-act="add-room" type="button">Add a room</button>'
        : '<button class="btn-primary btn-sm" data-act="add-tenant" type="button">Add a tenant</button>'
    );
    return;
  }

  table.hidden = false;
  blank.hidden = true;
  blank.innerHTML = "";

  /* Toggle button shows count */
  if (toggleText) {
    toggleText.textContent = _tenantsExpanded
      ? "Hide " + list.length + " tenant" + (list.length !== 1 ? "s" : "")
      : "Show " + list.length + " tenant" + (list.length !== 1 ? "s" : "");
  }
  if (toggleBtn) {
    toggleBtn.setAttribute("aria-expanded", String(_tenantsExpanded));
  }
  if (tableWrap) {
    tableWrap.hidden = !_tenantsExpanded;
  }

  const actions = (t, prefix) => {
    const id = `${prefix}dd-${t.roomId}-${t.bedIndex}`;
    return `<span class="dd-wrap">
      <button class="dd-trigger" type="button" data-dd="${id}" aria-haspopup="true" aria-expanded="false">\u22ee</button>
      <span class="dd-menu" id="${id}" role="menu" hidden>
        <button class="dd-item" role="menuitem" data-act="profile" data-room="${esc(t.roomId)}" data-bed="${t.bedIndex}">Profile</button>
        <button class="dd-item" role="menuitem" data-act="transfer" data-room="${esc(t.roomId)}" data-bed="${t.bedIndex}">Transfer bed</button>
        <button class="dd-item" role="menuitem" data-act="backfill" data-room="${esc(t.roomId)}" data-bed="${t.bedIndex}">Payment history</button>
        <button class="dd-item" role="menuitem" data-act="receipt" data-room="${esc(t.roomId)}" data-bed="${t.bedIndex}">Receipt</button>
        ${!t.paid ? `<button class="dd-item" role="menuitem" data-act="wa-remind" data-room="${esc(t.roomId)}" data-bed="${t.bedIndex}">WhatsApp reminder</button>` : ""}
        <button class="dd-item" role="menuitem" data-act="notice" data-room="${esc(t.roomId)}" data-bed="${t.bedIndex}">${t.onNotice ? "Cancel notice" : "Put on notice"}</button>
        <span class="dd-divider"></span>
        <button class="dd-item dd-danger" role="menuitem" data-act="checkout" data-room="${esc(t.roomId)}" data-bed="${t.bedIndex}">Check out</button>
      </span>
    </span>`;
  };

  el("tenant-rows").innerHTML = list.map((t) => `
    <tr>
      <td><button class="who who-btn" type="button" data-act="profile" data-room="${esc(t.roomId)}" data-bed="${t.bedIndex}"><span class="av">${esc(initials(t.name))}</span><span class="who-name">${esc(t.name)}</span>${t.onNotice ? ' <span class="tag-notice">notice</span>' : ""}</button></td>
      <td class="mono">${esc(t.roomNo)} · ${t.bed}</td>
      <td class="mono">${esc(t.phone) || "\u2014"}</td>
      <td>${prettyDate(t.joined)}</td>
      <td class="mono">${money(t.rent)}${t.hasCustomRent ? ' <span class="tag-custom">custom</span>' : ""}</td>
      <td><span class="badge badge-${t.status}">${BADGE[t.status]}</span></td>
      <td class="row-actions">${actions(t, 'tbl-')}</td>
    </tr>`).join("");

  el("tenant-cards").innerHTML = list.map((t) => `
    <div class="tcard">
      <div class="tcard-top">
        <button class="who who-btn" type="button" data-act="profile" data-room="${esc(t.roomId)}" data-bed="${t.bedIndex}"><span class="av">${esc(initials(t.name))}</span><span class="who-name">${esc(t.name)}</span></button>
        <span class="badge badge-${t.status}">${BADGE[t.status]}</span>
      </div>
      <div class="tcard-grid">
        <div><b>Bed</b>${esc(t.roomNo)} · ${t.bed}</div>
        <div><b>Rent</b>${money(t.rent)}${t.hasCustomRent ? ' <span class="tag-custom">custom</span>' : ""}</div>
        <div><b>Phone</b>${esc(t.phone) || "\u2014"}</div>
        <div><b>Joined</b>${prettyDate(t.joined)}</div>
      </div>
      <div class="row-actions">${actions(t, 'c-')}</div>
    </div>`).join("");
}

function renderRent() {
  const month = selectedRentMonth;
  const list = tenants(month);
  const expected = list.reduce((sum, tenant) => sum + tenant.rent, 0);
  const collected = list.filter((tenant) => tenant.paid).reduce((sum, tenant) => sum + tenant.rent, 0);
  const t = { expected: expected, collected: collected, pending: expected - collected };
  const paid = list.filter((x) => x.paid).length;

  el("rent-title").textContent =
    "Rent \u2014 " + PGStore.monthLabel(month);
  el("rent-month").value = month;

  el("rent-stats").innerHTML = [
    { label: "Expected", value: money(t.expected), note: list.length === 1 ? "1 tenant" : list.length + " tenants", icon: "rupee", tone: "brand" },
    { label: "Collected", value: money(t.collected), note: paid + (paid === 1 ? " payment received" : " payments received"), cls: "up", icon: "wallet", tone: "green" },
    { label: "Pending", value: money(t.pending), note: (list.length - paid) + " still to pay", cls: "warn", icon: "clock", tone: "red" }
  ].map(statCard).join("");

  if (!list.length) {
    el("paylist").innerHTML = '<li class="feed-blank">No rent records for this month. Open a tenant\'s payment history to add or correct a record.</li>';
    return;
  }

  const order = { late: 0, due: 1, paid: 2 };
  el("paylist").innerHTML = list
    .slice()
    .sort((a, b) => order[a.status] - order[b.status])
    .map((x) => `
      <li>
        <span class="pay-left">
          <span class="av">${esc(initials(x.name))}</span>
          <span class="pay-name">${esc(x.name)}<span>Room ${esc(x.roomNo)} · Bed ${x.bed}</span></span>
        </span>
        <span class="pay-right">
          <span class="amount">${money(x.rent)}</span>
          <span class="badge badge-${x.status}">${BADGE[x.status]}</span>
          <button class="link-btn" type="button" data-act="rent-edit-payment" data-room="${esc(x.roomId)}" data-bed="${x.bedIndex}" data-month="${month}">Edit</button>
          <button class="link-btn" type="button" data-act="receipt" data-room="${esc(x.roomId)}" data-bed="${x.bedIndex}" data-month="${month}">Receipt</button>
        </span>
      </li>`).join("");
}

el("rent-month").addEventListener("change", function () {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(this.value)) {
    selectedRentMonth = this.value;
    renderRent();
  }
});

function renderExpenses() {
  const x = expenseSummary();
  const t = totals();
  const net = t.collected - x.monthTotal;

  el("exp-title").textContent =
    "Expenses \u2014 " + new Date().toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  el("exp-count").textContent = x.list.length
    ? (x.list.length === 1 ? "1 entry" : x.list.length + " entries")
    : "";

  el("exp-stats").innerHTML = [
    {
      label: "Spent this month", value: money(x.monthTotal),
      note: x.month.length === 1 ? "1 entry" : x.month.length + " entries",
      cls: "warn", icon: "receipt", tone: "amber"
    },
    {
      label: "Biggest cost", value: x.top ? esc(x.top) : "\u2014",
      note: x.top ? money(x.topAmount) + " this month" : "Nothing logged yet",
      icon: "chart", tone: "brand"
    },
    {
      label: "Net this month", value: signedMoney(net),
      note: money(t.collected) + " rent collected",
      cls: net < 0 ? "warn" : "up", icon: "wallet", tone: net < 0 ? "red" : "green"
    }
  ].map(statCard).join("");

  if (!x.list.length) {
    el("exp-list").innerHTML =
      '<li class="feed-blank">Nothing logged yet. Add electricity, water, staff pay and anything else the property costs you.</li>';
    return;
  }

  el("exp-list").innerHTML = x.list.map((e) => {
    const meta = [e.note, prettyDate(e.date)].filter(Boolean).map(esc).join(" \u00b7 ");
    return `
      <li>
        <span class="pay-left">
          <span class="ico ico-out" aria-hidden="true">\u20b9</span>
          <span class="pay-name">${esc(e.category)}<span>${meta}</span></span>
        </span>
        <span class="pay-right">
          <span class="amount">${money(e.amount)}</span>
          <button class="link-btn" type="button" data-act="edit-expense" data-exp="${esc(e.id)}" aria-label="${esc("Edit " + e.category + " expense dated " + e.date)}">Edit</button>
          <button class="link-btn link-danger" type="button" data-act="del-expense" data-exp="${esc(e.id)}">Remove</button>
        </span>
      </li>`;
  }).join("");
}

