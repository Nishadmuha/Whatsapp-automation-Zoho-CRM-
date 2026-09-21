'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { temporaryStore, incoming, silent } = require('./helpers');
const { createBossLeadWorkflow } = require('../src/services/leads/bossLeadWorkflow');
const { createIncomingTriggerGate } = require('../src/services/whatsapp/incomingTriggerGate');
const { createAcknowledgementBatcher, isBossBatchBoundary } = require('../src/services/whatsapp/messageBatching');
const { LEAD_FIELDS } = require('../src/services/ai/leadExtraction');
const { createBooksWorker } = require('../src/services/books/booksWorker');
const { fixture, WORKER } = require('./billFixtures');
const { readConfig } = require('../src/config/env');

const BOSS = '+971551234567';
const QUIET_MS = 100;

test('message batching uses a validated configurable quiet window', () => {
  const base = { NODE_ENV: 'test', AUTOMATION_ENABLED: 'false', WEBHOOK_VERIFY_TOKEN: 'x'.repeat(32) };
  assert.equal(readConfig(base).messageBatchQuietMs, 5000);
  assert.equal(readConfig({ ...base, MESSAGE_BATCH_QUIET_MS: '750' }).messageBatchQuietMs, 750);
  for (const value of ['0', '99', '60001', 'nope']) {
    assert.throws(() => readConfig({ ...base, MESSAGE_BATCH_QUIET_MS: value }), /MESSAGE_BATCH_QUIET_MS/);
  }
});

test('acknowledgement grouping is stable within a batch and splits on boundaries or timeout', () => {
  let time = 1000;
  const batcher = createAcknowledgementBatcher({ quietMs: 500, now: () => time });
  const message = id => ({ messageId: id, senderPhone: BOSS });
  assert.equal(batcher.groupFor(message('first')), 'first');
  time += 100;
  assert.equal(batcher.groupFor(message('second')), 'first');
  time += 100;
  assert.equal(batcher.groupFor(message('save'), { boundary: true }), 'save');
  time += 100;
  assert.equal(batcher.groupFor(message('next')), 'next');
  time += 500;
  assert.equal(batcher.groupFor(message('later')), 'later');
});

async function bossHarness(t) {
  const { store } = await temporaryStore(t);
  let time = Date.now();
  t.mock.method(store, '_now', async () => new Date(time).toISOString());
  const triggerGate = createIncomingTriggerGate({ now: () => time });
  const sends = [], leadInputs = [], mediaInputs = [];
  const ai = {
    async extractLeadEnquiry(text) {
      leadInputs.push(text);
      return { is_lead: true, lead: {
        ...Object.fromEntries(LEAD_FIELDS.map(field => [field, null])),
        company_name: 'Batch Company', requirement: text.slice(0, 1000),
      } };
    },
    async extractMediaText({ buffer, type }) {
      mediaInputs.push(type);
      if (buffer.toString() === 'FAIL') throw new Error('Unreadable fixture');
      return buffer.toString();
    },
  };
  const media = new Map([
    ['image-1', { text: 'image facts', mimeType: 'image/jpeg' }],
    ['document-1', { text: 'document facts', mimeType: 'application/pdf' }],
    ['audio-1', { text: 'voice facts', mimeType: 'audio/ogg' }],
    ['failed-1', { text: 'FAIL', mimeType: 'image/jpeg' }],
  ]);
  const whatsapp = {
    async downloadMedia(id) {
      const item = media.get(id);
      return { buffer: Buffer.from(item.text), mimeType: item.mimeType };
    },
    async sendTextMessage(to, text) {
      sends.push({ to, text });
      return { messages: [{ id: `wamid.batch-reply-${sends.length}` }] };
    },
  };
  const config = { enabled: true, aiProvider: 'openai', bossSenders: new Set([BOSS]), allowedSenders: new Set(),
    leaseMs: 30000, maxAttempts: 3, bossReplyQuietMs: QUIET_MS, messageBatchQuietMs: QUIET_MS };
  const workflow = createBossLeadWorkflow({ store, ai, whatsapp, config, logger: silent, triggerGate });
  let sequence = 0;
  async function receive({ type = 'text', text = '', mediaId = null, mimeType = null, id } = {}) {
    const message = incoming({ whatsapp_message_id: id || `wamid.batch-${++sequence}`, sender_phone: BOSS,
      message_text: text, message_type: type, media_id: mediaId, media_mime_type: mimeType,
      request_lead_workflow: true, received_at: new Date(time).toISOString() });
    await store.enqueueMany([message], { processingFlow: 'conversation' });
    triggerGate.admit(message.whatsapp_message_id, String(Math.floor(time / 1000)));
    return message;
  }
  async function processBatch() {
    time += QUIET_MS;
    const job = await store.claimLeadExtraction({ messageIds: triggerGate.messageIds(), leaseMs: config.leaseMs,
      maxAttempts: 1, batchQuietMs: QUIET_MS, batchBoundary: isBossBatchBoundary });
    assert.ok(job);
    await workflow.processIncomingWhatsAppMessage(job);
    assert.equal(await workflow.processNextReply(), true);
    assert.equal(await workflow.processNextReply(), false);
    return job;
  }
  return { store, triggerGate, workflow, sends, leadInputs, mediaInputs, receive, processBatch };
}

