'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspect } = require('node:util');
const { createZohoAuthService } = require('../src/services/zoho/zohoAuthService');
const {
  createZohoLeadService, parseFieldMapping, mapLeadToZoho, escapeCriteriaValue,
} = require('../src/services/zoho/zohoLeadService');
const { validateZohoUrl } = require('../src/services/zoho/zohoSupport');

function settings(extra = {}) {
  return {
    ZOHO_CLIENT_ID: 'test-client', ZOHO_CLIENT_SECRET: 'test-secret', ZOHO_REFRESH_TOKEN: 'test-refresh',
    ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.com', ZOHO_API_BASE_URL: 'https://www.zohoapis.com/crm/v8',
    ...extra,
  };
}

function mockHttp(steps) {
  const calls = [];
  return {
    calls,
    async request(config) {
      calls.push(config);
      assert.ok(steps.length, 'Unexpected external request');
      const next = steps.shift();
      if (typeof next === 'function') return next(config);
      return next;
    },
  };
}

function crm(http, env = settings(), other = {}) {
  return createZohoLeadService({
    env, http,
    auth: { async getAccessToken() { return 'test-access'; }, invalidate() {} },
    ...other,
  });
}

function lead(extra = {}) {
  return { name: 'Ahmed Ali', phone: '0501234567', company: 'ABC Contracting', service: 'AC maintenance', ...extra };
}

function writeSuccess(id = '12345') {
  return { status: 201, data: { data: [{ status: 'success', code: 'SUCCESS', details: { id } }] } };
}

test('Zoho OAuth refresh keeps credentials in a form body, verifies TLS, caches, coalesces, and refreshes early', async () => {
  let milliseconds = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const http = mockHttp([
    async () => { await gate; return { status: 200, data: { access_token: 'first-token', expires_in: 3600, api_domain: 'https://www.zohoapis.com' } }; },
    { status: 200, data: { access_token: 'second-token', expires_in: 3600 } },
    { status: 200, data: { access_token: 'third-token', expires_in: 3600 } },
  ]);
  const env = settings({ ZOHO_CLIENT_SECRET: 'test-secret&=+', ZOHO_TIMEOUT_MS: '2000' });
  const auth = createZohoAuthService({ env, http, now: () => milliseconds });
  const pending = [auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken({ forceRefresh: true })];
  assert.equal(http.calls.length, 1);
  release();
  assert.deepEqual(await Promise.all(pending), ['first-token', 'first-token', 'first-token']);
  const call = http.calls[0];
  assert.equal(call.url, 'https://accounts.zoho.com/oauth/v2/token');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(call.data)), {
    grant_type: 'refresh_token', client_id: env.ZOHO_CLIENT_ID, client_secret: env.ZOHO_CLIENT_SECRET,
    refresh_token: env.ZOHO_REFRESH_TOKEN,
  });
  assert.equal(call.timeout, 2000);
  assert.equal(call.maxRedirects, 0);
  assert.equal(call.httpsAgent.options.rejectUnauthorized, true);
  milliseconds = 3_539_000;
  assert.equal(await auth.getAccessToken(), 'first-token');
  milliseconds = 3_541_000;
  assert.equal(await auth.getAccessToken(), 'second-token');
  auth.invalidate('first-token');
  assert.equal(await auth.getAccessToken(), 'second-token');
  auth.invalidate('second-token');
  assert.equal(await auth.getAccessToken(), 'third-token');
  assert.equal(http.calls.length, 3);
});

test('Zoho OAuth does not cache failed refresh and forceRefresh replaces a valid token', async () => {
  const http = mockHttp([
    { status: 200, data: { error: 'invalid_code' } },
    { status: 200, data: { access_token: 'token-two', expires_in: 30 } },
    { status: 200, data: { access_token: 'token-three', expires_in: 30 } },
  ]);
  const auth = createZohoAuthService({ env: settings(), http });
  await assert.rejects(auth.getAccessToken(), { code: 'ZOHO_AUTH', providerCode: 'INVALID_CODE', uncertain: false });
  assert.equal(await auth.getAccessToken(), 'token-two');
  assert.equal(await auth.getAccessToken({ forceRefresh: true }), 'token-three');
});

