'use strict';

const assert = require('node:assert/strict');
const { createHmac, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { createWorker } = require('../src/worker');
const { AUTO_REPLY_TEXT, createAutoReplyProcessor } = require('../src/services/whatsapp/autoReply');
const { temporaryStore, testEnv, silent } = require('./helpers');

function message(overrides = {}) {
  return { id: 'wamid.auto-reply-test', from: '971551234567', type: 'text', text: { body: 'Can you help with AC maintenance?' },
    timestamp: String(Math.floor(Date.now() / 1000)), ...overrides };
}

function payload(messages = [message()]) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: '1234567890' }, messages,
  } }] }] };
}

async function backend(t, { env: overrides = {}, store: suppliedStore, send } = {}) {
  const store = suppliedStore || (await temporaryStore(t)).store;
  const env = testEnv({ AUTOMATION_ENABLED: 'true', META_APP_SECRET: randomBytes(32).toString('hex'),
    WHATSAPP_ACCESS_TOKEN: randomBytes(32).toString('hex'), WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    META_GRAPH_API_VERSION: 'v25.0', ...overrides });
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (...args) => logs.push({ level, args })]));
  const app = createApp({ env, store, logger });
  await app.locals.ready;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const sends = [];
  const whatsapp = { async sendTextMessage(to, text) {
    sends.push({ to, text });
    return send ? send(to, text) : { messages: [{ id: 'wamid.accepted-auto-reply' }] };
  } };
  const config = app.locals.config;
  const processor = createAutoReplyProcessor({ store, whatsapp, config, logger });
  return { store, env, config, processor, sends, logs, async post(body = payload(), signed = true) {
    const raw = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };
    if (signed === true) headers['X-Hub-Signature-256'] = 'sha256=' + createHmac('sha256', config.appSecret).update(raw).digest('hex');
    else if (typeof signed === 'string') headers['X-Hub-Signature-256'] = signed;
    return fetch('http://127.0.0.1:' + server.address().port + '/webhook', { method: 'POST', headers, body: raw });
  } };
}

async function outboxCount(store) {
  return Number((await store.driver.query('SELECT COUNT(*) AS count FROM reply_outbox')).rows[0].count);
}

test('the default disabled configuration stores authenticated text without queuing or sending an automatic reply', async (t) => {
  const h = await backend(t, { env: { AUTOMATION_ENABLED: undefined } });
  assert.equal(h.config.enabled, false);
  assert.equal((await h.post()).status, 200);
  assert.equal((await h.store.getMessage(message().id)).authenticated, true);
  assert.equal(await h.store.getReply(message().id), null);
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal(await outboxCount(h.store), 0);
  assert.equal(h.sends.length, 0);
});

test('enabled signed text reaches the exact fixed reply through an outbox-only worker with no inbox/AI/Zoho processing', async (t) => {
  let notifySend;
  const sent = new Promise(resolve => { notifySend = resolve; });
  const h = await backend(t, { send: async () => { notifySend(); return { messages: [{ id: 'wamid.accepted-auto-reply' }] }; } });
  assert.equal(AUTO_REPLY_TEXT, 'Thanks for contacting Voltronix Contracting LLC. How can we help you?');
  assert.equal(h.config.allowedSenders.size, 0);
  assert.equal((await h.post()).status, 200);
  assert.equal((await h.store.getReply(message().id)).status, 'PENDING');
  let inboxClaims = 0;
  h.store.claimNext = async () => { inboxClaims++; throw new Error('Inbox processing is outside this feature.'); };
  const worker = createWorker({ store: h.store, processor: h.processor, config: h.config, logger: silent, processInbox: false });
  t.after(() => worker.stop());
  let timeout;
  const failed = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Automatic reply worker did not send.')), 3000); });
  worker.start();
  try { await Promise.race([sent, failed]); } finally { clearTimeout(timeout); await worker.stop(); }
  assert.equal(inboxClaims, 0);
  assert.deepEqual(h.sends, [{ to: '+971551234567', text: AUTO_REPLY_TEXT }]);
  const reply = await h.store.getReply(message().id);
  assert.equal(reply.status, 'SENT');
  assert.equal(reply.provider_message_id, 'wamid.accepted-auto-reply');
  const stored = await h.store.getMessage(message().id);
  assert.equal(stored.extracted_lead_data, null);
  assert.equal(stored.zoho_lead_id, null);
  assert.equal(stored.attempts, 0);
});

test('without an optional sender allowlist each sender receives its own fixed reply', async (t) => {
  const h = await backend(t);
  const incoming = [message(), message({ id: 'wamid.second-customer', from: '971561234567' })];
  assert.equal((await h.post(payload(incoming))).status, 200);
  assert.equal(await h.processor.processNextReply(), true);
  assert.equal(await h.processor.processNextReply(), true);
  assert.equal(await h.processor.processNextReply(), false);
  assert.deepEqual(h.sends.map(send => send.to).sort(), ['+971551234567', '+971561234567']);
  for (const sent of h.sends) assert.equal(sent.text, AUTO_REPLY_TEXT);
});

