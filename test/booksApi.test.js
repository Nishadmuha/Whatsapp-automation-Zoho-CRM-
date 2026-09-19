'use strict';

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { testEnv } = require('./helpers');

async function setupBooksBackend(t, { env: overrides = {}, billStoreMethods = {} } = {}) {
  const calls = [];
  const logs = [];
  const adminPassword = randomBytes(24).toString('hex');
  const env = testEnv({
    ADMIN_USERNAME: 'test-admin',
    ADMIN_PASSWORD: adminPassword,
    ...overrides,
  });

  const billId = randomUUID();
  const sessionId = randomUUID();
  const sampleBill = {
    bill_id: billId,
    session_id: sessionId,
    source_message_id: 'wamid.test-books-1',
    worker_phone: '+971501112233',
    status: 'COMPLETED',
    zoho_status: 'SYNCED',
    vendor_name: 'Fast Electricals Trading LLC',
    vendor_phone: '+97142233445',
    vendor_email: 'sales@fastelectricals.ae',
    vendor_trn: '100234567800003',
    zoho_vendor_id: '460000000012345',
    bill_number: 'INV-2026-0889',
    bill_date: '2026-09-15',
    due_date: '2026-10-15',
    currency: 'AED',
    subtotal: 1500,
    tax_amount: 75,
    discount_amount: 0,
    total_amount: 1575,
    line_items: [
      {
        name: 'PVC Conduit Pipes 20mm',
        description: '20mm high impact conduit pipes 3m length',
        quantity: 100,
        rate: 15,
        tax: 0.75,
        amount: 1500,
        account_id: '460000000099999',
      },
    ],
    notes: 'Urgent site delivery to Dubai South project',
    attachments: [
      {
        storage_reference: 'att-ref-12345',
        original_filename: 'fast_electricals_inv_0889.pdf',
        mime_type: 'application/pdf',
        media_id: 'media-books-999',
        storage_url: '/api/media/att-ref-12345',
      },
    ],
    zoho_bill_id: '460000000088888',
    zoho_bill_url: 'https://books.zoho.com/app#/bills/460000000088888',
    created_at: new Date('2026-09-15T10:00:00Z').toISOString(),
    updated_at: new Date('2026-09-15T10:05:00Z').toISOString(),
  };

  const sampleSession = {
    session_id: sessionId,
    worker_phone: '+971501112233',
    bill_id: billId,
    state: 'COMPLETED',
    last_message_id: 'wamid.test-books-1',
    created_at: new Date('2026-09-15T10:00:00Z').toISOString(),
    updated_at: new Date('2026-09-15T10:05:00Z').toISOString(),
    pending_action: 'Bill successfully created in Zoho Books',
  };

  const sampleStats = {
    total: 1,
    processing: 0,
    awaiting_additional_info: 0,
    awaiting_edit: 0,
    awaiting_final_confirmation: 0,
    creating_in_zoho: 0,
    completed: 1,
    cancelled: 0,
    failed: 0,
    draft: 0,
    pending_review: 0,
    ready_for_confirmation: 0,
    creating: 0,
    zoho_synced: 1,
    zoho_syncing: 0,
    zoho_not_synced: 0,
    zoho_failed: 0,
  };

  const mockBillStore = {
    async getBooksOverviewStats() {
      calls.push(['getBooksOverviewStats']);
      return sampleStats;
    },
    async listBills(params) {
      calls.push(['listBills', params]);
      return { items: [sampleBill], total: 1 };
    },
    async getBillWithDetails(id) {
      calls.push(['getBillWithDetails', id]);
      if (id === billId) {
        return {
          ...sampleBill,
          session: sampleSession,
          extraction: {
            job_id: 'job-123',
            status: 'COMPLETED',
            attempts: 1,
            model: 'gpt-4o-mini',
            confidence: { overall: 0.95 },
            grounding: { grounded: true },
            validation: { valid: true },
          },
        };
      }
      return null;
    },
    async listBillSessions(params) {
      calls.push(['listBillSessions', params]);
      return { items: [sampleSession], total: 1 };
    },
    async getBillSession(id) {
      calls.push(['getBillSession', id]);
      return id === sessionId ? sampleSession : null;
    },
    ...billStoreMethods,
  };

  const store = {
    async init() {},
    async ping() {},
  };

  const app = createApp({
    env,
    store,
    billStore: mockBillStore,
    logger: Object.fromEntries(['info', 'warn', 'error'].map((l) => [l, (entry) => logs.push(entry)])),
  });

  await app.locals.ready.catch(() => {});
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });

  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';

  const loginRes = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }),
  });
  assert.equal(loginRes.status, 200);
  cookie = loginRes.headers.get('set-cookie').split(';')[0];

  return {
    sampleBill,
    sampleSession,
    sampleStats,
    env,
    logs,
    calls,
    base,
    cookie,
    billId,
    sessionId,
    request(path = '/api/books', sessionCookie = cookie) {
      return fetch(base + path, { headers: sessionCookie ? { Cookie: sessionCookie } : {} });
    },
  };
}

