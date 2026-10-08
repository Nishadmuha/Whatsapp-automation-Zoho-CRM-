'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, validBill, WORKER } = require('./billFixtures');
const { temporaryStore } = require('./helpers');
const { createBillStore } = require('../src/database/billStore');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');
const { isBooksBatchBoundary, isBossBatchBoundary } = require('../src/services/whatsapp/messageBatching');

const ORGANIZATION = validBill().organization.organizationId;
const CUSTOMER = 'WAITING_FOR_CUSTOMER_SELECTION';
const PROJECT = 'WAITING_FOR_PROJECT_DETAILS';
const customer = (id, name, extra = {}) => ({ id, name, status: 'active', contact_type: 'customer',
  organizationId: ORGANIZATION, ...extra });

async function harness({ exact = false, contacts = null, detail = null } = {}) {
  let listReads = 0, detailReads = 0, failSearch = false;
  const records = contacts || Array.from({ length: 666 }, (_, index) =>
    customer(`customer-${index}`, exact && index === 555 ? 'Ogsi' : `Fixture company ${index}`));
  const f = fixture({ bill: { ...validBill(), customer_details: null }, workerAnswers: null, workerPaymentMethod: null,
    zohoOverrides: {
      async searchCustomer({ searchText, organizationId }) {
        listReads++;
        assert.equal(organizationId, ORGANIZATION);
        if (failSearch) throw new Error('Customer search unavailable');
        const needle = (searchText || '').toLowerCase();
        return structuredClone(records.filter(record => !needle || [record.name, record.company_name, record.customer_code]
          .some(value => String(value || '').toLowerCase().includes(needle))));
      },
      async getCustomer(id, { organizationId }) {
        detailReads++;
        assert.equal(organizationId, ORGANIZATION);
        if (detail instanceof Error) throw detail;
        return structuredClone(detail || records.find(record => record.id === id));
      },
    } });
  const initial = await f.send('Invoice details');
  assert.equal(initial.state, CUSTOMER);
  // The in-memory fixture has no storage-generated timestamp. Production
  // sessions already persist created_at; simulate that real snapshot age.
  await f.billStore.updateBillSession(initial.sessionId, { created_at: new Date() });
  return { ...f, initial, listReads: () => listReads, detailReads: () => detailReads,
    failSearch: () => { failSearch = true; } };
}

test('Ogsi absent from the complete 666-customer list keeps manual fallback without another Zoho search', async () => {
  const h = await harness();
  const result = await h.send('Ogsi');
  assert.equal(result.state, PROJECT);
  assert.match(result.replyText, /under Ogsi\?/);
  assert.equal(result.bill.customer_details.customer_name, 'Ogsi');
  assert.equal(result.bill.customer_details.customer_source, 'manual');
  assert.equal(result.bill.customer_details.customer_lookup_status, 'not_found');
  assert.equal(result.bill.customer_details.contact_id, null);
  assert.equal(h.listReads(), 1);
  assert.equal(h.detailReads(), 0);
  assert.equal(h.calls.filter(([action]) => action === 'extract').length, 1);
  assert.equal(h.calls.some(([action]) => ['edit', 'merge', 'create'].includes(action)), false);
});

test('an exact typed customer outside the visible page reuses the complete list and fetches fresh contact details', async () => {
  const h = await harness({ exact: true });
  const result = await h.send('Ogsi');
  assert.equal(result.state, PROJECT);
  assert.equal(result.bill.customer_details.contact_id, 'customer-555');
  assert.equal(result.bill.customer_details.customer_name, 'Ogsi');
  assert.equal(h.listReads(), 1);
  assert.equal(h.detailReads(), 1);
  assert.ok(result.replyMessages[0].includes('Ogsi'));
});