test('concurrent webhook duplicates and competing reply dispatches produce one stored reply and one send', async (t) => {
  const h = await backend(t);
  const body = payload([message(), message()]);
  const responses = await Promise.all(Array.from({ length: 8 }, () => h.post(body)));
  for (const response of responses) assert.equal(response.status, 200);
  assert.equal(await outboxCount(h.store), 1);
  await Promise.all(Array.from({ length: 8 }, () => h.processor.processNextReply()));
  assert.equal((await h.post(body)).status, 200);
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal(h.sends.length, 1);
  assert.equal((await h.store.getReply(message().id)).status, 'SENT');
});

test('missing and invalid signatures cannot queue or send automatic replies', async (t) => {
  const h = await backend(t);
  for (const signature of [false, 'invalid', 'sha256=' + '0'.repeat(64)]) {
    assert.equal((await h.post(payload(), signature)).status, 403);
  }
  assert.equal(await h.store.getMessage(message().id), null);
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal(await outboxCount(h.store), 0);
  assert.equal(h.sends.length, 0);
});

test('signed status events and non-text messages do not queue automatic replies', async (t) => {
  const h = await backend(t);
  const status = payload([]);
  const value = status.entry[0].changes[0].value;
  delete value.messages;
  value.statuses = [{ id: 'wamid.previous-send', status: 'delivered' }];
  for (const body of [status, payload([message({ type: 'image', image: { id: 'media-id' } })]), payload([message({ type: 'audio' })]), {}]) {
    assert.equal((await h.post(body)).status, 200);
  }
  assert.equal(await outboxCount(h.store), 0);
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal(h.sends.length, 0);
});

test('an optional sender allowlist restricts the automatic reply to matching authenticated senders', async (t) => {
  const h = await backend(t, { env: { ALLOWED_SENDER_PHONES: '971551234567' } });
  const rejected = message({ id: 'wamid.sender-not-allowed', from: '971561234567' });
  assert.equal((await h.post(payload([message(), rejected]))).status, 200);
  assert.equal(await h.store.getMessage(rejected.id), null);
  assert.equal(await h.store.getReply(rejected.id), null);
  assert.equal(await h.processor.processNextReply(), true);
  assert.equal(await h.processor.processNextReply(), false);
  assert.deepEqual(h.sends, [{ to: '+971551234567', text: AUTO_REPLY_TEXT }]);
});

test('enabling automatic replies does not retroactively reply to previously stored disabled-mode messages or their duplicates', async (t) => {
  const disabled = await backend(t, { env: { AUTOMATION_ENABLED: 'false' } });
  assert.equal((await disabled.post()).status, 200);
  const enabled = await backend(t, { store: disabled.store });
  assert.equal((await enabled.post()).status, 200);
  assert.equal(await enabled.store.getReply(message().id), null);
  assert.equal(await enabled.processor.processNextReply(), false);
  assert.equal((await enabled.post(payload([message({ id: 'wamid.new-after-enable' })]))).status, 200);
  assert.equal(await enabled.processor.processNextReply(), true);
  assert.equal(enabled.sends.length, 1);
  assert.equal(disabled.sends.length, 0);
});

test('automatic reply failures preserve delivery classification and never automatically resend the same message', async (t) => {
  for (const deliveryState of ['NOT_ATTEMPTED', 'ATTEMPTED_FAILED', 'UNKNOWN']) {
    const h = await backend(t, { send: async () => { throw Object.assign(new Error('private provider failure'), { deliveryState }); } });
    assert.equal((await h.post()).status, 200);
    assert.equal(await h.processor.processNextReply(), true);
    const reply = await h.store.getReply(message().id);
    assert.equal(reply.status, deliveryState === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED');
    assert.equal(reply.error_message, deliveryState);
    assert.equal(await h.processor.processNextReply(), false);
    assert.equal((await h.post()).status, 200);
    assert.equal(await h.processor.processNextReply(), false);
    assert.equal(h.sends.length, 1);
    assert.equal(JSON.stringify(h.logs).includes('private provider failure'), false);
  }
});

test('an accepted automatic reply whose completion cannot persist keeps reconciliation evidence and cannot send twice', async (t) => {
  const h = await backend(t);
  assert.equal((await h.post()).status, 200);
  h.store.finishReply = async () => false;
  assert.equal(await h.processor.processNextReply(), true);
  const reply = await h.store.getReply(message().id);
  assert.equal(reply.status, 'UNKNOWN');
  assert.equal(reply.provider_message_id, 'wamid.accepted-auto-reply');
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal((await h.post()).status, 200);
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal(h.sends.length, 1);
  assert.equal(h.logs.some(entry => entry.args[0]?.event === 'whatsapp_reply_sent'), false);
  assert.equal(h.logs.some(entry => entry.args[0]?.event === 'whatsapp_reply_reconciliation_required'), true);
});
