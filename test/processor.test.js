'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLeadProcessor } = require('../src/services/leads/leadProcessor');
const { createWhatsAppService } = require('../src/services/whatsapp/whatsappService');
const { successReply, missingInformationReply } = require('../src/services/leads/replyFormatter');
const { temporaryStore, incoming, lead, silent } = require('./helpers');

async function setup(t, overrides = {}) {
  const { store } = await temporaryStore(t);
  const calls = { extract: 0, search: 0, create: 0, update: 0, send: 0 };
  const config = { allowedSenders: new Set(['+971551234567']), maxAttempts: 3, leaseMs: 30000 };
  const ai = { async extractLead() { calls.extract++; return lead(); }, ...overrides.ai };
  const zoho = {
    async searchLeadByPhone() { calls.search++; return null; },
    async searchLeadByEmail() { calls.search++; return null; },
    async createLead() { calls.create++; return { id: '1001' }; },
    async updateLead() { calls.update++; return { id: '1001' }; },
    ...overrides.zoho,
  };
  const whatsapp = { async sendTextMessage() { calls.send++; return { messages: [{ id: 'wamid.reply' }] }; }, ...overrides.whatsapp };
  const processor = createLeadProcessor({ store, ai, zoho, whatsapp, config, logger: overrides.logger || silent });
  async function process(message = incoming()) {
    await store.enqueueMany([message]);
    const job = await store.claimNext({ leaseMs: config.leaseMs, maxAttempts: config.maxAttempts });
    if (job) await processor.processIncomingWhatsAppMessage(job);
    return store.getMessage(message.whatsapp_message_id);
  }
  return { store, calls, processor, process, config };
}
test('new lead is persisted, created in CRM, completed, and replied through a separate durable outbox', async (t) => {
  const h = await setup(t);
  const result = await h.process();
  assert.equal(result.processing_status, 'SUCCESS');
  assert.equal(result.zoho_lead_id, '1001');
  assert.equal(result.extracted_lead_data.phone, '+971501234567');
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.send, 0);
  assert.equal((await h.store.getReply(result.whatsapp_message_id)).status, 'PENDING');
  await h.processor.processNextReply();
  assert.equal(h.calls.send, 1);
  assert.equal((await h.store.getReply(result.whatsapp_message_id)).status, 'SENT');
  assert.equal((await h.store.getReply(result.whatsapp_message_id)).provider_message_id, 'wamid.reply');
});

