'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');
const { fixture, validBill } = require('./billFixtures');

const CONTRACTING = validBill().organization.organizationId;
const SWITCHGEAR = '802911060';
const ACCOUNT = '100000000000001'; // Synthetic, not a production account ID.
const MESSAGE = 'VAT or Exemption cannot be applied for this VAT Treatment.';

function sourceBill() {
  return { ...validBill(), bill_number: 'FIXTURE-VAT-71538', subtotal: 370, tax_amount: 18.5, total_amount: 388.5,
    line_items: [
      { name: 'Lamp', quantity: 1, rate: 90, amount: 94.5, tax_percentage: 5 },
      { name: 'Headlamp', quantity: 1, rate: 160, amount: 168, tax_percentage: 5 },
      { name: 'Grille', quantity: 1, rate: 120, amount: 126, tax_percentage: 5 },
    ] };
}

function harness({ treatment = 'vat_not_registered', organizationId = CONTRACTING } = {}) {
  const reads = [], posts = [], events = [];
  const vendor = { id: 'fixture-vendor', name: validBill().vendor_name, organizationId,
    raw: { contact_id: 'fixture-vendor', contact_type: 'vendor', status: 'active',
      tax_treatment: treatment, vat_reg_no: '', currency_id: 'fixture-aed' } };
  const client = createZohoBooksClient({
    env: { ZOHO_BOOKS_CONTRACTING_ORG_ID: CONTRACTING, ZOHO_BOOKS_SWITCHGEAR_ORG_ID: SWITCHGEAR,
      ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_ID: ACCOUNT,
      ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_NAME: 'VEHICLE REPARING' },
    clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh',
    logger: { error: event => events.push(event) },
    http: {
      async get(url, options) {
        assert.equal(options.params.organization_id, organizationId);
        const endpoint = new URL(url).pathname.replace('/books/v3', '');
        reads.push(endpoint);
        if (endpoint === '/settings/currencies') return { data: { code: 0, currencies: [{ currency_id: 'fixture-aed', currency_code: 'AED' }] } };
        if (endpoint === '/settings/taxes') return { data: { code: 0, taxes: [{ tax_id: 'fixture-vat5', tax_type: 'tax', tax_percentage: 5 }] } };
        assert.equal(endpoint, `/chartofaccounts/${ACCOUNT}`);
        return { data: { code: 0, chart_of_account: { account_id: ACCOUNT, account_name: 'VEHICLE REPARING',
          account_type: 'expense', is_active: true, organization_id: organizationId } } };
      },
      async post(url, payload, options) {
        if (url.endsWith('/oauth/v2/token')) return { data: { access_token: 'fixture-access', expires_in: 3600 } };
        assert.ok(url.endsWith('/bills'), 'No contact mutation or other API write is allowed');
        assert.equal(options.params.organization_id, organizationId);
        const sent = JSON.parse(JSON.stringify(payload));
        posts.push(sent);
        // Reproduce the real provider rule: omitted bill treatment inherits
        // the vendor treatment, not an inferred registration from invoice VAT.
        const effectiveTreatment = sent.tax_treatment || vendor.raw.tax_treatment;
        if (effectiveTreatment === 'vat_not_registered' && sent.line_items.some(item => item.tax_id || item.tax_percentage > 0)) {
          throw Object.assign(Error('fixture-private-transport'), { response: { status: 400, data: { code: 71538, message: MESSAGE } } });
        }
        const sub_total = sent.line_items.reduce((sum, item) => sum + item.quantity * item.rate, 0);
        const tax_total = sent.line_items.reduce((sum, item) => sum + item.quantity * item.rate * (item.tax_percentage || 0) / 100, 0);
        return { status: 201, data: { code: 0, bill: { bill_id: 'fixture-created', sub_total, tax_total, total: sub_total + tax_total } } };
      },
    },
  });
  function input(bill) {
    return { vendorId: vendor.id, billNumber: bill.bill_number, billDate: bill.bill_date,
      lineItems: bill.line_items, currency: bill.currency, currencyId: bill.currency_id, organizationId };
  }
  function workflow() {
    return fixture({ bill: sourceBill(), logger: { error: event => events.push(event) }, zohoOverrides: {
      async searchVendor() { return [structuredClone(vendor)]; },
      prepareBill: client.prepareBill, createBill: client.createBill,
    } });
  }
  return { client, vendor, reads, posts, events, input, workflow, organizationId };
}

