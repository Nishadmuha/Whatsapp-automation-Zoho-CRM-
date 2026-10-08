'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');

const ORGANIZATION = 'fixture-books-org';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function lookupClient(get, logger = null) {
  return createZohoBooksClient({
    env: {}, clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh',
    logger,
    http: {
      get,
      async post(url) {
        assert.ok(url.endsWith('/oauth/v2/token'), 'Contact lookups must not create financial or contact records');
        return { data: { access_token: 'fixture-access' } };
      },
    },
  });
}

function contact(id, extra = {}) {
  return { contact_id: id, contact_name: `Contact ${id}`, status: 'active', ...extra };
}

function pageReply(contacts, hasMore) {
  return { data: { code: 0, contacts, page_context: { has_more_page: hasMore } } };
}

test('7,336 customers retain all pages and order using 14 network rounds instead of 37', async () => {
  let active = 0;
  let peak = 0;
  let rounds = 0;
  const requested = [];
  const logged = [];
  const client = lookupClient(async (url, { params }) => {
    assert.ok(url.endsWith('/contacts'));
    assert.equal(params.organization_id, ORGANIZATION);
    assert.equal(params.contact_type, 'customer');
    assert.equal(params.per_page, 200);
    assert.equal(params.search_text, undefined);
    if (active === 0) rounds += 1;
    active += 1;
    peak = Math.max(peak, active);
    requested.push(params.page);
    await nextTurn();
    active -= 1;
    const start = (params.page - 1) * 200;
    return pageReply(Array.from({ length: Math.max(0, Math.min(200, 7336 - start)) }, (_, index) =>
      contact(String(start + index + 1), { contact_type: 'customer' })), params.page < 37);
  }, { debug(event) { logged.push(event.page); } });

  const customers = await client.searchCustomer({ organizationId: ORGANIZATION });

  assert.equal(rounds, 14);
  assert.equal(peak, 3);
  assert.equal(active, 0, 'All speculative reads must settle before another lookup starts');
  assert.deepEqual(requested, Array.from({ length: 38 }, (_, index) => index + 1));
  assert.deepEqual(logged, Array.from({ length: 37 }, (_, index) => index + 1));
  assert.deepEqual(customers.map(value => value.id), Array.from({ length: 7336 }, (_, index) => String(index + 1)));
});

test('parallel vendor pages preserve first duplicates, inactive contacts and organization validation inputs', async () => {
  const client = lookupClient(async (_url, { params }) => {
    assert.equal(params.organization_id, ORGANIZATION);
    assert.equal(params.contact_type, 'vendor');
    assert.equal(params.filter_by, 'Status.All');
    assert.equal(params.search_text, undefined);
    // Complete later pages first to ensure response arrival does not change
    // which duplicate record is authoritative or the displayed choice order.
    if (params.page === 3) { await nextTurn(); await nextTurn(); }
    if (params.page === 4) await nextTurn();
    const contacts = params.page === 3
      ? [contact('shared', { contact_name: 'Original', status: 'inactive', organization_id: ORGANIZATION })]
      : params.page === 4
        ? [contact('shared', { contact_name: 'Later duplicate', organization_id: 'other-org' }), contact('4')]
        : [contact(String(params.page))];
    return pageReply(contacts, params.page < 5);
  });

  const vendors = await client.searchVendor({ name: 'Original', organizationId: ORGANIZATION });

  assert.deepEqual(vendors.map(value => value.id), ['1', '2', 'shared', '4', '5']);
  assert.equal(vendors[2].name, 'Original');
  assert.equal(vendors[2].status, 'inactive');
  assert.equal(vendors[2].organizationId, ORGANIZATION);
});

test('customer search keeps provider criteria and local matching on every required page', async () => {
  const client = lookupClient(async (_url, { params }) => {
    assert.equal(params.search_text, 'needle');
    return pageReply([
      contact(`match-${params.page}`, { company_name: `Needle ${params.page}` }),
      contact(`other-${params.page}`),
    ], params.page < 5);
  });
  const customers = await client.searchCustomer({ searchText: ' needle ', organizationId: ORGANIZATION });
  assert.deepEqual(customers.map(value => value.id), ['match-1', 'match-2', 'match-3', 'match-4', 'match-5']);
});