test('Zoho official regional and sandbox endpoints are accepted; arbitrary destinations and URL components are rejected', () => {
  for (const [accounts, api] of [
    ['zoho.com', 'zohoapis.com'], ['zoho.in', 'zohoapis.in'], ['zoho.eu', 'zohoapis.eu'],
    ['zoho.com.au', 'zohoapis.com.au'], ['zoho.com.cn', 'zohoapis.com.cn'],
    ['zoho.jp', 'zohoapis.jp'], ['zoho.sa', 'zohoapis.sa'], ['zohocloud.ca', 'zohoapis.ca'],
  ]) {
    assert.equal(validateZohoUrl(`https://accounts.${accounts}/`, 'accounts'), `https://accounts.${accounts}`);
    for (const prefix of ['www', 'sandbox', 'developer']) {
      assert.equal(validateZohoUrl(`https://${prefix}.${api}/crm/v8/`, 'api'), `https://${prefix}.${api}/crm/v8`);
    }
  }
  for (const url of [
    'http://www.zohoapis.com/crm/v8', 'https://127.0.0.1/crm/v8',
    'https://www.zohoapis.com.evil.example/crm/v8', 'https://api.example/crm/v8',
    'https://www.zohoapis.com/crm/v8?token=1', 'https://www.zohoapis.com:444/crm/v8',
    'https://user:pass@www.zohoapis.com/crm/v8', 'https://www.zohoapis.com/crm/v8#x',
    'https://www.zohoapis.com/crm/v8/Leads', 'https://www.zohoapis.com/crm/v0',
  ]) assert.throws(() => validateZohoUrl(url, 'api'), { code: 'ZOHO_CONFIG' });
  assert.throws(() => validateZohoUrl('https://accounts.zoho.com/oauth/v2/token', 'accounts'), { code: 'ZOHO_CONFIG' });
});

test('Zoho OAuth validates credentials and response domain without logging sensitive provider errors', async () => {
  for (const invalid of [
    { ZOHO_CLIENT_ID: '' }, { ZOHO_CLIENT_SECRET: 'line\nbreak' }, { ZOHO_REFRESH_TOKEN: '' },
    { ZOHO_TIMEOUT_MS: '0' }, { ZOHO_TIMEOUT_MS: '60001' }, { ZOHO_TIMEOUT_MS: 'NaN' },
  ]) {
    await assert.rejects(createZohoAuthService({ env: settings(invalid), http: mockHttp([]) }).getAccessToken(), { code: 'ZOHO_CONFIG' });
  }
  for (const response of [
    { status: 200, data: { access_token: 'secret', expires_in: 3600, api_domain: 'https://www.zohoapis.eu' } },
    { status: 200, data: { access_token: 'secret', expires_in: 3600, api_domain: 'https://attacker.example' } },
    { status: 200, data: { access_token: 'secret', expires_in: 3600, api_domain: 'https://www.zohoapis.com?x=secret' } },
    { status: 200, data: { access_token: 'secret\nvalue', expires_in: 3600 } },
    { status: 200, data: { access_token: 'secret', expires_in: -1 } },
    { status: 503, data: { error: 'secret' } },
  ]) {
    const auth = createZohoAuthService({ env: settings(), http: mockHttp([response]) });
    await assert.rejects(auth.getAccessToken(), (error) => {
      assert.equal(inspect(error).includes('secret'), false);
      assert.ok(error.code.startsWith('ZOHO_'));
      return true;
    });
  }
});

