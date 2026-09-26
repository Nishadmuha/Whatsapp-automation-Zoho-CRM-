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

for (const [organizationId, organizationName] of [
  ['802911060', 'VOLTRONIX SWITCHGEAR LLC'],
  ['828765858', 'VOLTRONIX CONTRACTING LLC'],
]) test(`one displayed customer accepts only selection 1 in ${organizationName}`, async () => {
  const customerId = `customer-${organizationId}`;
  const makeFixture = () => fixture({
    bill: { ...validBill(), organization: { name: organizationName, organizationId, confidence: 1 }, customer_details: null },
    zohoOverrides: {
      async searchCustomer({ organizationId: scope }) {
        assert.equal(scope, organizationId);
        return [{ contactId: customerId, contactName: 'ABC Contracting', organizationId }];
      },
      async getCustomer(id, { organizationId: scope }) {
        assert.equal(id, customerId);
        assert.equal(scope, organizationId);
        return { contactId: customerId, contactName: 'ABC Contracting', organizationId };
      },
    },
  });
  const valid = makeFixture();
  const first = await valid.send('Synthetic bill');
  assert.equal(first.replyInteractive.sections[0].rows.length, 1);
  const selected = await valid.send('1');
  assert.equal(selected.bill.customer_details.contact_id, customerId);
  assert.equal(selected.bill.customer_details.organization_id, organizationId);

  for (const choice of ['2', '3', '4', '99', '0', '-1']) {
    const f = makeFixture();
    const initial = await f.send('Synthetic bill');
    const rejected = await f.send(choice);
    assert.equal(rejected.state, 'WAITING_FOR_CUSTOMER_SELECTION', `Choice ${choice} must stay in customer selection`);
    assert.equal(rejected.replyText, 'Please select one of the customers shown in the Zoho Books list.');
    assert.equal((await f.billStore.getBill(initial.billId)).customer_details, null);
    const pending = await f.billStore.getBillSession(initial.sessionId);
    assert.equal(pending.bill_data.customer_details, null);
    assert.equal(pending.customer_options.length, 1);
    assert.equal(f.calls.some(call => call[0] === 'create'), false);
  }
});

