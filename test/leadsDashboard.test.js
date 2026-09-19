'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { renderAdminPage } = require('../src/views/adminPage');
const { test } = require('node:test');

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = new Map(); this.classList = { add() {} }; this.value = ''; this.hidden = false; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('HTML injection sink is forbidden'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  dispatch(event) { return this.listeners.get(event)?.({ preventDefault() {} }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function response(data, status = 200) { return { status, ok: status >= 200 && status < 300, async json() { return data; } }; }
async function dashboard(fetch, { sessionAuthenticated = true, logoutStatus = 200, logoutGate, search = '' } = {}) {
  const [html, script] = await Promise.all(['leads.html', 'leads.js'].map(file => file.endsWith('.html') ? renderAdminPage('leads') : fs.readFile(path.resolve(__dirname, '../src/admin', file), 'utf8')));
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  elements.get('workspace').hidden = true;
  elements.get('page-size').value = '20';
  const tags = [];
  const document = {
    getElementById(id) { assert.ok(elements.has(id), 'Unknown dashboard element: ' + id); return elements.get(id); },
    createElement(tag) { tags.push(tag); return new Element(tag); },
  };
  Object.defineProperty(document, 'cookie', { get() { throw new Error('Cookie access is forbidden'); }, set() { throw new Error('Cookie storage is forbidden'); } });
  const window = new Element();
  window.location = { search, replace(path) { this.href = path; } };
  const requests = [];
  const context = { document, window, URLSearchParams, async fetch(url, options) {
    requests.push({ url, options });
    if (url === '/api/admin/session') return response({ authenticated: sessionAuthenticated });
    if (url === '/api/admin/logout') { await logoutGate; return response({ authenticated: false }, logoutStatus); }
    return fetch(url, options);
  } };
  for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(context, name, {
    get() { throw new Error('Persistent credential storage is forbidden'); },
  });
  vm.runInNewContext(script, context, { filename: 'admin/leads.js' });
  return { el: id => elements.get(id), tags, window, requests, html };
}
async function settled() { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }
test('dashboard reuses the admin session without a second login and renders untrusted lead content as text', async () => {
  const injected = '<img src=x onerror="globalThis.injected=true">';
  const lead = { id: '346770a3-ef6b-4d87-bf45-54a64246a17a', company_name: injected, contact_name: 'Synthetic contact',
    phone: '+971501234567', conversation_id: '+971551234567', address: 'Business Bay ' + injected, trn_no: '104249196700003',
    requirement: injected, original_message: 'Original\n' + injected,
    extraction_status: 'completed', validation_status: 'incomplete', zoho_status: 'not_started',
    validation_result: { valid: false, missing_fields: ['company_name'], errors: ['CUSTOMER_IDENTITY_REQUIRED'] },
  };
  const h = await dashboard(async url => {
    const result = url.endsWith('/stats') ? { total: 1, valid: 0, incomplete: 1, zoho_pending: 0 }
      : url.includes('?') ? { items: [lead], total: 1, page: 1, page_size: 20, total_pages: 1 } : lead;
    return { status: 200, ok: true, async json() { return result; } };
  });
  assert.deepEqual(h.requests.map(request => request.url), ['/api/admin/session']);
  assert.doesNotMatch(h.html, /id="(?:login-panel|login-form|username|password)"/);
  assert.match(h.html, /rel="icon" href="\/favicon.svg"/);
  assert.doesNotMatch(h.html, /id="token"|Admin access token|synthetic-test-password/);
  await settled();
  assert.equal(h.el('workspace').hidden, false);
  assert.match(h.el('lead-rows').textContent, /<img src=x/);
  const rowConversationLink = h.el('lead-rows').children[0].children.at(-1).children[0];
  assert.equal(rowConversationLink.textContent, 'View chat');
  assert.equal(rowConversationLink.href, '/admin/chats?conversation=%2B971551234567');
  h.el('lead-rows').children[0].children[0].children[0].dispatch('click');
  await settled();
  assert.equal(h.el('detail').open, true);
  assert.ok(h.el('detail-content').textContent.includes('Original\n' + injected));
  assert.ok(h.el('detail-content').textContent.includes('Business Bay ' + injected));
  assert.match(h.el('detail-content').textContent, /TRN number104249196700003/);
  const conversationLink = h.el('detail-content').children[0].children.find(child => child.tagName === 'a');
  assert.equal(conversationLink.textContent, 'Open related WhatsApp conversation');
  assert.equal(conversationLink.href, '/admin/chats?conversation=%2B971551234567');
  assert.equal(h.tags.includes('img'), false);
  assert.equal(h.tags.includes('script'), false);
  const logins = h.requests.filter(request => request.url === '/api/admin/login');
  assert.equal(logins.length, 0);
  for (const { url, options } of h.requests) {
    assert.ok(url.startsWith('/api/leads') || url.startsWith('/api/admin/'));
    assert.equal(url.includes('synthetic-test-password'), false);
    assert.equal(options.headers?.Authorization, undefined);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.redirect, 'error');
    if (url !== '/api/admin/login') assert.equal(options.body, undefined);
  }
  h.el('lock').dispatch('click');
  assert.equal(h.el('workspace').hidden, true);
  assert.equal(h.el('lead-rows').textContent, '');
  assert.equal(h.el('detail-content').textContent, '');
  assert.equal(h.el('detail').open, false);
  await settled();
  const logout = h.requests.at(-1);
  assert.equal(logout.url, '/api/admin/logout');
  assert.equal(logout.options.method, 'POST');
  assert.deepEqual(JSON.parse(logout.options.body), {});
  assert.equal(h.window.location.href, '/login');
});

test('lead detail refuses external or injected conversation links', async () => {
  for (const conversation_id of ['https://outside.example.test', 'javascript:alert(1)', '<img src=x>', null]) {
    const lead = { id: '346770a3-ef6b-4d87-bf45-54a64246a17a', company_name: 'Synthetic company', conversation_id };
    const h = await dashboard(async url => response(url.endsWith('/stats') ? {} : url.includes('?')
      ? { items: [lead], total: 1, page: 1, total_pages: 1 } : lead), { sessionAuthenticated: true });
    await settled();
    h.el('lead-rows').children[0].children[0].children[0].dispatch('click');
    await settled();
    assert.doesNotMatch(h.el('detail-content').textContent, /Open related WhatsApp conversation/);
    assert.equal(h.tags.includes('a'), false);
  }
});

test('single-field leads remain identifiable in the list and detail without implying mandatory fields', async () => {
  for (const [field, value] of Object.entries({ company_name: 'GLOW POWER', contact_name: 'Ahmed',
    phone: '+971501234567', email: 'procurement@example.test', address: 'Business Bay, Dubai',
    trn_no: '104249196700003', project_name: 'Marina Tower', project_location: 'Dubai',
    product_or_service: 'Electrical panels', requirement: 'Quotation', quantity: '5', deadline: 'Tomorrow', notes: 'Call after 3pm' })) {
    const lead = { id: '346770a3-ef6b-4d87-bf45-54a64246a17a', [field]: value,
      validation_result: { valid: true, missing_fields: [], errors: [] } };
    const h = await dashboard(async url => response(url.endsWith('/stats') ? {} : url.includes('?')
      ? { items: [lead], total: 1, page: 1, total_pages: 1 } : lead), { sessionAuthenticated: true });
    await settled();
    const open = h.el('lead-rows').children[0].children[0].children[0];
    assert.ok(open.textContent.includes(value), field);
    open.dispatch('click');
    await settled();
    assert.ok(h.el('detail-title').textContent.includes(value), field);
    assert.match(h.el('detail-content').textContent, /Available lead information passed validation\./);
    assert.doesNotMatch(h.el('detail-content').textContent, /Required information|Missing:/);
  }
});

test('chat lead links open the specific saved lead after authentication even outside the visible page', async () => {
  const id = '346770a3-ef6b-4d87-bf45-54a64246a17a';
  const injected = '<img src=x onerror=alert(1)>';
  const h = await dashboard(async url => response(url.endsWith('/stats') ? {}
    : url.includes('?') ? { items: [], total: 0, page: 1, total_pages: 0 }
      : { id, company_name: 'Linked company', email: 'procurement@example.test', notes: injected }),
  { search: '?lead=' + id });
  await settled();
  assert.equal(h.el('detail').open, true);
  assert.equal(h.el('detail-title').textContent, 'Linked company');
  assert.ok(h.el('detail-content').textContent.includes(injected));
  assert.equal(h.requests.filter(({ url }) => url === '/api/leads/' + id).length, 1);
  assert.equal(h.tags.includes('img'), false);
  h.el('refresh').dispatch('click');
  await settled();
  assert.equal(h.requests.filter(({ url }) => url === '/api/leads/' + id).length, 1);
});

test('lead navigation ignores malformed and duplicate identifiers without fetching a detail', async () => {
  const id = '346770a3-ef6b-4d87-bf45-54a64246a17a';
  for (const search of ['?lead=javascript:alert(1)', '?lead=%2F%2Fevil.example.test', '?lead=' + id + '&lead=' + id]) {
    const h = await dashboard(async url => response(url.endsWith('/stats') ? {}
      : { items: [], total: 0, page: 1, total_pages: 0 }), { search, sessionAuthenticated: true });
    await settled();
    assert.equal(h.requests.some(({ url }) => url.startsWith('/api/leads/') && !url.endsWith('/stats')), false);
    assert.equal(h.el('detail').open, undefined);
  }
});

test('signing out clears the dashboard immediately and invalidates late lead responses', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await dashboard(async url => {
    await gate;
    return { status: 200, ok: true, async json() { return url.endsWith('/stats')
      ? { total: 1, valid: 1, incomplete: 0, zoho_pending: 1 }
      : { items: [{ id: 'test', company_name: 'late-private-company' }], total: 1, page: 1, total_pages: 1 }; } };
  });
  await settled();
  assert.equal(h.requests.some(request => request.url.startsWith('/api/leads')), true);
  h.el('lock').dispatch('click');
  release();
  await settled();
  assert.equal(h.el('workspace').hidden, true);
  assert.equal(h.el('lead-rows').textContent, '');
  assert.equal(h.el('stat-total').textContent, '—');
  assert.equal(h.window.location.href, '/login');
  assert.equal(h.requests.some(request => request.url === '/api/admin/logout'), true);
});

test('missing sessions redirect to the dedicated login without requesting lead data', async () => {
  const h = await dashboard(async () => { throw new Error('Lead data should not be requested'); }, { sessionAuthenticated: false });
  await settled();
  assert.equal(h.el('workspace').hidden, true);
  assert.equal(h.window.location.href, '/login');
  assert.equal(h.requests.some(request => request.url.startsWith('/api/leads')), false);
});

test('a saved server session restores dashboard access on reload without resending credentials', async () => {
  const h = await dashboard(async url => response(url.endsWith('/stats') ? { total: 0, valid: 0, incomplete: 0, zoho_pending: 0 }
    : { items: [], total: 0, page: 1, total_pages: 0 }), { sessionAuthenticated: true });
  await settled();
  assert.equal(h.el('workspace').hidden, false);
  assert.equal(h.window.location.href, undefined);
  assert.equal(h.requests.some(request => request.url === '/api/admin/login'), false);
  assert.equal(h.requests.every(request => request.options.body === undefined), true);
});

test('an expired session clears private results and asks the operator to sign in again', async () => {
  const h = await dashboard(async () => response({}, 401), { sessionAuthenticated: true });
  await settled();
  assert.equal(h.el('workspace').hidden, true);
  assert.equal(h.window.location.href, '/login');
  assert.equal(h.el('lead-rows').textContent, '');
  assert.equal(h.el('feedback').textContent, 'Session expired. Please sign in again.');
});

test('logout failures remain visible and duplicate logout is blocked until the first finishes', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await dashboard(async url => response(url.endsWith('/stats') ? { total: 0, valid: 0, incomplete: 0, zoho_pending: 0 }
    : { items: [], total: 0, page: 1, total_pages: 0 }), { sessionAuthenticated: true, logoutStatus: 503, logoutGate: gate });
  await settled();
  h.el('lock').dispatch('click');
  assert.equal(h.el('workspace').hidden, true);
  h.el('lock').dispatch('click');
  assert.equal(h.requests.filter(request => request.url === '/api/admin/logout').length, 1);
  assert.equal(h.window.location.href, undefined);
  release();
  await settled();
  assert.equal(h.el('lock').hidden, false);
  assert.equal(h.window.location.href, undefined);
  assert.match(h.el('feedback').textContent, /Sign out could not be confirmed/);
});

