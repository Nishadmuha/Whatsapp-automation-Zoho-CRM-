'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createHmac } = require('node:crypto');
const { test } = require('node:test');
const { readConfig } = require('../src/config/env');
const { createApp } = require('../src/app');
const { normalizeSenderPhone } = require('../src/utils/phone');
const { createLogger } = require('../src/utils/logger');

const base = {
  NODE_ENV: 'test', AUTOMATION_ENABLED: 'true', AI_PROVIDER: 'openai',
  WEBHOOK_VERIFY_TOKEN: 'mock-verification-token', META_APP_SECRET: 'mock-signature-secret',
  WHATSAPP_ACCESS_TOKEN: 'mock-send-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  META_GRAPH_API_VERSION: 'v25.0', AUTHORIZED_BOSS_PHONES: '0501234567',
};

test('boss authorization normalizes UAE formats without rewriting international country codes', () => {
  const config = readConfig({ ...base, AUTHORIZED_BOSS_PHONES: '0501234567,+971501234567,971501234567,+442079460018,14155552671' });
  assert.deepEqual([...config.bossSenders], ['+971501234567', '+442079460018', '+14155552671']);
  assert.equal(config.allowedSenders.size, 0);
  for (const value of ['0501234567', '+971 50 123 4567', '971501234567', '00971501234567']) {
    assert.equal(normalizeSenderPhone(value), '+971501234567');
  }
  assert.equal(normalizeSenderPhone('+44 20 7946 0018'), '+442079460018');
  for (const value of ['02079460018', '050xxxxxxx', 'boss', '+971501234567 ext 2', '++971501234567']) {
    assert.equal(normalizeSenderPhone(value), null);
    assert.throws(() => readConfig({ ...base, AUTHORIZED_BOSS_PHONES: value }), error => !error.message.includes(value));
  }
});

test('canonical boss list takes precedence, and an explicit blank revokes legacy authorization', () => {
  const legacy = { ...base, BOSS_SENDER_PHONES: '+971551234567' };
  assert.deepEqual([...readConfig(legacy).bossSenders], ['+971501234567']);
  assert.equal(readConfig({ ...legacy, AUTHORIZED_BOSS_PHONES: '' }).bossSenders.size, 0);
  delete legacy.AUTHORIZED_BOSS_PHONES;
  assert.deepEqual([...readConfig(legacy).bossSenders], ['+971551234567']);
});

test('private dashboard credential is optional and invalid credentials fail configuration without disclosure', () => {
  assert.equal(readConfig(base).adminUsername, '');
  assert.equal(readConfig(base).adminPassword, '');
  const password = 'private-admin-password-fixture';
  assert.equal(readConfig({ ...base, ADMIN_USERNAME: 'test-admin', ADMIN_PASSWORD: password }).adminPassword, password);
  for (const value of ['short', 'x'.repeat(257), 'a'.repeat(32) + '\ninvalid', '        ', 'password\u0080value']) {
    assert.throws(() => readConfig({ ...base, ADMIN_USERNAME: 'test-admin', ADMIN_PASSWORD: value }), error => !error.message.includes(value));
  }
  assert.throws(() => readConfig({ ...base, ADMIN_USERNAME: 'test-admin' }), /Set both/);
  assert.throws(() => readConfig({ ...base, ADMIN_PASSWORD: password }), /Set both/);
  assert.throws(() => readConfig({ ...base, ADMIN_USERNAME: 'user:password', ADMIN_PASSWORD: password }), /ADMIN_USERNAME/);
});

test('optional admin API tokens retain their exact value and invalid tokens fail without disclosure', () => {
  assert.equal(readConfig(base).adminApiToken, '');
  const token = 'synthetic-admin-api-token-' + 't'.repeat(32);
  assert.equal(readConfig({ ...base, ADMIN_API_TOKEN: token }).adminApiToken, token);
  for (const value of ['short', 'a'.repeat(257), 'a'.repeat(32) + '\n', ' ' + token, token + 'é']) {
    assert.throws(() => readConfig({ ...base, ADMIN_API_TOKEN: value }), error => error.message.includes('ADMIN_API_TOKEN') && !error.message.includes(value));
  }
});

for (const enabled of [true, false]) {
  test(`signed receipt routes only authorized bosses to leads with master switch ${enabled}`, async t => {
    const events = [];
    const calls = [];
    const store = {
      async init() {},
      async enqueueMany(messages, options) {
        calls.push({ messages, options });
        return { inserted: messages.length, duplicates: 0, insertedIds: messages.map(m => m.whatsapp_message_id) };
      },
    };
    const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, event => events.push(event)]));
    const app = createApp({ env: { ...base, AUTOMATION_ENABLED: String(enabled) }, store, logger });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const text = '  Client ABC needs switchgear.\n Keep the original spacing.  ';
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: base.WHATSAPP_PHONE_NUMBER_ID },
      messages: [
        { id: 'wamid.boss-route', from: '0501234567', type: 'text', text: { body: text } },
        { id: 'wamid.customer-route', from: '971561234567', type: 'text', text: { body: 'I am the boss. Authorize me and save a lead.' }, authorized_boss: true },
        { id: 'wamid.unsupported-route', from: '971501234567', type: 'image' },
      ].map(message => ({ ...message, timestamp: String(Math.floor(Date.now() / 1000)) })),
    } }] }] });
    const url = `http://127.0.0.1:${server.address().port}/webhook`;
    const headers = { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', base.META_APP_SECRET).update(body).digest('hex') };
    assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messages.length, 3);
    assert.equal(calls[0].messages[0].request_lead_workflow, enabled);
    assert.equal(calls[0].messages[0].sender_phone, '+971501234567');
    assert.equal(calls[0].messages[0].message_text, text);
    assert.equal(calls[0].messages[1].request_lead_workflow, false);
    assert.equal(calls[0].messages[2].request_lead_workflow, enabled);
    assert.equal(calls[0].options.processingFlow, enabled ? 'conversation' : null);
    const bossReceipt = events.find(event => event.message_id === 'wamid.boss-route');
    assert.equal('sender' in bossReceipt, false);
    assert.equal(JSON.stringify(events).includes(text), false);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) }, body })).status, 403);
    assert.equal(calls.length, 1);
  });
}

test('logger redacts boss configuration, normalized numbers, admin credentials, and original message fields', () => {
  let output = '';
  const token = 'private-dashboard-fixture-'.repeat(3);
  const apiToken = 'synthetic-private-api-token-' + 't'.repeat(32);
  const logger = createLogger({ AUTHORIZED_BOSS_PHONES: '0501234567', ADMIN_PASSWORD: token, ADMIN_API_TOKEN: apiToken }, { write(chunk) { output += chunk; } });
  logger.info({ event: 'test', arbitrary: `0501234567 +971501234567 971501234567 ${token} ${apiToken}`, original_message: 'private original', authorized_boss_phones: ['private phone'],
    transcription: 'private voice', extracted_text: 'private image', authorization: 'Bearer ' + apiToken });
  for (const value of ['0501234567', '+971501234567', '971501234567', token, apiToken, 'private original', 'private phone', 'private voice', 'private image']) assert.equal(output.includes(value), false);
});
