'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createMessageStore } = require('../src/database');

const message = (id = randomUUID(), overrides = {}) => ({
  whatsapp_message_id: id,
  sender_phone: '971500000001',
  message_text: 'Ahmed, +971501234567, AC maintenance in Dubai.',
  message_type: 'text',
  authenticated: true,
  received_at: new Date().toISOString(),
  ...overrides
});

async function fixture(t, dialect) {
  const stores = [];
  let databaseUrl;
  let cleanup;
  if (dialect === 'postgres') {
    const { Pool } = require('pg');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_messages_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connectionUrl = new URL(process.env.TEST_DATABASE_URL);
    connectionUrl.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = connectionUrl.toString();
    cleanup = async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    };
  } else {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-db-'));
    databaseUrl = `file:${path.join(directory, 'messages.sqlite')}`;
    cleanup = async () => {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('whatsapp-db-'));
      await fs.rm(directory, { recursive: true, force: true });
    };
  }
  t.after(async () => {
    for (const store of stores.reverse()) await store.close();
    await cleanup();
  });
  async function connect() {
    const store = createMessageStore({ databaseUrl });
    await store.init();
    stores.push(store);
    return store;
  }
  return { store: await connect(), connect, databaseUrl };
}

function databaseContract(dialect) {
  const options = { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL };
  const dbTest = (name, fn) => test(`${dialect}: ${name}`, options, async t => fn(await fixture(t, dialect), t));

  dbTest('persists messages across restart and deduplicates an entire batch', async ({ store, connect }) => {
    const input = message('persistent-message');
    assert.deepEqual(await store.enqueueMany([input, input]), { inserted: 1, duplicates: 1 });
    await store.close();
    const reopened = await connect();
    assert.equal(await reopened.ping(), true);
    assert.equal((await reopened.getMessage(input.whatsapp_message_id)).message_text, input.message_text);
    assert.equal((await reopened.getMessage(input.whatsapp_message_id)).authenticated, true);
    assert.deepEqual(await reopened.enqueueMany([input]), { inserted: 0, duplicates: 1 });
  });

  dbTest('rejects an invalid batch without partially saving earlier messages', async ({ store }) => {
    await assert.rejects(store.enqueueMany([message('valid'), message('invalid', { sender_phone: '' })]), /Invalid sender_phone/);
    assert.equal(await store.getMessage('valid'), null);
    assert.deepEqual(await store.enqueueMany([]), { inserted: 0, duplicates: 0 });
  });

  dbTest('returns only new committed IDs when receipt logging requests them', async ({ store, connect }) => {
    const first = message('receipt-first');
    const second = message('receipt-second');
    assert.deepEqual(await store.enqueueMany([first, first, second], { includeInsertedIds: true }), {
      inserted: 2, duplicates: 1, insertedIds: ['receipt-first', 'receipt-second'],
    });
    const other = await connect();
    assert.deepEqual(await other.enqueueMany([first, second], { includeInsertedIds: true }), {
      inserted: 0, duplicates: 2, insertedIds: [],
    });
  });

  dbTest('fixed replies commit once with new authenticated text receipts and bypass lead processing', async ({ store, connect }) => {
    const input = message('fixed-reply');
    const replyText = 'Thank you. We received your message.';
    assert.deepEqual(await store.enqueueMany([input, input], { replyText, includeInsertedIds: true }), {
      inserted: 1, duplicates: 1, insertedIds: [input.whatsapp_message_id],
    });
    const other = await connect();
    const row = await other.getMessage(input.whatsapp_message_id);
    assert.equal(row.processing_status, 'SUCCESS');
    assert.equal(row.processed_at, row.created_at);
    assert.equal(row.attempts, 0);
    assert.equal(row.extracted_lead_data, null);
    assert.equal(row.zoho_lead_id, null);
    assert.equal(await other.claimNext(), null);
    const reply = await other.getReply(input.whatsapp_message_id);
    assert.equal(reply.status, 'PENDING');
    assert.equal(reply.text, replyText);
    assert.equal(reply.created_at, row.created_at);
    assert.deepEqual(await other.enqueueMany([input], { replyText: 'Different fixed reply.' }), { inserted: 0, duplicates: 1 });
    assert.deepEqual(await other.getReply(input.whatsapp_message_id), reply);
  });

  dbTest('concurrent fixed-reply intake across connections stores one receipt and one reply', async ({ store, connect }) => {
    const other = await connect();
    const input = message('concurrent-fixed-reply');
    const options = { replyText: 'Thank you. We received your message.' };
    const outcomes = await Promise.all([store.enqueueMany([input], options), other.enqueueMany([input], options)]);
    assert.equal(outcomes.reduce((sum, outcome) => sum + outcome.inserted, 0), 1);
    assert.equal(outcomes.reduce((sum, outcome) => sum + outcome.duplicates, 0), 1);
    assert.equal((await store.driver.query('SELECT id FROM reply_outbox WHERE message_id=?', [input.whatsapp_message_id])).rowCount, 1);
    assert.equal((await other.getMessage(input.whatsapp_message_id)).processing_status, 'SUCCESS');
  });

  dbTest('previously stored receive-only messages never gain a fixed reply from duplicate delivery', async ({ store }) => {
    const input = message('previously-disabled');
    await store.enqueueMany([input]);
    const before = await store.getMessage(input.whatsapp_message_id);
    assert.deepEqual(await store.enqueueMany([input], { replyText: 'New fixed reply.' }), { inserted: 0, duplicates: 1 });
    assert.deepEqual(await store.getMessage(input.whatsapp_message_id), before);
    assert.equal(before.processing_status, 'RECEIVED');
    assert.equal(await store.getReply(input.whatsapp_message_id), null);
  });

  dbTest('fixed replies exclude unauthenticated, non-text, and blank messages', async ({ store }) => {
    const inputs = [
      message('unsigned-fixed', { authenticated: false }),
      message('truthy-auth-fixed', { authenticated: 'true' }),
      message('image-fixed', { message_type: 'image' }),
      message('blank-fixed', { message_text: ' \n\t ' }),
      message('empty-fixed', { message_text: '' }),
    ];
    assert.deepEqual(await store.enqueueMany(inputs, { replyText: 'Fixed reply.' }), { inserted: inputs.length, duplicates: 0 });
    for (const input of inputs) {
      const row = await store.getMessage(input.whatsapp_message_id);
      assert.equal(row.processing_status, 'RECEIVED');
      assert.equal(row.processed_at, null);
      assert.equal(await store.getReply(input.whatsapp_message_id), null);
    }
  });

  dbTest('fixed reply insertion failure rolls back the entire intake batch and its replies', async ({ store }) => {
    if (dialect === 'postgres') {
      await store.driver.query(`CREATE FUNCTION fail_fixed_reply() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.message_id='fixed-reply-fail' THEN RAISE EXCEPTION 'simulated fixed reply failure'; END IF;
          RETURN NEW;
        END;
        $$`);
      await store.driver.query('CREATE TRIGGER fail_fixed_reply BEFORE INSERT ON reply_outbox FOR EACH ROW EXECUTE FUNCTION fail_fixed_reply()');
    } else {
      await store.driver.query("CREATE TRIGGER fail_fixed_reply BEFORE INSERT ON reply_outbox WHEN NEW.message_id='fixed-reply-fail' BEGIN SELECT RAISE(ABORT,'simulated fixed reply failure'); END");
    }
    const inputs = [message('fixed-reply-good'), message('fixed-reply-fail')];
    await assert.rejects(store.enqueueMany(inputs, { replyText: 'Fixed reply.' }), /simulated fixed reply failure/);
    for (const input of inputs) {
      assert.equal(await store.getMessage(input.whatsapp_message_id), null);
      assert.equal(await store.getReply(input.whatsapp_message_id), null);
    }
  });

  dbTest('scoped reply claims leave other reply text pending and return sender eligibility metadata', async ({ store }) => {
    await store.enqueueMany([message('legacy-reply', { authenticated: false, message_type: 'image' })]);
    const legacy = await store.claimNext();
    await store.completeWithReply(legacy.whatsapp_message_id, legacy.lease_token, { processing_status: 'SUCCESS' }, 'Legacy CRM confirmation.');
    const replyText = 'Thank you. We received your message.';
    await store.enqueueMany([message('scoped-fixed-reply')], { replyText });
    const reply = await store.claimReply({ replyText });
    assert.equal(reply.message_id, 'scoped-fixed-reply');
    assert.equal(reply.text, replyText);
    assert.equal(reply.authenticated, true);
    assert.equal(reply.message_type, 'text');
    assert.equal(reply.sender_phone, message().sender_phone);
    assert.equal((await store.getReply('legacy-reply')).status, 'PENDING');
    assert.equal(await store.claimReply({ replyText }), null);
    const legacyReply = await store.claimReply();
    assert.equal(legacyReply.message_id, 'legacy-reply');
    assert.equal(legacyReply.authenticated, false);
    assert.equal(legacyReply.message_type, 'image');
  });

  dbTest('unsigned messages remain explicitly unauthenticated on disk', async ({ store, connect }) => {
    await store.enqueueMany([message('unsigned', { authenticated: undefined })]);
    const other = await connect();
    assert.equal((await other.getMessage('unsigned')).authenticated, false);
  });

  dbTest('claims are unique across independent database connections', async ({ store, connect }) => {
    await store.enqueueMany([message('a'), message('b')]);
    const other = await connect();
    const claims = await Promise.all([store.claimNext(), other.claimNext()]);
    assert.equal(new Set(claims.map(row => row.whatsapp_message_id)).size, 2);
    assert.ok(claims.every(row => row.processing_status === 'PROCESSING' && row.attempts === 1));
    assert.equal(await store.claimNext(), null);
    assert.equal(await other.claimNext(), null);
  });

  dbTest('lease recovery fences an old worker and retains CRM ambiguity', async ({ store, connect }) => {
    await store.enqueueMany([message('recover')]);
    const first = await store.claimNext();
    assert.equal(await store.mark('recover', first.lease_token, { crm_write_started: true, extracted_lead_data: { name: 'Ahmed' } }), true);
    await store.driver.query('UPDATE whatsapp_messages SET lease_expires_at=? WHERE whatsapp_message_id=?', ['2000-01-01T00:00:00.000Z', 'recover']);
    assert.equal(await store.heartbeat('recover', first.lease_token, 5000), false);
    const other = await connect();
    const recovered = await other.claimNext();
    assert.equal(recovered.attempts, 2);
    assert.equal(recovered.crm_write_started, true);
    assert.deepEqual(recovered.extracted_lead_data, { name: 'Ahmed' });
    assert.notEqual(recovered.lease_token, first.lease_token);
    assert.equal(await store.mark('recover', first.lease_token, { processing_status: 'SUCCESS' }), false);
    assert.equal(await other.heartbeat('recover', recovered.lease_token, 5000), true);
  });

  dbTest('exhausted stale work becomes terminal instead of looping forever', async ({ store }) => {
    await store.enqueueMany([message('exhausted')]);
    await store.claimNext({ maxAttempts: 1 });
    await store.driver.query('UPDATE whatsapp_messages SET lease_expires_at=? WHERE whatsapp_message_id=?', ['2000-01-01T00:00:00.000Z', 'exhausted']);
    assert.equal(await store.claimNext({ maxAttempts: 1 }), null);
    const row = await store.getMessage('exhausted');
    assert.equal(row.processing_status, 'FAILED');
    assert.equal(row.next_attempt_at, null);
    assert.equal(row.error_message, 'PROCESSING_ATTEMPTS_EXHAUSTED');
  });

  dbTest('only scheduled FAILED work retries, and no earlier than its due time', async ({ store }) => {
    await store.enqueueMany([message('retry')]);
    const row = await store.claimNext();
    await store.mark('retry', row.lease_token, { processing_status: 'FAILED', next_attempt_at: new Date(Date.now() + 60000).toISOString() });
    assert.equal(await store.claimNext(), null);
    await store.enqueueMany([message('terminal')]);
    const terminal = await store.claimNext();
    await store.mark('terminal', terminal.lease_token, { processing_status: 'FAILED', next_attempt_at: null });
    assert.equal(await store.claimNext(), null);
  });

  dbTest('known CRM results can finalize after crash or due retry beyond the attempt limit', async ({ store }) => {
    await store.enqueueMany([message('known-crm')]);
    const row = await store.claimNext({ maxAttempts: 1 });
    await store.saveCrmResult('known-crm', row.lease_token, { zohoId: '123456', action: 'created', contactKey: 'phone:+971501234567' });
    await store.driver.query('UPDATE whatsapp_messages SET lease_expires_at=? WHERE whatsapp_message_id=?', ['2000-01-01T00:00:00.000Z', 'known-crm']);
    const recovered = await store.claimNext({ maxAttempts: 1 });
    assert.equal(recovered.attempts, 2);
    assert.equal(recovered.zoho_lead_id, '123456');
    await store.mark('known-crm', recovered.lease_token, { processing_status: 'FAILED', next_attempt_at: '2000-01-01T00:00:00.000Z' });
    const retry = await store.claimNext({ maxAttempts: 1 });
    assert.equal(retry.attempts, 3);
    assert.equal(retry.zoho_lead_id, '123456');
    await store.completeWithReply('known-crm', retry.lease_token, { processing_status: 'SUCCESS' }, 'Lead saved.');
    assert.equal(await store.claimNext({ maxAttempts: 1 }), null);
  });

  dbTest('message patches reject unknown fields and preserve ownership', async ({ store }) => {
    await store.enqueueMany([message('patch')]);
    const row = await store.claimNext();
    await assert.rejects(store.mark('patch', row.lease_token, { attempts: 0 }), /Unsupported/);
    await assert.rejects(store.mark('patch', row.lease_token, { processing_status: 'RECEIVED' }), /Invalid processing_status/);
    assert.equal(await store.mark('patch', 'wrong-token', { processing_status: 'SUCCESS' }), false);
    assert.equal((await store.getMessage('patch')).processing_status, 'PROCESSING');
  });

  dbTest('terminal message and reply persist atomically; duplicate replies never queue', async ({ store, connect }) => {
    await store.enqueueMany([message('complete')]);
    const row = await store.claimNext();
    assert.equal(await store.completeWithReply('complete', row.lease_token, { processing_status: 'SUCCESS', processed_at: new Date().toISOString() }, 'Lead saved.'), true);
    assert.equal(await store.queueReply('complete', 'Lead saved again.'), false);
    assert.equal(await store.completeWithReply('complete', row.lease_token, { processing_status: 'SUCCESS' }, 'Duplicate.'), false);
    await store.close();
    const reopened = await connect();
    assert.equal((await reopened.getMessage('complete')).processing_status, 'SUCCESS');
    assert.equal(await reopened.claimNext(), null);
    const reply = await reopened.claimReply();
    assert.equal(reply.text, 'Lead saved.');
    assert.equal(reply.sender_phone, '971500000001');
    assert.equal(reply.message_id, 'complete');
    assert.equal(await reopened.finishReply(reply.id, reply.lease_token, { status: 'SENT', provider_message_id: 'wamid.reply' }), true);
    assert.equal(await reopened.claimReply(), null);
    assert.equal((await reopened.getReply('complete')).status, 'SENT');
  });

  dbTest('a crash during sending is UNKNOWN and is never automatically resent', async ({ store, connect }) => {
    await store.enqueueMany([message('send-crash')]);
    const row = await store.claimNext();
    await store.completeWithReply('send-crash', row.lease_token, { processing_status: 'SUCCESS' }, 'Lead saved.');
    const reply = await store.claimReply();
    await store.driver.query('UPDATE reply_outbox SET lease_expires_at=? WHERE message_id=?', ['2000-01-01T00:00:00.000Z', 'send-crash']);
    const reopened = await connect();
    assert.equal(await reopened.claimReply(), null);
    assert.equal((await reopened.getReply('send-crash')).status, 'UNKNOWN');
    assert.equal(await store.finishReply(reply.id, reply.lease_token, { status: 'SENT' }), false);
    assert.equal((await reopened.getMessage('send-crash')).processing_status, 'SUCCESS');
  });

  dbTest('late acceptance evidence survives an expired sending lease and a separate sweeper', async ({ store, connect }) => {
    await store.enqueueMany([message('late-acceptance')]);
    const job = await store.claimNext();
    await store.completeWithReply(job.whatsapp_message_id, job.lease_token, { processing_status: 'SUCCESS' }, 'Saved.');
    const reply = await store.claimReply();
    await store.driver.query('UPDATE reply_outbox SET lease_expires_at=? WHERE id=?', ['2000-01-01T00:00:00.000Z', reply.id]);
    const other = await connect();
    assert.equal(await other.claimReply(), null);
    assert.equal((await other.getReply(job.whatsapp_message_id)).lease_token, reply.lease_token);
    assert.equal(await store.recordReplyReconciliation(reply.id, reply.lease_token, 'wamid.accepted'), 'UNKNOWN');
    assert.equal(await store.recordReplyReconciliation(reply.id, reply.lease_token, 'wamid.accepted'), 'UNKNOWN');
    const persisted = await other.getReply(job.whatsapp_message_id);
    assert.equal(persisted.status, 'UNKNOWN');
    assert.equal(persisted.provider_message_id, 'wamid.accepted');
    assert.equal(persisted.sent_at, null);
    assert.equal(persisted.error_message, 'PROVIDER_ACCEPTED_RECONCILIATION_REQUIRED');
    assert.equal(await other.claimReply(), null);
  });

  dbTest('reply reconciliation refuses other attempts, conflicting receipts and protected states', async ({ store }) => {
    await store.enqueueMany([message('protected-reply')]);
    const job = await store.claimNext();
    await store.completeWithReply(job.whatsapp_message_id, job.lease_token, { processing_status: 'SUCCESS' }, 'Saved.');
    const pending = await store.getReply(job.whatsapp_message_id);
    assert.equal(await store.recordReplyReconciliation(pending.id, 'wrong-token', 'wamid.accepted'), null);
    const reply = await store.claimReply();
    assert.equal(await store.recordReplyReconciliation(reply.id, 'wrong-token', 'wamid.accepted'), null);
    assert.equal((await store.getReply(job.whatsapp_message_id)).status, 'SENDING');
    assert.equal(await store.recordReplyReconciliation(reply.id, reply.lease_token, 'wamid.accepted'), 'UNKNOWN');
    assert.equal(await store.recordReplyReconciliation(reply.id, reply.lease_token, 'wamid.conflicting'), null);
    assert.equal((await store.getReply(job.whatsapp_message_id)).provider_message_id, 'wamid.accepted');
    await store.driver.query("UPDATE reply_outbox SET status='FAILED' WHERE id=?", [reply.id]);
    assert.equal(await store.recordReplyReconciliation(reply.id, reply.lease_token, 'wamid.accepted'), null);
    await store.driver.query("UPDATE reply_outbox SET status='UNKNOWN',lease_token=NULL WHERE id=?", [reply.id]);
    assert.equal(await store.recordReplyReconciliation(reply.id, reply.lease_token, 'wamid.accepted'), null);
  });

  dbTest('reply reconciliation recognizes a committed success without downgrading or overwriting it', async ({ store }) => {
    await store.enqueueMany([message('committed-reply')]);
    const job = await store.claimNext();
    await store.completeWithReply(job.whatsapp_message_id, job.lease_token, { processing_status: 'SUCCESS' }, 'Saved.');
    const reply = await store.claimReply();
    assert.equal(await store.finishReply(reply.id, reply.lease_token, { status: 'SENT', provider_message_id: 'wamid.committed' }), true);
    const before = await store.getReply(job.whatsapp_message_id);
    assert.equal(await store.recordReplyReconciliation(reply.id, reply.lease_token, 'wamid.committed'), 'SENT');
    assert.equal(await store.recordReplyReconciliation(reply.id, reply.lease_token, 'wamid.other'), null);
    assert.deepEqual(await store.getReply(job.whatsapp_message_id), before);
    assert.equal(await store.claimReply(), null);
  });

  dbTest('concurrent reconciliation never overwrites conflicting provider evidence', async ({ store, connect }) => {
    await store.enqueueMany([message('concurrent-evidence')]);
    const job = await store.claimNext();
    await store.completeWithReply(job.whatsapp_message_id, job.lease_token, { processing_status: 'SUCCESS' }, 'Saved.');
    const reply = await store.claimReply();
    const other = await connect();
    const results = await Promise.all([
      store.recordReplyReconciliation(reply.id, reply.lease_token, 'wamid.first'),
      other.recordReplyReconciliation(reply.id, reply.lease_token, 'wamid.second'),
    ]);
    assert.equal(results.filter(result => result === 'UNKNOWN').length, 1);
    assert.equal(results.filter(result => result === null).length, 1);
    assert.equal((await store.getReply(job.whatsapp_message_id)).provider_message_id, results[0] === 'UNKNOWN' ? 'wamid.first' : 'wamid.second');
    assert.equal(await store.claimReply(), null);
  });

  dbTest('expired customer service windows do not send queued freeform replies', async ({ store }) => {
    await store.enqueueMany([message('expired', { received_at: new Date(Date.now() - 24 * 3600000).toISOString() })]);
    const row = await store.claimNext();
    await store.completeWithReply('expired', row.lease_token, { processing_status: 'NEEDS_INFORMATION' }, 'Please send a phone number.');
    assert.equal(await store.claimReply(), null);
    const reply = await store.getReply('expired');
    assert.equal(reply.status, 'FAILED');
    assert.equal(reply.error_message, 'CUSTOMER_SERVICE_WINDOW_EXPIRED');
  });

  dbTest('contact ambiguity and CRM result survive restarts across phone and email keys', async ({ store, connect }) => {
    await store.enqueueMany([message('crm')]);
    const row = await store.claimNext();
    const phone = 'phone:+971501234567';
    const email = 'email:ahmed@example.com';
    await store.beginContactWrite(phone);
    await store.beginContactWrite(email);
    await store.mark('crm', row.lease_token, { crm_write_started: true });
    const other = await connect();
    assert.deepEqual(await other.getContactState(phone), { zoho_lead_id: null, uncertain: true });
    assert.equal(await other.saveCrmResult('crm', 'wrong-token', { zohoId: 'zoho-1', action: 'created', contactKeys: [phone, email] }), false);
    assert.equal((await other.getContactState(phone)).uncertain, true);
    assert.equal(await store.saveCrmResult('crm', row.lease_token, { zohoId: 'zoho-1', action: 'created', contactKeys: [phone, email] }), true);
    assert.deepEqual(await other.getContactState(phone), { zoho_lead_id: 'zoho-1', uncertain: false });
    assert.equal(await other.getContactLead(email), 'zoho-1');
    const saved = await other.getMessage('crm');
    assert.equal(saved.zoho_lead_id, 'zoho-1');
    assert.equal(saved.crm_action, 'created');
    assert.equal(saved.crm_write_started, false);
  });

  dbTest('contact locks serialize same contact across connections and release on failure', async ({ store, connect }) => {
    const other = await connect();
    const sequence = [];
    let unlockStart;
    const started = new Promise(resolve => { unlockStart = resolve; });
    const first = store.withContactLock('phone:+971501234567', async ({ assertOwned }) => {
      sequence.push('first:start');
      unlockStart();
      await delay(100);
      await assertOwned();
      sequence.push('first:end');
    });
    await started;
    const second = other.withContactLock('phone:+971501234567', async () => { sequence.push('second'); });
    await Promise.all([first, second]);
    assert.deepEqual(sequence, ['first:start', 'first:end', 'second']);
    await assert.rejects(store.withContactLock('same', async () => { throw new Error('test-failure'); }), /test-failure/);
    assert.equal(await other.withContactLock('same', async () => 'released'), 'released');
  });

  dbTest('nested locks for distinct sorted contacts allow one atomic CRM operation', async ({ store }) => {
    const result = await store.withContactLock('email:ahmed@example.com', async ({ assertOwned: assertEmail }) =>
      store.withContactLock('phone:+971501234567', async ({ assertOwned: assertPhone }) => {
        await assertEmail();
        await assertPhone();
        return 'both-owned';
      }));
    assert.equal(result, 'both-owned');
  });

  dbTest('processing logs retain only approved operational metadata', async ({ store }) => {
    await store.enqueueMany([message('log')]);
    await store.appendLog('log', 'processing_started', { attempt: 1, provider: 'openai', retry_scheduled: true, reconciliation: false, access_token: 'secret-not-to-store', message_text: 'personal-data' });
    const record = (await store.driver.query('SELECT details FROM processing_logs WHERE message_id=?', ['log'])).rows[0];
    const details = typeof record.details === 'string' ? JSON.parse(record.details) : record.details;
    assert.deepEqual(details, { attempt: 1, provider: 'openai', retry_scheduled: true, reconciliation: false });
  });
}