for (const [name, alter] of [
  ['stale list', session => { session.created_at = new Date(Date.now() - 60000); }],
  ['missing age', session => { delete session.created_at; }],
  ['future age', session => { session.created_at = new Date(Date.now() + 60000); }],
  ['filtered search', session => { session.customer_search = 'Og'; }],
  ['page-only list', session => { session.customer_all_options = []; }],
  ['missing full-list metadata', session => { delete session.customer_search; }],
  ['sparse legacy names', session => {
    const option = session.customer_all_options[0];
    option.raw = { contact_name: 'Ogsi' };
    delete option.contactName; delete option.companyName; delete option.displayName;
  }],
  ['mixed organization metadata', session => { session.customer_all_options[0].organizationId = 'other-org'; }],
]) {
  test(`${name} uses a live customer search rather than a cached manual fallback`, async () => {
    const h = await harness();
    alter(await h.billStore.getBillSession(h.initial.sessionId));
    h.failSearch();
    const result = await h.send('Ogsi');
    assert.equal(result.state, CUSTOMER);
    assert.match(result.replyText, /could not load/);
    assert.equal(result.bill.customer_details.customer_lookup_status, null);
    assert.equal(h.listReads(), 2);
    assert.equal(h.detailReads(), 0);
  });
}

for (const [name, detail, expected] of [
  ['unavailable', new Error('Customer detail unavailable'), /could not load the selected/],
  ['wrong ID', customer('different-id', 'Ogsi'), /could not be verified/],
  ['wrong organization', customer('customer-555', 'Ogsi', { organizationId: 'other-org' }), /could not be verified/],
  ['inactive', customer('customer-555', 'Ogsi', { status: 'inactive' }), /inactive/],
  ['vendor instead of customer', customer('customer-555', 'Ogsi', { contact_type: 'vendor' }), /could not be verified/],
  ['renamed', customer('customer-555', 'Renamed Company'), /could not be verified/],
]) {
  test(`cached exact customer with ${name} fresh details cannot become a confirmed or manual customer`, async () => {
    const h = await harness({ exact: true, detail });
    const result = await h.send('Ogsi');
    assert.equal(result.state, CUSTOMER);
    assert.match(result.replyText, expected);
    const session = await h.billStore.getBillSession(h.initial.sessionId);
    assert.equal(session.bill_data.customer_details.contact_id, null);
    assert.equal(session.bill_data.customer_details.customer_lookup_status, null);
    assert.equal(h.listReads(), 1);
    assert.equal(h.detailReads(), 1);
    assert.equal(h.calls.some(([action]) => action === 'create'), false);
  });
}

for (const [name, contacts] of [
  ['ambiguous', [customer('first', 'Ogsi'), customer('second', 'Ogsi')]],
  ['inactive', [customer('first', 'Ogsi', { status: 'inactive' })]],
  ['wrong type', [customer('first', 'Ogsi', { contact_type: 'vendor' })]],
]) {
  test(`${name} cached exact matches retain the remote selection policy`, async () => {
    const h = await harness({ contacts });
    const result = await h.send('Ogsi');
    assert.equal(result.state, CUSTOMER);
    assert.ok(result.replyInteractive);
    assert.equal(h.listReads(), 2);
    assert.equal(h.detailReads(), 0);
  });
}

test('labelled customer, explicit search and MANUAL keep their existing selection policies', async () => {
  for (const text of ['Customer: Ogsi', 'SEARCH: Ogsi']) {
    const h = await harness({ exact: true });
    const result = await h.send(text);
    assert.equal(result.state, CUSTOMER);
    assert.ok(result.replyInteractive);
    assert.equal(h.listReads(), 2);
    assert.equal(h.detailReads(), 0);
  }
  const h = await harness({ exact: true });
  const result = await h.send('MANUAL: Ogsi');
  assert.equal(result.state, PROJECT);
  assert.equal(result.bill.customer_details.customer_lookup_status, 'manual_entry');
  assert.equal(result.bill.customer_details.contact_id, null);
  assert.equal(h.listReads(), 1);
  assert.equal(h.detailReads(), 0);
});

