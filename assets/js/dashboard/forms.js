/* ---------- Edit Room dialog ---------- */
let editRoomRef = null;

function openEditRoomDialog(roomId) {
  const s = PGStore.state();
  const room = s.rooms.find(r => r.id === roomId);
  if (!room) return;

  editRoomRef = roomId;
  el("er-id").value = roomId;
  el("er-no").value = room.no;
  el("er-floor").value = room.floor;
  el("er-beds").value = room.beds.length;
  el("er-rent").value = room.rent;
  el("er-err").hidden = true;

  const filled = room.beds.filter(Boolean).length;
  const hint = el("er-beds-hint");
  hint.textContent = `${filled} occupied · ${room.beds.length - filled} vacant`;
  hint.style.display = filled > 0 ? 'block' : 'none';

  /* Show warning if trying to reduce beds below occupied count */
  el("er-beds").addEventListener("input", function () {
    const newCount = Number(this.value) || 0;
    const h = el("er-beds-hint");
    if (newCount < filled) {
      h.textContent = `⚠ Can't go below ${filled} (occupied beds)`;
      h.style.color = 'var(--red)';
    } else {
      h.textContent = `${filled} occupied · ${newCount - filled} vacant`;
      h.style.color = '';
    }
  });

  openDlg("dlg-edit-room");
}

window.openEditRoomDialog = openEditRoomDialog;

el("form-edit-room").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!editRoomRef) return;

  const roomId = editRoomRef;
  const s = PGStore.state();
  const room = s.rooms.find(r => r.id === roomId);
  if (!room) return;

  const newNo = el("er-no").value.trim();
  const newFloor = el("er-floor").value;
  const newRent = el("er-rent").value;
  const newBedCount = Number(el("er-beds").value) || room.beds.length;
  const filled = room.beds.filter(Boolean).length;

  /* Validate bed count */
  if (room.beds.slice(newBedCount).some(Boolean)) {
    showErr("er-err", "Move tenants out of the beds being removed before reducing the bed count.");
    return;
  }
  if (newBedCount < 1) {
    showErr("er-err", "A room needs at least 1 bed.");
    return;
  }
  if (newBedCount > 12) {
    showErr("er-err", "Maximum 12 beds per room.");
    return;
  }

  /* Adjust bed count BEFORE updating room (updateRoom calls save()) */
  const oldBedCount = room.beds.length;
  if (newBedCount > room.beds.length) {
    for (let i = room.beds.length; i < newBedCount; i++) {
      room.beds.push(null);
    }
  } else if (newBedCount < room.beds.length) {
    room.beds.length = newBedCount;
  }

  /* Update room properties (rent, number, floor) */
  const res = PGStore.updateRoom(roomId, {
    no: newNo,
    floor: PGStore.settings().floors === false ? 0 : newFloor,
    rent: newRent
  });
  if (!res.ok) { showErr("er-err", res.error); return; }

  if (newBedCount > oldBedCount) {
    toast(`Room ${newNo} — now has ${newBedCount} beds`, "success");
  } else if (newBedCount < oldBedCount) {
    toast(`Room ${newNo} — reduced to ${newBedCount} beds`, "success");
  } else {
    toast(`Room ${newNo} updated`, "success");
  }

  closeDlg("dlg-edit-room");
  editRoomRef = null;
  commit();
});

el("form-tenant").addEventListener("submit", (e) => {
  e.preventDefault();
  const picked = String(el("t-bed").value || "").split("|");
  const customRentInput = el("t-rent") ? el("t-rent").value.trim() : "";
  const res = PGStore.addTenant(picked[0], picked[1], {
    name: el("t-name").value,
    phone: el("t-phone").value,
    joined: el("t-joined").value,
    leaving: el("t-leaving").value,
    rent: customRentInput === "" ? null : customRentInput,
    note: el("t-note").value
  });
  if (!res.ok) { showErr("t-err", res.error); return; }
  closeDlg("dlg-tenant");
  toast("Tenant added!", "success");
  commit();
});

