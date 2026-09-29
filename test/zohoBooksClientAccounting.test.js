'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');

const ORG = '828765858';
const ACCOUNT = '100000000000222';
const cents = value => Math.round((value + 1e-9) * 100) / 100;

function harness({ total = 700.02, balance = total, status = 'open', currency = 'AED', config = true,
  accountType = 'cash', accountOrg = ORG, active = true, ignoreAdjustment = false, accountId = ACCOUNT, accountPages = null,
  paymentError = null, afterPaymentReadError = false, preflightReadFailure = null, tokenScope = undefined } = {}) {
  const calls = [];
  let bill = { bill_id: 'fixture-bill', bill_number: '223615', vendor_id: 'fixture-vendor',
    organization_id: ORG, total, balance, status, currency_code: currency, adjustment: 0 };
  let paid = false;
  const http = {
    async get(url, options) {
      calls.push({ method: 'GET', path: new URL(url).pathname, options });
      assert.equal(options.params.organization_id, ORG);
      if (preflightReadFailure && url.includes(preflightReadFailure)) {
        preflightReadFailure = null;
        throw Object.assign(Error('private preflight transport'), { response: { status: 503, data: { code: 999, message: 'private financial detail' } } });
      }
      if (url.includes('/chartofaccounts/')) return { data: { code: 0, chart_of_account: {
        account_id: accountId, account_name: 'Office cash', organization_id: accountOrg, is_active: active, account_type: accountType,
      } } };
      if (url.endsWith('/chartofaccounts')) {
        assert.ok(accountPages, 'Unexpected account list request');
        assert.equal(options.params.per_page, 200);
        assert.equal(options.params.filter_by, 'AccountType.Active');
        return { data: { code: 0, ...accountPages[Math.min(options.params.page - 1, accountPages.length - 1)] } };
      }
      if (url.endsWith('/settings/currencies')) return { data: { code: 0, currencies: [{ currency_id: 'fixture-aed', currency_code: 'AED' }] } };
      if (url.endsWith('/settings/taxes')) return { data: { code: 0, taxes: [{ tax_id: 'fixture-vat5', tax_type: 'tax', tax_percentage: 5 }] } };
      assert.ok(url.endsWith('/bills/fixture-bill'));
      if (paid && afterPaymentReadError) throw Object.assign(Error('read rejected'), { response: { status: 403, data: { code: 14 } } });
      return { data: { code: 0, bill: structuredClone(bill) } };
    },
    async post(url, payload, options) {
      if (url.endsWith('/oauth/v2/token')) return { data: { access_token: 'fixture-access', scope: tokenScope } };
      calls.push({ method: 'POST', path: new URL(url).pathname, payload: structuredClone(payload), options });
      assert.equal(options.params.organization_id, ORG);
      if (url.endsWith('/bills')) {
        // Simulate the provider calculating quantity * rate, ignoring item_total.
        const netLines = payload.line_items.map(line => cents(line.quantity * line.rate));
        const sub_total = cents(netLines.reduce((sum, value) => sum + value, 0));
        const tax_total = cents(payload.line_items.reduce((sum, line, index) => sum + cents(netLines[index] * (line.tax_percentage || 0) / 100), 0));
        bill = { ...bill, sub_total, tax_total, total: cents(sub_total + tax_total), balance: cents(sub_total + tax_total), line_items: payload.line_items };
        return { data: { code: 0, bill: structuredClone(bill) } };
      }
      assert.ok(url.endsWith('/vendorpayments'));
      if (paymentError) throw paymentError;
      paid = true;
      bill = { ...bill, status: 'paid', balance: 0 };
      return { data: { code: 0, vendorpayment: { payment_id: 'fixture-payment' } } };
    },
    async put(url, payload, options) {
      calls.push({ method: 'PUT', path: new URL(url).pathname, payload: structuredClone(payload), options });
      assert.equal(options.params.organization_id, ORG);
      assert.equal(payload.vendor_id, bill.vendor_id);
      assert.equal(payload.bill_number, bill.bill_number);
      assert.equal(payload.line_items, undefined, 'A rounding repair must not replace lines or customer allocation');
      if (!ignoreAdjustment) bill = { ...bill, total: cents(total + payload.adjustment), balance: cents(total + payload.adjustment), adjustment: payload.adjustment };
      return { data: { code: 0, bill: structuredClone(bill) } };
    },
  };
  const env = { ZOHO_BOOKS_CONTRACTING_ORG_ID: ORG, ZOHO_BOOKS_SWITCHGEAR_ORG_ID: '802911060',
    ...(config ? { ZOHO_BOOKS_CONTRACTING_PAYMENT_CASH_ACCOUNT_ID: ACCOUNT } : {}) };
  const client = createZohoBooksClient({ env, http, clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh' });
  return { client, calls, setTokenScope(scope) { tokenScope = scope; } };
}

const paymentInput = { billId: 'fixture-bill', vendorId: 'fixture-vendor', amount: 700.02,
  paymentDate: '2026-09-28', paymentType: 'Cash', organizationId: ORG, expectedCurrency: 'AED' };

test('known missing vendor-payment scope blocks preflight before account lookup or financial writes', async () => {
  const { client, calls } = harness({ tokenScope: 'ZohoBooks.bills.CREATE ZohoBooks.bills.UPDATE ZohoBooks.accountants.READ' });
  await assert.rejects(client.prepareBillPayment(paymentInput), { code: 'PAYMENT_SCOPE_REQUIRED', operation: 'paymentPreflight' });
  assert.deepEqual(calls, []);
  await assert.rejects(client.recordBillPayment(paymentInput), { code: 'PAYMENT_SCOPE_REQUIRED' });
  assert.ok(calls.every(call => call.method === 'GET' && call.path.endsWith('/bills/fixture-bill')));
});

for (const tokenScope of ['ZohoBooks.vendorpayments.CREATE', 'ZohoBooks.vendorpayments.ALL', 'ZohoBooks.fullaccess.all', undefined]) {
  test(`payment preflight accepts ${tokenScope || 'absent scope metadata'} without inventing a missing grant`, async () => {
    const { client } = harness({ tokenScope });
    assert.deepEqual(await client.prepareBillPayment(paymentInput), { accountId: ACCOUNT, paymentMode: 'Cash', accountName: 'Office cash' });
  });
}

test('scope metadata is replaced after token invalidation and reauthorization', async () => {
  const { client, calls, setTokenScope } = harness({ tokenScope: 'ZohoBooks.bills.CREATE' });
  await assert.rejects(client.prepareBillPayment(paymentInput), { code: 'PAYMENT_SCOPE_REQUIRED' });
  assert.deepEqual(calls, []);
  setTokenScope('ZohoBooks.vendorpayments.CREATE ZohoBooks.accountants.READ');
  client.invalidateToken();
  assert.deepEqual(await client.prepareBillPayment(paymentInput), { accountId: ACCOUNT, paymentMode: 'Cash', accountName: 'Office cash' });
  setTokenScope('ZohoBooks.accountants.READ');
  client.invalidateToken();
  await assert.rejects(client.prepareBillPayment(paymentInput), { code: 'PAYMENT_SCOPE_REQUIRED' });
  assert.equal(calls.length, 1, 'Revoked authorization must not reuse the previous granted scope metadata');
});

test('screenshot regression: printed 133.33 rate and 333.34 line amount save exactly AED 700.02', async () => {
  const { client, calls } = harness();
  const lineItems = [1, 2].map(n => ({ name: `CONCT 3/4 ${n}`, quantity: 2.5, rate: 133.33, amount: 333.34, tax_percentage: 5 }));
  const source = structuredClone(lineItems);
  const bill = { line_items: lineItems, currency: 'AED', subtotal: 666.68, tax_amount: 33.34, total_amount: 700.02 };
  await client.prepareBill(bill, { raw: { tax_treatment: 'vat_registered' } }, { organizationId: ORG });
  const created = await client.createBill({ vendorId: 'fixture-vendor', billNumber: '223615', billDate: '2026-09-28',
    organizationId: ORG, currency: 'AED', lineItems, expectedTotal: 700.02, subtotal: 666.68, taxAmount: 33.34 });
  assert.equal(created.total, 700.02);
  const payload = calls.find(call => call.method === 'POST').payload;
  assert.equal(payload.is_item_level_tax_calc, true);
  assert.equal(payload.is_inclusive_tax, false);
  assert.deepEqual(payload.line_items.map(line => line.rate), [133.336, 133.336]);
  assert.ok(payload.line_items.every(line => !Object.hasOwn(line, 'item_total')));
  assert.deepEqual(lineItems.map(({ tax_id: _tax, ...line }) => line), source, 'Source rates and printed amounts remain available for review');
  const confirmed = await client.verifyBillTotal(created.id, { organizationId: ORG, expectedTotal: 700.02, expectedCurrency: 'AED' });
  assert.equal(confirmed.total, 700.02);
  assert.equal(confirmed.raw.bill.sub_total, 666.68);
  assert.equal(confirmed.raw.bill.tax_total, 33.34);
  assert.equal(calls.some(call => call.method === 'PUT'), false);
});

test('actual saved 699.99 is reconciled to 700.02 and repeat verification is read-only', async () => {
  const { client, calls } = harness({ total: 699.99 });
  const options = { organizationId: ORG, expectedTotal: 700.02, expectedCurrency: 'AED' };
  const first = await client.verifyBillTotal('fixture-bill', options);
  assert.equal(first.total, 700.02);
  assert.equal(first.roundingAdjustment, 0.03);
  assert.equal((await client.verifyBillTotal('fixture-bill', options)).total, 700.02);
  const writes = calls.filter(call => call.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.adjustment, 0.03);
  assert.match(writes[0].payload.adjustment_description, /rounding/i);
});

for (const [name, options, errorCode] of [
  ['material discrepancy', { total: 699 }, 'BILL_TOTAL_MISMATCH'],
  ['wrong currency', { currency: 'USD' }, 'BILL_CURRENCY_MISMATCH'],
  ['missing total', { total: null }, 'BILL_TOTAL_UNCONFIRMED'],
  ['partly paid bill', { total: 699.99, balance: 200 }, 'BILL_TOTAL_MISMATCH'],
]) {
  test(`verification rejects ${name} without a write`, async () => {
    const { client, calls } = harness(options);
    await assert.rejects(client.verifyBillTotal('fixture-bill', { organizationId: ORG, expectedTotal: 700.02, expectedCurrency: 'AED' }), { code: errorCode });
    assert.equal(calls.some(call => call.method !== 'GET'), false);
  });
}

test('a provider that ignores the rounding adjustment cannot pass verification', async () => {
  const { client, calls } = harness({ total: 699.99, ignoreAdjustment: true });
  await assert.rejects(client.verifyBillTotal('fixture-bill', { organizationId: ORG, expectedTotal: 700.02, expectedCurrency: 'AED' }), { code: 'BILL_TOTAL_MISMATCH' });
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
});

for (const [name, options, code] of [
  ['missing mapping', { config: false }, 'PAYMENT_ACCOUNT_CONFIG_REQUIRED'],
  ['expense account', { accountType: 'expense' }, 'PAYMENT_ACCOUNT_INVALID'],
  ['other organization', { accountOrg: '802911060' }, 'PAYMENT_ACCOUNT_INVALID'],
  ['inactive account', { active: false }, 'PAYMENT_ACCOUNT_INVALID'],
]) {
  test(`payment preflight rejects ${name} without recording a payment`, async () => {
    const { client, calls } = harness(options);
    await assert.rejects(client.prepareBillPayment(paymentInput), { code });
    assert.equal(calls.some(call => call.method === 'POST'), false);
  });
}

test('worker-selected payment account works without mapping and is freshly verified before payment', async () => {
  const selectedAccount = '100000000000333';
  const { client, calls } = harness({ config: false, accountId: selectedAccount });
  const input = { ...paymentInput, paymentAccountId: selectedAccount };
  assert.deepEqual(await client.prepareBillPayment(input), {
    accountId: selectedAccount, paymentMode: 'Cash', accountName: 'Office cash',
  });
  assert.equal((await client.recordBillPayment(input)).status, 'paid');
  assert.equal(calls.filter(call => call.path.endsWith(`/chartofaccounts/${selectedAccount}`)).length, 2);
  assert.equal(calls.find(call => call.method === 'POST').payload.paid_through_account_id, selectedAccount);
});

test('worker-selected payment account overrides the configured default', async () => {
  const selectedAccount = '100000000000333';
  const { client, calls } = harness({ accountId: selectedAccount });
  const prepared = await client.prepareBillPayment({ ...paymentInput, paymentAccountId: selectedAccount });
  assert.equal(prepared.accountId, selectedAccount);
  assert.ok(calls.every(call => call.path.endsWith(`/chartofaccounts/${selectedAccount}`)));
});

for (const [name, options] of [
  ['inactive', { active: false }],
  ['other organization', { accountOrg: '802911060' }],
  ['wrong type', { accountType: 'bank' }],
  ['wrong returned ID', { accountId: '100000000000999' }],
]) {
  test(`worker-selected ${name} account is rejected without a payment`, async () => {
    const { client, calls } = harness({ config: false, ...options });
    await assert.rejects(client.recordBillPayment({ ...paymentInput, paymentAccountId: ACCOUNT }), { code: 'PAYMENT_ACCOUNT_INVALID' });
    assert.equal(calls.some(call => call.method === 'POST'), false);
  });
}

test('invalid selected account ID does not fall back to the configured account', async () => {
  for (const paymentAccountId of ['', '../other', 'cash', '123?organization_id=other']) {
    const { client, calls } = harness();
    await assert.rejects(client.prepareBillPayment({ ...paymentInput, paymentAccountId }), { code: 'PAYMENT_ACCOUNT_INVALID' });
    assert.deepEqual(calls, []);
  }
});

test('payment account listing covers every page and filters IDs, status, type, organization and duplicates', async () => {
  const base = { account_id: ACCOUNT, account_name: 'Office cash', account_type: 'cash', is_active: true, organization_id: ORG };
  const secondId = '100000000000333';
  const { client, calls } = harness({ config: false, accountPages: [
    { chartofaccounts: [base,
      { ...base, account_id: '1001', is_active: false },
      { ...base, account_id: '1002', account_type: 'expense' },
      { ...base, account_id: '1003', organization_id: '802911060' },
      { ...base, account_id: '../other' },
      { ...base, account_id: '1004', account_name: '' },
      null], page_context: { has_more_page: true } },
    { chartofaccounts: [base, { ...base, account_id: secondId, account_name: 'Site cash', organization_id: undefined }],
      page_context: { has_more_page: false } },
  ] });
  assert.deepEqual(await client.listPaymentAccounts(paymentInput), [
    { id: ACCOUNT, name: 'Office cash', type: 'cash', organizationId: ORG },
    { id: secondId, name: 'Site cash', type: 'cash', organizationId: ORG },
  ]);
  assert.deepEqual(calls.map(call => call.options.params.page), [1, 2]);
  assert.ok(calls.every(call => call.method === 'GET' && call.options.params.organization_id === ORG));
});

for (const [paymentType, expectedType] of [
  ['Cash', 'cash'], ['Credit Card', 'credit_card'], ['Bank Transfer', 'bank'], ['Bank Remittance', 'bank'], ['Cheque', 'bank'],
]) {
  test(`${paymentType} lists only ${expectedType} payment accounts`, async () => {
    const chartofaccounts = ['cash', 'credit_card', 'bank'].map((account_type, index) => ({
      account_id: `100${index}`, account_name: account_type, account_type, is_active: true,
    }));
    const { client } = harness({ accountPages: [{ chartofaccounts }] });
    const result = await client.listPaymentAccounts({ paymentType, organizationId: ORG });
    assert.equal(result.length, 1);
    assert.equal(result[0].type, expectedType);
    assert.equal(result[0].organizationId, ORG);
  });
}

test('payment account listing fails safely when pagination never ends or the list is malformed', async () => {
  for (const [data, code] of [
    [{ chartofaccounts: [], page_context: { has_more_page: true } }, 'PAYMENT_ACCOUNT_LOOKUP_INCOMPLETE'],
    [{ chartofaccounts: null }, 'PAYMENT_ACCOUNT_LOOKUP_FAILED'],
  ]) {
    const { client, calls } = harness({ accountPages: [data] });
    await assert.rejects(client.listPaymentAccounts(paymentInput), { code });
    assert.ok(calls.every(call => call.method === 'GET'));
    assert.ok(calls.length <= 100);
  }
});

test('payment account listing retains the vendor-payment scope preflight', async () => {
  const { client, calls } = harness({ tokenScope: 'ZohoBooks.accountants.READ' });
  await assert.rejects(client.listPaymentAccounts(paymentInput), { code: 'PAYMENT_SCOPE_REQUIRED' });
  assert.deepEqual(calls, []);
});

test('PAID records the exact amount against the bill, reads zero balance, and skips an already paid bill', async () => {
  const { client, calls } = harness();
  assert.deepEqual(await client.prepareBillPayment(paymentInput), { accountId: ACCOUNT, paymentMode: 'Cash', accountName: 'Office cash' });
  const paid = await client.recordBillPayment(paymentInput);
  assert.equal(paid.id, 'fixture-payment');
  assert.equal(paid.status, 'paid');
  assert.equal(paid.balance, 0);
  const writes = calls.filter(call => call.method === 'POST');
  assert.deepEqual(writes[0].payload, { vendor_id: 'fixture-vendor', amount: 700.02, date: '2026-09-28',
    payment_mode: 'Cash', paid_through_account_id: ACCOUNT, reference_number: 'WA-BILL-fixture-bill',
    bills: [{ bill_id: 'fixture-bill', amount_applied: 700.02 }] });
  assert.equal((await client.recordBillPayment(paymentInput)).alreadyPaid, true);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('a payment timeout is not automatically retried', async () => {
  const { client, calls } = harness({ paymentError: Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }) });
  await assert.rejects(client.recordBillPayment(paymentInput), error => error.httpStatus === undefined);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

for (const endpoint of ['/bills/', '/chartofaccounts/']) {
  test(`a ${endpoint} preflight read failure submits no payment and allows a successful retry`, async () => {
    const { client, calls } = harness({ preflightReadFailure: endpoint });
    await assert.rejects(client.recordBillPayment(paymentInput), error => error.code === 'PAYMENT_PREFLIGHT_FAILED'
      && error.operation === 'paymentPreflight' && error.httpStatus === undefined && !/private/.test(error.message));
    assert.equal(calls.filter(call => call.method === 'POST').length, 0);
    const result = await client.recordBillPayment(paymentInput);
    assert.equal(result.status, 'paid');
    assert.equal(result.balance, 0);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  });
}

for (const [status, code] of [[400, 'PAYMENT_REJECTED'], [200, 'PAYMENT_REJECTED'], [408, 'PAYMENT_OUTCOME_UNCONFIRMED'], [409, 'PAYMENT_OUTCOME_UNCONFIRMED'], [429, 'PAYMENT_OUTCOME_UNCONFIRMED'], [500, 'PAYMENT_OUTCOME_UNCONFIRMED']]) {
  test(`payment HTTP ${status} is classified as ${code} and does not expose provider data`, async () => {
    const paymentError = Object.assign(Error('private worker data'), { response: { status, data: { code: 999, message: 'private vendor details' } } });
    const { client, calls } = harness({ paymentError });
    await assert.rejects(client.recordBillPayment(paymentInput), error => error.code === code
      && error.operation === 'recordBillPayment' && !/private/.test(error.message));
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  });
}

test('post-payment read rejection is uncertain even with an HTTP 403 and preserves the payment ID', async () => {
  const { client, calls } = harness({ afterPaymentReadError: true });
  await assert.rejects(client.recordBillPayment(paymentInput), error => error.code === 'PAYMENT_OUTCOME_UNCONFIRMED'
    && error.paymentId === 'fixture-payment' && error.httpStatus === undefined);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('changed balance or mismatched vendor prevents payment creation', async () => {
  for (const input of [{ ...paymentInput, vendorId: 'wrong-vendor' }, paymentInput]) {
    const { client, calls } = harness({ balance: 200 });
    await assert.rejects(client.recordBillPayment(input), error => ['PAYMENT_VENDOR_MISMATCH', 'PAYMENT_BALANCE_MISMATCH'].includes(error.code));
    assert.equal(calls.some(call => call.method === 'POST'), false);
  }
});