for (const deliveryState of ['NOT_ATTEMPTED', 'ATTEMPTED_FAILED', 'UNKNOWN']) {
  test(`outbox records ${deliveryState} distinctly without automatically retrying`, async (t) => {
    let httpCalls = 0;
    const records = [];
    const env = deliveryState === 'NOT_ATTEMPTED' ? {} : {
      WHATSAPP_ACCESS_TOKEN: 'synthetic-test-token', WHATSAPP_PHONE_NUMBER_ID: '100000000001', META_GRAPH_API_VERSION: 'v25.0',
    };
    const whatsapp = createWhatsAppService({ env, logger: silent, http: { async post() {
      httpCalls++;
      if (deliveryState === 'ATTEMPTED_FAILED') {
        throw Object.assign(new Error('private provider failure'), { response: { status: 403, data: { error: { code: 10 } } } });
      }
      throw Object.assign(new Error('private transport failure'), { code: 'ETIMEDOUT' });
    } } });
    const h = await setup(t, { whatsapp, logger: { ...silent, error(record) { records.push(record); } } });
    const message = await h.process();
    await h.processor.processNextReply();
    assert.equal(await h.processor.processNextReply(), false);
    assert.equal(httpCalls, deliveryState === 'NOT_ATTEMPTED' ? 0 : 1);
    const reply = await h.store.getReply(message.whatsapp_message_id);
    assert.equal(reply.status, deliveryState === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED');
    assert.equal(reply.error_message, deliveryState);
    assert.ok(records.some(record => record.delivery_state === deliveryState && record.persisted === true));
    assert.equal(JSON.stringify(records).includes('private'), false);
  });
}

for (const completionFailure of ['false', 'throw', 'expired', 'swept']) {
  test(`accepted reply preserves reconciliation evidence after ${completionFailure} completion`, async (t) => {
    const records = [];
    const logger = { ...silent, info(record) { records.push(record); }, error(record) { records.push(record); } };
    const h = await setup(t, { logger });
    const message = await h.process();
    if (completionFailure === 'false') h.store.finishReply = async () => false;
    if (completionFailure === 'throw') h.store.finishReply = async () => { throw new Error('private database error'); };
    if (['expired', 'swept'].includes(completionFailure)) {
      const claim = h.store.claimReply.bind(h.store);
      h.store.claimReply = async (...args) => {
        const reply = await claim(...args);
        if (reply) {
          await h.store.driver.query('UPDATE reply_outbox SET lease_expires_at=? WHERE id=?', ['2000-01-01T00:00:00.000Z', reply.id]);
          if (completionFailure === 'swept') assert.equal(await claim(), null);
        }
        return reply;
      };
    }
    await h.processor.processNextReply();
    assert.equal(await h.processor.processNextReply(), false);
    assert.equal(h.calls.send, 1);
    const reply = await h.store.getReply(message.whatsapp_message_id);
    assert.equal(reply.status, 'UNKNOWN');
    assert.equal(reply.provider_message_id, 'wamid.reply');
    assert.equal(reply.sent_at, null);
    assert.equal(reply.error_message, 'PROVIDER_ACCEPTED_RECONCILIATION_REQUIRED');
    assert.equal(records.some(record => record.event === 'whatsapp_reply_sent'), false);
    assert.ok(records.some(record => record.event === 'whatsapp_reply_reconciliation_required'
      && record.completion_persisted === false && record.reconciliation_persisted === true));
    const audit = await h.store.driver.query("SELECT event FROM processing_logs WHERE message_id=? AND event='whatsapp_reply_sent'", [message.whatsapp_message_id]);
    assert.equal(audit.rowCount, 0);
  });
}

test('lost completion acknowledgement recognizes the committed SENT row without resending', async (t) => {
  const records = [];
  const h = await setup(t, { logger: { ...silent, info(record) { records.push(record); }, error(record) { records.push(record); } } });
  const message = await h.process();
  const finish = h.store.finishReply.bind(h.store);
  h.store.finishReply = async (...args) => {
    assert.equal(await finish(...args), true);
    throw new Error('lost database acknowledgement');
  };
  await h.processor.processNextReply();
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal(h.calls.send, 1);
  assert.equal((await h.store.getReply(message.whatsapp_message_id)).status, 'SENT');
  assert.equal(records.filter(record => record.event === 'whatsapp_reply_sent').length, 1);
  assert.equal(records.some(record => record.event === 'whatsapp_reply_reconciliation_required'), false);
});

test('database outage after acceptance reports unpersisted evidence and never resends after recovery', async (t) => {
  const records = [];
  const h = await setup(t, { logger: { ...silent, info(record) { records.push(record); }, error(record) { records.push(record); } } });
  const message = await h.process();
  const original = { finish: h.store.finishReply, reconcile: h.store.recordReplyReconciliation };
  h.store.finishReply = async () => { throw new Error('private database credential'); };
  h.store.recordReplyReconciliation = async () => { throw new Error('private database credential'); };
  await h.processor.processNextReply();
  assert.equal(records.some(record => record.event === 'whatsapp_reply_sent'), false);
  const evidence = records.find(record => record.event === 'whatsapp_reply_reconciliation_required');
  assert.equal(evidence.provider_message_id, 'wamid.reply');
  assert.equal(evidence.message_id, message.whatsapp_message_id);
  assert.equal(evidence.completion_persisted, false);
  assert.equal(evidence.reconciliation_persisted, false);
  assert.equal(JSON.stringify(records).includes('private database credential'), false);
  h.store.finishReply = original.finish;
  h.store.recordReplyReconciliation = original.reconcile;
  await h.store.driver.query('UPDATE reply_outbox SET lease_expires_at=? WHERE message_id=?', ['2000-01-01T00:00:00.000Z', message.whatsapp_message_id]);
  assert.equal(await h.processor.processNextReply(), false);
  assert.equal((await h.store.getReply(message.whatsapp_message_id)).status, 'UNKNOWN');
  assert.equal(h.calls.send, 1);
});
test('existing CRM lead is updated and receives original text', async (t) => {
  let original;
  const h = await setup(t, { zoho: {
    async searchLeadByPhone() { return { id: '2002' }; },
    async updateLead(id, value, text) { assert.equal(id, '2002'); assert.equal(value.name, 'Ahmed'); original = text; return { id }; },
  } });
  const message = incoming();
  const result = await h.process(message);
  assert.equal(result.crm_action, 'updated');
  assert.equal(result.zoho_lead_id, '2002');
  assert.equal(original, message.message_text);
  assert.equal(h.calls.create, 0);
});
test('same webhook ID does not repeat extraction, CRM, or confirmations', async (t) => {
  const h = await setup(t);
  const message = incoming();
  await h.process(message);
  await h.process(message);
  await h.processor.processNextReply();
  await h.processor.processNextReply();
  assert.equal(h.calls.extract, 1);
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.send, 1);
});
test('different messages for the same phone update the persisted CRM mapping despite search indexing lag', async (t) => {
  const h = await setup(t);
  await h.process(incoming());
  const second = await h.process(incoming());
  assert.equal(second.crm_action, 'updated');
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.update, 1);
});
test('parallel same-contact jobs serialize the CRM search/create decision', async (t) => {
  const h = await setup(t);
  await h.store.enqueueMany([incoming(), incoming()]);
  const jobs = await Promise.all([h.store.claimNext(), h.store.claimNext()]);
  await Promise.all(jobs.map((job) => h.processor.processIncomingWhatsAppMessage(job)));
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.update, 1);
});
test('missing phone and email is NEEDS_INFORMATION and never touches CRM', async (t) => {
  const h = await setup(t, { ai: { async extractLead() { return lead({ phone: null }); } } });
  const result = await h.process(incoming({ message_text: 'Ahmed needs maintenance.' }));
  assert.equal(result.processing_status, 'NEEDS_INFORMATION');
  assert.equal(h.calls.search, 0);
  assert.equal(h.calls.create, 0);
  assert.match((await h.store.getReply(result.whatsapp_message_id)).text, /phone number.*email/);
});
test('grounded email is a reliable fallback contact when phone is absent', async (t) => {
  const h = await setup(t, { ai: { async extractLead() { return lead({ phone: null, email: 'ahmed@example.com' }); } } });
  assert.equal((await h.process(incoming({ message_text: 'Ahmed ahmed@example.com needs maintenance.' }))).processing_status, 'SUCCESS');
  assert.equal(h.calls.create, 1);
});
test('hallucinated contact is rejected before CRM', async (t) => {
  const h = await setup(t);
  assert.equal((await h.process(incoming({ message_text: 'Ahmed needs maintenance.' }))).processing_status, 'NEEDS_INFORMATION');
  assert.equal(h.calls.create, 0);
});
test('extraction failure stores sanitized error and schedules bounded retry', async (t) => {
  const h = await setup(t, { ai: { async extractLead() { throw Object.assign(new Error('private API credential'), { code: 'AI_EXTRACTION_FAILED' }); } } });
  const result = await h.process();
  assert.equal(result.processing_status, 'FAILED');
  assert.ok(result.next_attempt_at);
  assert.doesNotMatch(result.error_message, /private API credential/);
  assert.equal(h.calls.create, 0);
});
test('uncertain CRM create is not repeated by a later message for that contact', async (t) => {
  let mutations = 0;
  const h = await setup(t, { zoho: { async createLead() { mutations++; throw Object.assign(new Error('private provider response'), { uncertain: true }); } } });
  const first = await h.process();
  const second = await h.process();
  assert.equal(mutations, 1);
  for (const result of [first, second]) {
    assert.equal(result.processing_status, 'FAILED');
    assert.equal(result.next_attempt_at, null);
    assert.match(result.error_message, /reconciliation/);
  }
});
test('a crashed job after CRM checkpoint completes without another CRM mutation', async (t) => {
  const h = await setup(t);
  const message = incoming();
  await h.store.enqueueMany([message]);
  const job = await h.store.claimNext();
  await h.store.mark(job.whatsapp_message_id, job.lease_token, { extracted_lead_data: lead() });
  await h.store.saveCrmResult(job.whatsapp_message_id, job.lease_token, { zohoId: '1001', action: 'created', contactKeys: ['phone:+971501234567'] });
  const persisted = await h.store.getMessage(job.whatsapp_message_id);
  await h.processor.processIncomingWhatsAppMessage(persisted);
  assert.equal((await h.store.getMessage(job.whatsapp_message_id)).processing_status, 'SUCCESS');
  assert.equal(h.calls.create, 0);
  assert.equal(h.calls.search, 0);
});
test('failed WhatsApp reply preserves CRM success and ambiguous sends are never automatically retried', async (t) => {
  let sends = 0;
  const h = await setup(t, { whatsapp: { async sendTextMessage() { sends++; throw Object.assign(new Error('secret transport response'), { uncertain: true }); } } });
  const result = await h.process();
  await h.processor.processNextReply();
  await h.processor.processNextReply();
  assert.equal(sends, 1);
  assert.equal((await h.store.getMessage(result.whatsapp_message_id)).processing_status, 'SUCCESS');
  assert.equal((await h.store.getReply(result.whatsapp_message_id)).status, 'UNKNOWN');
});
test('unsigned or unauthorized queued messages never reach integrations even after automation is enabled', async (t) => {
  const h = await setup(t);
  for (const message of [incoming({ authenticated: false }), incoming({ sender_phone: '+971561234567' })]) {
    const result = await h.process(message);
    assert.equal(result.processing_status, 'FAILED');
    assert.equal(await h.store.getReply(result.whatsapp_message_id), null);
  }
  assert.equal(h.calls.extract, 0);
  assert.equal(h.calls.create, 0);
});
test('conflicting phone and email CRM matches require review rather than overwriting either lead', async (t) => {
  const h = await setup(t, {
    ai: { async extractLead() { return lead({ email: 'ahmed@example.com' }); } },
    zoho: {
      async searchLeadByPhone() { return { id: '1001' }; },
      async searchLeadByEmail() { return { id: '2002' }; },
    },
  });
  const result = await h.process(incoming({ message_text: 'Ahmed 0501234567 ahmed@example.com needs maintenance.' }));
  assert.equal(result.processing_status, 'FAILED');
  assert.equal(h.calls.create + h.calls.update, 0);
});
test('confirmation formatting includes known details and requests complete corrected leads', () => {
  const text = successReply(lead({ name: 'Ahmed\n*Admin*' }), 'updated');
  assert.match(text, /Lead updated successfully/);
  assert.doesNotMatch(text, /\*Admin\*/);
  assert.match(text, /Name: Ahmed Admin/);
  assert.match(missingInformationReply({ missing: ['customer name'], errors: [] }), /resend the complete lead/);
});
test('confirmed CRM work recovers failed local completion even after the attempt budget, with durable audit events', async (t) => {
  const h = await setup(t);
  const original = h.store.completeWithReply.bind(h.store);
  let completionCalls = 0;
  h.store.completeWithReply = async (...args) => {
    if (++completionCalls === 1) throw new Error('temporary database interruption');
    return original(...args);
  };
  const row = await h.process();
  assert.equal(row.processing_status, 'FAILED');
  assert.equal(row.zoho_lead_id, '1001');
  assert.match(row.error_message, /awaiting local completion/);
  await h.store.driver.query('UPDATE whatsapp_messages SET next_attempt_at=? WHERE whatsapp_message_id=?', [new Date(0).toISOString(), row.whatsapp_message_id]);
  const reclaimed = await h.store.claimNext({ maxAttempts: 1 });
  assert.ok(reclaimed);
  await h.processor.processIncomingWhatsAppMessage(reclaimed);
  assert.equal((await h.store.getMessage(row.whatsapp_message_id)).processing_status, 'SUCCESS');
  assert.equal(h.calls.create, 1);
  const events = (await h.store.driver.query('SELECT event FROM processing_logs WHERE message_id=?', [row.whatsapp_message_id])).rows.map((record) => record.event);
  for (const event of ['extraction_started', 'crm_result_saved', 'completion_retry_scheduled', 'processing_success']) assert.ok(events.includes(event));
});
