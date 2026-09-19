'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CRM_SCOPES, BOOKS_SCOPES, scopeReport } = require('../src/services/zoho/oauthScopes');
const { verifyZohoScopes } = require('../scripts/verify-zoho-scopes');

const env = {
  ZOHO_CLIENT_ID: 'fixture-crm-client', ZOHO_CLIENT_SECRET: 'fixture-crm-secret', ZOHO_REFRESH_TOKEN: 'fixture-crm-refresh',
  ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.com', ZOHO_API_BASE_URL: 'https://www.zohoapis.com/crm/v8',
  ZOHO_BOOKS_CLIENT_ID: 'fixture-books-client', ZOHO_BOOKS_CLIENT_SECRET: 'fixture-books-secret', ZOHO_BOOKS_REFRESH_TOKEN: 'fixture-books-refresh',
  ZOHO_BOOKS_ORGANIZATION_ID: 'fixture-org',
};
function transport({ scopes = true } = {}) {
  const calls = [];
  return { calls, async request(options) {
    calls.push(options);
    if (options.method === 'POST') {
      assert.equal(options.url, 'https://accounts.zoho.com/oauth/v2/token');
      const form = new URLSearchParams(options.data);
      assert.equal(form.get('grant_type'), 'refresh_token');
      const crm = form.get('client_id') === env.ZOHO_CLIENT_ID;
      return { status: 200, data: { access_token: 'fixture-access-do-not-print', expires_in: 3600,
        ...(scopes ? { scope: (crm ? CRM_SCOPES : BOOKS_SCOPES).join(' ') } : {}) } };
    }
    assert.equal(options.method, 'GET', 'Read-only verification cannot mutate a record');
    assert.equal(options.maxRedirects, 0);
    const pathname = new URL(options.url).pathname;
    if (pathname.endsWith('/Leads/search')) return { status: 204 };
    if (pathname.endsWith('/Leads')) return { status: 200, data: { data: [{ id: '123' }] } };
    if (pathname.endsWith('/123/Attachments')) return { status: 204 };
    if (pathname.endsWith('/contacts')) {
      assert.equal(options.params.contact_type, 'customer');
      return { status: 200, data: { code: 0, contacts: [
        { contact_id: 'c1', contact_name: 'Private fixture customer', phone: '+971501112233', email: 'fixture@example.invalid' },
        { contact_id: 'c2', contact_name: 'Phone only', phone: '+971501112234' },
        { contact_id: 'c3', contact_name: 'Email only', email: 'other@example.invalid' },
      ] } };
    }
    assert.ok(['/books/v3/bills', '/books/v3/settings/currencies', '/books/v3/settings/taxes'].includes(pathname));
    return { status: 200, data: { code: 0 } };
  } };
}

