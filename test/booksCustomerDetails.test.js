'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, validBill } = require('./billFixtures');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');
const { mergeCustomerData, parseManualCustomerDetails } = require('../src/services/books/customerDetails');

const ORG = '828765858';
const CUSTOMER = '1234567890123456789'; // Synthetic; never coerce an ID to Number.
const ACCOUNT = '100000000000001';
const fullContact = () => ({
  contact_id: CUSTOMER, contact_name: 'Fixture Contact', company_name: 'Fixture Company',
  display_name: 'Fixture Display', contact_type: 'customer', status: 'active', organization_id: ORG,
  email: 'fixture@example.invalid', phone: '+971500000001', mobile: '+971550000001',
  contact_persons: [{ contact_person_id: 'person-1', first_name: 'Fixture', last_name: 'Person',
    email: 'person@example.invalid', phone: '+971500000002', is_primary_contact: true }],
  billing_address: { attention: 'Accounts', address: 'Fixture Road 1', street2: 'Unit 2', city: 'Dubai', country: 'UAE' },
  shipping_address: { address: 'Fixture Warehouse', city: 'Sharjah', country: 'UAE' },
  vat_reg_no: '100000000000001', tax_treatment: 'vat_not_registered', customer_code: 'FIXTURE-C001',
  currency_id: 'fixture-usd', currency_code: 'USD', payment_terms: 0, payment_terms_label: 'Due on receipt',
  custom_fields: [{ customfield_id: 'custom-1', value: 'Preserve this metadata' }],
  is_portal_enabled: false, website: 'https://customer.example.invalid',
});

function harness({ contacts = [fullContact()], detail, malformedList = false, rejectMessage = null } = {}) {
  const reads = [], posts = [], creates = [], events = [];
  const vendor = { id: 'fixture-vendor', name: validBill().vendor_name, organizationId: ORG,
    raw: { tax_treatment: 'vat_registered', currency_id: 'fixture-aed' } };
  const client = createZohoBooksClient({
    env: { ZOHO_BOOKS_CONTRACTING_ORG_ID: ORG, ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_ID: ACCOUNT,
      ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_NAME: 'VEHICLE REPARING' },
    clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh',
    logger: { error: event => events.push(event) },
    http: {
      async get(url, options) {
        assert.equal(options.params.organization_id, ORG);
        const endpoint = new URL(url).pathname.replace('/books/v3', '');
        reads.push({ endpoint, params: options.params });
        if (endpoint === '/contacts') return { data: { code: 0, contacts: malformedList ? {} : structuredClone(contacts) } };
        if (endpoint.startsWith('/contacts/')) {
          assert.equal(endpoint, `/contacts/${CUSTOMER}`);
          return { data: { code: 0, contact: structuredClone(detail || contacts[0]) } };
        }
        if (endpoint === '/settings/currencies') return { data: { code: 0, currencies: [{ currency_id: 'fixture-aed', currency_code: 'AED' }] } };
        if (endpoint === '/settings/taxes') return { data: { code: 0, taxes: [{ tax_id: 'fixture-vat5', tax_type: 'tax', tax_percentage: 5 }] } };
        assert.equal(endpoint, `/chartofaccounts/${ACCOUNT}`);
        return { data: { code: 0, chart_of_account: { account_id: ACCOUNT, account_name: 'VEHICLE REPARING',
          account_type: 'expense', is_active: true, organization_id: ORG } } };
      },
      async post(url, payload, options) {
        if (url.endsWith('/oauth/v2/token')) return { data: { access_token: 'fixture-access', expires_in: 3600 } };
        assert.ok(url.endsWith('/bills'), 'Customer handling must not write contacts, invoices, or payments');
        assert.equal(options.params.organization_id, ORG);
        posts.push(JSON.parse(JSON.stringify(payload)));
        if (rejectMessage) throw Object.assign(Error('private transport'), {
          response: { status: 400, data: { code: 12345, message: rejectMessage } },
        });
        return { status: 201, data: { code: 0, bill: { bill_id: 'fixture-created', total: 388.5 } } };
      },
    },
  });
  const bill = { ...validBill(), customer_details: null, subtotal: 370, tax_amount: 18.5, total_amount: 388.5,
    line_items: [90, 160, 120].map((rate, index) => ({ name: `Part ${index + 1}`, quantity: 1, rate,
      amount: [94.5, 168, 126][index], tax_percentage: 5 })) };
  const f = fixture({ bill, zohoOverrides: {
    searchCustomer: client.searchCustomer, getCustomer: client.getCustomer, prepareBill: client.prepareBill,
    async searchVendor() { return [structuredClone(vendor)]; },
    async createBill(input) { creates.push(structuredClone(input)); return client.createBill(input); },
  } });
  return { ...f, client, reads, posts, creates, events, vendor, bill,
    start: () => f.send('', { messageType: 'image', mediaId: 'fixture-image' }) };
}

