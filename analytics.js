/* PG Manager — Analytics & Reports
   Monthly heatmap, P&L, revenue per room, payment behavior, export PDF.
   Depends on PGStore (store.js) being loaded first. */

(function (global) {
  "use strict";

  /* ---- helpers ---- */
  function el(id) { return document.getElementById(id); }
  function esc(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function money(n) { return "\u20b9" + Number(n || 0).toLocaleString("en-IN"); }

  function thisMonth() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }

  function monthLabel(key) {
    var parts = key.split("-");
    var names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return names[parseInt(parts[1], 10) - 1] + " " + parts[0];
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  /* ================================================================
     1. MONTHLY COLLECTION HEATMAP
     ================================================================ */

  function renderHeatmap() {
    var container = el("heatmap-container");
    if (!container) return;

    var s = PGStore.state();
    var rooms = s.rooms || [];
    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var today = now.getDate();

    /* Build payment map: day → amount collected */
    var dayMap = {};
    rooms.forEach(function (room) {
      (room.beds || []).forEach(function (bed) {
        if (!bed) return;
        (bed.paidMonths || []).forEach(function (mk) {
          var parts = mk.split("-");
          if (parseInt(parts[0], 10) === year && parseInt(parts[1], 10) === month + 1) {
            /* Mark the 1st as payment day (we don't have exact day, so use 1st) */
            var day = 1;
            dayMap[day] = (dayMap[day] || 0) + (bed.rent || room.rent || 0);
          }
        });
      });
    });

    /* Also check expenses by date */
    var expMap = {};
    (s.expenses || []).forEach(function (e) {
      if (!e.date) return;
      var d = new Date(e.date);
      if (d.getFullYear() === year && d.getMonth() === month) {
        var day = d.getDate();
        expMap[day] = (expMap[day] || 0) + (e.amount || 0);
      }
    });

    /* Find max for scaling */
    var maxCol = 0;
    Object.values(dayMap).forEach(function (v) { if (v > maxCol) maxCol = v; });
    var maxExp = 0;
    Object.values(expMap).forEach(function (v) { if (v > maxExp) maxExp = v; });

    /* Build calendar grid */
    var firstDay = new Date(year, month, 1).getDay(); /* 0=Sun */
    var html = '<div class="heatmap-header">';
    html += '<h3>' + monthLabel(year + "-" + pad2(month + 1)) + ' Collection Heatmap</h3>';
    html += '<span class="muted-sm">Daily rent collection intensity</span>';
    html += '</div>';
    html += '<div class="heatmap-days-header">';
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(function (d) {
      html += '<span>' + d + '</span>';
    });
    html += '</div>';
    html += '<div class="heatmap-grid">';

    /* Empty cells before month starts */
    for (var e = 0; e < firstDay; e++) {
      html += '<div class="heatmap-cell heatmap-empty"></div>';
    }

    for (var day = 1; day <= daysInMonth; day++) {
      var amt = dayMap[day] || 0;
      var exp = expMap[day] || 0;
      var intensity = maxCol > 0 ? amt / maxCol : 0;
      var cls = "heatmap-cell";
      if (day <= today) {
        if (intensity > 0.75) cls += " heatmap-high";
        else if (intensity > 0.4) cls += " heatmap-mid";
        else if (intensity > 0) cls += " heatmap-low";
        else cls += " heatmap-none";
      } else {
        cls += " heatmap-future";
      }
      if (day === today) cls += " heatmap-today";

      var tip = day + " " + monthLabel(year + "-" + pad2(month + 1));
      if (amt > 0) tip += "\\nCollected: " + money(amt);
      if (exp > 0) tip += "\\nExpenses: " + money(exp);

      html += '<div class="' + cls + '" title="' + tip + '">';
      html += '<span class="heatmap-day">' + day + '</span>';
      if (amt > 0) html += '<span class="heatmap-amt">' + money(amt) + '</span>';
      html += '</div>';
    }

    html += '</div>';
    html += '<div class="heatmap-legend">';
    html += '<span><span class="key heatmap-low"></span> Low</span>';
    html += '<span><span class="key heatmap-mid"></span> Medium</span>';
    html += '<span><span class="key heatmap-high"></span> High</span>';
    html += '<span><span class="key heatmap-none"></span> None</span>';
    html += '</div>';

    container.innerHTML = html;
  }

  /* ================================================================
     2. PROFIT & LOSS STATEMENT
     ================================================================ */

  function renderPnL() {
    var container = el("pnl-container");
    if (!container) return;

    var s = PGStore.state();
    var rooms = s.rooms || [];
    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth();

    /* Calculate income from paid months */
    var totalIncome = 0;
    var monthIncome = 0;
    var rooms_data = [];

    rooms.forEach(function (room) {
      var roomIncome = 0;
      var roomMonthIncome = 0;
      (room.beds || []).forEach(function (bed) {
        if (!bed) return;
        var rent = bed.rent || room.rent || 0;
        (bed.paidMonths || []).forEach(function (mk) {
          var parts = mk.split("-");
          if (parseInt(parts[0], 10) === year) {
            roomIncome += rent;
            if (parseInt(parts[1], 10) === month + 1) {
              roomMonthIncome += rent;
            }
          }
        });
      });
      totalIncome += roomIncome;
      monthIncome += roomMonthIncome;
      if (roomIncome > 0) {
        rooms_data.push({ name: "Room " + room.no, income: roomIncome, monthIncome: roomMonthIncome });
      }
    });

    /* Calculate deposits collected */
    var totalDeposits = 0;
    rooms.forEach(function (room) {
      (room.beds || []).forEach(function (bed) {
        if (bed && bed.deposit) totalDeposits += bed.deposit;
      });
    });

    /* Calculate expenses */
    var totalExpenses = 0;
    var monthExpenses = 0;
    var catMap = {};
    (s.expenses || []).forEach(function (e) {
      totalExpenses += e.amount || 0;
      var cat = e.category || "Other";
      catMap[cat] = (catMap[cat] || 0) + (e.amount || 0);
      var d = new Date(e.date);
      if (d.getFullYear() === year && d.getMonth() === month) {
        monthExpenses += e.amount || 0;
      }
    });

    var netProfit = totalIncome - totalExpenses;
    var monthNet = monthIncome - monthExpenses;
    var profitMargin = totalIncome > 0 ? Math.round((netProfit / totalIncome) * 100) : 0;

    var html = '<div class="pnl-header">';
    html += '<h3>Profit & Loss Statement</h3>';
    html += '<span class="muted-sm">FY ' + year + '-' + (year + 1) + '</span>';
    html += '</div>';

    /* Summary cards */
    html += '<div class="pnl-summary">';
    html += '<div class="pnl-card pnl-income">';
    html += '<span class="pnl-label">Total Income (FY)</span>';
    html += '<span class="pnl-value">' + money(totalIncome) + '</span>';
    html += '<span class="pnl-sub">This month: ' + money(monthIncome) + '</span>';
    html += '</div>';
    html += '<div class="pnl-card pnl-expense">';
    html += '<span class="pnl-label">Total Expenses (FY)</span>';
    html += '<span class="pnl-value">' + money(totalExpenses) + '</span>';
    html += '<span class="pnl-sub">This month: ' + money(monthExpenses) + '</span>';
    html += '</div>';
    html += '<div class="pnl-card ' + (netProfit >= 0 ? "pnl-profit" : "pnl-loss") + '">';
    html += '<span class="pnl-label">Net ' + (netProfit >= 0 ? "Profit" : "Loss") + ' (FY)</span>';
    html += '<span class="pnl-value">' + money(Math.abs(netProfit)) + '</span>';
    html += '<span class="pnl-sub">Margin: ' + profitMargin + '%</span>';
    html += '</div>';
    html += '<div class="pnl-card">';
    html += '<span class="pnl-label">Security Deposits</span>';
    html += '<span class="pnl-value">' + money(totalDeposits) + '</span>';
    html += '<span class="pnl-sub">Held from ' + rooms.reduce(function (s, r) { return s + r.beds.filter(Boolean).length; }, 0) + ' tenants</span>';
    html += '</div>';
    html += '</div>';

    /* Expense breakdown */
    var cats = Object.keys(catMap).sort(function (a, b) { return catMap[b] - catMap[a]; });
    if (cats.length) {
      html += '<div class="pnl-breakdown">';
      html += '<h4>Expense Breakdown</h4>';
      cats.forEach(function (cat) {
        var pct = totalExpenses > 0 ? Math.round((catMap[cat] / totalExpenses) * 100) : 0;
        html += '<div class="pnl-row">';
        html += '<span class="pnl-cat">' + esc(cat) + '</span>';
        html += '<div class="pnl-bar-wrap"><div class="pnl-bar" style="width:' + pct + '%"></div></div>';
        html += '<span class="pnl-cat-amt">' + money(catMap[cat]) + ' <small>(' + pct + '%)</small></span>';
        html += '</div>';
      });
      html += '</div>';
    }

    container.innerHTML = html;
  }

  /* ================================================================
     3. REVENUE PER ROOM
     ================================================================ */

  function renderRevenuePerRoom() {
    var container = el("revenue-room-container");
    if (!container) return;

    var s = PGStore.state();
    var rooms = s.rooms || [];
    var now = new Date();
    var year = now.getFullYear();

    var rooms_data = [];
    rooms.forEach(function (room) {
      var totalRent = 0;
      var paidMonths = 0;
      (room.beds || []).forEach(function (bed) {
        if (!bed) return;
        var rent = bed.rent || room.rent || 0;
        var months = (bed.paidMonths || []).filter(function (mk) {
          return parseInt(mk.split("-")[0], 10) === year;
        });
        totalRent += rent * months.length;
        paidMonths += months.length;
      });
      rooms_data.push({
        no: room.no,
        id: room.id,
        total: totalRent,
        beds: room.beds.length,
        occupied: room.beds.filter(Boolean).length,
        paidMonths: paidMonths,
        rent: room.rent
      });
    });

    rooms_data.sort(function (a, b) { return b.total - a.total; });
    var maxTotal = rooms_data.length ? rooms_data[0].total : 1;

    var html = '<div class="rev-header">';
    html += '<h3>Revenue by Room (' + year + ')</h3>';
    html += '</div>';

    if (!rooms_data.length) {
      html += '<p class="muted-sm" style="text-align:center;padding:20px">No rooms yet</p>';
    } else {
      html += '<div class="rev-list">';
      rooms_data.forEach(function (r, i) {
        var pct = maxTotal > 0 ? (r.total / maxTotal) * 100 : 0;
        var medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "";
        html += '<div class="rev-row">';
        html += '<span class="rev-rank">' + (medal || (i + 1)) + '</span>';
        html += '<div class="rev-info">';
        html += '<span class="rev-name">Room ' + esc(r.no) + '</span>';
        html += '<span class="rev-meta">' + r.occupied + '/' + r.beds + ' beds · ' + money(r.rent) + '/mo</span>';
        html += '</div>';
        html += '<div class="rev-bar-wrap"><div class="rev-bar" style="width:' + pct + '%"></div></div>';
        html += '<span class="rev-amt">' + money(r.total) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }

    container.innerHTML = html;
  }

  /* ================================================================
     4. PAYMENT BEHAVIOR
     ================================================================ */

  function renderPaymentBehavior() {
    var container = el("payment-behavior-container");
    if (!container) return;

    var s = PGStore.state();
    var rooms = s.rooms || [];

    /* Analyze each tenant's payment pattern */
    var tenants = [];
    rooms.forEach(function (room) {
      (room.beds || []).forEach(function (bed) {
        if (!bed) return;
        var paid = (bed.paidMonths || []).slice().sort();
        var joined = bed.joined ? new Date(bed.joined) : null;
        if (!joined) return;

        /* Calculate months since joining */
        var now = new Date();
        var monthsSinceJoin = (now.getFullYear() - joined.getFullYear()) * 12 + (now.getMonth() - joined.getMonth());
        if (monthsSinceJoin < 1) monthsSinceJoin = 1;

        var paidCount = paid.length;
        var ratio = paidCount / monthsSinceJoin;
        var status = ratio >= 1 ? "excellent" : ratio >= 0.75 ? "good" : ratio >= 0.5 ? "fair" : "poor";

        tenants.push({
          name: bed.name,
          room: room.no,
          rent: bed.rent || room.rent || 0,
          paidMonths: paidCount,
          totalMonths: monthsSinceJoin,
          ratio: ratio,
          status: status,
          deposit: bed.deposit || 0
        });
      });
    });

    /* Categorize */
    var excellent = tenants.filter(function (t) { return t.status === "excellent"; });
    var good = tenants.filter(function (t) { return t.status === "good"; });
    var fair = tenants.filter(function (t) { return t.status === "fair"; });
    var poor = tenants.filter(function (t) { return t.status === "poor"; });

    var html = '<div class="pb-header">';
    html += '<h3>Payment Behavior</h3>';
    html += '<span class="muted-sm">' + tenants.length + ' tenants analyzed</span>';
    html += '</div>';

    /* Summary cards */
    html += '<div class="pb-summary">';
    html += '<div class="pb-card pb-excellent">';
    html += '<span class="pb-count">' + excellent.length + '</span>';
    html += '<span class="pb-label">Excellent</span>';
    html += '<span class="pb-desc">100% on time</span>';
    html += '</div>';
    html += '<div class="pb-card pb-good">';
    html += '<span class="pb-count">' + good.length + '</span>';
    html += '<span class="pb-label">Good</span>';
    html += '<span class="pb-desc">75%+ on time</span>';
    html += '</div>';
    html += '<div class="pb-card pb-fair">';
    html += '<span class="pb-count">' + fair.length + '</span>';
    html += '<span class="pb-label">Fair</span>';
    html += '<span class="pb-desc">50-74% on time</span>';
    html += '</div>';
    html += '<div class="pb-card pb-poor">';
    html += '<span class="pb-count">' + poor.length + '</span>';
    html += '<span class="pb-label">Needs Attention</span>';
    html += '<span class="pb-desc">Under 50%</span>';
    html += '</div>';
    html += '</div>';

    /* Tenant list */
    if (tenants.length) {
      html += '<div class="pb-list">';
      tenants.sort(function (a, b) { return a.ratio - b.ratio; }).forEach(function (t) {
        var icon = t.status === "excellent" ? "✅" : t.status === "good" ? "👍" : t.status === "fair" ? "⚠️" : "❌";
        html += '<div class="pb-row pb-' + t.status + '">';
        html += '<span class="pb-icon">' + icon + '</span>';
        html += '<div class="pb-info">';
        html += '<span class="pb-name">' + esc(t.name) + '</span>';
        html += '<span class="pb-room">Room ' + esc(t.room) + ' · ' + money(t.rent) + '/mo</span>';
        html += '</div>';
        html += '<div class="pb-stats">';
        html += '<span class="pb-paid">' + t.paidMonths + '/' + t.totalMonths + ' months</span>';
        html += '<div class="pb-ratio-bar"><div class="pb-ratio-fill" style="width:' + Math.round(t.ratio * 100) + '%"></div></div>';
        html += '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    container.innerHTML = html;
  }

  /* ================================================================
     5. WHATSAPP RENT REMINDER
     ================================================================ */

  function sendWhatsAppReminder(phone, name, rent, roomNo) {
    if (!phone) {
      /* No phone — try to find one from the tenant */
      alert("No phone number saved for " + name + ". Add one in their profile first.");
      return;
    }

    /* Clean phone number */
    var cleanPhone = phone.replace(/[^0-9+]/g, "");
    if (cleanPhone.length < 10) {
      alert("Invalid phone number for " + name);
      return;
    }

    /* Add country code if missing */
    if (!cleanPhone.startsWith("+")) {
      cleanPhone = "+91" + cleanPhone;
    }

    var monthNames = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    var now = new Date();
    var monthName = monthNames[now.getMonth()];
    var year = now.getFullYear();

    var msg = "Hi " + name + "! 👋\n\n";
    msg += "This is a friendly reminder that your rent for " + monthName + " " + year + " is due.\n\n";
    msg += "📋 Room: " + roomNo + "\n";
    msg += "💰 Amount: ₹" + (rent || 0).toLocaleString("en-IN") + "\n\n";
    msg += "Please make the payment at your earliest convenience.\n";
    msg += "Thank you! 🙏";

    var url = "https://wa.me/" + cleanPhone.replace("+", "") + "?text=" + encodeURIComponent(msg);
    window.open(url, "_blank");
  }

  /* ================================================================
     6. STAFF ATTENDANCE
     ================================================================ */

  function renderStaffAttendance() {
    var container = el("staff-attendance-container");
    if (!container) return;

    /* Load from localStorage */
    var key = "pg_staff_" + (PGStore.state().property || "default");
    var records = [];
    try { records = JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { records = []; }

    var today = new Date().toISOString().slice(0, 10);
    var todayRecords = records.filter(function (r) { return r.date === today; });

    var html = '<div class="staff-header">';
    html += '<h3>Staff Attendance</h3>';
    html += '<button class="link-btn" type="button" onclick="PGAnalytics.addStaff()">+ Add staff</button>';
    html += '</div>';

    /* Today's attendance */
    html += '<div class="staff-today">';
    html += '<h4>Today (' + today + ')</h4>';

    if (!todayRecords.length) {
      html += '<p class="muted-sm" style="padding:12px 0">No staff marked today. Click "Add staff" to begin.</p>';
    } else {
      html += '<div class="staff-grid">';
      todayRecords.forEach(function (r, i) {
        var cls = r.present ? "staff-present" : "staff-absent";
        html += '<div class="staff-card ' + cls + '">';
        html += '<span class="staff-avatar">' + (r.name || "?")[0].toUpperCase() + '</span>';
        html += '<span class="staff-name">' + esc(r.name) + '</span>';
        html += '<span class="staff-role">' + esc(r.role || "Staff") + '</span>';
        html += '<div class="staff-actions">';
        html += '<button class="staff-btn ' + (r.present ? "active" : "") + '" onclick="PGAnalytics.markAttendance(\'' + esc(r.name) + '\', true, \'' + today + '\')">✓ Present</button>';
        html += '<button class="staff-btn ' + (!r.present ? "active absent" : "") + '" onclick="PGAnalytics.markAttendance(\'' + esc(r.name) + '\', false, \'' + today + '\')">✗ Absent</button>';
        html += '<button class="staff-btn remove" onclick="PGAnalytics.removeStaff(\'' + esc(r.name) + '\', \'' + today + '\')">🗑</button>';
        html += '</div>';
        html += '</div>';
      });
      html += '</div>';
    }
    html += '</div>';

    /* Attendance history (last 7 days) */
    var dates = [];
    for (var d = 0; d < 7; d++) {
      var dt = new Date();
      dt.setDate(dt.getDate() - d);
      dates.push(dt.toISOString().slice(0, 10));
    }

    /* Get unique staff names */
    var staffNames = [];
    records.forEach(function (r) {
      if (staffNames.indexOf(r.name) === -1) staffNames.push(r.name);
    });

    if (staffNames.length) {
      html += '<div class="staff-history">';
      html += '<h4>Last 7 days</h4>';
      html += '<div class="staff-table-wrap"><table class="staff-table">';
      html += '<thead><tr><th>Staff</th>';
      dates.forEach(function (d) {
        html += '<th>' + d.slice(5) + '</th>';
      });
      html += '</tr></thead><tbody>';

      staffNames.forEach(function (name) {
        html += '<tr><td class="staff-tname">' + esc(name) + '</td>';
        dates.forEach(function (d) {
          var rec = records.find(function (r) { return r.name === name && r.date === d; });
          if (!rec) {
            html += '<td class="staff-na">—</td>';
          } else if (rec.present) {
            html += '<td class="staff-p">✓</td>';
          } else {
            html += '<td class="staff-a">✗</td>';
          }
        });
        html += '</tr>';
      });
      html += '</tbody></table></div>';
      html += '</div>';
    }

    container.innerHTML = html;
  }

  function addStaff() {
    var name = prompt("Staff member name:");
    if (!name || !name.trim()) return;
    name = name.trim();

    var role = prompt("Role (e.g., Housekeeping, Cook, Guard):") || "Staff";

    var key = "pg_staff_" + (PGStore.state().property || "default");
    var records = [];
    try { records = JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { records = []; }

    var today = new Date().toISOString().slice(0, 10);
    records.push({ name: name, role: role, date: today, present: true });
    localStorage.setItem(key, JSON.stringify(records));

    renderStaffAttendance();
  }

  function markAttendance(name, present, date) {
    var key = "pg_staff_" + (PGStore.state().property || "default");
    var records = [];
    try { records = JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { records = []; }

    /* Find existing or add */
    var existing = records.find(function (r) { return r.name === name && r.date === date; });
    if (existing) {
      existing.present = present;
    } else {
      records.push({ name: name, present: present, date: date, role: "Staff" });
    }
    localStorage.setItem(key, JSON.stringify(records));
    renderStaffAttendance();
  }

  function removeStaff(name, date) {
    var key = "pg_staff_" + (PGStore.state().property || "default");
    var records = [];
    try { records = JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { records = []; }
    records = records.filter(function (r) { return !(r.name === name && r.date === date); });
    localStorage.setItem(key, JSON.stringify(records));
    renderStaffAttendance();
  }

  /* ================================================================
     7. EXPORT TO PDF (using browser print)
     ================================================================ */

  function exportPDF() {
    /* Open print dialog with a formatted report */
    var s = PGStore.state();
    var rooms = s.rooms || [];
    var now = new Date();
    var year = now.getFullYear();
    var month = now.getMonth();
    var monthNames = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];

    /* Gather data */
    var totalBeds = 0, occupiedBeds = 0, totalIncome = 0, totalDeposits = 0;
    var tenantRows = [];
    var expTotal = 0;

    rooms.forEach(function (room) {
      totalBeds += room.beds.length;
      (room.beds || []).forEach(function (bed) {
        if (!bed) return;
        occupiedBeds++;
        var rent = bed.rent || room.rent || 0;
        var paidCount = (bed.paidMonths || []).length;
        totalIncome += rent * paidCount;
        totalDeposits += bed.deposit || 0;
        tenantRows.push({
          name: bed.name,
          room: room.no,
          rent: rent,
          deposit: bed.deposit || 0,
          joined: bed.joined || "",
          paid: paidCount,
          status: (bed.paidMonths || []).indexOf(year + "-" + pad2(month + 1)) !== -1 ? "Paid" : "Due"
        });
      });
    });

    (s.expenses || []).forEach(function (e) { expTotal += e.amount || 0; });

    /* Build print HTML */
    var printHtml = '<!DOCTYPE html><html><head><title>PG Report - ' + s.property + '</title>';
    printHtml += '<style>';
    printHtml += 'body{font-family:Arial,sans-serif;padding:30px;color:#222;font-size:13px}';
    printHtml += 'h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:20px 0 8px;border-bottom:2px solid #2563EB;padding-bottom:4px}';
    printHtml += '.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}';
    printHtml += '.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}';
    printHtml += '.scard{background:#f8f9fa;border:1px solid #e5e7eb;border-radius:8px;padding:12px;text-align:center}';
    printHtml += '.scard .val{font-size:20px;font-weight:700;color:#2563EB;display:block}';
    printHtml += '.scard .lbl{font-size:11px;color:#666;text-transform:uppercase}';
    printHtml += 'table{width:100%;border-collapse:collapse;margin-bottom:16px}';
    printHtml += 'th{background:#f1f5f9;text-align:left;padding:8px 10px;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb}';
    printHtml += 'td{padding:7px 10px;border-bottom:1px solid #f1f5f9}';
    printHtml += '.paid{color:#059669;font-weight:600}.due{color:#DC4444;font-weight:600}';
    printHtml += '.footer{margin-top:30px;text-align:center;color:#999;font-size:11px;border-top:1px solid #e5e7eb;padding-top:10px}';
    printHtml += '@media print{body{padding:15px}}';
    printHtml += '</style></head><body>';

    printHtml += '<div class="header"><div><h1>' + esc(s.property || "PG Property") + '</h1>';
    printHtml += '<p style="color:#666;margin:0">Monthly Report — ' + monthNames[month] + ' ' + year + '</p></div>';
    printHtml += '<div style="text-align:right"><p style="margin:0;font-size:11px;color:#999">Generated: ' + now.toLocaleDateString("en-IN") + '</p></div></div>';

    printHtml += '<div class="summary">';
    printHtml += '<div class="scard"><span class="val">' + occupiedBeds + '/' + totalBeds + '</span><span class="lbl">Occupied</span></div>';
    printHtml += '<div class="scard"><span class="val">₹' + totalIncome.toLocaleString("en-IN") + '</span><span class="lbl">Total Income</span></div>';
    printHtml += '<div class="scard"><span class="val">₹' + expTotal.toLocaleString("en-IN") + '</span><span class="lbl">Expenses</span></div>';
    printHtml += '<div class="scard"><span class="val">₹' + (totalIncome - expTotal).toLocaleString("en-IN") + '</span><span class="lbl">Net Profit</span></div>';
    printHtml += '</div>';

    printHtml += '<h2>Tenant List (' + tenantRows.length + ')</h2>';
    printHtml += '<table><thead><tr><th>Name</th><th>Room</th><th>Rent</th><th>Deposit</th><th>Joined</th><th>Months Paid</th><th>Status</th></tr></thead><tbody>';
    tenantRows.forEach(function (t) {
      printHtml += '<tr><td>' + esc(t.name) + '</td><td>' + esc(t.room) + '</td>';
      printHtml += '<td>₹' + t.rent.toLocaleString("en-IN") + '</td>';
      printHtml += '<td>₹' + t.deposit.toLocaleString("en-IN") + '</td>';
      printHtml += '<td>' + esc(t.joined) + '</td><td>' + t.paid + '</td>';
      printHtml += '<td class="' + (t.status === "Paid" ? "paid" : "due") + '">' + t.status + '</td></tr>';
    });
    printHtml += '</tbody></table>';

    if (s.expenses && s.expenses.length) {
      printHtml += '<h2>Expenses (' + s.expenses.length + ')</h2>';
      printHtml += '<table><thead><tr><th>Date</th><th>Category</th><th>Amount</th><th>Note</th></tr></thead><tbody>';
      s.expenses.slice().sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); }).forEach(function (e) {
        printHtml += '<tr><td>' + esc(e.date) + '</td><td>' + esc(e.category) + '</td>';
        printHtml += '<td>₹' + (e.amount || 0).toLocaleString("en-IN") + '</td><td>' + esc(e.note || "") + '</td></tr>';
      });
      printHtml += '</tbody></table>';
    }

    printHtml += '<div class="footer">Generated by PG Manager · ' + now.toLocaleDateString("en-IN") + '</div>';
    printHtml += '</body></html>';

    /* Open in new window and print */
    var win = window.open("", "_blank");
    if (win) {
      win.document.write(printHtml);
      win.document.close();
      setTimeout(function () { win.print(); }, 500);
    } else {
      alert("Pop-up blocked. Please allow pop-ups for this site to export PDF.");
    }
  }

  /* ================================================================
     PUBLIC API
     ================================================================ */

  global.PGAnalytics = {
    renderHeatmap: renderHeatmap,
    renderPnL: renderPnL,
    renderRevenuePerRoom: renderRevenuePerRoom,
    renderPaymentBehavior: renderPaymentBehavior,
    renderStaffAttendance: renderStaffAttendance,
    sendWhatsAppReminder: sendWhatsAppReminder,
    addStaff: addStaff,
    markAttendance: markAttendance,
    removeStaff: removeStaff,
    exportPDF: exportPDF
  };

})(window);
