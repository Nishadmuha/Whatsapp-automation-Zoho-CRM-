'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { temporaryStore, incoming, silent, testEnv } = require('./helpers');
const { readConfig } = require('../src/config/env');
const { createBossLeadWorkflow } = require('../src/services/leads/bossLeadWorkflow');
const { createIncomingTriggerGate } = require('../src/services/whatsapp/incomingTriggerGate');
const { LEAD_FIELDS } = require('../src/services/ai/leadExtraction');
const { CONFIRMATION_REPLY, SAVED_REPLY } = require('../src/services/leads/bossConversation');

const BOSS = '+971551234567';
const SECOND_BOSS = '+971551234568';
const facts = {
  'Al Noor Contracting': { company_name: 'Al Noor Contracting' },
  'Ahmed +971501234567': { contact_name: 'Ahmed', phone: '+971501234567' },
  'Need MDB panels. procurement@example.test': { requirement: 'Need MDB panels', email: 'procurement@example.test' },
  'Dubai site': { project_location: 'Dubai site' },
};
const attachments = {
  '123': { text: 'Ahmed +971501234567', mimeType: 'image/jpeg' },
  '124': { text: 'Need MDB panels. procurement@example.test', mimeType: 'application/pdf' },
  '125': { text: 'Dubai site', mimeType: 'audio/ogg' },
};

async function setup(t, { zoho = null } = {}) {
  const { store } = await temporaryStore(t);
  let time = Date.now();
  t.mock.method(store, '_now', async () => new Date(time).toISOString());
  const triggerGate = createIncomingTriggerGate({ now: () => time });
  const sends = [], extracts = [];
  const ai = {
    async extractLeadEnquiry(text) {
      extracts.push(text);
      return { is_lead: true, lead: { ...Object.fromEntries(LEAD_FIELDS.map(field => [field, null])), ...facts[text] } };
    },
    async extractMediaText({ buffer }) { return buffer.toString(); },
    generateReply() { assert.fail('Boss intake must not invoke customer reply generation.'); },
  };
  const whatsapp = {
    async downloadMedia(id) {
      const attachment = attachments[id];
      if (!attachment) throw new Error('Unreadable test file');
      return { buffer: Buffer.from(attachment.text), mimeType: attachment.mimeType };
    },
    async sendTextMessage(to, text) { sends.push({ to, text }); return { messages: [{ id: 'wamid.mock-' + sends.length }] }; },
  };
  const config = { enabled: true, aiProvider: 'openai', bossSenders: new Set([BOSS, SECOND_BOSS]),
    allowedSenders: new Set(), leaseMs: 30000, maxAttempts: 3, bossReplyQuietMs: 5000 };
  const workflow = createBossLeadWorkflow({ store, ai, whatsapp, config, logger: silent, triggerGate, zoho });
  return {
    store, ai, whatsapp, config, triggerGate, workflow, sends, extracts, zoho,
    advance(ms) { time += ms; },
    async receive(text, overrides = {}, admit = true) {
      const message = incoming({ sender_phone: BOSS, message_text: text, request_lead_workflow: true,
        received_at: new Date(time).toISOString(), ...overrides });
      await store.enqueueMany([message], { processingFlow: 'conversation' });
      if (admit) assert.equal(triggerGate.admit(message.whatsapp_message_id, String(Math.floor(time / 1000))), true);
      return message.whatsapp_message_id;
    },
    async process() {
      const job = await store.claimLeadExtraction({ messageIds: triggerGate.messageIds() });
      assert.ok(job);
      await workflow.processIncomingWhatsAppMessage(job);
      return job.message_id;
    },
    async sendNext() {
      // Equal-time outbox rows may be inspected before an older prompt is
      // cancelled. The worker revisits them on its following tick.
      return await workflow.processNextReply() || await workflow.processNextReply();
    },
  };
}

test('boss batching defaults to a five-second quiet period and validates configuration', () => {
  assert.equal(readConfig(testEnv()).bossReplyQuietMs, 5000);
  assert.equal(readConfig(testEnv({ BOSS_REPLY_QUIET_MS: '10000' })).bossReplyQuietMs, 10000);
  for (const value of ['-1', '0', '60001', 'abc']) {
    assert.throws(() => readConfig(testEnv({ BOSS_REPLY_QUIET_MS: value })), /BOSS_REPLY_QUIET_MS/);
  }
});

