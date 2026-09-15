'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMessageStore } = require('../src/database');
const { createMessagesAdmin } = require('../src/services/admin/messagesAdmin');
const { run, jsonOutput } = require('../scripts/messages');
const { temporaryStore } = require('./helpers');

const sender = '+971501234567';
const extracted = { name: 'Ahmed', phone: '+971501234568', email: 'ahmed@example.com' };

async function fixture(t) {
  const { store, databaseUrl } = await temporaryStore(t);
  const admin = createMessagesAdmin({ store, config: { allowedSenders: new Set([sender]) } });
  async function failed(id, { message = {}, lead = extracted, reply = true, status = 'FAILED', crmWrite = false, crmId = null } = {}) {
    await store.enqueueMany([{
      whatsapp_message_id: id, sender_phone: sender, message_text: 'Private lead text', message_type: 'text',
      received_at: new Date().toISOString(), authenticated: true, ...message,
    }]);
    await store.driver.query(
      `UPDATE whatsapp_messages SET processing_status=?,attempts=?,extracted_lead_data=?,
       crm_write_started=?,zoho_lead_id=?,error_message=?,processed_at=?,next_attempt_at=? WHERE whatsapp_message_id=?`,
      [status, 3, JSON.stringify(lead), crmWrite, crmId, 'Provider failed', new Date().toISOString(), new Date().toISOString(), id]
    );
    if (reply && ['FAILED', 'SUCCESS', 'NEEDS_INFORMATION'].includes(status)) await store.queueReply(id, 'Previous failure confirmation');
    return store.getMessage(id);
  }
  return { store, admin, failed, databaseUrl };
}

test('Admin list is bounded and masks sender while show includes row, reply and structured audit', async (t) => {
  const { store, admin, failed } = await fixture(t);
  await failed('show-me');
  await store.appendLog('show-me', 'processing_failed', { code: 'ZOHO_AUTH', attempt: 3 });
  const list = await admin.listMessages(1);
  assert.equal(list.length, 1);
  assert.equal(list[0].sender_phone, '***4567');
  assert.equal(list[0].message_text, undefined);
  assert.equal(list[0].extracted_lead_data, undefined);
  const shown = await admin.showMessage('show-me');
  assert.equal(shown.message.message_text, 'Private lead text');
  assert.deepEqual(shown.message.extracted_lead_data, extracted);
  assert.equal(shown.reply.status, 'PENDING');
  assert.deepEqual(shown.audit[0].details, { code: 'ZOHO_AUTH', attempt: 3 });
  assert.equal(Object.hasOwn(shown.message, 'lease_token'), false);
});

test('Admin rejects invalid list limits and message identifiers without altering the inbox', async (t) => {
  const { admin } = await fixture(t);
  for (const limit of [0, 101, 1.5, '10', null]) await assert.rejects(admin.listMessages(limit), { code: 'ADMIN_INPUT' });
  for (const id of ['', 'line\nbreak', '\u001b[31m', 'a'.repeat(513)]) {
    await assert.rejects(admin.showMessage(id), { code: 'ADMIN_INPUT' });
    await assert.rejects(admin.retryMessage(id), { code: 'ADMIN_INPUT' });
  }
  await assert.rejects(admin.showMessage('missing'), { code: 'ADMIN_NOT_FOUND' });
  await assert.rejects(admin.retryMessage('missing'), { code: 'ADMIN_NOT_FOUND' });
});

test('Admin retry resets only safely failed work and preserves its extraction and original message', async (t) => {
  const { store, admin, failed } = await fixture(t);
  await failed('retry-me');
  const result = await admin.retryMessage('retry-me');
  assert.equal(result.status, 'RECEIVED');
  assert.equal(result.previous_reply_status, 'PENDING');
  const row = await store.getMessage('retry-me');
  assert.equal(row.processing_status, 'RECEIVED');
  assert.equal(row.attempts, 0);
  for (const key of ['next_attempt_at', 'error_message', 'processed_at', 'lease_token', 'lease_expires_at']) assert.equal(row[key], null);
  assert.deepEqual(row.extracted_lead_data, extracted);
  assert.equal(row.message_text, 'Private lead text');
  assert.equal(await store.getReply('retry-me'), null);
  const audit = (await admin.showMessage('retry-me')).audit;
  assert.equal(audit[0].event, 'operator_retry');
  assert.equal(audit[0].details.previous_attempts, 3);
  assert.equal(audit[0].details.previous_reply.status, 'PENDING');
  const claim = await store.claimNext();
  assert.equal(claim.whatsapp_message_id, 'retry-me');
  assert.equal(claim.attempts, 1);
  await store.completeWithReply('retry-me', claim.lease_token, { processing_status: 'SUCCESS' }, 'Fresh success confirmation');
  assert.equal((await store.getReply('retry-me')).text, 'Fresh success confirmation');
});

