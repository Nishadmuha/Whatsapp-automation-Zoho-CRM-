'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { temporaryStore, incoming, silent } = require('./helpers');
const { createMessageStore } = require('../src/database');
const { createOutgoingRepository } = require('../src/database/outgoingMessages');
const { createOutgoingMessages, ACKNOWLEDGEMENT } = require('../src/services/whatsapp/outgoingMessages');
const { createIncomingTriggerGate } = require('../src/services/whatsapp/incomingTriggerGate');

const senderPhone = '+971551234567';
const flushTurn = () => new Promise(resolve => setTimeout(resolve, 350));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(t, { send, clock = Date.now, config: overrides = {} } = {}) {
  let service;
  t.after(() => service?.stop());
  const { store, databaseUrl } = await temporaryStore(t);
  const triggerGate = createIncomingTriggerGate({ now: clock });
  const config = { enabled: true, aiProvider: 'openai', allowedSenders: new Set(), bossSenders: new Set([senderPhone]), ...overrides };
  const calls = [];
  const logs = [];
  const whatsapp = { async sendTextMessage(to, text) {
    calls.push({ to, text });
    return send ? send(to, text) : { messages: [{ id: 'wamid.synthetic-outgoing-' + calls.length }] };
  } };
  service = createOutgoingMessages({ store, whatsapp, config, triggerGate, now: clock,
    logger: Object.fromEntries(['info', 'error'].map(level => [level, (...args) => logs.push(args)])) });
  async function receive(id, extra = {}, { admit = true, boss = true } = {}) {
    const message = incoming({ whatsapp_message_id: id, sender_phone: senderPhone, received_at: new Date(clock()).toISOString(),
      request_lead_workflow: boss, ...extra });
    await store.enqueueMany([message], { processingFlow: 'conversation' });
    if (admit) triggerGate.admit(id, String(Math.floor(new Date(message.received_at).getTime() / 1000)));
    return message;
  }
  return { service, store, triggerGate, config, calls, logs, receive, databaseUrl, whatsapp };
}

test('Boss acknowledgement returns before WhatsApp completes and leaves the incoming trigger available for processing', async t => {
  const pending = deferred();
  const h = await setup(t, { send: () => pending.promise });
  const message = await h.receive('ack-first');
  const row = await h.service.acknowledge(message, { groupKey: 'lead-group-A' });
  assert.equal(row.status, 'PENDING');
  await flushTurn();
  assert.deepEqual(h.calls, [{ to: senderPhone, text: ACKNOWLEDGEMENT }]);
  assert.equal((await h.service.repository.get(row.id)).status, 'SENDING');
  assert.equal(h.triggerGate.beginProcessing(message.whatsapp_message_id), true);
  pending.resolve({ messages: [{ id: 'wamid.fast-ack' }] });
  await h.service.flush();
  assert.equal(h.triggerGate.allows(message.whatsapp_message_id), true);
  assert.equal((await h.service.repository.get(row.id)).provider_message_id, 'wamid.fast-ack');
  assert.equal(await h.store.getReply(message.whatsapp_message_id), null, 'The final outbox remains available.');
});

test('concurrent duplicate receipts and later fragments in one group receive one durable acknowledgement', async t => {
  const h = await setup(t);
  const first = await h.receive('ack-group-first');
  const second = await h.receive('ack-group-second');
  const rows = await Promise.all([h.service.acknowledge(first, { groupKey: 'same-group' }),
    h.service.acknowledge(first, { groupKey: 'same-group' }), h.service.acknowledge(second, { groupKey: 'same-group' })]);
  await h.service.flush();
  assert.equal(new Set(rows.map(row => row.id)).size, 1);
  assert.equal(h.calls.length, 1);
  await h.service.acknowledge(second, { groupKey: 'different-group' });
  await h.service.flush();
  assert.equal(h.calls.length, 2);
});

test('unadmitted, historical, expired, completed and closed triggers cannot send acknowledgements', async t => {
  let time = Date.now();
  const h = await setup(t, { clock: () => time });
  const unknown = await h.receive('not-admitted', {}, { admit: false });
  assert.equal(await h.service.acknowledge(unknown), null);
  const old = await h.receive('old-ack', { received_at: new Date(time - 3600000).toISOString() });
  assert.equal(await h.service.acknowledge(old), null);
  const done = await h.receive('finished-ack');
  h.triggerGate.finish(done.whatsapp_message_id);
  assert.equal(await h.service.acknowledge(done), null);
  const expired = await h.receive('expired-ack');
  time += 300001;
  assert.equal(await h.service.acknowledge(expired), null);
  const stopped = await h.receive('closed-ack');
  h.triggerGate.close();
  assert.equal(await h.service.acknowledge(stopped), null);
  await h.service.flush();
  assert.deepEqual(h.calls, []);
});

