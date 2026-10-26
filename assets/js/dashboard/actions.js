/* ---------- actions ---------- */

/* ---------- dropdown menus ---------- */
/* Portal: move dd-menu to body to escape overflow containers */
function ddPortalOpen(menu, trigger) {
  if (!menu._ported) {
    menu._originalParent = menu.parentNode;
    document.body.appendChild(menu);
    menu._ported = true;
  }
  /* Ensure a backdrop exists */
  let bd = document.getElementById("dd-backdrop");
  if (!bd) {
    bd = document.createElement("div");
    bd.id = "dd-backdrop";
    bd.style.cssText = "position:fixed;inset:0;z-index:999;background:transparent;";
    bd.addEventListener("click", ddCloseAll);
    bd.addEventListener("touchstart", ddCloseAll, { passive: true });
    document.body.appendChild(bd);
  }
  bd.hidden = false;
}
function ddCloseAll() {
  document.querySelectorAll(".dd-menu:not([hidden])").forEach((m) => {
    m.hidden = true;
    /* Return to original position */
    if (m._ported && m._originalParent) {
      m._originalParent.appendChild(m);
      m._ported = false;
    }
    m.style.cssText = "";
  });
  document.querySelectorAll("[aria-expanded]").forEach((b) => { b.setAttribute("aria-expanded", "false"); });
  const bd = document.getElementById("dd-backdrop");
  if (bd) bd.hidden = true;
}
document.addEventListener("click", (e) => {
  /* Toggle dropdown on trigger click */
  const trigger = e.target.closest("[data-dd]");
  if (trigger) {
    e.stopPropagation();
    const menu = el(trigger.dataset.dd);
    const open = menu.hidden;
    /* Close all other open menus first */
    ddCloseAll();
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) {
      ddPortalOpen(menu, trigger);
      /* Position the fixed menu relative to the trigger button */
      const rect = trigger.getBoundingClientRect();
      const menuW = 180;
      let left = rect.right - menuW;
      let top = rect.bottom + 4;
      if (left < 8) left = 8;
      if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
      if (top + 220 > window.innerHeight) { top = rect.top - 4; menu.style.transform = 'translateY(-100%)'; }
      else { menu.style.transform = 'none'; }
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
      menu.style.right = 'auto';
    }
    return;
  }
  /* Close any open menu when clicking elsewhere */
  if (!e.target.closest(".dd-menu")) {
    ddCloseAll();
  }

  const btn = e.target.closest("[data-act]");
  if (!btn) { return; }
  /* Ignore clicks on disabled buttons */
  if (btn.disabled) { return; }
  /* Close the parent dropdown if this action came from one */
  const parentMenu = btn.closest(".dd-menu");
  if (parentMenu) { parentMenu.hidden = true; }

  const act = btn.dataset.act;
  const roomId = btn.dataset.room;
  const bedIndex = btn.dataset.bed;

  if (act === "rent-current") {
    selectedRentMonth = monthKey();
    renderRent();
  } else if (act === "add-room") {
    el("form-room").reset();
    openDlg("dlg-room");
  } else if (act === "add-tenant") {
    el("form-tenant").reset();
    openTenantDialog(null, null);
  } else if (act === "fill-bed") {
    el("form-tenant").reset();
    openTenantDialog(roomId, bedIndex);
  } else if (act === "name-property") {
    el("p-name").value = PGStore.state().property;
    openDlg("dlg-property");
  } else if (act === "del-room") {
    confirmAsync({ type: 'danger', title: 'Remove room?', message: 'Remove this room? Any tenants in it are removed too.', okText: 'Remove', icon: '🗑' }).then(function (ok) {
      if (ok) { PGStore.removeRoom(roomId); commit(); }
    });
  } else if (act === "edit-room") {
    openEditRoomDialog(roomId);
  } else if (act === "notice") {
    PGStore.toggleNotice(roomId, Number(bedIndex));
    commit();
    toast('Notice period toggled', 'info');
  } else if (act === "checkout") {
    openOffboardDialog(roomId, Number(bedIndex));
  } else if (act === "pay") {
    var isPaid = btn.dataset.paid === "1";
    PGStore.setPaid(roomId, Number(bedIndex), isPaid);
    commit();
    toast(isPaid ? 'Marked as paid ✓' : 'Payment undone', 'success');
  } else if (act === "add-expense") {
    openExpenseDialog();
  } else if (act === "edit-expense") {
    openExpenseDialog(btn.dataset.exp);
  } else if (act === "del-expense") {
    confirmAsync({ type: 'danger', title: 'Remove expense?', message: 'Remove this expense?', okText: 'Remove', icon: '🗑' }).then(function (ok) {
      if (ok) { PGStore.removeExpense(btn.dataset.exp); commit(); }
    });
  } else if (act === "backup-restore") {
    confirmAsync({ type: 'info', title: 'Restore from sheet?', message: 'Replace everything on this account with the last backup from the sheet?', okText: 'Restore', icon: '📥' }).then(function (ok) {
      if (!ok) return;
      PGSheets.restore().then((data) => {
        PGStore.replaceAll(data);
        renderAll();
        toast('Restored from Google Sheets', 'success');
      }, (err) => {
        toast(err && err.message ? err.message : "Could not restore from the sheet.", "error");
      });
    });
  } else if (act === "whatsapp-bulk") {
    var s = PGStore.state();
    var tenantsWithPhone = [];
    (s.rooms || []).forEach(function (room) {
      (room.beds || []).forEach(function (bed) {
        if (bed && bed.phone) {
          tenantsWithPhone.push({ name: bed.name, phone: bed.phone, rent: bed.rent || room.rent, room: room.no });
        }
      });
    });
    if (!tenantsWithPhone.length) {
      toast("No tenants with phone numbers found", "error");
    } else {
      var msg = "Send rent reminders to " + tenantsWithPhone.length + " tenants via WhatsApp?";
      confirmAsync({ type: 'info', title: 'WhatsApp Reminders', message: msg, okText: 'Send All', icon: '📱' }).then(function (ok) {
        if (!ok) return;
        tenantsWithPhone.forEach(function (t, i) {
          setTimeout(function () {
            PGAnalytics.sendWhatsAppReminder(t.phone, t.name, t.rent, t.room);
          }, i * 800);
        });
        toast("Opening WhatsApp for " + tenantsWithPhone.length + " tenants", "success");
      });
    }
  } else if (act === "set-rents") {
    openSetRents();
  } else if (act === "rate-card") {
    openRateCard();
  } else if (act === "view-payment-history") {
    location.hash = "#rent";
    global.setTimeout(function () { global.PGAnalytics && global.PGAnalytics.renderPaymentHistory && global.PGAnalytics.renderPaymentHistory(); }, 100);
  } else if (act === "add-rate") {
    openRateDialog();
  } else if (act === "edit-rate") {
    openRateDialog(btn.dataset.rate);
  } else if (act === "del-rate") {
    PGStore.removeRate(btn.dataset.rate);
    commit();
  } else if (act === "edit-owner") {
    openOwnerDialog();
  } else if (act === "backfill") {
    openBackfillDialog(roomId, Number(bedIndex));
  } else if (act === "bf-all") {
    el("dlg-backfill").querySelectorAll("input[name=bf-month]").forEach((cb) => { cb.checked = true; });
  } else if (act === "bf-none") {
    el("dlg-backfill").querySelectorAll("input[name=bf-month]").forEach((cb) => { cb.checked = false; });
  } else if (act === "transfer") {
    /* Open the transfer dialog — populate destination picker with vacant beds. */
    const src = tenants().find((t) => t.roomId === roomId && t.bedIndex === Number(bedIndex));
    if (!src) { return; }
    el("tr-who").textContent = src.name + " — currently Room " + src.roomNo + " Bed " + src.bed;
    const vacant = PGStore.vacantBeds();
    if (!vacant.length) { toast("No vacant beds to transfer to.", "info"); return; }
    el("tr-dest").innerHTML = vacant.map((b) =>
      `<option value="${esc(b.roomId)}|${b.bedIndex}">Room ${esc(b.roomNo)} · Bed ${b.bed} — ${money(b.rent)}</option>`
    ).join("");
    el("tr-dest").dataset.fromRoom = roomId;
    el("tr-dest").dataset.fromBed = bedIndex;
    el("tr-err").hidden = true;
    openDlg("dlg-transfer");
  } else if (act === "receipt") {
    openReceiptDialog(roomId, Number(bedIndex), btn.dataset.month);
  } else if (act === "wa-remind") {
    sendWhatsAppReminder(roomId, Number(bedIndex));
  } else if (act === "print-receipt") {
    window.print();
  } else if (act === "share-receipt") {
    if (receiptRef) { sendWhatsAppReminder(receiptRef.roomId, receiptRef.bedIndex, receiptRef.period, true); }
  } else if (act === "add-complaint") {
    el("form-complaint").reset();
    el("co-date").value = new Date().toISOString().slice(0, 10);
    /* Populate room picker. */
    el("co-room").innerHTML = '<option value="">— General / Common area —</option>' +
      PGStore.state().rooms.map((r) => `<option value="${esc(r.id)}">${esc(r.no)}</option>`).join("");
    el("co-err").hidden = true;
    openDlg("dlg-complaint");
  } else if (act === "resolve-complaint") {
    var comp = PGStore.complaints().find((c) => c.id === btn.dataset.comp);
    if (!comp) return;
    el("rco-title").textContent = comp.title;
    el("rco-name").value = comp.title;
    el("rco-room").innerHTML = '<option value="">— General / Common area —</option>' +
      PGStore.state().rooms.map((r) => `<option value="${esc(r.id)}">${esc(r.no)}</option>`).join("");
    if (comp.roomId && !PGStore.state().rooms.some((r) => r.id === comp.roomId)) {
      el("rco-room").insertAdjacentHTML("beforeend", `<option value="${esc(comp.roomId)}">${esc(comp.roomNo || "Previous room")}</option>`);
    }
    el("rco-room").value = comp.roomId || "";
    const categorySelect = el("rco-cat");
    if (!Array.from(categorySelect.options).some((option) => option.value === comp.category)) {
      categorySelect.insertAdjacentHTML("beforeend", `<option value="${esc(comp.category)}">${esc(comp.category)}</option>`);
    }
    categorySelect.value = comp.category;
    el("rco-priority").value = comp.priority;
    el("rco-note").value = comp.note || "";
    el("rco-date").value = comp.date;
    el("rco-resolved").value = comp.resolvedAt || "";
    el("rco-status").value = comp.status;
    el("rco-cost").value = comp.cost || 0;
    el("rco-sync-exp").checked = true;
    el("rco-err").hidden = true;
    /* Store the id for the form submit */
    el("form-resolve-complaint").dataset.compId = comp.id;
    openDlg("dlg-resolve-complaint");
  } else if (act === "del-complaint") {
    confirmAsync({ type: 'danger', title: 'Remove issue?', message: 'Remove this issue?', okText: 'Remove', icon: '🗑' }).then(function (ok) {
      if (ok) { PGStore.removeComplaint(btn.dataset.comp); commit(); }
    });
  } else if (act === "export-tenants") {
    exportTenantsCsv();
  } else if (act === "export-ledger") {
    exportLedgerCsv();
  } else if (act === "export-expenses") {
    exportExpensesCsv();
  } else if (act === "bulk-mark-paid") {
    bulkMarkAllPaid();
  } else if (act === "bulk-whatsapp") {
    broadcastWhatsAppReminders();
  } else if (act === "export-all") {
    exportAllCsv();
  } else if (act === "send-receipt-all") {
    sendReceiptsToAllPaid();
  } else if (act === "download-backup") {
    downloadJsonBackup();
  } else if (act === "import-backup") {
    importJsonBackup();
  } else if (act === "reset-all") {
    resetAllData();
  } else if (act === "edit-rules") {
    openRulesDialog();
  } else if (act === "set-opt") {
    const raw = btn.dataset.val;
    const patch = {};
    patch[btn.dataset.key] = raw === "true" ? true : raw === "false" ? false : raw;
    PGStore.setSettings(patch);
    commit();
  } else if (act === "close") {
    closeDlg(btn.dataset.dlg);
  }
});

el("form-room").addEventListener("submit", (e) => {
  e.preventDefault();
  const res = PGStore.addRoom({
    no: el("r-no").value,
    floor: PGStore.settings().floors === false ? 0 : el("r-floor").value,
    beds: el("r-beds").value,
    rent: el("r-rent").value
  });
  if (!res.ok) { showErr("r-err", res.error); return; }
  closeDlg("dlg-room");
  toast("Room added!", "success");
  commit();
});

