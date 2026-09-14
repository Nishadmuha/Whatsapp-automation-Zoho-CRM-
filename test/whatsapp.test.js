'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');
const { inspect } = require('node:util');
const axios = require('axios');
const { createWhatsAppService, sendWhatsAppTextMessage, sendTextMessage, sendTemplateMessage } = require('../src/services/whatsapp');

function settings(extra = {}) {
  return {
    WHATSAPP_ACCESS_TOKEN: randomBytes(24).toString('hex'),
    WHATSAPP_PHONE_NUMBER_ID: '123456789012345', META_GRAPH_API_VERSION: 'v25.0',
    ...extra,
  };
}

function setup({ env = settings(), outcome = { data: { messages: [{ id: 'mock-whatsapp-id' }] } } } = {}) {
  const calls = [];
  const logs = [];
  const http = { async post(...args) {
    calls.push(args);
    return typeof outcome === 'function' ? outcome(...args) : outcome;
  } };
  const service = createWhatsAppService({ env, http, logger: { error: (data) => logs.push(data) } });
  return { service, calls, logs, env };
}

test('WhatsApp sends the configured Graph API contract with TLS verification, bounded payload and no redirects', async () => {
  const { service, calls, logs, env } = setup();
  const result = await service.sendTextMessage('+971501234567', 'A customer confirmation');
  assert.deepEqual(result, { messages: [{ id: 'mock-whatsapp-id' }] });
  assert.equal(calls.length, 1);
  const [url, data, config] = calls[0];
  assert.equal(url, `https://graph.facebook.com/v25.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`);
  assert.deepEqual(data, {
    messaging_product: 'whatsapp', to: '+971501234567', type: 'text', text: { body: 'A customer confirmation' },
  });
  assert.deepEqual(config.headers, { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' });
  assert.equal(config.timeout, 15000);
  assert.ok(config.signal instanceof AbortSignal);
  assert.equal(config.maxRedirects, 0);
  assert.equal(config.httpsAgent.options.rejectUnauthorized, true);
  assert.ok(config.maxContentLength > 0 && config.maxContentLength <= 1024 * 1024);
  assert.ok(config.maxBodyLength > 0 && config.maxBodyLength <= 64 * 1024);
  assert.deepEqual(logs, []);
});

test('WhatsApp configured Graph version wins over the legacy alias and no implicit version is chosen', async () => {
  for (const [env, expected] of [
    [settings({ META_GRAPH_API_VERSION: 'v25.0', WHATSAPP_API_VERSION: 'v23.0' }), 'v25.0'],
    [settings({ META_GRAPH_API_VERSION: '', WHATSAPP_API_VERSION: 'v23.0' }), 'v23.0'],
  ]) {
    const { service, calls } = setup({ env });
    await service.sendTextMessage('971501234567', 'Hello');
    assert.ok(calls[0][0].includes(`/${expected}/`));
  }
  const { service, calls } = setup({ env: settings({ META_GRAPH_API_VERSION: '', WHATSAPP_API_VERSION: '' }) });
  await assert.rejects(service.sendTextMessage('971501234567', 'Hello'), { code: 'ERR_WHATSAPP_CONFIG' });
  assert.equal(calls.length, 0);
});

test('WhatsApp rejects missing credentials and URL/header injection before attempting a request', async () => {
  for (const invalid of [
    { WHATSAPP_ACCESS_TOKEN: '' }, { WHATSAPP_ACCESS_TOKEN: 'invalid\nheader' },
    { WHATSAPP_ACCESS_TOKEN: 'invalid\0header' }, { WHATSAPP_ACCESS_TOKEN: 42 },
    { WHATSAPP_PHONE_NUMBER_ID: '' }, { WHATSAPP_PHONE_NUMBER_ID: '../messages' },
    { META_GRAPH_API_VERSION: 'https://attacker.example' }, { META_GRAPH_API_VERSION: 'v24.0?x=1' },
  ]) {
    const { service, calls } = setup({ env: settings(invalid) });
    await assert.rejects(service.sendTextMessage('971501234567', 'Hello'), {
      code: 'ERR_WHATSAPP_CONFIG', deliveryState: 'NOT_ATTEMPTED', attempted: false, uncertain: false,
    });
    assert.equal(calls.length, 0);
  }
});

test('WhatsApp validates international recipients and empty, non-string, or oversized messages', async () => {
  for (const [to, message] of [
    ['', 'Hello'], [42, 'Hello'], ['invalid recipient', 'Hello'], ['0501234567', 'Hello'],
    ['123456', 'Hello'], ['9'.repeat(16), 'Hello'], [`+${'9'.repeat(16)}`, 'Hello'],
    ['971501234567', ''], ['971501234567', ' \n '], ['971501234567', null],
    ['971501234567', 'a'.repeat(4097)], ['971501234567', '\u{1F600}'.repeat(4097)],
  ]) {
    const { service, calls } = setup();
    await assert.rejects(service.sendTextMessage(to, message), {
      code: 'ERR_WHATSAPP_INPUT', deliveryState: 'NOT_ATTEMPTED', attempted: false, uncertain: false,
    });
    assert.equal(calls.length, 0);
  }
});

test('WhatsApp accepts maximum E.164 length and exactly 4096 Unicode characters', async () => {
  const { service, calls } = setup();
  await service.sendTextMessage(`+${'9'.repeat(15)}`, 'a'.repeat(4096));
  await service.sendTextMessage(`+${'9'.repeat(15)}`, '\u{1F600}'.repeat(4096));
  assert.equal(calls.length, 2);
  assert.equal(Array.from(calls[1][1].text.body).length, 4096);
});

test('WhatsApp API failures expose only safe numeric metadata and never Axios credentials or customer text', async () => {
  const env = settings();
  const privateMessage = 'private customer contact information';
  const recipient = '971501234567';
  const originalFailure = Object.assign(new Error(`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`), {
    code: 'ERR_BAD_REQUEST',
    config: { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` } },
    request: { recipient, privateMessage },
    response: { status: 401, data: { error: { message: privateMessage, code: 190, error_subcode: 463 }, access_token: env.WHATSAPP_ACCESS_TOKEN } },
  });
  const { service, calls, logs } = setup({ env, outcome: () => { throw originalFailure; } });
  await assert.rejects(service.sendTextMessage(recipient, privateMessage), (error) => {
    assert.notEqual(error, originalFailure);
    assert.equal(error.code, 'ERR_WHATSAPP_SEND');
    assert.equal(error.httpStatus, 401);
    assert.equal(error.metaCode, 190);
    assert.equal(error.metaSubcode, 463);
    assert.equal(error.transportCode, 'ERR_BAD_REQUEST');
    assert.equal(error.uncertain, false);
    assert.equal(error.deliveryState, 'ATTEMPTED_FAILED');
    assert.equal(error.attempted, true);
    assert.equal(error.cause, undefined);
    assert.equal(error.config, undefined);
    assert.equal(error.response, undefined);
    const output = inspect({ logs, error }, { depth: null });
    for (const secret of [env.WHATSAPP_ACCESS_TOKEN, privateMessage, recipient]) {
      assert.equal(output.includes(secret), false);
    }
    return true;
  });
  assert.equal(calls.length, 1);
});

test('WhatsApp timeout and malformed success remain UNKNOWN without blind retry', async () => {
  for (const outcome of [
    () => { throw Object.assign(new Error('private details'), { code: 'ECONNABORTED' }); },
    { data: {} }, { data: { messages: [] } }, { data: { messages: [{ id: '' }] } },
    { data: { messages: [{ id: ' ' }] } }, { status: 'invalid', data: { messages: [{ id: 'mock' }] } },
    ...['x'.repeat(513), 'bad\0id', 'bad\nid', 'bad id', 'é'].map((id) => ({ status: 200, data: { messages: [{ id }] } })),
    { status: 200, data: { messages: [{ id: 'mock' }], error: {} } },
  ]) {
    const { service, calls, logs } = setup({ outcome });
    await assert.rejects(service.sendTextMessage('971501234567', 'Hello'), (error) => {
      assert.equal(error.code, 'ERR_WHATSAPP_SEND');
      assert.equal(error.uncertain, true);
      assert.equal(error.deliveryState, 'UNKNOWN');
      assert.equal(error.attempted, true);
      assert.equal(inspect({ error, logs }).includes('private details'), false);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('WhatsApp malformed upstream error metadata never leaks arbitrary strings', async () => {
  const env = settings();
  const secret = env.WHATSAPP_ACCESS_TOKEN;
  const { service, calls, logs } = setup({ env, outcome: () => {
    throw { code: secret, response: { status: secret, data: { error: { code: secret, error_subcode: secret } } } };
  } });
  await assert.rejects(service.sendTextMessage('971501234567', 'Hello'), (error) => {
    for (const key of ['httpStatus', 'metaCode', 'metaSubcode', 'transportCode']) assert.equal(error[key], undefined);
    assert.equal(inspect({ logs, error }, { depth: null }).includes(secret), false);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('WhatsApp retains the original public import and sending-function aliases', async (t) => {
  assert.equal(sendTextMessage, sendWhatsAppTextMessage);
  const env = settings();
  const keys = [...Object.keys(env), 'WHATSAPP_API_VERSION', 'LOG_LEVEL'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const oldPost = axios.post;
  t.after(() => {
    axios.post = oldPost;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  Object.assign(process.env, env, { LOG_LEVEL: 'silent' });
  let count = 0;
  axios.post = async () => { count += 1; return { data: { messages: [{ id: 'mock-legacy-id' }] } }; };
  assert.deepEqual(await sendWhatsAppTextMessage('971501234567', 'Hello'), { messages: [{ id: 'mock-legacy-id' }] });
  assert.deepEqual(await sendTemplateMessage('971501234567', 'hello_world', 'en_US'), { messages: [{ id: 'mock-legacy-id' }] });
  assert.equal(count, 2);
});

test('WhatsApp template send uses dynamic recipient, template, language and the existing transport safeguards', async () => {
  const { service, calls, env } = setup();
  const response = await service.sendTemplateMessage('+971551234567', 'appointment_update_2', 'ar');
  assert.deepEqual(response, { messages: [{ id: 'mock-whatsapp-id' }] });
  assert.equal(calls.length, 1);
  const [url, payload, options] = calls[0];
  assert.equal(url, `https://graph.facebook.com/v25.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`);
  assert.deepEqual(payload, { messaging_product: 'whatsapp', to: '+971551234567', type: 'template',
    template: { name: 'appointment_update_2', language: { code: 'ar' } } });
  assert.equal(options.headers.Authorization, `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`);
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.equal(options.timeout, 15000);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.maxRedirects, 0);
  assert.equal(options.httpsAgent.options.rejectUnauthorized, true);
  assert.equal(options.proxy, false);
});

test('WhatsApp template recipient, name, language and configuration failures are NOT_ATTEMPTED', async () => {
  for (const args of [
    ['', 'hello_world', 'en_US'], ['0501234567', 'hello_world', 'en_US'],
    ['971501234567', '', 'en_US'], ['971501234567', null, 'en_US'],
    ['971501234567', 'Invalid Name', 'en_US'], ['971501234567', 'a'.repeat(513), 'en_US'],
    ['971501234567', 'hello_world', ''], ['971501234567', 'hello_world', null],
    ['971501234567', 'hello_world', 'en_US\n'], ['971501234567', 'hello_world', '../en'],
  ]) {
    const { service, calls } = setup();
    await assert.rejects(service.sendTemplateMessage(...args), {
      code: 'ERR_WHATSAPP_INPUT', deliveryState: 'NOT_ATTEMPTED', attempted: false, uncertain: false,
    });
    assert.equal(calls.length, 0);
  }
  const { service, calls } = setup({ env: settings({ WHATSAPP_PHONE_NUMBER_ID: '' }) });
  await assert.rejects(service.sendTemplateMessage('971501234567', 'hello_world', 'en_US'), {
    code: 'ERR_WHATSAPP_CONFIG', deliveryState: 'NOT_ATTEMPTED', attempted: false, uncertain: false,
  });
  assert.equal(calls.length, 0);
});

test('HTTP rejections including server errors and explicit Meta errors are ATTEMPTED_FAILED for both send types', async () => {
  for (const kind of ['text', 'template']) {
    for (const response of [
      { status: 401, data: { error: { message: 'private rejection', code: 190, error_subcode: 463 } } },
      { status: 429, data: {} }, { status: 503, data: {} }, { status: 302, data: {} },
      { status: 200, data: { error: { message: 'private rejection', code: 100 } } },
    ]) {
      for (const outcome of [response, () => { throw { response }; }]) {
        const { service, calls, logs } = setup({ outcome });
        const sending = kind === 'text' ? service.sendTextMessage('971501234567', 'Hello')
          : service.sendTemplateMessage('971501234567', 'hello_world', 'en_US');
        await assert.rejects(sending, (error) => {
          assert.equal(error.deliveryState, 'ATTEMPTED_FAILED');
          assert.equal(error.attempted, true);
          assert.equal(error.uncertain, false);
          assert.equal(error.httpStatus, response.status);
          assert.equal(inspect({ error, logs }, { depth: null }).includes('private rejection'), false);
          return true;
        });
        assert.equal(calls.length, 1);
      }
    }
  }
});

test('template transport failures remain UNKNOWN and do not expose credentials or retry', async () => {
  const env = settings();
  const { service, calls, logs } = setup({ env, outcome: () => {
    throw Object.assign(new Error(env.WHATSAPP_ACCESS_TOKEN), { code: 'ECONNRESET', config: { headers: { Authorization: env.WHATSAPP_ACCESS_TOKEN } } });
  } });
  await assert.rejects(service.sendTemplateMessage('971501234567', 'hello_world', 'en_US'), (error) => {
    assert.equal(error.deliveryState, 'UNKNOWN');
    assert.equal(error.uncertain, true);
    assert.equal(error.attempted, true);
    assert.equal(inspect({ error, logs }, { depth: null }).includes(env.WHATSAPP_ACCESS_TOKEN), false);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('a broken logger cannot turn an accepted send into a failure or mask a rejected send', async () => {
  const logger = { info() { throw new Error('logger failed'); }, error() { throw new Error('logger failed'); } };
  const accepted = createWhatsAppService({ env: settings(), logger, http: { async post() { return { status: 200, data: { messages: [{ id: 'accepted' }] } }; } } });
  assert.deepEqual(await accepted.sendTextMessage('971501234567', 'Hello'), { messages: [{ id: 'accepted' }] });
  const rejected = createWhatsAppService({ env: settings(), logger, http: { async post() { throw { response: { status: 500 } }; } } });
  await assert.rejects(rejected.sendTextMessage('971501234567', 'Hello'), { deliveryState: 'ATTEMPTED_FAILED' });
});
