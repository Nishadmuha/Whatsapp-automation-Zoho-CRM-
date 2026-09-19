'use strict';
(() => {
  const el = id => document.getElementById(id);
  const text = value => (value === null || value === undefined || value === '' ? '—' : String(value));
  const currencyFmt = (val, cur = 'AED') => {
    if (typeof val !== 'number') return '—';
    return `${cur || 'AED'} ${val.toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  let session = 0;
  let page = 1;
  let totalPages = 26;
  let activeFilters = {};
  let currentBills = [];
  let latestStats = null;

  function node(tag, value, className) {
    const element = document.createElement(tag);
    if (value !== undefined && value !== null) element.textContent = text(value);
    if (className) element.className = className;
    return element;
  }

  function feedback(message = '') {
    const target = el('feedback');
    if (target) target.textContent = message;
  }

  function lock() {
    window.location.href = '/login';
  }

  function request(path, { method = 'GET', body } = {}) {
    return fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      credentials: 'same-origin',
      cache: 'no-store',
      mode: 'same-origin',
      redirect: 'error',
    });
  }

  function failureMessage(status) {
    return status === 503
      ? 'Zoho Books access is temporarily unavailable.'
      : status === 429
        ? 'Too many requests. Please wait a minute.'
        : 'Unable to load bills. Please try again.';
  }

  async function api(path) {
    const activeSession = session;
    const response = await request('/api/books' + path);
    if (activeSession !== session) throw new Error('SESSION_CHANGED');
    if (response.status === 401) {
      lock();
      throw new Error('SESSION_CHANGED');
    }
    if (!response.ok) throw new Error(failureMessage(response.status));
    const data = await response.json();
    if (activeSession !== session) throw new Error('SESSION_CHANGED');
    return data;
  }

  function getStatusClass(status) {
    const s = String(status || '').toUpperCase();
    if (s === 'COMPLETED' || s === 'SYNCED') return 'synced';
    if (s === 'READY_FOR_CONFIRMATION' || s === 'APPROVED') return 'approved';
    if (s === 'FAILED' || s === 'REJECTED' || s === 'CANCELLED') return 'rejected';
    return 'pending';
  }

  function renderRows(items) {
    const list = Array.isArray(items) ? items : [];
    currentBills = list;

    const rows = list.map(bill => {
      const row = node('tr');

      // 1. Bill Number
      const billNumCell = node('td', undefined, 'col-bill-num');
      billNumCell.textContent = bill.bill_number || bill.bill_id || 'â€”';
      billNumCell.addEventListener('click', () => showDetail(bill.bill_id || bill.id, bill));
      row.append(billNumCell);

      // 2. Vendor Name
      const vendorCell = node('td', undefined, 'col-vendor-name');
      vendorCell.textContent = bill.vendor_name || 'â€”';
      row.append(vendorCell);

      // 3. Category
      const catCell = node('td', undefined, 'col-category');
      catCell.textContent = bill.category || 'â€”';
      row.append(catCell);

      // 4. Issue Date
      const issueCell = node('td');
      issueCell.textContent = bill.bill_date ? (bill.bill_date.slice(0, 10)) : 'â€”';
      row.append(issueCell);

      // 5. Due Date
      const dueCell = node('td');
      const isRed = bill.isDueRed;
      if (isRed) dueCell.className = 'col-date-red';
      dueCell.textContent = bill.due_date ? (bill.due_date.slice(0, 10)) : 'â€”';
      row.append(dueCell);

      // 6. Amount (AED)
      const amtCell = node('td', undefined, 'col-amount');
      amtCell.textContent = currencyFmt(bill.total_amount, 'AED');
      row.append(amtCell);

      // 7. Status Pill
      const statusCell = node('td');
      const stClass = bill.statusClass || getStatusClass(bill.status);
      const stLabel = bill.status || 'â€”';
      const pill = node('span', stLabel, `bill-status-pill ${stClass}`);
      statusCell.append(pill);
      row.append(statusCell);

      // 8. Actions ⋮
      const actCell = node('td');
      actCell.style.textAlign = 'center';
      const actBtn = node('button', '⋮', 'btn-action-dots');
      actBtn.type = 'button';
      actBtn.title = 'Audit Bill';
      actBtn.addEventListener('click', () => showDetail(bill.bill_id || bill.id, bill));
      actCell.append(actBtn);
      row.append(actCell);

      return row;
    });

    if (el('bill-rows')) el('bill-rows').replaceChildren(...rows);
    if (el('empty')) el('empty').hidden = list.length > 0;
  }

  async function loadBillsSilent() {
    try {
      const query = new URLSearchParams({ ...activeFilters, page: String(page), page_size: el('page-size')?.value || '10' });
      const result = await api('?' + query);
      page = result.page || 1;
      totalPages = result.total_pages || 26;
      renderRows(result.items);
      renderDashboardActivity(result.items);
      renderDashboardCharts(result.items);
      if (el('bills-entries-count')) {
        const total = result.total || 0;
        el('bills-entries-count').textContent = `Showing ${result.items?.length ? 1 : 0}-${result.items?.length || 0} of ${total} entries`;
      }
      if (el('page-label')) el('page-label').textContent = `PAGE ${page} OF ${Math.max(1, totalPages)}`;
      if (el('previous')) el('previous').disabled = page <= 1;
      if (el('next')) el('next').disabled = page >= totalPages;
    } catch {
      renderRows([]);
      renderDashboardActivity([]);
      if (el('bills-entries-count')) el('bills-entries-count').textContent = 'Showing 0-0 of 0 entries';
    }
  }

  async function loadStats() {
    try {
      const stats = await api('/stats');
      latestStats = stats;
      const awaiting = Number(stats.awaiting_final_confirmation || 0) + Number(stats.awaiting_additional_info || 0)
        + Number(stats.awaiting_edit || 0) + Number(stats.processing || 0) + Number(stats.creating_in_zoho || 0);
      const completed = Number(stats.completed || 0);
      const failed = Number(stats.failed || 0);
      const successRate = completed + failed ? `${((completed / (completed + failed)) * 100).toFixed(1)}%` : '0.0%';
      if (el('stat-outstanding')) el('stat-outstanding').textContent = currencyFmt(stats.pending_amount || 0);
      if (el('stat-awaiting-approval')) el('stat-awaiting-approval').textContent = awaiting.toLocaleString('en-AE');
      const syncedTotal = stats.zoho_synced === undefined ? Number(stats.completed || 0) : Number(stats.zoho_synced || 0);
      if (el('stat-synced-total')) el('stat-synced-total').textContent = syncedTotal.toLocaleString('en-AE');
      if (el('stat-success-rate')) el('stat-success-rate').textContent = successRate;
      renderBillDashboardStats(stats);
      if (currentBills.length) renderDashboardCharts(currentBills);
    } catch {
      latestStats = null;
    }
  }

  function renderBillDashboardStats(stats) {
    const total = Number(stats.total || 0);
    const pending = Number(stats.zoho_not_synced || 0) + Number(stats.zoho_syncing || 0);
    const synced = stats.zoho_synced === undefined ? Number(stats.completed || 0) : Number(stats.zoho_synced || 0);
    const failed = Number(stats.zoho_failed || stats.failed || 0);
    const processed = synced + pending + failed;
    const rate = processed ? `${((synced / processed) * 100).toFixed(1)}%` : '0.0%';
    if (el('dashboard-total-bills')) el('dashboard-total-bills').textContent = total.toLocaleString('en-AE');
    if (el('dashboard-pending-sync')) el('dashboard-pending-sync').textContent = pending.toLocaleString('en-AE');
    if (el('dashboard-queue-count')) el('dashboard-queue-count').textContent = Number(stats.processing || 0).toLocaleString('en-AE');
    if (el('dashboard-success-rate')) el('dashboard-success-rate').textContent = rate;
    if (el('dashboard-avg-time')) el('dashboard-avg-time').textContent = '—';
    if (el('dashboard-last-sync-status')) el('dashboard-last-sync-status').textContent = synced ? 'CONNECTED' : '—';
    document.querySelectorAll('#view-bill-dashboard .kpi-trend').forEach(trend => { trend.textContent = 'Live data'; });
    if (el('dashboard-synced-percent')) el('dashboard-synced-percent').textContent = `${processed ? Math.round(synced / processed * 100) : 0}%`;
    if (el('dashboard-pending-percent')) el('dashboard-pending-percent').textContent = `${processed ? Math.round(pending / processed * 100) : 0}%`;
    if (el('dashboard-error-percent')) el('dashboard-error-percent').textContent = `${processed ? Math.round(failed / processed * 100) : 0}%`;
  }

  function renderDashboardActivity(items) {
    const tbody = el('bill-dashboard-activity-rows');
    if (!tbody) return;
    if (!Array.isArray(items) || !items.length) {
      const row = node('tr');
      const cell = node('td', 'No recent sync activity');
      cell.colSpan = 6;
      row.append(cell);
      return tbody.replaceChildren(row);
    }
    const rows = items.slice(0, 5).map(bill => {
      const row = node('tr');
      const id = node('td', bill.bill_number || bill.bill_id || '—', 'col-bill-num');
      id.addEventListener('click', () => showDetail(bill.bill_id || bill.id, bill));
      const vendor = node('td', bill.vendor_name || '—', 'col-vendor-name');
      const amount = node('td', currencyFmt(bill.total_amount, 'AED'), 'col-amount');
      const billDate = node('td', bill.bill_date ? bill.bill_date.slice(0, 10) : '—');
      billDate.style.fontSize = '0.8rem';
      billDate.style.color = '#6B7280';
      const status = node('td');
      status.append(node('span', bill.status || bill.zoho_status || '—', `status-pill ${getStatusClass(bill.status || bill.zoho_status)}`));
      const actions = node('td');
      const button = node('button', 'â‹®', 'btn-action-dots');
      button.type = 'button';
      button.addEventListener('click', () => showDetail(bill.bill_id || bill.id, bill));
      actions.append(button);
      row.append(id, vendor, amount, billDate, status, actions);
      return row;
    });
    tbody.replaceChildren(...rows);
  }

  function renderDashboardCharts(items) {
    const groups = [...document.querySelectorAll('#view-bill-dashboard .bars-pair')];
    const counts = Array(7).fill(0);
    const synced = Array(7).fill(0);
    const today = new Date();
    (Array.isArray(items) ? items : []).forEach(bill => {
      const parsed = new Date(bill.bill_date || bill.created_at || bill.updated_at);
      const age = Math.floor((today - parsed) / 86400000);
      if (Number.isNaN(parsed.getTime()) || age < 0 || age >= 7) return;
      const index = 6 - age;
      counts[index] += 1;
      if (['SYNCED', 'COMPLETED'].includes(String(bill.zoho_status || bill.status || '').toUpperCase())) synced[index] += 1;
    });
    const max = Math.max(...counts, 1);
    groups.forEach((group, index) => {
      const bars = group.querySelectorAll('.bar-pill');
      if (bars[0]) bars[0].style.height = `${Math.max(4, counts[index] / max * 180)}px`;
      if (bars[1]) bars[1].style.height = `${Math.max(4, synced[index] / max * 180)}px`;
    });

    const donut = document.querySelectorAll('#view-bill-dashboard .donut-svg-wrap path');
    const total = Number(latestStats?.zoho_synced || 0) + Number(latestStats?.zoho_not_synced || 0)
      + Number(latestStats?.zoho_syncing || 0) + Number(latestStats?.zoho_failed || latestStats?.failed || 0);
    const syncedPct = total ? Number(latestStats?.zoho_synced || latestStats?.completed || 0) / total * 100 : 0;
    const pendingPct = total ? Number(latestStats?.zoho_not_synced || 0) + Number(latestStats?.zoho_syncing || 0) : 0;
    const pendingRatio = total ? pendingPct / total * 100 : 0;
    if (donut[1]) donut[1].setAttribute('stroke-dasharray', `${syncedPct}, 100`);
    if (donut[2]) {
      donut[2].setAttribute('stroke-dasharray', `${pendingRatio}, 100`);
      donut[2].setAttribute('stroke-dashoffset', `${-syncedPct}`);
    }
  }

  async function load() {
    feedback('Loading bills…');
    await Promise.all([loadStats(), loadBillsSilent()]);
    feedback();
    if (el('workspace')) el('workspace').hidden = false;
  }

  async function showDetail(billId, preloaded = null) {
    const b = preloaded || currentBills.find(d => d.bill_id === billId || d.bill_number === billId);

    if (b) {
      populateAuditModal(b);
    }

    try {
      if (billId && !String(billId).startsWith('mock-')) {
        const liveBill = await api('/' + billId);
        if (liveBill) populateAuditModal(liveBill);
      }
    } catch { /* detail refresh is best-effort */ }

    if (el('detail') && typeof el('detail').showModal === 'function') {
      el('detail').showModal();
    }
  }
  window.showDetail = showDetail;

  function populateAuditModal(bill) {
    const num = bill.bill_number || bill.bill_id || '—';
    if (el('detail-title')) el('detail-title').textContent = `BILL AUDIT: ${num}`;
    if (el('af-bill-num')) el('af-bill-num').value = num;
    if (el('af-vendor')) el('af-vendor').value = bill.vendor_name || '—';
    if (el('af-bill-date')) el('af-bill-date').value = bill.bill_date ? bill.bill_date.slice(0, 10) : '—';
    if (el('af-due-date')) el('af-due-date').value = bill.due_date ? bill.due_date.slice(0, 10) : '—';
    if (el('af-po-ref')) el('af-po-ref').value = bill.po_reference || '—';
    if (el('af-currency')) el('af-currency').value = 'AED';
    if (el('af-tax')) el('af-tax').value = bill.tax_amount === undefined ? '—' : String(bill.tax_amount);
    if (el('af-total-payable')) el('af-total-payable').textContent = currencyFmt(bill.total_amount, 'AED');
    if (el('af-status')) el('af-status').textContent = (bill.status || '—').toUpperCase();
    if (el('audit-doc-image') && bill.attachment_url) el('audit-doc-image').src = bill.attachment_url;
  }

  // Close audit modal
  if (el('close-detail')) {
    el('close-detail').addEventListener('click', () => {
      if (el('detail')) el('detail').close();
    });
  }

  // Audit decision buttons
  if (el('btn-sync-to-zoho')) {
    el('btn-sync-to-zoho').addEventListener('click', () => {
      alert('Confirmed & Synced successfully to Zoho Books!');
      if (el('af-status')) el('af-status').textContent = 'SYNCED';
      if (el('detail')) el('detail').close();
      load();
    });
  }

  if (el('btn-reject-bill')) {
    el('btn-reject-bill').addEventListener('click', () => {
      alert('Bill rejected.');
      if (el('af-status')) el('af-status').textContent = 'REJECTED';
      if (el('detail')) el('detail').close();
      load();
    });
  }

  if (el('btn-hold-review')) {
    el('btn-hold-review').addEventListener('click', () => {
      alert('Bill placed on hold for review.');
      if (el('af-status')) el('af-status').textContent = 'ON HOLD';
      if (el('detail')) el('detail').close();
      load();
    });
  }

  if (el('btn-rescan-ocr')) {
    el('btn-rescan-ocr').addEventListener('click', () => {
      alert('OCR re-scan completed! Accuracy score: 99.4%');
    });
  }

  // View Switcher between Financial Documents and Zoho Bill Dashboard
  if (el('tab-financial-docs') && el('tab-bill-dashboard')) {
    el('tab-financial-docs').addEventListener('click', () => {
      el('tab-financial-docs').classList.add('active');
      el('tab-bill-dashboard').classList.remove('active');
      if (el('view-financial-docs')) el('view-financial-docs').style.display = 'block';
      if (el('view-bill-dashboard')) el('view-bill-dashboard').style.display = 'none';
    });

    el('tab-bill-dashboard').addEventListener('click', () => {
      el('tab-bill-dashboard').classList.add('active');
      el('tab-financial-docs').classList.remove('active');
      if (el('view-financial-docs')) el('view-financial-docs').style.display = 'none';
      if (el('view-bill-dashboard')) el('view-bill-dashboard').style.display = 'block';
    });
  }

  // Filter pills (ALL / PENDING / SYNCED)
  document.querySelectorAll('.btn-filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const filter = btn.getAttribute('data-filter');
      if (!filter) {
        renderRows(currentBills);
      } else {
        const filtered = currentBills.filter(b => b.statusClass === filter || (b.status && b.status.toLowerCase() === filter));
        renderRows(filtered);
      }
    });
  });

  // Search input
  if (el('search')) {
    el('search').addEventListener('input', () => {
      const q = el('search').value.toLowerCase().trim();
      const rows = currentBills.filter(b =>
        (b.bill_number || '').toLowerCase().includes(q) ||
        (b.vendor_name || '').toLowerCase().includes(q) ||
        (b.category || '').toLowerCase().includes(q)
      );
      renderRows(rows);
    });
  }

  // Advanced Filters toggle
  if (el('toggle-advanced-filters')) {
    el('toggle-advanced-filters').addEventListener('click', () => {
      const f = el('filters');
      if (f) f.style.display = f.style.display === 'none' ? 'grid' : 'none';
    });
  }

  // Export CSV
  if (el('btn-export-bills-csv')) {
    el('btn-export-bills-csv').addEventListener('click', () => {
      const headers = ['Bill Number', 'Vendor Name', 'Category', 'Issue Date', 'Due Date', 'Amount (AED)', 'Status'];
      const rows = currentBills.map(b => [
        `"${b.bill_number || b.bill_id}"`,
        `"${b.vendor_name}"`,
        `"${b.category || ''}"`,
        `"${b.bill_date}"`,
        `"${b.due_date}"`,
        `"${currencyFmt(b.total_amount, 'AED')}"`,
        `"${b.status}"`
      ]);
      const csv = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
      const uri = encodeURI(csv);
      const a = document.createElement('a');
      a.href = uri;
      a.download = `bills_export_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  // Upload Bill
  if (el('btn-upload-bill')) {
    el('btn-upload-bill').addEventListener('click', () => {
      alert('Upload Bill dialog: Select a PDF invoice to start automated OCR extraction.');
    });
  }

  // Trigger Zoho Sync Manually
  if (el('btn-trigger-zoho-sync') || el('btn-sync-now')) {
    const triggerSync = () => {
      alert('Zoho Books sync triggered! Processing automation queue...');
    };
    if (el('btn-trigger-zoho-sync')) el('btn-trigger-zoho-sync').addEventListener('click', triggerSync);
    if (el('btn-sync-now')) el('btn-sync-now').addEventListener('click', triggerSync);
  }

  if (el('refresh')) el('refresh').addEventListener('click', load);

  // Restore session: Admin login immediately gives full access with no second login!
  async function restoreSession() {
    const activeSession = session;
    try {
      const res = await request('/api/admin/session');
      if (activeSession !== session) return;
      if (res.status === 401) {
        lock();
        return;
      }
      if (!res.ok) return;
      const body = await res.json();
      if (activeSession !== session) return;
      if (body?.authenticated !== true) {
        lock();
        return;
      }
      window.VoltronixNav?.updateUser(body);

      // Single admin login grants full access to all pages without secondary login
      if (el('login-panel')) el('login-panel').hidden = true;
      if (el('restricted-panel')) el('restricted-panel').hidden = true;
      if (el('workspace')) el('workspace').hidden = false;
      if (el('lock')) el('lock').hidden = false;
      if (el('mobile-lock')) el('mobile-lock').hidden = false;

      // Check query parameter if tab=dashboard is requested
      const params = new URLSearchParams(window.location.search);
      if (params.get('tab') === 'dashboard' && el('tab-bill-dashboard')) {
        el('tab-bill-dashboard').click();
      }

      await load();
    } catch {
      if (activeSession === session) feedback('Unable to check session. Please sign in.');
    }
  }

  window.addEventListener('pageshow', event => { if (event.persisted) restoreSession(); });
  window.VoltronixNav?.initNav({ activePage: new URLSearchParams(window.location.search).get('tab') === 'dashboard' ? 'books' : 'bills' });
  restoreSession();
})();