databaseContract('sqlite');
databaseContract('postgres');

test('database configuration rejects memory and unknown schemes', () => {
  assert.throws(() => createMessageStore({ databaseUrl: 'file::memory:' }), /persistent SQLite/);
  assert.throws(() => createMessageStore({ databaseUrl: 'memory:' }), /DATABASE_URL/);
  assert.throws(() => createMessageStore({ databaseUrl: '' }), /DATABASE_URL/);
});

test('fixed reply options reject invalid text before opening an intake or claim transaction', async t => {
  const { store } = await fixture(t, 'sqlite');
  t.mock.method(store.driver, 'transaction', () => assert.fail('Invalid reply text must fail before a transaction starts.'));
  for (const replyText of ['', ' \n\t ', 'x'.repeat(4097), 'bad\0text', false, 1, {}]) {
    await assert.rejects(store.enqueueMany([message()], { replyText }), /Invalid reply text/);
    await assert.rejects(store.claimReply({ replyText }), /Invalid reply text/);
  }
});

test('SQLite batch rolls back if a database operation fails midway', async t => {
  const { store } = await fixture(t, 'sqlite');
  store.driver.db.exec("CREATE TRIGGER fail_test BEFORE INSERT ON whatsapp_messages WHEN NEW.whatsapp_message_id='fail' BEGIN SELECT RAISE(ABORT,'simulated write failure'); END");
  await assert.rejects(store.enqueueMany([message('must-rollback'), message('fail')]), /simulated write failure/);
  assert.equal(await store.getMessage('must-rollback'), null);
});

