'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { limitOrganizationRequests } = require('../src/services/books/organizationRequestLimit');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const options = organization => ({ params: { organization_id: organization } });

test('organization budget limits overlapping reads and writes, preserves FIFO, and releases rejected requests', async () => {
  const started = [], release = new Map();
  let active = 0, peak = 0;
  const transport = Object.fromEntries(['get', 'post', 'put'].map(method => [method, async url => {
    active++;
    peak = Math.max(peak, active);
    started.push(url);
    try {
      await new Promise(resolve => release.set(url, resolve));
      if (url === '1') throw Error('fixture rejected');
      return url;
    } finally { active--; }
  }]));
  const http = limitOrganizationRequests(transport);
  const requests = Array.from({ length: 9 }, (_, index) => {
    const method = ['get', 'post', 'put'][index % 3];
    return method === 'get' ? http.get(String(index), options('org')) : http[method](String(index), {}, options('org'));
  });
  const settled = Promise.allSettled(requests);
  assert.deepEqual(started, ['0', '1', '2', '3', '4']);
  for (let index = 0; index < 9; index++) {
    release.get(String(index))();
    await nextTurn();
  }
  const results = await settled;
  assert.deepEqual(started, Array.from({ length: 9 }, (_, index) => String(index)));
  assert.equal(peak, 5);
  assert.equal(active, 0);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 8);
  const later = http.get('later', options('org'));
  assert.equal(started.at(-1), 'later');
  release.get('later')();
  assert.equal(await later, 'later');
});

test('a busy organization does not block another organization or OAuth refresh', async () => {
  const release = [];
  const http = limitOrganizationRequests({
    async get(_url, requestOptions) {
      if (requestOptions.params.organization_id === 'busy') await new Promise(resolve => release.push(resolve));
      return requestOptions.params.organization_id;
    },
    async post() { return 'token'; },
  });
  const busy = Array.from({ length: 6 }, () => http.get('/contacts', options('busy')));
  assert.equal(await http.get('/contacts', options('other')), 'other');
  assert.equal(await http.post('/oauth/v2/token', {}, {}), 'token');
  while (release.length) { release.shift()(); await nextTurn(); }
  assert.equal((await Promise.all(busy)).length, 6);
});

test('real Books client bounds combined customer/vendor pages while retaining all contacts', async () => {
  let active = 0, peak = 0;
  const client = createZohoBooksClient({ env: {}, clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh',
    http: {
      async post(url) {
        assert.ok(url.endsWith('/oauth/v2/token'));
        return { data: { access_token: 'fixture-access' } };
      },
      async get(_url, { params }) {
        active++;
        peak = Math.max(peak, active);
        await nextTurn();
        active--;
        return { data: { code: 0, contacts: [{ contact_id: `${params.contact_type}-${params.page}`, contact_name: `Contact ${params.page}`, contact_type: params.contact_type }], page_context: { has_more_page: params.page < 8 } } };
      },
    } });
  const [vendors, customers] = await Promise.all([
    client.searchVendor({ name: 'Contact', organizationId: 'org', fresh: true }),
    client.searchCustomer({ organizationId: 'org' }),
  ]);
  assert.equal(vendors.length, 8);
  assert.equal(customers.length, 8);
  assert.equal(peak, 5);
  assert.equal(active, 0);
});
