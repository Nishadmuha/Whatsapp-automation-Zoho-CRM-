'use strict';
const assert = require('node:assert/strict');
const { createHmac, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { createMessageStore } = require('../src/database');
const { parseIncomingMessages } = require('../src/services/whatsapp/whatsappParser');
const { temporaryStore, testEnv, silent } = require('./helpers');
function message(overrides = {}) {
  return { from: '971551234567', id: 'wamid.test1', type: 'text', text: { body: 'Ahmed 0501234567 needs AC maintenance.' }, timestamp: String(Math.floor(Date.now() / 1000)), ...overrides };
}
function payload(messages = [message()]) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '1234567890' }, messages } }] }] };
}
function signature(body, secret) { return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'); }
async function backend(t, overrides = {}, storeOverride, logger = silent, { allowUnavailable = false } = {}) {
  const { store, databaseUrl } = await temporaryStore(t);
  const env = testEnv(overrides);
  const app = createApp({ env, store: storeOverride || store, logger });
  if (allowUnavailable) await app.locals.ready.catch(() => {});
  else await app.locals.ready;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  return { store, databaseUrl, env, baseUrl, async post(body = payload(), headers = {}) {
    return fetch(baseUrl + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  } };
}
function captureLogs() {
  const entries = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (...args) => entries.push({ level, args })]));
  return { entries, logger };
}
test('health and legacy health expose safe headers and readiness without secrets', async (t) => {
  const h = await backend(t);
  const response = await fetch(h.baseUrl + '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'voltronix-whatsapp-backend' });
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await (await fetch(h.baseUrl + '/api/health')).json(), { success: true, message: 'Voltronix WhatsApp backend is running' });
  assert.deepEqual(await (await fetch(h.baseUrl + '/ready')).json(), { status: 'ready', automation: 'disabled' });
});
test('detailed health reports configured WhatsApp transport using sender validation', async (t) => {
  const h = await backend(t, {
    WHATSAPP_ACCESS_TOKEN: 'synthetic-whatsapp-token',
    WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    META_GRAPH_API_VERSION: 'v25.0',
  });
  const response = await fetch(h.baseUrl + '/health/status');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.whatsapp, 'CONFIGURED / HEALTHY');
  assert.equal(body.checks.whatsapp_api, '🟢 CONNECTED');
});
test('CORS permits only configured browser origins', async (t) => {
  const h = await backend(t, { CORS_ORIGINS: 'https://dashboard.example.com' });
  for (const origin of ['https://dashboard.example.com', 'https://untrusted.example.com']) {
    const response = await fetch(h.baseUrl + '/health', { headers: { Origin: origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), origin.includes('untrusted') ? null : origin);
  }
});
test('invalid destination configuration rejects app startup before storage initialization', () => {
  let initialized = false;
  assert.throws(() => createApp({
    env: testEnv({ WHATSAPP_PHONE_NUMBER_ID: 'invalid-destination' }),
    logger: silent,
    store: { init() { initialized = true; } },
  }), /WHATSAPP_PHONE_NUMBER_ID/);
  assert.equal(initialized, false);
});
test('Meta verification returns the unchanged plain text challenge', async (t) => {
  const h = await backend(t);
  for (const challenge of ['000123456789', '<challenge>&with spaces + symbols']) {
    const query = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': h.env.WEBHOOK_VERIFY_TOKEN, 'hub.challenge': challenge });
    const response = await fetch(h.baseUrl + '/webhook?' + query);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    assert.equal(await response.text(), challenge);
  }
});
test('verification rejects incorrect, missing and repeated parameters', async (t) => {
  const h = await backend(t);
  const valid = { 'hub.mode': 'subscribe', 'hub.verify_token': h.env.WEBHOOK_VERIFY_TOKEN, 'hub.challenge': '12345' };
  const queries = [new URLSearchParams({ ...valid, 'hub.mode': 'unsubscribe' }), new URLSearchParams({ ...valid, 'hub.verify_token': 'wrong' })];
  for (const key of Object.keys(valid)) {
    const missing = new URLSearchParams(valid); missing.delete(key); queries.push(missing);
    const duplicate = new URLSearchParams(valid); duplicate.append(key, valid[key]); queries.push(duplicate);
    queries.push(new URLSearchParams({ ...valid, [key]: '' }));
  }
  for (const query of queries) assert.equal((await fetch(h.baseUrl + '/webhook?' + query)).status, 403);
});
test('webhook commits all text messages before ACK and ignores repeated message IDs', async (t) => {
  const h = await backend(t);
  const body = payload([message(), message({ id: 'wamid.test2' })]);
  body.entry.push(...payload([message({ id: 'wamid.test3' })]).entry);
  assert.equal((await h.post(body)).status, 200);
  for (const id of ['wamid.test1', 'wamid.test2', 'wamid.test3']) {
    const stored = await h.store.getMessage(id);
    assert.equal(stored.processing_status, 'RECEIVED');
    assert.equal(stored.authenticated, false);
  }
  assert.equal((await h.post(body)).status, 200);
  assert.equal((await h.store.getMessage('wamid.test1')).attempts, 0);
});
test('concurrent and batched duplicates log each newly persisted message once and mask private content', async (t) => {
  const captured = captureLogs();
  const h = await backend(t, {}, undefined, captured.logger);
  const body = payload([message(), message(), message({ id: 'wamid.second' })]);
  body.entry[0].changes[0].value.contacts = [{ wa_id: '971551234567', profile: { name: 'Private Sender Name' } }];
  const bearer = 'test-private-authorization-value';
  const responses = await Promise.all(Array.from({ length: 8 }, () => h.post(body, { Authorization: 'Bearer ' + bearer })));
  for (const response of responses) assert.equal(response.status, 200);
  const received = captured.entries.filter((entry) => JSON.stringify(entry).includes('WhatsApp message received'));
  assert.equal(received.length, 2);
  for (const id of ['wamid.test1', 'wamid.second']) {
    assert.equal(received.filter((entry) => JSON.stringify(entry).includes(id)).length, 1);
    const stored = await h.store.getMessage(id);
    assert.equal(stored.message_text, message().text.body);
    assert.equal(stored.processing_status, 'RECEIVED');
    assert.equal(stored.attempts, 0);
  }
  const output = JSON.stringify(captured.entries);
  assert.match(output, /\*\*\*4567/);
  for (const privateValue of ['971551234567', '0501234567', message().text.body, 'Private Sender Name', bearer, h.env.WEBHOOK_VERIFY_TOKEN]) {
    assert.equal(output.includes(privateValue), false, 'Logs must omit private request content');
  }
});
test('duplicate protection survives reopening the persistent database in a new app', async (t) => {
  const first = await backend(t);
  assert.equal((await first.post()).status, 200);
  const original = await first.store.getMessage('wamid.test1');
  await first.store.close();
  const reopened = createMessageStore({ databaseUrl: first.databaseUrl, logger: silent });
  const captured = captureLogs();
  const second = await backend(t, {}, reopened, captured.logger);
  try {
    assert.equal((await second.post(payload([message({ text: { body: 'Retry must not overwrite the original' } })]))).status, 200);
    assert.deepEqual(await reopened.getMessage('wamid.test1'), original);
    assert.equal(captured.entries.some((entry) => JSON.stringify(entry).includes('WhatsApp message received')), false);
  } finally {
    await reopened.close();
  }
});
test('persistence failure returns 503 so Meta can retry', async (t) => {
  const h = await backend(t, {}, { init: async () => {}, enqueueMany: async () => { throw new Error('private database URL'); } });
  const response = await h.post();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '5');
  assert.doesNotMatch(await response.text(), /private database URL/);
});
test('harmless valid events are acknowledged even when database initialization failed', async (t) => {
  let enqueues = 0;
  const unavailable = {
    init: async () => { throw new Error('private database location'); },
    enqueueMany: async () => { enqueues += 1; throw new Error('Database unavailable'); },
  };
  const h = await backend(t, {}, unavailable, silent, { allowUnavailable: true });
  const status = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ status: 'delivered' }] } }] }] };
  for (const body of [{}, [], status, payload([message({ text: null })])]) {
    assert.equal((await h.post(body)).status, 200);
  }
  assert.equal(enqueues, 0);
  const response = await h.post();
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private database location/);
});
test('media messages are persisted with bounded metadata without suppressing valid text', async (t) => {
  const captured = captureLogs();
  const h = await backend(t, {}, undefined, captured.logger);
  const body = payload([message({ id: 'wamid.image', type: 'image', image: { id: '123456789', mime_type: 'image/jpeg', caption: 'private media caption' } }), message()]);
  body.entry[0].changes[0].value.contacts = [{ wa_id: '971551234567', profile: { name: 'Private Name' } }];
  assert.equal((await h.post(body)).status, 200);
  const saved = await h.store.getMessage('wamid.image');
  assert.equal(saved.media_id, '123456789');
  assert.equal(saved.media_mime_type, 'image/jpeg');
  assert.equal(saved.message_text, 'private media caption');
  assert.equal(saved.sender_name, 'Private Name');
  assert.ok(await h.store.getMessage('wamid.test1'));
  assert.doesNotMatch(JSON.stringify(captured.entries), /private media caption/);
  const untrustedType = 'unknown-' + 'private-type-content'.repeat(1000);
  assert.equal((await h.post(payload([message({ type: untrustedType })]))).status, 200);
  assert.ok(captured.entries.some((entry) => /unsupported/i.test(JSON.stringify(entry))));
  assert.equal(JSON.stringify(captured.entries).includes(untrustedType), false);
});
test('signature validates raw bytes and new or legacy secrets and records authenticated messages', async (t) => {
  for (const key of ['META_APP_SECRET', 'WHATSAPP_APP_SECRET']) {
    const secret = randomBytes(32).toString('hex');
    const h = await backend(t, { [key]: secret });
    const body = JSON.stringify(payload(), null, 2);
    assert.equal((await h.post(body, { 'X-Hub-Signature-256': signature(body, secret) })).status, 200);
    assert.equal((await h.store.getMessage('wamid.test1')).authenticated, true);
    for (const signed of [null, 'invalid', 'sha256=', 'sha256=' + 'g'.repeat(64), 'sha256=' + '0'.repeat(64), signature(JSON.stringify(JSON.parse(body)), secret)]) {
      assert.equal((await h.post(body, signed ? { 'X-Hub-Signature-256': signed } : {})).status, 403);
    }
  }
});
test('rejected signatures produce a dedicated diagnostic without private request data', async (t) => {
  const captured = captureLogs();
  const appSecret = randomBytes(32).toString('hex');
  const accessToken = randomBytes(32).toString('hex');
  const privateText = randomBytes(32).toString('hex');
  const h = await backend(t, { META_APP_SECRET: appSecret, WHATSAPP_ACCESS_TOKEN: accessToken }, undefined, captured.logger);
  const body = JSON.stringify(payload([message({ text: { body: privateText } })]));
  const invalidSignature = signature(body, randomBytes(32).toString('hex'));
  for (const suppliedSignature of [undefined, 'malformed-signature', invalidSignature]) {
    const headers = { Authorization: 'Bearer ' + accessToken };
    if (suppliedSignature) headers['X-Hub-Signature-256'] = suppliedSignature;
    const response = await h.post(body, headers);
    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'Forbidden');
  }
  assert.equal(await h.store.getMessage('wamid.test1'), null);
  const rejections = captured.entries.filter((entry) => entry.args[0]?.event === 'webhook_signature_invalid');
  assert.equal(rejections.length, 3);
  for (const entry of rejections) {
    assert.equal(entry.level, 'warn');
    assert.deepEqual(Object.keys(entry.args[0]).sort(), ['event', 'request_id']);
    assert.match(entry.args[0].request_id, /^[a-f0-9-]{36}$/);
    assert.equal(entry.args[1], 'Invalid WhatsApp webhook signature');
  }
  const output = JSON.stringify(captured.entries);
  for (const value of [appSecret, accessToken, privateText, body, invalidSignature, 'malformed-signature', h.env.WEBHOOK_VERIFY_TOKEN]) {
    assert.equal(output.includes(value), false, 'Signature logs must omit private request data');
  }
  assert.equal((await h.post(body, { 'X-Hub-Signature-256': signature(body, appSecret) })).status, 200);
  assert.equal(captured.entries.filter((entry) => entry.args[0]?.event === 'webhook_signature_invalid').length, 3);
});
test('only configured boss and destination number are accepted', async (t) => {
  const h = await backend(t, { ALLOWED_SENDER_PHONES: '+971551234567', WHATSAPP_PHONE_NUMBER_ID: '1234567890' });
  const wrong = payload([message({ id: 'wrong-destination' })]);
  wrong.entry[0].changes[0].value.metadata.phone_number_id = '9876';
  await h.post(wrong);
  await h.post(payload([message({ id: 'wrong-sender', from: '971561234567' })]));
  assert.equal(await h.store.getMessage('wrong-destination'), null);
  assert.equal(await h.store.getMessage('wrong-sender'), null);
  assert.equal((await h.post(payload([message({ id: 'matching-destination-and-sender' })]))).status, 200);
  assert.ok(await h.store.getMessage('matching-destination-and-sender'));
});
test('status, malformed nesting and invalid text are ignored safely', async (t) => {
  const h = await backend(t);
  const bodies = [{}, [], { object: 'unrelated' }, { object: 'whatsapp_business_account', entry: [null, {}] }, payload([null, {}, 'bad']), payload([message({ text: null })]), payload([message({ from: 'invalid' })]), payload([message({ timestamp: '99999999999' })])];
  bodies.push({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ status: 'delivered' }] } }] }] });
  for (const body of bodies) assert.equal((await h.post(body)).status, 200);
  assert.equal(await h.store.getMessage('wamid.test1'), null);
});
test('malformed message fields cannot poison a batch containing a valid text message', async (t) => {
  const h = await backend(t);
  const invalidMessages = [
    { id: {} }, { id: 'bad\nmessage-id' }, { from: [] }, { text: { body: {} } },
    { text: { body: '\0' } }, { text: { body: 'x'.repeat(4097) } }, { timestamp: {} },
    { timestamp: '0' }, { type: {} },
  ].map((overrides) => message(overrides));
  const body = payload([...invalidMessages, message({ id: 'wamid.valid-after-malformed' })]);
  assert.equal((await h.post(body)).status, 200);
  assert.equal(await h.store.getMessage('wamid.test1'), null);
  assert.ok(await h.store.getMessage('wamid.valid-after-malformed'));
});
test('malformed JSON, oversized bodies and unsupported content types receive bounded errors', async (t) => {
  const h = await backend(t);
  assert.equal((await h.post('{"entry":')).status, 400);
  assert.equal((await h.post({ content: 'x'.repeat(3 * 1024 * 1024) })).status, 413);
  assert.equal((await h.post('{}', { 'Content-Type': 'text/plain' })).status, 415);
});
test('webhook applies configurable request limits', async (t) => {
  const h = await backend(t, { WEBHOOK_RATE_LIMIT: '2' });
  assert.equal((await h.post({})).status, 200);
  assert.equal((await h.post({})).status, 200);
  assert.equal((await h.post({})).status, 429);
});
test('parser extracts sender, ID, timestamp, type and original text', () => {
  const parsed = parseIncomingMessages(payload());
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sender_phone, '+971551234567');
  assert.equal(parsed[0].message_type, 'text');
  assert.equal(parsed[0].whatsapp_message_id, 'wamid.test1');
  assert.equal(parsed[0].message_text, message().text.body);
  assert.ok(Number.isFinite(Date.parse(parsed[0].received_at)));
});
