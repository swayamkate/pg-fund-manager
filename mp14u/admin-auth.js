const SUPER_ADMIN_EMAIL = 'iswayamkate@gmail.com';

// Use window.supabase from the CDN script to avoid variable collision
const sb = window.supabase.createClient(PG_CONFIG.SUPABASE_URL, PG_CONFIG.SUPABASE_ANON_KEY);

const loginView = document.getElementById('admin-login-view');
const dashboardView = document.getElementById('admin-dashboard-view');
const loginForm = document.getElementById('admin-login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

async function checkAuth() {
  const { data: { session }, error } = await sb.auth.getSession();
  
  if (session) {
    if (session.user.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase()) {
      showDashboard();
    } else {
      showError("Access Denied: Super Admin Only.");
      await sb.auth.signOut();
      showLogin();
    }
  } else {
    showLogin();
  }
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('admin-email').value;
  const password = document.getElementById('admin-password').value;
  
  loginError.style.display = 'none';

  if (email.toLowerCase() !== SUPER_ADMIN_EMAIL.toLowerCase()) {
    showError("Access Denied: Unrecognized Admin.");
    return;
  }

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  
  if (error) {
    showError(error.message);
  } else if (data.user) {
    showDashboard();
  }
});

logoutBtn.addEventListener('click', async () => {
  await sb.auth.signOut();
  loginForm.reset();
  showLogin();
});

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    tabPanes.forEach(p => p.style.display = 'none');
    btn.classList.add('active');
    document.getElementById(btn.dataset.target).style.display = 'block';
  });
});

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

checkAuth();

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    showLogin();
  }
});
