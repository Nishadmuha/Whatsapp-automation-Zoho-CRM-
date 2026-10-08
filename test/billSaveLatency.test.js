'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, memoryStore, validBill, WORKER } = require('./billFixtures');

const ORG = validBill().organization.organizationId;
const turn = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function harness({ paid = true, newVendor = false, gates = {}, errors = {}, duplicate = false } = {}) {
  const events = [], writes = [], logs = [], locks = new Set();
  const billStore = memoryStore();
  const bill = { ...validBill(), payment_method_confirmed: true, payment_status: paid ? 'paid' : 'unpaid',
    payment_account_id: '100000000000222', payment_account_name: 'Fixture account',
    payment_account_organization_id: ORG, zoho_vendor_id: newVendor ? null : 'fixture-vendor' };
  const session = { session_id: 'fixture-session', bill_id: 'fixture-bill', worker_phone: WORKER,
    state: 'AWAITING_FINAL_CONFIRMATION', bill_data: bill, attachments: [] };
  await billStore.createBillSession(session);
  await billStore.saveBill({ ...bill, bill_id: session.bill_id, session_id: session.session_id,
    worker_phone: WORKER, status: 'PENDING_REVIEW', attachments: [] });
  const vendor = { id: 'fixture-vendor', name: bill.vendor_name, organizationId: ORG,
    raw: { tax_treatment: 'vat_registered', currency_id: 'fixture-aed' } };
  const state = { preparedItems: null, vendorInputs: [] };
  const vendorLocked = () => [...locks].some(key => key.startsWith('books-vendor:'));
  async function read(name, result) {
    events.push(name);
    if (gates[name]) await gates[name].promise;
    if (errors[name]) throw Object.assign(Error(`Fixture ${name} failure`), { code: errors[name], operation: name });
    return result;
  }
  const f = fixture({ billStore, bill, logger: { error: event => logs.push(event) }, sourceStore: {
    async withContactLock(key, task) {
      locks.add(key);
      try { return await task(); } finally { locks.delete(key); }
    },
  }, zohoOverrides: {
    async prepareBillPayment(input) {
      assert.equal(input.organizationId, ORG);
      return read('payment', { accountId: bill.payment_account_id, paymentMode: bill.payment_type });
    },
    async searchVendor(input) {
      assert.equal(vendorLocked(), true, 'Fresh vendor resolution must remain inside the vendor lock');
      state.vendorInputs.push(input);
      return read('vendor', newVendor ? [] : [structuredClone(vendor)]);
    },
    async checkDuplicateBill(input) {
      assert.equal(vendorLocked(), true, 'Duplicate validation must remain inside the vendor lock');
      assert.equal(input.vendorId, newVendor ? null : vendor.id);
      assert.equal(input.organizationId, ORG);
      return read('duplicate', { found: duplicate, bills: duplicate ? [{ id: 'fixture-existing' }] : [] });
    },
    async prepareBill(accountingBill, resolved, { organizationId }) {
      assert.equal(organizationId, ORG);
      assert.equal(resolved.id, vendor.id);
      await read('accounting');
      accountingBill.currency_id = 'fixture-aed';
      accountingBill.line_items[0].tax_id = 'fixture-vat5';
      state.preparedItems = accountingBill.line_items;
      return accountingBill;
    },
    async createVendor() {
      assert.equal(vendorLocked(), true, 'Contact creation must remain inside the vendor lock');
      writes.push(['vendor']);
      await read('vendorCreate');
      return structuredClone(vendor);
    },
    async createBill(input) {
      writes.push(['bill', input]);
      events.push('billCreate');
      assert.equal(input.lineItems, state.preparedItems, 'CREATE must consume the prepared array, preserving one-use account validation');
      return { id: 'fixture-created' };
    },
    async verifyBillTotal() {
      return read('verify', { total: bill.total_amount, currencyCode: bill.currency });
    },
    async recordBillPayment() {
      events.push('paymentCreate');
      writes.push(['payment']);
      return { id: 'fixture-payment', status: 'paid' };
    },
  } });
  return { ...f, events, writes, logs, state, session, locks };
}

