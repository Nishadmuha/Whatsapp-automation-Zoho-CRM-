'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { request } = require('node:http');
const { test } = require('node:test');
const express = require('express');
const { createAdminAccess, SESSION_COOKIE, SESSION_TTL_MS } = require('../src/middleware/adminAuth');
const { requestLogger } = require('../src/middleware/requestLogger');

const USERNAME = 'synthetic-operator';
const PASSWORD = 'synthetic-session-password';
const credentials = () => ({ username: USERNAME, password: PASSWORD });
const cookieFrom = response => response.headers.get('set-cookie')?.split(';')[0] || '';

function authRequest(base, path, headers, body) {
  // Node fetch intentionally replaces a supplied Host header. Use the native
  // HTTP client to reproduce the public Host retained by a local TLS proxy.
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function setup(t, { config: overrides = {}, clock, trustProxy = false } = {}) {
  const app = express();
  const logs = [];
  app.set('trust proxy', trustProxy);
  app.use(requestLogger({ info(value) { logs.push(value); } }));
  app.use(express.json({ limit: '2kb' }));
  const access = createAdminAccess({ adminUsername: USERNAME, adminPassword: PASSWORD, ...overrides },
    clock ? { now: clock } : undefined);
  app.use('/api/admin', access.router);
  app.get('/api/protected', access.requireAuth, (_req, res) => res.json({ authorized: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, logs,
    get(path, cookie = '', headers = {}) {
      return fetch(base + path, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
    },
    login(body = credentials(), headers = {}) {
      return fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    },
    logout(cookie = '', headers = {}) {
      return fetch(base + '/api/admin/logout', { method: 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
    },
  };
}

test('missing or invalid configured credentials fail closed and unconfigured bearer tokens grant no access', async t => {
  for (const config of [{ adminUsername: '' }, { adminPassword: '' }, { adminPassword: ' ' },
    { adminUsername: 'x'.repeat(129) }, { adminPassword: 'unsafe\0credential' }]) {
    const h = await setup(t, { config });
    assert.equal((await h.login()).status, 503);
    assert.equal((await h.get('/api/protected')).status, 503);
    assert.deepEqual(await (await h.get('/api/admin/session')).json(), { authenticated: false });
  }
  const h = await setup(t);
  assert.equal((await h.get('/api/protected', '', { Authorization: 'Bearer synthetic-legacy-token' })).status, 401);
  assert.deepEqual(await (await h.get('/api/admin/session')).json(), { authenticated: false });
});

test('optional configured admin API token uses the same protected access without issuing browser sessions', async t => {
  const token = 'synthetic-api-token-' + 'a'.repeat(32);
  const h = await setup(t, { config: { adminApiToken: token } });
  for (const header of ['Bearer ' + token, 'bearer ' + token]) {
    const response = await h.get('/api/protected', '', { Authorization: header });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authorized: true });
    assert.equal(response.headers.get('set-cookie'), null);
  }
  for (const header of ['Basic ' + token, 'Bearer incorrect-' + 'b'.repeat(32), 'Bearer  ' + token, 'Bearer short',
    'Bearer ' + 'x'.repeat(257), 'Bearer ' + token + ', Bearer ' + token]) {
    assert.equal((await h.get('/api/protected', '', { Authorization: header })).status, 401);
  }
  assert.equal((await h.get('/api/protected?token=' + token)).status, 401);
  assert.equal((await h.get('/api/protected', 'ADMIN_API_TOKEN=' + token)).status, 401);
  assert.deepEqual(await (await h.get('/api/admin/session', '', { Authorization: 'Bearer ' + token })).json(), { authenticated: false });
  const cookie = cookieFrom(await h.login());
  assert.equal((await h.get('/api/protected', cookie)).status, 200);
  assert.equal((await h.logout(cookie)).status, 200);
  assert.equal((await h.get('/api/protected', cookie)).status, 401);
  assert.equal((await h.get('/api/protected', '', { Authorization: 'Bearer ' + token })).status, 200);
  assert.equal(JSON.stringify(h.logs).includes(token), false);
});

test('API-only configuration authorizes a token while invalid configuration and duplicate headers fail closed', async t => {
  const token = 'synthetic-api-only-' + 'c'.repeat(32);
  const h = await setup(t, { config: { adminUsername: '', adminPassword: '', adminApiToken: token } });
  assert.equal((await h.login()).status, 503);
  assert.equal((await h.get('/api/protected')).status, 401);
  assert.equal((await h.get('/api/protected', '', { Authorization: 'Bearer ' + token })).status, 200);
  const duplicate = await new Promise((resolve, reject) => {
    const req = request(h.base + '/api/protected', { headers: ['Host', new URL(h.base).host, 'Authorization', 'Bearer ' + token, 'Authorization', 'Bearer ' + token] }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode)); res.once('error', reject);
    });
    req.once('error', reject); req.end();
  });
  assert.equal(duplicate, 401);
  for (const adminApiToken of ['short', 'a'.repeat(257), 'a'.repeat(32) + ' ', 'a'.repeat(32) + '\n', 'a'.repeat(32) + 'é']) {
    const invalid = await setup(t, { config: { adminUsername: '', adminPassword: '', adminApiToken } });
    assert.equal((await invalid.get('/api/protected')).status, 503);
  }
});

test('wrong username and wrong password return the same generic failure without sessions or secrets', async t => {
  const h = await setup(t);
  const results = [];
  for (const body of [{ username: 'another-operator', password: PASSWORD }, { username: USERNAME, password: 'another-password' }]) {
    const response = await h.login(body);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
    results.push(await response.json());
  }
  assert.deepEqual(results[0], results[1]);
  assert.equal(JSON.stringify(results).includes(PASSWORD), false);
  assert.equal(JSON.stringify(results).includes(USERNAME), false);
  assert.equal((await h.get('/api/protected')).status, 401);
  assert.equal(JSON.stringify(h.logs).includes(PASSWORD), false);
  assert.equal(JSON.stringify(h.logs).includes(USERNAME), false);
});

test('successful login issues only an opaque bounded HttpOnly cookie and authorizes a shared protected route', async t => {
  const h = await setup(t);
  const response = await h.login(credentials(), { Origin: h.base, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true, username: USERNAME, role: 'admin', roles: ['admin', 'books'] });
  const header = response.headers.get('set-cookie');
  const cookie = cookieFrom(response);
  assert.match(cookie, new RegExp('^' + SESSION_COOKIE + '=[a-f0-9]{64}$'));
  assert.match(header, /; HttpOnly(?:;|$)/);
  assert.match(header, /; SameSite=Strict(?:;|$)/);
  assert.match(header, /; Path=\/api(?:;|$)/);
  assert.match(header, /; Max-Age=28800(?:;|$)/);
  assert.doesNotMatch(header, /; Secure(?:;|$)/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await (await h.get('/api/protected', cookie)).json(), { authorized: true });
  assert.deepEqual(await (await h.get('/api/admin/session', cookie)).json(), { authenticated: true, username: USERNAME, role: 'admin', roles: ['admin', 'books'] });
  assert.equal(JSON.stringify(h.logs).includes(cookie.split('=')[1]), false);
  assert.equal(JSON.stringify(h.logs).includes(PASSWORD), false);
});

test('login enforces an exact bounded JSON credential envelope', async t => {
  const h = await setup(t);
  for (const body of [{}, [], { username: USERNAME }, { ...credentials(), token: 'synthetic-private-extra' },
    { username: 1, password: PASSWORD }, { username: USERNAME, password: 'x'.repeat(257) },
    { username: 'x'.repeat(129), password: PASSWORD }, { username: USERNAME, password: 'unsafe\nvalue' }]) {
    const response = await h.login(body);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { success: false, message: 'Invalid login request' });
  }
  const text = await fetch(h.base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(credentials()) });
  assert.equal(text.status, 415);
  assert.equal((await h.get('/api/protected')).status, 401);
});

