'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { testEnv } = require('./helpers');

test('RBAC: separates WhatsApp admin access and Zoho Books access', async (t) => {
  const adminPassword = randomBytes(24).toString('hex');
  const booksPassword = randomBytes(24).toString('hex');

  const env = testEnv({
    ADMIN_USERNAME: 'super-admin',
    ADMIN_PASSWORD: adminPassword,
    BOOKS_USERNAME: 'books-accountant',
    BOOKS_PASSWORD: booksPassword,
    ADMIN_BOOKS_ACCESS: 'false',
  });

  const mockBillStore = {
    async getBooksOverviewStats() {
      return { total: 0, by_status: {} };
    },
    async listBills() {
      return { items: [], total: 0 };
    },
  };

  const store = {
    async init() {},
    async ping() {},
    async countLeads() { return 0; },
    async listLeads() { return { items: [], total: 0, page: 1, total_pages: 0 }; },
    async getLeadStats() { return { total: 0, valid: 0, incomplete: 0, zoho_pending: 0 }; },
    async listConversations() { return { items: [], total: 0 }; },
  };

  const app = createApp({ env, store, billStore: mockBillStore });
  await app.locals.ready.catch(() => {});

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });

  const base = 'http://127.0.0.1:' + server.address().port;

  // 1. Unauthenticated request to /api/books/stats -> 401
  const unauthBooksRes = await fetch(base + '/api/books/stats');
  assert.equal(unauthBooksRes.status, 401);

  // 2. Unauthenticated request to /api/leads/stats -> 401
  const unauthLeadsRes = await fetch(base + '/api/leads/stats');
  assert.equal(unauthLeadsRes.status, 401);

  // 3. Login as Admin
  const adminLoginRes = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'super-admin', password: adminPassword }),
  });
  assert.equal(adminLoginRes.status, 200);
  const adminData = await adminLoginRes.json();
  assert.equal(adminData.role, 'admin');
  assert.deepEqual(adminData.roles, ['admin']);
  const adminCookie = adminLoginRes.headers.get('set-cookie').split(';')[0];

  // 4. Admin accesses /api/leads/stats -> 200 OK
  const adminLeadsRes = await fetch(base + '/api/leads/stats', {
    headers: { cookie: adminCookie },
  });
  assert.equal(adminLeadsRes.status, 200);

  // 5. Admin attempts to access /api/books/stats -> 403 Forbidden
  const adminBooksRes = await fetch(base + '/api/books/stats', {
    headers: { cookie: adminCookie },
  });
  assert.equal(adminBooksRes.status, 403);
  const adminBooksBody = await adminBooksRes.json();
  assert.equal(adminBooksBody.success, false);
  assert.match(adminBooksBody.message, /Zoho Books/i);

  // 6. Login as Books User
  const booksLoginRes = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'books-accountant', password: booksPassword }),
  });
  assert.equal(booksLoginRes.status, 200);
  const booksData = await booksLoginRes.json();
  assert.equal(booksData.role, 'books');
  assert.deepEqual(booksData.roles, ['books']);
  const booksCookie = booksLoginRes.headers.get('set-cookie').split(';')[0];

  // 7. Books user accesses /api/books/stats -> 200 OK
  const booksStatsRes = await fetch(base + '/api/books/stats', {
    headers: { cookie: booksCookie },
  });
  assert.equal(booksStatsRes.status, 200);

  // 8. Books user attempts to access /api/leads/stats -> 403 Forbidden
  const booksLeadsRes = await fetch(base + '/api/leads/stats', {
    headers: { cookie: booksCookie },
  });
  assert.equal(booksLeadsRes.status, 403);
  const booksLeadsBody = await booksLeadsRes.json();
  assert.equal(booksLeadsBody.success, false);
  assert.match(booksLeadsBody.message, /Administrator access required/i);

  // 9. Books user attempts to access /api/chats -> 403 Forbidden
  const booksChatsRes = await fetch(base + '/api/chats', {
    headers: { cookie: booksCookie },
  });
  assert.equal(booksChatsRes.status, 403);

  // 10. Check /api/admin/session with books user
  const booksSessionRes = await fetch(base + '/api/admin/session', {
    headers: { cookie: booksCookie },
  });
  assert.equal(booksSessionRes.status, 200);
  const booksSession = await booksSessionRes.json();
  assert.equal(booksSession.authenticated, true);
  assert.equal(booksSession.role, 'books');
  assert.deepEqual(booksSession.roles, ['books']);
});

test('RBAC: permits dual access when ADMIN_BOOKS_ACCESS=true', async (t) => {
  const adminPassword = randomBytes(24).toString('hex');
  const booksPassword = randomBytes(24).toString('hex');

  const env = testEnv({
    ADMIN_USERNAME: 'super-admin',
    ADMIN_PASSWORD: adminPassword,
    BOOKS_USERNAME: 'books-accountant',
    BOOKS_PASSWORD: booksPassword,
    ADMIN_BOOKS_ACCESS: 'true',
  });

  const mockBillStore = {
    async getBooksOverviewStats() {
      return { total: 0, by_status: {} };
    },
    async listBills() {
      return { items: [], total: 0 };
    },
  };

  const store = {
    async init() {},
    async ping() {},
    async getLeadStats() { return { total: 0, valid: 0, incomplete: 0, zoho_pending: 0 }; },
  };

  const app = createApp({ env, store, billStore: mockBillStore });
  await app.locals.ready.catch(() => {});

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });

  const base = 'http://127.0.0.1:' + server.address().port;

  const adminLoginRes = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'super-admin', password: adminPassword }),
  });
  assert.equal(adminLoginRes.status, 200);
  const adminData = await adminLoginRes.json();
  assert.equal(adminData.role, 'admin');
  assert.deepEqual(adminData.roles, ['admin', 'books']);
  const adminCookie = adminLoginRes.headers.get('set-cookie').split(';')[0];

  const adminLeadsRes = await fetch(base + '/api/leads/stats', {
    headers: { cookie: adminCookie },
  });
  assert.equal(adminLeadsRes.status, 200);

  const adminBooksRes = await fetch(base + '/api/books/stats', {
    headers: { cookie: adminCookie },
  });
  assert.equal(adminBooksRes.status, 200);
});