test('SAVE overlaps payment/vendor and duplicate/accounting reads while every check still gates CREATE', async t => {
  const gates = Object.fromEntries(['payment', 'vendor', 'duplicate', 'accounting'].map(name => [name, gate()]));
  t.after(() => Object.values(gates).forEach(item => item.release()));
  const h = await harness({ gates });
  const pending = h.send('SAVE');
  await turn();
  assert.deepEqual(h.events, ['payment', 'vendor']);
  assert.equal(h.state.vendorInputs[0].fresh, true);
  assert.equal(h.state.vendorInputs[0].organizationId, ORG);
  gates.payment.release();
  await turn();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.events, ['payment', 'vendor']);
  gates.vendor.release();
  await turn();
  assert.deepEqual(h.events, ['payment', 'vendor', 'duplicate', 'accounting']);
  gates.duplicate.release();
  await turn();
  assert.deepEqual(h.writes, [], 'A finished duplicate lookup cannot bypass pending accounting');
  gates.accounting.release();
  const result = await pending;
  assert.equal(result.state, 'COMPLETED');
  assert.deepEqual(h.writes.map(([kind]) => kind), ['bill', 'payment']);
  assert.deepEqual(h.events.slice(-3), ['billCreate', 'verify', 'paymentCreate']);
  const session = await h.billStore.getBillSession(h.session.session_id);
  assert.equal(session.bill_data.currency_id, undefined);
  assert.equal(session.bill_data.line_items[0].tax_id, undefined, 'Preparation must not mutate the reviewed source draft');
  assert.equal(h.locks.size, 0);
});

test('payment failure keeps precedence over a faster vendor failure and settles both without writes', async t => {
  const payment = gate();
  t.after(() => payment.release());
  const h = await harness({ gates: { payment }, errors: { payment: 'PAYMENT_ACCOUNT_INVALID', vendor: 'VENDOR_LOOKUP_FAILED' } });
  let finished = false;
  const pending = h.send('SAVE').then(result => { finished = true; return result; });
  await turn();
  assert.deepEqual(h.events, ['payment', 'vendor']);
  assert.equal(finished, false);
  assert.deepEqual(h.writes, []);
  payment.release();
  const result = await pending;
  assert.match(result.replyText, /payment account.*missing or invalid/i);
  assert.equal(h.logs.at(-1).code, 'PAYMENT_ACCOUNT_INVALID');
  assert.deepEqual(h.writes, []);
  assert.equal(h.events.includes('duplicate'), false);
});

test('vendor failure after a successful payment check prevents duplicate/accounting work and all writes', async () => {
  const h = await harness({ errors: { vendor: 'VENDOR_LOOKUP_FAILED' } });
  const result = await h.send('SAVE');
  assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.deepEqual(h.events, ['payment', 'vendor']);
  assert.equal(h.logs.at(-1).code, 'VENDOR_LOOKUP_FAILED');
  assert.deepEqual(h.writes, []);
});

test('a duplicate keeps precedence over accounting failure but waits for both reads to settle', async t => {
  const accounting = gate();
  t.after(() => accounting.release());
  const h = await harness({ gates: { accounting }, duplicate: true, errors: { accounting: 'CURRENCY_NOT_FOUND' } });
  let finished = false;
  const pending = h.send('SAVE').then(result => { finished = true; return result; });
  await turn();
  assert.ok(h.events.includes('duplicate') && h.events.includes('accounting'));
  assert.equal(finished, false);
  assert.deepEqual(h.writes, []);
  accounting.release();
  const result = await pending;
  assert.match(result.replyText, /duplicate/i);
  assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.deepEqual(h.logs, []);
  assert.deepEqual(h.writes, []);
});

test('duplicate read errors keep precedence over accounting errors without mutating the reviewed draft', async () => {
  const h = await harness({ errors: { duplicate: 'DUPLICATE_LOOKUP_FAILED', accounting: 'CURRENCY_NOT_FOUND' } });
  const before = structuredClone((await h.billStore.getBillSession(h.session.session_id)).bill_data);
  await h.send('SAVE');
  assert.equal(h.logs.at(-1).code, 'DUPLICATE_LOOKUP_FAILED');
  assert.deepEqual((await h.billStore.getBillSession(h.session.session_id)).bill_data, before);
  assert.deepEqual(h.writes, []);
});

