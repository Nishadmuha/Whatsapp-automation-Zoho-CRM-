'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');

const ORGANIZATION = 'fixture-books-org';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const vendor = (id, extra = {}) => ({ contact_id: id, contact_type: 'vendor', contact_name: `Supplier ${id}`,
  status: 'active', ...extra });
const reply = (contacts, hasMore = false) => ({ data: { code: 0, contacts, page_context: { has_more_page: hasMore } } });

function clientWith(get, post = null) {
  return createZohoBooksClient({
    env: {}, clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh',
    http: {
      get,
      async post(url, payload, options) {
        if (url.endsWith('/oauth/v2/token')) return { data: { access_token: 'fixture-access' } };
        assert.ok(post, 'Review lookups must not write to Zoho');
        return post(url, payload, options);
      },
    },
  });
}

function review(client, extra = {}) {
  return client.searchVendor({ name: 'Supplier', organizationId: ORGANIZATION, review: true, ...extra });
}

test('bill review reuses the complete organization vendor list and gives every reply independent copies', async () => {
  const requests = [];
  const client = clientWith(async (_url, { params }) => {
    requests.push(params.page);
    assert.equal(params.search_text, undefined);
    return reply([vendor(String(params.page), { contact_persons: [{ first_name: 'Original' }] })], params.page < 5);
  });
  const first = await review(client);
  first[0].raw.contact_persons[0].first_name = 'Changed';
  first[0].name = 'Changed supplier';
  first.pop();
  const second = await review(client, { name: 'Another supplier' });
  assert.deepEqual(requests, [1, 2, 3, 4, 5]);
  assert.deepEqual(second.map(contact => contact.id), ['1', '2', '3', '4', '5']);
  assert.equal(second[0].name, 'Supplier 1');
  assert.equal(second[0].raw.contact_persons[0].first_name, 'Original');
});

test('completed review cache is opt-in and never reused for customers or other organizations', async () => {
  const requests = [];
  const client = clientWith(async (_url, { params }) => {
    requests.push([params.organization_id, params.contact_type]);
    return reply([vendor(String(requests.length), { contact_type: params.contact_type })]);
  });
  assert.equal((await review(client))[0].id, '1');
  assert.equal((await client.searchVendor({ name: 'Supplier', organizationId: ORGANIZATION }))[0].id, '2');
  assert.equal((await client.searchVendor({ name: 'Supplier', organizationId: ORGANIZATION }))[0].id, '3');
  assert.equal((await review(client, { organizationId: 'other-org' }))[0].id, '4');
  assert.equal((await client.searchCustomer({ organizationId: ORGANIZATION }))[0].id, '5');
  assert.equal((await client.searchCustomer({ organizationId: ORGANIZATION }))[0].id, '6');
  assert.equal((await review(client))[0].id, '1');
  assert.equal(requests.length, 6);
});

test('review vendor cache expires 60 seconds after the complete lookup finishes', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  let finishFirst;
  const client = clientWith(async () => {
    calls += 1;
    if (calls === 1) return new Promise(resolve => { finishFirst = () => resolve(reply([vendor('first')])); });
    return reply([vendor('current')]);
  });
  const pending = review(client);
  await nextTurn();
  now += 20000;
  finishFirst();
  assert.equal((await pending)[0].id, 'first');
  now += 59999;
  assert.equal((await review(client))[0].id, 'first');
  assert.equal(calls, 1);
  now += 1;
  assert.equal((await review(client))[0].id, 'current');
  assert.equal(calls, 2);
});

test('a review caller joining an ordinary in-flight scan can cache its complete result', async () => {
  let calls = 0;
  let finish;
  const client = clientWith(async () => {
    calls += 1;
    return new Promise(resolve => { finish = () => resolve(reply([vendor('shared')])); });
  });
  const ordinary = client.searchVendor({ name: 'Supplier', organizationId: ORGANIZATION });
  await nextTurn();
  const reviewing = review(client);
  finish();
  const [first, second] = await Promise.all([ordinary, reviewing]);
  first[0].name = 'Edited';
  assert.equal(second[0].name, 'Supplier shared');
  assert.equal((await review(client))[0].name, 'Supplier shared');
  assert.equal(calls, 1);
});

test('SAVE fresh lookup bypasses both completed review cache and a concurrent ordinary scan', async () => {
  let calls = 0;
  let finishOrdinary;
  const client = clientWith(async () => {
    calls += 1;
    if (calls === 2) return new Promise(resolve => { finishOrdinary = () => resolve(reply([vendor('ordinary')])); });
    return reply([vendor(calls === 1 ? 'reviewed' : 'fresh', { status: calls === 1 ? 'active' : 'inactive' })]);
  });
  await review(client);
  const ordinary = client.searchVendor({ name: 'Supplier', organizationId: ORGANIZATION });
  await nextTurn();
  const fresh = await review(client, { fresh: true });
  assert.equal(fresh[0].id, 'fresh');
  assert.equal(fresh[0].status, 'inactive');
  assert.equal(calls, 3);
  finishOrdinary();
  assert.equal((await ordinary)[0].id, 'ordinary');
  assert.equal((await review(client))[0].id, 'reviewed');
});

