'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');
const { fixture, validBill } = require('./billFixtures');

const CONTRACTING = validBill().organization.organizationId;
const SWITCHGEAR = '802911060';
// Synthetic account IDs and OAuth values only; never copy private .env values.
const CONTRACTING_ACCOUNT = '100000000000001';
const SWITCHGEAR_ACCOUNT = '100000000000002';
const ACCOUNT_NAME = 'VEHICLE REPARING';

function harness({ overrides = {}, accountChange = {}, accountFailure = null, postFailure = null } = {}) {
  const env = {
    ZOHO_BOOKS_CONTRACTING_ORG_ID: CONTRACTING,
    ZOHO_BOOKS_SWITCHGEAR_ORG_ID: SWITCHGEAR,
    ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_ID: CONTRACTING_ACCOUNT,
    ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_NAME: ACCOUNT_NAME,
    ...overrides,
  };
  const reads = [], posts = [], events = [];
  const client = createZohoBooksClient({ env,
    clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh',
    logger: { error: event => events.push(event) },
    http: {
      async post(url, payload, options) {
        if (url.endsWith('/oauth/v2/token')) return { status: 200, data: { access_token: 'fixture-access', expires_in: 3600 } };
        assert.ok(url.endsWith('/bills'));
        posts.push({ payload: JSON.parse(JSON.stringify(payload)), organizationId: options.params.organization_id });
        if (postFailure) throw postFailure;
        return { status: 201, data: { code: 0, bill: { bill_id: 'fixture-created-bill' } } };
      },
      async get(url, options) {
        const organizationId = options.params.organization_id;
        const endpoint = new URL(url).pathname.replace('/books/v3', '');
        reads.push({ endpoint, organizationId });
        assert.equal(options.maxRedirects, 0);
        if (endpoint === '/settings/currencies') return { data: { code: 0, currencies: [{ currency_id: 'fixture-aed', currency_code: 'AED' }] } };
        if (endpoint === '/settings/taxes') return { data: { code: 0, taxes: [{ tax_id: 'fixture-vat5', tax_type: 'tax', tax_percentage: 5 }] } };
        assert.match(endpoint, /^\/chartofaccounts\/\d+$/);
        if (accountFailure) throw accountFailure;
        const id = organizationId === CONTRACTING ? CONTRACTING_ACCOUNT : SWITCHGEAR_ACCOUNT;
        if (endpoint !== `/chartofaccounts/${id}`) return { data: { code: 0 } };
        const account = { account_id: id, account_name: organizationId === CONTRACTING ? ACCOUNT_NAME : 'Approved Switchgear Expense',
          is_active: true, account_type: 'expense', organization_id: organizationId, ...accountChange };
        return { status: 200, data: { code: 0, chart_of_account: account } };
      },
    },
  });
  return { client, env, reads, posts, events,
    accountReads: () => reads.filter(read => read.endpoint.startsWith('/chartofaccounts/')) };
}

function createInput(bill = validBill(), organizationId = CONTRACTING) {
  return { vendorId: 'fixture-vendor', billNumber: bill.bill_number, billDate: bill.bill_date,
    lineItems: bill.line_items, currency: bill.currency, currencyId: bill.currency_id,
    paymentType: bill.payment_type, organizationId };
}