test('a duplicate discards successful accounting preparation and each retry performs fresh reads', async () => {
  const h = await harness({ duplicate: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.match((await h.send('SAVE')).replyText, /duplicate/i);
    const session = await h.billStore.getBillSession(h.session.session_id);
    assert.equal(session.bill_data.line_items[0].tax_id, undefined);
    assert.equal(session.bill_data.currency_id, undefined);
  }
  assert.equal(h.state.vendorInputs.length, 2);
  assert.ok(h.state.vendorInputs.every(input => input.fresh === true));
  assert.equal(h.events.filter(event => event === 'payment').length, 2);
  assert.equal(h.events.filter(event => event === 'accounting').length, 2);
  assert.deepEqual(h.writes, []);
});

test('accounting failure blocks CREATE after successful payment, vendor and duplicate checks', async () => {
  const h = await harness({ errors: { accounting: 'TOTAL_MISMATCH' } });
  const result = await h.send('SAVE');
  assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(h.logs.at(-1).code, 'TOTAL_MISMATCH');
  assert.deepEqual(h.writes, []);
});

test('unpaid SAVE overlaps duplicate/accounting reads without introducing payment calls', async t => {
  const duplicate = gate();
  t.after(() => duplicate.release());
  const h = await harness({ paid: false, gates: { duplicate } });
  const pending = h.send('SAVE');
  await turn();
  assert.deepEqual(h.events, ['vendor', 'duplicate', 'accounting']);
  assert.deepEqual(h.writes, []);
  duplicate.release();
  assert.equal((await pending).state, 'COMPLETED');
  assert.deepEqual(h.writes.map(([kind]) => kind), ['bill']);
  assert.equal(h.events.includes('payment'), false);
  assert.equal(h.events.includes('paymentCreate'), false);
});

test('new vendor creation remains after payment/vendor/duplicate checks and before accounting', async t => {
  const gates = Object.fromEntries(['payment', 'duplicate', 'vendorCreate', 'accounting'].map(name => [name, gate()]));
  t.after(() => Object.values(gates).forEach(item => item.release()));
  const h = await harness({ newVendor: true, gates });
  const pending = h.send('SAVE');
  await turn();
  assert.deepEqual(h.events, ['payment', 'vendor']);
  assert.deepEqual(h.writes, []);
  gates.payment.release();
  await turn();
  assert.deepEqual(h.events, ['payment', 'vendor', 'duplicate']);
  assert.deepEqual(h.writes, []);
  gates.duplicate.release();
  await turn();
  assert.deepEqual(h.writes.map(([kind]) => kind), ['vendor']);
  assert.equal(h.events.includes('accounting'), false, 'Never validate accounting against an invented vendor');
  gates.vendorCreate.release();
  await turn();
  assert.equal(h.events.at(-1), 'accounting');
  assert.deepEqual(h.writes.map(([kind]) => kind), ['vendor']);
  gates.accounting.release();
  assert.equal((await pending).state, 'COMPLETED');
  assert.deepEqual(h.writes.map(([kind]) => kind), ['vendor', 'bill', 'payment']);
});

test('a payment failure never creates a new vendor even when the fresh vendor scan found none', async () => {
  const h = await harness({ newVendor: true, errors: { payment: 'PAYMENT_SCOPE_REQUIRED' } });
  assert.match((await h.send('SAVE')).replyText, /Zoho permission.*vendor payments/i);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.events, ['payment', 'vendor']);
});

test('saved amount verification still blocks payment and document delivery after parallel preflight', async () => {
  const h = await harness({ errors: { verify: 'BILL_TOTAL_MISMATCH' } });
  const result = await h.send('SAVE');
  assert.equal(result.state, 'CREATING_IN_ZOHO');
  assert.match(result.replyText, /saved amount or currency does not match/i);
  assert.deepEqual(h.writes.map(([kind]) => kind), ['bill']);
  assert.equal(h.calls.some(([action]) => ['attach', 'pdf', 'document'].includes(action)), false);
  const record = await h.billStore.getBill(h.session.bill_id);
  assert.equal(record.zoho_bill_id, 'fixture-created');
  assert.equal(record.amount_verification_status, 'MISMATCH');
});
