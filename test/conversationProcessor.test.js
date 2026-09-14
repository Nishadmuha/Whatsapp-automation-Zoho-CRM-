'use strict';

const assert = require('node:assert/strict');
const { createHmac, randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { createConversationProcessor } = require('../src/services/ai/conversationProcessor');
const { temporaryStore, testEnv, incoming } = require('./helpers');

function message(overrides = {}) {
  return { id: 'wamid.conversation-test', from: '971551234567', type: 'text',
    text: { body: 'Can you help with AC maintenance?' }, timestamp: String(Math.floor(Date.now() / 1000)), ...overrides };
}
function payload(messages = [message()]) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: '1234567890' }, messages,
  } }] }] };
}
async function setup(t, { enabled = true, generate, send, store: suppliedStore } = {}) {
  const store = suppliedStore || (await temporaryStore(t)).store;
  const env = testEnv({ AUTOMATION_ENABLED: String(enabled), AI_PROVIDER: 'openai',
    META_APP_SECRET: randomBytes(32).toString('hex'), WHATSAPP_ACCESS_TOKEN: 'mock-whatsapp-token',
    WHATSAPP_PHONE_NUMBER_ID: '1234567890', META_GRAPH_API_VERSION: 'v25.0',
    OPENAI_API_KEY: 'mock-openai-key', OPENAI_MODEL: 'mock-model' });
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, record => logs.push(record)]));
  const app = createApp({ env, store, logger });
  await app.locals.ready;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const generations = [];
  const sends = [];
  const ai = { async generateReply(text) {
    generations.push(text);
    return generate ? generate(text) : 'Thank you for contacting Voltronix. What type of maintenance do you need?';
  } };
  const whatsapp = { async sendTextMessage(to, text) {
    sends.push({ to, text });
    return send ? send(to, text) : { messages: [{ id: 'wamid.mock-generated-reply' }] };
  } };
  const config = app.locals.config;
  const processor = createConversationProcessor({ store, ai, whatsapp, config, logger });
  return { store, config, processor, logs, generations, sends, ai, whatsapp, logger,
    async process() {
      const job = await store.claimNext({ processingFlow: 'conversation', leaseMs: config.leaseMs, maxAttempts: config.maxAttempts });
      if (job) await processor.processIncomingWhatsAppMessage(job);
      return job;
    },
    async post(body = payload(), signed = true) {
      const raw = JSON.stringify(body);
      const headers = { 'Content-Type': 'application/json' };
      if (signed) headers['X-Hub-Signature-256'] = 'sha256=' + createHmac('sha256', config.appSecret).update(raw).digest('hex');
      return fetch('http://127.0.0.1:' + server.address().port + '/webhook', { method: 'POST', headers, body: raw });
    },
  };
}

test('signed conversational text commits before ACK, generates once, and sends once through the outbox', async t => {
  const h = await setup(t);
  const responses = await Promise.all(Array.from({ length: 6 }, () => h.post()));
  responses.forEach(response => assert.equal(response.status, 200));
  assert.equal(h.generations.length, 0);
  assert.equal(h.sends.length, 0);
  assert.equal((await h.store.getMessage(message().id)).processing_flow, 'conversation');
  assert.equal(await h.store.getReply(message().id), null);
  await Promise.all(Array.from({ length: 6 }, () => h.process()));
  assert.deepEqual(h.generations, [message().text.body]);
  assert.equal((await h.store.getReply(message().id)).status, 'PENDING');
  await Promise.all(Array.from({ length: 6 }, () => h.processor.processNextReply()));
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].to, '+971551234567');
  assert.equal((await h.store.getReply(message().id)).status, 'SENT');
  const stored = await h.store.getMessage(message().id);
  assert.equal(stored.processing_status, 'SUCCESS');
  assert.equal(stored.extracted_lead_data, null);
  assert.equal(stored.zoho_lead_id, null);
  assert.equal(stored.crm_write_started, false);
  assert.equal((await h.post()).status, 200);
  assert.equal(await h.process(), null);
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal(h.generations.length, 1);
  assert.equal(h.sends.length, 1);
});

