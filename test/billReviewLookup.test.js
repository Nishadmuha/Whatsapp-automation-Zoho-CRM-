'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, validBill } = require('./billFixtures');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');

const ORGANIZATION = validBill().organization.organizationId;
const ALIAS = 'NEW QAMAR JASI BUILDING MATERIALS TRADING L.L.C (BR)';
const CANONICAL = 'NEW QAMAR JASI BUILDING MATERIALS TRADING LLC';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function vendorClient() {
  let reads = 0;
  let vendors = [{ contact_id: 'supplier', contact_name: validBill().vendor_name, status: 'active' }];
  const client = createZohoBooksClient({
    env: {}, clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh',
    http: {
      async get(url, { params }) {
        assert.ok(url.endsWith('/contacts'));
        assert.equal(params.organization_id, ORGANIZATION);
        assert.equal(params.contact_type, 'vendor');
        reads++;
        return { data: { code: 0, contacts: structuredClone(vendors), page_context: { has_more_page: false } } };
      },
      async post(url) {
        assert.ok(url.endsWith('/oauth/v2/token'), 'This fixture cannot create any live contact or financial record');
        return { data: { access_token: 'fixture-access' } };
      },
    },
  });
  return { client, readCount: () => reads, change: value => { vendors = value; } };
}

