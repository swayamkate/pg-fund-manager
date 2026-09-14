/* PG Manager — Google Sheets backup endpoint.

   Paste this into Extensions → Apps Script from the spreadsheet that should
   hold the backups, set TOKEN below, then deploy it as a web app:

     Deploy → New deployment → Web app
       Execute as:      Me
       Who has access:  Anyone

   Copy the /exec URL into SHEETS_URL in config.js, and the same TOKEN into
   SHEETS_TOKEN.

   Each account gets its own readable tab. The _data tab holds the exact JSON
   used to restore, so restoring never depends on parsing the pretty version.

   Note: "Anyone" really does mean anyone who has the URL, and the URL is
   visible in the site's source. Treat this as a convenience backup, not as a
   private store.
*/

var TOKEN = "change-me";
var DATA_TAB = "_data";
var COLUMNS = ["Room", "Floor", "Rent", "Bed", "Tenant", "Phone", "Joined", "On notice", "Paid"];

/* Emergency alert recipient — set this to your own email address.
   Fires when a PG Manager client reports a database save that failed
   permanently after all client-side retries. */
var ALERT_EMAIL = "you@example.com";

function doGet() {
  return reply({ ok: true, message: "PG Manager backup endpoint is live." });
}

function doPost(e) {
  var lock = LockService.getScriptLock();

  try {
    lock.waitLock(20000);

    var req = JSON.parse(e.postData.contents);

    if (TOKEN && String(req.token || "") !== TOKEN) {
      return reply({ ok: false, error: "Wrong backup token." });
    }

    var account = String(req.account || "").trim();
    if (!account) {
      return reply({ ok: false, error: "Missing account." });
    }

    if (req.action === "push") { return reply(push(account, req.data)); }
    if (req.action === "pull") { return reply(pull(account)); }
    if (req.action === "critical_error_log") { return reply(criticalErrorLog(account, req)); }

    return reply({ ok: false, error: "Unknown action." });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

function reply(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   Directive 4 — automated email alert pipeline.
   The browser POSTs { action: "critical_error_log", error, tables, ... }
   when a Supabase save has failed permanently after all retries.
   ============================================================ */
function criticalErrorLog(account, req) {
  var subject = "[PG Manager] CRITICAL: database save failed for " + account;
  var body =
    "A PG Manager client failed to save data to Supabase after all retries.\n\n" +
    "Account:  " + account + "\n" +
    "Error:    " + String(req.error || "(none given)") + "\n" +
    "Tables:   " + (req.tables && req.tables.length ? req.tables.join(", ") : "(not reported)") + "\n" +
    "Attempts: " + String(req.attempts || "(not reported)") + "\n" +
    "Browser:  " + String(req.userAgent || "(not reported)") + "\n" +
    "Time:     " + String(req.at || stamp()) + "\n\n" +
    "The owner has been shown a blocking warning in the app. Their latest " +
    "changes are still in their browser and local backup only.";

  try {
    MailApp.sendEmail(ALERT_EMAIL, subject, body);
    logCritical(account, body);
    return { ok: true, alerted: true };
  } catch (err) {
    logCritical(account, body + "\n\n[EMAIL FAILED: " + String(err) + "]");
    return { ok: false, error: "Could not send alert email: " + String(err) };
  }
}

/* Keep a written trail in the sheet itself, capped at 200 entries. */
function logCritical(account, body) {
  try {
    var tab = sheetFor("_alerts");
    if (tab.getLastRow() === 0) {
      tab.appendRow(["Time", "Account", "Detail"]);
      tab.getRange(1, 1, 1, 3).setFontWeight("bold");
    }
    tab.appendRow([stamp(), account, String(body).slice(0, 2000)]);
    if (tab.getLastRow() > 200) {
      tab.deleteRows(2, tab.getLastRow() - 200);
    }
  } catch (err) { /* logging must never break the reply */ }
}

/* Tab names cannot contain : \ / ? * [ ] and cap out at 100 characters. */
function tabName(account) {
  var name = String(account).replace(/[:\\\/\?\*\[\]]/g, "-").slice(0, 90);
  return name || "account";
}

function sheetFor(name) {
  var ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function stamp() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
}

function pad(row) {
  while (row.length < COLUMNS.length) { row.push(""); }
  return row;
}

function push(account, data) {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Nothing to back up." };
  }

  var rooms = data.rooms || [];
  var rows = [
    pad(["Property", data.property || "(unnamed)", "", "Account", account]),
    pad(["Last backup", stamp(), "", "Rent cycle", data.cycle || ""]),
    pad([""]),
    pad(COLUMNS.slice())
  ];

  var beds = 0;
  var tenants = 0;

  for (var r = 0; r < rooms.length; r++) {
    var room = rooms[r];
    for (var b = 0; b < room.beds.length; b++) {
      var bed = room.beds[b];
      var bedRent = bed && bed.rent != null ? bed.rent : room.rent;
      beds++;
      if (bed) { tenants++; }
      rows.push(pad([
        room.no,
        room.floor,
        bedRent,
        "ABCDEFGH".charAt(b) || String(b + 1),
        bed ? bed.name : "(vacant)",
        bed ? bed.phone : "",
        bed ? bed.joined : "",
        bed && bed.onNotice ? "yes" : "",
        bed ? (bed.paid ? "paid" : "due") : ""
      ]));
    }
  }

  if (!rooms.length) {
    rows.push(pad(["(no rooms yet)"]));
  }

  var tab = sheetFor(tabName(account));
  tab.clear();
  tab.getRange(1, 1, rows.length, COLUMNS.length).setValues(rows);
  tab.getRange(1, 1, 2, 1).setFontWeight("bold");
  tab.getRange(4, 1, 1, COLUMNS.length).setFontWeight("bold");
  tab.setFrozenRows(4);
  tab.autoResizeColumns(1, COLUMNS.length);

  writeData(account, data);

  return { ok: true, beds: beds, tenants: tenants, at: stamp() };
}

/* The _data tab is the restore source: account | json | updated. */
function writeData(account, data) {
  var tab = sheetFor(DATA_TAB);
  var json = JSON.stringify(data);

  if (tab.getLastRow() === 0) {
    tab.appendRow(["Account", "Data", "Updated"]);
    tab.getRange(1, 1, 1, 3).setFontWeight("bold");
  }

  var ids = tab.getRange(1, 1, Math.max(tab.getLastRow(), 1), 1).getValues();
  for (var i = 1; i < ids.length; i++) {
    if (String(ids[i][0]) === account) {
      tab.getRange(i + 1, 2, 1, 2).setValues([[json, stamp()]]);
      return;
    }
  }

  tab.appendRow([account, json, stamp()]);
}

function pull(account) {
  var ss = SpreadsheetApp.getActive();
  var tab = ss.getSheetByName(DATA_TAB);
  if (!tab || tab.getLastRow() < 2) {
    return { ok: true, data: null };
  }

  var rows = tab.getRange(2, 1, tab.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === account) {
      try {
        return { ok: true, data: JSON.parse(rows[i][1]) };
      } catch (err) {
        return { ok: false, error: "The saved backup could not be read." };
      }
    }
  }

  return { ok: true, data: null };
}
