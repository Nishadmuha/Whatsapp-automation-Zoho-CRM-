'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBossLeadProcessor } = require('../src/services/ai/bossLeadProcessor');
const { temporaryStore, incoming } = require('./helpers');
const { LEAD_FIELDS } = require('../src/services/ai/leadExtraction');

const BOSS = '+971551234567';
const enquiry = (values = {}, isLead = true) => ({
  is_lead: isLead, lead: { ...Object.fromEntries(LEAD_FIELDS.map(field => [field, null])), ...values },
});
const completeText = 'Company: Desert Build LLC; Contact: Sara; Phone: 0501234567; Email: sara@example.com; '
  + 'Project: Office A; Location: Dubai; Service: AC maintenance; Requirement: Inspect AC units; '
  + 'Quantity: 4 units; Deadline: 20 September; Notes: Call after 2 PM.';
const completeEnquiry = () => enquiry({
  company_name: 'Desert Build LLC', contact_name: 'Sara', phone: '0501234567', email: 'sara@example.com',
  project_name: 'Office A', project_location: 'Dubai', product_or_service: 'AC maintenance',
  requirement: 'Inspect AC units', quantity: '4 units', deadline: '20 September', notes: 'Call after 2 PM',
});

async function setup(t, { extract, config: overrides = {} } = {}) {
  const { store } = await temporaryStore(t);
  const config = { enabled: true, aiProvider: 'openai', bossSenders: new Set([BOSS]), allowedSenders: new Set(),
    leaseMs: 30000, maxAttempts: 3, ...overrides };
  const calls = [];
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, record => logs.push(record)]));
  const ai = { async extractLeadEnquiry(text) { calls.push(text); return extract ? extract(text) : completeEnquiry(); } };
  const processor = createBossLeadProcessor({ store, ai, config, logger });
  async function enqueue(overrides = {}) {
    const message = incoming({ sender_phone: BOSS, message_text: completeText, request_lead_extraction: true, ...overrides });
    await store.enqueueMany([message], { processingFlow: 'conversation' });
    return message;
  }
  async function process() {
    const job = await store.claimLeadExtraction({ leaseMs: config.leaseMs, maxAttempts: config.maxAttempts });
    if (job) await processor.processIncomingWhatsAppMessage(job);
    return job;
  }
  return { store, config, logs, calls, processor, enqueue, process };
}

test('complete boss enquiries are grounded, normalized and stored internally without changing the conversation or outbox', async t => {
  const h = await setup(t);
  const message = await h.enqueue();
  const before = await h.store.getMessage(message.whatsapp_message_id);
  await h.process();
  const extraction = await h.store.getLeadExtraction(message.whatsapp_message_id);
  assert.equal(extraction.processing_status, 'SUCCESS');
  assert.equal(extraction.attempts, 1);
  assert.ok(extraction.processed_at);
  assert.equal(extraction.next_attempt_at, null);
  const expected = completeEnquiry();
  expected.lead.phone = '+971501234567';
  assert.deepEqual(extraction.result, expected);
  assert.deepEqual(await h.store.getMessage(message.whatsapp_message_id), before);
  assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
  assert.equal(await h.processor.processNextReply(), false);
  assert.deepEqual(h.calls, [completeText]);
  assert.equal(JSON.stringify(h.logs).includes('Desert Build LLC'), false);
  assert.equal(JSON.stringify(h.logs).includes('sara@example.com'), false);
});

test('partial boss enquiries preserve only supplied details and allow missing contacts', async t => {
  const expected = enquiry({ product_or_service: 'AC maintenance', project_location: 'Dubai' });
  const h = await setup(t, { extract: async () => expected });
  const message = await h.enqueue({ message_text: 'Need AC maintenance in Dubai.' });
  await h.process();
  const extraction = await h.store.getLeadExtraction(message.whatsapp_message_id);
  assert.equal(extraction.processing_status, 'SUCCESS');
  assert.deepEqual(extraction.result, expected);
  assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
});