test('normal worker conversation uses one review vendor scan and one independent SAVE scan', async () => {
  const h = vendorClient();
  let customerLists = 0;
  const f = fixture({ bill: { ...validBill(), customer_details: null, payment_type: null },
    workerAnswers: null, workerPaymentMethod: null, zohoOverrides: {
      searchVendor: h.client.searchVendor,
      async searchCustomer() { customerLists++; return [{ id: 'customer', name: 'Customer LLC', status: 'active' }]; },
      async getCustomer(id) { return { id, name: 'Customer LLC', status: 'active' }; },
    } });
  assert.equal((await f.send('Invoice details')).state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal((await f.send('Select', { interactiveId: 'zoho-customer:customer' })).state, 'WAITING_FOR_PROJECT_DETAILS');
  const method = await f.send('Dubai site');
  assert.equal(method.state, 'WAITING_FOR_ADDITIONAL_INFO');
  assert.match(method.replyText, /Please confirm the payment method/);
  assert.equal((await f.send('Cash')).state, 'WAITING_FOR_PAYMENT_STATUS');
  const review = await f.send('UNPAID');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.match(review.replyText, /1 SAVE\n2 EDIT\n3 DELETE/);
  assert.equal(h.readCount(), 1);
  assert.equal(customerLists, 1);
  assert.equal(f.calls.filter(([action]) => ['edit', 'merge', 'ocr'].includes(action)).length, 0);
  assert.equal((await f.send('SAVE')).state, 'COMPLETED');
  assert.equal(h.readCount(), 2);
  assert.equal(f.calls.filter(([action]) => action === 'create').length, 1);
});

for (const [scenario, changed, message] of [
  ['inactive', [{ contact_id: 'supplier', contact_name: 'Supplier LLC', status: 'inactive' }], /inactive/],
  ['renamed', [{ contact_id: 'supplier', contact_name: 'Renamed LLC', status: 'active' }], /reviewed vendor has changed/i],
  ['ambiguous', [{ contact_id: 'supplier', contact_name: 'Supplier LLC' }, { contact_id: 'other', contact_name: 'Supplier LLC' }], /Multiple vendors/],
  ['wrong organization', [{ contact_id: 'supplier', contact_name: 'Supplier LLC', organization_id: 'different-org' }], /does not belong/],
]) {
  test(`fresh SAVE detects ${scenario} after a cached review`, async () => {
    const h = vendorClient(), f = fixture({ zohoOverrides: { searchVendor: h.client.searchVendor } });
    assert.equal((await f.send('Invoice details')).state, 'AWAITING_FINAL_CONFIRMATION');
    assert.equal(h.readCount(), 1);
    h.change(changed);
    const result = await f.send('SAVE');
    assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
    assert.match(result.replyText, message);
    assert.equal(h.readCount(), 2);
    assert.equal(f.calls.some(([action]) => action === 'create'), false);
  });
}

test('customer list starts alongside vendor lookup and is reused by the original selection prompt', async () => {
  let releaseVendor;
  const vendorGate = new Promise(resolve => { releaseVendor = resolve; });
  let customerStarted = false, vendorFinished = false, lists = 0;
  const f = fixture({ zohoOverrides: {
    async searchVendor() { await vendorGate; vendorFinished = true; return [{ id: 'supplier', name: 'Supplier LLC' }]; },
    async searchCustomer() { customerStarted = true; lists++; return [{ id: 'customer', name: 'Customer LLC' }]; },
  } });
  const reply = f.send('Invoice details');
  for (let i = 0; i < 5 && !customerStarted; i++) await nextTurn();
  const overlapped = customerStarted && !vendorFinished;
  releaseVendor();
  const result = await reply;
  assert.equal(overlapped, true);
  assert.equal(lists, 1);
  assert.equal(result.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(result.replyInteractive.header, 'Customer details');
});

test('parallel customer failure preserves vendor-first error priority and handles both rejections', async () => {
  const f = fixture({ zohoOverrides: {
    async searchVendor() { throw Error('fixture vendor unavailable'); },
    async searchCustomer() { throw Error('fixture customer unavailable'); },
  } });
  const result = await f.send('Invoice details');
  assert.equal(result.replyText, 'I could not check the vendor in Zoho Books. Please try again.');
  assert.equal(result.state, 'WAITING_FOR_ADDITIONAL_INFO');
});

test('parallel customer failure retains the existing customer retry prompt after valid vendor resolution', async () => {
  const f = fixture({ zohoOverrides: { async searchCustomer() { throw Error('fixture customer unavailable'); } } });
  const result = await f.send('Invoice details');
  assert.match(result.replyText, /I could not load the Zoho Books customer list/);
  assert.equal(result.state, 'WAITING_FOR_CUSTOMER_SELECTION');
});

test('confirmed branch alias selects the existing registered vendor despite an exact-name unregistered duplicate', async () => {
  const bill = { ...validBill(), vendor_name: ALIAS };
  const f = fixture({ bill, zohoOverrides: {
    async searchVendor() { return [
      { id: 'unregistered-duplicate', name: ALIAS, status: 'active', raw: { tax_treatment: 'vat_not_registered' } },
      { id: 'existing-registered', name: CANONICAL, status: 'active', raw: { tax_treatment: 'vat_registered' } },
    ]; },
    async createVendor() { assert.fail('The confirmed existing supplier must never create a new contact'); },
    async prepareBill(candidate, vendor) { assert.equal(vendor.id, 'existing-registered'); assert.equal(candidate.tax_amount, 5); },
  } });
  const review = await f.send('Invoice details');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(review.bill.vendor_name, CANONICAL);
  assert.equal(review.bill.zoho_vendor_id, 'existing-registered');
  assert.equal((await f.send('SAVE')).state, 'COMPLETED');
  assert.equal(f.calls.find(([action]) => action === 'create')[1].vendorId, 'existing-registered');
});

for (const [scenario, vendors, message] of [
  ['missing', [{ id: 'duplicate', name: ALIAS }], /confirmed existing vendor could not be found/i],
  ['inactive', [{ id: 'existing', name: CANONICAL, status: 'inactive' }], /inactive/],
  ['ambiguous', [{ id: 'existing', name: CANONICAL }, { id: 'other', name: CANONICAL }], /Multiple vendors/],
  ['wrong TRN', [{ id: 'existing', name: CANONICAL, trn: 'different-registration' }], /Multiple vendors/],
]) {
  test(`confirmed alias fails safely when canonical target is ${scenario}`, async () => {
    const f = fixture({ bill: { ...validBill(), vendor_name: ALIAS, ...(scenario === 'wrong TRN' ? { vendor_trn: 'fixture-registration' } : {}) },
      zohoOverrides: {
        async searchVendor() { return vendors; },
        async createVendor() { assert.fail('Do not create a replacement for a confirmed existing supplier'); },
      } });
    const result = await f.send('Invoice details');
    assert.equal(result.state, 'WAITING_FOR_ADDITIONAL_INFO');
    assert.match(result.replyText, message);
    assert.match((await f.send('SAVE')).replyText, message);
    assert.equal(f.calls.some(([action]) => action === 'create'), false);
  });
}
