'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { temporaryStore, incoming, silent } = require('./helpers');
const { createBossLeadWorkflow } = require('../src/services/leads/bossLeadWorkflow');
const { LEAD_FIELDS } = require('../src/services/ai/leadExtraction');
const { CONFIRMATION_REPLY } = require('../src/services/leads/bossConversation');

const BOSS = '+971551234567';
const CAD_BYTES = Buffer.from('AC1032 synthetic original drawing');
const cad = (id = '123') => ({ message_type: 'document', media_id: id,
  media_mime_type: 'image/vnd.dwg', media_filename: `drawing-${id}.dwg` });

async function setup(t) {
  const { store } = await temporaryStore(t);
  let now = Date.now();
  t.mock.method(store, '_now', async () => new Date(now).toISOString());
  const extracts = [], downloads = [], uploads = [];
  const ai = {
    async extractLeadEnquiry(text) {
      extracts.push(text);
      const fields = {};
      if (text.includes('Al Noor Contracting')) fields.company_name = 'Al Noor Contracting';
      if (text.includes('Ahmed')) fields.contact_name = 'Ahmed';
      return { is_lead: Object.keys(fields).length > 0,
        lead: { ...Object.fromEntries(LEAD_FIELDS.map(field => [field, null])), ...fields } };
    },
    async extractMediaText() { assert.fail('CAD bytes must not be sent to AI extraction.'); },
  };
  const whatsapp = {
    async downloadMedia(id, options) {
      downloads.push({ id, options });
      assert.equal(options?.purpose, 'attachment');
      return { buffer: CAD_BYTES, mimeType: 'image/vnd.dwg' };
    },
    async sendTextMessage() { assert.fail('Tests never dispatch WhatsApp messages.'); },
  };
  const zoho = {
    async searchLeadByPhone() { return null; },
    async createLead() { return { id: '5653678000000000001' }; },
    async uploadLeadAttachment(id, file) {
      uploads.push({ id, ...file });
      return { id: String(5653678000000000000n + BigInt(uploads.length)), status: 'uploaded' };
    },
  };
  const config = { enabled: true, aiProvider: 'openai', bossSenders: new Set([BOSS]), allowedSenders: new Set(),
    leaseMs: 30000, maxAttempts: 3 };
  const workflow = createBossLeadWorkflow({ store, ai, whatsapp, zoho, config, logger: silent });
  const h = {
    store, extracts, downloads, uploads,
    session: () => store.getActiveLeadSession(BOSS),
    async enqueue(text, overrides = {}) {
      const message = incoming({ sender_phone: BOSS, message_text: text, request_lead_workflow: true,
        received_at: new Date(now).toISOString(), ...overrides });
      await store.enqueueMany([message], { processingFlow: 'conversation' });
      now += 1;
      return message.whatsapp_message_id;
    },
    async process(batch = false) {
      now += 100;
      const job = await store.claimLeadExtraction({ leaseMs: config.leaseMs, maxAttempts: config.maxAttempts,
        ...(batch ? { batchQuietMs: 50 } : {}) });
      assert.ok(job);
      await workflow.processIncomingWhatsAppMessage(job);
      return job;
    },
    async turn(text, overrides) {
      const id = await h.enqueue(text, overrides);
      await h.process();
      return id;
    },
  };
  return h;
}

test('a CAD original starts an empty draft and attaches after factual details and explicit save', async t => {
  const h = await setup(t);
  const id = await h.turn('', cad());
  const draft = await h.session();
  assert.equal(draft.state, 'collecting');
  assert.equal(draft.result.is_lead, false);
  assert.equal(draft.original_message, '');
  assert.deepEqual(h.extracts, []);
  const message = await h.store.getMessage(id);
  assert.match(message.storage_reference, /^[a-f0-9]{24}$/);
  assert.equal(message.extracted_text, null);
  assert.deepEqual((await h.store.getMediaFile(message.storage_reference)).buffer, CAD_BYTES);
  await h.turn('Yes');
  assert.equal((await h.store.listLeads()).total, 0, 'An original file alone is not a factual lead.');
  await h.turn('Al Noor Contracting');
  await h.turn('Yes');
  const saved = (await h.store.listLeads()).items[0];
  assert.equal(saved.attachments.length, 1);
  assert.equal(saved.attachments[0].zohoUploadStatus, 'uploaded');
  assert.equal(saved.attachments[0].filename, 'drawing-123.dwg');
  assert.deepEqual(h.uploads[0].buffer, CAD_BYTES);
  assert.equal(h.downloads.length, 1, 'Saving reuses the retained original.');
  assert.deepEqual(h.extracts, ['Al Noor Contracting']);
});