test('dashboard search and status filters combine with pagination and reset the page when changed', async () => {
  const queries = [];
  const h = await dashboard(async url => {
    if (url.endsWith('/stats')) return { status: 200, ok: true, async json() { return { total: 55, valid: 20, incomplete: 35, zoho_pending: 20 }; } };
    const query = new URLSearchParams(url.split('?')[1]);
    queries.push(query);
    return { status: 200, ok: true, async json() { return {
      items: [{ id: 'synthetic-id', company_name: 'Synthetic company' }], total: 55,
      page: Number(query.get('page')), page_size: Number(query.get('page_size')), total_pages: Math.ceil(55 / Number(query.get('page_size'))),
    }; } };
  });
  await settled();
  h.el('search').value = 'Al Noor & Sons %_';
  h.el('validation').value = 'incomplete';
  h.el('extraction').value = 'completed';
  h.el('zoho').value = 'not_started';
  h.el('filters').dispatch('submit');
  await settled();
  assert.deepEqual(Object.fromEntries(queries.at(-1)), { search: 'Al Noor & Sons %_', validation_status: 'incomplete',
    extraction_status: 'completed', zoho_status: 'not_started', page: '1', page_size: '20' });
  assert.equal(h.el('previous').disabled, true);
  assert.equal(h.el('next').disabled, false);
  h.el('next').dispatch('click');
  await settled();
  assert.equal(queries.at(-1).get('page'), '2');
  assert.equal(queries.at(-1).get('search'), 'Al Noor & Sons %_');
  assert.match(h.el('page-label').textContent, /Page 2 of 3/);
  h.el('previous').dispatch('click');
  await settled();
  assert.equal(queries.at(-1).get('page'), '1');
  h.el('next').dispatch('click');
  await settled();
  h.el('page-size').value = '50';
  h.el('page-size').dispatch('change');
  await settled();
  assert.equal(queries.at(-1).get('page'), '1');
  assert.equal(queries.at(-1).get('page_size'), '50');
  h.el('lock').dispatch('click');
  assert.equal(h.el('search').value, '');
  assert.equal(h.el('page-label').textContent, 'No leads loaded');
});