test('Admin permits a retry with no extracted contact yet and no prior reply', async (t) => {
  const { admin, failed } = await fixture(t);
  await failed('ai-failed', { lead: null, reply: false });
  const result = await admin.retryMessage('ai-failed');
  assert.equal(result.status, 'RECEIVED');
  assert.equal(result.previous_reply_status, null);
});

test('Admin retry refuses boss lead failures without changing the inbox, extraction, stored lead or confirmation', async (t) => {
  for (const [stage, code, replyStatus] of [
    ['extraction', 'AI_AUTHENTICATION_ERROR', 'SENT'],
    ['persistence', 'LEAD_WORKFLOW_PERSISTENCE_FAILED', 'PENDING'],
    ['validation', 'MESSAGE_NOT_AUTHORIZED', null],
  ]) {
    const { store, admin } = await fixture(t);
    const id = 'boss-' + stage;
    await store.enqueueMany([{
      whatsapp_message_id: id, sender_phone: sender, message_text: 'Synthetic company needs AC maintenance.',
      message_type: 'text', authenticated: true, received_at: new Date().toISOString(), request_lead_workflow: true,
    }], { processingFlow: 'conversation' });
    const job = await store.claimLeadExtraction();
    await store.failLeadWorkflow(id, job.lease_token, {
      code, stage, replyText: replyStatus ? 'The lead could not be processed.' : null,
    });
    if (replyStatus === 'SENT') {
      const reply = await store.claimReply({ processingFlow: 'boss_lead' });
      await store.finishReply(reply.id, reply.lease_token, { status: 'SENT', provider_message_id: 'wamid.synthetic-prior-confirmation' });
    }
    const before = { message: await store.getMessage(id), extraction: await store.getLeadExtraction(id),
      reply: await store.getReply(id), leads: await store.listLeads(), shown: await admin.showMessage(id) };
    await assert.rejects(admin.retryMessage(id), error => {
      assert.equal(error.code, 'ADMIN_RETRY_REFUSED');
      assert.match(error.message, /does not support boss lead messages/);
      return true;
    });
    assert.deepEqual({ message: await store.getMessage(id), extraction: await store.getLeadExtraction(id),
      reply: await store.getReply(id), leads: await store.listLeads(), shown: await admin.showMessage(id) }, before);
    assert.equal(await store.claimLeadExtraction(), null);
  }
});

test('Admin retry refuses active, completed, unsigned, unauthorized, and possible or confirmed CRM writes', async (t) => {
  const { store, admin, failed } = await fixture(t);
  const cases = [
    ['active', { status: 'PROCESSING', reply: false }], ['success', { status: 'SUCCESS' }],
    ['needs-info', { status: 'NEEDS_INFORMATION' }], ['already-received', { status: 'RECEIVED', reply: false }],
    ['unsigned', { message: { authenticated: false } }], ['not-authorized', { message: { sender_phone: '+971501234569' } }],
    ['write-started', { crmWrite: true }], ['crm-saved', { crmId: '12345' }],
  ];
  for (const [id, options] of cases) {
    const before = await failed(id, options);
    await assert.rejects(admin.retryMessage(id), { code: 'ADMIN_RETRY_REFUSED' });
    assert.equal((await store.getMessage(id)).processing_status, before.processing_status);
    assert.equal((await admin.showMessage(id)).audit.length, 0);
  }
});

test('Admin retry refuses uncertain phone or email contact state and retains its failure reply', async (t) => {
  for (const uncertainKey of ['phone:+971501234568', 'email:ahmed@example.com']) {
    const { store, admin, failed } = await fixture(t);
    await failed('uncertain');
    await store.beginContactWrite(uncertainKey);
    await assert.rejects(admin.retryMessage('uncertain'), { code: 'ADMIN_RETRY_REFUSED' });
    assert.equal((await store.getReply('uncertain')).status, 'PENDING');
    assert.equal((await store.getMessage('uncertain')).processing_status, 'FAILED');
  }
});

