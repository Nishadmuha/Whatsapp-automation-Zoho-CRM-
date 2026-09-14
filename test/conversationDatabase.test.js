'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMessageStore } = require('../src/database');
const { createMessagesAdmin } = require('../src/services/admin/messagesAdmin');

const FLOW = { processingFlow: 'conversation' };
const ago = milliseconds => new Date(Date.now() - milliseconds).toISOString();
const message = (id = randomUUID(), overrides = {}) => ({
  whatsapp_message_id: id, sender_phone: '971500000001', message_text: 'Please help with AC maintenance.',
  message_type: 'text', authenticated: true, received_at: new Date().toISOString(), ...overrides,
});

async function seedVersionOne(databaseUrl, dialect) {
  const migration = await fs.readFile(path.join(__dirname, `../migrations/001_initial.${dialect}.sql`), 'utf8');
  const seed = `
    INSERT INTO schema_migrations(version,applied_at) VALUES (1,'2026-01-01T00:00:00.000Z');
    INSERT INTO whatsapp_messages(whatsapp_message_id,sender_phone,message_text,message_type,authenticated,received_at,created_at)
      VALUES ('existing-v1','971500000001','Existing receipt','text',TRUE,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO reply_outbox(id,message_id,text,created_at)
      VALUES ('existing-reply','existing-v1','Existing reply','2026-01-01T00:00:00.000Z');`;
  if (dialect === 'sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databaseUrl.slice('file:'.length));
    try {
      db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
      db.exec(migration);
      db.exec(seed);
    } finally { db.close(); }
  } else {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL)');
      await pool.query(migration);
      await pool.query(seed);
    } finally { await pool.end(); }
  }
}

async function fixture(t, dialect, { legacy = false } = {}) {
  const stores = [];
  let databaseUrl;
  let cleanup;
  if (dialect === 'postgres') {
    const { Pool } = require('pg');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_conversation_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connectionUrl = new URL(process.env.TEST_DATABASE_URL);
    connectionUrl.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = connectionUrl.toString();
    cleanup = async () => {
      try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { await admin.end(); }
    };
  } else {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-conversation-db-'));
    databaseUrl = `file:${path.join(directory, 'messages.sqlite')}`;
    cleanup = async () => {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('whatsapp-conversation-db-'));
      await fs.rm(directory, { recursive: true, force: true });
    };
  }
  t.after(async () => {
    for (const store of stores.reverse()) await store.close();
    await cleanup();
  });
  if (legacy) await seedVersionOne(databaseUrl, dialect);
  async function connect() {
    const store = createMessageStore({ databaseUrl });
    stores.push(store);
    await store.init();
    return store;
  }
  return { store: await connect(), connect };
}

async function complete(store, job, text = 'How can we help with your request?') {
  return store.completeWithReply(job.whatsapp_message_id, job.lease_token,
    { processing_status: 'SUCCESS', processed_at: new Date().toISOString() }, text);
}