test('partial names, customer codes and punctuation do not gain fuzzy automatic selection', async () => {
  for (const [text, record] of [
    ['Ogsi', customer('other', 'Ogsi Contracting LLC')],
    ['OGSI', customer('other', 'Another Customer', { customer_code: 'OGSI' })],
    ['O.G.S.I.', customer('other', 'Ogsi')],
  ]) {
    const h = await harness({ contacts: [record] });
    const result = await h.send(text);
    assert.equal(result.state, PROJECT);
    assert.equal(result.bill.customer_details.contact_id, null);
    assert.equal(result.bill.customer_details.customer_lookup_status, 'not_found');
    assert.equal(h.listReads(), 1);
    assert.equal(h.detailReads(), 0);
  }
});

test('a typed customer response bypasses five seconds using only session state while media and edit fragments still batch', async t => {
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();
  await billStore.createBillSession({ worker_phone: WORKER, state: CUSTOMER });
  const sessions = billStore.col('bill_sessions');
  const originalCol = billStore.col.bind(billStore);
  let queried = false;
  t.mock.method(billStore, 'col', name => name === 'bill_sessions' ? {
    async findOne(filter, options) {
      queried = true;
      assert.deepEqual(options, { projection: { state: 1, _id: 0, 'bill_data.bill_date': 1 } });
      return sessions.findOne(filter, options);
    },
  } : originalCol(name));
  await billStore.enqueueBillExtraction({ messageId: 'ogsi-reply', workerPhone: WORKER,
    payload: { message_type: 'text', message_text: 'Ogsi' } });
  const options = { batchQuietMs: 5000, batchBoundary: isBooksBatchBoundary, batchSessionAware: true };
  const claimed = await billStore.claimBillExtraction(options);
  assert.equal(claimed?.message_id, 'ogsi-reply');
  assert.equal(queried, true);
  await billStore.completeBillExtraction(claimed.job_id, claimed.lease_token);
  for (const text of ['Invoice 123 total 100', 'Customer: Ogsi; Payment method: Cash', 'Ogsi\nProject: Workshop', 'change total to 100']) {
    assert.equal(isBooksBatchBoundary({ text }, { state: CUSTOMER }), false, text);
  }
  assert.equal(isBooksBatchBoundary({ text: 'Ogsi' }, { state: 'WAITING_FOR_EDIT_INSTRUCTION' }), false);
  assert.equal(isBossBatchBoundary({ messageType: 'text', text: 'Ogsi' }), false);
  await billStore.enqueueBillExtraction({ messageId: 'invoice-image', workerPhone: WORKER,
    payload: { message_type: 'image', media_id: 'fixture-image', message_text: 'Ogsi' } });
  assert.equal(await billStore.claimBillExtraction(options), null);
});

test('a missing bill-date reply is immediate while ambiguous dates, known bare dates and invoice fragments keep batching', async t => {
  const state = 'WAITING_FOR_ADDITIONAL_INFO';
  assert.equal(isBooksBatchBoundary({ text: '7-oct-26' }, { state, bill_data: { bill_date: null } }), true);
  assert.equal(isBooksBatchBoundary({ text: '7-oct-26' }, { state, bill_data: { bill_date: '2026-10-01' } }), false);
  assert.equal(isBooksBatchBoundary({ text: 'Bill date: 7-oct-26' }, { state, bill_data: { bill_date: '2026-10-01' } }), true);
  for (const text of ['7/10/26', 'Invoice 123 total 100 date 7-oct-26', 'Bill date: 7-oct-26; total: 100']) {
    assert.equal(isBooksBatchBoundary({ text }, { state, bill_data: { bill_date: null } }), false, text);
  }
  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();
  await billStore.createBillSession({ worker_phone: WORKER, state, bill_data: { bill_date: null } });
  await billStore.enqueueBillExtraction({ messageId: 'missing-date-reply', workerPhone: WORKER,
    payload: { message_type: 'text', message_text: '7-oct-26' } });
  const claimed = await billStore.claimBillExtraction({ batchQuietMs: 5000, batchBoundary: isBooksBatchBoundary, batchSessionAware: true });
  assert.equal(claimed?.message_id, 'missing-date-reply');
});