test('irrelevant boss messages are stored as IRRELEVANT without inventing a lead or sending a reply', async t => {
  const expected = enquiry({}, false);
  const h = await setup(t, { extract: async () => expected });
  const message = await h.enqueue({ message_text: 'Good morning, thanks.' });
  await h.process();
  const extraction = await h.store.getLeadExtraction(message.whatsapp_message_id);
  assert.equal(extraction.processing_status, 'IRRELEVANT');
  assert.deepEqual(extraction.result, expected);
  assert.equal(extraction.next_attempt_at, null);
  assert.equal(await h.process(), null);
  assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
});

test('duplicate boss receipts and competing extraction claims produce one internal extraction', async t => {
  const h = await setup(t);
  const message = await h.enqueue();
  await Promise.all(Array.from({ length: 5 }, () => h.store.enqueueMany([message], { processingFlow: 'conversation' })));
  await Promise.all(Array.from({ length: 5 }, () => h.process()));
  assert.equal(h.calls.length, 1);
  assert.equal((await h.store.getLeadExtraction(message.whatsapp_message_id)).processing_status, 'SUCCESS');
  assert.equal(await h.process(), null);
  assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
});

test('a queued non-boss enquiry is refused before extraction even when the intake flag was supplied', async t => {
  const h = await setup(t);
  const message = await h.enqueue({ sender_phone: '+971561234567' });
  await h.process();
  const extraction = await h.store.getLeadExtraction(message.whatsapp_message_id);
  assert.equal(extraction.processing_status, 'FAILED');
  assert.equal(extraction.error_message, 'MESSAGE_NOT_AUTHORIZED');
  assert.equal(extraction.result, null);
  assert.equal(h.calls.length, 0);
  assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
});

test('disabled automation and an inactive provider cannot run a previously queued boss extraction', async t => {
  for (const config of [{ enabled: false }, { aiProvider: '' }]) {
    const h = await setup(t, { config });
    const message = await h.enqueue();
    await h.process();
    const extraction = await h.store.getLeadExtraction(message.whatsapp_message_id);
    assert.equal(extraction.result, null);
    assert.equal(h.calls.length, 0);
    assert.equal(await h.processor.processNextReply(), false);
    assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
  }
});

test('unsigned and unsupported messages cannot queue or directly invoke boss extraction', async t => {
  for (const overrides of [{ authenticated: false }, { message_type: 'image' }, { message_type: 'audio' }]) {
    const h = await setup(t);
    const message = await h.enqueue(overrides);
    assert.equal(await h.store.getLeadExtraction(message.whatsapp_message_id), null);
    assert.equal(await h.process(), null);
    await h.processor.processIncomingWhatsAppMessage({ ...message, message_id: message.whatsapp_message_id,
      processing_flow: 'conversation', attempts: 1, lease_token: 'unclaimed-test-lease' });
    assert.equal(h.calls.length, 0);
    assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
  }
});

test('ungrounded AI fields are discarded before the internal result is persisted', async t => {
  for (const product of [null, 'AC maintenance']) {
    const h = await setup(t, { extract: async () => enquiry({
      company_name: 'Invented Private Company', product_or_service: product,
    }) });
    const message = await h.enqueue({ message_text: 'Need AC maintenance in Dubai.' });
    await h.process();
    const extraction = await h.store.getLeadExtraction(message.whatsapp_message_id);
    assert.equal(extraction.processing_status, product ? 'SUCCESS' : 'IRRELEVANT');
    assert.deepEqual(extraction.result, enquiry({ product_or_service: product }, Boolean(product)));
    assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
    assert.equal(JSON.stringify(h.logs).includes('Invented Private Company'), false);
  }
});

test('malformed AI results fail safely without persisting any result', async t => {
  for (const result of [{}, null, { ...enquiry(), unexpected: 'synthetic-private-result' }]) {
    const h = await setup(t, { extract: async () => result });
    const message = await h.enqueue({ message_text: 'Need AC maintenance in Dubai.' });
    await h.process();
    const extraction = await h.store.getLeadExtraction(message.whatsapp_message_id);
    assert.equal(extraction.processing_status, 'FAILED');
    assert.equal(extraction.error_message, 'AI_MALFORMED_RESPONSE');
    assert.equal(extraction.result, null);
    assert.equal(extraction.next_attempt_at, null);
    assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
    assert.equal(JSON.stringify(h.logs).includes('synthetic-private-result'), false);
  }
});

