/* components/sync-ping.js — floating "Live Sync Ping" badge (bottom-left)
 *
 * Visual + behavior spec:
 *   - fixed bottom-left glass pill with a status dot + short text
 *   - green pulsing "Live" · blue blinking "Syncing (N)…" · amber
 *     "Offline (Saved locally)" · red "Sync paused"
 *   - tap toggles a micro-popover: queue depth, last successful sync time,
 *     and a manual "Sync Now" flush button
 *
 * Data sources (all read-only):
 *   - window "pgv2:sync" events (status, detail) from store/sync.js
 *   - store.syncHealth() for queue/parked/dead-letter depth on tap
 *   - lastSyncAt is recorded here on every "synced" transition
 *
 * No store mutation, no network calls of its own — pure UI.
 */

let lastSyncAt = null;

const STATES = {
  synced: { dot: "green", text: "Live", anim: "pulse" },
  queued: { dot: "blue", text: "Syncing", anim: "blink", counting: true },
  draining: { dot: "blue", text: "Syncing", anim: "blink", counting: true },
  /* offline + error = "paused, still saving locally" — the owner keeps
     editing; retries resume automatically (online/focus). Non-blocking. */
  offline: { dot: "amber", text: "Sync paused — retrying… (saved locally)", anim: "none" },
  error: { dot: "red", text: "Sync paused — retrying…", anim: "none" }
};

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (e) { return "—"; }
}

function render(stateKey, detail) {
  const badge = document.getElementById("sync-ping");
  if (!badge) { return; }
  const dot = badge.querySelector(".ping-dot");
  const label = badge.querySelector(".ping-label");
  const conf = STATES[stateKey] || STATES.offline;

  badge.dataset.state = stateKey;
  badge.dataset.anim = conf.anim;
  badge.className = "sync-ping state-" + stateKey;
  dot.className = "ping-dot dot-" + conf.dot;

  let text = conf.text;
  if (conf.counting && typeof detail === "number" && detail > 0) { text = "Syncing (" + detail + ")…"; }
  label.textContent = text;
}

function popoverHtml(health, rtStatus) {
  const pending = health.pending || 0;
  const parked = health.parked ? health.parked.count : 0;
  const dead = health.deadLetters || 0;
  const rows = [];
  rows.push("<div class=\"ping-row\"><span>Pending changes</span><b>" + pending + "</b></div>");
  if (parked) { rows.push("<div class=\"ping-row\"><span>Held (schema)</span><b>" + parked + "</b></div>"); }
  if (dead) { rows.push("<div class=\"ping-row\"><span>Errors kept</span><b>" + dead + "</b></div>"); }
  rows.push("<div class=\"ping-row\"><span>Last cloud sync</span><b>" + (lastSyncAt ? fmtTime(lastSyncAt) : "this session") + "</b></div>");
  if (rtStatus) { rows.push("<div class=\"ping-row\"><span>Realtime</span><b>" + esc(rtStatus) + "</b></div>"); }
  return rows.join("");
}

export function initSyncPing({ store, realtime, toast } = {}) {
  const badge = document.getElementById("sync-ping");
  if (!badge) { return { destroy() {} }; }

  /* build the DOM once */
  badge.className = "sync-ping state-offline";
  badge.innerHTML =
    '<span class="ping-dot dot-amber"></span>' +
    '<span class="ping-label">Offline (Saved locally)</span>' +
    '<span class="ping-pop" hidden></span>';

  const pop = badge.querySelector(".ping-pop");
  let open = false;

  function togglePopover(force) {
    open = force != null ? force : !open;
    if (open) {
      const health = store && store.syncHealth ? store.syncHealth() : {};
      const rt = realtime ? realtime.currentStatus() : null;
      pop.innerHTML = popoverHtml(health, rt) +
        '<button type="button" class="ping-sync-now">Sync Now</button>';
      pop.querySelector(".ping-sync-now").addEventListener("click", (e) => {
        e.stopPropagation();
        if (store && store.flushSync) {
          store.flushSync();
          if (toast) { toast("Syncing now…"); }
        }
        togglePopover(false);
      });
      pop.hidden = false;
    } else {
      pop.hidden = true;
    }
  }

  badge.addEventListener("click", (e) => { e.stopPropagation(); togglePopover(); });
  document.addEventListener("click", onDocClick);
  function onDocClick() { if (open) { togglePopover(false); } }

  /* real-time updates: one listener, transitions only, never blocks UI */
  function onSyncEvent(ev) {
    const d = ev.detail || {};
    if (d.status === "synced") { lastSyncAt = new Date().toISOString(); }
    render(d.status, d.detail);
  }
  window.addEventListener("pgv2:sync", onSyncEvent);

  return {
    destroy() {
      window.removeEventListener("pgv2:sync", onSyncEvent);
      document.removeEventListener("click", onDocClick);
    },
    /* exposed for tests */
    _render: render,
    _popover: popoverHtml,
    _setLastSync: (iso) => { lastSyncAt = iso; }
  };
}