test('malformed or failed speculative pages after the confirmed end do not change results', async () => {
  let active = 0;
  const requested = [];
  const client = lookupClient(async (_url, { params }) => {
    requested.push(params.page);
    active += 1;
    try {
      if (params.page === 4) return { data: { code: 0, contacts: null } };
      if (params.page === 5) {
        await nextTurn();
        throw new Error('Speculative request failed');
      }
      return pageReply([contact(String(params.page))], params.page < 3);
    } finally { active -= 1; }
  });
  const customers = await client.searchCustomer({ organizationId: ORGANIZATION });
  assert.deepEqual(customers.map(value => value.id), ['1', '2', '3']);
  assert.deepEqual(requested, [1, 2, 3, 4, 5]);
  assert.equal(active, 0);
});

test('a failed required page prevents partial success even when a later page reports the end', async () => {
  const calls = [];
  const client = lookupClient(async (_url, { params }) => {
    calls.push(params.page);
    if (params.page === 4) throw new Error('Required page failed');
    return pageReply([contact(String(params.page))], params.page !== 5);
  });
  await assert.rejects(client.searchVendor({ name: 'Missing', organizationId: ORGANIZATION }), /Required page failed/);
  assert.deepEqual(calls, [1, 2, 3, 4, 5]);
});

test('required-page errors are checked in page order before a later request rejection', async () => {
  const client = lookupClient(async (_url, { params }) => {
    if (params.page === 3) { await nextTurn(); return { data: { code: 0, contacts: null } }; }
    if (params.page === 4) throw new Error('Later page failure');
    return pageReply([contact(String(params.page))], true);
  });
  await assert.rejects(client.searchCustomer({ organizationId: ORGANIZATION }), /invalid customer list/);
});

test('an expired token on a required page restarts the full lookup without retaining partial records', async () => {
  let expired = true;
  let active = 0;
  const calls = [];
  const client = lookupClient(async (_url, { params }) => {
    if (params.page === 1) assert.equal(active, 0, 'Previous attempt must finish all reads before refreshing');
    active += 1;
    calls.push(params.page);
    try {
      await nextTurn();
      if (params.page === 4 && expired) {
        expired = false;
        const error = new Error('Expired token');
        error.response = { status: 401, data: { code: 57 } };
        throw error;
      }
      return pageReply([contact(String(params.page))], params.page < 5);
    } finally { active -= 1; }
  });
  const customers = await client.searchCustomer({ organizationId: ORGANIZATION });
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 1, 2, 3, 4, 5]);
  assert.deepEqual(customers.map(value => value.id), ['1', '2', '3', '4', '5']);
});

test('large customer lookups still fail closed at 100 pages with no request beyond the limit', async () => {
  const pages = [];
  const client = lookupClient(async (_url, { params }) => {
    pages.push(params.page);
    return pageReply([contact(String(params.page))], true);
  });
  await assert.rejects(client.searchCustomer({ organizationId: ORGANIZATION }), /customer lookup could not be completed safely/);
  assert.deepEqual(pages, Array.from({ length: 100 }, (_, index) => index + 1));
});

test('simultaneous customer lists share one traversal and receive independent contact copies', async () => {
  const pages = [];
  const client = lookupClient(async (_url, { params }) => {
    pages.push(params.page);
    await nextTurn();
    return pageReply([contact(String(params.page), {
      contact_persons: [{ first_name: 'Original' }],
    })], params.page < 5);
  });
  const [first, second, third] = await Promise.all(Array.from({ length: 3 }, () =>
    client.searchCustomer({ organizationId: ORGANIZATION })));

  assert.deepEqual(pages, [1, 2, 3, 4, 5]);
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  first[0].raw.contact_persons[0].first_name = 'Changed';
  first[0].name = 'Edited draft';
  first.pop();
  assert.equal(second.length, 5);
  assert.equal(second[0].raw.contact_persons[0].first_name, 'Original');
  assert.equal(third[0].name, 'Contact 1');
});

