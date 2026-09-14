'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMessageStore } = require('../src/database');

const FLOW = { processingFlow: 'conversation' };
const ago = milliseconds => new Date(Date.now() - milliseconds).toISOString();
const message = (id = randomUUID(), overrides = {}) => ({
  whatsapp_message_id: id, sender_phone: '971500000001', message_text: 'Synthetic customer needs AC maintenance.',
  message_type: 'text', authenticated: true, received_at: new Date().toISOString(), request_lead_extraction: true,
  ...overrides,
});
const extracted = { name: 'Synthetic Customer', phone: null, service: 'AC maintenance', location: null };

async function seedVersionTwo(databaseUrl, dialect) {
  const migrations = await Promise.all(['001_initial', '002_conversation'].map(name =>
    fs.readFile(path.join(__dirname, `../migrations/${name}.${dialect}.sql`), 'utf8')));
  const seed = `
    INSERT INTO schema_migrations(version,applied_at) VALUES (1,'2026-01-01T00:00:00.000Z'),(2,'2026-01-01T00:00:00.000Z');
    INSERT INTO whatsapp_messages(whatsapp_message_id,sender_phone,message_text,message_type,authenticated,received_at,created_at,processing_flow)
      VALUES ('existing-v2','971500000001','Existing conversation receipt','text',TRUE,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','conversation');
    INSERT INTO reply_outbox(id,message_id,text,created_at)
      VALUES ('existing-reply','existing-v2','Existing conversation reply','2026-01-01T00:00:00.000Z');`;
  if (dialect === 'sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databaseUrl.slice('file:'.length));
    try {
      db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
      for (const migration of migrations) db.exec(migration);
      db.exec(seed);
    } finally { db.close(); }
  } else {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL)');
      for (const migration of migrations) await pool.query(migration);
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
    const schema = `test_extraction_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connectionUrl = new URL(process.env.TEST_DATABASE_URL);
    connectionUrl.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = connectionUrl.toString();
    cleanup = async () => {
      try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { await admin.end(); }
    };
  } else {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-extraction-db-'));
    databaseUrl = `file:${path.join(directory, 'messages.sqlite')}`;
    cleanup = async () => {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('whatsapp-extraction-db-'));
      await fs.rm(directory, { recursive: true, force: true });
    };
  }
  t.after(async () => {
    for (const store of stores.reverse()) await store.close();
    await cleanup();
  });
  if (legacy) await seedVersionTwo(databaseUrl, dialect);
  async function connect() {
    const store = createMessageStore({ databaseUrl });
    stores.push(store);
    await store.init();
    return store;
  }
  return { store: await connect(), connect };
}

const finish = (store, job, patch = {}) => store.finishLeadExtraction(job.message_id, job.lease_token,
  { processing_status: 'SUCCESS', result: extracted, ...patch });

function databaseContract(dialect) {
  const options = { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL };
  const dbTest = (name, fn, fixtureOptions) => test(`${dialect}: extraction ${name}`, options,
    async t => fn(await fixture(t, dialect, fixtureOptions), t));

  dbTest('upgrades version 2 without backfill and reopens all migrations idempotently', async ({ store, connect }) => {
    const before = await store.getMessage('existing-v2');
    const replyBefore = await store.getReply('existing-v2');
assert.deepEqual((await store.driver.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(await store.getLeadExtraction('existing-v2'), null);
    await store.enqueueMany([message('existing-v2')], FLOW);
    assert.equal(await store.getLeadExtraction('existing-v2'), null);
    assert.deepEqual(await store.getMessage('existing-v2'), before);
    assert.deepEqual(await store.getReply('existing-v2'), replyBefore);
    await store.close();
    const reopened = await connect();
    await reopened.init();
    assert.deepEqual((await reopened.driver.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(await reopened.claimLeadExtraction(), null);
    await reopened.enqueueMany([message('after-upgrade')], FLOW);
    assert.equal((await reopened.claimLeadExtraction()).message_id, 'after-upgrade');
  }, { legacy: true });

  dbTest('retains original text and persists an independent job and result across restart', async ({ store, connect }) => {
    const input = message('original', { message_text: '  Synthetic request:\nAC maintenance.\nKeep punctuation & spacing.  ' });
    assert.deepEqual(await store.enqueueMany([input], { ...FLOW, includeInsertedIds: true }),
      { inserted: 1, duplicates: 0, insertedIds: ['original'] });
    const original = await store.getMessage(input.whatsapp_message_id);
    const queued = await store.getLeadExtraction(input.whatsapp_message_id);
    assert.equal(queued.processing_status, 'RECEIVED');
    assert.equal(queued.created_at, original.created_at);
    assert.equal(queued.attempts, 0);
    assert.equal(queued.result, null);
    assert.equal(original.message_text, input.message_text);
    await store.close();
    const reopened = await connect();
    const job = await reopened.claimLeadExtraction();
    assert.equal(job.message_id, input.whatsapp_message_id);
    assert.equal(job.whatsapp_message_id, input.whatsapp_message_id);
    assert.equal(job.message_text, input.message_text);
    assert.equal(job.sender_phone, input.sender_phone);
    assert.equal(job.message_type, 'text');
    assert.equal(job.authenticated, true);
    assert.equal(job.processing_flow, 'conversation');
    assert.equal(job.processing_status, 'PROCESSING');
    assert.equal(await finish(reopened, job), true);
    const saved = await reopened.getLeadExtraction(job.message_id);
    assert.equal(saved.processing_status, 'SUCCESS');
    assert.deepEqual(saved.result, extracted);
    assert.equal(saved.lease_token, null);
    assert.equal(saved.lease_expires_at, null);
    assert.equal(saved.next_attempt_at, null);
    assert.ok(saved.processed_at);
    assert.deepEqual(await reopened.getMessage(job.message_id), original);
    assert.equal(await reopened.getReply(job.message_id), null);
    assert.equal(await reopened.claimLeadExtraction(), null);
  });

  dbTest('requires trusted boolean opt-in on newly inserted authenticated nonblank conversation text', async ({ store }) => {
    const excluded = [
      message('unsigned', { authenticated: false }), message('truthy-auth', { authenticated: 'true' }),
      message('media', { message_type: 'image' }), message('blank', { message_text: ' \n\t ' }),
      message('empty', { message_text: '' }), message('no-opt-in', { request_lead_extraction: false }),
      message('missing-opt-in', { request_lead_extraction: undefined }), message('truthy-opt-in', { request_lead_extraction: 'true' }),
    ];
    await store.enqueueMany(excluded, FLOW);
    await store.enqueueMany([message('disabled')]);
    await store.enqueueMany([message('fixed')], { replyText: 'Fixed reply' });
    const inputs = [...excluded, message('disabled'), message('fixed')];
    const snapshots = await Promise.all(inputs.map(input => store.getMessage(input.whatsapp_message_id)));
    const fixedReply = await store.getReply('fixed');
    await store.enqueueMany(inputs.map(input => message(input.whatsapp_message_id)), FLOW);
    for (const input of inputs) assert.equal(await store.getLeadExtraction(input.whatsapp_message_id), null);
    assert.deepEqual(await Promise.all(inputs.map(input => store.getMessage(input.whatsapp_message_id))), snapshots);
    assert.deepEqual(await store.getReply('fixed'), fixedReply);
    assert.equal(await store.claimLeadExtraction(), null);
  });

  dbTest('concurrent intake creates one job and later redelivery cannot change its state or result', async ({ store, connect }) => {
    const other = await connect();
    const input = message('duplicate');
    const results = await Promise.all([store.enqueueMany([input], FLOW), other.enqueueMany([input], FLOW)]);
    assert.equal(results.reduce((sum, result) => sum + result.inserted, 0), 1);
    assert.equal((await store.driver.query('SELECT message_id FROM lead_extractions')).rowCount, 1);
    const job = await store.claimLeadExtraction();
    assert.equal(await finish(store, job), true);
    const before = await store.getLeadExtraction(job.message_id);
    await other.enqueueMany([message(input.whatsapp_message_id, { message_text: 'Changed duplicate', request_lead_extraction: false })], FLOW);
    assert.deepEqual(await other.getLeadExtraction(job.message_id), before);
    assert.equal((await other.getMessage(job.message_id)).message_text, input.message_text);
    assert.equal(await other.claimLeadExtraction(), null);
  });

  dbTest('extraction and conversation can finish in either order without sharing status or replies', async ({ store }) => {
    for (const extractFirst of [true, false]) {
      const id = extractFirst ? 'extract-first' : 'conversation-first';
      await store.enqueueMany([message(id)], FLOW);
      const conversation = await store.claimNext(FLOW);
      const extraction = await store.claimLeadExtraction();
      assert.notEqual(conversation.lease_token, extraction.lease_token);
      if (extractFirst) {
        assert.equal(await finish(store, extraction, { processing_status: 'IRRELEVANT', result: null }), true);
        assert.deepEqual(await store.getMessage(id), conversation);
        assert.equal(await store.getReply(id), null);
      }
      assert.equal(await store.completeWithReply(id, conversation.lease_token,
        { processing_status: 'SUCCESS' }, 'Conversation answer'), true);
      const inboxBefore = await store.getMessage(id);
      const replyBefore = await store.getReply(id);
      if (!extractFirst) assert.equal(await finish(store, extraction), true);
      assert.deepEqual(await store.getMessage(id), inboxBefore);
      assert.deepEqual(await store.getReply(id), replyBefore);
      assert.equal((await store.getLeadExtraction(id)).processing_status, extractFirst ? 'IRRELEVANT' : 'SUCCESS');
    }
  });

  dbTest('claims once across connections and fences expired owners during bounded crash recovery', async ({ store, connect }) => {
    const other = await connect();
    await store.enqueueMany([message('lease')], FLOW);
    const original = await store.getMessage('lease');
    const claims = await Promise.all([store.claimLeadExtraction({ maxAttempts: 2 }), other.claimLeadExtraction({ maxAttempts: 2 })]);
    assert.equal(claims.filter(Boolean).length, 1);
    const first = claims.find(Boolean);
    assert.equal(first.attempts, 1);
    assert.equal(await store.heartbeatLeadExtraction(first.message_id, first.lease_token, 180000), true);
    assert.equal(await store.heartbeatLeadExtraction(first.message_id, 'different-owner'), false);
    await store.driver.query('UPDATE lead_extractions SET lease_expires_at=? WHERE message_id=?', [ago(1000), first.message_id]);
    assert.equal(await finish(store, first), false);
    assert.equal(await store.heartbeatLeadExtraction(first.message_id, first.lease_token), false);
    const second = await other.claimLeadExtraction({ maxAttempts: 2 });
    assert.equal(second.attempts, 2);
    assert.notEqual(second.lease_token, first.lease_token);
    assert.equal(await finish(store, first), false);
    await store.driver.query('UPDATE lead_extractions SET lease_expires_at=? WHERE message_id=?', [ago(1000), second.message_id]);
    assert.equal(await store.claimLeadExtraction({ maxAttempts: 2 }), null);
    const terminal = await store.getLeadExtraction(first.message_id);
    assert.equal(terminal.processing_status, 'FAILED');
    assert.equal(terminal.error_message, 'PROCESSING_ATTEMPTS_EXHAUSTED');
    assert.equal(terminal.next_attempt_at, null);
    assert.equal(terminal.lease_token, null);
    assert.ok(terminal.processed_at);
    assert.equal(await finish(other, second), false);
    assert.deepEqual(await store.getMessage('lease'), original);
    assert.equal(await store.getReply('lease'), null);
  });

  dbTest('only due scheduled failures retry, with the attempt cap clearing further retries', async ({ store }) => {
    await store.enqueueMany([message('retry')], FLOW);
    const first = await store.claimLeadExtraction({ maxAttempts: 2 });
    assert.equal(await finish(store, first, { processing_status: 'FAILED', result: null,
      error_message: 'OPENAI_RATE_LIMITED', next_attempt_at: new Date(Date.now() + 60000).toISOString() }), true);
    assert.equal(await store.claimLeadExtraction({ maxAttempts: 2 }), null);
    await store.driver.query('UPDATE lead_extractions SET next_attempt_at=? WHERE message_id=?', [ago(1000), first.message_id]);
    const second = await store.claimLeadExtraction({ maxAttempts: 2 });
    assert.equal(second.attempts, 2);
    assert.equal(await finish(store, second, { processing_status: 'FAILED', result: null,
      error_message: 'OPENAI_RATE_LIMITED', next_attempt_at: new Date(Date.now() + 60000).toISOString() }), true);
    assert.equal(await store.claimLeadExtraction({ maxAttempts: 2 }), null);
    const terminal = await store.getLeadExtraction(first.message_id);
    assert.equal(terminal.processing_status, 'FAILED');
    assert.equal(terminal.next_attempt_at, null);
    assert.equal(terminal.attempts, 2);
    assert.equal(terminal.error_message, 'OPENAI_RATE_LIMITED');
    await store.enqueueMany([message('nonretryable')], FLOW);
    const nonretryable = await store.claimLeadExtraction();
    assert.equal(await finish(store, nonretryable, { processing_status: 'FAILED', result: null, error_message: 'INVALID_OUTPUT' }), true);
    assert.equal(await store.claimLeadExtraction(), null);
  });

  dbTest('internal extraction remains eligible after the WhatsApp reply window expires', async ({ store }) => {
    await store.enqueueMany([message('old', { received_at: ago(48 * 60 * 60 * 1000) })], FLOW);
    assert.equal(await store.claimNext(FLOW), null);
    assert.equal((await store.getMessage('old')).error_message, 'CUSTOMER_SERVICE_WINDOW_EXPIRED');
    const job = await store.claimLeadExtraction();
    assert.equal(job.message_id, 'old');
    assert.equal(await finish(store, job), true);
    assert.equal((await store.getMessage('old')).processing_status, 'FAILED');
    assert.equal(await store.getReply('old'), null);
  });

  dbTest('rechecks authenticated text and conversation scope when claiming stored jobs', async ({ store }) => {
    await store.enqueueMany([message('invalid-auth'), message('invalid-type'), message('invalid-flow')], FLOW);
    await store.driver.query("UPDATE whatsapp_messages SET authenticated=FALSE WHERE whatsapp_message_id='invalid-auth'");
    await store.driver.query("UPDATE whatsapp_messages SET message_type='image' WHERE whatsapp_message_id='invalid-type'");
    await store.driver.query("UPDATE whatsapp_messages SET processing_flow=NULL WHERE whatsapp_message_id='invalid-flow'");
    assert.equal(await store.claimLeadExtraction(), null);
    for (const id of ['invalid-auth', 'invalid-type', 'invalid-flow']) assert.equal((await store.getLeadExtraction(id)).attempts, 0);
  });

  dbTest('validates bounded result and patch fields without losing the current lease', async ({ store }) => {
    await store.enqueueMany([message('validation')], FLOW);
    const job = await store.claimLeadExtraction();
    const before = await store.getLeadExtraction(job.message_id);
    const invalidPatches = [null, [], {}, { processing_status: 'RECEIVED' }, { processing_status: 'PROCESSING' },
      { processing_status: 'SUCCESS', unexpected: true }, { processing_status: 'SUCCESS', result: [] },
      { processing_status: 'SUCCESS', result: 'raw text' }, { processing_status: 'SUCCESS', result: new Date() },
      { processing_status: 'SUCCESS', result: { notes: 'x'.repeat(24001) } },
      { processing_status: 'SUCCESS', result: { notes: '界'.repeat(8000) } },
      { processing_status: 'SUCCESS', error_message: 'private free-form error' },
      { processing_status: 'SUCCESS', error_message: 'X'.repeat(101) },
      { processing_status: 'SUCCESS', next_attempt_at: new Date().toISOString() },
      { processing_status: 'FAILED', next_attempt_at: 'invalid' },
      { processing_status: 'SUCCESS', processed_at: 'invalid' }];
    for (const patch of invalidPatches) await assert.rejects(store.finishLeadExtraction(job.message_id, job.lease_token, patch));
    assert.deepEqual(await store.getLeadExtraction(job.message_id), before);
    assert.equal(await finish(store, { ...job, lease_token: 'wrong-owner' }), false);
    assert.deepEqual(await store.getLeadExtraction(job.message_id), before);
    const exactBoundary = { notes: 'x'.repeat(23988) };
    assert.equal(Buffer.byteLength(JSON.stringify(exactBoundary)), 24000);
    assert.equal(await finish(store, job, { result: exactBoundary }), true);
    assert.deepEqual((await store.getLeadExtraction(job.message_id)).result, exactBoundary);
    assert.equal(await finish(store, job), false);
    assert.equal(await store.heartbeatLeadExtraction(job.message_id, job.lease_token), false);
  });

  dbTest('validates claim and heartbeat bounds and enforces one job per existing inbox', async ({ store }) => {
    for (const leaseMs of [0, -1, 3600001, 1.5, '1000']) {
      await assert.rejects(store.claimLeadExtraction({ leaseMs }), /Invalid leaseMs/);
      await assert.rejects(store.heartbeatLeadExtraction('synthetic-id', 'synthetic-token', leaseMs), /Invalid leaseMs/);
    }
    for (const maxAttempts of [0, -1, 101, 1.5, '3']) await assert.rejects(store.claimLeadExtraction({ maxAttempts }), /Invalid maxAttempts/);
    await assert.rejects(async () => store.driver.query('INSERT INTO lead_extractions(message_id,created_at) VALUES (?,?)', ['missing-inbox', new Date().toISOString()]));
    await store.enqueueMany([message('unique')], FLOW);
    await assert.rejects(async () => store.driver.query('INSERT INTO lead_extractions(message_id,created_at) VALUES (?,?)', ['unique', new Date().toISOString()]));
    assert.equal((await store.driver.query('SELECT message_id FROM lead_extractions')).rowCount, 1);
  });
}

databaseContract('sqlite');
databaseContract('postgres');

test('sqlite: extraction intake failure rolls back the whole receipt batch and every queued job', async t => {
  const { store } = await fixture(t, 'sqlite');
  store.driver.db.exec("CREATE TRIGGER fail_extraction_intake BEFORE INSERT ON lead_extractions WHEN NEW.message_id='fail-intake' BEGIN SELECT RAISE(ABORT,'synthetic extraction intake failure'); END");
  await assert.rejects(store.enqueueMany([message('first-intake'), message('fail-intake')], FLOW), /synthetic extraction intake failure/);
  for (const id of ['first-intake', 'fail-intake']) {
    assert.equal(await store.getMessage(id), null);
    assert.equal(await store.getLeadExtraction(id), null);
    assert.equal(await store.getReply(id), null);
  }
});

test('sqlite: extraction completion failure rolls back result and lease changes without touching original work', async t => {
  const { store } = await fixture(t, 'sqlite');
  await store.enqueueMany([message('finish-rollback')], FLOW);
  const original = await store.getMessage('finish-rollback');
  const job = await store.claimLeadExtraction();
  const before = await store.getLeadExtraction(job.message_id);
  store.driver.db.exec("CREATE TRIGGER fail_extraction_finish AFTER UPDATE ON lead_extractions WHEN NEW.processing_status='SUCCESS' BEGIN SELECT RAISE(ABORT,'synthetic extraction finish failure'); END");
  await assert.rejects(finish(store, job), /synthetic extraction finish failure/);
  assert.deepEqual(await store.getLeadExtraction(job.message_id), before);
  assert.deepEqual(await store.getMessage(job.message_id), original);
  assert.equal(await store.getReply(job.message_id), null);
});