test('disabled automation and old disabled receipts cannot trigger AI when later enabled', async t => {
  const disabled = await setup(t, { enabled: false });
  assert.equal((await disabled.post()).status, 200);
  assert.equal(await disabled.process(), null);
  await disabled.processor.processIncomingWhatsAppMessage(incoming({ processing_flow: 'conversation' }));
  assert.equal(await disabled.processor.processNextReply(), false);
  const enabled = await setup(t, { store: disabled.store });
  assert.equal((await enabled.post()).status, 200);
  assert.equal(await enabled.process(), null);
  assert.equal((await enabled.store.getMessage(message().id)).processing_flow, null);
  assert.equal(disabled.generations.length + enabled.generations.length, 0);
  assert.equal(disabled.sends.length + enabled.sends.length, 0);
});

test('invalid HMAC, unsupported types, status events and messages beyond parser limits never reach AI', async t => {
  const h = await setup(t);
  assert.equal((await h.post(payload(), false)).status, 403);
  const status = payload([]);
  status.entry[0].changes[0].value.statuses = [{ status: 'delivered', id: 'wamid.other' }];
  for (const body of [status, payload([message({ type: 'image' })]), payload([message({ type: 'audio' })]),
    payload([message({ text: { body: 'x'.repeat(4097) } })])]) {
    assert.equal((await h.post(body)).status, 200);
  }
  assert.equal(await h.process(), null);
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal(h.generations.length, 0);
  assert.equal(h.sends.length, 0);
});

test('excessively long accepted messages are retained but fail safely before any AI or WhatsApp call', async t => {
  const h = await setup(t);
  assert.equal((await h.post(payload([message({ text: { body: 'x'.repeat(4001) } })]))).status, 200);
  await h.process();
  const stored = await h.store.getMessage(message().id);
  assert.equal(stored.processing_status, 'FAILED');
  assert.equal(stored.error_message, 'AI_INPUT_INVALID');
  assert.equal(stored.next_attempt_at, null);
  assert.equal(await h.store.getReply(message().id), null);
  assert.equal(h.generations.length, 0);
  assert.equal(h.sends.length, 0);
});

test('transient OpenAI failures use bounded durable retries and only one eventual WhatsApp reply', async t => {
  let attempts = 0;
  const h = await setup(t, { generate: async () => {
    if (++attempts < 3) throw Object.assign(new Error('private response and secret'), { code: 'AI_TIMEOUT', retryable: true });
    return 'How can Voltronix help with your project?';
  } });
  assert.equal((await h.post()).status, 200);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await h.process();
    const stored = await h.store.getMessage(message().id);
    assert.equal(stored.attempts, attempt);
    assert.equal(stored.processing_status, 'FAILED');
    assert.ok(Date.parse(stored.next_attempt_at) > Date.now());
    assert.equal(stored.processed_at, null);
    assert.equal(await h.process(), null);
    assert.equal(await h.store.getReply(message().id), null);
    await h.store.driver.query('UPDATE whatsapp_messages SET next_attempt_at=? WHERE whatsapp_message_id=?',
      [new Date(Date.now() - 1000).toISOString(), message().id]);
  }
  await h.process();
  await h.processor.processNextReply();
  assert.equal(attempts, 3);
  assert.equal(h.sends.length, 1);
  assert.equal((await h.store.getReply(message().id)).status, 'SENT');
  assert.equal(JSON.stringify(h.logs).includes('private response'), false);
});

test('exhausted retries stop without a customer error reply or another AI attempt', async t => {
  const h = await setup(t, { generate: async () => { throw Object.assign(new Error('private'), { code: 'AI_RATE_LIMIT', retryable: true }); } });
  h.config.maxAttempts = 2;
  assert.equal((await h.post()).status, 200);
  await h.process();
  await h.store.driver.query('UPDATE whatsapp_messages SET next_attempt_at=? WHERE whatsapp_message_id=?',
    [new Date(Date.now() - 1000).toISOString(), message().id]);
  await h.process();
  const stored = await h.store.getMessage(message().id);
  assert.equal(stored.attempts, 2);
  assert.equal(stored.next_attempt_at, null);
  assert.ok(stored.processed_at);
  assert.equal(await h.process(), null);
  assert.equal(h.generations.length, 2);
  assert.equal(h.sends.length, 0);
});