const COMPLETE_CUSTOMER_REPLY = 'Ogsi\nProject: Electrical\nPayment method: Cash\nPayment status: paid';

test('only a complete customer, project, supported method and payment-status bundle bypasses the quiet window', async t => {
  for (const separator of ['\n', '; ']) {
    for (const method of ['Cash', 'Bank Transfer', 'Bank Remittance', 'Credit Card', 'Cheque']) {
      for (const status of ['paid', 'unpaid']) {
        const text = ['Ogsi', 'Project: Electrical', `Payment method: ${method}`, `Payment status: ${status}`].join(separator);
        assert.equal(isBooksBatchBoundary({ text }, { state: CUSTOMER }), true, text);
        assert.equal(isBooksBatchBoundary({ text }), false);
        assert.equal(isBooksBatchBoundary({ text }, { state: 'WAITING_FOR_EDIT_INSTRUCTION' }), false);
        assert.equal(isBossBatchBoundary({ messageType: 'text', text }), false);
      }
    }
  }
  for (const text of [
    'Ogsi\nProject: Electrical', 'Ogsi\nPayment method: Cash\nPayment status: paid',
    COMPLETE_CUSTOMER_REPLY.replace('Cash', 'Card'), COMPLETE_CUSTOMER_REPLY.replace('status: paid', 'status: maybe'),
    COMPLETE_CUSTOMER_REPLY.replace('status: paid', 'method: Cash'), COMPLETE_CUSTOMER_REPLY.replace('Project:', 'Vendor:'),
    COMPLETE_CUSTOMER_REPLY + '\nVAT: 5%', COMPLETE_CUSTOMER_REPLY + '; Price: 35',
    COMPLETE_CUSTOMER_REPLY.replace('Ogsi', 'Invoice 123'), COMPLETE_CUSTOMER_REPLY.replace('Electrical', 'Electrical Total: 220'),
    COMPLETE_CUSTOMER_REPLY.replace('Ogsi', 'Customer: Ogsi'),
  ]) assert.equal(isBooksBatchBoundary({ text }, { state: CUSTOMER }), false, text);
  assert.equal(isBooksBatchBoundary({ messageType: 'image', mediaId: 'fixture-page', text: COMPLETE_CUSTOMER_REPLY }, { state: CUSTOMER }), false);

  const { store } = await temporaryStore(t);
  const billStore = createBillStore({ store });
  await billStore.init();
  await billStore.createBillSession({ worker_phone: WORKER, state: CUSTOMER });
  await billStore.enqueueBillExtraction({ messageId: 'complete-customer-reply', workerPhone: WORKER,
    payload: { message_type: 'text', message_text: COMPLETE_CUSTOMER_REPLY } });
  const claimed = await billStore.claimBillExtraction({ batchQuietMs: 5000, batchBoundary: isBooksBatchBoundary, batchSessionAware: true });
  assert.equal(claimed?.message_id, 'complete-customer-reply');
});