test('books API: requires admin authentication on all endpoints', async (t) => {
  const h = await setupBooksBackend(t);

  for (const path of ['/api/books/stats', '/api/books', '/api/books/bills', `/api/books/${h.billId}`]) {
    const resUnauth = await h.request(path, null);
    assert.equal(resUnauth.status, 401);
  }

  assert.equal(h.calls.length, 0);
});

test('books API: GET /api/books/stats returns overview statistics', async (t) => {
  const h = await setupBooksBackend(t);

  const res = await h.request('/api/books/stats');
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.total, 1);
  assert.equal(data.completed, 1);
  assert.equal(data.processing, 0);
  assert.equal(data.zoho_synced, 1);
  assert.ok(h.calls.some((c) => c[0] === 'getBooksOverviewStats'));
});

test('books API: GET /api/books and /api/books/bills return paginated bill list with filters', async (t) => {
  const h = await setupBooksBackend(t);

  const res = await h.request('/api/books?page=1&page_size=20&search=Fast&status=COMPLETED');
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.total, 1);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].bill_id, h.billId);
  assert.equal(data.items[0].vendor_name, 'Fast Electricals Trading LLC');

  // Alias /api/books/bills
  const aliasRes = await h.request('/api/books/bills');
  assert.equal(aliasRes.status, 200);
});

test('books API: GET /api/books/:id returns full bill details with vendor, line items, AI extraction and session', async (t) => {
  const h = await setupBooksBackend(t);

  const res = await h.request(`/api/books/${h.billId}`);
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.bill_id, h.billId);
  assert.equal(data.bill_number, 'INV-2026-0889');
  assert.equal(data.vendor_name, 'Fast Electricals Trading LLC');
  assert.equal(data.line_items.length, 1);
  assert.equal(data.line_items[0].name, 'PVC Conduit Pipes 20mm');
  assert.equal(data.line_items[0].amount, 1500);

  // Associated session and extraction
  assert.ok(data.session);
  assert.equal(data.session.session_id, h.sessionId);
  assert.equal(data.session.state, 'COMPLETED');
  assert.ok(data.extraction);
  assert.equal(data.extraction.job_id, 'job-123');
  assert.equal(data.extraction.model, 'gpt-4o-mini');
});

test('books API: GET /api/books/:id returns 404 for nonexistent bill', async (t) => {
  const h = await setupBooksBackend(t);

  const res = await h.request('/api/books/nonexistent-id');
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.success, false);
});

test('books API: GET /api/books/sessions returns session listing', async (t) => {
  const h = await setupBooksBackend(t);

  const res = await h.request('/api/books/sessions');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.total, 1);
  assert.equal(data.items[0].session_id, h.sessionId);
});

test('books API: redacts secrets from responses and does not leak environment credentials', async (t) => {
  const secretKey = 'sk-synthetic-super-secret-key-12345';
  const h = await setupBooksBackend(t, {
    env: { OPENAI_API_KEY: secretKey },
    billStoreMethods: {
      async getBillWithDetails(id) {
        return {
          bill_id: id,
          vendor_name: 'Fast Electricals',
          notes: `Created with key ${secretKey}`,
        };
      },
    },
  });

  const res = await h.request(`/api/books/${h.billId}`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text.includes(secretKey), false);
  assert.equal(text.includes('[REDACTED]'), true);
});
