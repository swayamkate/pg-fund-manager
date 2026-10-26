/* ---------- navigation ---------- */

function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === "view-" + view));
  document.querySelectorAll(".tab").forEach((t) => {
    const active = t.dataset.view === view;
    t.classList.toggle("is-active", active);
    if (active) { t.setAttribute("aria-current", "page"); } else { t.removeAttribute("aria-current"); }
  });
  /* Smooth scroll to top with momentum on mobile */
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

el("tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) { location.hash = tab.dataset.view; }
});

/* ---------- tenant table toggle ---------- */
var tenantToggleBtn = el('tenant-toggle');
if (tenantToggleBtn) {
  tenantToggleBtn.addEventListener('click', function () {
    _tenantsExpanded = !_tenantsExpanded;
    renderTenants();
  });
}

/* ---------- sidebar toggle ---------- */
var sidebarToggle = el('sidebar-toggle');
if (sidebarToggle) {
  sidebarToggle.addEventListener('click', function () {
    var sb = document.querySelector('.sidebar');
    var main = document.querySelector('.app-main');
    if (!sb || !main) return;
    var collapsed = sb.classList.toggle('is-collapsed');
    main.classList.toggle('sidebar-collapsed', collapsed);
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  });
}

/* Set rents save button */
var setRentBtn = el('setrents-save');
if (setRentBtn) { setRentBtn.addEventListener('click', saveSetRents); }

/* Complaint filter pills */
var compFilters = el("comp-filters");
if (compFilters) {
  compFilters.addEventListener("click", (e) => {
    const pill = e.target.closest(".pill");
    if (!pill) return;
    compFilters.querySelectorAll(".pill").forEach((p) => p.classList.remove("is-active"));
    pill.classList.add("is-active");
    renderComplaints();
  });
}

window.addEventListener("hashchange", () => show(location.hash.slice(1) || "dashboard"));

