/* PG Manager — dashboard.

   No sample data lives in this file. Everything on screen comes from PGStore,
   which starts empty for every account and is filled in through the UI.
*/

/* ---------- helpers ---------- */

const el = (id) => document.getElementById(id);
const money = (n) => "\u20b9" + Number(n || 0).toLocaleString("en-IN");
const isArray = (v) => Array.isArray(v);
const BADGE = { paid: "Paid", due: "Due", late: "Overdue" };

const initials = (name) =>
  String(name || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "?";

/* Tenant names and phone numbers are typed by the user, so everything that
   reaches innerHTML goes through this first. */
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- toast notifications ---------- */
function toast(msg, type, duration) {
  type = type || 'success';
  duration = duration || 3000;
  var container = el('toast-container');
  if (!container) return;
  var icons = { success: '✓', error: '✕', info: 'ℹ', warn: '⚠' };
  var t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.innerHTML = '<span class="toast-icon">' + (icons[type] || '') + '</span>' +
    '<span class="toast-body">' + esc(msg) + '</span>' +
    '<button class="toast-close" type="button" aria-label="Dismiss">✕</button>';
  t.querySelector('.toast-close').onclick = function () { removeToast(t); };
  container.appendChild(t);
  setTimeout(function () { removeToast(t); }, duration);
}
function removeToast(t) {
  if (!t || !t.parentNode) return;
  t.classList.add('removing');
  setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 250);
}

/* ---------- custom confirm dialog ---------- */
var _confirmResolve = null;
function confirmAsync(opts) {
  return new Promise(function (resolve) {
    _confirmResolve = resolve;
    var dlg = el('dlg-confirm');
    var icon = el('confirm-icon');
    var title = el('confirm-title');
    var msg = el('confirm-msg');
    var okBtn = el('confirm-ok');
    var cancelBtn = el('confirm-cancel');
    var type = opts.type || 'warn';
    icon.textContent = opts.icon || (type === 'danger' ? '⚠' : type === 'success' ? '✓' : '?');
    icon.className = 'confirm-' + type;
    title.textContent = opts.title || 'Are you sure?';
    msg.textContent = opts.message || '';
    okBtn.textContent = opts.okText || 'Confirm';
    okBtn.className = type === 'danger' ? 'btn-primary btn-sm btn-danger' : 'btn-primary btn-sm';
    okBtn.style.width = 'auto';
    okBtn.style.minWidth = '120px';
    function close(result) {
      if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
      if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
    }
    okBtn.onclick = function () { close(true); };
    cancelBtn.onclick = function () { close(false); };
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  });
}

function prettyDate(value) {
  if (!value) { return "\u2014"; }
  const d = new Date(value);
  if (isNaN(d.getTime())) { return esc(value); }
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function sinceLabel(iso) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) { return ""; }
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) { return "just now"; }
  if (mins < 60) { return mins + " min ago"; }
  const hrs = Math.round(mins / 60);
  if (hrs < 24) { return hrs + (hrs === 1 ? " hour ago" : " hours ago"); }
  const days = Math.round(hrs / 24);
  return days === 1 ? "yesterday" : days + " days ago";
}

/* Unpaid becomes "Overdue" once we are past the 10th of the month. */
function bedStatus(bed) {
  if (bed.paid) { return "paid"; }
  return new Date().getDate() > 10 ? "late" : "due";
}

let selectedRentMonth = monthKey();

function tenants(month) {
  const out = [];
  PGStore.state().rooms.forEach((room) => {
    room.beds.forEach((bed, i) => {
      if (!bed) { return; }
      if (month && !PGStore.ledger(room.id, i).some((entry) => entry.month === month)) { return; }
      const period = month || monthKey();
      const effRent = PGStore.monthRent(room, bed, period);
      const paid = (bed.paidMonths || []).includes(period);
      out.push({
        name: bed.name,
        phone: bed.phone,
        joined: bed.joined,
        leaving: bed.leaving,
        note: bed.note,
        deposit: bed.deposit || 0,
        idType: bed.idType || "",
        idNumber: bed.idNumber || "",
        emergencyContact: bed.emergencyContact || "",
        workplace: bed.workplace || "",
        onNotice: bed.onNotice,
        paid: paid,
        status: paid ? "paid" : (period < monthKey() || (period === monthKey() && new Date().getDate() > 10) ? "late" : "due"),
        roomId: room.id,
        roomNo: room.no,
        bedIndex: i,
        bed: PGStore.bedLabel(i, room.id),
        rent: effRent,
        hasCustomRent: bed.rent != null && bed.rent > 0
      });
    });
  });
  return out;
}