test('Contracting resolves its configured VEHICLE REPARING account and uses it on every line', async () => {
  const h = harness();
  const bill = validBill();
  bill.line_items = [
    { name: 'Lamp', quantity: 1, rate: 90, amount: 94.5, tax_percentage: 5 },
    { name: 'Headlamp', quantity: 1, rate: 160, amount: 168, tax_percentage: 5 },
    { name: 'Grille', quantity: 1, rate: 120, amount: 126, tax_percentage: 5 },
  ];
  Object.assign(bill, { subtotal: 370, tax_amount: 18.5, total_amount: 388.5 });
  await h.client.prepareBill(bill, {}, { organizationId: CONTRACTING });
  assert.equal(h.posts.length, 0);
  assert.ok(bill.line_items.every(item => item.account_id === undefined), 'Accounting metadata is not an extracted invoice value');
  await h.client.createBill(createInput(bill));
  assert.deepEqual(h.accountReads(), [{ endpoint: `/chartofaccounts/${CONTRACTING_ACCOUNT}`, organizationId: CONTRACTING }]);
  assert.equal(h.posts.length, 1);
  const payload = h.posts[0].payload;
  assert.deepEqual(payload.line_items.map(item => item.account_id), Array(3).fill(CONTRACTING_ACCOUNT));
  assert.deepEqual(payload.line_items.map(item => item.rate), [90, 160, 120]);
  assert.ok(payload.line_items.every(item => item.tax_id === 'fixture-vat5' && item.tax_percentage === 5 && !Object.hasOwn(item, 'item_total')));
  assert.deepEqual(bill.line_items.map(item => item.amount), [94.5, 168, 126]);
  assert.equal(bill.tax_amount, 18.5);
  assert.equal(bill.total_amount, 388.5);
});

test('direct createBill also validates the configured account rather than trusting extracted IDs', async () => {
  const h = harness();
  const input = createInput();
  input.lineItems[0].account_id = SWITCHGEAR_ACCOUNT;
  input.lineItems[0].item_id = 'untrusted-extracted-item';
  await h.client.createBill(input);
  assert.equal(h.accountReads().length, 1);
  assert.equal(h.posts[0].payload.line_items[0].account_id, CONTRACTING_ACCOUNT);
  assert.equal(h.posts[0].payload.line_items[0].item_id, undefined);
});

for (const paymentType of ['Cash', 'Bank Remittance', 'Bank Transfer', 'Credit Card', 'Cheque']) {
  test(`SAVE resolves the same approved account independently of payment method ${paymentType}`, async () => {
    const h = harness();
    const f = fixture({ bill: { ...validBill(), payment_type: paymentType },
      zohoOverrides: { prepareBill: h.client.prepareBill, createBill: h.client.createBill } });
    const initial = await f.send('Synthetic invoice');
    assert.doesNotMatch(initial.replyText, /account|VEHICLE REPARING/i);
    const result = await f.send('SAVE');
    assert.equal(result.state, 'COMPLETED');
    assert.match(result.replyText, /BILL SAVED TO ZOHO BOOKS/);
    assert.doesNotMatch(result.replyText, /account id|account name|chart.of.accounts|VEHICLE REPARING/i);
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].payload.line_items[0].account_id, CONTRACTING_ACCOUNT);
    assert.ok(h.posts[0].payload.notes.includes(`Payment method: ${paymentType}`));
    assert.equal((await f.billStore.getBill(initial.billId)).payment_type, paymentType);
  });
}

test('customer/vendor data, VAT, attachments and document delivery remain unchanged through SAVE', async () => {
  const h = harness();
  const f = fixture({ zohoOverrides: { prepareBill: h.client.prepareBill, createBill: h.client.createBill } });
  const initial = await f.send('', { messageType: 'image', mediaId: 'fixture-image' });
  const before = structuredClone(await f.billStore.getBill(initial.billId));
  const result = await f.send('SAVE');
  const after = await f.billStore.getBill(initial.billId);
  assert.equal(result.state, 'COMPLETED');
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].payload.vendor_id, 'v1');
  assert.equal(h.posts[0].payload.line_items[0].tax_id, 'fixture-vat5');
  for (const field of ['vendor_name', 'customer_details', 'organization', 'payment_type', 'subtotal', 'tax_amount', 'total_amount']) {
    assert.deepEqual(after[field], before[field], field);
  }
  const attachments = f.calls.filter(([action]) => action === 'attach');
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0][1].billId, 'fixture-created-bill');
  assert.equal(attachments[0][1].organizationId, CONTRACTING);
  assert.equal(attachments[0][1].buffer.toString(), 'original-image');
  assert.equal(f.calls.filter(([action]) => action === 'document').length, 1);
  assert.equal(after.pdf_delivery_status, 'ACCEPTED');
  assert.equal(after.attachments[0].zoho_upload_status, 'uploaded');
});