test('Admin retry locks sorted contacts and allows their known CRM mapping without requeueing a CRM-saved message', async (t) => {
  const { store, admin, failed } = await fixture(t);
  await failed('known-contact');
  await store.saveContactLead('phone:+971501234568', '12345');
  const locked = [];
  const original = store.withContactLock.bind(store);
  t.mock.method(store, 'withContactLock', (key, fn) => { locked.push(key); return original(key, fn); });
  await admin.retryMessage('known-contact');
  assert.deepEqual(locked, ['email:ahmed@example.com', 'phone:+971501234568']);
  assert.equal(await store.getContactLead('phone:+971501234568'), '12345');
});

test('Admin retry refuses SENDING and UNKNOWN replies even when CRM work never started', async (t) => {
  const { store, admin, failed } = await fixture(t);
  for (const status of ['SENDING', 'UNKNOWN']) {
    await failed(status);
    await store.driver.query('UPDATE reply_outbox SET status=? WHERE message_id=?', [status, status]);
    await assert.rejects(admin.retryMessage(status), { code: 'ADMIN_RETRY_REFUSED' });
    assert.equal((await store.getReply(status)).status, status);
  }
});

test('Admin retry archives previous SENT or FAILED failure confirmation before removing the outbox slot', async (t) => {
  const { store, admin, failed } = await fixture(t);
  for (const status of ['SENT', 'FAILED']) {
    await failed(status);
    await store.driver.query('UPDATE reply_outbox SET status=?,provider_message_id=?,sent_at=? WHERE message_id=?',
      [status, 'mock-prior-provider-id', '2026-09-01T12:00:00.000Z', status]);
    await admin.retryMessage(status);
    const shown = await admin.showMessage(status);
    assert.equal(shown.reply, null);
    assert.equal(shown.audit[0].details.previous_reply.status, status);
    assert.equal(shown.audit[0].details.previous_reply.provider_message_id, 'mock-prior-provider-id');
    assert.equal(shown.audit[0].details.previous_reply.sent_at, '2026-09-01T12:00:00.000Z');
    const history = await store.listConversationMessages(sender);
    const archived = history.items.find(item => item.direction === 'outgoing' && item.message_id === status);
    assert.equal(archived.text, 'Previous failure confirmation');
    assert.equal(archived.status, status);
    assert.equal(archived.whatsapp_message_id, 'mock-prior-provider-id');
  }
});

test('operator retry retains chronological full reply text, cancels unsent replies, and never dispatches the archive', async t => {
  const { store, admin, failed, databaseUrl } = await fixture(t);
  await failed('retained-reply');
  const original = await store.getReply('retained-reply');
  await admin.retryMessage('retained-reply');
  assert.equal(await store.claimReply(), null);
  const job = await store.claimNext();
  await store.completeWithReply(job.whatsapp_message_id, job.lease_token, { processing_status: 'SUCCESS' }, 'Fresh successful reply');
  const reply = await store.claimReply();
  assert.equal(reply.text, 'Fresh successful reply');
  await store.finishReply(reply.id, reply.lease_token, { status: 'SENT', provider_message_id: 'wamid.fresh-reply' });
  const history = await store.listConversationMessages(sender, { pageSize: 2 });
  const later = await store.listConversationMessages(sender, { pageSize: 2, page: 2 });
  assert.equal(history.total, 3);
  const messages = [...history.items, ...later.items];
  assert.deepEqual(messages.map(item => item.text), ['Private lead text', 'Previous failure confirmation', 'Fresh successful reply']);
  assert.equal(messages[1].id, 'out:' + original.id);
  assert.equal(messages[1].status, 'CANCELLED');
  assert.equal(messages[1].sender_type, 'bot');
  assert.equal(messages[2].whatsapp_message_id, 'wamid.fresh-reply');
  assert.equal((await store.getConversation(sender)).last_message, 'Fresh successful reply');
  assert.equal(await store.claimReply(), null);
  const reopened = createMessageStore({ databaseUrl, databaseName: store.databaseName });
  try {
    await reopened.init();
    assert.equal((await reopened.listConversationMessages(sender)).total, 3);
  } finally { await reopened.close(); }
});

