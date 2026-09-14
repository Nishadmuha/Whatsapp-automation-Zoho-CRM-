'use strict';
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { test, after } = require('node:test');
const { createApp } = require('../src/app');
const { testEnv, temporaryStore, incoming } = require('./helpers');

const fields = ['company_name', 'contact_name', 'phone', 'email', 'address', 'trn_no', 'project_name', 'project_location',
  'product_or_service', 'requirement', 'quantity', 'deadline', 'notes'];
function sample(overrides = {}) {
  return { id: randomUUID(), whatsapp_message_id: 'wamid.synthetic-api', sender_phone: '+971551234567', conversation_id: '+971551234567',
    original_message: 'Synthetic company requires AC maintenance.',
    ...Object.fromEntries(fields.map(field => [field, null])), company_name: 'Synthetic company',
    extraction_status: 'completed', validation_status: 'valid', zoho_status: 'pending', zoho_lead_id: null,
    validation_result: { valid: true, missing_fields: [], errors: [] }, error_stage: null, error_code: null,
    created_at: '2026-09-12T10:00:00.000Z', updated_at: '2026-09-12T10:00:00.000Z', ...overrides };
}
async function backend(t, { env: overrides = {}, store: methods = {}, actualStore } = {}) {
  const logs = [];
  const calls = [];
  const row = sample();
  const stats = { total: 12, valid: 7, incomplete: 3, extraction_failed: 2, zoho_pending: 7, zoho_saved: 0 };
  const store = actualStore || {
    async init() {}, async ping() {},
    async listLeads(query) { calls.push(['list', query]); return { items: [row], total: 12, page: query.page, pageSize: query.pageSize, totalPages: 3 }; },
    async getLead(id) { calls.push(['detail', id]); return id === row.id ? row : null; },
    async getLeadStats() { calls.push(['stats']); return stats; }, ...methods,
  };
  const env = testEnv({ ADMIN_USERNAME: 'test-admin', ADMIN_PASSWORD: randomBytes(24).toString('hex'), ...overrides });
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, record => logs.push(record)]));
  const app = createApp({ env, store, logger });
  await app.locals.ready.catch(() => {});
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; });
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  if (env.ADMIN_USERNAME && env.ADMIN_PASSWORD) {
    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }) });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
  }
  return { row, env, calls, logs, stats, base, cookie, request(path = '/api/leads', sessionCookie = cookie) {
    return fetch(base + path, { headers: sessionCookie ? { Cookie: sessionCookie } : {} });
  } };
}

test('all lead API endpoints fail closed when the admin credential is absent', async t => {
  const h = await backend(t, { env: { ADMIN_USERNAME: '', ADMIN_PASSWORD: '' } });
  for (const path of ['/api/leads', '/api/leads/stats', '/api/leads/' + h.row.id]) {
    assert.equal((await h.request(path)).status, 503);
  }
  assert.deepEqual(h.calls, []);
});

test('lead API accepts an issued session and rejects unconfigured tokens or query credentials', async t => {
  const h = await backend(t);
  for (const headers of [{}, { Authorization: 'Bearer ' + h.env.ADMIN_PASSWORD },
    { Cookie: 'ADMIN_API_TOKEN=' + h.env.ADMIN_PASSWORD }, { Cookie: 'voltronix_admin_session=invalid' }]) {
    for (const path of ['/api/leads', '/api/leads/stats', '/api/leads/' + h.row.id]) {
      const response = await fetch(h.base + path, { headers });
      assert.equal(response.status, 401);
    }
  }
  assert.equal((await h.request('/api/leads?password=' + h.env.ADMIN_PASSWORD, null)).status, 401);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.request()).status, 200);
  assert.equal(JSON.stringify(h.logs).includes(h.env.ADMIN_PASSWORD), false);
  assert.equal(JSON.stringify(h.logs).includes(h.cookie), false);
});