test('adding the verified account changes no other serialized bill payload field', async () => {
  const configured = harness();
  const legacy = harness({ overrides: { ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_ID: '', ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_NAME: '' } });
  for (const h of [configured, legacy]) {
    const bill = validBill();
    await h.client.prepareBill(bill, {}, { organizationId: CONTRACTING });
    await h.client.createBill({ ...createInput(bill), customerId: 'fixture-customer', notes: 'Fixture note', referenceNumber: 'FIXTURE-REFERENCE' });
  }
  const payload = structuredClone(configured.posts[0].payload);
  for (const line of payload.line_items) delete line.account_id;
  assert.deepEqual(payload, legacy.posts[0].payload);
});

for (const [label, accountChange, code] of [
  ['inactive account', { is_active: false }, 'BILL_ACCOUNT_INACTIVE'],
  ['missing active flag', { is_active: undefined }, 'BILL_ACCOUNT_INACTIVE'],
  ['string active flag', { is_active: 'true' }, 'BILL_ACCOUNT_INACTIVE'],
  ['wrong account ID', { account_id: SWITCHGEAR_ACCOUNT }, 'BILL_ACCOUNT_MISMATCH'],
  ['wrong organization', { organization_id: SWITCHGEAR }, 'BILL_ACCOUNT_ORGANIZATION_MISMATCH'],
  ['different account name', { account_name: 'Materials Purchase' }, 'BILL_ACCOUNT_NAME_MISMATCH'],
  ['payment/bank account', { account_type: 'bank' }, 'BILL_ACCOUNT_TYPE_INVALID'],
]) {
  test(`configured ${label} is rejected before POST without substituting another account`, async () => {
    const h = harness({ accountChange });
    await assert.rejects(h.client.prepareBill(validBill(), {}, { organizationId: CONTRACTING }), { code });
    await assert.rejects(h.client.createBill(createInput()), { code });
    assert.equal(h.posts.length, 0);
    assert.ok(h.accountReads().every(read => read.endpoint === `/chartofaccounts/${CONTRACTING_ACCOUNT}`));
  });
}

test('missing configured account fails preflight, retains the draft, and never asks the worker for an account', async () => {
  const h = harness({ overrides: { ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_ID: '100000000000099' } });
  const f = fixture({ zohoOverrides: { prepareBill: h.client.prepareBill, createBill: h.client.createBill } });
  const initial = await f.send('Synthetic invoice');
  const result = await f.send('SAVE');
  assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(result.replyText, 'Zoho vendor, currency, tax or duplicate validation failed. Nothing was created.\nReply SAVE to retry, EDIT to correct, or DELETE.');
  assert.doesNotMatch(result.replyText, /account|VEHICLE REPARING/i);
  assert.equal(h.posts.length, 0);
  assert.equal((await f.billStore.getBill(initial.billId)).status, 'PENDING_REVIEW');
  assert.equal(f.calls.filter(([action]) => action === 'document').length, 0);
});

