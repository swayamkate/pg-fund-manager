/* ---------- complaints / issues ---------- */

function renderComplaints() {
  var complaints = PGStore.complaints();
  var filter = "all";
  var activePill = document.querySelector("#comp-filters .pill.is-active");
  if (activePill) { filter = activePill.dataset.filter || "all"; }

  var filtered = filter === "all" ? complaints : complaints.filter(function (c) { return c.status === filter; });
  var open = complaints.filter(function (c) { return c.status === "open"; }).length;
  var prog = complaints.filter(function (c) { return c.status === "in_progress"; }).length;
  var res = complaints.filter(function (c) { return c.status === "resolved"; }).length;

  var allEl = el("comp-count-all");
  if (allEl) { allEl.textContent = complaints.length; }
  var openEl = el("comp-count-open");
  if (openEl) { openEl.textContent = open; }
  var progEl = el("comp-count-prog");
  if (progEl) { progEl.textContent = prog; }
  var resEl = el("comp-count-res");
  if (resEl) { resEl.textContent = res; }

  var list = el("comp-list");
  var empty = el("comp-empty");
  if (!list) return;

  if (!filtered.length) {
    list.innerHTML = "";
    if (empty) { empty.hidden = false; }
    return;
  }
  if (empty) { empty.hidden = true; }

  var statusBadge = function (s) {
    var map = { open: ["Open", "bg-red-soft text-red"], in_progress: ["In Progress", "bg-amber-soft text-amber"], resolved: ["Resolved", "bg-green-soft text-green"] };
    var cfg = map[s] || map.open;
    return '<span class="badge" style="' + cfg[1] + '">' + cfg[0] + '</span>';
  };
  var prioIcon = function (p) {
    if (p === "high") return '<span style="color:var(--red);font-weight:600">⬆ High</span>';
    if (p === "low") return '<span style="color:var(--muted)">⬇ Low</span>';
    return '<span style="color:var(--amber)">● Medium</span>';
  };

  list.innerHTML = filtered.map(function (c) {
    var meta = [c.roomNo ? "Room " + c.roomNo : "", c.category, prettyDate(c.date)].filter(Boolean).join(" \u00b7 ");
    var costLine = c.cost > 0 ? '<span style="margin-left:8px;color:var(--amber)">' + money(c.cost) + '</span>' : "";
    return '<div class="comp-card card" style="margin-bottom:12px;padding:18px 20px">'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">'
      + '<div style="flex:1;min-width:0">'
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + '<b style="font-size:14px">' + esc(c.title) + '</b>'
      + statusBadge(c.status)
      + prioIcon(c.priority)
      + costLine
      + '</div>'
      + '<p style="font-size:12px;color:var(--muted);margin:4px 0 0">' + esc(meta) + '</p>'
      + (c.note ? '<p style="font-size:12.5px;margin:6px 0 0;color:var(--text)">' + esc(c.note) + '</p>' : "")
      + (c.status === "resolved" && c.resolvedAt ? '<p style="font-size:11px;color:var(--green);margin:4px 0 0">\u2713 Resolved ' + prettyDate(c.resolvedAt) + '</p>' : "")
      + '</div>'
      + '<div style="display:flex;gap:6px;flex-shrink:0">'
      + '<button class="link-btn" type="button" data-act="resolve-complaint" data-comp="' + esc(c.id) + '">Edit</button>'
      + '<button class="link-btn link-danger" type="button" data-act="del-complaint" data-comp="' + esc(c.id) + '">\u00d7</button>'
      + '</div>'
      + '</div>'
      + '</div>';
  }).join("");
}