el("form-expense").addEventListener("submit", (e) => {
  e.preventDefault();
  const expenseId = el("form-expense").dataset.expenseId;
  const data = {
    category: el("x-cat").value,
    amount: el("x-amt").value,
    date: el("x-date").value,
    note: el("x-note").value
  };
  const res = expenseId ? PGStore.updateExpense(expenseId, data) : PGStore.addExpense(data);
  if (!res.ok) { showErr("x-err", res.error); return; }
  closeDlg("dlg-expense");
  toast(expenseId ? "Expense updated!" : "Expense logged!", "success");
  commit();
});

el("form-rate").addEventListener("submit", (e) => {
  e.preventDefault();
  const rateId = el("form-rate").dataset.rateId;
  const data = {
    label: el("ra-label").value,
    amount: el("ra-amt").value,
    note: el("ra-note").value
  };
  const res = rateId ? PGStore.updateRate(rateId, data) : PGStore.addRate(data);
  if (!res.ok) { showErr("ra-err", res.error); return; }
  closeDlg("dlg-rate");
  toast(rateId ? "Rate updated!" : "Rate added!", "success");
  commit();
});

el("form-owner").addEventListener("submit", (e) => {
  e.preventDefault();
  const res = PGStore.setOwner({
    name: el("o-name").value,
    phone: el("o-phone").value,
    upiId: el("o-upi") ? el("o-upi").value : "",
    address: el("o-address").value,
    pgStartDate: el("o-pgdate") ? el("o-pgdate").value : ""
  });
  if (!res.ok) { showErr("o-err", res.error); return; }
  closeDlg("dlg-owner");
  toast("Details saved!", "success");
  commit();
});

el("form-rules").addEventListener("submit", (e) => {
  e.preventDefault();
  PGStore.setRules({
    visiting: el("ru-visit").value,
    quiet: el("ru-quiet").value,
    guests: el("ru-guest").value,
    lockout: el("ru-lock").value,
    other: el("ru-other").value
  });
  closeDlg("dlg-rules");
  toast("Rules saved!", "success");
  commit();
});

el("form-property").addEventListener("submit", (e) => {
  e.preventDefault();
  const val = el("p-name").value.trim();
  const result = PGStore.setProperty(val);
  if (!result || result.ok !== true) {
    toast("Could not save property name. Storage may be full.", "error", 6000);
    return;
  }
  renderAll();
  closeDlg("dlg-property");
  toast(val ? "Property name saved!" : "Property name cleared.", "success");
  commit();
});

/* Save on Enter key in the property name input */
el("p-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    el("form-property").dispatchEvent(new Event("submit"));
  }
});

/* Save on blur as a safety net */
el("p-name").addEventListener("blur", () => {
  const val = el("p-name").value.trim();
  if (val !== PGStore.state().property) {
    PGStore.setProperty(val);
    renderAll();
  }
});

el("form-backfill").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!backfillRef) { return; }

  /* Collect all checked months. */
  const checked = Array.from(
    el("dlg-backfill").querySelectorAll("input[name=bf-month]:checked")
  ).map((cb) => cb.value);

  if (!checked.length) {
    showErr("bf-err", "Check at least one month, or cancel.");
    return;
  }

  /* Resolve collection day: explicit input → joining date day → 1. */
  let collectDay = parseInt(el("bf-collect").value, 10);
  if (!collectDay || collectDay < 1 || collectDay > 31) {
    /* Auto-detect from joining date. */
    const rooms = PGStore.state().rooms;
    const room = rooms.find((r) => r.id === backfillRef.roomId);
    const bed = room && room.beds[backfillRef.bedIndex];
    collectDay = (bed && bed.joined) ? parseInt(bed.joined.split("-")[2], 10) : 1;
  }

  const res = PGStore.bulkMarkPaid(
    backfillRef.roomId,
    backfillRef.bedIndex,
    checked,
    collectDay
  );

  if (!res.ok) { showErr("bf-err", res.error); return; }
  closeDlg("dlg-backfill");
  backfillRef = null;
  toast("Payment history saved!", "success");
  commit();
});

