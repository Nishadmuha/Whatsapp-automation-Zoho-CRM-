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
  const customer = {
    contactId: '1234567890123456789', contactName: 'Selected Contact', companyName: 'Selected Company',
    phone, mobile: null, email, contactType: 'customer', status: 'active',
  };
  const f = fixture({
    bill: { ...validBill(), payment_type: null, customer_details: { customer_name: 'OCR customer', customer_phone: '+971509998888', customer_email: 'old@example.invalid', project_site: 'Dubai' } },
    zohoOverrides: { async searchCustomer() { return [customer]; }, async getCustomer(id) { assert.equal(id, customer.contactId); return customer; } },
  });
  const first = await f.send('Synthetic bill', { messageType: 'image', mediaId: 'synthetic-image' });
  assert.equal(first.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(f.calls.some(call => call[0] === 'create'), false);
  await f.send('Select', { interactiveId: 'zoho-customer:' + customer.contactId });
  const expected = {
    customer_name: 'Selected Company (Selected Contact)', customer_phone: phone, customer_email: email, project_site: 'Dubai',
    customer_id: customer.contactId, contact_id: customer.contactId, contact_name: customer.contactName, company_name: customer.companyName,
    customer_contact_name: customer.contactName, customer_company_name: customer.companyName, customer_mobile: null,
    customer_contact_type: 'customer', customer_status: 'active',
    organization_id: '828765858',
  };
  assert.deepEqual((await f.billStore.getBill(first.billId)).customer_details, expected);
  assert.deepEqual((await f.billStore.getBillSession(first.sessionId)).bill_data.customer_details, expected);
  const extractions = f.calls.filter(call => call[0] === 'extract').length;
  assert.equal(extractions, 1, 'selection must not ask AI to regenerate customer details');
});

test('similar customer names select the exact offered ID; forged IDs do not change the draft', async () => {
  const customers = [
    { contactId: '101', contactName: 'Contact One', companyName: 'Similar LLC', phone: null, email: 'one@example.invalid' },
    { contactId: '102', contactName: 'Contact Two', companyName: 'Similar LLC', phone: '+971501112233', email: null },
  ];
  const f = fixture({ zohoOverrides: { async searchCustomer() { return customers; }, async getCustomer(id) { return customers.find(customer => customer.contactId === id); } } });
  const first = await f.send('Synthetic bill');
  await f.send('Select', { interactiveId: 'zoho-customer:not-offered' });
  assert.equal((await f.billStore.getBillSession(first.sessionId)).state, 'WAITING_FOR_CUSTOMER_SELECTION');
  await f.send('2');
  assert.equal((await f.billStore.getBill(first.billId)).customer_details.customer_id, '102');
  assert.equal((await f.billStore.getBill(first.billId)).customer_details.contact_name, 'Contact Two');
  assert.equal(f.calls.some(call => call[0] === 'create'), false);
});

test('three distinct customer records keep exact IDs and names, including a customer from a later API page', async () => {
  const customers = [
    { contactId: 'page-1-customer', contactName: 'First Contact', companyName: 'First Company', email: 'first@example.invalid', phone: '+971500000001', mobile: null, contactType: 'customer', status: 'active' },
    { contactId: 'page-2-customer', contactName: 'Second Contact', companyName: 'Second Company', email: null, phone: null, mobile: '+971550000002', contactType: 'customer', status: 'active' },
    { contactId: 'page-3-customer', contactName: 'Third Contact', companyName: 'Third Company', email: 'third@example.invalid', phone: '+971500000003', mobile: '+971550000003', contactType: 'customer', status: 'active' },
  ];
  const f = fixture({ zohoOverrides: {
    async searchCustomer() { return customers; },
    async getCustomer(id) { return customers.find(customer => customer.contactId === id); },
  } });
  const first = await f.send('Synthetic bill');
  assert.deepEqual(first.replyInteractive.sections[0].rows.map(row => row.id), customers.map(customer => `zoho-customer:${customer.contactId}`).slice(0, 3));
  await f.send('2');
  let selected = await f.billStore.getBill(first.billId);
  assert.equal(selected.customer_details.contact_id, 'page-2-customer');
  assert.equal(selected.customer_details.company_name, 'Second Company');
  assert.equal(selected.customer_details.contact_name, 'Second Contact');

  const later = fixture({ zohoOverrides: {
    async searchCustomer() { return [customers[2]]; },
    async getCustomer(id) { assert.equal(id, 'page-3-customer'); return customers[2]; },
  } });
  const laterFirst = await later.send('Synthetic bill');
  await later.send('Third Company', { interactiveId: 'zoho-customer:page-3-customer' });
  selected = await later.billStore.getBill(laterFirst.billId);
  assert.equal(selected.customer_details.contact_id, 'page-3-customer');
  assert.equal(selected.customer_details.customer_mobile, '+971550000003');
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
        return { data: { code: 0, contacts: [{ contact_id: '1234567890123456789', contact_name: 'Zoho Contact', company_name: 'Zoho Customer', contact_type: 'customer', status: 'active', phone: '+971501112233', email: 'selected@example.invalid' }] } };
      }
      if (url.endsWith('/contacts/1234567890123456789')) {
        return { data: { code: 0, contact: { contact_id: '1234567890123456789', contact_name: 'Zoho Contact', company_name: 'Zoho Customer', contact_type: 'customer', status: 'active', phone: '+971501112233', email: 'selected@example.invalid' } } };
      }
      if (url.endsWith('/settings/currencies')) return { data: { code: 0, currencies: [{ currency_id: 'aed1', currency_code: 'AED' }] } };
      if (url.endsWith('/settings/taxes')) return { data: { code: 0, taxes: [{ tax_id: 'vat5', tax_type: 'tax', tax_percentage: 5 }] } };
      assert.fail('Unexpected endpoint');
    },
  } });
  const f = fixture({ bill: { ...validBill(), payment_type: null, customer_details: null }, zohoOverrides: { searchCustomer: client.searchCustomer, getCustomer: client.getCustomer, prepareBill: client.prepareBill, createBill: client.createBill } });
  const first = await f.send('Synthetic bill image', { messageType: 'image', mediaId: 'synthetic-image' });
  await f.send('Select', { interactiveId: 'zoho-customer:1234567890123456789' });
  await f.send(method);
  assert.equal((await f.billStore.getBill(first.billId)).payment_type, method);
  assert.equal((await f.billStore.getBillSession(first.sessionId)).bill_data.payment_type, method);
  assert.equal(calls.filter(call => call.url.endsWith('/bills')).length, 0);
  await f.send('SAVE'); // Mock transport only. No real Zoho or WhatsApp network.
  const payload = calls.find(call => call.method === 'POST' && call.url.endsWith('/bills')).payload;
  assert.equal(payload.customer_id, '1234567890123456789');
  assert.ok(payload.notes.includes('Payment method: ' + method));
  assert.ok(payload.notes.includes('Zoho customer ID: 1234567890123456789'));
  assert.equal(payload.line_items[0].account_id, undefined);
  assert.ok(calls.every(call => !call.url.includes('chartofaccounts')));
  await f.send('SAVE');
  assert.equal(calls.filter(call => call.method === 'POST' && call.url.endsWith('/bills')).length, 1);
});