async function completeReplyFixture() {
  const expenseId = '100000000000111', paymentId = '100000000000222';
  const state = { paymentActive: true, billTotal: 220.03, savedBill: null };
  const reads = [], writes = [], documents = [];
  const rows = [[3, 35], [20, 0.35], [6, 1.25], [30, 0.85], [10, 4.25], [1, 5], [4, 4.26]];
  const bill = { ...validBill(), bill_number: 'FIXTURE-7-ROWS', bill_date: '2026-10-07', customer_details: null,
    payment_type: null, subtotal: 209.54, tax_amount: 10.49, total_amount: 220.03,
    line_items: rows.map(([quantity, rate], index) => ({ name: `Fixture item ${index + 1}`, quantity, rate,
      amount: Math.round(quantity * rate * 100) / 100, tax_percentage: 5 })) };
  const contacts = Array.from({ length: 666 }, (_, index) => ({ contact_id: `customer-${index}`,
    contact_name: `Fixture company ${index}`, contact_type: 'customer', status: 'active' }));
  const cash = (id, name) => ({ account_id: id, account_name: name, account_type: 'cash',
    organization_id: ORGANIZATION, is_active: state.paymentActive });
  const client = createZohoBooksClient({
    env: { ZOHO_BOOKS_CONTRACTING_ORG_ID: ORGANIZATION, ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_ID: expenseId },
    clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh',
    http: {
      async get(url, { params }) {
        assert.equal(params.organization_id, ORGANIZATION);
        const endpoint = new URL(url).pathname.replace('/books/v3', '');
        reads.push({ endpoint, params: { ...params } });
        if (endpoint === '/contacts') {
          if (params.contact_type === 'vendor') return { data: { code: 0, contacts: [
            { contact_id: 'fixture-vendor', contact_name: bill.vendor_name, contact_type: 'vendor', status: 'active',
              tax_treatment: 'vat_registered', currency_id: 'fixture-aed' },
          ], page_context: { has_more_page: false } } };
          assert.equal(params.search_text, undefined, 'The complete list must make another Ogsi search unnecessary');
          const start = (params.page - 1) * params.per_page;
          return { data: { code: 0, contacts: contacts.slice(start, start + params.per_page),
            page_context: { has_more_page: start + params.per_page < contacts.length } } };
        }
        if (endpoint === '/chartofaccounts') return { data: { code: 0,
          chartofaccounts: [cash(paymentId, 'Cash box'), cash('100000000000333', 'Other cash box')] } };
        if (endpoint === `/chartofaccounts/${paymentId}`) return { data: { code: 0, chart_of_account: cash(paymentId, 'Cash box') } };
        if (endpoint === `/chartofaccounts/${expenseId}`) return { data: { code: 0, chart_of_account: {
          account_id: expenseId, account_name: 'Fixture expense', account_type: 'expense', is_active: true, organization_id: ORGANIZATION,
        } } };
        if (endpoint === '/settings/currencies') return { data: { code: 0, currencies: [{ currency_id: 'fixture-aed', currency_code: 'AED' }] } };
        if (endpoint === '/settings/taxes') return { data: { code: 0, taxes: [{ tax_id: 'fixture-vat', tax_type: 'tax', tax_percentage: 5 }] } };
        if (endpoint === '/bills') return { data: { code: 0, bills: [], page_context: { has_more_page: false } } };
        assert.equal(endpoint, '/bills/fixture-bill');
        return { data: { code: 0, bill: structuredClone(state.savedBill) } };
      },
      async post(url, payload, { params } = {}) {
        if (url.endsWith('/oauth/v2/token')) return { data: { access_token: 'fixture-access', scope: 'ZohoBooks.fullaccess.all' } };
        assert.equal(params.organization_id, ORGANIZATION);
        const endpoint = new URL(url).pathname.replace('/books/v3', '');
        writes.push({ endpoint, payload: structuredClone(payload) });
        if (endpoint === '/bills') {
          state.savedBill = { bill_id: 'fixture-bill', bill_number: payload.bill_number, vendor_id: payload.vendor_id,
            organization_id: ORGANIZATION, total: state.billTotal, balance: state.billTotal, currency_code: 'AED', status: 'open' };
          return { data: { code: 0, bill: structuredClone(state.savedBill) } };
        }
        assert.equal(endpoint, '/vendorpayments');
        state.savedBill.status = 'paid';
        state.savedBill.balance = 0;
        return { data: { code: 0, vendorpayment: { payment_id: 'fixture-payment' } } };
      },
    },
  });
  const f = fixture({ bill, workerAnswers: null, workerPaymentMethod: null, zohoOverrides: {
    ...client,
    async attachBillFile() { return { success: true }; },
    async getBillPdf() { documents.push('pdf'); return { buffer: Buffer.from('%PDF-fixture'), bill: structuredClone(state.savedBill) }; },
  } });
  const initial = await f.send('', { messageType: 'image', mediaId: 'fixture-seven-row-image' });
  assert.equal(initial.state, CUSTOMER);
  assert.match(initial.replyText, /666 customers/);
  await f.billStore.updateBillSession(initial.sessionId, { created_at: new Date() });
  return { ...f, initial, reads, writes, documents, state, paymentId, expenseId, bill,
    customerReads: () => reads.filter(read => read.params.contact_type === 'customer').length };
}

