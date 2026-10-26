/* ---------- backfill payment history ---------- */

let backfillRef = null;

function monthsBetweenJS(from, to) {
  const out = [];
  const a = new Date(from + "-01");
  const b = new Date(to + "-01");
  if (isNaN(a) || isNaN(b)) { return out; }
  let y = a.getFullYear(), m = a.getMonth();
  const ey = b.getFullYear(), em = b.getMonth();
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard++ < 600) {
    out.push(y + "-" + String(m + 1).padStart(2, "0"));
    m++; if (m > 11) { m = 0; y++; }
  }
  return out;
}

function monthLabelJS(key) {
  const [y, mo] = key.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

function openBackfillDialog(roomId, bedIndex) {
  const rooms = PGStore.state().rooms;
  const room = rooms.find((r) => r.id === roomId);
  if (!room) { return; }
  const bed = room.beds[bedIndex];
  if (!bed) { return; }

  backfillRef = { roomId, bedIndex };

  /* Collection day: use bed.collect if set, else derive from joining date. */
  const joinedDay = bed.joined ? parseInt(bed.joined.split("-")[2], 10) : null;
  const defaultCollect = bed.collect || joinedDay || 1;

  el("bf-collect").value = bed.collect || "";
  el("bf-collect").placeholder = "e.g. " + defaultCollect + " (auto-detected from joining date)";
  el("bf-who").textContent = bed.name + " · Room " + room.no + " · Joined " + (bed.joined || "unknown");

  /* Build month list from joining month → current month. */
  const fromKey = bed.joined ? bed.joined.slice(0, 7) : new Date().toISOString().slice(0, 7);
  const toKey = new Date().toISOString().slice(0, 7);
  const months = monthsBetweenJS(fromKey, toKey);
  const alreadyPaid = new Set(bed.paidMonths || []);

  el("bf-months").innerHTML = months.map((mk) => {
    const paid = alreadyPaid.has(mk);
    const id = "bf-m-" + mk;
    return `<div class="bf-month-item">
      <input type="checkbox" id="${id}" name="bf-month" value="${mk}" ${!paid ? "checked" : ""} ${paid ? "" : ""} />
      <label for="${id}">${monthLabelJS(mk)}</label>
      ${paid ? '<span class="bf-already">✓ paid</span>' : ""}
    </div>`;
  }).join("") || "<p style='font-size:13px;color:var(--muted)'>No past months to backfill.</p>";

  el("bf-err").hidden = true;
  openDlg("dlg-backfill");
}


/* A PG with floors switched off should never be asked for one. */
function applyFloorSetting() {
  const field = el("r-floor-field");
  if (field) { field.hidden = PGStore.state().settings.floors === false; }
}

/* ---------- owner quick actions, deposits, rules, data management ---------- */

function renderOwnerActions() {
  const t = totals();
  const list = tenants();
  const unpaid = list.filter((x) => !x.paid);
  const paid = list.filter((x) => x.paid);
  const allPaid = list.length > 0 && unpaid.length === 0;
  const noTenants = list.length === 0;

  el("owner-actions").innerHTML = `
    <div class="oa-grid">
      <button class="oa-card" type="button" data-act="bulk-mark-paid" ${allPaid ? 'disabled title="All tenants already paid"' : noTenants ? 'disabled title="No tenants to mark"' : ''}>
        <span class="oa-icon oa-green">\u2713</span>
        <span class="oa-text"><b>Mark all rent paid</b><span>${allPaid ? 'All tenants are already paid for this month' : noTenants ? 'Add tenants first' : 'Mark every tenant as paid for this month'}</span></span>
      </button>
      <button class="oa-card" type="button" data-act="bulk-whatsapp" ${!unpaid.length ? 'disabled title="No unpaid tenants"' : ''}>
        <span class="oa-icon oa-blue">\ud83d\udcac</span>
        <span class="oa-text"><b>Broadcast WhatsApp</b><span>${unpaid.length ? 'Send rent reminder to ' + unpaid.length + ' unpaid tenant' + (unpaid.length !== 1 ? 's' : '') : 'All tenants have paid'}</span></span>
      </button>
      <button class="oa-card" type="button" data-act="export-all">
        <span class="oa-icon oa-amber">\u2b07</span>
        <span class="oa-text"><b>Export all data</b><span>Download complete backup as JSON file</span></span>
      </button>
      <button class="oa-card" type="button" data-act="send-receipt-all" ${!t.collected ? 'disabled title="No rent collected yet"' : ''}>
        <span class="oa-icon oa-purple">\ud83d\udcc4</span>
        <span class="oa-text"><b>Send receipts</b><span>${t.collected ? 'Send receipts to ' + paid.length + ' paid tenant' + (paid.length !== 1 ? 's' : '') : 'No rent collected this month'}</span></span>
      </button>
    </div>`;
}

function renderDeposits() {
  const list = tenants();
  const withDeposit = list.filter((t) => t.deposit > 0);
  const totalDeposits = withDeposit.reduce((s, t) => s + t.deposit, 0);

  el("deposit-summary").textContent = withDeposit.length
    ? money(totalDeposits) + " from " + withDeposit.length + " tenant" + (withDeposit.length !== 1 ? "s" : "")
    : "No deposits recorded";

  if (!withDeposit.length) {
    el("deposit-list").innerHTML = '<p class="feed-blank">No security deposits recorded. Deposits are saved when you add or edit a tenant.</p>';
    return;
  }

  el("deposit-list").innerHTML = '<ul class="paylist">' + withDeposit.map((t) => `
    <li>
      <span class="pay-left">
        <span class="av">${esc(initials(t.name))}</span>
        <span class="pay-name">${esc(t.name)}<span>Room ${esc(t.roomNo)} \u00b7 Bed ${t.bed}</span></span>
      </span>
      <span class="pay-right">
        <span class="amount">${money(t.deposit)}</span>
        <span class="badge badge-paid">Held</span>
      </span>
    </li>`).join('') + '</ul>' + `
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:13px">
      <span style="color:var(--muted)">Total deposits held</span>
      <span style="font-weight:700;color:var(--green)">${money(totalDeposits)}</span>
    </div>`;
}

function renderRules() {
  const s = PGStore.state();
  const rules = s.rules || {};
  const items = [];
  if (rules.visiting) { items.push({ label: "Visiting hours", value: rules.visiting }); }
  if (rules.quiet) { items.push({ label: "Quiet hours", value: rules.quiet }); }
  if (rules.guests) { items.push({ label: "Guest policy", value: rules.guests }); }
  if (rules.lockout) { items.push({ label: "Lockout time", value: rules.lockout }); }
  if (rules.other) { items.push({ label: "Other rules", value: rules.other }); }

  /* Update accordion summary */
  var rulesSummary = el("rules-summary");
  if (rulesSummary) {
    rulesSummary.textContent = items.length ? items.length + " rule" + (items.length !== 1 ? "s" : "") + " set" : "Not configured";
  }

  if (!items.length) {
    el("rules-display").innerHTML = '<p class="feed-blank">No rules set yet. Click "Edit rules" to add house rules for your PG.</p>';
    return;
  }

  el("rules-display").innerHTML = items.map((r) => `
    <div class="rules-item">
      <b>${esc(r.label)}</b>
      <span>${esc(r.value)}</span>
    </div>`).join("");
}

function renderDataActions() {
  const t = totals();
  const list = tenants();
  const s = PGStore.state();
  const totalExpenses = (s.expenses || []).reduce((sum, e) => sum + e.amount, 0);
  const totalDeposits = list.filter((t) => t.deposit > 0).reduce((sum, t) => sum + t.deposit, 0);
  const dataSizeKB = Math.round(JSON.stringify(s).length / 1024);
  const hasData = t.rooms > 0 || t.occupied > 0 || (s.expenses || []).length > 0;
  const hasExpenses = (s.expenses || []).length > 0;
  const hasRooms = t.rooms > 0;

  /* Update accordion summary */
  var dataSummary = el("data-summary");
  if (dataSummary) {
    dataSummary.textContent = dataSizeKB + " KB · " + t.rooms + " rooms · " + t.occupied + " tenants";
  }

  el("data-actions").innerHTML = `
    <div class="oa-grid">
      <div class="data-stat-card">
        <b>Data summary</b>
        <div class="data-stat-row"><span>Rooms</span><span>${t.rooms}</span></div>
        <div class="data-stat-row"><span>Tenants</span><span>${t.occupied}</span></div>
        <div class="data-stat-row"><span>Expenses</span><span>${(s.expenses || []).length} entries</span></div>
        <div class="data-stat-row"><span>Total collected</span><span>${money(t.collected)}</span></div>
        <div class="data-stat-row"><span>Total expenses</span><span>${money(totalExpenses)}</span></div>
        <div class="data-stat-row"><span>Deposits held</span><span>${money(totalDeposits)}</span></div>
        <div class="data-stat-row"><span>Data size</span><span>${dataSizeKB} KB</span></div>
      </div>
      <div class="data-btn-col">
        <button class="oa-card" type="button" data-act="download-backup" ${!hasData ? 'disabled title="No data to back up"' : ''}>
          <span class="oa-icon oa-green">\u2b07</span>
          <span class="oa-text"><b>Download backup</b><span>${hasData ? 'Save all your data as a JSON file' : 'Add rooms or tenants first'}</span></span>
        </button>
        <button class="oa-card" type="button" data-act="import-backup">
          <span class="oa-icon oa-blue">\u2b06</span>
          <span class="oa-text"><b>Restore from backup</b><span>Import a previously saved JSON backup</span></span>
        </button>
        <button class="oa-card oa-danger" type="button" data-act="reset-all" ${!hasData ? 'disabled title="Nothing to reset"' : ''}>
          <span class="oa-icon oa-red">\u2716</span>
          <span class="oa-text"><b>Reset all data</b><span>${hasData ? 'Clear everything and start fresh (cannot be undone)' : 'No data to clear'}</span></span>
        </button>
      </div>
    </div>`;
}

function openRulesDialog() {
  const rules = PGStore.state().rules || {};
  el("ru-visit").value = rules.visiting || "";
  el("ru-quiet").value = rules.quiet || "";
  el("ru-guest").value = rules.guests || "";
  el("ru-lock").value = rules.lockout || "";
  el("ru-other").value = rules.other || "";
  openDlg("dlg-rules");
}

function downloadJsonBackup() {
  const s = PGStore.state();
  const blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "pg-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  URL.revokeObjectURL(url);
  toast("Backup downloaded!", "success");
}

async function importJsonBackup() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = function (e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function (ev) {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data || !data.rooms) { toast("This does not look like a valid PG Manager backup.", "error"); return; }
        var ok = await confirmAsync({ type: 'danger', title: 'Restore backup?', message: 'This will replace ALL current data with the backup. Continue?', okText: 'Restore', icon: '⚠' });
        if (!ok) return;
        PGStore.replaceAll(data);
        commit();
        toast("Backup restored successfully!", "success");
      } catch (err) {
        toast("Could not read the backup file: " + err.message, "error");
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function exportAllCsv() {
  exportTenantsCsv();
  setTimeout(exportLedgerCsv, 500);
  setTimeout(exportExpensesCsv, 1000);
  toast("Exporting all data as CSV…", "info");
}

async function broadcastWhatsAppReminders() {
  const list = tenants();
  const unpaid = list.filter((t) => !t.paid && t.phone);
  if (!unpaid.length) { toast("No unpaid tenants with phone numbers.", "info"); return; }
  const count = unpaid.length;
  var ok = await confirmAsync({ type: 'info', title: 'Send reminders?', message: 'Send WhatsApp rent reminders to ' + count + ' unpaid tenant' + (count !== 1 ? 's' : '') + '. Continue?', okText: 'Send', icon: '💬' });
  if (!ok) return;
  unpaid.forEach((t, i) => {
    setTimeout(function () { sendWhatsAppReminder(t.roomId, t.bedIndex); }, i * 1000);
  });
  toast('Sending reminders to ' + count + ' tenant' + (count !== 1 ? 's' : '') + '…', 'info');
}

async function sendReceiptsToAllPaid() {
  const list = tenants();
  const paid = list.filter((t) => t.paid && t.phone);
  if (!paid.length) { toast("No paid tenants with phone numbers.", "info"); return; }
  const count = paid.length;
  var ok = await confirmAsync({ type: 'info', title: 'Send receipts?', message: 'Send WhatsApp receipts to ' + count + ' paid tenant' + (count !== 1 ? 's' : '') + '. Continue?', okText: 'Send', icon: '📄' });
  if (!ok) return;
  paid.forEach((t, i) => {
    setTimeout(function () { sendWhatsAppReminder(t.roomId, t.bedIndex); }, i * 1000);
  });
  toast('Sending receipts to ' + count + ' tenant' + (count !== 1 ? 's' : '') + '…', 'info');
}

async function bulkMarkAllPaid() {
  const list = tenants();
  const unpaid = list.filter((t) => !t.paid);
  if (!unpaid.length) { toast("All tenants are already marked as paid!", "info"); return; }
  var ok = await confirmAsync({ type: 'success', title: 'Mark all paid?', message: 'Mark ' + unpaid.length + ' tenant' + (unpaid.length !== 1 ? 's' : '') + ' as paid for this month?', okText: 'Mark paid', icon: '✓' });
  if (!ok) return;
  var payDate = new Date().toISOString().slice(0, 10);
  unpaid.forEach((t) => {
    PGStore.setPaid(t.roomId, t.bedIndex, true, payDate, '');
  });
  commit();
  toast("Marked " + unpaid.length + " tenant" + (unpaid.length !== 1 ? "s" : "") + " as paid.", "success");
}

async function resetAllData() {
  var ok1 = await confirmAsync({ type: 'danger', title: 'Delete all data?', message: 'This will DELETE ALL your rooms, tenants, expenses, and settings. This cannot be undone!', okText: 'Delete everything', icon: '⚠' });
  if (!ok1) return;
  var ok2 = await confirmAsync({ type: 'danger', title: 'Are you absolutely sure?', message: 'Last chance — all your data will be permanently deleted.', okText: 'Yes, delete it all', icon: '🗑' });
  if (!ok2) return;
  PGStore.replaceAll({ property: "", rooms: [], activity: [], expenses: [], rates: [], complaints: [], rules: {}, owner: { name: "", phone: "", address: "", upiId: "", pgStartDate: "" }, settings: { floors: true, bedStyle: "alpha", bedNumbering: "restart" }, cycle: "" });
  commit();
  toast("All data has been cleared.", "success");
}