test('account lookup failures do not retain raw credentials, provider text, headers or response bodies', async () => {
  const failure = Object.assign(Error('fixture-secret fixture-refresh fixture-access'), {
    response: { status: 401, data: { code: 57, message: 'fixture-private-person fixture-secret' } },
    config: { headers: { Authorization: 'fixture-access' } },
  });
  const events = [];
  const h = harness({ accountFailure: failure });
  await assert.rejects(h.client.createBill(createInput()), error => {
    assert.equal(error.code, 'BILL_ACCOUNT_LOOKUP_FAILED');
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message }), /fixture-|Authorization|headers|response|cause/);
    return true;
  });
  const f = fixture({ zohoOverrides: { prepareBill: h.client.prepareBill, createBill: h.client.createBill },
    logger: { error: event => events.push(event) } });
  await f.send('Synthetic invoice');
  await f.send('SAVE');
  assert.ok(events.some(event => event.code === 'BILL_ACCOUNT_LOOKUP_FAILED'));
  assert.doesNotMatch(JSON.stringify([...events, ...h.events]), /fixture-secret|fixture-refresh|fixture-access|fixture-private-person|Authorization/);
  assert.equal(h.posts.length, 0);
});

for (const badId of ['', '../other', 'not-an-id', 123]) {
  test(`invalid configured account ID (${typeof badId}, ${String(badId)}) fails without an account lookup or POST`, async () => {
    const h = harness({ overrides: { ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_ID: badId } });
    await assert.rejects(h.client.createBill(createInput()), { code: 'BILL_ACCOUNT_CONFIG_INVALID' });
    assert.equal(h.accountReads().length, 0);
    assert.equal(h.posts.length, 0);
  });
}

test('Switchgear without an explicit mapping keeps its payload and does not read accounts', async () => {
  const h = harness();
  const bill = validBill();
  bill.line_items[0].account_id = CONTRACTING_ACCOUNT;
  await h.client.prepareBill(bill, {}, { organizationId: SWITCHGEAR });
  await h.client.createBill(createInput(bill, SWITCHGEAR));
  assert.equal(h.accountReads().length, 0);
  assert.equal(h.posts[0].organizationId, SWITCHGEAR);
  assert.ok(h.posts[0].payload.line_items.every(item => !Object.hasOwn(item, 'account_id')));
});

test('Switchgear uses only its own explicit, verified mapping', async () => {
  const h = harness({ overrides: { ZOHO_BOOKS_SWITCHGEAR_DEFAULT_ACCOUNT_ID: SWITCHGEAR_ACCOUNT,
    ZOHO_BOOKS_SWITCHGEAR_DEFAULT_ACCOUNT_NAME: 'Approved Switchgear Expense' } });
  await h.client.createBill(createInput(validBill(), SWITCHGEAR));
  assert.deepEqual(h.accountReads(), [{ endpoint: `/chartofaccounts/${SWITCHGEAR_ACCOUNT}`, organizationId: SWITCHGEAR }]);
  assert.equal(h.posts[0].payload.line_items[0].account_id, SWITCHGEAR_ACCOUNT);
});

test('copying Contracting account configuration into Switchgear fails organization-scoped verification', async () => {
  const h = harness({ overrides: { ZOHO_BOOKS_SWITCHGEAR_DEFAULT_ACCOUNT_ID: CONTRACTING_ACCOUNT } });
  await assert.rejects(h.client.createBill(createInput(validBill(), SWITCHGEAR)), { code: 'BILL_ACCOUNT_NOT_FOUND' });
  assert.deepEqual(h.accountReads(), [{ endpoint: `/chartofaccounts/${CONTRACTING_ACCOUNT}`, organizationId: SWITCHGEAR }]);
  assert.equal(h.posts.length, 0);
});

test('an explicitly configured ID is verified even without the optional account-name cross-check', async () => {
  const h = harness({ overrides: { ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_NAME: '' } });
  await h.client.createBill(createInput());
  assert.equal(h.accountReads().length, 1);
  assert.equal(h.posts[0].payload.line_items[0].account_id, CONTRACTING_ACCOUNT);
});