test('Admin retry repeats state and contact checks inside the transaction after acquiring locks', async (t) => {
  for (const change of ['status', 'contact', 'uncertain', 'flow']) {
    const { store, admin, failed } = await fixture(t);
    await failed('racing');
    const original = store.withContactLock.bind(store);
    let changed = false;
    t.mock.method(store, 'withContactLock', (key, fn) => original(key, async (context) => {
      if (!changed) {
        changed = true;
        if (change === 'status') await store.driver.query("UPDATE whatsapp_messages SET processing_status='SUCCESS' WHERE whatsapp_message_id=?", ['racing']);
        else if (change === 'contact') await store.driver.query('UPDATE whatsapp_messages SET extracted_lead_data=? WHERE whatsapp_message_id=?', [JSON.stringify({ ...extracted, phone: '+971501234569' }), 'racing']);
        else if (change === 'flow') await store.driver.query("UPDATE whatsapp_messages SET processing_flow='boss_lead' WHERE whatsapp_message_id=?", ['racing']);
        else await store.beginContactWrite('phone:+971501234568');
      }
      return fn(context);
    }));
    await assert.rejects(admin.retryMessage('racing'), { code: change === 'contact' ? 'ADMIN_STATE_CHANGED' : 'ADMIN_RETRY_REFUSED' });
    assert.equal((await admin.showMessage('racing')).audit.length, 0);
    assert.equal((await store.getReply('racing')).status, 'PENDING');
  }
});

test('Admin retry audit, old reply removal, and requeue roll back atomically if the final update fails', async (t) => {
  const { store, admin, failed } = await fixture(t);
  if (!store?.driver?.db?.exec) return;
  await failed('rollback');
  store.driver.db.exec("CREATE TRIGGER fail_admin_retry BEFORE UPDATE ON whatsapp_messages WHEN NEW.processing_status='RECEIVED' BEGIN SELECT RAISE(ABORT,'simulated update failure'); END");
  await assert.rejects(admin.retryMessage('rollback'), /simulated update failure/);
  assert.equal((await store.getMessage('rollback')).processing_status, 'FAILED');
  assert.equal((await store.getReply('rollback')).status, 'PENDING');
  assert.equal((await admin.showMessage('rollback')).audit.length, 0);
  assert.equal((await store.driver.query('SELECT COUNT(*) AS count FROM reply_history')).rows[0].count, 0);
});

test('Admin CLI uses only the local configured database, JSON-escapes control text, and masks list output', async (t) => {
  const { store, failed, databaseUrl } = await fixture(t);
  const originalText = '\u001b[31mPrivate customer\u0085\u2028new line\n';
  await failed('cli-message', { message: { message_text: originalText } });
  let output = '';
  let errors = '';
  const options = {
    createStore: () => store,
    env: { DATABASE_URL: databaseUrl, NODE_ENV: 'test', ALLOWED_SENDER_PHONES: sender },
    stdout: { write(value) { output += value; } }, stderr: { write(value) { errors += value; } },
  };
  assert.equal(await run(['list', '1'], options), 0);
  assert.equal(JSON.parse(output)[0].sender_phone, '***4567');
  assert.equal(output.includes('Private'), false);
  output = '';
  assert.equal(await run(['show', 'cli-message'], options), 0);
  assert.equal(JSON.parse(output).message.message_text, originalText);
  assert.equal(output.includes('\u001b'), false);
  assert.equal(output.includes('\u0085'), false);
  assert.equal(output.includes('\u2028'), false);
  output = '';
  assert.equal(await run(['retry', 'cli-message'], options), 0);
  assert.equal(JSON.parse(output).status, 'RECEIVED');
  assert.equal(errors, '');
});

test('Admin CLI validates usage and production persistence before opening a database; failures are sanitized', async () => {
  let calls = 0;
  let output = '';
  const base = {
    stdout: { write(value) { output += value; } }, stderr: { write(value) { output += value; } },
    createStore() { calls += 1; throw new Error('postgres://private-user:private-password@private-host/private-db'); },
  };
  for (const argv of [['bad'], ['list', '101'], ['list', '0'], ['show'], ['retry'], ['retry', 'id', 'extra']]) {
    assert.equal(await run(argv, { ...base, env: {} }), 1);
  }
  assert.equal(await run(['list'], { ...base, env: { NODE_ENV: 'production', DATABASE_URL: 'file:./test.sqlite' } }), 1);
  assert.equal(calls, 0);
  output = '';
  assert.equal(await run(['list'], { ...base, env: { DATABASE_URL: 'file:./unused.sqlite' } }), 1);
  assert.equal(calls, 1);
  assert.equal(output.includes('private'), false);
  assert.equal(JSON.parse(output).error.code, 'ADMIN_DATABASE');
  output = '';
  assert.equal(await run(['--help'], { ...base, env: {} }), 0);
  assert.ok(JSON.parse(output).usage.length > 0);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(jsonOutput({ text: '\u001b\u009b\u2028' })).text, '\u001b\u009b\u2028');
});
