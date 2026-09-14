'use strict';

const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { createWorker } = require('../src/worker');
const { createBossLeadWorkflow } = require('../src/services/leads/bossLeadWorkflow');
const { createConversationProcessor } = require('../src/services/ai/conversationProcessor');
const { LEAD_FIELDS } = require('../src/services/ai/leadExtraction');
const { GREETING_REPLY, CONFIRMATION_REPLY, SAVED_REPLY } = require('../src/services/leads/bossConversation');
const { temporaryStore, testEnv, incoming } = require('./helpers');

const BOSS = '+971551234567';
const BUSINESS = '+971501111111';
const PHONE_ID = '1234567890';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const extraction = fields => ({ is_lead: true, lead: { ...Object.fromEntries(LEAD_FIELDS.map(field => [field, null])), ...fields } });

function envelope(messages = [], extra = {}) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID, display_phone_number: BUSINESS }, messages, ...extra,
  } }] }] };
}

async function setup(t, { store: suppliedStore, extract, download } = {}) {
  const store = suppliedStore || (await temporaryStore(t)).store;
  const logs = [], calls = [], sends = [], downloads = [], analyses = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, value => logs.push(value)]));
  const env = testEnv({ AUTOMATION_ENABLED: 'true', AI_PROVIDER: 'openai',
    META_APP_SECRET: 'synthetic-trigger-signature', WHATSAPP_ACCESS_TOKEN: 'synthetic-trigger-token',
    WHATSAPP_PHONE_NUMBER_ID: PHONE_ID, META_GRAPH_API_VERSION: 'v25.0', AUTHORIZED_BOSS_PHONES: BOSS,
    OPENAI_API_KEY: 'synthetic-trigger-ai-key', OPENAI_MODEL: 'synthetic-model', WORKER_POLL_MS: '50' });
  const app = createApp({ env, store, logger });
  await app.locals.ready;
  const { config, triggerGate } = app.locals;
  assert.ok(triggerGate, 'Every application runtime needs its own fresh-message trigger gate.');
  const ai = {
    async extractLeadEnquiry(text) {
      calls.push(text);
      return extract ? extract(text) : extraction({ company_name: 'Al Noor Contracting' });
    },
    generateReply() { assert.fail('No unrelated customer reply may be generated.'); },
    async extractMediaText({ type }) {
      analyses.push(type);
      return type === 'image' ? 'Contact person is Ahmed' : 'Quantity is 5';
    },
  };
  const whatsapp = {
    async sendTextMessage(to, text) { sends.push({ to, text }); return { messages: [{ id: 'wamid.sent-trigger-' + sends.length }] }; },
    async downloadMedia(id) {
      downloads.push(id);
      return download ? download(id) : { buffer: Buffer.from('synthetic private media'), mimeType: id === '10001' ? 'image/jpeg' : 'audio/ogg' };
    },
  };
  const processor = createBossLeadWorkflow({ store, config, logger, ai, whatsapp, triggerGate });
  const customer = createConversationProcessor({ store, config, logger, ai, whatsapp, triggerGate });
  const worker = createWorker({ store: { claimNext: options => store.claimLeadExtraction(options) }, processor, config, logger, triggerGate });
  const customerWorker = createWorker({ store, processor: customer, config, logger, triggerGate,
    inboxClaimOptions: { processingFlow: 'conversation' } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    triggerGate.close();
    await Promise.all([worker.stop(), customerWorker.stop()]);
    const stopped = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await stopped;
  }
  t.after(close);
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    store, config, processor, customer, triggerGate, logs, calls, sends, downloads, analyses, close,
    message(id, text = 'Al Noor Contracting', extra = {}) {
      return { id, from: BOSS.slice(1), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...extra };
    },
    async post(body) {
      const raw = JSON.stringify(body);
      const response = await fetch(base + '/webhook', { method: 'POST', body: raw,
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', config.appSecret).update(raw).digest('hex') } });
      assert.equal(response.status, 200);
      await response.text();
    },
    async verify() {
      const query = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': config.verifyToken, 'hub.challenge': 'trigger-verification' });
      const response = await fetch(base + '/webhook?' + query);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'trigger-verification');
    },
    async process() {
      const job = await store.claimLeadExtraction({ messageIds: triggerGate.messageIds(), maxAttempts: 1, leaseMs: config.leaseMs });
      if (job) await processor.processIncomingWhatsAppMessage(job);
      return job;
    },
    async drain() {
      for (let index = 0; index < 20; index++) if (!(await processor.processNextReply())) return;
      assert.fail('Fresh-message outbox did not drain within its bound.');
    },
    async poll() {
      worker.start();
      customerWorker.start();
      await pause(config.pollMs * 3 + 20);
    },
  };
}

