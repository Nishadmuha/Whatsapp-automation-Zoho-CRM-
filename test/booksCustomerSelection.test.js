'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, validBill } = require('./billFixtures');
const { PAYMENT_METHODS } = require('../src/services/books/paymentMethods');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');

for (const [label, phone, email] of [
  ['phone only', '+971501112233', null],
  ['email only', null, 'selected@example.invalid'],
  ['both', '+971501112233', 'selected@example.invalid'],
]) test(`selected Zoho customer with ${label} is authoritative in session and pending bill`, async () => {
  const customer = { id: '1234567890123456789', name: 'Selected Customer', phone, email };
  const f = fixture({
    bill: { ...validBill(), payment_type: null, customer_details: { customer_name: 'OCR customer', customer_phone: '+971509998888', customer_email: 'old@example.invalid', project_site: 'Dubai' } },
    zohoOverrides: { async searchCustomer() { return [customer]; } },
  });
  const first = await f.send('Synthetic bill', { messageType: 'image', mediaId: 'synthetic-image' });
  assert.equal(first.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(f.calls.some(call => call[0] === 'create'), false);
  await f.send('Select', { interactiveId: 'zoho-customer:' + customer.id });
  const expected = { customer_id: customer.id, customer_name: customer.name, customer_phone: phone, customer_email: email, project_site: 'Dubai' };
  assert.deepEqual((await f.billStore.getBill(first.billId)).customer_details, expected);
  assert.deepEqual((await f.billStore.getBillSession(first.sessionId)).bill_data.customer_details, expected);
  const extractions = f.calls.filter(call => call[0] === 'extract').length;
  assert.equal(extractions, 1, 'selection must not ask AI to regenerate customer details');
});

test('similar customer names select the exact offered ID; forged IDs do not change the draft', async () => {
  const customers = [{ id: '101', name: 'Similar LLC', phone: null, email: 'one@example.invalid' }, { id: '102', name: 'Similar LLC', phone: '+971501112233', email: null }];
  const f = fixture({ zohoOverrides: { async searchCustomer() { return customers; } } });
  const first = await f.send('Synthetic bill');
  await f.send('Select', { interactiveId: 'zoho-customer:not-offered' });
  assert.equal((await f.billStore.getBillSession(first.sessionId)).state, 'WAITING_FOR_CUSTOMER_SELECTION');
  await f.send('2');
  assert.equal((await f.billStore.getBill(first.billId)).customer_details.customer_id, '102');
  assert.equal(f.calls.some(call => call[0] === 'create'), false);
});

test('empty or failed Contacts lookup never invents or creates a customer', async () => {
  for (const searchCustomer of [async () => [], async () => { throw Error('lookup unavailable'); }]) {
    const f = fixture({ bill: { ...validBill(), customer_details: null }, zohoOverrides: { searchCustomer } });
    const result = await f.send('Synthetic bill');
    assert.match(result.replyText, /No Zoho Books customers|could not load/);
    assert.equal(result.bill.customer_details, null);
    assert.equal(f.calls.some(call => call[0] === 'create'), false);
  }
});

for (const method of PAYMENT_METHODS) test(`${method}: pending draft and mocked Books POST retain selected method and exact customer ID`, async () => {
  const calls = [];
  const client = createZohoBooksClient({ env: {}, clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh', organizationId: 'fixture-org', http: {
    async post(url, payload) {
      calls.push({ method: 'POST', url, payload });
      if (url.endsWith('/oauth/v2/token')) return { data: { access_token: 'fixture-access', expires_in: 3600 } };
      assert.ok(url.endsWith('/bills'), 'Never create a contact or payment');
      return { data: { code: 0, bill: { bill_id: '123456', bill_number: payload.bill_number } } };
    },
    async get(url, options) {
      calls.push({ method: 'GET', url });
      if (url.endsWith('/contacts')) {
        assert.equal(options.params.contact_type, 'customer');
        return { data: { code: 0, contacts: [{ contact_id: '1234567890123456789', contact_name: 'Zoho Customer', phone: '+971501112233', email: 'selected@example.invalid' }] } };
      }
      if (url.endsWith('/settings/currencies')) return { data: { code: 0, currencies: [{ currency_id: 'aed1', currency_code: 'AED' }] } };
      if (url.endsWith('/settings/taxes')) return { data: { code: 0, taxes: [{ tax_id: 'vat5', tax_type: 'tax', tax_percentage: 5 }] } };
      assert.fail('Unexpected endpoint');
    },
  } });
  const f = fixture({ bill: { ...validBill(), payment_type: null, customer_details: null }, zohoOverrides: { searchCustomer: client.searchCustomer, prepareBill: client.prepareBill, createBill: client.createBill } });
  const first = await f.send('Synthetic bill image', { messageType: 'image', mediaId: 'synthetic-image' });
  await f.send('Select', { interactiveId: 'zoho-customer:1234567890123456789' });
  await f.send(method);
  assert.equal((await f.billStore.getBill(first.billId)).payment_type, method);
  assert.equal((await f.billStore.getBillSession(first.sessionId)).bill_data.payment_type, method);
  assert.equal(calls.filter(call => call.url.endsWith('/bills')).length, 0);
  await f.send('SAVE'); // Mock transport only. No real Zoho or WhatsApp network.
  const payload = calls.find(call => call.method === 'POST' && call.url.endsWith('/bills')).payload;
  assert.ok(payload.notes.includes('Payment method: ' + method));
  assert.ok(payload.notes.includes('Zoho customer ID: 1234567890123456789'));
  assert.equal(payload.line_items[0].account_id, undefined);
  assert.ok(calls.every(call => !call.url.includes('chartofaccounts')));
  await f.send('SAVE');
  assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/bills')).length, 1);
});