const bossCases = [
  ['Boss text only produces one final reply', [{ text: 'text facts' }], 0],
  ['Boss image only produces one final reply', [{ type: 'image', mediaId: 'image-1', mimeType: 'image/jpeg' }], 1],
  ['Boss text plus image produces one extraction and one final reply', [{ text: 'text facts' }, { type: 'image', mediaId: 'image-1', mimeType: 'image/jpeg' }], 1],
  ['Boss text, image and document produce one extraction and one final reply', [{ text: 'text facts' }, { type: 'image', mediaId: 'image-1', mimeType: 'image/jpeg' }, { type: 'document', mediaId: 'document-1', mimeType: 'application/pdf' }], 2],
  ['Boss text, image, document and voice produce one extraction and one final reply', [{ text: 'text facts' }, { type: 'image', mediaId: 'image-1', mimeType: 'image/jpeg' }, { type: 'document', mediaId: 'document-1', mimeType: 'application/pdf' }, { type: 'audio', mediaId: 'audio-1', mimeType: 'audio/ogg' }], 3],
];
for (const [name, messages, expectedMedia] of bossCases) test(name, async t => {
  const h = await bossHarness(t);
  for (const message of messages) await h.receive(message);
  await h.processBatch();
  assert.equal(h.sends.length, 1);
  assert.equal(h.leadInputs.length, 1);
  assert.equal(h.mediaInputs.length, expectedMedia);
  for (const expected of ['text facts', 'image facts', 'document facts', 'voice facts']) {
    if (messages.some(item => item.text === expected || item.mediaId?.startsWith(expected.split(' ')[0]))) {
      assert.match(h.leadInputs[0], new RegExp(expected));
    }
  }
});

function booksHarness(t, items, { failMediaId = null, holdMedia = false } = {}) {
  const f = fixture();
  let claim = true;
  const jobs = items.map((item, index) => ({
    job_id: `job-${index}`, message_id: `message-${index}`, worker_phone: WORKER,
    lease_token: `lease-${index}`, payload: {
      message_type: item.type || 'text', message_text: item.text || '', media_id: item.mediaId || null,
      media_mime_type: item.mimeType || null, media_filename: item.filename || null,
    },
  }));
  const completions = [];
  const replyReservations = new Set();
  const queue = {
    async claimBillExtraction() { if (!claim) return null; claim = false; return { ...jobs[0], batch_items: jobs }; },
    async heartbeatBillExtraction() { return true; },
    async reserveBillReply(jobId) {
      if (replyReservations.has(jobId)) return false;
      replyReservations.add(jobId);
      return true;
    },
    async finishBillReply() { return true; },
    async completeBillExtraction(...args) { completions.push(args); return true; },
    async failBillExtraction() { return true; },
  };
  t.mock.method(f.whatsapp, 'downloadMedia', async id => ({ buffer: Buffer.from(id),
    mimeType: items.find(item => item.mediaId === id)?.mimeType || 'image/jpeg' }));
  let activeMedia = 0, maxActiveMedia = 0;
  t.mock.method(f.ai, 'extractMediaText', async ({ buffer }) => {
    f.calls.push(['ocr', buffer.toString()]);
    activeMedia += 1;
    maxActiveMedia = Math.max(maxActiveMedia, activeMedia);
    if (holdMedia) await new Promise(resolve => setTimeout(resolve, 20));
    activeMedia -= 1;
    if (buffer.toString() === failMediaId) throw new Error('Unreadable fixture');
    return `${buffer.toString()} extracted bill facts`;
  });
  const worker = createBooksWorker({ billStore: queue, billWorkflow: f.workflow, whatsapp: f.whatsapp,
    config: { enabled: true, leaseMs: 30000, maxAttempts: 3, messageBatchQuietMs: QUIET_MS },
    logger: silent, triggerGate: { allows: () => true, finish() {} } });
  return { ...f, worker, completions, getMaxActiveMedia: () => maxActiveMedia };
}