test('different vendor search names share the same complete organization scan', async () => {
  const pages = [];
  const client = lookupClient(async (_url, { params }) => {
    pages.push(params.page);
    assert.equal(params.search_text, undefined);
    await nextTurn();
    return pageReply([contact(String(params.page), { contact_type: 'vendor', status: 'inactive' })], params.page < 3);
  });
  const [first, second] = await Promise.all([
    client.searchVendor({ name: 'First supplier', organizationId: ORGANIZATION }),
    client.searchVendor({ name: 'Other supplier', organizationId: ORGANIZATION }),
  ]);
  assert.deepEqual(pages, [1, 2, 3, 4, 5]);
  assert.deepEqual(first.map(value => value.id), ['1', '2', '3']);
  assert.deepEqual(first, second);
  first[0].raw.status = 'active';
  assert.equal(second[0].raw.status, 'inactive');
});

test('in-flight contacts stay isolated by organization, contact type and customer search text', async () => {
  const queries = [];
  const client = lookupClient(async (_url, { params }) => {
    queries.push([params.organization_id, params.contact_type, params.search_text || '']);
    await nextTurn();
    return pageReply([contact(`${params.organization_id}-${params.contact_type}-${params.search_text || 'all'}`, {
      contact_name: params.search_text || 'Unfiltered', contact_type: params.contact_type,
    })], false);
  });
  const results = await Promise.all([
    client.searchCustomer({ organizationId: ORGANIZATION, searchText: 'First' }),
    client.searchCustomer({ organizationId: ORGANIZATION, searchText: 'Other' }),
    client.searchCustomer({ organizationId: 'other-org', searchText: 'First' }),
    client.searchCustomer({ organizationId: ORGANIZATION }),
    client.searchVendor({ organizationId: ORGANIZATION, name: 'First' }),
  ]);
  assert.equal(queries.length, 5);
  assert.deepEqual(results.map(list => list[0].id), [
    `${ORGANIZATION}-customer-First`, `${ORGANIZATION}-customer-Other`, 'other-org-customer-First',
    `${ORGANIZATION}-customer-all`, `${ORGANIZATION}-vendor-all`,
  ]);
});

test('a later contact lookup fetches current records instead of caching a completed result', async () => {
  let version = 1;
  let calls = 0;
  const client = lookupClient(async () => {
    calls += 1;
    return pageReply([contact(String(version))], false);
  });
  assert.equal((await client.searchCustomer({ organizationId: ORGANIZATION }))[0].id, '1');
  version = 2;
  assert.equal((await client.searchCustomer({ organizationId: ORGANIZATION }))[0].id, '2');
  assert.equal(calls, 2);
});

test('failed shared contact lookups release their slot and a later reply can retry', async () => {
  let fail = true;
  const pages = [];
  const client = lookupClient(async (_url, { params }) => {
    pages.push(params.page);
    await nextTurn();
    if (fail && params.page === 3) throw new Error('Lookup unavailable');
    return pageReply([contact(String(params.page))], params.page < 3);
  });
  const failed = await Promise.allSettled(Array.from({ length: 3 }, () =>
    client.searchCustomer({ organizationId: ORGANIZATION })));
  assert.ok(failed.every(result => result.status === 'rejected' && /Lookup unavailable/.test(result.reason.message)));
  assert.deepEqual(pages, [1, 2, 3, 4, 5]);
  fail = false;
  assert.deepEqual((await client.searchCustomer({ organizationId: ORGANIZATION })).map(value => value.id), ['1', '2', '3']);
  assert.deepEqual(pages, [1, 2, 3, 4, 5, 1, 2, 3, 4, 5]);
});