test('Zoho OAuth supports account data centers without changing the configured API destination', async () => {
  const http = mockHttp([{ status: 200, data: { access_token: 'eu-token', expires_in: 3600, api_domain: 'https://sandbox.zohoapis.eu' } }]);
  const auth = createZohoAuthService({
    env: settings({ ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.eu', ZOHO_API_BASE_URL: 'https://sandbox.zohoapis.eu/crm/v8' }), http,
  });
  assert.equal(await auth.getAccessToken(), 'eu-token');
  assert.equal(http.calls[0].url, 'https://accounts.zoho.eu/oauth/v2/token');
});

test('Zoho phone search checks Phone/Mobile and exact normalized candidates, including later pages', async () => {
  const http = mockHttp([
    { status: 200, data: { data: [
      { id: '11', Phone: '+971501234568' }, { id: '12', Mobile: '050 123 4567' },
    ], info: { more_records: true } } },
    { status: 200, data: { data: [{ id: '12', Phone: '+971501234567' }], info: { more_records: false } } },
  ]);
  assert.equal((await crm(http).searchLeadByPhone('971501234567')).id, '12');
  const config = http.calls[0];
  assert.equal(config.url, 'https://www.zohoapis.com/crm/v8/Leads/search');
  assert.equal(config.method, 'GET');
  assert.equal(config.headers.Authorization, 'Zoho-oauthtoken test-access');
  assert.equal(config.maxRedirects, 0);
  assert.equal(config.httpsAgent.options.rejectUnauthorized, true);
  assert.match(config.params.criteria, /Phone:equals:\+971501234567/);
  assert.match(config.params.criteria, /Mobile:equals:501234567/);
  assert.equal(http.calls[1].params.page, 2);
});

test('Zoho exact-match search returns null for no content or unrelated approximate matches', async () => {
  const http = mockHttp([
    { status: 204 },
    { status: 200, data: { data: [{ id: '10', Phone: '+971501234568' }] } },
  ]);
  const service = crm(http);
  assert.equal(await service.searchLeadByPhone('+971501234567'), null);
  assert.equal(await service.searchLeadByPhone('+971501234567'), null);
});

test('Zoho international CRM national-format numbers are compared using the explicit target country', async () => {
  const http = mockHttp([{ status: 200, data: { data: [
    { id: '10', Phone: '020 7946 0958' }, { id: '11', Phone: '020 7946 0959' },
  ] } }]);
  assert.equal((await crm(http).searchLeadByPhone('+442079460958')).id, '10');
});

test('Zoho ambiguous and incomplete searches require review instead of choosing a record or creating a duplicate', async () => {
  const http = mockHttp([{ status: 200, data: { data: [
    { id: '1', Phone: '+971501234567' }, { id: '2', Mobile: '0501234567' },
  ] } }]);
  await assert.rejects(crm(http).searchLeadByPhone('+971501234567'), { code: 'ZOHO_AMBIGUOUS_MATCH', retryable: false });
  const incomplete = mockHttp(Array.from({ length: 10 }, () => ({ status: 200, data: { data: [], info: { more_records: true } } })));
  await assert.rejects(crm(incomplete).searchLeadByPhone('+971501234567'), { code: 'ZOHO_SEARCH_LIMIT' });
});

test('Zoho email fallback applies exact comparison even when punctuation search finds approximate matches', async () => {
  const http = mockHttp([{ status: 200, data: { data: [
    { id: '1', Email: 'sales_team@example.com' }, { id: '2', Email: 'Sales-Team@Example.COM' },
  ] } }]);
  assert.equal((await crm(http).searchLeadByEmail(' SALES-TEAM@example.com ')).id, '2');
  assert.equal(http.calls[0].params.criteria, '(Email:equals:sales-team@example.com)');
  const missing = mockHttp([{ status: 204 }]);
  assert.equal(await crm(missing).searchLeadByEmail('customer@example.com'), null);
});

test('Zoho mapping uses standard fields, preserves the original message, and skips null values', () => {
  const original = '  Ahmed Ali: +971501234567, AC maintenance.\nKeep original spacing.  ';
  const record = mapLeadToZoho(lead({ email: null, location: 'Dubai', notes: 'Urgent', requirement: 'Repair AC' }), original);
  assert.equal(record.Last_Name, 'Ali');
  assert.equal(record.First_Name, 'Ahmed');
  assert.equal(record.Phone, '+971501234567');
  assert.equal(record.City, 'Dubai');
  assert.equal(record.Lead_Source, 'WhatsApp');
  assert.equal(Object.hasOwn(record, 'Email'), false);
  assert.equal(Object.hasOwn(record, 'Service'), false);
  assert.ok(record.Description.includes(original));
  assert.match(record.Description, /Service: AC maintenance/);
  assert.match(record.Description, /Requirement: Repair AC/);
  assert.match(record.Description, /Notes: Urgent/);
  assert.equal(mapLeadToZoho(lead({ name: 'Ahmed' })).First_Name, undefined);
});

test('Zoho mapping supports explicit custom fields and full names with mandatory Last_Name', () => {
  const mapping = parseFieldMapping(JSON.stringify({ name: 'Customer_Name', service: 'Service_Required', originalMessage: 'WhatsApp_Message', phone: 'Customer_Phone' }));
  const record = mapLeadToZoho(lead(), 'Original', mapping);
  assert.equal(record.Customer_Name, 'Ahmed Ali');
  assert.equal(record.Last_Name, 'Ali');
  assert.equal(record.Service_Required, 'AC maintenance');
  assert.equal(record.WhatsApp_Message, 'Original WhatsApp message:\nOriginal\n\nService: AC maintenance');
  assert.equal(record.Customer_Phone, '+971501234567');
  assert.equal(record.Phone, undefined);
  const fullNameRecord = mapLeadToZoho(lead(), undefined, parseFieldMapping('{"name":"Last_Name"}'));
  assert.equal(fullNameRecord.Last_Name, 'Ahmed Ali');
  assert.equal(fullNameRecord.First_Name, undefined);
});

test('Zoho field API names, search criteria, record IDs, and inputs cannot inject URL or CRM syntax', async () => {
  for (const raw of [
    'not-json', '[]', 'null', '{"unknown":"Field"}', '{"phone":"Phone)or(Last_Name"}',
    '{"phone":"__proto__"}', '{"phone":"id"}', '{"phone":null}', '{"originalMessage":null}',
    '{"service":"Email"}', '{"__proto__":{"polluted":true}}',
  ]) assert.throws(() => parseFieldMapping(raw), { code: 'ZOHO_CONFIG' });
  assert.equal(escapeCriteriaValue('x,y(z)\\'), 'x\\,y\\(z\\)\\\\');
  const service = crm(mockHttp([]));
  await assert.rejects(service.searchLeadByPhone('+971501234567)or(Last_Name:equals:x'), { code: 'ZOHO_INPUT' });
  await assert.rejects(service.searchLeadByEmail('a@example.com)or(Email:equals:b'), { code: 'ZOHO_INPUT' });
  await assert.rejects(service.getLead('../users'), { code: 'ZOHO_INPUT' });
  await assert.rejects(service.createLead(lead({ name: null })), { code: 'ZOHO_INPUT' });
  await assert.rejects(service.createLead(lead({ phone: null })), { code: 'ZOHO_INPUT' });
  await assert.rejects(service.createLead(lead({ notes: { unexpected: true } })), { code: 'ZOHO_INPUT' });
});

test('Zoho create sends one real API insert contract and returns the provider ID', async () => {
  const http = mockHttp([writeSuccess()]);
  assert.deepEqual(await crm(http).createLead(lead(), 'Original text'), { id: '12345' });
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].method, 'POST');
  assert.equal(http.calls[0].url, 'https://www.zohoapis.com/crm/v8/Leads');
  assert.equal(http.calls[0].data.data.length, 1);
  assert.equal(http.calls[0].data.data[0].Lead_Source, 'WhatsApp');
});

