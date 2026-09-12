const SUPER_ADMIN_EMAIL = 'iswayamkate@gmail.com'; // <-- CHANGE THIS!

// Initialize Supabase (assuming PG_CONFIG is defined in ../config.js)
const supabase = supabase.createClient(PG_CONFIG.SUPABASE_URL, PG_CONFIG.SUPABASE_ANON_KEY);

// DOM Elements
const loginView = document.getElementById('admin-login-view');
const dashboardView = document.getElementById('admin-dashboard-view');
const loginForm = document.getElementById('admin-login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

// Verify Session & Bouncer Logic
async function checkAuth() {
  const { data: { session }, error } = await supabase.auth.getSession();
  
  if (session) {
    if (session.user.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase()) {
      showDashboard();
    } else {
      showError("Access Denied: Super Admin Only.");
      await supabase.auth.signOut();
      showLogin();
    }
  } else {
    showLogin();
  }
}

// Login Handler
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('admin-email').value;
  const password = document.getElementById('admin-password').value;
  
  loginError.style.display = 'none';

  // Cheap pre-check
  if (email.toLowerCase() !== SUPER_ADMIN_EMAIL.toLowerCase()) {
    showError("Access Denied: Unrecognized Admin.");
    return;
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  
  if (error) {
    showError(error.message);
  } else if (data.user) {
    showDashboard();
  }
});

// Logout Handler
logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  loginForm.reset();
  showLogin();
});

// Tab Switching Logic
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    tabPanes.forEach(p => p.style.display = 'none');
    btn.classList.add('active');
    document.getElementById(btn.dataset.target).style.display = 'block';
  });
});

// UI Helpers
function showDashboard() {
  loginView.style.display = 'none';
  dashboardView.style.display = 'block';
}

function showLogin() {
  loginView.style.display = 'flex';
  dashboardView.style.display = 'none';
}

function showError(msg) {
  loginError.textContent = msg;
  loginError.style.display = 'block';
}

// Run on load
checkAuth();

// Listen for auth changes (like closing another tab)
supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    showLogin();
  }
});
