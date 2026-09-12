:root {
  --primary: #4F46E5;
  --bg-color: #F3F4F6;
  --surface: #FFFFFF;
  --text-main: #111827;
  --text-muted: #6B7280;
  --danger: #DC2626;
  --border: #E5E7EB;
}

* { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }

body { background-color: var(--bg-color); color: var(--text-main); }

/* Login View */
#admin-login-view {
  display: flex; justify-content: center; align-items: center; min-height: 100vh;
}
.login-card {
  background: var(--surface); padding: 2.5rem; border-radius: 12px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); width: 100%; max-width: 400px;
}
.login-card h2 { margin-bottom: 0.5rem; font-size: 1.5rem; }
.login-card p { color: var(--text-muted); margin-bottom: 2rem; font-size: 0.9rem; }

.input-group { margin-bottom: 1.5rem; }
.input-group label { display: block; margin-bottom: 0.5rem; font-weight: 500; font-size: 0.9rem; }
.input-group input { 
  width: 100%; padding: 0.75rem; border: 1px solid var(--border); 
  border-radius: 6px; outline: none; font-size: 1rem;
}
.input-group input:focus { border-color: var(--primary); }

button {
  background: var(--primary); color: white; border: none; padding: 0.75rem;
  border-radius: 6px; width: 100%; font-weight: 600; cursor: pointer; font-size: 1rem;
}
button:hover { opacity: 0.9; }

#login-error {
  margin-top: 1rem; padding: 0.75rem; background: #FEE2E2; color: var(--danger);
  border-radius: 6px; font-size: 0.9rem; text-align: center;
}

/* Dashboard View */
.admin-nav {
  background: var(--surface); padding: 1rem 2rem; display: flex;
  justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border);
}
.admin-nav h1 { font-size: 1.25rem; font-weight: 600; }
#logout-btn { background: transparent; color: var(--text-muted); border: 1px solid var(--border); width: auto; padding: 0.5rem 1rem;}
#logout-btn:hover { background: var(--bg-color); }

.dashboard-content { padding: 2rem; max-width: 1200px; margin: 0 auto; }

/* Tabs */
.tabs { display: flex; gap: 1rem; margin-bottom: 2rem; border-bottom: 1px solid var(--border); }
.tab-btn {
  background: none; color: var(--text-muted); width: auto; border-radius: 0;
  padding: 0.5rem 1rem; font-weight: 500; border-bottom: 2px solid transparent;
}
.tab-btn.active { color: var(--primary); border-bottom: 2px solid var(--primary); }
.tab-btn:hover { background: transparent; color: var(--text-main); }

/* Metrics */
.metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.5rem; }
.metric-card { background: var(--surface); padding: 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
.metric-card h3 { font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.5rem; font-weight: 500; }
.metric-card .metric-value { font-size: 2rem; font-weight: 700; }

/* Tables */
.table-container { background: var(--surface); border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
table { width: 100%; border-collapse: collapse; text-align: left; }
th, td { padding: 1rem; border-bottom: 1px solid var(--border); }
th { background: #F9FAFB; font-weight: 500; color: var(--text-muted); }