test('CAD added to an existing valid draft preserves its facts and confirmation state', async t => {
  const h = await setup(t);
  await h.turn('Al Noor Contracting');
  const before = await h.session();
  const id = await h.turn('', cad());
  const after = await h.session();
  assert.equal(after.id, before.id);
  assert.equal(after.state, 'awaiting_confirmation');
  assert.deepEqual(after.result, before.result);
  assert.equal(after.original_message, before.original_message);
  assert.equal((await h.store.getReply(id)).text, CONFIRMATION_REPLY);
  assert.deepEqual(h.extracts, ['Al Noor Contracting']);
});

test('mixed text and CAD in one batch retain originals without marking the CAD unreadable', async t => {
  const h = await setup(t);
  await h.enqueue('Al Noor Contracting');
  const cadId = await h.enqueue('', cad());
  await h.enqueue('Ahmed');
  const job = await h.process(true);
  assert.equal(job.batch_items.length, 3);
  assert.deepEqual(h.extracts, ['Al Noor Contracting\nAhmed']);
  assert.equal((await h.store.getMessage(cadId)).error_message, null);
  assert.equal((await h.session()).state, 'awaiting_confirmation');
  await h.turn('Yes');
  assert.equal(h.uploads.length, 1);
  assert.deepEqual(h.uploads[0].buffer, CAD_BYTES);
});

test('a batch containing only CAD originals retains every file and waits for actual facts', async t => {
  const h = await setup(t);
  const ids = [await h.enqueue('', cad('123')), await h.enqueue('', cad('124'))];
  await h.process(true);
  assert.deepEqual(h.extracts, []);
  assert.equal((await h.session()).state, 'collecting');
  for (const id of ids) {
    const message = await h.store.getMessage(id);
    assert.equal(message.error_message, null);
    assert.match(message.storage_reference, /^[a-f0-9]{24}$/);
  }
  await h.turn('Al Noor Contracting');
  await h.turn('Yes');
  assert.equal(h.uploads.length, 2);
  assert.equal((await h.store.listLeads()).items[0].attachments.length, 2);
});

test('CAD captions provide facts but cannot act as save consent, individually or batched', async t => {
  const h = await setup(t);
  await h.turn('Al Noor Contracting', cad('121'));
  assert.deepEqual(h.extracts, ['Al Noor Contracting']);
  assert.equal((await h.session()).state, 'awaiting_confirmation');
  await h.turn('Yes', cad('122'));
  assert.equal((await h.store.listLeads()).total, 0);
  await h.enqueue('Yes', cad('123'));
  await h.enqueue('', cad('124'));
  await h.process(true);
  assert.equal((await h.store.listLeads()).total, 0);
  assert.equal((await h.session()).state, 'awaiting_confirmation');
  assert.deepEqual(h.extracts, ['Al Noor Contracting']);
  await h.turn('Yes');
  assert.equal(h.uploads.length, 4);
});

test('retaining CAD does not clear a pending choice to discard or continue the current lead', async t => {
  const h = await setup(t);
  await h.turn('Al Noor Contracting');
  await h.turn('New lead');
  const before = await h.session();
  assert.equal(before.pending_action, 'new_lead');
  const id = await h.turn('', cad());
  const after = await h.session();
  assert.equal(after.pending_action, 'new_lead');
  assert.deepEqual(after.result, before.result);
  assert.match((await h.store.getReply(id)).text, /discard current lead/);
  await h.turn('Yes');
  assert.equal((await h.store.listLeads()).total, 0);
});