test('configured accounting applies only to priced lines while preserving unpriced source rows in the draft', async () => {
  const h = harness();
  const bill = validBill();
  bill.line_items.push({ name: 'Unpriced source description', quantity: null, rate: null, amount: null, tax_percentage: 5 });
  const f = fixture({ bill, zohoOverrides: { prepareBill: h.client.prepareBill, createBill: h.client.createBill } });
  const initial = await f.send('Synthetic invoice');
  assert.equal(initial.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal((await f.send('SAVE')).state, 'COMPLETED');
  assert.equal(h.posts[0].payload.line_items.length, 1);
  assert.equal(h.posts[0].payload.line_items[0].account_id, CONTRACTING_ACCOUNT);
  assert.deepEqual((await f.billStore.getBill(initial.billId)).line_items[1], bill.line_items[1]);
});

test('a foreign organization never receives the Contracting account', async () => {
  const h = harness();
  await h.client.createBill(createInput(validBill(), 'fixture-unrelated-org'));
  assert.equal(h.accountReads().length, 0);
  assert.equal(h.posts[0].payload.line_items[0].account_id, undefined);
});

test('duplicate configured organization IDs fail safely rather than selecting the first mapping', async () => {
  const h = harness({ overrides: { ZOHO_BOOKS_SWITCHGEAR_ORG_ID: CONTRACTING } });
  await assert.rejects(h.client.createBill(createInput()), { code: 'BILL_ACCOUNT_ORGANIZATION_AMBIGUOUS' });
  assert.equal(h.posts.length, 0);
});

test('preflight account verification cannot cross organizations on the same line-items array', async () => {
  const h = harness();
  const bill = validBill();
  await h.client.prepareBill(bill, {}, { organizationId: CONTRACTING });
  await h.client.createBill(createInput(bill, SWITCHGEAR));
  assert.equal(h.posts[0].payload.line_items[0].account_id, undefined);
  assert.equal(h.posts[0].organizationId, SWITCHGEAR);
});

test('verification is consumed once and subsequent saves recheck account activity', async () => {
  const accountChange = {};
  const h = harness({ accountChange });
  const bill = validBill();
  await h.client.prepareBill(bill, {}, { organizationId: CONTRACTING });
  await h.client.createBill(createInput(bill));
  assert.equal(h.accountReads().length, 1);
  accountChange.is_active = false;
  await assert.rejects(h.client.createBill(createInput(bill)), { code: 'BILL_ACCOUNT_INACTIVE' });
  assert.equal(h.accountReads().length, 2);
  assert.equal(h.posts.length, 1);
});

test('changing mapping after preflight does not reuse the old account verification', async () => {
  const h = harness();
  const bill = validBill();
  await h.client.prepareBill(bill, {}, { organizationId: CONTRACTING });
  h.env.ZOHO_BOOKS_CONTRACTING_DEFAULT_ACCOUNT_ID = '100000000000099';
  await assert.rejects(h.client.createBill(createInput(bill)), { code: 'BILL_ACCOUNT_NOT_FOUND' });
  assert.equal(h.posts.length, 0);
  assert.equal(h.accountReads().length, 2);
});

test('HTTP 400/13009 diagnostics and safe worker reply remain intact even with a configured account', async () => {
  const h = harness({ postFailure: Object.assign(Error('fixture-private-transport'), {
    response: { status: 400, data: { code: 13009, message: 'The account field cannot be empty' } },
  }) });
  const f = fixture({ zohoOverrides: { prepareBill: h.client.prepareBill, createBill: h.client.createBill } });
  await f.send('Synthetic invoice');
  const result = await f.send('SAVE');
  assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(result.replyText, 'Zoho rejected this bill. Please check the accounting fields and permissions.\nReply SAVE to retry, EDIT to correct, or DELETE.');
  assert.equal(h.posts[0].payload.line_items[0].account_id, CONTRACTING_ACCOUNT);
  assert.deepEqual(h.events, [{ event: 'zoho.books.bill_create_failed', httpStatus: 400, providerCode: 13009,
    providerMessage: 'The account field cannot be empty', operation: 'createBill', method: 'POST', endpoint: '/bills' }]);
});