test('startup and idle polls leave previously enabled jobs and pending replies intact without AI or sends', async t => {
  const { store } = await temporaryStore(t);
  const oldBoss = incoming({ whatsapp_message_id: 'old-boss-reply', sender_phone: BOSS, message_text: 'Hi', request_lead_workflow: true });
  await store.enqueueMany([oldBoss], { processingFlow: 'conversation' });
  const bossJob = await store.claimLeadExtraction();
  await store.completeLeadSessionTurn(bossJob.message_id, bossJob.lease_token, { kind: 'greeting', replyText: GREETING_REPLY });
  const oldCustomer = incoming({ whatsapp_message_id: 'old-customer-reply', sender_phone: '+971561234567' });
  await store.enqueueMany([oldCustomer], { processingFlow: 'conversation' });
  const customerJob = await store.claimNext({ processingFlow: 'conversation' });
  await store.completeWithReply(customerJob.whatsapp_message_id, customerJob.lease_token, { processing_status: 'SUCCESS' }, 'A previous generated reply');
  await store.enqueueMany(['received', 'retrying', 'abandoned'].map(state => incoming({
    whatsapp_message_id: 'old-' + state, sender_phone: BOSS, request_lead_workflow: true,
  })), { processingFlow: 'conversation' });
  await store.driver.query("UPDATE lead_extractions SET processing_status='FAILED',attempts=1,next_attempt_at=? WHERE message_id='old-retrying'", [new Date(Date.now() - 1000).toISOString()]);
  await store.driver.query("UPDATE lead_extractions SET processing_status='PROCESSING',attempts=1,lease_token='prior-runtime',lease_expires_at=? WHERE message_id='old-abandoned'", [new Date(Date.now() - 1000).toISOString()]);
  const before = await store.listConversationMessages(BOSS);
  const h = await setup(t, { store });
  await h.poll();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sends, []);
  assert.equal((await store.getReply('old-boss-reply')).status, 'PENDING');
  assert.equal((await store.getReply('old-customer-reply')).status, 'PENDING');
  assert.deepEqual(await store.listConversationMessages(BOSS), before);
  const fresh = h.message('fresh-after-startup', 'Hi');
  await h.post(envelope([fresh]));
  await h.poll();
  assert.deepEqual(h.sends.map(reply => reply.text), [GREETING_REPLY]);
  assert.equal((await store.getReply('old-boss-reply')).status, 'PENDING');
  assert.equal((await store.getReply('old-customer-reply')).status, 'PENDING');
});

test('one fresh greeting sends once despite concurrent duplicates, idle polls and a new app runtime', async t => {
  const h = await setup(t);
  const greeting = h.message('one-greeting', 'Hi');
  await Promise.all(Array.from({ length: 4 }, () => h.post(envelope([greeting, greeting]))));
  await h.poll();
  await h.post(envelope([greeting]));
  await h.poll();
  assert.deepEqual(h.sends.map(reply => reply.text), [GREETING_REPLY]);
  assert.deepEqual(h.calls, []);
  assert.equal(await h.store.getActiveLeadSession(BOSS), null);
  await h.close();
  const reopened = await setup(t, { store: h.store });
  await reopened.post(envelope([greeting]));
  await reopened.poll();
  assert.deepEqual(reopened.sends, []);
  assert.deepEqual(reopened.calls, []);
});