test('Zoho update reads the existing record, appends history, uses optimistic concurrency, and omits missing fields', async () => {
  const modified = '2026-09-01T12:20:30+04:00';
  const http = mockHttp([
    { status: 200, data: { data: [{ id: '12345', Description: 'Existing CRM notes', Company: 'Keep Company', Email: 'keep@example.com', Modified_Time: modified }] } },
    writeSuccess(),
  ]);
  assert.deepEqual(await crm(http).updateLead('12345', lead({ company: null, email: null }), 'New original'), { id: '12345' });
  const put = http.calls[1];
  assert.equal(put.method, 'PUT');
  assert.equal(put.url, 'https://www.zohoapis.com/crm/v8/Leads/12345');
  assert.equal(put.headers['If-Unmodified-Since'], modified);
  assert.equal(put.data.data[0].id, '12345');
  assert.equal(put.data.data[0].Company, undefined);
  assert.equal(put.data.data[0].Email, undefined);
  assert.match(put.data.data[0].Description, /^Existing CRM notes\n\n--- WhatsApp update ---/);
  assert.match(put.data.data[0].Description, /New original/);
});

test('Zoho getLead and update stop safely on missing records or full description history', async () => {
  const http = mockHttp([
    { status: 204 },
    { status: 204 },
    { status: 200, data: { data: [{ id: '12345', Description: 'a'.repeat(32000) }] } },
  ]);
  const service = crm(http);
  assert.equal(await service.getLead('12345'), null);
  await assert.rejects(service.updateLead('12345', lead()), { code: 'ZOHO_NOT_FOUND' });
  await assert.rejects(service.updateLead('12345', lead(), 'New message'), { code: 'ZOHO_INPUT' });
  assert.ok(http.calls.every((call) => call.method === 'GET'));
});

