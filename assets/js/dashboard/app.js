/* Dashboard startup. Shared features load first; see docs/architecture.md. */
/* ---------- boot ---------- */

function pgDuration(startDate) {
  const start = new Date(startDate);
  const now = new Date();
  const diffMs = now.getTime() - start.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days < 0) return "not started yet";
  if (days < 30) return days + " day" + (days !== 1 ? "s" : "");
  const months = Math.floor(days / 30);
  const rem = days % 30;
  if (months < 12) {
    return months + " month" + (months !== 1 ? "s" : "") + (rem > 0 ? " and " + rem + " day" + (rem !== 1 ? "s" : "") : "");
  }
  const years = Math.floor(months / 12);
  const rMonths = months % 12;
  return years + " year" + (years !== 1 ? "s" : "") + (rMonths > 0 ? " and " + rMonths + " month" + (rMonths !== 1 ? "s" : "") : "");
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) { return "Good morning"; }
  if (h < 17) { return "Good afternoon"; }
  return "Good evening";
}

function boot(session) {
  const name = (session && session.name) || "Owner";
  const accountId = (session && session.id) || "local";
  PGStore.use(accountId);
  window.PG_SESSION = { name: name, id: accountId };

  if (window.PGSheets) {
    PGSheets.use(accountId);
    PGSheets.onStatus(renderBackup);
  }

  /* Show header immediately — don't wait for anything */
  el("greet").textContent = greeting() + ", " + String(name).split(" ")[0];
  el("avatar").textContent = initials(name);
  el("avatar").title = name;
  el("stamp").textContent = new Date().toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short", year: "numeric"
  });

  /* Render from localStorage instantly (fast path) */
  renderAll();
  show(location.hash.slice(1) || "dashboard");

  /* Connect to Supabase data storage if available (async, non-blocking). */
  if (window.SupabaseStorage) {
    SupabaseStorage.init(accountId);
    if (SupabaseStorage.isAvailable()) {
      /* Startup schema check: verify every table has the columns the client
         writes BEFORE any save can hit a 42703 and lose a field. Drift is
         surfaced via the pg:storage-schema-drift event listener above. */
      SupabaseStorage.checkSchema();
      var cloudLoading = true;
      SupabaseStorage.healthCheck().then(function (ok) {
        if (!ok) {
          cloudLoading = false;
          toast("Database unreachable — changes are saved locally and will sync when it's back.", "warn", 6000);
        }
      });
      SupabaseStorage.load().then(function (data) {
        cloudLoading = false;
        if (data && data.rooms) {
          /* Data-safety merge: if the cloud copy is missing tenants/rooms that
             exist locally (e.g. the last save failed), the local state is NEWER
             for those items — merge instead of overwriting, then save the union
             back up. Prevents a failed save from erasing new tenants forever. */
          var local = PGStore.state();
          var cloudRooms = data.rooms || [];
          var localRooms = local.rooms || [];
          var cloudIds = {};
          cloudRooms.forEach(function (r) { cloudIds[r.id] = true; });
          var missing = localRooms.filter(function (r) { return !cloudIds[r.id]; });
          var localTenants = 0, cloudTenants = 0;
          localRooms.forEach(function (r) { (r.beds || []).forEach(function (b) { if (b) localTenants++; }); });
          cloudRooms.forEach(function (r) { (r.beds || []).forEach(function (b) { if (b) cloudTenants++; }); });

          if (missing.length || localTenants > cloudTenants) {
            /* Cloud is behind the browser — keep the browser's data. */
            console.warn("[boot] Cloud behind local (cloud rooms: " + cloudRooms.length +
              ", local rooms: " + localRooms.length + ") — keeping local data and re-syncing.");
            renderAll();
            toast("Using this device's data — cloud copy was out of date.", "info", 4000);
            dispatchSave();
            return;
          }
          PGStore.replaceAll(data);
          renderAll();
          toast("Synced with cloud.", "success", 2000);
        }
      }).catch(function (e) {
        cloudLoading = false;
        console.warn("Supabase load failed, using localStorage:", e);
        toast("Database unreachable — using saved local data. Will sync when it's back.", "warn", 6000);
      });
    }
  }
}

try {
  PGAuth.session().then((s) => {
    // A signed-out visitor is redirected by the gate in index.html.
    if (s.signedIn) { boot(s); }
  }, () => boot(null));
} catch (err) {
  boot(null);
}

/* ---------- session + theme ---------- */

const themeBtn = el("theme-toggle");
if (themeBtn) {
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("pgTheme", next); } catch (err) {}
  });
}

const logoutBtn = el("logout");
if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    const done = () => location.replace("login.html");
    if (window.PGAuth) {
      Promise.resolve(window.PGAuth.signOut()).then(done, done);
    } else {
      try { sessionStorage.removeItem("pgAuth"); } catch (err) {}
      done();
    }
  });
}

/* Close dropdowns on Escape, scroll, or resize */
document.addEventListener("keydown", (e) => { if (e.key === "Escape") ddCloseAll(); });
window.addEventListener("scroll", ddCloseAll, { passive: true });
window.addEventListener("resize", ddCloseAll, { passive: true });