test('verification, delivery statuses and self or outgoing echoes never authorize a reply', async t => {
  const h = await setup(t);
  await h.verify();
  await h.post(envelope([], { statuses: ['sent', 'delivered', 'read', 'failed'].map(status => ({ id: 'wamid.outgoing', status })) }));
  const echoes = [
    { from: BUSINESS.slice(1) }, { from_me: true }, { fromMe: true }, { is_echo: true }, { direction: 'outgoing' },
  ].map((extra, index) => h.message('echo-' + index, 'Hi', extra));
  await h.post(envelope(echoes));
  await h.poll();
  assert.deepEqual(h.triggerGate.messageIds(), []);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sends, []);
  assert.equal((await h.store.listConversationMessages(BOSS)).total, 0);
});

test('a delayed historical receipt with a previously unknown ID cannot become a new AI trigger', async t => {
  const h = await setup(t);
  const messages = [2, 600].map(age => h.message('delayed-' + age, 'Al Noor Contracting', {
    timestamp: String(Math.floor(Date.now() / 1000) - age),
  }));
  await h.post(envelope(messages));
  await h.poll();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sends, []);
  for (const message of messages) assert.equal(await h.store.getMessage(message.id), null);
});

test('non-boss image and audio receipts retain history without occupying fresh-message triggers', async t => {
  const h = await setup(t);
  const customer = '+971561234567';
  const messages = [
    h.message('customer-image', '', { from: customer.slice(1), type: 'image', image: { id: '10001', mime_type: 'image/jpeg' } }),
    h.message('customer-audio', '', { from: customer.slice(1), type: 'audio', audio: { id: '10002', mime_type: 'audio/ogg', voice: true } }),
  ];
  await h.post(envelope(messages));
  assert.deepEqual(h.triggerGate.messageIds(), []);
  await h.poll();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.downloads, []);
  assert.deepEqual(h.analyses, []);
  assert.deepEqual(h.sends, []);
  const history = await h.store.listConversationMessages(customer);
  assert.equal(history.total, 2);
  for (const message of messages) {
    const stored = await h.store.getMessage(message.id);
    assert.equal(stored.sender_phone, customer);
    assert.equal(stored.message_type, message.type);
    assert.equal(stored.media_id, message[message.type].id);
    assert.equal(stored.processing_flow, null);
    assert.equal(await h.store.getReply(message.id), null);
  }
  const fresh = h.message('boss-after-customer-media');
  await h.post(envelope([fresh]));
  await h.poll();
  assert.deepEqual(h.calls, ['Al Noor Contracting']);
  assert.deepEqual(h.sends.map(reply => reply.text), [CONFIRMATION_REPLY]);
  assert.equal((await h.store.getActiveLeadSession(BOSS)).result.lead.company_name, 'Al Noor Contracting');
});

test('each fresh text, image and voice message merges into one draft and explicit confirmation saves once', async t => {
  const h = await setup(t, { extract: text => extraction(text.includes('Al Noor') ? { company_name: 'Al Noor Contracting' }
    : text.includes('Ahmed') ? { contact_name: 'Ahmed' } : { quantity: '5' }) });
  const messages = [h.message('text-fact'),
    h.message('image-fact', '', { type: 'image', image: { id: '10001', mime_type: 'image/jpeg' } }),
    h.message('voice-fact', '', { type: 'audio', audio: { id: '10002', mime_type: 'audio/ogg', voice: true } })];
  await h.post(envelope(messages));
  for (const message of messages) assert.equal((await h.process()).message_id, message.id);
  assert.equal(await h.process(), null);
  const draft = await h.store.getActiveLeadSession(BOSS);
  assert.equal(draft.state, 'awaiting_confirmation');
  assert.equal(draft.result.lead.company_name, 'Al Noor Contracting');
  assert.equal(draft.result.lead.contact_name, 'Ahmed');
  assert.equal(draft.result.lead.quantity, '5');
  assert.equal((await h.store.listLeads()).total, 0);
  assert.equal((await h.store.getMessage('image-fact')).extracted_text, 'Contact person is Ahmed');
  assert.equal((await h.store.getMessage('voice-fact')).transcription, 'Quantity is 5');
  const save = h.message('fresh-confirmation', 'Save it');
  await h.post(envelope([save]));
  await h.process();
  await h.drain();
  await h.post(envelope([...messages, save]));
  await h.poll();
  assert.deepEqual(h.calls, ['Al Noor Contracting', 'Contact person is Ahmed', 'Quantity is 5']);
  assert.deepEqual(h.downloads, ['10001', '10002']);
  assert.deepEqual(h.analyses, ['image', 'audio']);
  assert.deepEqual(h.sends.map(reply => reply.text), [CONFIRMATION_REPLY, CONFIRMATION_REPLY, CONFIRMATION_REPLY, SAVED_REPLY]);
  const leads = await h.store.listLeads();
  assert.equal(leads.total, 1);
  assert.equal(leads.items[0].quantity, '5');
  assert.equal(leads.items[0].zoho_status, 'not_started');
  assert.equal(await h.store.getActiveLeadSession(BOSS), null);
});