test('failed required vendor pages never cache a partial review result and the next reply retries', async () => {
  let fail = true;
  const pages = [];
  const client = clientWith(async (_url, { params }) => {
    pages.push(params.page);
    if (fail && params.page === 4) throw new Error('Required vendor page failed');
    return reply([vendor(String(params.page))], params.page < 5);
  });
  await assert.rejects(review(client), /Required vendor page failed/);
  fail = false;
  assert.equal((await review(client)).length, 5);
  assert.equal((await review(client)).length, 5);
  assert.deepEqual(pages, [1, 2, 3, 4, 5, 1, 2, 3, 4, 5]);
});

test('vendor creation invalidates completed review results at the start and completion of the write', async () => {
  let calls = 0;
  let created = false;
  let finishCreate;
  const client = clientWith(async () => {
    calls += 1;
    return reply([vendor(created ? 'new' : 'old')]);
  }, async url => {
    assert.ok(url.endsWith('/contacts'));
    return new Promise(resolve => { finishCreate = () => {
      created = true;
      resolve({ data: { code: 0, contact: vendor('new') } });
    }; });
  });
  await review(client);
  const creating = client.createVendor({ name: 'Supplier new', organizationId: ORGANIZATION });
  await nextTurn();
  assert.equal((await review(client))[0].id, 'old');
  assert.equal(calls, 2, 'Creation start must invalidate the previously completed scan');
  finishCreate();
  await creating;
  assert.equal((await review(client))[0].id, 'new');
  assert.equal((await review(client))[0].id, 'new');
  assert.equal(calls, 3, 'Creation completion must invalidate a scan completed during the POST');
});

for (const failure of [false, true]) {
  test(`older review scans cannot restore cached vendors after ${failure ? 'uncertain' : 'successful'} creation`, async () => {
    const reads = [];
    let finishCreate;
    let newSnapshot = false;
    const client = clientWith(async () => {
      const snapshot = newSnapshot ? 'new' : 'old';
      return new Promise(resolve => reads.push(() => resolve(reply([vendor(snapshot)]))));
    }, async () => new Promise((resolve, reject) => { finishCreate = () => {
      newSnapshot = true;
      if (failure) reject(new Error('Vendor write timed out'));
      else resolve({ data: { code: 0, contact: vendor('new') } });
    }; }));
    const before = review(client);
    await nextTurn();
    const creation = client.createVendor({ name: 'Supplier', organizationId: ORGANIZATION });
    const creationResult = failure ? assert.rejects(creation, /Vendor write timed out/) : creation;
    await nextTurn();
    const during = review(client);
    await nextTurn();
    finishCreate();
    await creationResult;
    const after = review(client);
    await nextTurn();
    assert.equal(reads.length, 3);
    reads[2]();
    assert.equal((await after)[0].id, 'new');
    reads[0]();
    reads[1]();
    assert.equal((await before)[0].id, 'old');
    assert.equal((await during)[0].id, 'old');
    assert.equal((await review(client))[0].id, 'new');
    assert.equal(reads.length, 3, 'Old scans must neither overwrite nor delete the newer cached scan');
  });
}

test('review cache bounds completed lists to 50 organizations', async () => {
  let calls = 0;
  const client = clientWith(async (_url, { params }) => {
    calls += 1;
    return reply([vendor(params.organization_id)]);
  });
  for (let index = 0; index < 51; index += 1) await review(client, { organizationId: `org-${index}` });
  await review(client, { organizationId: 'org-50' });
  assert.equal(calls, 51);
  await review(client, { organizationId: 'org-0' });
  assert.equal(calls, 52, 'The oldest completed organization list must be evicted');
});

test('vendor lookup includes Zoho VAT and tax registration metadata without losing raw fields', async () => {
  const client = clientWith(async () => reply([
    vendor('vat', { vat_reg_no: '100000000000001', tax_treatment: 'vat_registered' }),
    vendor('tax', { tax_reg_no: '100000000000002' }),
    vendor('existing', { tax_registration_number: '100000000000003', vat_reg_no: 'other' }),
  ]));
  const vendors = await review(client);
  assert.deepEqual(vendors.map(value => value.trn), ['100000000000001', '100000000000002', '100000000000003']);
  assert.equal(vendors[0].raw.vat_reg_no, '100000000000001');
  assert.equal(vendors[0].raw.tax_treatment, 'vat_registered');
});