test('sessions expire at eight hours and a fresh access instance cannot reuse previous in-memory sessions', async t => {
  let now = Date.now();
  const h = await setup(t, { clock: () => now });
  const cookie = cookieFrom(await h.login());
  now += SESSION_TTL_MS - 1;
  assert.equal((await h.get('/api/protected', cookie)).status, 200);
  now++;
  assert.equal((await h.get('/api/protected', cookie)).status, 401);
  assert.deepEqual(await (await h.get('/api/admin/session', cookie)).json(), { authenticated: false });
  const replacement = await setup(t);
  const activeCookie = cookieFrom(await h.login());
  assert.equal((await replacement.get('/api/protected', activeCookie)).status, 401);
});

test('login rotates a prior session and logout revokes it before clearing the browser cookie', async t => {
  const h = await setup(t);
  const first = cookieFrom(await h.login());
  const next = cookieFrom(await h.login(credentials(), { Cookie: first }));
  assert.notEqual(next, first);
  assert.equal((await h.get('/api/protected', first)).status, 401);
  assert.equal((await h.get('/api/protected', next)).status, 200);
  const response = await h.logout(next, { Origin: h.base, 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: false });
  assert.match(response.headers.get('set-cookie'), new RegExp('^' + SESSION_COOKIE + '=;'));
  assert.match(response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await h.get('/api/protected', next)).status, 401);
  assert.deepEqual(await (await h.get('/api/admin/session', next)).json(), { authenticated: false });
  assert.equal((await h.logout()).status, 200);
});

