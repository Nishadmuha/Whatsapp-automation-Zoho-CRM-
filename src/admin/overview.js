'use strict';

(() => {
  const el = id => document.getElementById(id);
  const text = value => value === null || value === undefined || value === '' ? '—' : String(value);
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('en-CA') : '—';
  const dateTime = value => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('en-AE', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const number = value => Number(value || 0).toLocaleString('en-AE');
  const formatAed = value => `AED ${Number(value || 0).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const statusLabel = value => text(value).replaceAll('_', ' ').toUpperCase();
  const healthKeys = ['backend', 'webhook', 'mongodb', 'whatsapp', 'ai', 'zoho_crm'];
  let recentBills = [];
  let latestHealth = null;

  function fetchJson(path) {
    return fetch(path, { credentials: 'same-origin', cache: 'no-store' }).then(response => {
      if (!response.ok) throw Object.assign(new Error(`Request failed: ${response.status}`), { status: response.status });
      return response.json();
    });
  }

  function setText(id, value) { if (el(id)) el(id).textContent = text(value); }

  function clearPlaceholders() {
    ['overview-leads-rows', 'overview-bills-rows', 'overview-activity-list'].forEach(id => el(id)?.replaceChildren());
    document.querySelectorAll('.bar-fill').forEach(bar => { bar.style.height = '0%'; });
  }

  function renderEmpty(tbody, colspan, label = 'No records found') {
    if (!tbody) return;
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = colspan;
    cell.textContent = label;
    row.append(cell);
    tbody.replaceChildren(row);
  }

  function renderLeads(items) {
    const tbody = el('overview-leads-rows');
    if (!tbody) return;
    if (!Array.isArray(items) || !items.length) return renderEmpty(tbody, 4);
    const rows = items.slice(0, 4).map(lead => {
      const row = document.createElement('tr');
      const contact = document.createElement('td');
      contact.className = 'td-contact';
      contact.textContent = lead.company_name || lead.contact_name || lead.phone || '—';
      const project = document.createElement('td');
      project.className = 'td-project';
      project.textContent = lead.project_location || lead.requirement || lead.notes || '—';
      const activity = document.createElement('td');
      activity.textContent = date(lead.updated_at || lead.created_at);
      const status = document.createElement('td');
      const badge = document.createElement('span');
      const value = statusLabel(lead.validation_status || lead.extraction_status || lead.status);
      badge.className = ['VALID', 'COMPLETED', 'NEW', 'SAVED'].includes(value) ? 'badge-new' : 'badge-dark-pill';
      badge.textContent = value;
      status.append(badge);
      row.append(contact, project, activity, status);
      return row;
    });
    tbody.replaceChildren(...rows);
  }

  function renderBills(items) {
    const tbody = el('overview-bills-rows');
    if (!tbody) return;
    recentBills = Array.isArray(items) ? items : [];
    if (!recentBills.length) return renderEmpty(tbody, 6);
    const rows = recentBills.slice(0, 5).map(bill => {
      const row = document.createElement('tr');
      const id = document.createElement('td');
      id.className = 'td-bill-id';
      id.textContent = bill.bill_number || bill.bill_id || '—';
      const vendor = document.createElement('td');
      vendor.className = 'td-vendor';
      vendor.textContent = bill.vendor_name || '—';
      const billDate = document.createElement('td');
      billDate.className = 'td-date';
      billDate.textContent = date(bill.bill_date || bill.created_at);
      const category = document.createElement('td');
      const categoryPill = document.createElement('span');
      categoryPill.className = 'cat-border-pill';
      categoryPill.textContent = statusLabel(bill.category || '—');
      category.append(categoryPill);
      const amount = document.createElement('td');
      amount.className = 'td-amount';
      amount.textContent = formatAed(bill.total_amount);
      const status = document.createElement('td');
      status.className = 'status-dot-cell';
      const synced = ['SYNCED', 'COMPLETED'].includes(String(bill.zoho_status || bill.status || '').toUpperCase());
      const dot = document.createElement('span');
      dot.className = synced ? 'dot-black' : 'dot-red';
      status.append(dot, document.createTextNode(` ${statusLabel(bill.zoho_status || bill.status)}`));
      row.append(id, vendor, billDate, category, amount, status);
      return row;
    });
    tbody.replaceChildren(...rows);
  }

  function renderActivity(bills) {
    const list = el('overview-activity-list');
    if (!list) return;
    if (!bills.length) {
      const item = document.createElement('div');
      item.className = 'activity-item';
      item.textContent = 'No recent bill activity';
      return list.replaceChildren(item);
    }
    const nodes = bills.slice(0, 5).map(bill => {
      const item = document.createElement('div');
      item.className = 'activity-item';
      const icon = document.createElement('div');
      icon.className = 'activity-icon-box';
      icon.textContent = '↗';
      const content = document.createElement('div');
      content.className = 'activity-content';
      const actor = document.createElement('div');
      actor.className = 'activity-actor';
      actor.textContent = bill.vendor_name || 'Bill automation';
      const target = document.createElement('div');
      target.className = 'activity-target';
      target.textContent = `${bill.bill_number || bill.bill_id || 'Bill'} · ${statusLabel(bill.zoho_status || bill.status)}`;
      const when = document.createElement('div');
      when.className = 'activity-time';
      when.textContent = dateTime(bill.updated_at || bill.created_at || bill.bill_date);
      content.append(actor, target, when);
      item.append(icon, content);
      return item;
    });
    list.replaceChildren(...nodes);
  }

  function renderChart(bills) {
    const bars = [...document.querySelectorAll('.bar-fill')];
    const counts = Array(7).fill(0);
    const today = new Date();
    bills.forEach(bill => {
      const parsed = new Date(bill.bill_date || bill.created_at || bill.updated_at);
      const age = Math.floor((today - parsed) / 86400000);
      if (!Number.isNaN(parsed.getTime()) && age >= 0 && age < 7) counts[6 - age] += 1;
    });
    const max = Math.max(...counts, 1);
    bars.forEach((bar, index) => { bar.style.height = `${(counts[index] / max) * 80}%`; });
  }

  function healthStatus(value) {
    return ['healthy', 'error', 'not_configured', 'warning', 'unknown'].includes(value) ? value : 'unknown';
  }

  function applyStatusClass(node, status) {
    if (!node?.classList) return;
    node.classList.remove('status-healthy', 'status-error', 'status-not_configured', 'status-warning', 'status-unknown');
    node.classList.add(`status-${healthStatus(status)}`);
  }

  function fallbackHealthComponent(key, health = {}) {
    const values = {
      backend: [health.backend || 'ONLINE', 'Backend', 'The backend health endpoint is responding normally.'],
      webhook: ['READY', 'Webhook', 'The signed WhatsApp webhook route is registered and ready to accept requests.'],
      mongodb: [health.mongodb || 'UNKNOWN', 'MongoDB', 'MongoDB status is unavailable.'],
      whatsapp: [health.whatsapp || 'UNKNOWN', 'WhatsApp', 'WhatsApp status is unavailable.'],
      ai: [health.openai || 'UNKNOWN', 'AI', 'AI status is unavailable.'],
      zoho_crm: [health.zoho_crm || 'UNKNOWN', 'Zoho CRM', 'Zoho CRM status is unavailable.'],
    };
    const [label, area, message] = values[key] || ['UNKNOWN', key, 'No diagnostic information is available.'];
    const status = /DISCONNECTED|ERROR|FAILED/i.test(label)
      ? 'error' : /NOT_CONFIGURED|NOT CONFIGURED/i.test(label) ? 'not_configured' : 'unknown';
    return { status, label: status === 'unknown' ? label : label.replaceAll('_', ' '), area, message };
  }

  function showHealthDetail(key) {
    const component = latestHealth?.components?.[key] || fallbackHealthComponent(key, latestHealth || {});
    const panel = el('settings-health-detail');
    const status = el('setting-health-status');
    const area = el('setting-health-area');
    const message = el('setting-health-message');
    const code = el('setting-health-code');
    if (panel) panel.hidden = false;
    if (status) {
      status.textContent = component.label || 'UNKNOWN';
      applyStatusClass(status, component.status);
    }
    if (area) area.textContent = component.area || key;
    if (message) message.textContent = component.message || 'No diagnostic information is available.';
    if (code) {
      code.textContent = component.code || '';
      code.hidden = !component.code;
    }
    const settingsModal = el('settings-dialog');
    if (settingsModal && typeof settingsModal.showModal === 'function' && !settingsModal.open) settingsModal.showModal();
  }

  function updateHealth(health = {}) {
    latestHealth = health;
    const components = health.components || {};
    healthKeys.forEach(key => {
      const component = components[key] || fallbackHealthComponent(key, health);
      const status = healthStatus(component.status);
      const dot = typeof document.querySelector === 'function'
        ? document.querySelector(`[data-health-dot="${key}"]`) : null;
      const value = el(`health-status-${key}`);
      if (dot) applyStatusClass(dot, status);
      if (value) {
        value.textContent = component.label || 'UNKNOWN';
        applyStatusClass(value, status);
      }
    });
    const hasError = healthKeys.some(key => healthStatus((components[key] || {}).status) === 'error');
    const hasWarning = healthKeys.some(key => ['not_configured', 'warning', 'unknown'].includes(healthStatus((components[key] || {}).status)));
    const overall = el('diagnostics-overall-status');
    if (overall) {
      overall.textContent = hasError ? 'ERROR DETECTED' : hasWarning ? 'REVIEW CONFIG' : 'ALL SYSTEMS GO';
      applyStatusClass(overall, hasError ? 'error' : hasWarning ? 'warning' : 'healthy');
    }
    setText('setting-val-mongo', health.mongodb || '—');
    setText('setting-val-whatsapp', health.whatsapp || '—');
    setText('setting-val-crm', health.zoho_crm || '—');
    setText('kpi-sync-status', health.zoho_books || health.zoho_crm || health.backend || '—');
  }

  function renderHealthFailure(error) {
    const status = error?.status ? `HTTP ${error.status}` : 'UNAVAILABLE';
    const message = error?.status
      ? `The health endpoint returned ${status}. Check the backend logs and server availability.`
      : 'The health endpoint could not be reached. Check that the backend process is running.';
    const components = Object.fromEntries(healthKeys.map(key => [key, {
      status: key === 'backend' ? 'error' : 'unknown',
      label: key === 'backend' ? 'ERROR' : 'UNKNOWN',
      area: key === 'backend' ? 'Backend' : key,
      message: key === 'backend' ? message : 'This check could not run because the backend health endpoint is unavailable.',
      ...(key === 'backend' ? { code: 'HEALTH_ENDPOINT_' + status.replace(/[^A-Z0-9]+/gi, '_') } : {}),
    }]));
    updateHealth({ backend: 'ERROR', components });
  }

  async function loadLiveMetrics() {
    const results = await Promise.allSettled([
      fetchJson('/api/leads/stats'),
      fetchJson('/api/leads?page=1&page_size=4'),
      fetchJson('/api/books/stats'),
      fetchJson('/api/books?page=1&page_size=5'),
      fetchJson('/api/health/status'),
    ]);
    const [leadStats, leadList, bookStats, billList, health] = results.map(result => result.status === 'fulfilled' ? result.value : null);
    if (leadStats) {
      setText('kpi-total-leads', number(leadStats.total));
      const total = Number(leadStats.total || 0);
      setText('kpi-auto-rate', total ? `${((Number(leadStats.valid || 0) / total) * 100).toFixed(1)}%` : '0.0%');
    }
    if (leadList) renderLeads(leadList.items);
    if (bookStats) {
      const pending = Number(bookStats.processing || 0) + Number(bookStats.awaiting_additional_info || 0)
        + Number(bookStats.awaiting_edit || 0) + Number(bookStats.awaiting_final_confirmation || 0)
        + Number(bookStats.creating_in_zoho || 0);
      setText('kpi-pending-bills', number(pending));
      setText('kpi-volume', formatAed(bookStats.total_amount));
    }
    if (billList) {
      renderBills(billList.items);
      renderActivity(recentBills);
      renderChart(recentBills);
    }
    if (health) updateHealth(health);
    else renderHealthFailure(results[4]?.reason);
    setText('kpi-avg-time', '—');
  }

  async function checkSession() {
    const feedback = el('overview-feedback');
    if (feedback) { feedback.textContent = ''; feedback.hidden = true; }
    try {
      const body = await fetchJson('/api/admin/session');
      if (body?.authenticated === false) {
        window.location.replace('/login');
        return false;
      }
      if (body?.authenticated !== true) throw new Error('SESSION_UNAVAILABLE');
      setText('topbar-username', body.username || 'Admin User');
      setText('setting-val-user', body.username || 'Admin User');
      setText('setting-val-role', (body.roles || [body.role]).filter(Boolean).join(', ').toUpperCase());
      window.VoltronixNav?.updateUser(body);
      await loadLiveMetrics();
      return true;
    } catch (error) {
      if (error.status === 401) {
        window.location.replace('/login');
      } else if (feedback) {
        // Network/server/rendering errors are not evidence of an expired
        // session. Redirecting here sends valid users straight back again.
        feedback.textContent = 'Unable to load the dashboard. Use Force Sync to retry.';
        feedback.hidden = false;
      }
      return false;
    }
  }

  const forceSyncBtn = el('btn-force-sync');
  if (forceSyncBtn) forceSyncBtn.addEventListener('click', async () => {
    const originalText = forceSyncBtn.innerHTML;
    forceSyncBtn.disabled = true;
    forceSyncBtn.textContent = 'SYNCING…';
    if (!await checkSession()) {
      forceSyncBtn.innerHTML = originalText;
      forceSyncBtn.disabled = false;
      return;
    }
    forceSyncBtn.textContent = 'SYNCED ✓';
    setTimeout(() => { forceSyncBtn.innerHTML = originalText; forceSyncBtn.disabled = false; }, 2000);
  });

  const settingsModal = el('settings-dialog');
  if (el('btn-diagnostics-action') && settingsModal) el('btn-diagnostics-action').addEventListener('click', () => settingsModal.showModal?.());
  if (el('close-settings') && settingsModal) el('close-settings').addEventListener('click', () => settingsModal.close?.());
  document.querySelectorAll('[data-health-key]').forEach(button => {
    button.addEventListener('click', () => showHealthDetail(button.dataset.healthKey));
  });

  if (el('btn-bills-export')) el('btn-bills-export').addEventListener('click', () => {
    const rows = recentBills.map(bill => [bill.bill_number || bill.bill_id || '', bill.vendor_name || '', bill.bill_date || '', bill.category || '', Number(bill.total_amount || 0).toFixed(2), bill.zoho_status || bill.status || '']);
    const csv = [['Bill ID', 'Vendor', 'Date', 'Category', 'Amount (AED)', 'Status'], ...rows]
      .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
    const link = document.createElement('a');
    link.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    link.download = 'voltronix_recent_bills.csv';
    document.body.appendChild(link); link.click(); link.remove();
  });
  if (el('btn-bills-filter')) el('btn-bills-filter').addEventListener('click', () => { window.location.href = '/bills'; });
  if (el('current-month-label')) el('current-month-label').textContent = new Date().toLocaleString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();
  clearPlaceholders();
  window.VoltronixNav?.initNav({ activePage: 'overview' });
  checkSession();
})();