test('text, image, document and voice in one burst produce one confirmation with all facts retained', async t => {
  const h = await setup(t);
  const ids = [await h.receive('Al Noor Contracting')];
  for (const [id, type] of [['123', 'image'], ['124', 'document'], ['125', 'audio']]) {
    ids.push(await h.receive('', { message_type: type, media_id: id, media_mime_type: attachments[id].mimeType }));
  }
  for (const id of ids) {
    assert.equal(await h.process(), id);
    assert.equal(await h.workflow.processNextReply(), false);
  }
  assert.deepEqual(h.sends, []);
  h.advance(5000);
  assert.equal(await h.sendNext(), true);
  assert.deepEqual(h.sends, [{ to: BOSS, text: CONFIRMATION_REPLY }]);
  assert.equal(await h.workflow.processNextReply(), false);
  const draft = await h.store.getActiveLeadSession(BOSS);
  assert.equal(draft.state, 'awaiting_confirmation');
  assert.equal(draft.result.lead.company_name, 'Al Noor Contracting');
  assert.equal(draft.result.lead.contact_name, 'Ahmed');
  assert.equal(draft.result.lead.phone, '+971501234567');
  assert.equal(draft.result.lead.email, 'procurement@example.test');
  assert.equal(draft.result.lead.requirement, 'Need MDB panels');
  assert.equal(draft.result.lead.project_location, 'Dubai site');
  assert.equal(h.extracts.length, 4);
  assert.equal((await h.store.listLeads()).total, 0);
  for (const id of ids.slice(0, -1)) assert.equal((await h.store.getReply(id)).status, 'CANCELLED');

  await h.receive('YES');
  await h.process();
  assert.equal(await h.sendNext(), true, 'Explicit save response is not delayed.');
  assert.equal(h.sends.at(-1).text, SAVED_REPLY);
  const saved = (await h.store.listLeads()).items[0];
  assert.equal(saved.attachments.length, 3);
  assert.deepEqual(new Set(saved.attachments.map(a => a.type)), new Set(['image', 'document', 'audio']));
  assert.equal(saved.attachments.find(a => a.type === 'audio').transcription, 'Dubai site');
  assert.equal(saved.attachments.find(a => a.type === 'document').extractedText, attachments['124'].text);
});

test('CRM finalization restores the rich Boss success reply instead of racing with the initial saved prompt', async t => {
  let crmStarted;
  const crmReady = new Promise(resolve => { crmStarted = resolve; });
  let releaseCrm;
  const crmReleased = new Promise(resolve => { releaseCrm = resolve; });
  const zoho = {
    async searchLeadByPhone() { return null; },
    async createLead() {
      crmStarted();
      await crmReleased;
      return { id: 'crm-rich-reply-1' };
    },
  };
  const h = await setup(t, { zoho });
  await h.receive('Ahmed +971501234567');
  await h.process();
  const confirmation = await h.receive('YES');
  const processing = h.process();

  await crmReady;
  assert.equal(await h.workflow.processNextReply(), false, 'The initial saved prompt must not dispatch during CRM finalization.');
  assert.equal((await h.store.getReply(confirmation)).text, SAVED_REPLY);

  releaseCrm();
  await processing;
  assert.equal((await h.store.listLeads()).items[0].zoho_lead_id, 'crm-rich-reply-1');
  assert.equal(await h.sendNext(), true);
  const sent = h.sends.at(-1).text;
  assert.match(sent, /Lead Saved Successfully/);
  assert.match(sent, /crm-rich-reply-1/);
  assert.notEqual(sent, SAVED_REPLY);
  assert.equal(h.sends.length, 1, 'One logical confirmation must produce one final Boss response.');
});

