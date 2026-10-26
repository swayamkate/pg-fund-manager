/* ---------- dialogs ---------- */

function openDlg(id) {
  const d = el(id);
  const err = d.querySelector(".auth-error");
  if (err) { err.hidden = true; }
  if (d.showModal) { d.showModal(); } else { d.setAttribute("open", ""); }
  const first = d.querySelector("input, select");
  if (first) { setTimeout(() => first.focus(), 30); }
}

function closeDlg(id) {
  const d = el(id);
  if (d.close) { d.close(); } else { d.removeAttribute("open"); }
}

function showErr(id, message) {
  const p = el(id);
  p.textContent = message;
  p.hidden = false;
}

/* Fill the bed picker with every vacant bed, optionally preselecting one. */
function fillBedPicker(roomId, bedIndex) {
  const picker = el("t-bed");
  const free = PGStore.vacantBeds();

  picker.innerHTML = free.map((b) =>
    `<option value="${esc(b.roomId)}|${b.bedIndex}">Room ${esc(b.roomNo)} · Bed ${b.bed} — ${money(b.rent)}</option>`
  ).join("");

  if (roomId != null) { picker.value = roomId + "|" + bedIndex; }
  return free.length;
}

function openTenantDialog(roomId, bedIndex) {
  if (!PGStore.vacantBeds().length) {
    toast(PGStore.isEmpty()
      ? "Add a room first, then you can move tenants in."
      : "Every bed is taken. Add another room to make space.", "warn");
    return;
  }
  fillBedPicker(roomId, bedIndex);
  el("t-joined").value = new Date().toISOString().slice(0, 10);
  if (el("t-rent")) { el("t-rent").value = ""; }
  openDlg("dlg-tenant");
}

function openExpenseDialog(expenseId) {
  const expense = expenseId ? (PGStore.state().expenses || []).find((x) => x.id === expenseId) : null;
  if (expenseId && !expense) { toast("That expense is gone already.", "warn"); return; }
  const form = el("form-expense");
  form.reset();
  form.dataset.expenseId = expense ? expense.id : "";
  const categories = EXPENSE_CATS.slice();
  if (expense && !categories.includes(expense.category)) { categories.push(expense.category); }
  const sel = el("x-cat");
  sel.innerHTML = categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  if (expense) { sel.value = expense.category; }
  el("x-amt").value = expense ? expense.amount : "";
  el("x-date").value = expense ? expense.date : new Date().toISOString().slice(0, 10);
  el("x-note").value = expense ? expense.note || "" : "";
  el("x-title").textContent = expense ? "Edit expense" : "Add an expense";
  el("x-submit").textContent = expense ? "Save changes" : "Add expense";
  openDlg("dlg-expense");
}

/* ---------- early termination & offboarding ---------- */

let offboardingRef = null;

