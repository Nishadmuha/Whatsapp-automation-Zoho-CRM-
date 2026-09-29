'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHmac } = require('node:crypto');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { temporaryStore, testEnv, silent } = require('./helpers');

const FIRST_WORKER = '+971568556901';
const SECOND_WORKER = '+971505479030';

async function setup(t, overrides = {}) {
  const { store, databaseUrl } = await temporaryStore(t);
  const env = testEnv({
    AUTOMATION_ENABLED: 'true', AI_PROVIDER: 'openai', META_APP_SECRET: 'synthetic-signing-secret',
    WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '123456', META_GRAPH_API_VERSION: 'v25.0',
    AUTHORIZED_BOOKS_PHONES: `${FIRST_WORKER},${SECOND_WORKER}`, AUTHORIZED_BOSS_PHONES: '+971501111111',
    ZOHO_BOOKS_SWITCHGEAR_ORG_ID: '802911060', ZOHO_BOOKS_CONTRACTING_ORG_ID: '828765858',
    DATABASE_URL: databaseUrl, MONGODB_URI: databaseUrl, ...overrides,
  });
  const app = createApp({ env, store, logger: silent });
  await app.locals.ready;
  const { billStore, config } = app.locals;
  await billStore.init();
  app.locals.onNewMessage = async message => {
    if (!config.booksSenders.has(message.senderPhone)) return;
    await billStore.enqueueBillExtraction({
      messageId: message.messageId, workerPhone: message.senderPhone,
      payload: { message_text: message.text, message_type: message.messageType, media_id: message.mediaId },
    });
  };
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  let sequence = 0;
  const send = async ({ from, type = 'text' }) => {
    const id = `wamid.books-workers.${++sequence}`;
    const message = {
      id, from: from.replace(/^\+/, ''), timestamp: String(Math.floor(Date.now() / 1000)), type,
      ...(type === 'text' ? { text: { body: 'Please enter this bill' } }
        : { image: { id: '555', mime_type: 'image/jpeg', caption: 'Invoice attached' } }),
    };
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
      value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '123456' }, messages: [message] },
    }] }] });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + createHmac('sha256', env.META_APP_SECRET).update(body).digest('hex') }, body,
    });
    await response.text();
    return { id, status: response.status };
  };
  return { store, billStore, config, send };
}

test('both authorized bill workers route signed media exclusively to Books, including a Boss-list overlap', async t => {
  const f = await setup(t, {
    AUTHORIZED_BOOKS_PHONES: `${FIRST_WORKER},0505479030`,
    AUTHORIZED_BOSS_PHONES: `+971501111111,${SECOND_WORKER}`,
  });
  assert.deepEqual([...f.config.booksSenders], [FIRST_WORKER, SECOND_WORKER]);
  for (const from of [FIRST_WORKER, SECOND_WORKER]) {
    const sent = await f.send({ from, type: 'image' });
    assert.equal(sent.status, 200);
    assert.equal((await f.store.getMessage(sent.id)).processing_flow, 'books_bill');
    const extraction = await f.billStore.getBillExtractionByMessageId(sent.id);
    assert.ok(extraction);
    assert.equal(extraction.worker_phone, from);
  }
  assert.equal(await f.billStore.col('bill_extractions').countDocuments(), 2);
  assert.equal((await f.store.listLeads()).items.length, 0);
});

test('two-worker Books allowlist leaves Boss and other senders outside bill extraction', async t => {
  const f = await setup(t);
  for (const [from, flow] of [['+971501111111', 'boss_lead'], ['+971509999999', 'conversation']]) {
    const sent = await f.send({ from });
    assert.equal(sent.status, 200);
    assert.equal((await f.store.getMessage(sent.id)).processing_flow, flow);
    assert.equal(await f.billStore.getBillExtractionByMessageId(sent.id), null);
  }
  for (const from of ['+971501111111', '+971509999999']) {
    const sent = await f.send({ from, type: 'image' });
    assert.equal(sent.status, 200);
    assert.notEqual((await f.store.getMessage(sent.id)).processing_flow, 'books_bill');
    assert.equal(await f.billStore.getBillExtractionByMessageId(sent.id), null);
  }
  assert.equal(await f.billStore.col('bill_extractions').countDocuments(), 0);
});