test('customer numbers are limited to the options actually displayed, and valid numbers use exact IDs', async () => {
  const customers = Array.from({ length: 11 }, (_, index) => ({
    contactId: `customer-${index + 1}`, contactName: `Customer ${index + 1}`, organizationId: '828765858',
  }));
  const makeFixture = () => fixture({ bill: { ...validBill(), customer_details: null }, zohoOverrides: {
    async searchCustomer() { return customers; },
    async getCustomer(id) { return customers.find(customer => customer.contactId === id); },
  } });
  for (const number of [2, 10]) {
    const f = makeFixture();
    const first = await f.send('Synthetic bill');
    assert.equal(first.replyInteractive.sections[0].rows.length, 10);
    const selected = await f.send(String(number));
    assert.equal(selected.bill.customer_details.contact_id, `customer-${number}`);
    assert.equal((await f.billStore.getBill(first.billId)).customer_details.customer_id, `customer-${number}`);
  }
  const f = makeFixture();
  const first = await f.send('Synthetic bill');
  const rejected = await f.send('11');
  assert.equal(rejected.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(rejected.replyText, 'Please select one of the customers shown in the Zoho Books list.');
  assert.equal((await f.billStore.getBill(first.billId)).customer_details, null);
  assert.equal((await f.billStore.getBillSession(first.sessionId)).customer_options.length, 10);
});

test('free-form customer details still work after an invalid numeric selection', async () => {
  const f = fixture({ bill: { ...validBill(), customer_details: null }, zohoOverrides: {
    async searchCustomer({ searchText }) {
      return searchText ? [] : [{ contactId: 'other-customer', contactName: 'Other Customer' }];
    },
  } });
  await f.send('Synthetic bill');
  assert.equal((await f.send('4')).state, 'WAITING_FOR_CUSTOMER_SELECTION');
  const review = await f.send('ABC Contracting, 0501234567, Dubai site');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(review.bill.customer_details.customer_name, 'ABC Contracting');
  assert.equal(review.bill.customer_details.customer_phone, '0501234567');
  assert.equal(review.bill.customer_details.project_site, 'Dubai site');
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

test('missing customer details prompts for typed information without blocking extraction', async () => {
  const f = fixture({ bill: { ...validBill(), customer_details: null }, zohoOverrides: {
    async searchCustomer() { return []; },
  } });
  const first = await f.send('Synthetic bill');
  assert.equal(first.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.match(first.replyText, /^Please send the customer details\. You can type the customer\/company name, phone number, email, location, or any available customer details\./);
  assert.equal((await f.billStore.getBill(first.billId)).customer_details, null);
  assert.equal(f.calls.some(call => call[0] === 'create'), false);
});

for (const [organizationId, organizationName] of [
  ['802911060', 'VOLTRONIX SWITCHGEAR LLC'],
  ['828765858', 'VOLTRONIX CONTRACTING LLC'],
]) test(`typed customer details with no Zoho match remain in the ${organizationName} draft and bill`, async () => {
  const searches = [];
  const f = fixture({ bill: { ...validBill(), organization: { name: organizationName, organizationId, confidence: 1 }, customer_details: null }, zohoOverrides: {
    async searchCustomer(input) { searches.push(input); return []; },
    async createCustomer() { assert.fail('A missing customer must not be created'); },
  } });
  const first = await f.send('Synthetic bill');
  const typed = await f.send('ABC Contracting LLC, Dubai, 0501234567, accounts@example.invalid');
  assert.equal(typed.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.match(typed.replyText, /BILL DETAILS/);
  assert.match(typed.replyText, /ABC Contracting LLC/);
  assert.match(typed.replyText, /0501234567/);
  assert.match(typed.replyText, /Dubai/);
  assert.match(typed.replyText, /accounts@example.invalid/);
  const expected = {
    customer_name: 'ABC Contracting LLC', project_site: 'Dubai', customer_phone: '0501234567',
    customer_email: 'accounts@example.invalid', customer_id: null, contact_id: null,
    organization_id: organizationId, customer_source: 'manual', customer_lookup_status: 'not_found',
  };
  assert.deepEqual((await f.billStore.getBill(first.billId)).customer_details, expected);
  assert.deepEqual((await f.billStore.getBillSession(first.sessionId)).bill_data.customer_details, expected);
  assert.deepEqual(searches.map(input => input.organizationId), [organizationId, organizationId]);
  assert.equal(searches[1].searchText, 'ABC Contracting LLC');
  const saved = await f.send('SAVE');
  assert.equal(saved.state, 'COMPLETED');
  const created = f.calls.find(call => call[0] === 'create')[1];
  assert.equal(created.customerId, null);
  assert.equal(created.organizationId, organizationId);
  assert.match(created.notes, /Customer: ABC Contracting LLC/);
  assert.match(created.notes, /Customer email: accounts@example.invalid/);
  assert.equal(f.calls.some(call => call[0] === 'createCustomer'), false);
});

test('typed name, phone, and site in the other order are parsed and shown in Bill Details', async () => {
  const f = fixture({ bill: { ...validBill(), customer_details: null }, zohoOverrides: { async searchCustomer() { return []; } } });
  await f.send('Synthetic bill');
  const review = await f.send('ABC Contracting, 0501234567, Dubai site');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(review.bill.customer_details.customer_name, 'ABC Contracting');
  assert.equal(review.bill.customer_details.customer_phone, '0501234567');
  assert.equal(review.bill.customer_details.project_site, 'Dubai site');
  assert.match(review.replyText, /ABC Contracting/);
  assert.match(review.replyText, /Dubai site/);
});

test('typed customer details proceed without a Zoho ID when lookup returns only other names', async () => {
  const f = fixture({ bill: { ...validBill(), customer_details: null }, zohoOverrides: {
    async searchCustomer({ searchText }) {
      return searchText ? [{ contactId: 'different-customer', contactName: 'ABC Contracting Services' }]
        : [{ contactId: 'different-customer', contactName: 'ABC Contracting Services' }];
    },
  } });
  await f.send('Synthetic bill');
  const review = await f.send('ABC Contracting, 0501234567, Dubai site');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(review.bill.customer_details.customer_id, null);
  assert.equal(review.bill.customer_details.customer_name, 'ABC Contracting');
  assert.equal(review.bill.customer_details.customer_lookup_status, 'not_found');
  await f.send('SAVE');
  assert.equal(f.calls.find(call => call[0] === 'create')[1].customerId, null);
});

test('when Contacts lookup is unavailable, payment collection stays first and free-form customer text completes the draft', async () => {
  const f = fixture({ bill: { ...validBill(), payment_type: null, customer_details: null } });
  const first = await f.send('Synthetic bill');
  assert.match(first.replyText, /payment method/i);
  const payment = await f.send('Cash');
  assert.equal(payment.state, 'WAITING_FOR_ADDITIONAL_INFO');
  assert.equal(payment.replyText, 'Please send the customer details. You can type the customer/company name, phone number, email, location, or any available customer details.');
  const review = await f.send('ABC Contracting LLC, Dubai, 0501234567');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(review.bill.customer_details.customer_name, 'ABC Contracting LLC');
  assert.equal(review.bill.customer_details.project_site, 'Dubai');
  assert.equal((await f.billStore.getBill(first.billId)).customer_details.customer_phone, '0501234567');
});

test('a phone-only text reply is stored while the workflow waits for the customer name', async () => {
  const f = fixture({ bill: { ...validBill(), customer_details: null }, zohoOverrides: { async searchCustomer() { return []; } } });
  const first = await f.send('Synthetic bill');
  const partial = await f.send('0501234567');
  assert.equal(partial.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.match(partial.replyText, /Please send the customer details/);
  assert.equal((await f.billStore.getBill(first.billId)).customer_details.customer_phone, '0501234567');
  const review = await f.send('ABC Contracting');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(review.bill.customer_details.customer_phone, '0501234567');
});

for (const [organizationId, organizationName] of [
  ['802911060', 'VOLTRONIX SWITCHGEAR LLC'],
  ['828765858', 'VOLTRONIX CONTRACTING LLC'],
]) test(`typed exact customer match uses the verified ID only in ${organizationName}`, async () => {
  const matchingId = `customer-${organizationId}`;
  const exact = { contactId: matchingId, contactName: 'ABC Contracting LLC', organizationId, phone: '+971500000000', status: 'active', contactType: 'customer' };
  const f = fixture({ bill: { ...validBill(), organization: { name: organizationName, organizationId, confidence: 1 }, customer_details: null }, zohoOverrides: {
    async searchCustomer({ searchText, organizationId: scope }) {
      assert.equal(scope, organizationId);
      return searchText ? [exact, { ...exact, contactId: 'wrong-org', organizationId: organizationId === '802911060' ? '828765858' : '802911060' }]
        : [{ contactId: 'other', contactName: 'Other Customer', organizationId }];
    },
    async getCustomer(id, { organizationId: scope }) { assert.equal(id, matchingId); assert.equal(scope, organizationId); return exact; },
    async createCustomer() { assert.fail('Existing customer must not be duplicated'); },
  } });
  const first = await f.send('Synthetic bill');
  const review = await f.send('ABC Contracting LLC, 0501234567, Dubai site');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(review.bill.customer_details.contact_id, matchingId);
  assert.equal(review.bill.customer_details.customer_phone, '0501234567');
  assert.equal(review.bill.customer_details.project_site, 'Dubai site');
  assert.equal((await f.billStore.getBill(first.billId)).customer_details.customer_id, matchingId);
  assert.equal((await f.billStore.getBillSession(first.sessionId)).bill_data.customer_details.contact_id, matchingId);
  assert.match(review.replyText, /ABC Contracting LLC/);
  assert.equal((await f.send('SAVE')).state, 'COMPLETED');
  assert.equal(f.calls.find(call => call[0] === 'create')[1].customerId, matchingId);
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