test('authentication, exhausted quota, configuration and malformed failures do not retry or escape into the webhook', async t => {
  for (const code of ['AI_AUTHENTICATION_ERROR', 'AI_RATE_LIMIT', 'AI_CONFIGURATION_ERROR', 'AI_MALFORMED_RESPONSE']) {
    const h = await setup(t, { generate: async () => { throw Object.assign(new Error('private-key and customer-body'), { code, retryable: false }); } });
    assert.equal((await h.post()).status, 200);
    await h.process();
    assert.equal((await h.post()).status, 200);
    const stored = await h.store.getMessage(message().id);
    assert.equal(stored.processing_status, 'FAILED');
    assert.equal(stored.error_message, code);
    assert.equal(stored.next_attempt_at, null);
    assert.equal(await h.process(), null);
    assert.equal(await h.processor.processNextReply(), false);
    assert.equal(h.generations.length, 1);
    assert.equal(h.sends.length, 0);
    assert.equal(JSON.stringify(h.logs).includes('private-key'), false);
  }
});

test('malformed mocked AI outputs are independently rejected before outbox persistence', async t => {
  for (const reply of ['', null, {}, 'x'.repeat(1001), 'unsafe\0reply']) {
    const h = await setup(t, { generate: async () => reply });
    assert.equal((await h.post()).status, 200);
    await h.process();
    assert.equal((await h.store.getMessage(message().id)).error_message, 'AI_MALFORMED_RESPONSE');
    assert.equal(await h.store.getReply(message().id), null);
    assert.equal(h.sends.length, 0);
  }
});

test('lease loss while OpenAI is pending prevents stale generation from queuing or sending', async t => {
  let resolve;
  const h = await setup(t, { generate: () => new Promise(done => { resolve = done; }) });
  assert.equal((await h.post()).status, 200);
  const processing = h.process();
  while (!resolve) await new Promise(done => setImmediate(done));
  await h.store.driver.query('UPDATE whatsapp_messages SET lease_token=? WHERE whatsapp_message_id=?', ['replacement-lease', message().id]);
  resolve('This stale response must not be sent.');
  await processing;
  assert.equal(await h.store.getReply(message().id), null);
  assert.equal(h.sends.length, 0);
  assert.ok(h.logs.some(record => record.event === 'ai_reply_lease_lost'));
});

test('a persisted AI outbox reply survives worker replacement without regeneration', async t => {
  const h = await setup(t);
  assert.equal((await h.post()).status, 200);
  await h.process();
  const restarted = createConversationProcessor({ store: h.store, config: h.config, logger: h.logger,
    whatsapp: h.whatsapp, ai: { generateReply() { assert.fail('Persisted replies must not regenerate'); } } });
  assert.equal(await restarted.processNextReply(), true);
  assert.equal(await restarted.processNextReply(), false);
  assert.equal(h.generations.length, 1);
  assert.equal(h.sends.length, 1);
  assert.equal((await h.store.getReply(message().id)).status, 'SENT');
});

test('failure before saving an AI result schedules bounded recovery without sending', async t => {
  const h = await setup(t);
  assert.equal((await h.post()).status, 200);
  const complete = h.store.completeWithReply.bind(h.store);
  h.store.completeWithReply = async () => { throw new Error('private database credential'); };
  await h.process();
  const stored = await h.store.getMessage(message().id);
  assert.equal(stored.processing_status, 'FAILED');
  assert.equal(stored.error_message, 'AI_RESULT_PERSISTENCE_FAILED');
  assert.ok(stored.next_attempt_at);
  assert.equal(await h.store.getReply(message().id), null);
  assert.equal(h.sends.length, 0);
  h.store.completeWithReply = complete;
  await h.store.driver.query('UPDATE whatsapp_messages SET next_attempt_at=? WHERE whatsapp_message_id=?',
    [new Date(Date.now() - 1000).toISOString(), message().id]);
  await h.process();
  await h.processor.processNextReply();
  assert.equal(h.generations.length, 2);
  assert.equal(h.sends.length, 1);
  assert.equal(JSON.stringify(h.logs).includes('private database'), false);
});