test('Zoho repeating the same formatted message preserves description history without appending it again', async () => {
  const description = `Earlier notes\n\n--- WhatsApp update ---\n${mapLeadToZoho(lead(), 'Same original').Description}`;
  const http = mockHttp([
    { status: 200, data: { data: [{ id: '12345', Description: description }] } },
    writeSuccess(),
  ]);
  await crm(http).updateLead('12345', lead(), 'Same original');
  assert.equal(http.calls[1].data.data[0].Description, description);
});

test('Zoho write checks per-record errors even with HTTP 200 and does not fabricate success', async () => {
  for (const status of [200, 207, 400]) {
    const http = mockHttp([{ status, data: { data: [{ code: 'INVALID_DATA', status: 'error', message: 'sensitive upstream response' }] } }]);
    await assert.rejects(crm(http).createLead(lead()), (error) => {
      assert.equal(error.code, 'ZOHO_API');
      assert.equal(error.retryable, false);
      assert.equal(error.uncertain, false);
      assert.equal(inspect(error).includes('sensitive upstream response'), false);
      return true;
    });
    assert.equal(http.calls.length, 1);
  }
  for (const data of [{}, { data: [] }, { data: [{ code: 'SUCCESS', status: 'success', details: {} }] }]) {
    await assert.rejects(crm(mockHttp([{ status: 200, data }])).createLead(lead()), { code: 'ZOHO_RESPONSE', uncertain: true });
  }
});

