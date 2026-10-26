/* ---------- owner tab render ---------- */

function renderAll() {
  const s = PGStore.state();
  const t = totals();
  const list = tenants();
  el("brand-prop").textContent = s.property || "Name your property";
  const bpMobile = document.getElementById("brand-prop-mobile");
  if (bpMobile) { bpMobile.textContent = s.property || "Name your property"; }
  /* Topbar — show property name on the button when set */
  var nameBtn = document.querySelector('[data-act="name-property"]');
  if (nameBtn && nameBtn.closest('.topbar-right')) {
    nameBtn.textContent = s.property || 'Name property';
  }
  
  /* Setup card: only show when property is NOT named AND no rooms exist */
  var hasRooms = s.rooms && s.rooms.length > 0;
  var hasProperty = !!(s.property && s.property.trim());
  var setupCard = el("setup");
  if (hasProperty && hasRooms) {
    /* User is set up — hide the card permanently */
    setupCard.hidden = true;
  } else {
    setupCard.hidden = false;
    /* Update setup card message based on progress */
    var setupMsg = setupCard.querySelector('.sub');
    if (setupMsg) {
      if (hasProperty) {
        setupMsg.textContent = 'Property named! Add your rooms next, then move tenants into beds.';
      } else if (hasRooms) {
        setupMsg.textContent = 'Rooms added — name your property to get started.';
      } else {
        setupMsg.textContent = 'This account is empty. Name the property, add your rooms, then move tenants into beds.';
      }
    }
    /* Show/hide individual setup actions based on state */
    var setupBtns = setupCard.querySelectorAll('[data-act]');
    setupBtns.forEach(function(btn) {
      var act = btn.getAttribute('data-act');
      if (act === 'name-property') {
        btn.style.display = hasProperty ? 'none' : '';
      } else if (act === 'add-room') {
        btn.style.display = hasRooms ? 'none' : '';
      } else {
        btn.style.display = '';
      }
    });
  }
  
  /* --- Smart button states across all tabs --- */
  var hasExpenses = (s.expenses || []).length > 0;
  var hasLedger = (s.ledger || []).length > 0;
  var hasVacant = t.vacant > 0;
  var hasTenants = list.length > 0;
  
  /* Add tenant — disable if no vacant beds */
  var addTenantBtn = document.querySelector('#view-tenants [data-act="add-tenant"]');
  if (addTenantBtn) {
    addTenantBtn.disabled = !hasVacant;
    addTenantBtn.title = hasVacant ? 'Add a new tenant' : 'No vacant beds — add a room first';
  }
  
  /* Export buttons — disable when no data */
  var exportLedger = document.querySelector('[data-act="export-ledger"]');
  if (exportLedger) {
    exportLedger.disabled = !hasLedger;
    exportLedger.title = hasLedger ? 'Export rent ledger' : 'No payment history yet';
  }
  var exportTenants = document.querySelector('[data-act="export-tenants"]');
  if (exportTenants) {
    exportTenants.disabled = !hasTenants;
    exportTenants.title = hasTenants ? 'Export tenant list' : 'No tenants yet';
  }
  var exportExpenses = document.querySelector('[data-act="export-expenses"]');
  if (exportExpenses) {
    exportExpenses.disabled = !hasExpenses;
    exportExpenses.title = hasExpenses ? 'Export expenses' : 'No expenses logged yet';
  }
  /* --- Lazy rendering: active tab first, others deferred --- */
  var activeView = location.hash.slice(1) || 'dashboard';
  
  /* Always render dashboard stats (shown in header area) */
  var alwaysFns = [renderStats];
  
  /* Map views to their render functions */
  var viewFns = {
    dashboard: [renderGraph, renderRentStatus, renderFloors, renderFeed, renderExpDashboard,
                PGAnalytics.renderHeatmap, PGAnalytics.renderRevenuePerRoom,
                PGAnalytics.renderPaymentBehavior, PGAnalytics.renderPnL],
    beds:      [renderRooms],
    tenants:   [renderTenants],
    rent:      [renderRent, PGAnalytics.renderPaymentHistory],
    expenses:  [renderExpenses],
    complaints:[renderComplaints],
    owner:     [renderOwner, renderSettings, renderRates, applyFloorSetting,
                renderOwnerActions, renderDeposits, renderRules, renderDataActions,
                PGAnalytics.renderStaffAttendance]
  };
  
  /* Render active tab immediately */
  var activeFns = viewFns[activeView] || viewFns.dashboard;
  var deferredFns = [];
  Object.keys(viewFns).forEach(function (key) {
    if (key !== activeView) {
      viewFns[key].forEach(function (fn) { deferredFns.push(fn); });
    }
  });
  
  function runFns(fns) {
    fns.forEach(function (fn) { try { fn(); } catch (err) { console.error(err); } });
  }
  
  runFns(alwaysFns.concat(activeFns));
  
  /* Defer non-active tabs to next frame so the active tab paints first */
  if (deferredFns.length) {
    requestAnimationFrame(function () { runFns(deferredFns); });
  }
}