function updateOffboardCalculation() {
  if (!offboardingRef) { return; }
  const exitDate = el("ob-date").value;
  const deposit = el("ob-deposit").value;
  const charges = el("ob-charges").value;

  const s = PGStore.calculateExitSettlement(offboardingRef.roomId, offboardingRef.bedIndex, exitDate, {
    deposit: deposit,
    charges: charges
  });

  if (!s) { return; }

  const netCls = s.isRefund ? "ob-net-refund" : "ob-net-due";
  const netLabel = s.isRefund ? "Refund to tenant on exit:" : "Balance to collect from tenant:";

  el("ob-calc-card").innerHTML = `
    <div class="ob-calc-grid">
      <div class="ob-cell">
        <b>Monthly Rent Rate</b>
        <span>${money(s.monthlyRent)} ${s.hasCustomRent ? '<span class="tag-custom">custom</span>' : '<span class="muted-sm">(room default)</span>'}</span>
      </div>
      <div class="ob-cell">
        <b>Daily Pro-rated Rate</b>
        <span>${money(s.dailyRate)} / day (${s.daysInMonth} days in ${esc(s.exitMonthLabel)})</span>
      </div>
      <div class="ob-cell">
        <b>Stayed in ${esc(s.exitMonthLabel)}</b>
        <span>${s.daysOccupied} of ${s.daysInMonth} days &rarr; <b>${money(s.proRatedRent)}</b></span>
      </div>
      <div class="ob-cell">
        <b>${esc(s.exitMonthLabel)} Rent Status</b>
        <span>${s.isExitMonthPaid ? '<span class="badge badge-paid">Paid in full</span> &rarr; ' + money(s.exitMonthRefundCredit) + ' refund credit' : '<span class="badge badge-due">Unpaid</span> &rarr; ' + money(s.exitMonthUnpaidLiability) + ' liability'}</span>
      </div>
      ${s.priorDues > 0 ? `
        <div class="ob-cell span-2">
          <b>Prior Unpaid Months (${s.priorMonthsCount})</b>
          <span style="color:var(--red);font-weight:600">${money(s.priorDues)} (${s.priorMonths.map(esc).join(", ")})</span>
        </div>` : ""}
      ${s.deposit > 0 ? `
        <div class="ob-cell">
          <b>Security Deposit Credit</b>
          <span style="color:var(--green);font-weight:600">&minus; ${money(s.deposit)}</span>
        </div>` : ""}
      ${s.charges > 0 ? `
        <div class="ob-cell">
          <b>Extra Charges / Damages</b>
          <span style="color:var(--red);font-weight:600">+ ${money(s.charges)}</span>
        </div>` : ""}
    </div>
    <div class="ob-net-banner ${netCls}">
      <span>${netLabel}</span>
      <strong>${money(Math.abs(s.netBalance))}</strong>
    </div>`;
}

function openOffboardDialog(roomId, bedIndex) {
  const room = PGStore.state().rooms.find((r) => r.id === roomId);
  const bed = room && room.beds[bedIndex];
  if (!bed) { return; }

  offboardingRef = { roomId, bedIndex };
  el("ob-who").textContent = `${bed.name} · Room ${room.no} · Bed ${PGStore.bedLabel(bedIndex, roomId)}`;
  el("ob-date").value = new Date().toISOString().slice(0, 10);
  el("ob-deposit").value = "0";
  el("ob-charges").value = "0";
  el("ob-note").value = "";
  el("ob-err").hidden = true;

  updateOffboardCalculation();
  openDlg("dlg-offboard");
}

window.openOffboardDialog = openOffboardDialog;

["input", "change"].forEach((evt) => {
  ["ob-date", "ob-deposit", "ob-charges"].forEach((id) => {
    const node = el(id);
    if (node) { node.addEventListener(evt, updateOffboardCalculation); }
  });
});

el("form-offboard").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!offboardingRef) { return; }

  const s = PGStore.calculateExitSettlement(offboardingRef.roomId, offboardingRef.bedIndex, el("ob-date").value, {
    deposit: el("ob-deposit").value,
    charges: el("ob-charges").value
  });

  const res = PGStore.checkoutTenantWithSettlement(offboardingRef.roomId, offboardingRef.bedIndex, s);
  if (!res.ok) { showErr("ob-err", res.error); return; }

  closeDlg("dlg-offboard");
  offboardingRef = null;
  toast("Tenant checked out & settled!", "success");
  commit();
});

/* ---------- receipt & whatsapp ---------- */

let receiptRef = null;

