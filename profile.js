/* PG Manager — tenant profile.

   One panel per tenant: who they are, which bed they hold, when they moved in,
   when they are due to leave, and whatever note the owner keeps on them.

   The dialog builds itself and appends to the body, so index.html only has to
   load this file. Rent, notice and check-out reuse the actions app.js already
   owns — this file just re-draws itself afterwards, because its click listener
   is registered after app.js's and therefore runs second.
*/
(function (global) {
  "use strict";

  var current = null;   /* { roomId, bedIndex } while the panel is open */
  var editing = false;
  var error = "";

  var LABEL = { paid: "Paid", due: "Due", late: "Overdue" };

  /* app.js has its own copies of these, but several are declared with `const`,
     which never lands on `window`. Keeping local copies means this file does
     not depend on how app.js happens to be scoped. */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function money(n) {
    return "\u20b9" + Number(n || 0).toLocaleString("en-IN");
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/).map(function (p) {
      return p.charAt(0);
    });
    return parts.slice(0, 2).join("").toUpperCase() || "?";
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function midnight(value) {
    if (!value) { return null; }
    var d = new Date(value);
    if (isNaN(d.getTime())) { return null; }
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function today() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function pretty(value) {
    if (!value) { return "\u2014"; }
    var d = new Date(value);
    if (isNaN(d.getTime())) { return esc(value); }
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  /* A date input will silently blank anything that is not yyyy-mm-dd, so an
     imported date gets normalised before it reaches the edit form. */
  function dateValue(value) {
    var s = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { return s; }
    var d = midnight(s);
    if (!d) { return ""; }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function daysBetween(from, to) {
    return Math.round((to.getTime() - from.getTime()) / 86400000);
  }

  function stayLabel(joined) {
    var d = midnight(joined);
    if (!d) { return ""; }
    var n = daysBetween(d, today());
    if (n < 0) { return "moves in in " + Math.abs(n) + " days"; }
    if (n === 0) { return "moved in today"; }
    if (n < 31) { return n + (n === 1 ? " day here" : " days here"); }
    var months = Math.floor(n / 30.44);
    if (months < 12) { return months + (months === 1 ? " month here" : " months here"); }
    var years = Math.floor(months / 12);
    var rest = months % 12;
    return years + (years === 1 ? " year" : " years") + (rest ? " " + rest + " mo" : "") + " here";
  }

  function leaveLabel(leaving) {
    var d = midnight(leaving);
    if (!d) { return ""; }
    var n = daysBetween(today(), d);
    if (n > 1) { return n + " days left"; }
    if (n === 1) { return "leaves tomorrow"; }
    if (n === 0) { return "leaves today"; }
    return "that date has passed";
  }

  /* Same rule app.js uses: unpaid turns into "overdue" after the 10th. */
  function status(bed) {
    if (bed.paid) { return "paid"; }
    return new Date().getDate() > 10 ? "late" : "due";
  }

  function find(ref) {
    if (!ref || !global.PGStore) { return null; }
    var rooms = PGStore.state().rooms;
    for (var i = 0; i < rooms.length; i++) {
      if (rooms[i].id === ref.roomId) {
        var bed = rooms[i].beds[ref.bedIndex];
        return bed ? { room: rooms[i], bed: bed } : null;
      }
    }
    return null;
  }

  function bedLabel(i, roomId) {
    return global.PGStore ? PGStore.bedLabel(i, roomId) : String(i + 1);
  }

  /* Owners of a single-storey PG switch floors off, and then a floor line
     under the room number is just noise. */
  function floorSub(room) {
    var s = global.PGStore && PGStore.settings ? PGStore.settings() : null;
    if (s && s.floors === false) { return ""; }
    return "Floor " + (Number(room.floor) || 0);
  }

  function dialog() {
    var d = document.getElementById("dlg-profile");
    if (d) { return d; }

    d = document.createElement("dialog");
    d.id = "dlg-profile";
    d.className = "dlg dlg-profile";
    d.innerHTML = '<div class="dlg-card" id="pf-card"></div>';
    document.body.appendChild(d);

    /* Covers Escape and backdrop dismissal as well as our own close button. */
    d.addEventListener("close", function () {
      current = null;
      editing = false;
      error = "";
    });
    return d;
  }

  function cell(label, value, sub) {
    return '<div class="pf-cell"><b>' + esc(label) + "</b><span>" + value +
      (sub ? '<i>' + esc(sub) + "</i>" : "") + "</span></div>";
  }

  function readView(found) {
    var room = found.room;
    var bed = found.bed;
    var st = status(bed);
    var phone = String(bed.phone || "").trim();
    var tel = phone.replace(/[^0-9+]/g, "");
    var note = String(bed.note || "").trim();
    var ref = ' data-room="' + esc(room.id) + '" data-bed="' + current.bedIndex + '"';
    var rentAmt = (global.PGStore && PGStore.effectiveRent) ? PGStore.effectiveRent(room, bed) : (bed.rent != null ? bed.rent : room.rent);
    var rentSub = (bed.rent != null && bed.rent > 0) ? "custom rate per month" : "room default per month";

    var idDetails = bed.idNumber ? ((bed.idType ? bed.idType + ": " : "") + bed.idNumber) : "\u2014";

    return '' +
      '<div class="pf-head">' +
        '<span class="av pf-av">' + esc(initials(bed.name)) + '</span>' +
        '<span class="pf-id">' +
          '<b>' + esc(bed.name) +
            (bed.onNotice ? ' <span class="tag-notice">notice</span>' : "") + '</b>' +
          '<span>Room ' + esc(room.no) + ' \u00b7 Bed ' + esc(bedLabel(current.bedIndex, current.roomId)) + '</span>' +
        '</span>' +
        '<span class="badge badge-' + st + '">' + LABEL[st] + '</span>' +
      '</div>' +

      '<div class="pf-grid">' +
        cell("Room", "Room " + esc(room.no), floorSub(room)) +
        cell("Bed number", "Bed " + esc(bedLabel(current.bedIndex, current.roomId)), "") +
        cell("Phone", tel ? '<a href="tel:' + esc(tel) + '">' + esc(phone) + '</a>' : "\u2014", "") +
        cell("Monthly rent", money(rentAmt), rentSub) +
        cell("Security deposit", bed.deposit ? money(bed.deposit) : "\u20b90", bed.deposit ? "held with owner" : "not recorded") +
        cell("ID document", esc(idDetails), "") +
        cell("Emergency contact", esc(bed.emergencyContact || "\u2014"), "") +
        cell("Workplace / College", esc(bed.workplace || "\u2014"), "") +
        cell("Joining date", pretty(bed.joined), stayLabel(bed.joined)) +
        cell("Leaving date", bed.leaving ? pretty(bed.leaving) : "\u2014",
          leaveLabel(bed.leaving) || (bed.onNotice ? "on notice, no date set" : "no date set")) +
        cell("Collection day", bed.collect ? "Day " + bed.collect : "\u2014",
          bed.collect ? "of every month" : "not set") +
      '</div>' +

      '<div class="pf-note"><b>Note</b>' +
        (note ? "<p>" + esc(note) + "</p>"
              : '<p class="pf-blank">Nothing noted yet. Food preference, parent\u2019s number \u2014 anything worth remembering.</p>') +
      '</div>' +

      '<div class="pf-foot">' +
        '<span class="pf-left">' +
          '<button class="link-btn" type="button" data-act="pay"' + ref +
            ' data-paid="' + (bed.paid ? "0" : "1") + '">' +
            (bed.paid ? "Undo payment" : "Mark rent paid") + '</button>' +
          '<button class="link-btn" type="button" data-act="backfill"' + ref + '>Add history</button>' +
          '<button class="link-btn" type="button" data-act="transfer"' + ref + '>Transfer bed</button>' +
          '<button class="link-btn" type="button" data-act="receipt"' + ref + '>Receipt</button>' +
          '<button class="link-btn" type="button" data-act="wa-remind"' + ref + '>WhatsApp</button>' +
          '<button class="link-btn" type="button" data-act="notice"' + ref + '>' +
            (bed.onNotice ? "Cancel notice" : "Put on notice") + '</button>' +
          '<button class="link-btn link-danger" type="button" data-act="checkout"' + ref + '>Check out</button>' +
        '</span>' +
        '<button class="btn-ghost" type="button" data-act="pf-close">Close</button>' +
        '<button class="btn-primary btn-sm" type="button" data-act="pf-edit">Edit details</button>' +
      '</div>';
  }

  function editView(found) {
    var bed = found.bed;
    var room = found.room;
    var customRentVal = (bed.rent != null && bed.rent !== "") ? String(bed.rent) : "";
    var depositVal = (bed.deposit != null && bed.deposit > 0) ? String(bed.deposit) : "";
    var idType = bed.idType || "Aadhaar";

    return '' +
      '<form class="pf-form" id="pf-form">' +
        '<h3>Edit ' + esc(bed.name) + '</h3>' +
        '<div class="form-grid">' +
          '<label class="field span-2"><span>Full name</span>' +
            '<input id="pf-name" maxlength="60" autocomplete="name" value="' + esc(bed.name) + '" required /></label>' +
          '<label class="field"><span>Phone</span>' +
            '<input id="pf-phone" maxlength="24" autocomplete="tel" value="' + esc(bed.phone || "") +
            '" placeholder="+91 98765 43210" /></label>' +
          '<label class="field"><span>Custom rent (\u20b9/mo) <i class="field-opt">optional</i></span>' +
            '<input id="pf-rent" type="number" min="0" step="100" value="' + esc(customRentVal) + '" placeholder="Default: ' + money(room.rent) + '" /></label>' +
          '<label class="field"><span>Security deposit held (\u20b9)</span>' +
            '<input id="pf-deposit" type="number" min="0" step="100" value="' + esc(depositVal) + '" placeholder="e.g. 10000" /></label>' +
          '<label class="field"><span>ID document type</span>' +
            '<select id="pf-idtype">' +
              '<option value="Aadhaar"' + (idType === "Aadhaar" ? " selected" : "") + '>Aadhaar Card</option>' +
              '<option value="PAN"' + (idType === "PAN" ? " selected" : "") + '>PAN Card</option>' +
              '<option value="Passport"' + (idType === "Passport" ? " selected" : "") + '>Passport</option>' +
              '<option value="Driving License"' + (idType === "Driving License" ? " selected" : "") + '>Driving License</option>' +
              '<option value="College ID"' + (idType === "College ID" ? " selected" : "") + '>College / Student ID</option>' +
              '<option value="Work ID"' + (idType === "Work ID" ? " selected" : "") + '>Work / Company ID</option>' +
              '<option value="Other"' + (idType === "Other" ? " selected" : "") + '>Other</option>' +
            '</select></label>' +
          '<label class="field"><span>ID document number</span>' +
            '<input id="pf-idnum" maxlength="40" value="' + esc(bed.idNumber || "") + '" placeholder="e.g. 1234 5678 9012" /></label>' +
          '<label class="field"><span>Emergency contact</span>' +
            '<input id="pf-emergency" maxlength="60" value="' + esc(bed.emergencyContact || "") + '" placeholder="Father: +91 98765 00000" /></label>' +
          '<label class="field"><span>Workplace / College</span>' +
            '<input id="pf-workplace" maxlength="60" value="' + esc(bed.workplace || "") + '" placeholder="e.g. Infosys / COEP" /></label>' +
          '<label class="field"><span>Joining date</span>' +
            '<input id="pf-joined" type="date" value="' + esc(dateValue(bed.joined)) + '" /></label>' +
          '<label class="field"><span>Leaving date</span>' +
            '<input id="pf-leaving" type="date" value="' + esc(dateValue(bed.leaving)) + '" /></label>' +
          '<label class="field"><span>Collection day</span>' +
            '<input id="pf-collect" type="number" min="1" max="31" value="' + esc(bed.collect || "") + '" placeholder="e.g. 5" /></label>' +
          '<p class="hint span-2">Setting a custom rent applies only to ' + esc(bed.name) + '\u2019s bed. Leave blank to inherit Room ' + esc(room.no) + '\u2019s default of ' + money(room.rent) + '/mo.</p>' +
          '<label class="field span-2"><span>Note</span>' +
            '<textarea id="pf-note" maxlength="200" rows="3" ' +
            'placeholder="Deposit paid, food preference, parent\u2019s number\u2026">' +
            esc(bed.note || "") + '</textarea></label>' +
        '</div>' +
        (error ? '<p class="auth-error">' + esc(error) + '</p>' : "") +
        '<div class="dlg-foot">' +
          '<button class="btn-ghost" type="button" data-act="pf-cancel">Cancel</button>' +
          '<button class="btn-primary btn-sm" type="submit">Save changes</button>' +
        '</div>' +
      '</form>';
  }

  function render() {
    var found = find(current);
    if (!found) { close(); return; }

    var card = dialog().querySelector("#pf-card");
    card.innerHTML = editing ? editView(found) : readView(found);

    if (editing) {
      var first = card.querySelector("input");
      if (first) { setTimeout(function () { first.focus(); }, 30); }
    }
  }

  function open(roomId, bedIndex) {
    current = { roomId: roomId, bedIndex: Number(bedIndex) };
    editing = false;
    error = "";

    if (!find(current)) { current = null; return; }

    var d = dialog();
    render();
    if (d.open) { return; }
    if (d.showModal) { d.showModal(); } else { d.setAttribute("open", ""); }
  }

  function close() {
    var d = document.getElementById("dlg-profile");
    current = null;
    editing = false;
    error = "";
    if (!d) { return; }
    if (d.close) {
      try { d.close(); } catch (err) { d.removeAttribute("open"); }
    } else {
      d.removeAttribute("open");
    }
  }

  function save() {
    var found = find(current);
    if (!found) { close(); return; }

    var val = function (id) {
      var node = document.getElementById(id);
      return node ? node.value : "";
    };

    var rentRaw = val("pf-rent").trim();
    var rentVal = rentRaw === "" ? null : Math.max(0, Number(rentRaw));

    var res = PGStore.updateTenant(current.roomId, current.bedIndex, {
      name: val("pf-name"),
      phone: val("pf-phone"),
      joined: val("pf-joined"),
      leaving: val("pf-leaving"),
      collect: val("pf-collect"),
      rent: rentVal,
      deposit: val("pf-deposit"),
      idType: val("pf-idtype"),
      idNumber: val("pf-idnum"),
      emergencyContact: val("pf-emergency"),
      workplace: val("pf-workplace"),
      note: val("pf-note")
    });

    if (!res.ok) {
      error = res.error || "Could not save those changes.";
      render();
      return;
    }

    error = "";
    editing = false;
    render();
    /* Redraw the tabs behind the dialog and queue the sheet backup. */
    if (typeof global.commit === "function") { global.commit(); }
  }

  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
    if (!btn) { return; }

    var act = btn.dataset.act;

    if (act === "profile") {
      open(btn.dataset.room, btn.dataset.bed);
      return;
    }

    /* Everything below only matters while the panel is on screen. */
    if (!current) { return; }

    if (act === "pf-edit") {
      error = "";
      editing = true;
      render();
    } else if (act === "pf-cancel") {
      error = "";
      editing = false;
      render();
    } else if (act === "pf-close") {
      close();
    } else if (act === "pay" || act === "notice") {
      /* app.js has already applied the change and re-rendered the tabs. */
      render();
    } else if (act === "checkout") {
      /* Close profile modal and let app.js trigger the offboarding settlement dialog. */
      close();
    }
  });

  document.addEventListener("submit", function (e) {
    if (e.target && e.target.id === "pf-form") {
      e.preventDefault();
      save();
    }
  });

  /* Exposed so the panel can be rendered to a string outside a browser, which
     is how it gets checked visually before shipping. */
  function html(roomId, bedIndex, edit) {
    current = { roomId: roomId, bedIndex: Number(bedIndex) };
    var found = find(current);
    var out = found ? (edit ? editView(found) : readView(found)) : "";
    current = null;
    return out;
  }

  global.PGProfile = { open: open, close: close, html: html };
})(window);