test('configured API tokens authorize all existing lead routes without exposing tokens or mixing customer conversations', async t => {
  const token = 'synthetic-lead-api-token-' + 'x'.repeat(32);
  const h = await backend(t, { env: { ADMIN_API_TOKEN: token, ADMIN_USERNAME: '', ADMIN_PASSWORD: '' } });
  h.row.phone = '+971501234567';
  h.row.address = 'Business Bay, Dubai';
  h.row.trn_no = '104249196700003';
  h.row.notes = token;
  for (const path of ['/api/leads', '/api/leads/stats', '/api/leads/' + h.row.id]) {
    assert.equal((await h.request(path, null)).status, 401);
    const response = await fetch(h.base + path, { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes(token), false);
  }
  const detail = await (await fetch(h.base + '/api/leads/' + h.row.id, { headers: { Authorization: 'Bearer ' + token } })).json();
  assert.equal(detail.conversation_id, h.row.sender_phone);
  assert.notEqual(detail.conversation_id, h.row.phone);
  assert.equal(detail.address, h.row.address);
  assert.equal(detail.trn_no, h.row.trn_no);
  assert.equal(detail.notes, '[REDACTED]');
  assert.equal(JSON.stringify(h.logs).includes(token), false);
});

test('list pagination, literal search and all filters are validated and passed to the existing store', async t => {
  const h = await backend(t);
  const search = "Al Noor %_ ' ";
  const query = new URLSearchParams({ page: '2', page_size: '5', search, validation_status: 'incomplete', extraction_status: 'failed', zoho_status: 'pending' });
  const response = await h.request('/api/leads?' + query);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { items: [h.row], total: 12, page: 2, page_size: 5, total_pages: 3 });
  assert.deepEqual(h.calls, [['list', { page: 2, pageSize: 5, search, validationStatus: 'incomplete', extractionStatus: 'failed', zohoStatus: 'pending' }]]);
  assert.equal((await h.request('/api/leads?status=valid')).status, 200);
  assert.equal(h.calls.at(-1)[1].validationStatus, 'valid');
  assert.equal((await h.request('/api/leads?page=1000000&page_size=100')).status, 200);
});

test('invalid, duplicate, conflicting and unrecognized query parameters never reach storage', async t => {
  const h = await backend(t);
  const queries = ['page=0', 'page=-1', 'page=1.5', 'page=1e2', 'page=1000001', 'page=01', 'page=',
    'page_size=0', 'page_size=101', 'page=1&page=2', 'search=a&search=b', 'status=complete',
    'status=valid&validation_status=incomplete', 'extraction_status=invalid', 'zoho_status=connected',
    'sort=oldest', 'access_token=private', 'search=%00', 'search=' + 'x'.repeat(201), 'page[foo]=1'];
  for (const query of queries) {
    const response = await h.request('/api/leads?' + query);
    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { success: false, message: 'Invalid lead query' });
  }
  assert.equal((await h.request('/api/leads/stats?search=x')).status, 400);
  assert.equal((await h.request('/api/leads/' + h.row.id + '?token=x')).status, 400);
  assert.deepEqual(h.calls, []);
});

test('detail UUID validation, missing leads and stats routing use safe deterministic responses', async t => {
  const h = await backend(t);
  const detail = await h.request('/api/leads/' + h.row.id);
  assert.equal(detail.status, 200);
  assert.deepEqual(await detail.json(), h.row);
  assert.equal((await h.request('/api/leads/not-a-uuid')).status, 400);
  assert.equal((await h.request('/api/leads/' + randomUUID())).status, 404);
  const stats = await h.request('/api/leads/stats');
  assert.equal(stats.status, 200);
  assert.deepEqual(await stats.json(), h.stats);
  assert.deepEqual(h.calls.at(-1), ['stats']);
});