test('closing the runtime while AI is pending fences its late result and every outbound reply', async t => {
  let resolve;
  const h = await setup(t, { extract: () => new Promise(done => { resolve = done; }) });
  const message = h.message('pending-ai');
  await h.post(envelope([message]));
  const processing = h.process();
  const deadline = Date.now() + 2000;
  while (!resolve && Date.now() < deadline) await pause(5);
  assert.ok(resolve, 'The fresh message should start one extraction.');
  await h.post(envelope([message]));
  assert.equal(await h.process(), null);
  assert.equal(await h.processor.processNextReply(), false);
  h.triggerGate.close();
  resolve(extraction({ company_name: 'Al Noor Contracting' }));
  await processing;
  await h.poll();
  assert.deepEqual(h.calls, ['Al Noor Contracting']);
  assert.deepEqual(h.sends, []);
  assert.equal(await h.store.getReply(message.id), null);
  assert.equal(await h.store.getActiveLeadSession(BOSS), null);
  assert.equal((await h.store.listLeads()).total, 0);
});

test('a transient extraction failure never schedules another AI attempt without a new incoming message', async t => {
  let attempts = 0;
  const h = await setup(t, { extract: () => {
    if (++attempts === 1) throw Object.assign(new Error('synthetic provider timeout'), { code: 'AI_TIMEOUT', retryable: true });
    return extraction({ company_name: 'Al Noor Contracting' });
  } });
  const failed = h.message('transient-failure');
  await h.post(envelope([failed]));
  await h.poll();
  const savedFailure = await h.store.getLeadExtraction(failed.id);
  assert.equal(savedFailure.attempts, 1);
  assert.equal(savedFailure.next_attempt_at, null, 'A retry timer must not authorize a second AI request.');
  assert.equal(h.calls.length, 1);
  assert.equal(h.sends.length, 1);
  assert.doesNotMatch(h.sends[0].text, /saved successfully/i);
  await h.post(envelope([failed, failed]));
  await h.poll();
  assert.equal(h.calls.length, 1);
  assert.equal(h.sends.length, 1);
  const fresh = h.message('new-message-after-failure');
  await h.post(envelope([fresh]));
  await h.poll();
  assert.equal(h.calls.length, 2);
  assert.equal((await h.store.getLeadExtraction(fresh.id)).attempts, 1);
  assert.equal((await h.store.getActiveLeadSession(BOSS)).result.lead.company_name, 'Al Noor Contracting');
  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[1].text, CONFIRMATION_REPLY);
});

test('shutdown during a media download prevents later OCR, extraction, draft writes and replies', async t => {
  let resolve;
  const h = await setup(t, { download: () => new Promise(done => { resolve = done; }) });
  const message = h.message('pending-image-download', '', { type: 'image', image: { id: '10001', mime_type: 'image/jpeg' } });
  await h.post(envelope([message]));
  const processing = h.process();
  const deadline = Date.now() + 2000;
  while (!resolve && Date.now() < deadline) await pause(5);
  assert.ok(resolve, 'The fresh image should start one download.');
  h.triggerGate.close();
  resolve({ buffer: Buffer.from('synthetic pending image'), mimeType: 'image/jpeg' });
  await processing;
  await h.poll();
  assert.deepEqual(h.downloads, ['10001']);
  assert.deepEqual(h.analyses, []);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sends, []);
  assert.equal((await h.store.getMessage(message.id)).extracted_text, null);
  assert.equal(await h.store.getReply(message.id), null);
  assert.equal(await h.store.getActiveLeadSession(BOSS), null);
});
