'use strict';

window.VoltronixNav = (() => {
  const el = id => document.getElementById(id);

  /* ──────────────────────────────────────────────────────────
     STATE
     ────────────────────────────────────────────────────────── */
  let initialized = false;

  /* ──────────────────────────────────────────────────────────
     THEME MANAGEMENT (full-site dark mode)
     ────────────────────────────────────────────────────────── */
  function applyTheme(theme) {
    const isDark = theme === 'dark';
    const dock = el('floating-dock') || el('sidebar');
    if (isDark) {
      document.body.classList.add('dark-mode');
      document.documentElement.setAttribute('data-theme', 'dark');
      dock?.classList.add('dock-theme-dark');
    } else {
      document.body.classList.remove('dark-mode');
      document.documentElement.removeAttribute('data-theme');
      dock?.classList.remove('dock-theme-dark');
    }
    try { localStorage.setItem('voltronix_theme', theme); } catch { /* storage may be unavailable */ }
  }

  function loadTheme() {
    try {
      const saved = localStorage.getItem('voltronix_theme') || 'light';
      applyTheme(saved);
    } catch {
      applyTheme('light');
    }
  }

  /* ──────────────────────────────────────────────────────────
     RBAC NAV VISIBILITY
     ────────────────────────────────────────────────────────── */
  function applyNavVisibility(sess) {
    if (!sess) return;
    const roles = Array.isArray(sess.roles) ? sess.roles : (sess.role ? [sess.role] : []);
    const isAdmin = Boolean(sess.isAdmin || sess.role === 'admin' || roles.includes('admin') || sess.access === 'full');
    const permitted = Array.isArray(sess.permittedPages) ? sess.permittedPages : (isAdmin ? ['dashboard', 'leads', 'chats', 'bills', 'billing_dashboard'] : []);

    // Administrator Dashboard: only root admin
    const navOverview = el('nav-overview');
    if (navOverview) {
      navOverview.closest('.dock-section') && (navOverview.closest('.dock-section').style.display = isAdmin ? '' : 'none');
      navOverview.style.display = isAdmin ? '' : 'none';
    }

    // Leads
    const navLeads = el('nav-leads');
    if (navLeads) {
      const canSeeLeads = isAdmin || permitted.includes('leads');
      navLeads.style.display = canSeeLeads ? '' : 'none';
    }

    // Chats
    const navChats = el('nav-chats');
    if (navChats) {
      const canSeeChats = isAdmin || permitted.includes('chats');
      navChats.style.display = canSeeChats ? '' : 'none';
    }

    // Bills
    const navBills = el('nav-bills');
    if (navBills) {
      const canSeeBills = isAdmin || permitted.includes('bills');
      navBills.style.display = canSeeBills ? '' : 'none';
    }

    // Bill Dashboard (under zoho section)
    const navBooks = el('nav-books');
    if (navBooks) {
      navBooks.style.display = (isAdmin || permitted.includes('bills') || permitted.includes('billing_dashboard')) ? '' : 'none';
    }

    // Manage Users: admin only
    const navManageUsers = el('nav-manage-users');
    if (navManageUsers) {
      navManageUsers.style.display = isAdmin ? '' : 'none';
    }

    // All navigation items are directly accessible once logged in
  }

  /* ──────────────────────────────────────────────────────────
     USER MANAGEMENT MODAL
     ────────────────────────────────────────────────────────── */
  async function fetchUsers() {
    const res = await fetch('/api/admin/users', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load users');
    const data = await res.json();
    return data.users || [];
  }

  function renderUsersTable(users, container) {
    container.innerHTML = '';
    if (!users.length) {
      container.innerHTML = `<tr class="um-empty-row"><td colspan="5">No additional users. Add one below.</td></tr>`;
      return;
    }
    for (const u of users) {
      const tr = document.createElement('tr');
      const accessBadge = `<span class="um-access-badge ${u.access}">${accessLabel(u.access)}</span>`;
      const passCell = `<span class="um-password-cell">${escHtml(u.password || '••••••')}</span>`;
      tr.innerHTML = `
        <td>${escHtml(u.username)}</td>
        <td>${accessBadge}</td>
        <td>${passCell}</td>
        <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
        <td><button class="um-del-btn" data-username="${escHtml(u.username)}" type="button">Delete</button></td>
      `;
      container.appendChild(tr);
    }

    // Bind delete buttons
    container.querySelectorAll('.um-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uname = btn.dataset.username;
        if (!confirm(`Delete user "${uname}"? This cannot be undone.`)) return;
        btn.disabled = true;
        try {
          const res = await fetch('/api/admin/users/' + encodeURIComponent(uname), {
            method: 'DELETE', credentials: 'same-origin'
          });
          const data = await res.json();
          if (data.success) {
            await reloadUsersTable(container);
          } else {
            alert('Delete failed: ' + data.message);
            btn.disabled = false;
          }
        } catch (e) {
          alert('Error: ' + e.message);
          btn.disabled = false;
        }
      });
    });
  }

  async function reloadUsersTable(container) {
    try {
      const users = await fetchUsers();
      renderUsersTable(users, container);
    } catch { /* silent */ }
  }

  function accessLabel(access) {
    return {
      lead: 'Leads', leads_chat: 'Leads + Chats',
      billing: 'Bills', billing_dashboard: 'Bills + Dashboard', full: 'Full Access'
    }[access] || access;
  }

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function initManageUsersModal() {
    const dialog = el('user-manage-dialog');
    if (!dialog) return;
    const tbody     = dialog.querySelector('#um-users-tbody');
    const form      = dialog.querySelector('#um-add-form');
    const pinInput  = dialog.querySelector('#um-password');
    const genBtn    = dialog.querySelector('#um-gen-pin');
    const msg       = dialog.querySelector('#um-msg');
    const closeBtn  = dialog.querySelector('#um-close');

    closeBtn?.addEventListener('click', () => dialog.close());

    // Generate PIN
    genBtn?.addEventListener('click', async () => {
      genBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/generate-password', { method: 'POST', credentials: 'same-origin' });
        const data = await res.json();
        if (data.success && pinInput) pinInput.value = data.password;
      } catch { if (pinInput) pinInput.value = String(Math.floor(100000 + Math.random() * 900000)); }
      finally { genBtn.disabled = false; }
    });

    // Add user form
    form?.addEventListener('submit', async e => {
      e.preventDefault();
      if (msg) { msg.textContent = ''; msg.className = 'um-msg'; }
      const username = dialog.querySelector('#um-username')?.value.trim();
      const password = pinInput?.value.trim();
      const access   = dialog.querySelector('#um-access')?.value;
      if (!username || !password) {
        if (msg) { msg.textContent = 'Username and password are required.'; msg.className = 'um-msg error'; }
        return;
      }
      const submitBtn = form.querySelector('[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await fetch('/api/admin/users', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password, access })
        });
        const data = await res.json();
        if (data.success) {
          if (msg) { msg.textContent = `✓ User "${data.user.username}" created. Password: ${data.user.password}`; msg.className = 'um-msg success'; }
          form.reset();
          await reloadUsersTable(tbody);
        } else {
          if (msg) { msg.textContent = data.message || 'Failed to create user.'; msg.className = 'um-msg error'; }
        }
      } catch (err) {
        if (msg) { msg.textContent = 'Error: ' + err.message; msg.className = 'um-msg error'; }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });

    // Open modal and load users
    const navManageBtn = el('nav-manage-users');
    navManageBtn?.addEventListener('click', async e => {
      e.preventDefault();
      if (msg) { msg.textContent = ''; msg.className = 'um-msg'; }
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--vx-text-muted);padding:1.5rem;">Loading…</td></tr>';
      if (typeof dialog.showModal === 'function') dialog.showModal();
      await reloadUsersTable(tbody);
    });
  }



  /* ──────────────────────────────────────────────────────────
     INIT NAV
     ────────────────────────────────────────────────────────── */
  function initNav({ activePage = '', pageOwnsLogout = false } = {}) {
    if (initialized) return;
    initialized = true;
    const dock = el('floating-dock') || el('sidebar');

    // 1. Load persistent theme
    loadTheme();

    // 2. Hover expand / collapse
    if (dock) {
      dock.addEventListener('mouseenter', () => {
        dock.classList.add('is-expanded');
        document.body.classList.add('dock-is-hovered');
      });
      dock.addEventListener('mouseleave', () => {
        dock.classList.remove('is-expanded');
        document.body.classList.remove('dock-is-hovered');
      });
    }

    // 3. Theme toggle button
    const themeToggle = el('dock-theme-toggle');
    if (themeToggle) {
      themeToggle.addEventListener('click', e => {
        e.stopPropagation();
        const isDark = document.body.classList.contains('dark-mode');
        applyTheme(isDark ? 'light' : 'dark');
      });
    }

    // 4. Highlight active navigation item
    if (activePage) {
      let activeEl = el('nav-' + activePage) || document.querySelector(`[data-nav="${activePage}"]`);
      if (!activeEl) {
        if (activePage === 'overview' || activePage === 'dashboard') {
          activeEl = el('nav-overview') || el('nav-dashboard');
        } else if (activePage === 'bills' || activePage === 'books') {
          activeEl = el('nav-bills') || el('nav-books');
        }
      }
      if (activeEl) {
        activeEl.classList.add('active');
        activeEl.setAttribute('aria-current', 'page');
      }
    }

    // 5. Mobile drawer toggling
    const toggle   = el('sidebar-toggle');
    const backdrop = el('sidebar-backdrop');

    if (toggle && dock) {
      toggle.addEventListener('click', () => {
        dock.classList.add('open');
        backdrop?.classList.add('active');
      });
    }

    const closeSidebar = () => {
      dock?.classList.remove('open');
      backdrop?.classList.remove('active');
    };

    el('sidebar-close')?.addEventListener('click', closeSidebar);
    backdrop?.addEventListener('click', closeSidebar);

    // 6. Settings / Security Dialog
    const settingsBtn    = el('nav-settings-btn');
    const settingsDialog = el('settings-dialog');
    const settingsClose  = el('close-settings');

    if (settingsBtn && settingsDialog) {
      settingsBtn.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/health/status');
          if (res.ok) {
            const data = await res.json();
            if (el('setting-val-backend'))  el('setting-val-backend').textContent  = data.backend  || 'ONLINE';
            if (el('setting-val-mongo'))    el('setting-val-mongo').textContent    = data.mongodb  || 'CONNECTED';
            if (el('setting-val-whatsapp')) el('setting-val-whatsapp').textContent = data.whatsapp || 'CONFIGURED';
            if (el('setting-val-crm'))      el('setting-val-crm').textContent      = data.zoho_crm || 'NOT_CONFIGURED';
          }
        } catch { /* health status is best-effort */ }
        if (typeof settingsDialog.showModal === 'function') settingsDialog.showModal();
      });
    }

    settingsClose?.addEventListener('click', () => {
      if (typeof settingsDialog?.close === 'function') settingsDialog.close();
    });

    // 7. Universal Sign Out
    const performLogout = async () => {
      try { await fetch('/api/admin/logout', { method: 'POST' }); } catch { /* redirect still clears the local view */ }
      window.location.href = '/login';
    };

    if (!pageOwnsLogout) el('lock')?.addEventListener('click', performLogout);
    el('mobile-lock')?.addEventListener('click', () => el('lock')?.click());

    el('topbar-search')?.addEventListener('keydown', event => {
      const query = event.currentTarget.value.trim();
      if (event.key === 'Enter' && query) {
        window.location.href = '/leads?' + new URLSearchParams({ search: query });
      }
    });

    // 8. User Management Modal
    initManageUsersModal();

    // 9. Initial user display (fallback defaults)
    updateUser();
  }

  /* ──────────────────────────────────────────────────────────
     UPDATE USER DISPLAY
     ────────────────────────────────────────────────────────── */
  function updateUser(userData = {}) {
    const username = userData.username || '';
    const roles    = Array.isArray(userData.roles) ? userData.roles : (userData.role ? [userData.role] : []);
    const isAdmin  = Boolean(userData.isAdmin || userData.role === 'admin' || roles.includes('admin') || userData.access === 'full');

    const avatar   = el('user-avatar-text');
    const name     = el('user-name-text');
    const roleBadge = el('user-role-badge-text');
    const topbarUser = el('topbar-username');

    if (username) {
      el('user-badge')?.removeAttribute('hidden');
      if (avatar)   avatar.textContent = username.slice(0, 2).toUpperCase();
      if (name)     name.textContent   = username;
      if (topbarUser) topbarUser.textContent = username;
      if (roleBadge) {
        if (isAdmin) {
          roleBadge.textContent = 'ADMINISTRATOR';
        } else if (roles.includes('lead') && roles.includes('chat')) {
          roleBadge.textContent = 'Leads + Chats';
        } else if (roles.includes('lead')) {
          roleBadge.textContent = 'Leads User';
        } else if (roles.includes('books')) {
          roleBadge.textContent = 'Billing User';
        } else {
          roleBadge.textContent = 'System User';
        }
      }
      el('lock')?.removeAttribute('hidden');
      el('mobile-lock')?.removeAttribute('hidden');
      if (el('setting-val-user')) el('setting-val-user').textContent = username;
      if (el('setting-val-role')) el('setting-val-role').textContent = roles.join(', ').toUpperCase();
    } else {
      if (name      && !name.textContent.trim())      name.textContent      = 'admin';
      if (roleBadge && !roleBadge.textContent.trim()) roleBadge.textContent = 'Administrator';
      if (avatar    && !avatar.textContent.trim())    avatar.textContent    = 'AD';
    }

    // Apply nav visibility
    if (userData.authenticated) applyNavVisibility(userData);
  }

  return { initNav, updateUser };
})();