function openReceiptDialog(roomId, bedIndex, period) {
  const rooms = PGStore.state().rooms;
  const room = rooms.find((r) => r.id === roomId);
  if (!room) { return; }
  const bed = room.beds[bedIndex];
  if (!bed) { return; }

  period = /^\d{4}-(0[1-9]|1[0-2])$/.test(period || "") ? period : monthKey();
  receiptRef = { roomId, bedIndex, period };
  const owner = PGStore.state().owner || {};
  const rent = PGStore.monthRent(room, bed, period);
  const paymentInfo = (bed.paymentInfo && bed.paymentInfo[period]) || {};
  const now = new Date();
  const monthLabel = PGStore.monthLabel(period);
  const receiptNo = "RCP-" + period.replace("-", "") + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  const isPaid = (bed.paidMonths || []).includes(period);

  el("receipt-paper").innerHTML = `
    <div class="receipt-brand">
      <div>
        <h2>${esc(owner.name || "PG Manager")}</h2>
        <p>${esc(owner.address || "")}</p>
      </div>
      <span class="receipt-tag">${isPaid ? "PAID" : "PENDING"}</span>
    </div>
    <div class="receipt-grid">
      <div class="receipt-cell"><b>Receipt No.</b><span>${receiptNo}</span></div>
      <div class="receipt-cell"><b>Payment date</b><span>${prettyDate(paymentInfo.date)}</span></div>
      <div class="receipt-cell"><b>Tenant</b><span>${esc(bed.name)}</span></div>
      <div class="receipt-cell"><b>Room / Bed</b><span>Room ${esc(room.no)} · Bed ${PGStore.bedLabel(bedIndex, roomId)}</span></div>
      <div class="receipt-cell"><b>Period</b><span>${monthLabel}</span></div>
      <div class="receipt-cell"><b>Status</b><span>${isPaid ? "✅ Paid" : "⏳ Due"}</span></div>
      <div class="receipt-cell"><b>Transaction reference</b><span>${esc(paymentInfo.utr || "—")}</span></div>
    </div>
    <div class="receipt-amount-box">
      <span>Rent for ${monthLabel}</span>
      <strong>${money(rent)}</strong>
    </div>
    ${owner.upiId ? `<p style="font-size:12px;text-align:center;margin-bottom:12px;color:#6b7280">Pay via UPI: <b>${esc(owner.upiId)}</b></p>` : ""}
    <div class="receipt-foot">This is a computer-generated receipt. · ${esc(owner.name || "PG Manager")}</div>`;

  openDlg("dlg-receipt");
}

function sendWhatsAppReminder(roomId, bedIndex, period, shareReceipt) {
  const rooms = PGStore.state().rooms;
  const room = rooms.find((r) => r.id === roomId);
  if (!room) { return; }
  const bed = room.beds[bedIndex];
  if (!bed || !bed.phone) {
    toast("No phone number saved for this tenant. Add one in their profile first.", "warn");
    return;
  }
  const owner = PGStore.state().owner || {};
  period = /^\d{4}-(0[1-9]|1[0-2])$/.test(period || "") ? period : monthKey();
  const rent = PGStore.monthRent(room, bed, period);
  const month = PGStore.monthLabel(period);
  const paid = (bed.paidMonths || []).includes(period);
  const info = (bed.paymentInfo && bed.paymentInfo[period]) || {};
  const upiLine = owner.upiId ? `\n💳 UPI: ${owner.upiId}` : "";
  const msg = shareReceipt && paid
    ? `Hi ${bed.name.split(" ")[0]}, your rent of ${money(rent)} for ${month} is marked paid.${info.date ? "\nPayment date: " + info.date : ""}${info.utr ? "\nReference: " + info.utr : ""}\n\n— ${owner.name || "Your PG Owner"}`
    : `Hi ${bed.name.split(" ")[0]}, this is a friendly reminder that your rent of ${money(rent)} for ${month} is due.${upiLine}\n\n— ${owner.name || "Your PG Owner"}`;
  const phone = bed.phone.replace(/\D/g, "");
  window.open("https://wa.me/" + phone + "?text=" + encodeURIComponent(msg), "_blank");
}

/* ---------- transfer form ---------- */

el("form-transfer").addEventListener("submit", (e) => {
  e.preventDefault();
  const dest = el("tr-dest").value.split("|");
  const fromRoom = el("tr-dest").dataset.fromRoom;
  const fromBed = Number(el("tr-dest").dataset.fromBed);
  const res = PGStore.transferTenant(fromRoom, fromBed, dest[0], Number(dest[1]));
  if (!res.ok) { showErr("tr-err", res.error); return; }
  closeDlg("dlg-transfer");
  toast("Tenant transferred!", "success");
  commit();
});