function assertUnchangedBill(h, payload, customerId) {
  assert.equal(payload.vendor_id, h.vendor.id);
  assert.equal(payload.bill_number, h.bill.bill_number);
  assert.equal(payload.date, h.bill.bill_date);
  assert.equal(payload.currency_id, 'fixture-aed', 'Customer currency must not replace bill currency');
  assert.equal(payload.tax_treatment, undefined, 'Customer tax treatment must not replace vendor treatment');
  assert.equal(payload.payment_terms, undefined, 'Customer payment terms must not change vendor terms');
  assert.deepEqual(payload.line_items, [90, 160, 120].map((rate, index) => ({
    account_id: ACCOUNT, ...(customerId ? { customer_id: customerId } : {}),
    description: `Part ${index + 1}`, rate, quantity: 1, tax_id: 'fixture-vat5', tax_percentage: 5,
  })), 'VAT-inclusive source totals must not be sent as pre-tax item_total');
  const subtotal = payload.line_items.reduce((sum, line) => sum + line.rate * line.quantity, 0);
  const vat = payload.line_items.reduce((sum, line) => sum + line.rate * line.quantity * line.tax_percentage / 100, 0);
  assert.equal(subtotal, 370);
  assert.equal(vat, 18.5);
  assert.equal(subtotal + vat, 388.5);
  assert.match(payload.notes, /Payment method: Credit Card/);
  assert.equal(h.reads.filter(read => read.endpoint.startsWith('/chartofaccounts/')).length, 1);
  const attachments = h.calls.filter(([action]) => action === 'attach');
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0][1].buffer.toString(), 'original-image');
  assert.equal(h.calls.filter(([action]) => action === 'document').length, 1);
  assert.equal(h.calls.filter(([action]) => ['edit', 'merge'].includes(action)).length, 0);
}

