'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHmac } = require('node:crypto');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { createBooksWorker } = require('../src/services/books/booksWorker');
const { createOutgoingMessages } = require('../src/services/whatsapp/outgoingMessages');
const { temporaryStore, testEnv, silent } = require('./helpers');
const { fixture, WORKER } = require('./billFixtures');

async function setup(t) {
  const { store, databaseUrl } = await temporaryStore(t);
  const env = testEnv({ AUTOMATION_ENABLED: 'true', AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-test', META_APP_SECRET: 'synthetic-signing-secret', WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '123456', META_GRAPH_API_VERSION: 'v25.0', AUTHORIZED_BOOKS_PHONES: '971568556901', AUTHORIZED_BOSS_PHONES: '+971501111111', ZOHO_BOOKS_SWITCHGEAR_ORG_ID: '802911060', ZOHO_BOOKS_CONTRACTING_ORG_ID: '828765858', DATABASE_URL: databaseUrl, MONGODB_URI: databaseUrl });
  const app = createApp({ env, store, logger: silent }); await app.locals.ready;
  const billStore = app.locals.billStore; await billStore.init();
  const f = fixture({ billStore, sourceStore: store });
  const { config, triggerGate } = app.locals;
  const outgoing = createOutgoingMessages({ store, whatsapp: f.whatsapp, config, triggerGate, logger: silent });
  const workerConfig = { ...config, messageBatchQuietMs: 0 };
  const worker = createBooksWorker({ billStore, billWorkflow: f.workflow, whatsapp: f.whatsapp, config: workerConfig, triggerGate, logger: silent });
  app.locals.onNewMessage = async message => {
    if (!config.booksSenders.has(message.senderPhone)) return;
    if (message.mediaId) { await outgoing.acknowledge(message, { isBooks: true }); await outgoing.flush(); }
    await billStore.enqueueBillExtraction({ messageId: message.messageId, workerPhone: message.senderPhone, payload: { message_text: message.text, message_type: message.messageType, media_id: message.mediaId } });
  };
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await outgoing.stop(); await worker.stop(); await new Promise(resolve => server.close(resolve)); });
  let sequence = 0;
  const send = async (text, { from = WORKER.slice(1), id = `wamid.pipeline.${++sequence}`, type = 'text', unsigned = false } = {}) => {
    const message = { id, from, timestamp: String(Math.floor(Date.now() / 1000)), type, ...(type === 'text' ? { text: { body: text } } : { [type]: { id: '555', mime_type: 'image/jpeg', caption: text } }) };
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '123456' }, messages: [message] } }] }] });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...(unsigned ? {} : { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', env.META_APP_SECRET).update(body).digest('hex') }) }, body });
    await response.text(); return { id, status: response.status };
  };
  return { ...f, app, worker, store, send };
}
test('signed worker Hi is books_bill, never a customer or CRM lead', async t => {
  const f = await setup(t); const sent = await f.send('Hi'); assert.equal(sent.status, 200);
  assert.equal((await f.store.getMessage(sent.id)).processing_flow, 'books_bill'); await f.worker.tick();
  assert.match(f.calls.find(c => c[0] === 'text')[2], /send the bill/i);
  assert.equal((await f.store.listLeads()).items.length, 0);
});
test('customer and boss retain distinct routes', async t => {
  const f = await setup(t);
  for (const [from, flow] of [['971501111111', 'boss_lead'], ['971509999999', 'conversation']]) {
    const sent = await f.send('Hello', { from }); assert.equal((await f.store.getMessage(sent.id)).processing_flow, flow);
    assert.equal(await f.billStore.getBillExtractionByMessageId(sent.id), null);
  }
});
test('media ACK precedes OCR, review is not silent, SAVE sends a created PDF', async t => {
  const f = await setup(t); await f.send('Fuel bill', { type: 'image' });
  assert.match(f.calls[0][2], /Processing the bill/); assert.equal(f.calls.some(c => c[0] === 'ocr'), false);
  await f.worker.tick(); assert.ok(f.calls.some(c => c[0] === 'text' && /1 SAVE/.test(c[2])));
  await f.send('SAVE'); await f.worker.tick(); assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  assert.equal(f.calls.find(c => c[0] === 'document')[2].buffer.toString(), '%PDF-created-record');
});
test('duplicate webhook inserts only one job and unsigned messages are rejected', async t => {
  const f = await setup(t); await f.send('Hi', { id: 'wamid.same' }); await f.send('Hi', { id: 'wamid.same' });
  assert.equal(await f.billStore.col('bill_extractions').countDocuments(), 1);
  assert.equal((await f.send('Hi', { unsigned: true })).status, 403);
  await f.worker.tick(); await f.worker.tick(); assert.equal(f.calls.filter(c => c[0] === 'text').length, 1);
});
test('Mongo atomic save reservation and restart preserve uncertainty lock', async t => {
  const f = await setup(t); await f.send('Bill details'); await f.worker.tick();
  const session = await f.billStore.getActiveBillSession(WORKER);
  const results = await Promise.all([f.billStore.claimBillSave(session.session_id, 'save1'), f.billStore.claimBillSave(session.session_id, 'save2')]);
  assert.deepEqual(results.sort(), [false, true]);
  await f.billStore.updateBillSession(session.session_id, { expires_at: new Date(0) });
  const { createBillStore } = require('../src/database/billStore'); const restarted = createBillStore({ store: f.store });
  assert.equal((await restarted.getActiveBillSession(WORKER)).state, 'CREATING_IN_ZOHO');
});