test('acknowledgement checks the trigger again after awaiting its durable send reservation', async t => {
  const h = await setup(t);
  const message = await h.receive('close-during-reserve');
  const reserve = h.service.repository.reserve;
  t.mock.method(h.service.repository, 'reserve', async id => {
    const row = await reserve(id);
    h.triggerGate.close();
    return row;
  });
  const queued = await h.service.acknowledge(message);
  await h.service.flush();
  assert.equal(h.calls.length, 0);
  assert.equal((await h.service.repository.get(queued.id)).status, 'CANCELLED');
});

test('only persisted authenticated Boss messages can acknowledge, regardless of caller-supplied metadata', async t => {
  const h = await setup(t);
  for (const [id, extra, boss] of [['unsigned-ack', { authenticated: false }, true], ['customer-ack', {}, false]]) {
    const message = await h.receive(id, extra, { boss });
    await assert.rejects(h.service.acknowledge({ ...message, authenticated: true }), { code: 'OUTGOING_NOT_AUTHORIZED' });
  }
  const message = await h.receive('revoked-ack');
  h.config.bossSenders.clear();
  assert.equal(await h.service.acknowledge(message), null);
  assert.equal(h.calls.length, 0);
});

test('shutdown waits for a send already dispatched, records acceptance, and starts no new acknowledgement', async t => {
  const pending = deferred();
  const h = await setup(t, { send: () => pending.promise });
  const first = await h.receive('in-flight-at-stop');
  const row = await h.service.acknowledge(first);
  await flushTurn();
  assert.equal(h.calls.length, 1);
  let stopped = false;
  const stopping = h.service.stop().then(() => { stopped = true; });
  await flushTurn();
  assert.equal(stopped, false);
  pending.resolve({ messages: [{ id: 'wamid.accepted-before-stop' }] });
  await stopping;
  assert.equal((await h.service.repository.get(row.id)).status, 'SENT');
  assert.equal(await h.service.acknowledge(first), null);
  assert.equal(h.calls.length, 1);
});

test('manual send uses the real service contract and records outgoing evidence without entering the incoming gate', async t => {
  const h = await setup(t);
  await h.receive('manual-source', {}, { admit: false, boss: false });
  const request = { senderPhone, text: 'Your quotation is being prepared.', requestKey: randomUUID() };
  const result = await h.service.sendManual(request);
  assert.equal(result.kind, 'manual');
  assert.equal(result.status, 'SENT');
  assert.equal(result.message_id, 'manual-source');
  assert.match(result.provider_message_id, /^wamid\./);
  assert.deepEqual(h.calls, [{ to: senderPhone, text: request.text }]);
  assert.deepEqual(h.triggerGate.messageIds(), []);
  assert.equal((await h.store.getMessage('manual-source')).processing_status, 'RECEIVED');
  assert.equal(await h.store.getReply('manual-source'), null);
  assert.equal((await h.service.sendManual(request)).id, result.id);
  assert.equal(h.calls.length, 1);
});

