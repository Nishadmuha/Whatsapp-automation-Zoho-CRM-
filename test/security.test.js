'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { readConfig } = require('../src/config/env');
const { createLogger, maskPhone } = require('../src/utils/logger');
const { requestLogger } = require('../src/middleware/requestLogger');

function configured(extra = {}) {
  return {
    NODE_ENV: 'production', WEBHOOK_VERIFY_TOKEN: 'a'.repeat(40), META_APP_SECRET: 'mock-meta-app-secret',
    DATABASE_URL: 'postgresql://test_user:test_password@db.example.test/test_database',
    AUTOMATION_ENABLED: 'true', ALLOWED_SENDER_PHONES: '+971501234567,971501234568',
    WHATSAPP_PHONE_NUMBER_ID: '123456789', WHATSAPP_ACCESS_TOKEN: 'mock-whatsapp-token',
    META_GRAPH_API_VERSION: 'v24.0', AI_PROVIDER: 'openai', OPENAI_API_KEY: 'mock-openai-key', OPENAI_MODEL: 'mock-model',
    ZOHO_CLIENT_ID: 'mock-client', ZOHO_CLIENT_SECRET: 'mock-client-secret', ZOHO_REFRESH_TOKEN: 'mock-refresh',
    ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.com', ZOHO_API_BASE_URL: 'https://www.zohoapis.com/crm/v8',
    ...extra,
  };
}