test('permanent extraction errors retain only a safe code and do not retry or send', async t => {
  const h = await setup(t, { extract: async () => {
    throw Object.assign(new Error('synthetic-private-token customer detail'), { code: 'AI_AUTHENTICATION_ERROR', retryable: false });
  } });
  const message = await h.enqueue();
  await h.process();
  const extraction = await h.store.getLeadExtraction(message.whatsapp_message_id);
  assert.equal(extraction.processing_status, 'FAILED');
  assert.equal(extraction.error_message, 'AI_AUTHENTICATION_ERROR');
  assert.equal(extraction.next_attempt_at, null);
  assert.equal(extraction.result, null);
  assert.equal(await h.process(), null);
  assert.equal(h.calls.length, 1);
  assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
  assert.equal(JSON.stringify(h.logs).includes('synthetic-private-token'), false);
});

for (const eventualSuccess of [true, false]) {
  test(eventualSuccess
    ? 'transient extraction failures retry durably and then store one internal result'
    : 'extraction retry exhaustion stops without a result, further calls, or an outbound message', async t => {
    let attempts = 0;
    const h = await setup(t, { config: { maxAttempts: 2 }, extract: async () => {
      if (++attempts === 2 && eventualSuccess) return completeEnquiry();
      throw Object.assign(new Error('synthetic-private-rate-limit-body'), { code: 'AI_RATE_LIMIT', retryable: true });
    } });
    const message = await h.enqueue();
    await h.process();
    let extraction = await h.store.getLeadExtraction(message.whatsapp_message_id);
    assert.equal(extraction.processing_status, 'FAILED');
    assert.equal(extraction.attempts, 1);
    assert.ok(Date.parse(extraction.next_attempt_at) > Date.now());
    assert.equal(extraction.processed_at, null);
    assert.equal(await h.process(), null);
    await h.store.driver.query('UPDATE lead_extractions SET next_attempt_at=? WHERE message_id=?',
      [new Date(Date.now() - 1000).toISOString(), message.whatsapp_message_id]);
    await h.process();
    extraction = await h.store.getLeadExtraction(message.whatsapp_message_id);
    assert.equal(extraction.processing_status, eventualSuccess ? 'SUCCESS' : 'FAILED');
    assert.equal(extraction.attempts, 2);
    assert.equal(extraction.next_attempt_at, null);
    assert.ok(extraction.processed_at);
    assert.equal(Boolean(extraction.result), eventualSuccess);
    assert.equal(await h.process(), null);
    assert.equal(h.calls.length, 2);
    assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
    assert.equal(JSON.stringify(h.logs).includes('synthetic-private-rate-limit-body'), false);
  });
}

test('losing extraction ownership while AI is pending prevents stale result persistence', async t => {
  let resolve;
  const started = new Promise(done => { resolve = done; });
  let finish;
  const pendingResult = new Promise(done => { finish = done; });
  const h = await setup(t, { extract: async () => { resolve(); return pendingResult; } });
  const message = await h.enqueue();
  const processing = h.process();
  await started;
  await h.store.driver.query('UPDATE lead_extractions SET lease_token=? WHERE message_id=?',
    ['replacement-extraction-lease', message.whatsapp_message_id]);
  finish(completeEnquiry());
  await processing;
  const extraction = await h.store.getLeadExtraction(message.whatsapp_message_id);
  assert.equal(extraction.result, null);
  assert.equal(extraction.lease_token, 'replacement-extraction-lease');
  assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
  assert.equal(h.calls.length, 1);
});

test('removing boss authorization during extraction cannot persist the pending result', async t => {
  let started;
  const began = new Promise(done => { started = done; });
  let finish;
  const pendingResult = new Promise(done => { finish = done; });
  const h = await setup(t, { extract: async () => { started(); return pendingResult; } });
  const message = await h.enqueue();
  const processing = h.process();
  await began;
  h.config.bossSenders.clear();
  finish(completeEnquiry());
  await processing;
  assert.equal((await h.store.getLeadExtraction(message.whatsapp_message_id)).result, null);
  assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
});