test('71538 reproduction: valid accounts and VAT-inclusive source amounts do not override a non-registered vendor', async () => {
  const h = harness();
  const bill = sourceBill();
  for (const line of bill.line_items) line.tax_id = 'fixture-vat5';
  await assert.rejects(h.client.createBill(h.input(bill)), {
    httpStatus: 400, providerCode: 71538, providerMessage: MESSAGE, operation: 'createBill',
  });
  assert.equal(h.posts.length, 1);
  assert.ok(h.posts[0].line_items.every(line => line.account_id === ACCOUNT && line.tax_id === 'fixture-vat5' && line.tax_percentage === 5));
  assert.deepEqual(h.posts[0].line_items.map(line => line.rate), [90, 160, 120]);
  assert.ok(h.posts[0].line_items.every(line => !Object.hasOwn(line, 'item_total')));
  assert.equal(h.posts[0].tax_treatment, undefined);
  assert.deepEqual(h.events, [{ event: 'zoho.books.bill_create_failed', httpStatus: 400, providerCode: 71538,
    providerMessage: MESSAGE, operation: 'createBill', method: 'POST', endpoint: '/bills' }]);
});

for (const organizationId of [CONTRACTING, SWITCHGEAR]) {
  test(`preflight stops conflicting purchase VAT before POST without changing any source data in ${organizationId}`, async () => {
    const h = harness({ organizationId });
    const bill = sourceBill(), before = structuredClone(bill);
    h.vendor.id = 'another-synthetic-vendor';
    h.vendor.name = 'Another Supplier';
    await assert.rejects(h.client.prepareBill(bill, h.vendor, { organizationId }), {
      code: 'VENDOR_VAT_TREATMENT_CONFLICT', operation: 'prepareBill',
    });
    assert.deepEqual(bill, before);
    assert.deepEqual(h.reads, [], 'The freshly resolved vendor metadata needs no redundant lookup');
    assert.deepEqual(h.posts, []);
  });
}

test('SAVE preserves the rejected draft, attachments and existing review reply without a VAT-treatment/account prompt', async () => {
  const h = harness(), f = h.workflow();
  const initial = await f.send('', { messageType: 'image', mediaId: 'fixture-image' });
  const before = structuredClone(await f.billStore.getBill(initial.billId));
  const result = await f.send('SAVE');
  assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(result.replyText, 'Zoho vendor, currency, tax or duplicate validation failed. Nothing was created.\nReply SAVE to retry, EDIT to correct, or DELETE.');
  assert.doesNotMatch(result.replyText, /enter.*(?:account|VAT treatment)|tax percentage missing/i);
  const after = await f.billStore.getBill(initial.billId);
  assert.equal(after.status, 'PENDING_REVIEW');
  assert.equal(after.zoho_bill_id, undefined);
  for (const field of ['line_items', 'subtotal', 'tax_amount', 'total_amount', 'vendor_name', 'organization', 'customer_details', 'payment_type', 'attachments']) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.equal((await f.send('SAVE')).state, 'AWAITING_FINAL_CONFIRMATION');
  assert.deepEqual(h.posts, []);
  assert.equal(f.calls.filter(([action]) => ['attach', 'pdf', 'document', 'edit', 'merge'].includes(action)).length, 0);
  assert.ok(h.events.every(event => event.event === 'books.bill_preflight_failed' && event.code === 'VENDOR_VAT_TREATMENT_CONFLICT'));
  assert.equal(h.events.length, 2);
  assert.doesNotMatch(JSON.stringify(h.events), /fixture-secret|fixture-refresh|fixture-access|fixture-vendor|Supplier|Authorization/);
});