function databaseContract(dialect) {
  const options = { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL };
  const dbTest = (name, fn, fixtureOptions) => test(`${dialect}: conversation ${name}`, options,
    async t => fn(await fixture(t, dialect, fixtureOptions), t));

  dbTest('retains failed customer reply text and role after an explicit operator retry and restart', async ({ store, connect }) => {
    const source = message('archived-customer-reply', { sender_phone: '+971500000001' });
    await store.enqueueMany([source], FLOW);
    const job = await store.claimNext(FLOW);
    await store.completeWithReply(job.whatsapp_message_id, job.lease_token,
      { processing_status: 'FAILED' }, 'Please try again later.');
    const reply = await store.claimReply(FLOW);
    await store.finishReply(reply.id, reply.lease_token, { status: 'SENT', provider_message_id: 'wamid.archived-reply' });
    await createMessagesAdmin({ store }).retryMessage(source.whatsapp_message_id);
    const restarted = await connect();
    const history = await restarted.listConversationMessages(source.sender_phone);
    assert.equal(history.total, 2);
    assert.equal(history.items[0].sender_type, 'customer');
    assert.equal(history.items[1].sender_type, 'bot');
    assert.equal(history.items[1].text, 'Please try again later.');
    assert.equal(history.items[1].status, 'SENT');
    assert.equal(history.items[1].whatsapp_message_id, 'wamid.archived-reply');
    assert.equal((await restarted.getConversation(source.sender_phone)).last_message, 'Please try again later.');
    assert.equal(await restarted.claimReply(FLOW), null);
    assert.equal((await restarted.listLeads()).total, 0);
  });

  dbTest('upgrades version 1 in place, preserves unscoped data, and reopens idempotently', async ({ store, connect }) => {
    const original = await store.getMessage('existing-v1');
    const originalReply = await store.getReply('existing-v1');
    assert.equal(original.processing_flow, null);
    assert.equal(original.message_text, 'Existing receipt');
    assert.equal(originalReply.text, 'Existing reply');
    assert.equal(await store.claimNext(FLOW), null);
    assert.equal(await store.claimReply(FLOW), null);
    assert.deepEqual(await store.getMessage('existing-v1'), original);
    assert.deepEqual(await store.getReply('existing-v1'), originalReply);
    await store.close();
    const reopened = await connect();
    await reopened.init();
assert.deepEqual((await reopened.driver.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(await reopened.getMessage('existing-v1'), original);
    await reopened.enqueueMany([message('after-upgrade')], FLOW);
    assert.equal((await reopened.claimNext(FLOW)).whatsapp_message_id, 'after-upgrade');
  }, { legacy: true });

  dbTest('requires explicit opt-in and authentic nonblank text, persisting the scope across restart', async ({ store, connect }) => {
    const ineligible = [
      message('unsigned', { authenticated: false }), message('truthy-auth', { authenticated: 'true' }),
      message('media', { message_type: 'image' }), message('empty', { message_text: '' }),
      message('whitespace', { message_text: ' \n\t ' }),
    ];
    await store.enqueueMany(ineligible, FLOW);
    await store.enqueueMany([message('default', { processing_flow: 'conversation' })]);
    await store.enqueueMany([message('eligible')], FLOW);
    for (const input of [...ineligible, message('default')]) {
      assert.equal((await store.getMessage(input.whatsapp_message_id)).processing_flow, null);
    }
    await store.close();
    const reopened = await connect();
    const job = await reopened.claimNext(FLOW);
    assert.equal(job.whatsapp_message_id, 'eligible');
    assert.equal(job.processing_flow, 'conversation');
    assert.equal(job.authenticated, true);
    assert.equal(await reopened.claimNext(FLOW), null);
    await assert.rejects(reopened.mark(job.whatsapp_message_id, job.lease_token, { processing_flow: null }), /Unsupported message patch field/);
    await assert.rejects(async () => reopened.driver.query("UPDATE whatsapp_messages SET processing_flow='legacy' WHERE whatsapp_message_id='eligible'"));
  });

  dbTest('duplicate opt-in cannot retag disabled receipts, fixed replies, or legacy CRM work', async ({ store }) => {
    const legacy = message('legacy-crm');
    const disabled = message('disabled');
    const fixed = message('fixed');
    await store.enqueueMany([legacy]);
    const oldJob = await store.claimNext();
    assert.equal(await store.completeWithReply(oldJob.whatsapp_message_id, oldJob.lease_token,
      { processing_status: 'SUCCESS', zoho_lead_id: 'synthetic-crm-id', crm_action: 'CREATE' }, 'Legacy CRM reply'), true);
    await store.enqueueMany([disabled]);
    await store.enqueueMany([fixed], { replyText: 'Old fixed reply' });
    const before = await Promise.all([legacy, disabled, fixed].map(input => store.getMessage(input.whatsapp_message_id)));
    const oldReplies = await Promise.all([legacy, fixed].map(input => store.getReply(input.whatsapp_message_id)));
    assert.deepEqual(await store.enqueueMany([legacy, disabled, fixed, message('new-conversation')], { ...FLOW, includeInsertedIds: true }),
      { inserted: 1, duplicates: 3, insertedIds: ['new-conversation'] });
    assert.deepEqual(await Promise.all([legacy, disabled, fixed].map(input => store.getMessage(input.whatsapp_message_id))), before);
    assert.equal(await store.claimReply(FLOW), null);
    const job = await store.claimNext(FLOW);
    assert.equal(job.whatsapp_message_id, 'new-conversation');
    assert.equal(await complete(store, job), true);
    const reply = await store.claimReply(FLOW);
    assert.equal(reply.message_id, job.whatsapp_message_id);
    assert.equal(reply.processing_flow, 'conversation');
    assert.equal(reply.sender_phone, job.sender_phone);
    assert.equal(reply.authenticated, true);
    assert.equal(reply.message_type, 'text');
    assert.equal(await store.claimNext(FLOW), null);
    assert.equal(await store.claimReply(FLOW), null);
    assert.deepEqual(await Promise.all([legacy, fixed].map(input => store.getReply(input.whatsapp_message_id))), oldReplies);
  });

  dbTest('concurrent duplicate intake never changes the winning receipt scope', async ({ store, connect }) => {
    const other = await connect();
    const input = message('concurrent-intake');
    const results = await Promise.all([store.enqueueMany([input]), other.enqueueMany([input], FLOW)]);
    assert.equal(results[0].inserted + results[1].inserted, 1);
    const expectedFlow = results[1].inserted ? 'conversation' : null;
    assert.equal((await store.getMessage(input.whatsapp_message_id)).processing_flow, expectedFlow);
    await Promise.all([store.enqueueMany([input], FLOW), other.enqueueMany([input], { replyText: 'Fixed' })]);
    assert.equal((await store.getMessage(input.whatsapp_message_id)).processing_flow, expectedFlow);
    assert.equal(await store.getReply(input.whatsapp_message_id), null);
  });

  dbTest('claims are unique, recover leases, fence stale owners, and exhaust attempts within scope', async ({ store, connect }) => {
    const other = await connect();
    await store.enqueueMany([message('legacy-stale')]);
    const legacy = await store.claimNext({ maxAttempts: 1 });
    await store.driver.query('UPDATE whatsapp_messages SET lease_expires_at=? WHERE whatsapp_message_id=?', [ago(1000), legacy.whatsapp_message_id]);
    const legacyBefore = await store.getMessage(legacy.whatsapp_message_id);
    await store.enqueueMany([message('scoped-lease')], FLOW);
    const results = await Promise.all([store.claimNext({ ...FLOW, maxAttempts: 2 }), other.claimNext({ ...FLOW, maxAttempts: 2 })]);
    const first = results.find(Boolean);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(first.whatsapp_message_id, 'scoped-lease');
    assert.equal(await store.heartbeat(first.whatsapp_message_id, first.lease_token), true);
    await store.driver.query('UPDATE whatsapp_messages SET lease_expires_at=? WHERE whatsapp_message_id=?', [ago(1000), first.whatsapp_message_id]);
    const second = await other.claimNext({ ...FLOW, maxAttempts: 2 });
    assert.equal(second.attempts, 2);
    assert.notEqual(second.lease_token, first.lease_token);
    assert.equal(await complete(store, first), false);
    assert.equal(await store.heartbeat(first.whatsapp_message_id, first.lease_token), false);
    await store.driver.query('UPDATE whatsapp_messages SET lease_expires_at=? WHERE whatsapp_message_id=?', [ago(1000), second.whatsapp_message_id]);
    assert.equal(await store.claimNext({ ...FLOW, maxAttempts: 2 }), null);
    const exhausted = await store.getMessage(second.whatsapp_message_id);
    assert.equal(exhausted.processing_status, 'FAILED');
    assert.equal(exhausted.error_message, 'PROCESSING_ATTEMPTS_EXHAUSTED');
    assert.equal(exhausted.next_attempt_at, null);
    assert.equal(exhausted.lease_token, null);
    assert.deepEqual(await store.getMessage(legacy.whatsapp_message_id), legacyBefore);
  });

  dbTest('retries only due scheduled failures and leaves terminal failures unclaimed', async ({ store }) => {
    await store.enqueueMany([message('retry')], FLOW);
    const first = await store.claimNext(FLOW);
    assert.equal(await store.mark(first.whatsapp_message_id, first.lease_token,
      { processing_status: 'FAILED', error_message: 'TRANSIENT', next_attempt_at: new Date(Date.now() + 60000).toISOString() }), true);
    assert.equal(await store.claimNext(FLOW), null);
    await store.driver.query('UPDATE whatsapp_messages SET next_attempt_at=? WHERE whatsapp_message_id=?', [ago(1000), first.whatsapp_message_id]);
    const retry = await store.claimNext(FLOW);
    assert.equal(retry.attempts, 2);
    assert.equal(await store.mark(retry.whatsapp_message_id, retry.lease_token,
      { processing_status: 'FAILED', error_message: 'TERMINAL', next_attempt_at: null }), true);
    assert.equal(await store.claimNext(FLOW), null);
  });

  dbTest('expires old pending, retrying, and abandoned jobs before claiming without touching legacy or active work', async ({ store }) => {
    const expiredAt = ago(23 * 60 * 60 * 1000 + 60000);
    await store.enqueueMany([message('legacy-old', { received_at: expiredAt })]);
    const legacyBefore = await store.getMessage('legacy-old');
    await store.enqueueMany(['old-pending', 'old-retry', 'old-abandoned', 'old-active'].map(id => message(id, { received_at: expiredAt })), FLOW);
    await store.driver.query("UPDATE whatsapp_messages SET processing_status='FAILED',next_attempt_at=? WHERE whatsapp_message_id='old-retry'", [new Date(Date.now() + 60000).toISOString()]);
    await store.driver.query("UPDATE whatsapp_messages SET processing_status='PROCESSING',lease_token='expired-owner',lease_expires_at=? WHERE whatsapp_message_id='old-abandoned'", [ago(1000)]);
    await store.driver.query("UPDATE whatsapp_messages SET processing_status='PROCESSING',lease_token='active-owner',lease_expires_at=? WHERE whatsapp_message_id='old-active'", [new Date(Date.now() + 60000).toISOString()]);
    const activeBefore = await store.getMessage('old-active');
    assert.equal(await store.claimNext(FLOW), null);
    for (const id of ['old-pending', 'old-retry', 'old-abandoned']) {
      const row = await store.getMessage(id);
      assert.equal(row.processing_status, 'FAILED');
      assert.equal(row.error_message, 'CUSTOMER_SERVICE_WINDOW_EXPIRED');
      assert.equal(row.attempts, 0);
      assert.equal(row.next_attempt_at, null);
      assert.equal(row.lease_token, null);
      assert.ok(row.processed_at);
      assert.equal(await store.getReply(id), null);
    }
    assert.deepEqual(await store.getMessage('legacy-old'), legacyBefore);
    assert.deepEqual(await store.getMessage('old-active'), activeBefore);
  });

  dbTest('completion commits one reply atomically and scoped sends never recover another flow', async ({ store, connect }) => {
    await store.enqueueMany([message('legacy-send')], { replyText: 'Legacy' });
    const legacyReply = await store.claimReply();
    await store.driver.query('UPDATE reply_outbox SET lease_expires_at=? WHERE id=?', [ago(1000), legacyReply.id]);
    const before = await store.getReply('legacy-send');
    await store.enqueueMany([message('conversation-send')], FLOW);
    const job = await store.claimNext(FLOW);
    assert.equal(await complete(store, job, 'Conversation answer'), true);
    assert.equal(await complete(store, job, 'Duplicate answer'), false);
    await store.close();
    const reopened = await connect();
    assert.equal((await reopened.getMessage(job.whatsapp_message_id)).processing_status, 'SUCCESS');
    const reply = await reopened.claimReply(FLOW);
    assert.equal(reply.text, 'Conversation answer');
    assert.equal(reply.processing_flow, 'conversation');
    assert.deepEqual(await reopened.getReply('legacy-send'), before);
    await reopened.driver.query('UPDATE reply_outbox SET lease_expires_at=? WHERE id=?', [ago(1000), reply.id]);
    assert.equal(await reopened.claimReply(FLOW), null);
    assert.equal((await reopened.getReply(job.whatsapp_message_id)).status, 'UNKNOWN');
    assert.equal(await reopened.finishReply(reply.id, reply.lease_token, { status: 'SENT' }), false);
    assert.deepEqual(await reopened.getReply('legacy-send'), before);
  });

  dbTest('expires only scoped pending replies and preserves the optional reply text filter', async ({ store }) => {
    const expiredAt = ago(24 * 60 * 60 * 1000);
    await store.enqueueMany([message('legacy-expired', { received_at: expiredAt })], { replyText: 'Legacy expired reply' });
    const legacyBefore = await store.getReply('legacy-expired');
    for (const [id, text] of [['conversation-expired', 'Expired'], ['conversation-matching', 'Chosen'], ['conversation-other', 'Other']]) {
      await store.enqueueMany([message(id)], FLOW);
      assert.equal(await complete(store, await store.claimNext(FLOW), text), true);
    }
    await store.driver.query("UPDATE whatsapp_messages SET received_at=? WHERE whatsapp_message_id='conversation-expired'", [expiredAt]);
    const reply = await store.claimReply({ ...FLOW, replyText: 'Chosen' });
    assert.equal(reply.message_id, 'conversation-matching');
    assert.equal((await store.getReply('conversation-expired')).status, 'FAILED');
    assert.equal((await store.getReply('conversation-expired')).error_message, 'CUSTOMER_SERVICE_WINDOW_EXPIRED');
    assert.equal((await store.getReply('conversation-other')).status, 'PENDING');
    assert.deepEqual(await store.getReply('legacy-expired'), legacyBefore);
  });

  dbTest('claims require authenticated text even if a stored scope is inconsistent', async ({ store }) => {
    await store.enqueueMany([message('bad-auth', { authenticated: false }), message('bad-type', { message_type: 'image' })]);
    await store.driver.query("UPDATE whatsapp_messages SET processing_flow='conversation'");
    assert.equal(await store.claimNext(FLOW), null);
    await store.driver.query("UPDATE whatsapp_messages SET processing_status='SUCCESS'");
    await store.queueReply('bad-auth', 'Never send');
    await store.queueReply('bad-type', 'Never send');
    assert.equal(await store.claimReply(FLOW), null);
    assert.equal((await store.getReply('bad-auth')).status, 'PENDING');
    assert.equal((await store.getReply('bad-type')).status, 'PENDING');
  });

  dbTest('rejects unsupported flows and mixed intake modes before writing', async ({ store }) => {
    for (const processingFlow of ['', 'legacy', 'CONVERSATION', false, 1, {}, []]) {
      await assert.rejects(store.enqueueMany([message('invalid-options')], { processingFlow }), /Invalid processing flow/);
      await assert.rejects(store.claimNext({ processingFlow }), /Invalid processing flow/);
      await assert.rejects(store.claimReply({ processingFlow }), /Invalid processing flow/);
    }
    await assert.rejects(store.enqueueMany([message('mixed')], { ...FLOW, replyText: 'Fixed reply' }), /cannot be combined/);
    assert.equal(await store.getMessage('invalid-options'), null);
    assert.equal(await store.getMessage('mixed'), null);
  });
}

databaseContract('sqlite');
databaseContract('postgres');

test('sqlite: conversation outbox insertion failure rolls back completion and retains its lease', async t => {
  const { store } = await fixture(t, 'sqlite');
  await store.enqueueMany([message('rollback')], FLOW);
  const job = await store.claimNext(FLOW);
  store.driver.db.exec("CREATE TRIGGER reject_conversation_reply BEFORE INSERT ON reply_outbox BEGIN SELECT RAISE(ABORT,'synthetic outbox failure'); END");
  await assert.rejects(complete(store, job), /synthetic outbox failure/);
  assert.deepEqual(await store.getMessage(job.whatsapp_message_id), job);
  assert.equal(await store.getReply(job.whatsapp_message_id), null);
});
