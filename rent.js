/* rent.js - editable room rent, and a month-by-month payment history that
   starts at each tenant's joining date.

   This lives in its own file for two reasons. app.js is already at the size
   the push tooling will carry, and everything here is drawn as a sibling
   underneath the rent view rather than inside the list app.js owns, so the
   two never fight over the same nodes.

   The dialogs are injected from here too, so switching this feature on costs
   index.html exactly one script tag. */
(function (global) {
  "use strict";

  var doc = global.document;
  var editing = null;   /* room id being edited */
  var viewing = null;   /* {roomId, bedIndex} whose history is open */

  function el(id) { return doc.getElementById(id); }
  function store() { return global.PGStore; }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function money(n) {
    return "\u20b9" + Number(n || 0).toLocaleString("en-IN");
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + "-" +
      (d.getMonth() < 9 ? "0" : "") + (d.getMonth() + 1) + "-" +
      (d.getDate() < 10 ? "0" : "") + d.getDate();
  }

  /* ---------- one-time markup ---------- */

  function ensureDom() {
    if (el("rent-extra")) { return true; }

    var view = el("view-rent");
    if (!view) { return false; }

    var box = doc.createElement("div");
    box.id = "rent-extra";
    view.appendChild(box);

    var holder = doc.createElement("div");
    holder.innerHTML =
      '<dialog class="dlg" id="dlg-rent">' +
        '<form class="dlg-card" method="dialog">' +
          '<h3>Edit room</h3>' +
          '<p class="dlg-sub">Changing the rent applies to future months. Months already settled keep the amount they were settled at.</p>' +
          '<div class="form-grid">' +
            '<label class="field"><span>Room number</span>' +
              '<input id="rn-no" maxlength="12" /></label>' +
            '<label class="field"><span>Floor</span>' +
              '<input id="rn-floor" maxlength="12" /></label>' +
            '<label class="field span-2"><span>Rent per month</span>' +
              '<input id="rn-rent" type="number" min="0" step="100" /></label>' +
          '</div>' +
          '<p class="auth-error" id="rn-err" hidden></p>' +
          '<div class="dlg-foot">' +
            '<button class="btn-ghost" type="button" data-act="rent-close">Cancel</button>' +
            '<button class="btn-primary btn-sm" type="button" data-act="rent-save">Save room</button>' +
          '</div>' +
        '</form>' +
      '</dialog>' +

      '<dialog class="dlg dlg-wide" id="dlg-ledger">' +
        '<form class="dlg-card" method="dialog">' +
          '<h3 id="lg-who">Payment history</h3>' +
          '<p class="dlg-sub" id="lg-headline"></p>' +
          '<div class="lg-catchup">' +
            '<label class="field"><span>Mark paid up to</span>' +
              '<input id="lg-upto" type="date" /></label>' +
            '<button class="btn-ghost" type="button" data-act="lg-run">Settle</button>' +
          '</div>' +
          '<p class="auth-error" id="lg-err" hidden></p>' +
          '<div class="form-grid" style="margin-bottom:16px">' +
            '<label class="field"><span>Payment date <i class="field-opt">optional</i></span>' +
              '<input id="lg-paydate" type="date" /></label>' +
            '<label class="field"><span>UTR / Transaction ID <i class="field-opt">optional</i></span>' +
              '<input id="lg-utr" maxlength="40" placeholder="e.g. 123456789012" /></label>' +
          '</div>' +
          '<div class="lg-grid" id="lg-months"></div>' +
          '<p class="lg-total" id="lg-total"></p>' +
          '<div class="dlg-foot">' +
            '<button class="btn-primary btn-sm" type="button" data-act="rent-close">Done</button>' +
          '</div>' +
        '</form>' +
      '</dialog>';

    while (holder.firstChild) { doc.body.appendChild(holder.firstChild); }
    return true;
  }

  /* ---------- the cards under the rent view ---------- */

  function tenantRows() {
    var rows = [];
    store().state().rooms.forEach(function (room) {
      room.beds.forEach(function (bed, i) {
        if (!bed) { return; }
        var months = store().ledger(room.id, i);
        var paid = 0;
        months.forEach(function (m) { if (m.paid) { paid++; } });
        rows.push({
          roomId: room.id, roomNo: room.no, bedIndex: i,
          bed: store().bedLabel(i, room.id),
          name: bed.name, collect: bed.collect || 0,
          joined: bed.joined || "", paid: paid, total: months.length
        });
      });
    });
    return rows;
  }

  function render() {
    if (!ensureDom() || !store()) { return; }

    /* Build full payment history table: one row per month per tenant */
    function paymentHistory() {
      var rows = [];
      var totalBill = 0;
      var totalCollected = 0;
      store().state().rooms.forEach(function (room) {
        room.beds.forEach(function (bed, i) {
          if (!bed) { return; }
          var months = store().ledger(room.id, i);
          var rentAmt = store().effectiveRent ? store().effectiveRent(room, bed) : (bed.rent || room.rent || 0);
          months.forEach(function (m) {
            var info = (bed.paymentInfo && bed.paymentInfo[m.month]) || null;
            var dateStr = info ? info.date : '';
            var utrStr = info ? info.utr : '';
            rows.push({
              tenant: bed.name,
              roomNo: room.no,
              bedNo: store().bedLabel(i, room.id),
              month: m.label,
              monthKey: m.month,
              paid: m.paid,
              date: dateStr,
              utr: utrStr,
              amount: Math.max(0, Number(rentAmt || 0))
            });
            if (m.paid) { totalCollected += Number(rentAmt || 0); }
            totalBill += Number(rentAmt || 0);
          });
        });
      });
      rows.sort(function (a, b) {
        var r = b.monthKey.localeCompare(a.monthKey);
        return r !== 0 ? r : String(a.tenant).localeCompare(String(b.tenant));
      });
      return { rows: rows, totalBill: totalBill, totalCollected: totalCollected };
    }

    var due = store().outstanding();
    var rows = tenantRows();
    var html = "";

    /* Arrears first, because it is the number an owner actually chases. */
    html +=
      '<section class="card">' +
        '<div class="card-head"><h2>Outstanding</h2></div>';

    if (!due.people.length) {
      html += '<p class="feed-blank">Nothing outstanding. Every month is settled.</p>';
    } else {
      html += '<p class="lg-headline">' + money(due.amount) + ' across ' +
        due.months + (due.months === 1 ? ' month' : ' months') + '</p>' +
        '<ul class="paylist">';
      due.people.forEach(function (p) {
        html +=
          '<li><span class="pay-left"><span>' +
            '<span class="pay-name">' + esc(p.name) + '</span>' +
            '<span>Room ' + esc(p.roomNo) + ' \u00b7 Bed ' + esc(p.bed) + '</span>' +
          '</span></span>' +
          '<span class="pay-right">' +
            '<span class="amount">' + money(p.amount) + '</span>' +
            '<button class="link-btn" type="button" data-act="wa-remind" data-room="' +
              esc(p.roomId) + '" data-bed="' + p.bedIndex + '">WhatsApp</button>' +
            '<button class="link-btn" type="button" data-act="lg-open" data-room="' +
              esc(p.roomId) + '" data-bed="' + p.bedIndex + '">' +
              p.months + (p.months === 1 ? ' month due' : ' months due') + '</button>' +
          '</span></li>';
      });
      html += '</ul>';
    }
    html += '</section>';

    /* Per tenant history. */
    html +=
      '<section class="card">' +
        '<div class="card-head"><h2>Payment history</h2></div>';

    if (!rows.length) {
      html += '<p class="feed-blank">No tenants yet. Add someone to a bed and their months start here.</p>';
    } else {
      html += '<ul class="paylist">';
      rows.forEach(function (r) {
        var clear = r.paid >= r.total;
        html +=
          '<li><span class="pay-left"><span>' +
            '<span class="pay-name">' + esc(r.name) + '</span>' +
            '<span>Room ' + esc(r.roomNo) + ' \u00b7 Bed ' + esc(r.bed) +
              (r.collect ? ' \u00b7 collect on day ' + r.collect : '') + '</span>' +
          '</span></span>' +
          '<span class="pay-right">' +
            '<span class="badge badge-' + (clear ? 'paid' : 'due') + '">' +
              r.paid + ' of ' + r.total + '</span>' +
            '<button class="link-btn" type="button" data-act="receipt" data-room="' +
              esc(r.roomId) + '" data-bed="' + r.bedIndex + '">Receipt</button>' +
            '<button class="link-btn" type="button" data-act="lg-open" data-room="' +
              esc(r.roomId) + '" data-bed="' + r.bedIndex + '">History</button>' +
          '</span></li>';
      });
      html += '</ul>';
    }
    html += '</section>';

    /* Rooms and their rent. */
    html +=
      '<section class="card">' +
        '<div class="card-head"><h2>Rooms and rent</h2></div>';

    var rooms = store().state().rooms;
    if (!rooms.length) {
      html += '<p class="feed-blank">No rooms yet.</p>';
    } else {
      html += '<ul class="paylist">';
      rooms.forEach(function (room) {
        html +=
          '<li><span class="pay-left"><span>' +
            '<span class="pay-name">Room ' + esc(room.no) + '</span>' +
            '<span>' + (room.floor ? esc(room.floor) + ' \u00b7 ' : '') +
              room.beds.length + ' beds</span>' +
          '</span></span>' +
          '<span class="pay-right">' +
            '<span class="amount">' + money(room.rent) + '<span class="rent-per">/mo</span></span>' +
            '<button class="link-btn" type="button" data-act="rent-edit" data-room="' +
              esc(room.id) + '">Edit</button>' +
          '</span></li>';
      });
      html += '</ul>';
    }
    html += '</section>';

    el("rent-extra").innerHTML = html;
  }

  /* ---------- the month grid ---------- */

  function paintLedger() {
    if (!viewing) { return; }

    var months = store().ledger(viewing.roomId, viewing.bedIndex);
    var paid = 0;
    var owed = 0;
    var chips = "";

    months.forEach(function (m) {
      if (m.paid) { paid++; } else { owed += Number(m.rent || 0); }
      var tip = '';
      if (m.paid && (m.paymentDate || m.utr)) {
        tip = ' title="' + (m.paymentDate ? 'Paid: ' + esc(m.paymentDate) : '') +
          (m.paymentDate && m.utr ? ' \u00b7 ' : '') +
          (m.utr ? 'UTR: ' + esc(m.utr) : '') + '"';
      }
      chips +=
        '<button class="lg-chip' + (m.paid ? ' is-paid' : '') + '" type="button" ' +
          'data-act="lg-month" data-m="' + esc(m.month) + '" ' +
          'data-paid="' + (m.paid ? '1' : '0') + '"' + tip + '>' + esc(m.label) + '</button>';
    });

    el("lg-months").innerHTML = chips ||
      '<p class="feed-blank">No months yet. Set a joining date on this tenant.</p>';
    el("lg-total").innerHTML = paid + ' of ' + months.length +
      (months.length === 1 ? ' month settled' : ' months settled') +
      (owed ? ' \u00b7 ' + money(owed) + ' outstanding' : '');
  }

  function openLedger(roomId, bedIndex) {
    var state = store().state();
    var room = null;
    state.rooms.forEach(function (r) { if (r.id === roomId) { room = r; } });
    var bed = room && room.beds[bedIndex];
    if (!bed) { return; }

    viewing = { roomId: roomId, bedIndex: bedIndex };
    var rentAmt = store().effectiveRent ? store().effectiveRent(room, bed) : (bed.rent || room.rent);
    var customTag = (bed.rent != null && bed.rent > 0) ? ' <span class="tag-custom">custom</span>' : '';

    el("lg-who").innerHTML = esc(bed.name);
    el("lg-headline").innerHTML =
      'Room ' + esc(room.no) + ' \u00b7 Bed ' + esc(store().bedLabel(bedIndex, roomId)) +
      ' \u00b7 ' + money(rentAmt) + ' per month' + customTag +
      (bed.joined ? ' \u00b7 joined ' + esc(bed.joined) : '') +
      (bed.collect ? ' \u00b7 collected on day ' + bed.collect : '');

    el("lg-upto").value = today();
    el("lg-paydate").value = today();
    el("lg-utr").value = "";
    hide("lg-err");
    paintLedger();
    el("dlg-ledger").showModal();
  }

  function openRoom(roomId) {
    var room = null;
    store().state().rooms.forEach(function (r) { if (r.id === roomId) { room = r; } });
    if (!room) { return; }

    editing = roomId;
    el("rn-no").value = room.no || "";
    el("rn-floor").value = room.floor || "";
    el("rn-rent").value = room.rent || "";
    hide("rn-err");
    el("dlg-rent").showModal();
  }

  function hide(id) {
    var node = el(id);
    if (node) { node.hidden = true; node.innerHTML = ""; }
  }

  function show(id, message) {
    var node = el(id);
    if (node) { node.innerHTML = esc(message); node.hidden = false; }
  }

  function closeAll() {
    ["dlg-rent", "dlg-ledger"].forEach(function (id) {
      var d = el(id);
      if (d && d.open) { d.close(); }
    });
    editing = null;
    viewing = null;
  }

  /* Everything app.js changes should be reflected here too, so any click we
     do not recognise simply schedules a redraw once that handler is done. */
  function commit() {
    if (global.PGRender && global.PGRender.commit) { global.PGRender.commit(); }
    render();
  }

  doc.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!btn) { return; }
    var act = btn.getAttribute("data-act");

    if (act === "rent-edit") {
      openRoom(btn.getAttribute("data-room"));
      return;
    }

    if (act === "lg-open") {
      openLedger(btn.getAttribute("data-room"), Number(btn.getAttribute("data-bed")));
      return;
    }

    if (act === "rent-close") {
      closeAll();
      render();
      return;
    }

    if (act === "rent-save") {
      if (!editing) { return; }
      var res = store().updateRoom(editing, {
        no: el("rn-no").value,
        floor: el("rn-floor").value,
        rent: el("rn-rent").value
      });
      if (!res.ok) { show("rn-err", res.error || "Could not save that room."); return; }
      closeAll();
      commit();
      return;
    }

    if (act === "lg-month") {
      if (!viewing) { return; }
      var wasPaid = btn.getAttribute("data-paid") === "1";
      var payDate = el("lg-paydate").value || today();
      var utr = (el("lg-utr").value || "").trim();
      var out = store().setMonthPaid(viewing.roomId, viewing.bedIndex,
        btn.getAttribute("data-m"), !wasPaid, !wasPaid ? payDate : null, !wasPaid ? utr : null);
      if (!out.ok) { show("lg-err", out.error || "Could not change that month."); return; }
      hide("lg-err");
      paintLedger();
      commit();
      return;
    }

    if (act === "lg-run") {
      if (!viewing) { return; }
      var payDate2 = el("lg-paydate").value || today();
      var utr2 = (el("lg-utr").value || "").trim();
      var done = store().markPaidThrough(viewing.roomId, viewing.bedIndex, el("lg-upto").value, payDate2, utr2);
      if (!done.ok) { show("lg-err", done.error || "Could not settle those months."); return; }
      hide("lg-err");
      paintLedger();
      commit();
      return;
    }

    /* Not ours. Let the original handler run, then catch up. */
    if (!el("dlg-ledger") || !el("dlg-ledger").open) {
      global.setTimeout(render, 0);
    }
  });

  global.addEventListener("hashchange", function () { global.setTimeout(render, 0); });

  /* app.js boots the store from a session, so wait until it has. */
  function start(tries) {
    if (store() && el("view-rent")) { render(); return; }
    if (tries > 40) { return; }
    global.setTimeout(function () { start(tries + 1); }, 250);
  }

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", function () { start(0); });
  } else {
    start(0);
  }

  global.PGRent = { render: render };
})(window);
