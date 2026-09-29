'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createZohoBooksClient } = require('../src/services/books/zohoBooksClient');

const CONTRACTING = '828765858';
const SWITCHGEAR = '802911060';
const METHODS = ['Cash', 'Bank Transfer', 'Credit Card'];

function account(id, type, organizationId) {
  return { account_id: id, account_name: `${type} ${id}`, account_type: type,
    is_active: true, organization_id: organizationId };
}

function clientWithLookup(get) {
  return createZohoBooksClient({
    env: {}, clientId: 'fixture-client', clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh',
    http: {
      get,
      async post(url) {
        assert.ok(url.endsWith('/oauth/v2/token'), 'Lookup tests must not submit a financial write');
        return { data: { access_token: 'fixture-access', scope: 'ZohoBooks.fullaccess.all' } };
      },
    },
  });
}

test('parallel payment-method choices read each account page once instead of three times', async () => {
  const pages = [];
  const client = clientWithLookup(async (url, { params }) => {
    assert.ok(url.endsWith('/chartofaccounts'));
    assert.equal(params.organization_id, CONTRACTING);
    assert.equal(params.per_page, 200);
    assert.equal(params.filter_by, 'AccountType.Active');
    pages.push(params.page);
    return { data: { code: 0,
      chartofaccounts: params.page === 1
        ? [account('101', 'cash', CONTRACTING), account('102', 'bank', CONTRACTING)]
        : [account('103', 'credit_card', CONTRACTING)],
      page_context: { has_more_page: params.page === 1 } } };
  });

  const choices = await Promise.all(METHODS.map(paymentType => client.listPaymentAccounts({ paymentType, organizationId: CONTRACTING })));
  assert.deepEqual(pages, [1, 2], 'The three choices need two requests, not six');
  assert.deepEqual(choices.map(list => list.map(value => value.id)), [['101'], ['102'], ['103']]);
});

test('simultaneous account lookups never share results between organizations', async () => {
  const calls = [];
  const client = clientWithLookup(async (_url, { params }) => {
    calls.push(params.organization_id);
    return { data: { code: 0, chartofaccounts: [
      account(params.organization_id === CONTRACTING ? '201' : '202', 'cash', params.organization_id),
    ] } };
  });
  const lists = await Promise.all([CONTRACTING, SWITCHGEAR].flatMap(organizationId =>
    ['Cash', 'Bank Transfer'].map(paymentType => client.listPaymentAccounts({ paymentType, organizationId }))));

  assert.deepEqual(calls.sort(), [CONTRACTING, SWITCHGEAR].sort());
  assert.deepEqual(lists.map(list => list.map(value => [value.id, value.organizationId])), [
    [['201', CONTRACTING]], [], [['202', SWITCHGEAR]], [],
  ]);
});

test('completed account lookups are not cached and later choices see account changes', async () => {
  let available = account('301', 'cash', CONTRACTING);
  let calls = 0;
  const client = clientWithLookup(async () => {
    calls += 1;
    return { data: { code: 0, chartofaccounts: [structuredClone(available)] } };
  });
  const first = await client.listPaymentAccounts({ paymentType: 'Cash', organizationId: CONTRACTING });
  available = account('302', 'cash', CONTRACTING);
  const second = await client.listPaymentAccounts({ paymentType: 'Cash', organizationId: CONTRACTING });

  assert.equal(calls, 2);
  assert.deepEqual(first.map(value => value.id), ['301']);
  assert.deepEqual(second.map(value => value.id), ['302']);
});

test('a failed shared lookup is released so the next worker reply can retry', async () => {
  let fail = true;
  let calls = 0;
  const client = clientWithLookup(async () => {
    calls += 1;
    return { data: { code: 0, chartofaccounts: fail ? null : [account('401', 'cash', CONTRACTING)] } };
  });
  const failed = await Promise.allSettled(METHODS.map(paymentType => client.listPaymentAccounts({ paymentType, organizationId: CONTRACTING })));
  assert.equal(calls, 1);
  assert.ok(failed.every(result => result.status === 'rejected' && result.reason.code === 'PAYMENT_ACCOUNT_LOOKUP_FAILED'));
  fail = false;
  assert.deepEqual((await client.listPaymentAccounts({ paymentType: 'Cash', organizationId: CONTRACTING })).map(value => value.id), ['401']);
  assert.equal(calls, 2);
});

test('payment preflight freshly rejects an account deactivated after the choices were shown', async () => {
  const paths = [];
  const selected = account('501', 'cash', CONTRACTING);
  const client = clientWithLookup(async (url, { params }) => {
    assert.equal(params.organization_id, CONTRACTING);
    paths.push(new URL(url).pathname);
    return { data: { code: 0, ...(url.endsWith('/501')
      ? { chart_of_account: { ...selected, is_active: false } }
      : { chartofaccounts: [selected] }) } };
  });
  await Promise.all(METHODS.map(paymentType => client.listPaymentAccounts({ paymentType, organizationId: CONTRACTING })));
  await assert.rejects(client.prepareBillPayment({ paymentType: 'Cash', organizationId: CONTRACTING, paymentAccountId: selected.account_id }),
    { code: 'PAYMENT_ACCOUNT_INVALID' });
  assert.deepEqual(paths, ['/books/v3/chartofaccounts', '/books/v3/chartofaccounts/501']);
});