test('Zoho mutation transport/server failures are uncertain and never automatically retried or leaked', async () => {
  for (const outcome of [
    () => { throw Object.assign(new Error('secret-auth private phone'), { config: { headers: { Authorization: 'secret-auth' } } }); },
    { status: 503, data: { code: 'INTERNAL_ERROR', message: 'secret-auth' } },
    { status: 200, data: { data: [{ status: 'error', code: 'INTERNAL_ERROR' }] } },
  ]) {
    const http = mockHttp([outcome]);
    await assert.rejects(crm(http).createLead(lead()), (error) => {
      assert.equal(error.uncertain, true);
      assert.equal(error.retryable, false);
      assert.equal(inspect(error).includes('secret-auth'), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(http.calls.length, 1);
  }
  const transientRead = crm(mockHttp([{ status: 503, data: { code: 'INTERNAL_ERROR' } }]));
  await assert.rejects(transientRead.getLead('12345'), { retryable: true, uncertain: false });
});

test('Zoho definite 401 rejection invalidates and refreshes authentication once before a safe replay', async () => {
  const env = settings();
  const http = mockHttp([
    { status: 200, data: { access_token: 'old-token', expires_in: 3600 } },
    { status: 401, data: { code: 'INVALID_TOKEN', status: 'error' } },
    { status: 200, data: { access_token: 'new-token', expires_in: 3600 } },
    writeSuccess(),
  ]);
  const service = createZohoLeadService({ env, http });
  assert.deepEqual(await service.createLead(lead()), { id: '12345' });
  assert.equal(http.calls[1].headers.Authorization, 'Zoho-oauthtoken old-token');
  assert.equal(http.calls[3].headers.Authorization, 'Zoho-oauthtoken new-token');
  assert.equal(http.calls.length, 4);
  let invalidations = 0;
  const denied = crm(mockHttp([
    { status: 401, data: { code: 'INVALID_TOKEN' } },
    { status: 401, data: { code: 'INVALID_TOKEN' } },
  ]), env, { auth: { async getAccessToken() { return 'token'; }, invalidate() { invalidations += 1; } } });
  await assert.rejects(denied.getLead('12345'), { code: 'ZOHO_API', httpStatus: 401 });
  assert.equal(invalidations, 1);
});

test('Zoho scope rejection does not trigger useless refresh, and logs contain operation metadata only', async () => {
  const logs = [];
  let invalidations = 0;
  const http = mockHttp([{ status: 401, data: { code: 'OAUTH_SCOPE_MISMATCH', message: 'private customer text' } }]);
  const service = crm(http, settings(), {
    auth: { async getAccessToken() { return 'secret-token'; }, invalidate() { invalidations += 1; } },
    logger: { info(record) { logs.push(record); } },
  });
  await assert.rejects(service.searchLeadByPhone('+971501234567'), { code: 'ZOHO_API', providerCode: 'OAUTH_SCOPE_MISMATCH' });
  assert.equal(invalidations, 0);
  assert.deepEqual(logs, [{ event: 'zoho_search', contactType: 'phone' }]);
});

test('Zoho exchangeAuthorizationCode sends proper grant_type, parses tokens and api_domain securely', async () => {
  const http = mockHttp([
    {
      status: 200,
      data: {
        access_token: 'auth-access-token-123',
        refresh_token: 'auth-refresh-token-456',
        api_domain: 'https://www.zohoapis.com',
        expires_in: 3600,
      },
    },
  ]);
  const env = settings({
    ZOHO_CLIENT_ID: 'self-client-id',
    ZOHO_CLIENT_SECRET: 'self-client-secret',
    ZOHO_AUTHORIZATION_CODE: '1000.sample-auth-code',
    ZOHO_REDIRECT_URI: 'https://localhost',
  });
  const auth = createZohoAuthService({ env, http });
  const result = await auth.exchangeAuthorizationCode();

  assert.equal(result.accessToken, 'auth-access-token-123');
  assert.equal(result.refreshToken, 'auth-refresh-token-456');
  assert.equal(result.apiDomain, 'https://www.zohoapis.com');
  assert.equal(result.apiBaseUrl, 'https://www.zohoapis.com/crm/v8');
  assert.equal(result.expiresIn, 3600);

  const call = http.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://accounts.zoho.com/oauth/v2/token');
  const bodyParams = Object.fromEntries(new URLSearchParams(call.data));
  assert.equal(bodyParams.grant_type, 'authorization_code');
  assert.equal(bodyParams.client_id, 'self-client-id');
  assert.equal(bodyParams.client_secret, 'self-client-secret');
  assert.equal(bodyParams.code, '1000.sample-auth-code');
  assert.equal(bodyParams.redirect_uri, 'https://localhost');

  // Verify that subsequent getAccessToken uses the acquired token without extra refresh
  assert.equal(await auth.getAccessToken(), 'auth-access-token-123');
  assert.equal(http.calls.length, 1);
});

test('Zoho exchangeAuthorizationCode fails safely with invalid or consumed authorization code', async () => {
  const http = mockHttp([
    { status: 200, data: { error: 'invalid_code' } },
  ]);
  const env = settings({
    ZOHO_CLIENT_ID: 'self-client-id',
    ZOHO_CLIENT_SECRET: 'self-client-secret',
  });
  const auth = createZohoAuthService({ env, http });
  await assert.rejects(
    auth.exchangeAuthorizationCode({ code: 'expired-or-used-code' }),
    { code: 'ZOHO_AUTH', providerCode: 'INVALID_CODE' }
  );
});

test('Zoho uploadLeadAttachment uploads image binary with multipart FormData and parses success', async () => {
  const logs = [];
  const http = mockHttp([
    { status: 201, data: { data: [{ status: 'success', code: 'SUCCESS', details: { id: '714777000000123456' } }] } },
  ]);
  const service = crm(http, settings(), {
    logger: {
      info(rec) { logs.push(rec); },
      error(rec) { logs.push(rec); },
    },
  });

  const imgBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const result = await service.uploadLeadAttachment('5653678000072495041', {
    buffer: imgBuf,
    filename: 'blueprint.jpg',
    mimeType: 'image/jpeg',
  });

  assert.equal(result.id, '714777000000123456');
  assert.equal(result.status, 'uploaded');

  const call = http.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://www.zohoapis.com/crm/v8/Leads/5653678000072495041/Attachments');
  assert.equal(call.headers.Authorization, 'Zoho-oauthtoken test-access');
  assert.equal(call.maxBodyLength, 25 * 1024 * 1024);

  // Check logs contain safe observability events
  assert.ok(logs.some(l => l.event === 'ZOHO_ATTACHMENT_UPLOAD_STARTED' && l.filename === 'blueprint.jpg' && l.mime_type === 'image/jpeg'));
  assert.ok(logs.some(l => l.event === 'ZOHO_ATTACHMENT_UPLOAD_SUCCESS' && l.attachment_id === '714777000000123456'));
});

test('Zoho uploadLeadAttachment supports large PDF (>128KB) without maxBodyLength error', async () => {
  const http = mockHttp([
    { status: 200, data: { data: [{ status: 'success', code: 'SUCCESS', details: { id: '714777000000999888' } }] } },
  ]);
  const service = crm(http);

  // 250 KB buffer - exceeds original 128KB maxBodyLength limit
  const pdfBuf = Buffer.alloc(250 * 1024, 0x25);
  const result = await service.uploadLeadAttachment('5653678000072495041', {
    buffer: pdfBuf,
    filename: 'specifications.pdf',
    mimeType: 'application/pdf',
  });

  assert.equal(result.id, '714777000000999888');
  assert.equal(result.status, 'uploaded');
  assert.equal(http.calls[0].maxBodyLength, 25 * 1024 * 1024);
});

test('Zoho uploadLeadAttachment uploads audio/ogg voice note successfully', async () => {
  const http = mockHttp([
    { status: 200, data: { data: [{ status: 'success', code: 'SUCCESS', details: { id: '714777000000555444' } }] } },
  ]);
  const service = crm(http);

  const voiceBuf = Buffer.from('OggS voice data stream');
  const result = await service.uploadLeadAttachment('5653678000072495041', {
    buffer: voiceBuf,
    filename: 'voice_note.ogg',
    mimeType: 'audio/ogg',
  });

  assert.equal(result.id, '714777000000555444');
  assert.equal(result.status, 'uploaded');
});

test('Zoho uploadLeadAttachment handles 401 with token invalidation and successful retry', async () => {
  let invalidations = 0;
  const http = mockHttp([
    { status: 401, data: { code: 'INVALID_TOKEN' } },
    { status: 200, data: { data: [{ status: 'success', code: 'SUCCESS', details: { id: '714777000000111222' } }] } },
  ]);
  const service = crm(http, settings(), {
    auth: {
      async getAccessToken() { return 'token-' + invalidations; },
      invalidate() { invalidations += 1; },
    },
  });

  const result = await service.uploadLeadAttachment('5653678000072495041', {
    buffer: Buffer.from('test data'),
    filename: 'file.bin',
  });

  assert.equal(result.id, '714777000000111222');
  assert.equal(invalidations, 1);
  assert.equal(http.calls.length, 2);
});

test('Zoho uploadLeadAttachment stops on OAUTH_SCOPE_MISMATCH without retry and logs failure', async () => {
  const logs = [];
  let invalidations = 0;
  const http = mockHttp([
    { status: 401, data: { code: 'OAUTH_SCOPE_MISMATCH', message: 'scope mismatch' } },
  ]);
  const service = crm(http, settings(), {
    auth: {
      async getAccessToken() { return 'test-token'; },
      invalidate() { invalidations += 1; },
    },
    logger: {
      info(rec) { logs.push(rec); },
      error(rec) { logs.push(rec); },
    },
  });

  await assert.rejects(
    service.uploadLeadAttachment('5653678000072495041', {
      buffer: Buffer.from('test image'),
      filename: 'image.jpg',
      mimeType: 'image/jpeg',
    }),
    { code: 'ZOHO_API', providerCode: 'OAUTH_SCOPE_MISMATCH', httpStatus: 401, retryable: false }
  );

  assert.equal(invalidations, 0, 'Must not invalidate token on permanent scope mismatch');
  assert.equal(http.calls.length, 1);
  assert.ok(logs.some(l => l.event === 'ZOHO_ATTACHMENT_UPLOAD_FAILED' && l.provider_code === 'OAUTH_SCOPE_MISMATCH'));
});

test('Zoho uploadLeadAttachment fails safely when Zoho returns error in response body', async () => {
  const http = mockHttp([
    { status: 200, data: { data: [{ status: 'error', code: 'INVALID_FILE_TYPE', message: 'The file type is not supported.' }] } },
  ]);
  const service = crm(http);

  await assert.rejects(
    service.uploadLeadAttachment('5653678000072495041', {
      buffer: Buffer.from('unsupported format'),
      filename: 'file.exe',
      mimeType: 'application/x-msdownload',
    }),
    { code: 'ZOHO_API', providerCode: 'INVALID_FILE_TYPE' }
  );
});

test('Zoho uploadLeadAttachment validates input arguments strictly', async () => {
  const service = crm(mockHttp([]));

  await assert.rejects(service.uploadLeadAttachment('not-numeric-id', { buffer: Buffer.from('x') }), { code: 'ZOHO_INPUT' });
  await assert.rejects(service.uploadLeadAttachment('12345', { buffer: null }), { code: 'ZOHO_INPUT' });
  await assert.rejects(service.uploadLeadAttachment('12345', { buffer: Buffer.alloc(0) }), { code: 'ZOHO_INPUT' });
});