test('malformed, duplicated, oversized and unknown session cookies fail closed', async t => {
  const h = await setup(t);
  const cookie = cookieFrom(await h.login());
  const token = cookie.split('=')[1];
  for (const candidate of [cookie + '; ' + cookie, SESSION_COOKIE + '=unknown', SESSION_COOKIE + '=' + token + 'x',
    SESSION_COOKIE + '="' + token + '"', SESSION_COOKIE + '=%61' + token.slice(1),
    SESSION_COOKIE + ' =' + token, 'malformed; ' + cookie, 'other=' + 'x'.repeat(4096) + '; ' + cookie,
    'x=y;'.repeat(101) + cookie, SESSION_COOKIE + '=' + 'a'.repeat(64)]) {
    assert.equal((await h.get('/api/protected', candidate)).status, 401);
    assert.deepEqual(await (await h.get('/api/admin/session', candidate)).json(), { authenticated: false });
  }
  assert.equal((await h.get('/api/protected', 'other=value; ' + cookie)).status, 200);
});

test('state-changing auth routes reject foreign, malformed and opaque Origins and cross-site Fetch Metadata', async t => {
  const h = await setup(t);
  const cookie = cookieFrom(await h.login());
  for (const headers of [
    { Origin: 'https://other.example.test' }, { Origin: 'null' }, { Origin: h.base + '/path' },
    { Origin: h.base + '?query=1' }, { Origin: h.base + '#fragment' },
    { Origin: h.base.replace('http://', 'http://synthetic-user:synthetic-password@') },
    { Origin: h.base, 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
  ]) {
    assert.equal((await h.login(credentials(), headers)).status, 403);
    assert.equal((await h.logout(cookie, headers)).status, 403);
  }
  assert.equal((await h.get('/api/protected', cookie)).status, 200);
  assert.equal((await h.logout(cookie)).status, 200);
});

test('a matching HTTPS browser Origin behind ngrok is accepted with Secure cookies while raw forwarding headers are ignored', async t => {
  const h = await setup(t);
  const headers = { Host: 'dashboard.example.test', Origin: 'https://dashboard.example.test', 'Sec-Fetch-Site': 'same-origin' };
  const response = await authRequest(h.base, '/api/admin/login', headers, credentials());
  assert.equal(response.status, 200);
  assert.match(response.headers['set-cookie'][0], /; Secure(?:;|$)/);
  const logout = await authRequest(h.base, '/api/admin/logout', { ...headers, Cookie: response.headers['set-cookie'][0].split(';')[0] });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /; Secure(?:;|$)/);
  assert.equal((await authRequest(h.base, '/api/admin/login', { ...headers, Origin: 'https://foreign.example.test' }, credentials())).status, 403);
  const rawForwarded = await h.login(credentials(), { 'X-Forwarded-Proto': 'https' });
  assert.equal(rawForwarded.status, 200);
  assert.doesNotMatch(rawForwarded.headers.get('set-cookie'), /; Secure(?:;|$)/);
});

test('production and framework-validated HTTPS require Secure cookies and reject a downgraded browser Origin', async t => {
  const production = await setup(t, { config: { production: true } });
  assert.match((await production.login()).headers.get('set-cookie'), /; Secure(?:;|$)/);
  const https = await setup(t, { trustProxy: 1 });
  assert.equal((await https.login(credentials(), { Origin: https.base, 'X-Forwarded-Proto': 'https' })).status, 403);
  const response = await https.login(credentials(), { Origin: https.base.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /; Secure(?:;|$)/);
});

test('ten failed login attempts trigger a dedicated limiter without blocking session checks or logout', async t => {
  const h = await setup(t);
  const cookie = cookieFrom(await h.login());
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await h.login({ username: USERNAME, password: 'incorrect-synthetic-password' })).status, 401);
  }
  const response = await h.login();
  assert.equal(response.status, 429);
  assert.ok(response.headers.get('retry-after'));
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await h.get('/api/protected', cookie)).status, 200);
  assert.deepEqual(await (await h.get('/api/admin/session', cookie)).json(), { authenticated: true, username: USERNAME, role: 'admin', roles: ['admin', 'books'] });
  assert.equal((await h.logout(cookie)).status, 200);
});

test('successful logins do not consume failure limits and session capacity evicts only the oldest session', async t => {
  const h = await setup(t);
  async function login() {
    const response = await h.login();
    assert.equal(response.status, 200);
    // Drain every response before the next of 1001 requests, so transport
    // resources are released without relying on garbage collection.
    assert.deepEqual(await response.json(), { authenticated: true, username: USERNAME, role: 'admin', roles: ['admin', 'books'] });
    return cookieFrom(response);
  }
  const first = await login();
  let second;
  let last;
  for (let index = 0; index < 1000; index++) {
    last = await login();
    if (index === 0) second = last;
  }
  assert.equal((await h.get('/api/protected', first)).status, 401);
  assert.equal((await h.get('/api/protected', second)).status, 200);
  assert.equal((await h.get('/api/protected', last)).status, 200);
});