test('DTOs omit unknown credentials and internal fields and redact known secrets recursively without mutating source', async t => {
  const credential = 'synthetic-configured-openai-secret';
  const appSecret = 'synthetic-configured-meta-secret';
  const adminPassword = 'synthetic-private-dashboard-password';
  const row = sample({ original_message: 'Original ' + credential + ' and ' + appSecret + ' and ' + adminPassword,
    notes: credential, company_name: 'Company ' + credential, api_key: 'injected-unrecognized-secret',
    lease_token: 'private-lease', raw_response: { token: 'private-provider-token' },
    validation_result: { valid: false, missing_fields: ['company_name', 'unknown-secret-field'],
      errors: ['CUSTOMER_IDENTITY_REQUIRED', { token: 'nested-secret' }, 'private raw error'], token: credential },
  });
  const before = structuredClone(row);
  const h = await backend(t, { env: { OPENAI_API_KEY: credential, META_APP_SECRET: appSecret, ADMIN_PASSWORD: adminPassword }, store: {
    async getLead() { return row; },
    async listLeads() { return { items: [row], total: 1, page: 1, pageSize: 20, totalPages: 1, access_token: credential }; },
    async getLeadStats() { return { total: 1, valid: 0, incomplete: 1, extraction_failed: 0, zoho_pending: 0, zoho_saved: 0, token: credential }; },
  } });
  for (const path of ['/api/leads', '/api/leads/' + row.id, '/api/leads/stats']) {
    const response = await h.request(path);
    assert.equal(response.status, 200);
    const body = await response.text();
    for (const value of [credential, appSecret, adminPassword, 'injected-unrecognized-secret', 'private-lease', 'private-provider-token', 'nested-secret', 'private raw error', 'unknown-secret-field']) {
      assert.equal(body.includes(value), false);
    }
    if (!path.endsWith('/stats')) assert.match(body, /\[REDACTED\]/);
  }
  const detail = await (await h.request('/api/leads/' + row.id)).json();
  assert.deepEqual(detail.validation_result, { valid: false, missing_fields: ['company_name'], errors: ['CUSTOMER_IDENTITY_REQUIRED'] });
  assert.equal(detail.sender_phone, row.sender_phone);
  assert.deepEqual(row, before);
  assert.equal(JSON.stringify(h.logs).includes(credential), false);
});

test('storage errors and initialization failures return no raw errors, rows or credentials', async t => {
  for (const initFails of [false, true]) {
    const fail = async () => { throw new Error('private-database-password customer text'); };
    const h = await backend(t, { store: { ...(initFails ? { init: fail } : {}), listLeads: fail, getLead: fail, getLeadStats: fail } });
    for (const path of ['/api/leads', '/api/leads/stats', '/api/leads/' + h.row.id]) {
      const response = await h.request(path);
      assert.equal(response.status, 503);
      assert.equal((await response.text()).includes('private-database-password'), false);
    }
    assert.equal(JSON.stringify(h.logs).includes('private-database-password'), false);
  }
});

test('lead API rate limiting includes unauthenticated attempts and remains separate from health', async t => {
  const h = await backend(t, { env: { WEBHOOK_RATE_LIMIT: '2' } });
  assert.equal((await h.request('/api/leads', null)).status, 401);
  assert.equal((await h.request('/api/leads/stats', null)).status, 401);
  assert.equal((await h.request()).status, 429);
  assert.equal((await h.request('/health', null)).status, 200);
});

test('the public dashboard shell and local assets expose no data or credentials and retain CSP', async t => {
  const h = await backend(t, { env: { ADMIN_USERNAME: '', ADMIN_PASSWORD: '' } });
  const response = await h.request('/admin/leads', null);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Lead overview/);
  assert.match(html, /id="workspace" hidden/);
  assert.match(html, /src="\/admin\/leads\.js" defer/);
  assert.match(html, /id="username"/);
  assert.match(html, /id="password"/);
  assert.doesNotMatch(html, /id="token"/);
  assert.doesNotMatch(html, /<script\b[^>]*>[\s\S]*?\S[\s\S]*?<\/script>|on(?:click|load)=|https?:\/\//i);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const asset of ['/admin/leads.css', '/admin/leads.js']) {
    const file = await h.request(asset, null);
    assert.equal(file.status, 200);
    assert.equal((await file.text()).includes(h.row.original_message), false);
  }
  assert.equal((await h.request('/admin/.env', null)).status, 404);
  assert.equal((await h.request('/favicon.ico', null)).status, 204);
  const icon = await h.request('/favicon.svg', null);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /image\/svg\+xml/);
  assert.deepEqual(h.calls, []);
});

