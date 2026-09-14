'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { createMessageStore } = require('../src/database');
const { temporaryStore, incoming } = require('./helpers');

const ago = milliseconds => new Date(Date.now() - milliseconds).toISOString();
const conversation = { processingFlow: 'conversation' };
const boss = { processingFlow: 'boss_lead' };
const message = (id, overrides = {}) => incoming({ whatsapp_message_id: id, ...overrides });

async function fixture(t, dialect) {
  if (dialect === 'sqlite') return temporaryStore(t);
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `test_trigger_scope_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const connectionUrl = new URL(process.env.TEST_DATABASE_URL);
  connectionUrl.searchParams.set('options', `-c search_path=${schema}`);
  const store = createMessageStore({ databaseUrl: connectionUrl.toString() });
  t.after(async () => {
    try { await store.close(); }
    finally {
      try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { await admin.end(); }
    }
  });
  await store.init();
  return { store };
}

async function snapshot(store, ids) {
  return Promise.all(ids.map(async id => ({
    message: await store.getMessage(id), extraction: await store.getLeadExtraction(id), reply: await store.getReply(id),
  })));
}

for (const dialect of ['sqlite', 'postgres']) {
  const dbTest = (name, run) => test(`${dialect}: trigger scope ${name}`,
    { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL }, async t => run((await fixture(t, dialect)).store, t));

  dbTest('an empty authorization list performs no database operations', async (store, t) => {
    t.mock.method(store.driver, 'query', () => { assert.fail('Empty scope cannot query or mutate the database.'); });
    t.mock.method(store.driver, 'transaction', () => { assert.fail('Empty scope cannot open a transaction.'); });
    for (const method of ['claimNext', 'claimLeadExtraction', 'claimReply']) {
      assert.equal(await store[method]({ messageIds: [] }), null);
    }
  });

  dbTest('validates bounded unique IDs and binds IDs as data', async store => {
    for (const method of ['claimNext', 'claimLeadExtraction', 'claimReply']) {
      for (const messageIds of ['id', new Set(['id']), [null], [''], ['x'.repeat(513)], ['a', 'a'], Array(1001).fill('id')]) {
        await assert.rejects(store[method]({ messageIds }), /Invalid messageId/);
      }
      assert.equal(await store[method]({ messageIds: Array.from({ length: 1000 }, (_, n) => `absent-${n}`) }), null);
      assert.equal(await store[method]({ messageIds: ["') OR TRUE --"] }), null);
    }
    const id = "wamid.'quoted-id";
    await store.enqueueMany([message(id)], conversation);
    assert.equal((await store.claimNext({ ...conversation, messageIds: [id] })).whatsapp_message_id, id);
  });

  dbTest('inbox selection and expiry cleanup leave all other messages untouched', async store => {
    const outside = ['outside-pending', 'outside-old', 'outside-exhausted'];
    await store.enqueueMany([...outside, 'inside-old', 'inside-exhausted', 'inside-fresh'].map(id => message(id)), conversation);
    for (const id of ['outside-old', 'inside-old']) {
      await store.driver.query('UPDATE whatsapp_messages SET received_at=? WHERE whatsapp_message_id=?', [ago(24 * 3600000), id]);
    }
    for (const id of ['outside-exhausted', 'inside-exhausted']) {
      await store.driver.query("UPDATE whatsapp_messages SET processing_status='PROCESSING',attempts=1,lease_token='abandoned',lease_expires_at=? WHERE whatsapp_message_id=?", [ago(1000), id]);
    }
    const before = await snapshot(store, outside);
    const options = { ...conversation, maxAttempts: 1, messageIds: ['inside-old', 'inside-exhausted', 'inside-fresh'] };
    assert.equal((await store.claimNext(options)).whatsapp_message_id, 'inside-fresh');
    assert.equal(await store.claimNext(options), null);
    assert.equal((await store.getMessage('inside-old')).error_message, 'CUSTOMER_SERVICE_WINDOW_EXPIRED');
    assert.equal((await store.getMessage('inside-exhausted')).error_message, 'PROCESSING_ATTEMPTS_EXHAUSTED');
    assert.deepEqual(await snapshot(store, outside), before);
  });

  dbTest('lead extraction ignores historic blockers while retaining authorized receipt order', async store => {
    const outside = ['outside-first', 'outside-exhausted'];
    const inside = ['inside-exhausted', 'inside-first', 'inside-second'];
    await store.enqueueMany([...outside, ...inside].map(id => message(id, { request_lead_workflow: true })), boss);
    for (const id of ['outside-exhausted', 'inside-exhausted']) {
      await store.driver.query("UPDATE lead_extractions SET processing_status='PROCESSING',attempts=1,lease_token='abandoned',lease_expires_at=? WHERE message_id=?", [ago(1000), id]);
    }
    const before = await snapshot(store, outside);
    const options = { messageIds: [...inside].reverse(), maxAttempts: 1 };
    const first = await store.claimLeadExtraction(options);
    assert.equal(first.message_id, 'inside-first');
    assert.equal(await store.claimLeadExtraction(options), null, 'The next authorized turn waits for the first authorized turn.');
    assert.equal((await store.getLeadExtraction('inside-exhausted')).error_message, 'PROCESSING_ATTEMPTS_EXHAUSTED');
    assert.deepEqual(await snapshot(store, outside), before);
    await store.driver.query("UPDATE lead_extractions SET processing_status='SUCCESS',lease_token=NULL,lease_expires_at=NULL WHERE message_id=?", [first.message_id]);
    assert.equal((await store.claimLeadExtraction(options)).message_id, 'inside-second');
    assert.deepEqual(await snapshot(store, outside), before);
  });

  dbTest('outbox scope excludes historic blockers and protects unrelated pending and uncertain sends', async store => {
    const outside = ['outside-pending', 'outside-old', 'outside-sending'];
    const inside = ['inside-old', 'inside-sending', 'inside-first', 'inside-second'];
    await store.enqueueMany([...outside, ...inside].map(id => message(id, { request_lead_workflow: true })), boss);
    for (const id of [...outside, ...inside]) {
      await store.driver.query("UPDATE whatsapp_messages SET processing_status='SUCCESS' WHERE whatsapp_message_id=?", [id]);
      await store.queueReply(id, 'Reply for ' + id);
    }
    for (const id of ['outside-old', 'inside-old']) {
      await store.driver.query('UPDATE whatsapp_messages SET received_at=? WHERE whatsapp_message_id=?', [ago(24 * 3600000), id]);
    }
    for (const id of ['outside-sending', 'inside-sending']) {
      await store.driver.query("UPDATE reply_outbox SET status='SENDING',lease_token='abandoned',lease_expires_at=? WHERE message_id=?", [ago(1000), id]);
    }
    const before = await snapshot(store, outside);
    const options = { ...boss, messageIds: [...inside].reverse() };
    const first = await store.claimReply(options);
    assert.equal(first.message_id, 'inside-first');
    assert.equal(await store.claimReply(options), null, 'The next authorized reply waits for the first authorized reply.');
    assert.equal((await store.getReply('inside-old')).error_message, 'CUSTOMER_SERVICE_WINDOW_EXPIRED');
    assert.equal((await store.getReply('inside-sending')).status, 'UNKNOWN');
    assert.deepEqual(await snapshot(store, outside), before);
    assert.equal(await store.finishReply(first.id, first.lease_token, { status: 'SENT', provider_message_id: 'synthetic-sent' }), true);
    assert.equal((await store.claimReply(options)).message_id, 'inside-second');
    assert.deepEqual(await snapshot(store, outside), before);
  });

  dbTest('explicit null keeps legacy selection and fixed-text filters work with IDs', async store => {
    await store.enqueueMany([message('legacy-inbox')], conversation);
    assert.equal((await store.claimNext({ ...conversation, messageIds: null })).whatsapp_message_id, 'legacy-inbox');
    await store.enqueueMany([message('legacy-extraction', { request_lead_workflow: true })], boss);
    assert.equal((await store.claimLeadExtraction({ messageIds: null })).message_id, 'legacy-extraction');
    await store.enqueueMany([message('legacy-reply')], { replyText: 'Fixed reply' });
    assert.equal(await store.claimReply({ messageIds: ['legacy-reply'], replyText: 'Different reply' }), null);
    assert.equal((await store.claimReply({ messageIds: null, replyText: 'Fixed reply' })).message_id, 'legacy-reply');
    await store.enqueueMany([message('scoped-fixed-reply')], { replyText: 'Fixed reply' });
    assert.equal((await store.claimReply({ messageIds: ['scoped-fixed-reply'], replyText: 'Fixed reply' })).message_id, 'scoped-fixed-reply');
  });
}