test('minimal scope sets cover existing endpoints, without accounts or broad write grants', () => {
  assert.deepEqual(CRM_SCOPES, ['ZohoCRM.modules.leads.READ', 'ZohoCRM.modules.leads.CREATE', 'ZohoCRM.modules.leads.UPDATE', 'ZohoCRM.modules.attachments.READ', 'ZohoCRM.modules.attachments.CREATE', 'ZohoSearch.securesearch.READ']);
  assert.deepEqual(BOOKS_SCOPES, ['ZohoBooks.contacts.READ', 'ZohoBooks.bills.READ', 'ZohoBooks.bills.CREATE', 'ZohoBooks.settings.READ']);
});
test('scope coverage is operation-specific, not a substring permission check', () => {
  const report = scopeReport('ZohoCRM.modules.leads.READ,ZohoCRM.modules.attachments.READ', CRM_SCOPES);
  assert.ok(report.missing.includes('ZohoCRM.modules.attachments.CREATE'));
  assert.ok(report.missing.includes('ZohoCRM.modules.leads.CREATE'));
  assert.ok(report.missing.includes('ZohoCRM.modules.leads.UPDATE'));
});
test('broad grants cover their own service but are flagged for least-privilege reauthorization', () => {
  const crm = scopeReport('ZohoCRM.modules.ALL', CRM_SCOPES);
  assert.deepEqual(crm.excess, ['ZohoCRM.modules.ALL']);
  assert.deepEqual(crm.missing, ['ZohoSearch.securesearch.READ']);
  assert.deepEqual(scopeReport('ZohoBooks.fullaccess.all', BOOKS_SCOPES).missing, []);
  assert.deepEqual(scopeReport(BOOKS_SCOPES.join(',') + ',ZohoBooks.bills.UPDATE', BOOKS_SCOPES).excess, ['ZohoBooks.bills.UPDATE']);
});
test('absent or malformed OAuth scope metadata is unknown, never an invented PASS', () => {
  for (const raw of [undefined, '', 'fixture-secret-token', ['ZohoCRM.modules.ALL']]) {
    const report = scopeReport(raw, CRM_SCOPES);
    assert.equal(report.metadataAvailable, false); assert.equal(report.missing, null);
    assert.deepEqual(report.granted, []);
  }
});
test('read-only audit uses existing CRM/Books integrations and returns no credentials or contact values', async () => {
  const http = transport();
  const original = { ...env };
  const report = await verifyZohoScopes({ env, http });
  assert.deepEqual(env, original);
  for (const service of ['crm', 'books']) {
    assert.deepEqual(report[service].scopes.missing, []);
    assert.deepEqual(report[service].scopes.excess, []);
    assert.equal(report[service].writesTested, false);
    assert.ok(Object.values(report[service].checks).every(check => check.status === 'PASS'));
  }
  assert.deepEqual(report.books.checks.customers, { status: 'PASS', recordsReturned: 3, withIdAndName: 3, withPhone: 2, withEmail: 2 });
  const output = JSON.stringify(report);
  for (const secret of [...Object.values(env).filter(value => value.startsWith('fixture-')), 'fixture-access-do-not-print', 'Private fixture customer', 'fixture@example.invalid']) assert.ok(!output.includes(secret));
  assert.ok(http.calls.every(call => !/chartofaccounts|organizations/.test(call.url)));
});
test('successful read checks do not prove undisclosed write scopes', async () => {
  const report = await verifyZohoScopes({ env, http: transport({ scopes: false }) });
  assert.equal(report.crm.checks.leadSearch.status, 'PASS');
  assert.equal(report.crm.scopes.metadataAvailable, false);
  assert.equal(report.crm.scopes.missing, null);
  assert.equal(report.crm.writesTested, false);
});
test('diagnostics reject untrusted destinations before sending any credential', async () => {
  for (const override of [{ ZOHO_ACCOUNTS_URL: 'http://accounts.zoho.com' }, { ZOHO_BOOKS_BASE_URL: 'https://untrusted.example/books/v3' }]) {
    const service = Object.keys(override)[0].startsWith('ZOHO_BOOKS_') ? 'books' : 'crm';
    const http = transport();
    const result = await verifyZohoScopes({ env: { ...env, ...override }, http, services: [service] });
    assert.equal(result[service].checks.authentication.code, 'INVALID_ZOHO_URL');
    assert.equal(http.calls.length, 0);
  }
});
test('diagnostics report missing configuration without attempting code exchange or network', async () => {
  const http = transport();
  const report = await verifyZohoScopes({ env: { ZOHO_AUTHORIZATION_CODE: 'do-not-consume', ZOHO_BOOKS_AUTHORIZATION_CODE: 'do-not-consume' }, http });
  assert.ok(report.crm.missingConfig.includes('ZOHO_REFRESH_TOKEN'));
  assert.ok(report.books.missingConfig.includes('ZOHO_BOOKS_REFRESH_TOKEN'));
  assert.equal(http.calls.length, 0);
});
test('diagnostic failures never echo raw OAuth errors or secrets', async () => {
  const report = await verifyZohoScopes({ env, http: { async request() { throw Error('fixture-crm-secret fixture-books-refresh'); } } });
  assert.equal(report.crm.checks.authentication.status, 'FAIL');
  assert.equal(report.books.checks.authentication.status, 'FAIL');
  assert.doesNotMatch(JSON.stringify(report), /fixture-crm-secret|fixture-books-refresh/);
});
test('shared dashboard redactor removes Books credentials and pending OAuth codes', () => {
  const { outputRedactor } = require('../src/routes/leads');
  const secrets = {
    ZOHO_BOOKS_CLIENT_ID: 'synthetic-books-client', ZOHO_BOOKS_CLIENT_SECRET: 'synthetic-books-secret',
    ZOHO_BOOKS_REFRESH_TOKEN: 'synthetic-books-refresh', ZOHO_BOOKS_ACCESS_TOKEN: 'synthetic-books-access',
    ZOHO_BOOKS_AUTHORIZATION_CODE: 'synthetic-books-code', ZOHO_AUTHORIZATION_CODE: 'synthetic-crm-code',
    ZOHO_AUTH_CODE: 'synthetic-legacy-code', BOOKS_PASSWORD: 'synthetic-books-password',
  };
  const source = { nested: Object.values(secrets).map(value => 'Error: ' + value) };
  const output = outputRedactor({}, secrets)(source);
  assert.ok(output.nested.every(value => value === 'Error: [REDACTED]'));
  assert.ok(source.nested[0].includes(secrets.ZOHO_BOOKS_CLIENT_ID), 'do not mutate stored source data');
});
test('legacy CLI entrypoints default to read-only verification, never implicit code exchange', async t => {
  const verification = require('../scripts/verify-zoho-scopes');
  const calls = [];
  t.mock.method(verification, 'printVerification', async services => { calls.push(services); });
  await require('../scripts/zoho-auth').run();
  await require('../scripts/testZohoBooksConnection').run();
  assert.deepEqual(calls, [['crm'], ['books']]);
});