test('authenticated API integrates with migrated SQLite for newest-first pages, literal search, filters, detail and statistics', async t => {
  const { store, databaseUrl } = await temporaryStore(t);
  const messages = ['Al Noor %_ enquiry\nExact original line.', 'Al Noor XX enquiry', 'Other company enquiry'].map(message_text => incoming({
    message_text, request_lead_workflow: true,
  }));
  const companies = ['Al Noor %_', 'Al Noor XX', 'Other company'];
  for (let i = 0; i < messages.length; i++) {
    await store.enqueueMany([messages[i]]);
    await store.enqueueMany([messages[i]]);
    let job = await store.claimLeadExtraction();
    const result = { is_lead: true, lead: { ...Object.fromEntries(fields.map(field => [field, null])),
      company_name: companies[i], requirement: 'AC maintenance' } };
    await store.completeLeadSessionTurn(job.message_id, job.lease_token, { result,
      validation: { valid: true, missing_fields: [], errors: [] }, state: 'awaiting_confirmation',
      originalMessage: messages[i].message_text, replyText: 'Is this lead complete?' });
    const session = await store.getActiveLeadSession(messages[i].sender_phone);
    await store.enqueueMany([incoming({ message_text: 'Yes', request_lead_workflow: true })]);
    job = await store.claimLeadExtraction();
    await store.completeLeadSessionTurn(job.message_id, job.lease_token, {
      sessionId: session.id, state: 'completed', kind: 'confirmation', replyText: 'Lead saved successfully' });
    // Retain historical status variants to verify the existing dashboard filters.
    await store.driver.query(`UPDATE leads SET company_name=?,extraction_status=?,validation_status=?,zoho_status=?,created_at=?,validation_result=?
      WHERE whatsapp_message_id=?`, [companies[i], i === 2 ? 'failed' : 'completed', ['valid', 'incomplete', 'invalid'][i],
      i === 0 ? 'pending' : 'not_started', `2026-09-12T10:00:0${i}.000Z`,
      JSON.stringify({ valid: i === 0, missing_fields: i === 0 ? [] : ['requirement'], errors: [] }), messages[i].whatsapp_message_id]);
  }
  const h = await backend(t, { actualStore: store, env: { DATABASE_URL: databaseUrl } });
  let result = await (await h.request('/api/leads?page_size=1')).json();
  assert.equal(result.total, 3, 'Duplicate receipts must not add dashboard leads.');
  assert.equal(result.total_pages, 3);
  assert.equal(result.items[0].company_name, 'Other company');
  result = await (await h.request('/api/leads?page_size=1&page=2')).json();
  assert.equal(result.items[0].company_name, 'Al Noor XX');
  result = await (await h.request('/api/leads?search=' + encodeURIComponent('%_'))).json();
  assert.equal(result.total, 1, 'SQL wildcard symbols in search are literal.');
  assert.equal(result.items[0].company_name, 'Al Noor %_');
  const id = result.items[0].id;
  result = await (await h.request('/api/leads?search=al%20noor&status=valid&extraction_status=completed&zoho_status=pending')).json();
  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, id);
  const detail = await (await h.request('/api/leads/' + id)).json();
  assert.equal(detail.original_message, messages[0].message_text);
  assert.deepEqual(detail.validation_result, { valid: true, missing_fields: [], errors: [] });
  assert.deepEqual(await (await h.request('/api/leads/stats')).json(), {
    total: 3, valid: 1, incomplete: 1, extraction_failed: 1, zoho_pending: 1, zoho_saved: 0,
  });
});

after(async () => {
  const mongoose = require('mongoose');
  await mongoose.disconnect().catch(() => {});
});