test('seven-row AED220.03 bill takes bundled details, actual account choice and SAVE with all accounting checks retained', async () => {
  const h = await completeReplyFixture();
  const initialCustomerReads = h.customerReads();
  const account = await h.send(COMPLETE_CUSTOMER_REPLY);
  assert.equal(account.state, 'WAITING_FOR_PAYMENT_ACCOUNT');
  assert.equal(account.replyInteractive.header, 'Payment account');
  assert.deepEqual(account.replyInteractive.sections[0].rows.map(row => row.title), ['Cash box', 'Other cash box']);
  assert.equal(account.bill.customer_details.customer_lookup_status, 'not_found');
  assert.equal(account.bill.customer_details.project_site, 'Electrical');
  assert.equal(account.bill.payment_type, 'Cash');
  assert.equal(account.bill.payment_status, 'paid');
  assert.equal(h.writes.length, 0);
  const review = await h.send('1');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(review.bill.payment_account_id, h.paymentId);
  assert.equal(review.bill.bill_date, '2026-10-07');
  assert.match(review.replyText, /1 SAVE\n2 EDIT\n3 DELETE/);
  assert.equal(h.writes.length, 0, 'Choosing account 1 must not be interpreted as SAVE');
  const saved = await h.send('SAVE');
  assert.equal(saved.state, 'COMPLETED');
  assert.equal(h.customerReads(), initialCustomerReads);
  assert.equal(h.calls.filter(([action]) => action === 'vision').length, 1);
  assert.equal(h.calls.some(([action]) => ['extract', 'edit', 'merge'].includes(action)), false);
  assert.deepEqual(h.writes.map(write => write.endpoint), ['/bills', '/vendorpayments']);
  const payload = h.writes[0].payload;
  assert.equal(payload.line_items.length, 7);
  assert.deepEqual(payload.line_items.map(item => [item.quantity, item.rate]), h.bill.line_items.map(item => [item.quantity, item.rate]));
  assert.ok(payload.line_items.every(item => item.account_id === h.expenseId && item.tax_id === 'fixture-vat'));
  assert.equal(h.writes[1].payload.paid_through_account_id, h.paymentId);
  assert.equal(h.writes[1].payload.amount, 220.03);
  assert.equal(h.reads.filter(read => read.endpoint === `/chartofaccounts/${h.paymentId}`).length, 3,
    'Freshly check the chosen account at selection, SAVE and before recording payment');
  assert.equal(h.reads.filter(read => read.endpoint === '/bills/fixture-bill').length, 3,
    'Verify saved amount, payment preconditions and final paid balance');
  assert.deepEqual(h.documents, ['pdf']);
});

for (const failure of ['inactive account', 'wrong saved amount']) {
  test(`complete bundled reply still stops safely for ${failure}`, async () => {
    const h = await completeReplyFixture();
    await h.send(COMPLETE_CUSTOMER_REPLY);
    assert.equal((await h.send('1')).state, 'AWAITING_FINAL_CONFIRMATION');
    if (failure === 'inactive account') h.state.paymentActive = false;
    else h.state.billTotal = 221.03;
    const result = await h.send('SAVE');
    assert.notEqual(result.state, 'COMPLETED');
    if (failure === 'inactive account') {
      assert.match(result.replyText, /payment account.*missing or invalid/i);
      assert.equal(h.writes.length, 0);
    } else {
      assert.match(result.replyText, /amount or currency does not match/);
      assert.deepEqual(h.writes.map(write => write.endpoint), ['/bills']);
    }
    assert.deepEqual(h.documents, []);
  });
}