test('full verified customer survives list, detail, draft, session, SAVE and supported bill payload', async () => {
  const contact = fullContact(), h = harness({ contacts: [contact] });
  const initial = await h.start();
  assert.equal(initial.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(initial.replyInteractive.sections[0].rows[0].id, `zoho-customer:${CUSTOMER}`);
  const review = await h.send('1');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  const details = (await h.billStore.getBill(initial.billId)).customer_details;
  assert.deepEqual(details.zoho_contact, contact);
  assert.equal(details.customer_name, contact.display_name);
  assert.equal(details.customer_id, CUSTOMER);
  assert.equal(details.contact_id, CUSTOMER);
  assert.equal(details.organization_id, ORG);
  assert.deepEqual((await h.billStore.getBillSession(initial.sessionId)).bill_data.customer_details, details);
  assert.equal(h.reads.filter(read => read.endpoint === `/contacts/${CUSTOMER}`).length, 1);
  assert.equal((await h.send('SAVE')).state, 'COMPLETED');
  assert.deepEqual(h.creates[0].customerDetails, details);
  assert.equal(h.creates[0].customerId, CUSTOMER);
  assert.equal(h.posts[0].customer_id, CUSTOMER);
  for (const value of ['Fixture Person', contact.email, contact.mobile, 'Fixture Road 1', 'Fixture Warehouse',
    contact.vat_reg_no, contact.customer_code, 'USD', 'Due on receipt', ORG]) assert.ok(h.posts[0].notes.includes(value), value);
  assert.equal(h.posts[0].contact_persons, undefined);
  assert.equal(h.posts[0].customerDetails, undefined, 'Do not send arbitrary contact fields to POST /bills');
  assertUnchangedBill(h, h.posts[0], CUSTOMER);
  await h.send('SAVE');
  assert.equal(h.posts.length, 1, 'Repeated SAVE must not duplicate a created bill');
});

test('missing optional customer fields are neither invented nor required for SAVE', async () => {
  const contact = { contact_id: CUSTOMER, contact_name: 'Name Only' }, h = harness({ contacts: [contact] });
  await h.start();
  const review = await h.send('1');
  assert.deepEqual(review.bill.customer_details.zoho_contact, contact);
  assert.equal(review.bill.customer_details.customer_email, null);
  assert.equal((await h.send('SAVE')).state, 'COMPLETED');
  assert.equal(h.posts[0].customer_id, CUSTOMER);
  assert.doesNotMatch(h.posts[0].notes, /Customer (?:TRN|email|billing address|currency):/);
  assertUnchangedBill(h, h.posts[0], CUSTOMER);
});

test('sparse detail responses preserve valid list values while fresh non-empty values win', async () => {
  const list = fullContact();
  const detail = { contact_id: CUSTOMER, contact_name: 'Updated Contact', company_name: '', email: null, phone: '',
    billing_address: { address: '', city: 'Abu Dhabi' }, shipping_address: null, payment_terms: 0,
    custom_fields: [{ customfield_id: 'custom-1', value: null }],
    contact_persons: [{ contact_person_id: 'person-1', first_name: 'New', email: null }] };
  const h = harness({ contacts: [list], detail });
  await h.start();
  const selected = await h.send('1');
  const raw = selected.bill.customer_details.zoho_contact;
  assert.deepEqual(raw, { ...list, contact_name: 'Updated Contact', billing_address: { ...list.billing_address, city: 'Abu Dhabi' },
    contact_persons: [{ ...list.contact_persons[0], first_name: 'New' }] });
  assert.equal(selected.bill.customer_details.customer_email, list.email);
  assert.equal(selected.bill.customer_details.customer_phone, list.phone);
  assert.equal(raw.payment_terms, 0);
  assert.equal(raw.is_portal_enabled, false);
  assert.equal((await h.send('SAVE')).state, 'COMPLETED');
  assert.deepEqual(h.creates[0].customerDetails.zoho_contact, raw);
});

for (const [label, changes] of [
  ['wrong ID', { contact_id: 'other-customer' }], ['wrong organization', { organization_id: '802911060' }],
  ['vendor contact', { contact_type: 'vendor' }], ['inactive contact', { status: 'inactive' }],
]) test(`customer detail verification rejects ${label} without falling back to an old ID`, async () => {
  const h = harness({ detail: { ...fullContact(), ...changes } });
  const initial = await h.start();
  assert.equal((await h.send('1')).state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal((await h.billStore.getBill(initial.billId)).customer_details, null);
  assert.equal(h.posts.length, 0);
});

for (const prefix of ['', 'Customer: ', 'Client: ']) test(`manual no-match customer with ${prefix || 'free-form'} input saves rich details without a fake ID`, async () => {
  const h = harness({ contacts: [] });
  const initial = await h.start();
  const review = await h.send(`${prefix}Manual Customer; Email: manual@example.invalid; Phone: 0501234567; Mobile: 0551234567; TRN: 100000000000009; Address: Unit 12, Test Road, Dubai; Site: Test site`);
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  const details = { customer_name: 'Manual Customer', customer_email: 'manual@example.invalid', customer_phone: '0501234567',
    customer_mobile: '0551234567', customer_trn: '100000000000009', customer_address: 'Unit 12, Test Road, Dubai', project_site: 'Test site',
    customer_id: null, contact_id: null, organization_id: ORG, customer_source: 'manual', customer_lookup_status: 'not_found' };
  assert.deepEqual(review.bill.customer_details, details);
  assert.deepEqual((await h.billStore.getBill(initial.billId)).customer_details, details);
  assert.deepEqual((await h.billStore.getBillSession(initial.sessionId)).bill_data.customer_details, details);
  assert.equal(review.bill.vendor_trn, undefined, 'Customer TRN must not be applied to vendor matching');
  assert.equal((await h.send('SAVE')).state, 'COMPLETED');
  assert.equal(h.creates[0].customerId, null);
  assert.deepEqual(h.creates[0].customerDetails, details);
  assert.equal(Object.hasOwn(h.posts[0], 'customer_id'), false);
  for (const value of ['Manual Customer', details.customer_email, details.customer_phone, details.customer_mobile,
    details.customer_trn, details.customer_address, details.project_site]) assert.ok(h.posts[0].notes.includes(value), value);
  assertUnchangedBill(h, h.posts[0], null);
  await h.send('SAVE');
  assert.equal(h.posts.length, 1);
});

test('manual name alone is sufficient and optional fields are not fabricated', async () => {
  const h = harness({ contacts: [] });
  await h.start();
  assert.equal((await h.send('Customer: Name Alone')).state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal((await h.send('SAVE')).state, 'COMPLETED');
  assert.equal(h.posts[0].customer_id, undefined);
  assert.match(h.posts[0].notes, /Customer: Name Alone/);
  assert.doesNotMatch(h.posts[0].notes, /Customer (?:TRN|email|phone|mobile|address):/);
});

test('labelled customer corrections preserve the existing combined payment correction behavior', async () => {
  const h = harness({ contacts: [] });
  await h.start();
  await h.send('Customer: Name Alone');
  const review = await h.send('Customer: Updated Name; TRN: 100000000000009; Payment method: Cash');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(review.bill.payment_type, 'Cash');
  assert.equal(review.bill.customer_details.customer_name, 'Updated Name');
  assert.equal(review.bill.customer_details.customer_trn, '100000000000009');
  assert.equal(review.bill.vendor_trn, undefined);
  assert.equal((await h.send('SAVE')).state, 'COMPLETED');
  assert.match(h.posts[0].notes, /Payment method: Cash/);
  assert.doesNotMatch(h.posts[0].notes, /Project\/site: Payment/);
});

test('partial manual metadata waits for a required name and survives the next reply', async () => {
  const h = harness({ contacts: [] });
  await h.start();
  const partial = await h.send('Email: partial@example.invalid; TRN: 100000000000009; Address: Fixture Road');
  assert.equal(partial.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(partial.bill.customer_details.customer_name, undefined);
  assert.equal(h.posts.length, 0);
  const review = await h.send('Customer: Partial Customer');
  assert.equal(review.bill.customer_details.customer_email, 'partial@example.invalid');
  assert.equal(review.bill.customer_details.customer_trn, '100000000000009');
  assert.equal(review.bill.customer_details.customer_address, 'Fixture Road');
  assert.equal((await h.send('SAVE')).state, 'COMPLETED');
});

test('editing to a new manual customer clears old contact metadata and preserves bill fields', async () => {
  const h = harness();
  await h.start();
  await h.send('1');
  await h.send('EDIT');
  const review = await h.send('Customer: New Manual Customer');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.deepEqual(review.bill.customer_details, { customer_name: 'New Manual Customer', customer_id: null, contact_id: null,
    organization_id: ORG, customer_source: 'manual', customer_lookup_status: 'not_found' });
  assert.equal((await h.send('SAVE')).state, 'COMPLETED');
  assert.equal(h.posts[0].customer_id, undefined);
  assert.doesNotMatch(h.posts[0].notes, /fixture@example|Fixture Road|100000000000001/);
  assertUnchangedBill(h, h.posts[0], null);
});

test('a different manual name never inherits the previous manual address, TRN or phone', async () => {
  const h = harness({ contacts: [] });
  await h.start();
  await h.send('Customer: Old Manual; Phone: 0501234567; TRN: 100000000000009; Address: Old Address');
  const review = await h.send('Customer: New Manual');
  assert.deepEqual(review.bill.customer_details, { customer_name: 'New Manual', customer_id: null, contact_id: null,
    organization_id: ORG, customer_source: 'manual', customer_lookup_status: 'not_found' });
});

test('invalid customer-list response is not treated as a confirmed no-match', async () => {
  const h = harness({ malformedList: true });
  await h.start();
  const result = await h.send('Customer: Retain Manual; TRN: 100000000000009');
  assert.equal(result.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.match(result.replyText, /could not load/);
  assert.equal(result.bill.customer_details.customer_name, 'Retain Manual');
  assert.equal(result.bill.customer_details.customer_trn, '100000000000009');
  assert.equal(result.bill.customer_details.customer_lookup_status, null);
  assert.equal(h.posts.length, 0);
});

for (const hasOptions of [true, false]) test(`invalid numeric replies cannot edit/delete/parse a customer (${hasOptions ? 'one option' : 'no options'})`, async () => {
  const h = harness({ contacts: hasOptions ? [fullContact()] : [] });
  const initial = await h.start();
  for (const choice of ['0', '-1', '2', '3', '4', '99']) {
    const result = await h.send(choice);
    assert.equal(result.state, 'WAITING_FOR_CUSTOMER_SELECTION', choice);
    assert.equal(result.replyText, 'Please select one of the customers shown in the Zoho Books list.');
    assert.equal((await h.billStore.getBill(initial.billId)).customer_details, null);
    assert.equal((await h.billStore.getBillSession(initial.sessionId)).state, 'WAITING_FOR_CUSTOMER_SELECTION');
  }
  assert.equal(h.reads.length, 1, 'Invalid numbers must not start a new customer lookup');
  assert.equal(h.calls.filter(([action]) => ['edit', 'merge', 'create'].includes(action)).length, 0);
  assert.equal(h.posts.length, 0);
  if (hasOptions) assert.equal((await h.send('1')).bill.customer_details.customer_id, CUSTOMER);
});

test('customer display name and customer code remain searchable', async () => {
  const h = harness();
  for (const searchText of ['Fixture Display', 'FIXTURE-C001']) {
    const results = await h.client.searchCustomer({ organizationId: ORG, searchText });
    assert.equal(results.length, 1);
    assert.equal(results[0].contactId, CUSTOMER);
    assert.deepEqual(results[0].raw, fullContact());
  }
});

for (const search of ['Fixture', 'Fixture Display', 'FIXTURE-C001']) test(`matching customer search "${search}" still offers verified list selection`, async () => {
  const h = harness();
  await h.start();
  const options = await h.send(`Customer: ${search}`);
  assert.equal(options.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(options.replyInteractive.sections[0].rows[0].id, `zoho-customer:${CUSTOMER}`);
  assert.notEqual(options.bill.customer_details.customer_lookup_status, 'not_found');
  const review = await h.send('1');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(review.bill.customer_details.customer_id, CUSTOMER);
  assert.deepEqual(review.bill.customer_details.zoho_contact, fullContact());
});

test('new customer notes are redacted if echoed by the provider error', async () => {
  const address = 'Private Fixture Street', person = 'Private Fixture Person';
  const h = harness({ contacts: [], rejectMessage: `Invalid value ${address}; ${person}; manual@example.invalid; 100000000000009` });
  await h.start();
  await h.send(`Customer: Manual Customer; Contact person: ${person}; Email: manual@example.invalid; TRN: 100000000000009; Address: ${address}`);
  assert.equal((await h.send('SAVE')).state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].providerCode, 12345);
  assert.equal(h.events[0].providerMessage, 'Invalid value [REDACTED]; [REDACTED]; [REDACTED]; [REDACTED]');
});

test('customer merge clones nested data and ignores empty values without losing zero or false', () => {
  const original = fullContact();
  const merged = mergeCustomerData(original, { billing_address: '', custom_fields: [], payment_terms: 0, is_portal_enabled: false });
  assert.deepEqual(merged, original);
  merged.billing_address.address = 'Changed locally';
  merged.contact_persons[0].email = 'changed@example.invalid';
  assert.equal(original.billing_address.address, 'Fixture Road 1');
  assert.equal(original.contact_persons[0].email, 'person@example.invalid');
});

test('manual parser retains company, contact person, billing/shipping addresses and labelled tax numbers', () => {
  assert.deepEqual(parseManualCustomerDetails('Customer details: Company: Manual LLC; Contact person: Person One; Tax number: 100000000000009; Billing address: Unit 1, Dubai; Shipping address: Warehouse, Sharjah'), {
    customer_company_name: 'Manual LLC', customer_name: 'Manual LLC', customer_contact_person: 'Person One',
    customer_trn: '100000000000009', customer_billing_address: 'Unit 1, Dubai', customer_shipping_address: 'Warehouse, Sharjah',
  });
});
