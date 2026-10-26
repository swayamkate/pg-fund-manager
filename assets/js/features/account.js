/* PG Manager — account and access.

   Everything on the Owner tab that concerns logins rather than beds: who you
   are signed in as, setting a username, changing a password, and the invite
   codes that decide who is allowed to open an account at all.

   This file keeps to itself. Its click listener is registered after app.js's,
   so it runs second, and app.js ignores actions it does not recognise. It also
   asks auth.js for the session itself rather than waiting on app.js's boot,
   which means neither file has to know the other's timing.
*/
(function (global) {
  "use strict";

  var ME = { name: "Owner", id: "", username: "", role: "owner" };
  var flashText = "";
  var flashTimer = null;

  /* app.js declares its own copies of these with `const`, which never lands on
     `window`. Local copies keep this file independent of how app.js is scoped. */
  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/).map(function (p) {
      return p.charAt(0);
    });
    return parts.slice(0, 2).join("").toUpperCase() || "?";
  }

  function openDlg(id) {
    var d = el(id);
    if (!d) { return; }
    if (d.showModal) { d.showModal(); } else { d.setAttribute("open", ""); }
    var first = d.querySelector("input, select");
    if (first) { setTimeout(function () { first.focus(); }, 30); }
  }

  function closeDlg(id) {
    var d = el(id);
    if (!d) { return; }
    if (d.close) { d.close(); } else { d.removeAttribute("open"); }
  }

  function showErr(id, message) {
    var p = el(id);
    if (!p) { return; }
    p.textContent = message;
    p.hidden = false;
  }

  function hideErr(id) {
    var p = el(id);
    if (p) { p.hidden = true; }
  }

  function shortDate(value) {
    var d = new Date(value);
    if (isNaN(d.getTime())) { return ""; }
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  }

  function flash(msg) {
    flashText = msg;
    render();
    if (flashTimer) { clearTimeout(flashTimer); }
    flashTimer = setTimeout(function () {
      flashText = "";
      render();
    }, 5000);
  }

  /* ---------- rows ---------- */

  var INVITE_BADGE = {
    open: '<span class="badge badge-due">Open</span>',
    used: '<span class="badge badge-paid">Used</span>',
    expired: '<span class="badge badge-late">Expired</span>',
    revoked: '<span class="badge badge-late">Cancelled</span>'
  };

  function personRow(p) {
    var under = p.username ? "@" + p.username : p.id;
    var you = p.id === ME.id ? ' <i class="acc-you">you</i>' : "";

    return '' +
      '<div class="acc-row">' +
        '<span class="pay-left">' +
          '<span class="av">' + esc(initials(p.name)) + '</span>' +
          '<span><b class="pay-name">' + esc(p.name) + you + '</b>' +
          '<span class="muted-sm">' + esc(under) + '</span></span>' +
        '</span>' +
        '<span class="pay-right">' + (p.role === "owner"
          ? '<span class="badge badge-paid">Owner</span>'
          : '<span class="badge badge-due">Staff</span>') + '</span>' +
      '</div>';
  }

  function inviteRow(inv) {
    var tail = "";
    if (inv.state === "used" && inv.usedBy) { tail = " \u00b7 used by " + inv.usedBy; }
    else if (inv.state === "open") { tail = " \u00b7 good until " + shortDate(inv.expires); }

    var line = (inv.role === "owner" ? "Owner invite" : "Staff invite") + tail;
    var cancel = inv.state === "open"
      ? '<button class="link-btn link-danger" type="button" data-act="del-invite" ' +
        'data-code="' + esc(inv.digest) + '">Cancel</button>'
      : "";

    return '' +
      '<div class="acc-row">' +
        '<span class="pay-left">' +
          '<span class="code-chip">' + esc(inv.hint) + '\u2026</span>' +
          '<span><b class="pay-name">' + esc(inv.label || "No label") + '</b>' +
          '<span class="muted-sm">' + esc(line) + '</span></span>' +
        '</span>' +
        '<span class="pay-right">' + (INVITE_BADGE[inv.state] || "") + cancel + '</span>' +
      '</div>';
  }

  /* ---------- render ---------- */

  function render() {
    var box = el("account-body");
    if (!box) { return; }

    var mode = el("access-mode");
    if (mode) {
      mode.textContent = global.PGAuth && PGAuth.mode === "supabase"
        ? "Checked on your Supabase project"
        : "Checked in this browser";
    }

    box.innerHTML = '' +
      '<div class="own-grid">' +
        '<div class="own-cell"><b>Name</b><span>' + esc(ME.name || "\u2014") + '</span></div>' +
        '<div class="own-cell"><b>Email</b><span>' + esc(ME.id || "\u2014") + '</span></div>' +
        '<div class="own-cell"><b>Username</b><span>' +
          (ME.username ? "@" + esc(ME.username) : "<i>Not set yet</i>") +
        '</span></div>' +
        '<div class="own-cell"><b>Role</b><span>' +
          (ME.role === "owner" ? "Owner" : "Staff") + '</span></div>' +
      '</div>' +
      '<div class="acc-actions">' +
        '<button class="btn-ghost btn-sm" type="button" data-act="set-username">' +
          (ME.username ? "Change username" : "Set a username") + '</button>' +
        '<button class="btn-ghost btn-sm" type="button" data-act="change-password">' +
          'Change password</button>' +
      '</div>' +
      (flashText ? '<p class="acc-flash" role="status">' + esc(flashText) + '</p>' : "") +
      '<p class="acc-note">You are signed out after 30 idle minutes, and after 12 hours ' +
        'either way. Wrong passwords lock a login, and the wait grows each time.</p>';

    renderInvites();
  }

  function renderInvites() {
    var card = el("invite-card");
    if (!card) { return; }

    /* auth.js enforces invites itself in browser mode. On Supabase the real
       switch lives in the project dashboard, so offering codes here would be
       promising something this page cannot deliver. */
    var canInvite = ME.role === "owner" && global.PGAuth && PGAuth.mode !== "supabase";

    card.hidden = !canInvite;
    if (!canInvite) { return; }

    el("people-list").innerHTML =
      '<div class="acc-sec"><h4>Who can sign in</h4>' +
      PGAuth.listPeople().map(personRow).join("") + "</div>";

    var invites = PGAuth.listInvites();
    el("invite-list").innerHTML = invites.length
      ? '<div class="acc-sec"><h4>Invite codes</h4>' + invites.map(inviteRow).join("") + "</div>"
      : '<p class="rate-blank">No invite codes yet. Make one when you want to let ' +
        'somebody in \u2014 without a code, nobody can open an account here.</p>';
  }

  /* ---------- actions ---------- */

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) { return; }
    var act = btn.dataset.act;

    if (act === "set-username") {
      el("un-head").textContent = ME.username ? "Change your username" : "Set a username";
      el("un-name").value = ME.username || "";
      hideErr("un-err");
      openDlg("dlg-username");

    } else if (act === "change-password") {
      el("cp-cur").value = "";
      el("cp-new").value = "";
      el("cp-conf").value = "";
      el("cp-meter").hidden = true;
      hideErr("cp-err");
      openDlg("dlg-password");

    } else if (act === "new-invite") {
      el("iv-label").value = "";
      el("iv-role").value = "staff";
      el("iv-days").value = "7";
      hideErr("iv-err");
      openDlg("dlg-invite");

    } else if (act === "del-invite") {
      Promise.resolve(PGAuth.revokeInvite(btn.dataset.code)).then(function () {
        render();
      }, function () {});

    } else if (act === "copy-code") {
      copyCode(btn);
    }
  });

  function copyCode(btn) {
    var text = el("code-out").textContent.trim();
    if (!navigator.clipboard || !navigator.clipboard.writeText) { return; }

    navigator.clipboard.writeText(text).then(function () {
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = "Copy code"; }, 1600);
    }, function () {});
  }

  document.addEventListener("submit", function (e) {
    var id = e.target && e.target.id;

    if (id === "form-username") {
      e.preventDefault();
      PGAuth.setUsername(el("un-name").value).then(function (res) {
        if (!res.ok) { showErr("un-err", res.error); return; }
        ME.username = res.username;
        if (global.PG_SESSION) { PG_SESSION.username = res.username; }
        closeDlg("dlg-username");
        flash("You can now sign in as @" + res.username + ".");
      }, function () { showErr("un-err", "Could not save the username."); });

    } else if (id === "form-password") {
      e.preventDefault();
      var next = el("cp-new").value;
      if (next !== el("cp-conf").value) {
        showErr("cp-err", "The two new passwords do not match.");
        return;
      }
      PGAuth.changePassword(el("cp-cur").value, next).then(function (res) {
        if (!res.ok) { showErr("cp-err", res.error); return; }
        closeDlg("dlg-password");
        flash("Password changed. Any other device signed in as you is now signed out.");
      }, function () { showErr("cp-err", "Could not change the password."); });

    } else if (id === "form-invite") {
      e.preventDefault();
      PGAuth.createInvite({
        label: el("iv-label").value,
        role: el("iv-role").value,
        days: Number(el("iv-days").value)
      }).then(function (res) {
        if (!res.ok) { showErr("iv-err", res.error); return; }
        closeDlg("dlg-invite");
        el("code-out").textContent = res.code;
        el("code-sub").textContent =
          "Send it to the person you are inviting. It opens one account, once.";
        openDlg("dlg-code");
        render();
      }, function () { showErr("iv-err", "Could not create the invite."); });
    }
  });

  document.addEventListener("input", function (e) {
    if (!e.target || e.target.id !== "cp-new") { return; }

    var pw = e.target.value;
    var meter = el("cp-meter");
    if (!pw) { meter.hidden = true; return; }

    var read = PGAuth.passwordScore(pw);
    meter.hidden = false;
    meter.dataset.score = String(read.score);
    el("cp-fill").style.width = (read.score * 25) + "%";
    el("cp-label").textContent = read.label;
  });

  /* ---------- session watchdog ---------- */

  /* Real work in the page pushes the idle clock back, and a timer notices when
     the session has run out. Without this, a dashboard left open all night
     would still look signed in until something was clicked. */
  function watch() {
    var last = 0;

    function bump() {
      var at = Date.now();
      if (at - last < 30000) { return; }
      last = at;
      PGAuth.touch();
    }

    ["click", "keydown", "pointerdown", "scroll"].forEach(function (evt) {
      document.addEventListener(evt, bump, { passive: true });
    });

    setInterval(function () {
      Promise.resolve(PGAuth.session()).then(function (s) {
        if (!s.signedIn) {
          location.replace("login.html" + (s.reason ? "?out=" + s.reason : ""));
        }
      }, function () {});
    }, 60000);
  }

  /* ---------- start ---------- */

  if (global.PGAuth) {
    try {
      PGAuth.session().then(function (s) {
        if (!s.signedIn) { return; }
        ME = {
          name: s.name || "Owner",
          id: s.id || "",
          username: s.username || "",
          role: s.role || "owner"
        };
        render();
        watch();
      }, function () {});
    } catch (err) { /* the gate in index.html handles a broken session */ }
  }

  global.PGAccount = { render: render };
})(window);