test('separate arrivals reset the pause and slow OCR cannot send an intermediate prompt', async t => {
  const h = await setup(t);
  const first = await h.receive('Al Noor Contracting');
  await h.process();
  h.advance(4000);
  assert.equal(await h.workflow.processNextReply(), false);
  const image = await h.receive('', { message_type: 'image', media_id: '123', media_mime_type: 'image/jpeg' });
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  t.mock.method(h.ai, 'extractMediaText', async ({ buffer }) => { started(); await held; return buffer.toString(); });
  const processing = h.process();
  await entered;
  h.advance(6000);
  assert.equal(await h.workflow.processNextReply(), false);
  assert.equal((await h.store.getReply(first)).status, 'CANCELLED');
  assert.deepEqual(h.sends, []);
  release();
  await processing;
  await h.store.enqueueMany([await h.store.getMessage(image)], { processingFlow: 'conversation' });
  assert.equal(await h.sendNext(), true);
  assert.equal(await h.workflow.processNextReply(), false);
  assert.equal(h.sends.length, 1);
  assert.equal((await h.store.getActiveLeadSession(BOSS)).result.lead.contact_name, 'Ahmed');
});

test('another boss can receive a confirmation while the first boss is still sending', async t => {
  const h = await setup(t);
  await h.receive('Al Noor Contracting');
  await h.process();
  await h.receive('Al Noor Contracting', { sender_phone: SECOND_BOSS });
  await h.process();
  h.advance(4000);
  await h.receive('Dubai site');
  await h.process();
  h.advance(1000);
  assert.equal(await h.sendNext(), true);
  assert.deepEqual(h.sends, [{ to: SECOND_BOSS, text: CONFIRMATION_REPLY }]);
  assert.equal(await h.workflow.processNextReply(), false);
  h.advance(4000);
  assert.equal(await h.sendNext(), true);
  assert.equal(h.sends.at(-1).to, BOSS);
});

test('read errors remain visible and do not send a stale confirmation or lose draft facts', async t => {
  const h = await setup(t);
  const first = await h.receive('Al Noor Contracting');
  await h.process();
  await h.receive('', { message_type: 'document', media_id: '999', media_mime_type: 'application/pdf' });
  await h.process();
  assert.equal(await h.sendNext(), true);
  assert.equal((await h.store.getReply(first)).status, 'CANCELLED');
  assert.match(h.sends[0].text, /could not read that attachment/);
  assert.equal(h.sends.length, 1);
  assert.equal((await h.store.getActiveLeadSession(BOSS)).result.lead.company_name, 'Al Noor Contracting');
  assert.equal((await h.store.listLeads()).total, 0);
});

test('unadmitted historical work does not silence a fresh confirmation and restart does not send old prompts', async t => {
  const h = await setup(t);
  const fresh = await h.receive('Al Noor Contracting');
  await h.process();
  const outside = await h.receive('Dubai site', {}, false);
  h.advance(5000);
  assert.equal(await h.sendNext(), true);
  assert.equal((await h.store.getReply(fresh)).status, 'SENT');
  assert.equal((await h.store.getLeadExtraction(outside)).processing_status, 'RECEIVED');
  const pending = await h.receive('Dubai site');
  await h.process();
  const restartedGate = createIncomingTriggerGate();
  const restarted = createBossLeadWorkflow({ ...h, logger: silent, triggerGate: restartedGate });
  assert.equal(await restarted.processNextReply(), false);
  assert.equal((await h.store.getReply(pending)).status, 'PENDING');
  assert.equal(h.sends.length, 1);
});

test('YES replaces an unsent confirmation but keeps the explicit save response and duplicate protection', async t => {
  const h = await setup(t);
  const intake = await h.receive('Al Noor Contracting');
  await h.process();
  const confirmation = await h.receive('YES');
  await h.process();
  assert.equal(await h.sendNext(), true);
  assert.equal((await h.store.getReply(intake)).status, 'CANCELLED');
  assert.deepEqual(h.sends, [{ to: BOSS, text: SAVED_REPLY }]);
  await h.store.enqueueMany([await h.store.getMessage(confirmation)], { processingFlow: 'conversation' });
  assert.equal(await h.workflow.processNextReply(), false);
  assert.equal((await h.store.listLeads()).total, 1);
});