test('vendor creation invalidates scans at start and completion without old waiters clearing a new scan', async () => {
  const reads = [];
  let finishCreate;
  let created = false;
  const vendor = contact('new-vendor', { contact_type: 'vendor' });
  const client = createZohoBooksClient({
    env: {}, clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh',
    http: {
      get: async (_url, { params }) => {
        assert.equal(params.organization_id, ORGANIZATION);
        assert.equal(params.contact_type, 'vendor');
        const snapshot = created ? [vendor] : [];
        return new Promise(resolve => reads.push(() => resolve(pageReply(snapshot, false))));
      },
      post: async url => {
        if (url.endsWith('/oauth/v2/token')) return { data: { access_token: 'fixture-access' } };
        assert.ok(url.endsWith('/contacts'));
        return new Promise(resolve => { finishCreate = () => {
          created = true;
          resolve({ data: { code: 0, contact: vendor } });
        }; });
      },
    },
  });
  const search = () => client.searchVendor({ name: 'Supplier', organizationId: ORGANIZATION });
  const beforeCreate = search();
  await nextTurn();
  assert.equal(reads.length, 1);

  const creation = client.createVendor({ name: 'Supplier', organizationId: ORGANIZATION });
  await nextTurn();
  const duringCreate = search();
  await nextTurn();
  assert.equal(reads.length, 2, 'Creation start must detach the old scan');

  finishCreate();
  await creation;
  const afterCreate = search();
  await nextTurn();
  assert.equal(reads.length, 3, 'Creation completion must detach scans begun during the POST');

  reads[0]();
  reads[1]();
  assert.deepEqual(await beforeCreate, []);
  assert.deepEqual(await duringCreate, []);
  const anotherAfterCreate = search();
  await nextTurn();
  assert.equal(reads.length, 3, 'Old waiters must not delete the new pending scan');
  reads[2]();
  assert.equal((await afterCreate)[0].id, 'new-vendor');
  assert.equal((await anotherAfterCreate)[0].id, 'new-vendor');
});

test('uncertain vendor creation also releases a scan begun during the write', async () => {
  let rejectCreate;
  let finishRead;
  let calls = 0;
  const client = createZohoBooksClient({
    env: {}, clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh',
    http: {
      get: async () => {
        calls += 1;
        if (calls === 1) return new Promise(resolve => { finishRead = () => resolve(pageReply([], false)); });
        return pageReply([contact('possibly-created', { contact_type: 'vendor' })], false);
      },
      post: async url => {
        if (url.endsWith('/oauth/v2/token')) return { data: { access_token: 'fixture-access' } };
        return new Promise((_resolve, reject) => { rejectCreate = () => reject(new Error('Write timed out')); });
      },
    },
  });
  const creation = client.createVendor({ name: 'Supplier', organizationId: ORGANIZATION });
  const rejected = assert.rejects(creation, /Write timed out/);
  await nextTurn();
  const oldScan = client.searchVendor({ name: 'Supplier', organizationId: ORGANIZATION });
  await nextTurn();
  rejectCreate();
  await rejected;
  const current = await client.searchVendor({ name: 'Supplier', organizationId: ORGANIZATION });
  assert.equal(calls, 2);
  assert.equal(current[0].id, 'possibly-created');
  finishRead();
  assert.deepEqual(await oldScan, []);
});

test('fresh vendor rechecks bypass older shared scans without replacing or clearing them', async () => {
  let finishOldRead;
  let calls = 0;
  const client = lookupClient(async () => {
    calls += 1;
    if (calls === 1) return new Promise(resolve => {
      finishOldRead = () => resolve(pageReply([contact('older-snapshot', { contact_type: 'vendor' })], false));
    });
    return pageReply([contact('current-snapshot', { contact_type: 'vendor' })], false);
  });
  const oldScan = client.searchVendor({ name: 'Supplier', organizationId: ORGANIZATION });
  await nextTurn();
  const current = await client.searchVendor({ name: 'Supplier', organizationId: ORGANIZATION, fresh: true });
  assert.equal(calls, 2, 'SAVE must start its own lookup after acquiring the vendor lock');
  assert.equal(current[0].id, 'current-snapshot');

  const sameOldScan = client.searchVendor({ name: 'Other supplier', organizationId: ORGANIZATION });
  await nextTurn();
  assert.equal(calls, 2, 'The independent SAVE scan must not remove an unrelated shared scan');
  finishOldRead();
  assert.equal((await oldScan)[0].id, 'older-snapshot');
  assert.equal((await sameOldScan)[0].id, 'older-snapshot');
});