test('a lost database acknowledgement after commit never regenerates or duplicates the persisted reply', async t => {
  const h = await setup(t);
  assert.equal((await h.post()).status, 200);
  const complete = h.store.completeWithReply.bind(h.store);
  h.store.completeWithReply = async (...args) => {
    await complete(...args);
    throw new Error('Acknowledgement lost after commit');
  };
  await h.process();
  assert.equal((await h.store.getMessage(message().id)).processing_status, 'SUCCESS');
  assert.equal((await h.store.getReply(message().id)).status, 'PENDING');
  assert.equal(await h.process(), null);
  assert.equal(await h.processor.processNextReply(), true);
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal(h.generations.length, 1);
  assert.equal(h.sends.length, 1);
});

test('turning off the master switch while generation is pending cannot queue or send its result', async t => {
  let resolve;
  const h = await setup(t, { generate: () => new Promise(done => { resolve = done; }) });
  assert.equal((await h.post()).status, 200);
  const processing = h.process();
  while (!resolve) await new Promise(done => setImmediate(done));
  h.config.enabled = false;
  resolve('A reply generated before the master switch changed.');
  await processing;
  assert.equal(await h.store.getReply(message().id), null);
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal(h.sends.length, 0);
});

test('changing the sender allowlist before dispatch prevents delivery of a generated reply', async t => {
  const h = await setup(t);
  assert.equal((await h.post()).status, 200);
  await h.process();
  h.config.allowedSenders.add('+971561234567');
  assert.equal(await h.processor.processNextReply(), true);
  assert.equal((await h.store.getReply(message().id)).status, 'FAILED');
  assert.equal(h.sends.length, 0);
});

test('an ambiguous WhatsApp send keeps UNKNOWN state and never regenerates or resends', async t => {
  const h = await setup(t, { send: async () => { throw Object.assign(new Error('private provider response'), { deliveryState: 'UNKNOWN' }); } });
  assert.equal((await h.post()).status, 200);
  await h.process();
  assert.equal(await h.processor.processNextReply(), true);
  assert.equal((await h.store.getReply(message().id)).status, 'UNKNOWN');
  assert.equal((await h.post()).status, 200);
  assert.equal(await h.process(), null);
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal(h.generations.length, 1);
  assert.equal(h.sends.length, 1);
});

test('historical webhooks and expired stored messages stop before generation and legacy CRM replies cannot be dispatched', async t => {
  const h = await setup(t);
  assert.equal((await h.post(payload([message({ timestamp: String(Math.floor(Date.now() / 1000) - 24 * 3600) })]))).status, 200);
  assert.equal(await h.process(), null);
  assert.equal(await h.store.getMessage(message().id), null, 'Historical deliveries are ignored before inbox insertion.');
  const expired = incoming({ whatsapp_message_id: 'wamid.already-stored-expired', received_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString() });
  await h.store.enqueueMany([expired], { processingFlow: 'conversation' });
  assert.equal(await h.process(), null);
  assert.equal((await h.store.getMessage(expired.whatsapp_message_id)).error_message, 'CUSTOMER_SERVICE_WINDOW_EXPIRED');
  const legacy = incoming({ whatsapp_message_id: 'wamid.legacy-crm' });
  await h.store.enqueueMany([legacy]);
  const job = await h.store.claimNext();
  await h.store.completeWithReply(job.whatsapp_message_id, job.lease_token,
    { processing_status: 'SUCCESS', processed_at: new Date().toISOString() }, 'A preserved CRM confirmation.');
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal((await h.store.getReply(legacy.whatsapp_message_id)).status, 'PENDING');
  assert.equal(h.generations.length, 0);
  assert.equal(h.sends.length, 0);
});

test('client asking for contact number directly receives boss contact details', async t => {
  const h = await setup(t);
  h.config.bossSenders = new Set(['+971502420957']);
  const contactMsg = message({ id: 'wamid.contact-query', text: { body: 'give m contact number or i need contact number / contact deatiles' } });
  assert.equal((await h.post(payload([contactMsg]))).status, 200);
  await h.process();
  const reply = await h.store.getReply('wamid.contact-query');
  assert.ok(reply, 'Reply must be queued');
  assert.ok(reply.text.includes('+971 50 242 0957'), 'Reply must include boss contact number');
  assert.equal(h.generations.length, 0, 'Direct contact query should not require external AI generation');
  await h.processor.processNextReply();
  assert.equal(h.sends.length, 1);
  assert.ok(h.sends[0].text.includes('+971 50 242 0957'));
});

