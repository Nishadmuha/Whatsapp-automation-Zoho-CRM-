'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');

const ORG = '828765858';
const EXPENSE = '100000000000111';
const PAYMENT = '100000000000222';
const CURRENCIES = '/settings/currencies';
const TAXES = '/settings/taxes';
const EXPENSE_PATH = `/chartofaccounts/${EXPENSE}`;
const PAYMENT_PATH = `/chartofaccounts/${PAYMENT}`;
const BILL_PATH = '/bills/fixture-bill';
const turn = () => new Promise(resolve => setImmediate(resolve));

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

function billInput() {
  return { currency: 'AED', subtotal: 100, tax_amount: 5, total_amount: 105,
    line_items: [{ name: 'Fixture part', quantity: 1, rate: 100, amount: 100, tax_percentage: 5 }] };
}

function createInput(bill) {
  return { vendorId: 'fixture-vendor', billNumber: 'fixture-105', billDate: '2026-10-08',
    lineItems: bill.line_items, currency: 'AED', currencyId: bill.currency_id, organizationId: ORG };
}

const paymentInput = { billId: 'fixture-bill', vendorId: 'fixture-vendor', amount: 105,
  paymentDate: '2026-10-08', paymentType: 'Cash', organizationId: ORG, expectedCurrency: 'AED' };

function harness({ gates = {}, expenseConfigured = true } = {}) {
  const reads = [], writes = [];
  let tokenRequests = 0;
  const state = {
    currencies: [{ currency_id: 'fixture-aed', currency_code: 'AED' }],
    taxes: [{ tax_id: 'fixture-vat5', tax_type: 'tax', tax_percentage: 5 }],
    expenseActive: true, paymentActive: true, taxFailure: false, paymentFailure: false,
    bill: { bill_id: 'fixture-bill', bill_number: 'fixture-105', vendor_id: 'fixture-vendor',
      organization_id: ORG, total: 105, balance: 105, status: 'open', currency_code: 'AED' },
  };
  const client = createZohoBooksClient({
    env: { ZOHO_BOOKS_CONTRACTING_ORG_ID: ORG, ZOHO_BOOKS_CONTRACTING_PAYMENT_CASH_ACCOUNT_ID: PAYMENT,
      ...(expenseConfigured ? { ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_ID: EXPENSE } : {}) },
    clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh',
    http: {
      async get(url, { params }) {
        const path = new URL(url).pathname.replace('/books/v3', '');
        assert.equal(params.organization_id, ORG);
        reads.push(path);
        if (gates[path]) await gates[path].promise;
        if (path === CURRENCIES) return { data: { code: 0, currencies: state.currencies } };
        if (path === TAXES) {
          if (state.taxFailure) throw new Error('fixture tax transport failure');
          return { data: { code: 0, taxes: state.taxes } };
        }
        if (path === BILL_PATH) return { data: { code: 0, bill: structuredClone(state.bill) } };
        assert.ok([EXPENSE_PATH, PAYMENT_PATH].includes(path), `Unexpected GET ${path}`);
        const expense = path === EXPENSE_PATH;
        if (!expense && state.paymentFailure) throw new Error('fixture account transport failure');
        return { data: { code: 0, chart_of_account: {
          account_id: expense ? EXPENSE : PAYMENT, account_name: expense ? 'Fixture expense' : 'Fixture cash',
          account_type: expense ? 'expense' : 'cash', organization_id: ORG,
          is_active: expense ? state.expenseActive : state.paymentActive,
        } } };
      },
      async post(url, payload, { params } = {}) {
        if (url.endsWith('/oauth/v2/token')) {
          tokenRequests += 1;
          return { data: { access_token: 'fixture-access', scope: 'ZohoBooks.fullaccess.all' } };
        }
        assert.equal(params.organization_id, ORG);
        writes.push({ path: new URL(url).pathname.replace('/books/v3', ''), payload: structuredClone(payload) });
        if (url.endsWith('/bills')) return { data: { code: 0, bill: structuredClone(state.bill) } };
        assert.ok(url.endsWith('/vendorpayments'));
        state.bill.status = 'paid';
        state.bill.balance = 0;
        return { data: { code: 0, vendorpayment: { payment_id: 'fixture-payment' } } };
      },
    },
  });
  return { client, state, reads, writes, tokenRequests: () => tokenRequests };
}

test('bill preflight starts currency, tax and expense reads together and waits for every validation', async t => {
  const gates = Object.fromEntries([CURRENCIES, TAXES, EXPENSE_PATH].map(path => [path, gate()]));
  t.after(() => Object.values(gates).forEach(item => item.release()));
  const h = harness({ gates });
  const bill = billInput();
  let prepared = false;
  const pending = h.client.prepareBill(bill, {}, { organizationId: ORG }).then(result => { prepared = true; return result; });
  await turn();
  assert.deepEqual([...h.reads].sort(), [CURRENCIES, TAXES, EXPENSE_PATH].sort(),
    'All three GETs must start before any response is released');
  assert.equal(h.tokenRequests(), 1, 'Parallel reads share the existing OAuth refresh');
  gates[CURRENCIES].release();
  gates[TAXES].release();
  await turn();
  assert.equal(prepared, false, 'The expense check still gates successful preflight');
  assert.equal(h.writes.length, 0);
  gates[EXPENSE_PATH].release();
  assert.equal(await pending, bill);
  await h.client.createBill(createInput(bill));
  assert.equal(h.reads.filter(path => path === EXPENSE_PATH).length, 1,
    'Successful preparation still supplies one-use account verification to create');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].payload.line_items[0].account_id, EXPENSE);
  assert.equal(h.writes[0].payload.line_items[0].tax_id, 'fixture-vat5');
});