/* ---------- complaint forms ---------- */

el("form-complaint").addEventListener("submit", (e) => {
  e.preventDefault();
  const roomSel = el("co-room").value;
  const roomData = PGStore.state().rooms.find((r) => r.id === roomSel);
  const res = PGStore.addComplaint({
    title: el("co-title").value,
    roomId: roomSel || "",
    roomNo: roomData ? roomData.no : "",
    category: el("co-cat").value,
    priority: el("co-priority").value,
    date: el("co-date").value,
    note: el("co-note").value,
    status: "open",
    cost: 0
  });
  if (!res.ok) { showErr("co-err", res.error); return; }
  closeDlg("dlg-complaint");
  toast("Issue logged!", "success");
  commit();
});

el("form-resolve-complaint").addEventListener("submit", (e) => {
  e.preventDefault();
  var id = el("form-resolve-complaint").dataset.compId;
  if (!id) return;
  var existing = PGStore.complaints().find((c) => c.id === id);
  var roomId = el("rco-room").value;
  var roomData = PGStore.state().rooms.find((r) => r.id === roomId);
  var syncExp = el("rco-sync-exp").checked;
  var res = PGStore.updateComplaint(id, {
    title: el("rco-name").value,
    roomId: roomId,
    roomNo: roomData ? roomData.no : (existing && roomId === existing.roomId ? existing.roomNo : ""),
    category: el("rco-cat").value,
    priority: el("rco-priority").value,
    note: el("rco-note").value,
    date: el("rco-date").value,
    resolvedAt: el("rco-resolved").value,
    status: el("rco-status").value,
    cost: Number(el("rco-cost").value) || 0,
    syncExpense: syncExp
  });
  if (!res.ok) { showErr("rco-err", res.error); return; }
  closeDlg("dlg-resolve-complaint");
  toast("Issue updated!", "success");
  commit();
});

/* ---------- CSV exporters ---------- */

function csvDownload(filename, rows) {
  const csv = "\uFEFF" + rows.map((r) => r.map((c) => '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"').join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  a.download = filename;
  a.click();
}

function exportTenantsCsv() {
  const list = tenants();
  const rows = [["Name", "Phone", "Room", "Bed", "Rent", "Deposit", "Joined", "Leaving", "Status", "ID Type", "ID No.", "Emergency", "Workplace", "Note"]];
  list.forEach((t) => rows.push([t.name, t.phone, t.roomNo, t.bed, t.rent, t.deposit, t.joined, t.leaving || "", t.status, t.idType, t.idNumber, t.emergencyContact, t.workplace, t.note]));
  csvDownload("tenants-" + new Date().toISOString().slice(0, 10) + ".csv", rows);
  toast("Tenants exported!", "success");
}

function exportLedgerCsv() {
  const rows = [["Tenant", "Room", "Bed", "Month", "Paid", "Rent amount", "Payment date", "Transaction reference"]];
  PGStore.state().rooms.forEach((room) => {
    room.beds.forEach((bed, i) => {
      if (!bed) { return; }
      const label = PGStore.bedLabel(i, room.id);
      PGStore.ledger(room.id, i).forEach((m) => {
        rows.push([bed.name, room.no, label, m.month, m.paid ? "Yes" : "No", m.rent, m.paymentDate || "", m.utr || ""]);
      });
    });
  });
  csvDownload("ledger-" + new Date().toISOString().slice(0, 10) + ".csv", rows);
  toast("Ledger exported!", "success");
}

function exportExpensesCsv() {
  const rows = [["Date", "Category", "Amount", "Note"]];
  PGStore.state().expenses.forEach((x) => rows.push([x.date, x.category, x.amount, x.note || ""]));
  csvDownload("expenses-" + new Date().toISOString().slice(0, 10) + ".csv", rows);
  toast("Expenses exported!", "success");
}