function totals() {
  const rooms = PGStore.state().rooms;
  const list = tenants();
  const beds = rooms.reduce((s, r) => s + r.beds.length, 0);
  const expected = list.reduce((s, t) => s + t.rent, 0);
  const collected = list.filter((t) => t.paid).reduce((s, t) => s + t.rent, 0);
  return {
    rooms: rooms.length,
    beds,
    occupied: list.length,
    vacant: beds - list.length,
    onNotice: list.filter((t) => t.onNotice).length,
    expected,
    collected,
    pending: expected - collected,
    rate: beds ? Math.round((list.length / beds) * 100) : 0
  };
}

const ICONS = {
  bed: '<path d="M4 18v-8"/><path d="M4 14h16v4"/><path d="M20 14v-1.5a2 2 0 0 0-2-2h-7V14"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.6a3 3 0 0 1 0 4.8"/><path d="M18.5 19a5.6 5.6 0 0 0-2-4"/>',
  door: '<path d="M6 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17"/><path d="M4 21h16"/><circle cx="14" cy="12" r=".6"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h11v3"/><rect x="3" y="7" width="18" height="12" rx="2.5"/><circle cx="16.5" cy="13" r="1"/>',
  rupee: '<circle cx="12" cy="12" r="9"/><path d="M9.5 8h5"/><path d="M9.5 10.5h5"/><path d="M13 10.5a2.5 2.5 0 0 1-2.5 2.5H9.5l4 4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
  receipt: '<path d="M6 3.5h12v17l-2.5-1.5-2.5 1.5-2.5-1.5L8 20.5 6 20.5Z"/><path d="M9.5 8.5h5"/><path d="M9.5 12h5"/>',
  chart: '<path d="M4.5 20V11"/><path d="M10 20V4.5"/><path d="M15.5 20v-6"/><path d="M20.5 20V8"/>'
};

/* ---------- expenses ---------- */

const EXPENSE_CATS = [
  "Electricity", "Water", "Staff salary", "Groceries",
  "Maintenance", "Internet", "Gas", "Rent to owner", "Other"
];

/* yyyy-mm for the month we are in, to match against an expense date. */
function monthKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function expenseSummary() {
  const list = PGStore.state().expenses || [];
  const mk = monthKey();
  const month = list.filter((x) => String(x.date).slice(0, 7) === mk);
  const byCat = {};
  month.forEach((x) => { byCat[x.category] = (byCat[x.category] || 0) + x.amount; });
  const top = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a])[0] || "";
  return {
    list,
    month,
    monthTotal: month.reduce((s, x) => s + x.amount, 0),
    allTotal: list.reduce((s, x) => s + x.amount, 0),
    byCat,
    top,
    topAmount: top ? byCat[top] : 0
  };
}

/* money() has no sign handling, so negatives are built by hand. */
function signedMoney(n) {
  return (n < 0 ? "\u2212" : "") + money(Math.abs(n));
}

function statCard(s) {
  return `
    <div class="stat">
      <div class="stat-top">
        <span class="stat-label">${s.label}</span>
        <span class="stat-ico ico-${s.tone}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[s.icon]}</svg>
        </span>
      </div>
      <div class="stat-value">${s.value}</div>
      <div class="stat-note ${s.cls || ""}">${s.note}</div>
    </div>`;
}

function emptyState(title, note, action) {
  return `
    <div class="empty">
      <span class="empty-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS.bed}</svg>
      </span>
      <b>${title}</b>
      <p>${note}</p>
      ${action || ""}
    </div>`;
}