test('untaxed bills and organizations without an expense mapping do not gain unnecessary reads', async () => {
  const h = harness({ expenseConfigured: false });
  const bill = billInput();
  bill.tax_amount = 0;
  bill.total_amount = 100;
  bill.line_items[0].tax_percentage = 0;
  await h.client.prepareBill(bill, {}, { organizationId: ORG });
  assert.deepEqual(h.reads, [CURRENCIES]);
  assert.equal(h.writes.length, 0);
});

for (const [name, configure, changeBill, code] of [
  ['currency before failed tax and expense reads', state => { state.currencies = []; state.taxFailure = true; },
    () => {}, 'CURRENCY_NOT_FOUND'],
  ['source amounts before a failed tax read', state => { state.taxFailure = true; },
    bill => { bill.subtotal = 99; }, 'TOTAL_MISMATCH'],
  ['tax mapping before an invalid expense account', state => { state.taxes = []; },
    () => {}, 'TAX_AMBIGUOUS'],
]) {
  test(`parallel bill checks preserve error priority: ${name}`, async t => {
    const currencyGate = gate();
    t.after(() => currencyGate.release());
    const h = harness({ gates: { [CURRENCIES]: currencyGate } });
    h.state.expenseActive = false;
    configure(h.state);
    const bill = billInput();
    changeBill(bill);
    const pending = assert.rejects(h.client.prepareBill(bill, {}, { organizationId: ORG }), { code });
    await turn();
    assert.ok(h.reads.includes(TAXES) && h.reads.includes(EXPENSE_PATH));
    currencyGate.release();
    await pending;
    assert.equal(h.writes.length, 0);
  });
}

test('a failed bill preflight discards a successful parallel expense-account verification', async () => {
  const h = harness();
  const bill = billInput();
  h.state.currencies = [];
  await assert.rejects(h.client.prepareBill(bill, {}, { organizationId: ORG }), { code: 'CURRENCY_NOT_FOUND' });
  assert.equal(h.reads.filter(path => path === EXPENSE_PATH).length, 1);
  h.state.expenseActive = false;
  await assert.rejects(h.client.createBill(createInput(bill)), { code: 'BILL_ACCOUNT_INACTIVE' });
  assert.equal(h.reads.filter(path => path === EXPENSE_PATH).length, 2,
    'A failed preparation cannot leave a reusable verification behind');
  assert.equal(h.writes.length, 0);
});

test('payment preflight overlaps fresh bill and account reads and still verifies payment after POST', async t => {
  const gates = Object.fromEntries([BILL_PATH, PAYMENT_PATH].map(path => [path, gate()]));
  t.after(() => Object.values(gates).forEach(item => item.release()));
  const h = harness({ gates });
  const pending = h.client.recordBillPayment(paymentInput);
  await turn();
  assert.deepEqual([...h.reads].sort(), [BILL_PATH, PAYMENT_PATH].sort());
  gates[BILL_PATH].release();
  await turn();
  assert.equal(h.writes.length, 0, 'Payment must wait for the account check');
  gates[PAYMENT_PATH].release();
  const payment = await pending;
  assert.equal(payment.status, 'paid');
  assert.equal(payment.bill.balance, 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].path, '/vendorpayments');
  assert.equal(h.writes[0].payload.amount, 105);
  assert.equal(h.reads.filter(path => path === BILL_PATH).length, 2,
    'The paid status is freshly read after submission');
  assert.equal(h.reads.filter(path => path === PAYMENT_PATH).length, 1);
});

test('payment bill mismatch keeps priority when the parallel account read fails first', async t => {
  const billGate = gate();
  t.after(() => billGate.release());
  const h = harness({ gates: { [BILL_PATH]: billGate } });
  h.state.bill.vendor_id = 'fixture-other-vendor';
  h.state.paymentFailure = true;
  const pending = assert.rejects(h.client.recordBillPayment(paymentInput), { code: 'PAYMENT_VENDOR_MISMATCH' });
  await turn();
  assert.ok(h.reads.includes(PAYMENT_PATH));
  billGate.release();
  await pending;
  assert.equal(h.writes.length, 0);
});

test('an already-paid bill still succeeds when its parallel account lookup fails', async () => {
  const h = harness();
  h.state.bill.status = 'paid';
  h.state.bill.balance = 0;
  h.state.paymentFailure = true;
  const result = await h.client.recordBillPayment(paymentInput);
  assert.equal(result.alreadyPaid, true);
  assert.equal(result.status, 'paid');
  assert.equal(h.writes.length, 0);
});

test('failed parallel payment validation remains safe to retry and does not reuse account results', async () => {
  const h = harness();
  h.state.paymentFailure = true;
  await assert.rejects(h.client.recordBillPayment(paymentInput), { code: 'PAYMENT_PREFLIGHT_FAILED' });
  assert.equal(h.writes.length, 0);
  h.state.paymentFailure = false;
  const result = await h.client.recordBillPayment(paymentInput);
  assert.equal(result.status, 'paid');
  assert.equal(h.reads.filter(path => path === PAYMENT_PATH).length, 2);
  assert.equal(h.writes.length, 1);
});
