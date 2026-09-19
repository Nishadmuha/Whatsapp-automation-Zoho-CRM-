'use strict';
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { testEnv } = require('./helpers');

async function createTestServer(t) {
  const adminUser = 'test-admin';
  const adminPass = randomBytes(24).toString('hex');
  const env = testEnv({
    ADMIN_USERNAME: adminUser,
    ADMIN_PASSWORD: adminPass,
  });
  const store = {
    async init() {},
    async ping() {},
    async listLeads() { return { items: [], total: 0, page: 1, pageSize: 20, totalPages: 1 }; },
    async getLeadStats() { return { total: 0, valid: 0, incomplete: 0, zoho_pending: 0 }; },
  };
  const logger = { info() {}, warn() {}, error() {} };
  const app = createApp({ env, store, logger });
  await app.locals.ready.catch(() => {});
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, adminUser, adminPass };
}

test('GET / redirects unauthenticated visitors to the dedicated login page', async t => {
  const { base } = await createTestServer(t);
  const res = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('GET /admin and /admin/ redirect unauthenticated visitors to the login page', async t => {
  const { base } = await createTestServer(t);
  for (const path of ['/admin', '/admin/']) {
    const res = await fetch(base + path, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
  }
});

test('GET / followed automatically serves the dedicated admin login page', async t => {
  const { base } = await createTestServer(t);
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('id="login-form"'), 'HTML must contain login form');
  assert.ok(html.includes('id="username"'), 'HTML must contain username input');
  assert.ok(html.includes('id="password"'), 'HTML must contain password input');
  assert.ok(html.includes('id="login-submit"'), 'HTML must contain login submit button');
});

test('invalid API endpoint returns JSON 404 Route not found', async t => {
  const { base } = await createTestServer(t);
  const res = await fetch(base + '/api/test-does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
  const body = await res.json();
  assert.deepEqual(body, { success: false, message: 'Route not found' });
});

test('admin login and authentication cycle works as expected', async t => {
  const { base, adminUser, adminPass } = await createTestServer(t);

  // Check unauthenticated session
  const sessRes = await fetch(base + '/api/admin/session');
  assert.equal(sessRes.status, 200);
  const sessData = await sessRes.json();
  assert.equal(sessData.authenticated, false);

  // Login
  const loginRes = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: adminUser, password: adminPass }),
  });
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.equal(loginData.authenticated, true);
  const cookie = loginRes.headers.get('set-cookie');
  assert.ok(cookie);

  // Check authenticated session
  const authSessRes = await fetch(base + '/api/admin/session', {
    headers: { Cookie: cookie.split(';')[0] },
  });
  assert.equal(authSessRes.status, 200);
  const authSessData = await authSessRes.json();
  assert.equal(authSessData.authenticated, true);

  // Logout
  const logoutRes = await fetch(base + '/api/admin/logout', {
    method: 'POST',
    headers: { Cookie: cookie.split(';')[0] },
  });
  assert.equal(logoutRes.status, 200);

  // Session is now unauthenticated
  const postLogoutSess = await fetch(base + '/api/admin/session', {
    headers: { Cookie: cookie.split(';')[0] },
  });
  assert.equal(postLogoutSess.status, 200);
  const postLogoutData = await postLogoutSess.json();
  assert.equal(postLogoutData.authenticated, false);
});