test('Production configuration requires signatures, strong verification token, PostgreSQL, and TLS verification', () => {
  assert.equal(readConfig(configured()).enabled, true);
  for (const overrides of [
    { META_APP_SECRET: '', WHATSAPP_APP_SECRET: '' }, { WEBHOOK_VERIFY_TOKEN: 'short' },
    { DATABASE_URL: 'file:./messages.sqlite' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  ]) assert.throws(() => readConfig(configured(overrides)));
});

test('Enabled fixed replies require valid WhatsApp configuration and signed intake', () => {
  for (const overrides of [
    { ALLOWED_SENDER_PHONES: '0501234567' }, { ALLOWED_SENDER_PHONES: '+971501234567,invalid' },
    { WHATSAPP_PHONE_NUMBER_ID: '' }, { WHATSAPP_PHONE_NUMBER_ID: '../messages' },
    { META_GRAPH_API_VERSION: '', WHATSAPP_API_VERSION: '' }, { META_GRAPH_API_VERSION: 'invalid' },
    { WHATSAPP_ACCESS_TOKEN: '' }, { WHATSAPP_ACCESS_TOKEN: 'invalid\nheader' },
    { WHATSAPP_ACCESS_TOKEN: 'x'.repeat(4097) }, { AUTOMATION_ENABLED: 'TRUE' },
  ]) assert.throws(() => readConfig(configured(overrides)));
  assert.throws(() => readConfig(configured({ NODE_ENV: 'development', META_APP_SECRET: '', WHATSAPP_APP_SECRET: '' })), /META_APP_SECRET/);
});

test('Reply configuration stays lazy for AI credentials and needs no Zoho settings or mandatory sender filter', () => {
  const config = readConfig({
    WEBHOOK_VERIFY_TOKEN: 'local-test-token', META_APP_SECRET: 'mock-meta-app-secret', AUTOMATION_ENABLED: 'true',
    WHATSAPP_PHONE_NUMBER_ID: '123456789', WHATSAPP_ACCESS_TOKEN: 'mock-whatsapp-token', META_GRAPH_API_VERSION: 'v25.0',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.allowedSenders.size, 0);
  for (const provider of ['', 'openai']) {
    const withoutProviderKeys = readConfig(configured({
      ALLOWED_SENDER_PHONES: '', AI_PROVIDER: provider, OPENAI_API_KEY: '', OPENAI_MODEL: '', GEMINI_API_KEY: '', GEMINI_MODEL: '',
      ZOHO_CLIENT_ID: '', ZOHO_CLIENT_SECRET: '', ZOHO_REFRESH_TOKEN: '', ZOHO_ACCOUNTS_URL: '', ZOHO_API_BASE_URL: '',
    }));
    assert.equal(withoutProviderKeys.enabled, true);
    assert.equal(withoutProviderKeys.allowedSenders.size, 0);
    assert.equal(withoutProviderKeys.aiProvider, provider);
  }
  for (const provider of ['gemini', 'deferred-provider']) {
    assert.throws(() => readConfig(configured({ AI_PROVIDER: provider })), /AI_PROVIDER=openai/);
  }
});

test('Safe development defaults disable external automation and honor legacy environment aliases', () => {
  const config = readConfig({ WEBHOOK_VERIFY_TOKEN: 'local-test-token' });
  assert.equal(config.enabled, false);
  assert.equal(config.bossSenders.size, 0);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.trustProxy, 0);
  assert.equal(config.databaseUrl, 'file:./data/messages.sqlite');
  const legacy = readConfig(configured({ META_APP_SECRET: '', WHATSAPP_APP_SECRET: 'legacy-secret', META_GRAPH_API_VERSION: '', WHATSAPP_API_VERSION: 'v23.0' }));
  assert.equal(legacy.appSecret, 'legacy-secret');
  assert.equal(legacy.graphVersion, 'v23.0');
  assert.deepEqual([...legacy.allowedSenders], ['+971501234567', '+971501234568']);
});

test('Boss authorization is independent from customer access and requires explicit international sender IDs', () => {
  const config = readConfig(configured({ BOSS_SENDER_PHONES: '971551234567, +971551234567, +971561234567', ALLOWED_SENDER_PHONES: '' }));
  assert.deepEqual([...config.bossSenders], ['+971551234567', '+971561234567']);
  assert.equal(config.allowedSenders.size, 0);
  const customerOnly = readConfig(configured({ ALLOWED_SENDER_PHONES: '+971551234567' }));
  assert.equal(customerOnly.bossSenders.size, 0);
  for (const value of ['0501234567', '*', 'private-authorization-value', '+97155 1234567']) {
    assert.throws(() => readConfig(configured({ BOSS_SENDER_PHONES: value })), error => {
      assert.match(error.message, /BOSS_SENDER_PHONES/);
      assert.equal(error.message.includes(value), false);
      return true;
    });
  }
});

test('Webhook-only configuration accepts a numeric destination or a disabled filter and rejects malformed IDs', () => {
  const base = { WEBHOOK_VERIFY_TOKEN: 'local-test-token', AUTOMATION_ENABLED: 'false' };
  for (const value of [undefined, '', '  ']) {
    assert.equal(readConfig({ ...base, WHATSAPP_PHONE_NUMBER_ID: value }).phoneNumberId, '');
  }
  for (const value of ['1234567890', ' 1234567890 ']) {
    const config = readConfig({ ...base, WHATSAPP_PHONE_NUMBER_ID: value });
    assert.equal(config.phoneNumberId, '1234567890');
    assert.equal(config.enabled, false);
  }
  for (const value of ['not-a-number', '../messages', '+1234567890', '123 456', '123.45']) {
    assert.throws(() => readConfig({ ...base, WHATSAPP_PHONE_NUMBER_ID: value }), (error) => {
      assert.match(error.message, /WHATSAPP_PHONE_NUMBER_ID/);
      assert.equal(error.message.includes(value), false);
      return true;
    });
  }
  assert.throws(() => readConfig(configured({ WHATSAPP_PHONE_NUMBER_ID: '' })), /WHATSAPP_PHONE_NUMBER_ID/);
});

test('Configuration bounds request, worker, and proxy values without echoing arbitrary inputs', () => {
  for (const key of ['PORT', 'WORKER_POLL_MS', 'WORKER_LEASE_MS', 'PROCESSING_MAX_ATTEMPTS', 'WEBHOOK_RATE_LIMIT', 'TRUST_PROXY_HOPS']) {
    assert.throws(() => readConfig(configured({ [key]: 'private-secret-value' })), (error) => {
      assert.equal(error.message.includes('private-secret-value'), false);
      return true;
    });
  }
  assert.throws(() => readConfig(configured({ TRUST_PROXY_HOPS: '4' })));
  assert.throws(() => readConfig(configured({ PORT: '65536' })));
  assert.throws(() => readConfig({ WEBHOOK_VERIFY_TOKEN: 'change_this_to_a_random_secret' }));
});

test('Structured logger redacts configured secrets, arbitrary sensitive keys, request bodies, and raw errors', () => {
  const env = configured({ LOG_LEVEL: 'info' });
  let output = '';
  const logger = createLogger(env, { write(chunk) { output += chunk; } });
  logger.info({
    event: 'security_test',
    nested: { authorization: 'new-runtime-access-token', apiKey: 'not-in-env', password: 'not-in-env-password' },
    message_text: 'private customer text', rawBody: 'private webhook text',
    values: [env.WHATSAPP_ACCESS_TOKEN, `prefix ${env.ZOHO_REFRESH_TOKEN} suffix`, env.DATABASE_URL, env.OPENAI_API_KEY],
    exception: Object.assign(new Error('private raw transport failure'), { config: { headers: { Authorization: 'private-runtime-token' } } }),
  });
  logger.error(`Failed safely ${env.ZOHO_CLIENT_SECRET}`);
  const parsed = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(parsed[0].event, 'security_test');
  assert.equal(parsed[0].service, 'whatsapp-lead-automation');
  assert.equal(parsed[0].nested.authorization, '[REDACTED]');
  assert.deepEqual(parsed[0].exception, { code: 'INTERNAL_ERROR' });
  for (const secret of [env.WHATSAPP_ACCESS_TOKEN, env.ZOHO_REFRESH_TOKEN, env.DATABASE_URL, env.OPENAI_API_KEY, env.ZOHO_CLIENT_SECRET,
    'new-runtime-access-token', 'not-in-env', 'private customer text', 'private webhook text', 'private raw transport failure', 'private-runtime-token']) {
    assert.equal(output.includes(secret), false);
  }
});

test('Request logging omits query tokens, request headers, phone numbers, and message bodies', () => {
  const logs = [];
  const logger = { info: (record) => logs.push(record) };
  const req = {
    method: 'GET', url: '/webhook?hub.verify_token=private-verification-token',
    originalUrl: '/webhook?hub.verify_token=private-verification-token',
    headers: { authorization: 'private-header' }, body: { text: 'private customer' }, route: { path: '/' },
  };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.set = () => {};
  let continued = false;
  requestLogger(logger)(req, res, () => { continued = true; });
  res.emit('finish');
  assert.equal(continued, true);
  assert.match(req.requestId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(logs[0]).sort(), ['duration_ms', 'event', 'method', 'request_id', 'route', 'status']);
  assert.equal(JSON.stringify(logs).includes('private'), false);
  assert.equal(maskPhone('+971501234567'), '***4567');
});