test('SQLite terminal transition rolls back when its outbox insert fails', async t => {
  const { store } = await fixture(t, 'sqlite');
  await store.enqueueMany([message('atomic-reply')]);
  const row = await store.claimNext();
  store.driver.db.exec("CREATE TRIGGER fail_reply BEFORE INSERT ON reply_outbox BEGIN SELECT RAISE(ABORT,'simulated outbox failure'); END");
  await assert.rejects(store.completeWithReply('atomic-reply', row.lease_token, { processing_status: 'SUCCESS' }, 'Saved.'), /simulated outbox failure/);
  assert.equal((await store.getMessage('atomic-reply')).processing_status, 'PROCESSING');
  assert.equal(await store.getReply('atomic-reply'), null);
});

test('SQLite CRM result and all contact mappings roll back together on failure', async t => {
  const { store } = await fixture(t, 'sqlite');
  await store.enqueueMany([message('atomic-crm')]);
  const row = await store.claimNext();
  await store.beginContactWrite('phone:test');
  await store.beginContactWrite('email:test');
  store.driver.db.exec("CREATE TRIGGER fail_contact BEFORE INSERT ON crm_contacts WHEN NEW.contact_key='email:test' BEGIN SELECT RAISE(ABORT,'simulated contact failure'); END");
  await assert.rejects(store.saveCrmResult('atomic-crm', row.lease_token, { zohoId: '123', action: 'created', contactKeys: ['phone:test', 'email:test'] }), /simulated contact failure/);
  assert.equal((await store.getMessage('atomic-crm')).zoho_lead_id, null);
  assert.deepEqual(await store.getContactState('phone:test'), { zoho_lead_id: null, uncertain: true });
  assert.deepEqual(await store.getContactState('email:test'), { zoho_lead_id: null, uncertain: true });
});
