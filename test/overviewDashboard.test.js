'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { renderAdminPage } = require('../src/views/adminPage');

class Element {
  constructor() { this.textContent = ''; this.innerHTML = ''; this.hidden = true; this.style = {}; this.listeners = new Map(); }
  append() {}
  replaceChildren() {}
  addEventListener(event, handler) { this.listeners.set(event, handler); }
}

const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, async json() { return body; } });
const signedIn = () => response({ authenticated: true, username: 'synthetic-admin', roles: ['admin'] });

async function dashboard(sessionResponse = signedIn, { updateUser = () => {}, metricsResponse = () => response({ items: [], total: 0 }) } = {}) {
  const html = renderAdminPage('overview');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const requests = [];
  const timers = [];
  const redirects = [];
  const window = {
    location: { set href(value) { redirects.push(value); }, replace(value) { redirects.push(value); } },
    VoltronixNav: { initNav() {}, updateUser },
  };
  const context = {
    document: {
      getElementById: id => elements.get(id) || null,
      querySelectorAll: () => [],
      createElement: () => new Element(),
      createTextNode: value => ({ textContent: value }),
    },
    window,
    setTimeout(callback) { timers.push(callback); },
    async fetch(url, options) {
      requests.push({ url, options });
      return url === '/api/admin/session' ? sessionResponse() : metricsResponse(url);
    },
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, '../src/admin/overview.js'), 'utf8'), context);
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  return { el: id => elements.get(id), requests, redirects, timers };
}

for (const [label, sessionResponse] of [
  ['network failure', () => { throw new Error('synthetic network failure'); }],
  ['503', () => response({}, 503)],
  ['429', () => response({}, 429)],
  ['403', () => response({}, 403)],
  ['invalid JSON', () => ({ ok: true, status: 200, json() { throw new SyntaxError('synthetic HTML response'); } })],
  ['invalid session payload', () => response({})],
]) {
  test(`overview does not bounce an authenticated page to login on ${label}`, async () => {
    const h = await dashboard(sessionResponse);
    assert.deepEqual(h.redirects, []);
    assert.equal(h.requests.length, 1);
    assert.equal(h.el('overview-feedback').hidden, false);
    assert.match(h.el('overview-feedback').textContent, /retry|try again/i);
  });
}

test('overview rendering failures do not become authentication redirects', async () => {
  const h = await dashboard(signedIn, { updateUser() { throw new Error('synthetic rendering failure'); } });
  assert.deepEqual(h.redirects, []);
  assert.equal(h.el('overview-feedback').hidden, false);
});

for (const [label, sessionResponse] of [
  ['expired session', () => response({ authenticated: false })],
  ['401', () => response({}, 401)],
]) {
  test(`overview sends ${label} to login once without loading private data`, async () => {
    const h = await dashboard(sessionResponse);
    assert.deepEqual(h.redirects, ['/login']);
    assert.equal(h.requests.length, 1);
  });
}

test('overview keeps authenticated users on the dashboard and loads real metrics', async () => {
  const h = await dashboard();
  assert.deepEqual(h.redirects, []);
  assert.equal(h.requests.length, 6);
  assert.equal(h.el('topbar-username').textContent, 'synthetic-admin');
  assert.equal(h.el('overview-feedback').hidden, true);
  for (const { options } of h.requests) {
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
  }
});

test('Force Sync retries session verification without reloading after a temporary failure', async () => {
  let available = false;
  const h = await dashboard(() => available ? signedIn() : response({}, 503));
  assert.deepEqual(h.redirects, []);
  available = true;
  await h.el('btn-force-sync').listeners.get('click')();
  h.timers.forEach(callback => callback());
  assert.equal(h.requests.filter(r => r.url === '/api/admin/session').length, 2);
  assert.equal(h.el('overview-feedback').hidden, true);
  assert.equal(h.el('btn-force-sync').disabled, false);
  assert.equal(h.el('topbar-username').textContent, 'synthetic-admin');
  assert.deepEqual(h.redirects, []);
});

test('optional Books permission/API failures do not restart the dashboard', async () => {
  const h = await dashboard(signedIn, {
    metricsResponse: url => url.startsWith('/api/books') ? response({}, 403) : response({ items: [], total: 2 }),
  });
  assert.deepEqual(h.redirects, []);
  assert.equal(h.el('kpi-total-leads').textContent, '2');
});