test('manual request IDs prevent duplicate sends across simultaneous requests, connections and restart', async t => {
  let otherStore;
  t.after(() => otherStore?.close());
  const h = await setup(t);
  await h.receive('manual-dedup-source', {}, { boss: false, admit: false });
  otherStore = createMessageStore({ databaseUrl: h.databaseUrl, logger: silent });
  await otherStore.init();
  const other = createOutgoingMessages({ store: otherStore, whatsapp: h.whatsapp, config: h.config, logger: silent });
  t.after(() => other.stop());
  const request = { senderPhone, text: 'One manual message.', requestKey: randomUUID() };
  const results = await Promise.all([h.service.sendManual(request), other.sendManual(request)]);
  await Promise.all([h.service.flush(), other.flush()]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(h.calls.length, 1);
  const restarted = createOutgoingMessages({ store: otherStore, whatsapp: h.whatsapp, config: h.config, logger: silent });
  t.after(() => restarted.stop());
  assert.equal((await restarted.sendManual(request)).status, 'SENT');
  assert.equal(h.calls.length, 1);
  await assert.rejects(restarted.sendManual({ ...request, text: 'Different message.' }), { code: 'OUTGOING_CONFLICT' });
  assert.equal(h.calls.length, 1);
});

test('new service instances never dispatch old PENDING or abandoned SENDING rows', async t => {
  const h = await setup(t);
  const source = await h.receive('abandoned-source');
  const pendingKey = randomUUID();
  for (const [requestKey, reserve] of [[pendingKey, false], [randomUUID(), true]]) {
    const record = await h.service.repository.insert({ requestKey: 'manual:' + requestKey, messageId: source.whatsapp_message_id,
      senderPhone, kind: 'manual', text: 'Old message' });
    if (reserve) await h.service.repository.reserve(record.row.id);
  }
  const restarted = createOutgoingMessages({ store: h.store, whatsapp: h.whatsapp, config: h.config, logger: silent });
  t.after(() => restarted.stop());
  await restarted.flush();
  const result = await restarted.sendManual({ senderPhone, text: 'Old message', requestKey: pendingKey });
  assert.equal(result.status, 'PENDING');
  await restarted.flush();
  assert.equal(h.calls.length, 0);
});

test('manual sending requires a known authenticated conversation and a current reply window', async t => {
  const h = await setup(t);
  const send = () => h.service.sendManual({ senderPhone, text: 'Hello', requestKey: randomUUID() });
  await assert.rejects(send(), { code: 'OUTGOING_NOT_FOUND' });
  await h.receive('unsigned-manual', { authenticated: false }, { admit: false, boss: false });
  await assert.rejects(send(), { code: 'OUTGOING_NOT_FOUND' });
  await h.receive('expired-manual', { received_at: new Date(Date.now() - 24 * 3600000).toISOString() }, { admit: false, boss: false });
  await assert.rejects(send(), { code: 'OUTGOING_WINDOW_EXPIRED' });
  for (const patch of [{ senderPhone: '0501234567' }, { requestKey: 'not-a-uuid' }, { text: '' }, { text: 'x'.repeat(4097) }, { text: 'bad\0body' }]) {
    await assert.rejects(h.service.sendManual({ senderPhone, text: 'Hello', requestKey: randomUUID(), ...patch }), { code: 'OUTGOING_INPUT' });
  }
  assert.equal(h.calls.length, 0);
});

for (const deliveryState of ['NOT_ATTEMPTED', 'ATTEMPTED_FAILED', 'UNKNOWN', 'unsafe-private-token']) {
  test(`manual ${deliveryState} outcome is durable, sanitized and never automatically sent again`, async t => {
    const h = await setup(t, { send() { throw Object.assign(new Error('private-provider-error'), { deliveryState }); } });
    await h.receive('outcome-source', {}, { admit: false, boss: false });
    const request = { senderPhone, text: 'Private customer text', requestKey: randomUUID() };
    const first = await h.service.sendManual(request);
    assert.equal(first.status, ['NOT_ATTEMPTED', 'ATTEMPTED_FAILED'].includes(deliveryState) ? 'FAILED' : 'UNKNOWN');
    assert.equal((await h.service.sendManual(request)).id, first.id);
    assert.equal(h.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(h.logs), /private-provider-error|unsafe-private-token|Private customer text/);
  });
}

test('accepted send whose completion fails retains its provider evidence and cannot send twice', async t => {
  const h = await setup(t);
  await h.receive('evidence-source', {}, { admit: false, boss: false });
  t.mock.method(h.service.repository, 'finish', async () => { throw new Error('private-storage-error'); });
  const request = { senderPhone, text: 'Receipt evidence.', requestKey: randomUUID() };
  const result = await h.service.sendManual(request);
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.provider_message_id, 'wamid.synthetic-outgoing-1');
  assert.equal(result.error_code, 'PROVIDER_ACCEPTED_RECONCILIATION_REQUIRED');
  assert.equal((await h.service.sendManual(request)).id, result.id);
  assert.equal(await h.service.repository.reserve(result.id), null);
  assert.equal(h.calls.length, 1);
});

test('repository rejects conflicting acceptance evidence and only one reservation can win', async t => {
  const h = await setup(t);
  await h.receive('repository-source', {}, { boss: false, admit: false });
  const repository = createOutgoingRepository({ store: h.store });
  const inserted = await repository.insert({ requestKey: 'manual:' + randomUUID(), messageId: 'repository-source', senderPhone,
    kind: 'manual', text: 'Synthetic message' });
  const [first, second] = await Promise.all([repository.reserve(inserted.row.id), repository.reserve(inserted.row.id)]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal(await repository.recordAcceptance(inserted.row.id, 'wamid.first-evidence'), 'UNKNOWN');
  assert.equal(await repository.recordAcceptance(inserted.row.id, 'wamid.conflicting-evidence'), null);
  assert.equal((await repository.get(inserted.row.id)).provider_message_id, 'wamid.first-evidence');
  assert.equal(await repository.reserve(inserted.row.id), null);
});