const booksCases = [
  ['Worker text only produces one final reply', [{ text: 'typed bill facts' }], 0],
  ['Worker image only produces one final reply', [{ type: 'image', mediaId: 'image', mimeType: 'image/jpeg' }], 1],
  ['Worker text plus image produces one extraction and one final reply', [{ text: 'typed bill facts' }, { type: 'image', mediaId: 'image', mimeType: 'image/jpeg' }], 1],
  ['Worker text, image, PDF and voice produce one extraction and one final reply', [{ text: 'typed bill facts' }, { type: 'image', mediaId: 'image', mimeType: 'image/jpeg' }, { type: 'document', mediaId: 'pdf', mimeType: 'application/pdf' }, { type: 'audio', mediaId: 'voice', mimeType: 'audio/ogg' }], 3],
];
for (const [name, items, expectedMedia] of booksCases) test(name, async t => {
  const h = booksHarness(t, items);
  await h.worker.tick();
  assert.equal(h.calls.filter(call => call[0] === 'text').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'extract').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'ocr').length, expectedMedia);
  assert.equal(h.completions.length, items.length);
});

test('duplicate Boss receipt cannot create a duplicate final reply', async t => {
  const h = await bossHarness(t);
  const message = await h.receive({ text: 'text facts', id: 'wamid.duplicate-batch' });
  await h.store.enqueueMany([message], { processingFlow: 'conversation' });
  await h.processBatch();
  assert.equal(h.sends.length, 1);
  assert.equal(h.leadInputs.length, 1);
});

test('Books reply reservation suppresses a replay after processing retry', async () => {
  const job = { job_id: 'retry-job', message_id: 'retry-message', worker_phone: WORKER,
    lease_token: 'retry-lease', payload: { message_type: 'text', message_text: 'bill details' } };
  let claims = 0;
  const reserved = new Set();
  const queue = {
    async claimBillExtraction() { return claims++ < 2 ? job : null; },
    async heartbeatBillExtraction() { return true; },
    async reserveBillReply(id) { if (reserved.has(id)) return false; reserved.add(id); return true; },
    async finishBillReply() { return true; },
    async completeBillExtraction() { return true; },
    async failBillExtraction() { return true; },
  };
  const sends = [];
  const worker = createBooksWorker({ billStore: queue,
    billWorkflow: { async processMessage() { return { success: true, replyText: 'one reply' }; } },
    whatsapp: { async sendTextMessage(_to, text) { sends.push(text); return { messages: [{ id: 'wamid.once' }] }; } },
    config: { enabled: true, leaseMs: 30000, maxAttempts: 3, messageBatchQuietMs: QUIET_MS },
    logger: silent, triggerGate: { allows: () => true, finish() {} } });
  await worker.tick();
  await worker.tick();
  assert.deepEqual(sends, ['one reply']);
});

test('one failed media extraction retains successful batch content and sends one final reply', async t => {
  const h = await bossHarness(t);
  await h.receive({ text: 'text facts' });
  await h.receive({ type: 'image', mediaId: 'failed-1', mimeType: 'image/jpeg' });
  await h.receive({ type: 'audio', mediaId: 'audio-1', mimeType: 'audio/ogg' });
  await h.processBatch();
  assert.equal(h.sends.length, 1);
  assert.equal(h.leadInputs.length, 1);
  assert.match(h.leadInputs[0], /text facts[\s\S]*voice facts/);
});

test('one failed Worker media extraction retains successful content and sends one final reply', async t => {
  const items = [{ text: 'typed bill facts' }, { type: 'image', mediaId: 'failed', mimeType: 'image/jpeg' },
    { type: 'audio', mediaId: 'voice', mimeType: 'audio/ogg' }];
  const h = booksHarness(t, items, { failMediaId: 'failed' });
  await h.worker.tick();
  assert.equal(h.calls.filter(call => call[0] === 'extract').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'text').length, 1);
  const combined = h.calls.find(call => call[0] === 'extract')[1].text;
  assert.match(combined, /typed bill facts[\s\S]*voice extracted bill facts/);
});

test('concurrent media extraction is parallel and concurrent worker ticks send one final reply', async t => {
  const items = [{ text: 'typed bill facts' }, { type: 'image', mediaId: 'image', mimeType: 'image/jpeg' },
    { type: 'document', mediaId: 'pdf', mimeType: 'application/pdf' }, { type: 'audio', mediaId: 'voice', mimeType: 'audio/ogg' }];
  const h = booksHarness(t, items, { holdMedia: true });
  await Promise.all([h.worker.tick(), h.worker.tick(), h.worker.tick()]);
  assert.ok(h.getMaxActiveMedia() > 1);
  assert.equal(h.calls.filter(call => call[0] === 'extract').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'text').length, 1);
});