test('the same draft saves with 18.50 VAT after an administrator corrects the vendor metadata, with accounts and attachments intact', async () => {
  const h = harness(), f = h.workflow();
  const initial = await f.send('', { messageType: 'image', mediaId: 'fixture-image' });
  assert.equal((await f.send('SAVE')).state, 'AWAITING_FINAL_CONFIRMATION');
  // Simulate an external administrator correction, never a backend contact write.
  h.vendor.raw.tax_treatment = 'vat_registered';
  h.vendor.raw.vat_reg_no = 'fixture-verified-registration';
  const result = await f.send('SAVE');
  assert.equal(result.state, 'COMPLETED');
  assert.equal(h.posts.length, 1);
  const payload = h.posts[0];
  assert.deepEqual(payload.line_items.map(line => line.rate), [90, 160, 120]);
  assert.ok(payload.line_items.every(line => line.account_id === ACCOUNT && line.tax_id === 'fixture-vat5' && line.tax_percentage === 5));
  assert.ok(payload.line_items.every(line => !Object.hasOwn(line, 'item_total')));
  assert.equal(payload.tax_treatment, undefined, 'Inherit actual vendor treatment; do not override registration');
  assert.equal(payload.is_reverse_charge_applied, undefined);
  const net = payload.line_items.reduce((sum, line) => sum + line.quantity * line.rate, 0);
  const vat = payload.line_items.reduce((sum, line) => sum + line.quantity * line.rate * line.tax_percentage / 100, 0);
  assert.equal(net, 370);
  assert.equal(vat, 18.5);
  assert.equal(net + vat, 388.5);
  const saved = await f.billStore.getBill(initial.billId);
  assert.deepEqual(saved.line_items.map(line => line.amount), [94.5, 168, 126]);
  assert.equal(saved.tax_amount, 18.5);
  assert.equal(saved.total_amount, 388.5);
  assert.match(payload.notes, new RegExp(`Payment method: ${saved.payment_type}`));
  const attachments = f.calls.filter(([action]) => action === 'attach');
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0][1].buffer.toString(), 'original-image');
  assert.equal(f.calls.filter(([action]) => action === 'document').length, 1);
  assert.equal(h.reads.filter(path => path.startsWith('/chartofaccounts/')).length, 1);
});

test('a genuinely VAT-free bill from a non-registered vendor still saves without fabricated taxes or treatment', async () => {
  const h = harness(), bill = sourceBill();
  bill.tax_amount = 0;
  bill.total_amount = 370;
  for (const line of bill.line_items) { line.tax_percentage = 0; line.amount = line.quantity * line.rate; }
  await h.client.prepareBill(bill, h.vendor, { organizationId: CONTRACTING });
  const result = await h.client.createBill(h.input(bill));
  assert.equal(result.raw.bill.total, 370);
  assert.equal(result.raw.bill.tax_total, 0);
  assert.equal(h.reads.includes('/settings/taxes'), false);
  assert.ok(h.posts[0].line_items.every(line => line.account_id === ACCOUNT && !Object.hasOwn(line, 'tax_id') && !Object.hasOwn(line, 'tax_percentage')));
  assert.equal(h.posts[0].tax_treatment, undefined);
});

for (const [field, value] of [
  ['tax_percentage', 5], ['tax', 5], ['tax_id', 'fixture-vat5'], ['taxId', 'fixture-vat5'],
  ['tax_exemption_id', 'fixture-exempt'], ['tax_exemption_code', 'fixture-exempt'],
]) {
  test(`non-registered vendor rejects incompatible ${field} even when the source tax total is zero`, async () => {
    const h = harness(), bill = sourceBill();
    bill.tax_amount = 0;
    bill.total_amount = 370;
    for (const line of bill.line_items) { delete line.tax_percentage; line.amount = line.quantity * line.rate; }
    bill.line_items[0][field] = value;
    await assert.rejects(h.client.prepareBill(bill, h.vendor, { organizationId: CONTRACTING }), { code: 'VENDOR_VAT_TREATMENT_CONFLICT' });
    assert.equal(bill.line_items[0][field], value, 'Never silently discard source or supplied tax fields');
    assert.deepEqual(h.posts, []);
  });
}

test('extracted registration/treatment claims cannot override actual Zoho vendor metadata', async () => {
  const h = harness(), bill = sourceBill();
  bill.tax_treatment = 'vat_registered';
  bill.vendor_trn = 'fixture-extracted-registration';
  await assert.rejects(h.client.prepareBill(bill, h.vendor, { organizationId: CONTRACTING }), { code: 'VENDOR_VAT_TREATMENT_CONFLICT' });
  assert.equal(h.vendor.raw.tax_treatment, 'vat_not_registered');
  assert.equal(bill.tax_amount, 18.5);
  assert.equal(bill.total_amount, 388.5);
  assert.deepEqual(h.posts, []);
});
