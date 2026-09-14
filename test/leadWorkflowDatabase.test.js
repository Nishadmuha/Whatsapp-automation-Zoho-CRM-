'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMessageStore } = require('../src/database');

const FLOW = { processingFlow: 'conversation' };
const BOSS_FLOW = { processingFlow: 'boss_lead' };
const FIELDS = ['company_name', 'contact_name', 'phone', 'email', 'project_name', 'project_location', 'product_or_service', 'requirement', 'quantity', 'deadline', 'notes', 'address', 'trn_no'];
const ago = ms => new Date(Date.now() - ms).toISOString();
const message = (id = randomUUID(), overrides = {}) => ({
  whatsapp_message_id: id, sender_phone: '+971501234567', message_type: 'text', authenticated: true,
  message_text: '  Synthetic company: AC maintenance.\nKeep the original spacing.  ', received_at: new Date().toISOString(),
  request_lead_workflow: true, ...overrides,
});
const result = (overrides = {}) => ({ is_lead: true, lead: { ...Object.fromEntries(FIELDS.map(field => [field, null])),
  company_name: 'Synthetic company', product_or_service: 'AC maintenance', ...overrides } });
const partialResult = (fields = {}) => ({ is_lead: true, lead: { ...Object.fromEntries(FIELDS.map(field => [field, null])), ...fields } });
const VALID = { valid: true, missing_fields: [], errors: [] };
const CONFIRMATION = 'Lead received and saved internally. Zoho CRM sync is currently pending.';

async function seedVersionThree(databaseUrl, dialect) {
  const migrations = await Promise.all(['001_initial', '002_conversation', '003_lead_extractions'].map(name =>
    fs.readFile(path.join(__dirname, `../migrations/${name}.${dialect}.sql`), 'utf8')));
  const seed = `
    INSERT INTO schema_migrations(version,applied_at) VALUES (1,'2026-01-01T00:00:00.000Z'),(2,'2026-01-01T00:00:00.000Z'),(3,'2026-01-01T00:00:00.000Z');
    INSERT INTO whatsapp_messages(whatsapp_message_id,sender_phone,message_text,message_type,authenticated,received_at,created_at,processing_flow)
      VALUES ('existing-v3','+971501234567','Original v3 conversation','text',TRUE,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','conversation');
    INSERT INTO whatsapp_messages(whatsapp_message_id,sender_phone,message_text,message_type,authenticated,received_at,created_at)
      VALUES ('legacy-null','+971501234567','Original unscoped receipt','text',TRUE,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO reply_outbox(id,message_id,text,created_at) VALUES ('existing-reply','existing-v3','Existing reply','2026-01-01T00:00:00.000Z');
    INSERT INTO lead_extractions(message_id,created_at) VALUES ('existing-v3','2026-01-01T00:00:00.000Z');
    INSERT INTO processing_logs(id,message_id,event,details,created_at) VALUES ('existing-log','existing-v3','synthetic_event','{}','2026-01-01T00:00:00.000Z');`;
  if (dialect === 'sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databaseUrl.slice(5));
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

async function seedVersionFive(databaseUrl, dialect) {
  await seedVersionThree(databaseUrl, dialect);
  const migrations = await Promise.all(['004_leads', '005_lead_sessions'].map(name =>
    fs.readFile(path.join(__dirname, `../migrations/${name}.${dialect}.sql`), 'utf8')));
  const oldResult = result();
  delete oldResult.lead.address;
  delete oldResult.lead.trn_no;
  const serialized = JSON.stringify(oldResult);
  const checked = JSON.stringify(VALID);
  const seed = `
    INSERT INTO schema_migrations(version,applied_at) VALUES (4,'2026-01-01T00:00:00.000Z'),(5,'2026-01-01T00:00:00.000Z');
    INSERT INTO leads(id,whatsapp_message_id,sender_phone,original_message,company_name,created_at,updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111','legacy-null','+971501234567','Historic original','Historic company','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO lead_sessions(id,sender_phone,state,result,validation_result,original_message,first_message_id,created_at,updated_at)
      VALUES ('old-draft','+971501234567','awaiting_confirmation','${serialized}','${checked}','  Preserve old draft.\nExactly.  ','existing-v3','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO lead_sessions(id,sender_phone,state,result,validation_result,original_message,first_message_id,lead_id,created_at,updated_at,completed_at)
      VALUES ('old-saved','+971501234567','completed','${serialized}','${checked}','Historic original','legacy-null','11111111-1111-4111-8111-111111111111','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    UPDATE whatsapp_messages SET session_id='old-draft',processing_flow='boss_lead' WHERE whatsapp_message_id='existing-v3';
    UPDATE whatsapp_messages SET session_id='old-saved' WHERE whatsapp_message_id='legacy-null';
    UPDATE lead_extractions SET processing_status='SUCCESS',result='${serialized}' WHERE message_id='existing-v3';`;
  if (dialect === 'sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databaseUrl.slice(5));
    try {
      db.exec('PRAGMA foreign_keys=OFF; BEGIN');
      for (const migration of migrations) db.exec(migration);
      db.exec(seed);
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
      db.exec('COMMIT');
    } finally { db.close(); }
  } else {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      for (const migration of migrations) await pool.query(migration);
      await pool.query(seed);
    } finally { await pool.end(); }
  }
}

async function fixture(t, dialect, { legacy = false, versionFive = false } = {}) {
  const stores = [];
  let databaseUrl;
  let cleanup;
  if (dialect === 'postgres') {
    const { Pool } = require('pg');
    const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `test_lead_workflow_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connectionUrl = new URL(process.env.TEST_DATABASE_URL);
    connectionUrl.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = connectionUrl.toString();
    cleanup = async () => {
      try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin.end(); }
    };
  } else {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whatsapp-workflow-db-'));
    databaseUrl = `file:${path.join(directory, 'messages.sqlite')}`;
    cleanup = async () => {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('whatsapp-workflow-db-'));
      await fs.rm(directory, { recursive: true, force: true });
    };
  }
  t.after(async () => { for (const store of stores.reverse()) await store.close(); await cleanup(); });
  if (versionFive) await seedVersionFive(databaseUrl, dialect);
  else if (legacy) await seedVersionThree(databaseUrl, dialect);
  async function connect() {
    const store = createMessageStore({ databaseUrl });
    stores.push(store);
    await store.init();
    return store;
  }
  return { store: await connect(), connect, databaseUrl };
}

const turn = (store, job, options = {}) => store.completeLeadSessionTurn(job.message_id, job.lease_token, options);
async function nextTurn(store, id, options = {}, overrides = {}) {
  await store.enqueueMany([message(id, overrides)], FLOW);
  const job = await store.claimLeadExtraction();
  assert.equal(job.message_id, id);
  assert.equal(await turn(store, job, options), true);
  return job;
}
const details = (extra = {}) => ({ state: 'collecting', result: result(), validation: VALID,
  originalMessage: 'Synthetic company needs AC maintenance.', kind: 'details', ...extra });

function contract(dialect) {
  const options = { skip: dialect === 'postgres' && !process.env.TEST_DATABASE_URL };
  const dbTest = (name, fn, fixtureOptions) => test(`${dialect}: lead sessions ${name}`, options,
    async t => fn(await fixture(t, dialect, fixtureOptions), t));

  dbTest('upgrades old databases in place and exposes existing inbox and outbox history', async ({ store, connect }) => {
assert.deepEqual((await store.driver.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal((await store.getMessage('existing-v3')).processing_flow, 'conversation');
    assert.equal((await store.getReply('existing-v3')).text, 'Existing reply');
    assert.equal((await store.driver.query('SELECT id FROM processing_logs')).rowCount, 1);
    const history = await store.listConversationMessages('+971501234567');
    assert.equal(history.total, 3);
    assert.equal(history.items.filter(row => row.direction === 'outgoing')[0].text, 'Existing reply');
    assert.equal((await store.listLeads()).total, 0);
    await store.close();
    const reopened = await connect();
    assert.deepEqual(await reopened.listConversationMessages('+971501234567'), history);
  }, { legacy: true });

  dbTest('intake durably stores jobs and all media metadata without a lead or session', async ({ store }) => {
    await store.enqueueMany([message('intake'), message('image', { message_type: 'image', message_text: '',
      media_id: 'synthetic-media', media_mime_type: 'image/jpeg', media_filename: 'lead.jpg', sender_name: 'Boss' })], FLOW);
    assert.equal((await store.listLeads()).total, 0);
    assert.equal(await store.getActiveLeadSession('+971501234567'), null);
    assert.equal((await store.getMessage('image')).media_id, 'synthetic-media');
    assert.equal((await store.getMessage('image')).sender_name, 'Boss');
    assert.equal((await store.getMessage('image')).processing_flow, 'boss_lead');
    assert.equal(await store.claimNext(FLOW), null);
    assert.equal(await store.claimNext(), null);
  });

  dbTest('consumes a boss processing claim once across connections before any decision', async ({ store, connect }) => {
    const other = await connect();
    await store.enqueueMany([message('same-claim')], FLOW);
    const job = await store.claimLeadExtraction();
    const attempts = (await store.getLeadExtraction(job.message_id)).attempts;
    const tokens = await Promise.all([
      store.beginLeadExtractionProcessing(job.message_id, job.lease_token),
      other.beginLeadExtractionProcessing(job.message_id, job.lease_token),
    ]);
    assert.equal(tokens.filter(Boolean).length, 1);
    const executionToken = tokens.find(Boolean);
    assert.notEqual(executionToken, job.lease_token);
    assert.equal((await store.getLeadExtraction(job.message_id)).attempts, attempts);
    assert.equal(await store.heartbeatLeadExtraction(job.message_id, job.lease_token), false);
    assert.equal(await store.checkpointLeadMedia(job.message_id, job.lease_token, { transcription: 'Duplicate' }), false);
    assert.equal(await turn(store, job, details({ replyText: 'Duplicate decision' })), false);
    assert.equal(await store.failLeadWorkflow(job.message_id, job.lease_token,
      { code: 'AI_UNAVAILABLE', stage: 'extraction' }), false);
    assert.equal(await store.heartbeatLeadExtraction(job.message_id, executionToken), true);
    assert.equal(await turn(store, { ...job, lease_token: executionToken }, details({ replyText: 'One decision' })), true);
    assert.equal(await store.beginLeadExtractionProcessing(job.message_id, executionToken), null);
    assert.equal((await store.getReply(job.message_id)).text, 'One decision');
    assert.equal((await store.driver.query('SELECT id FROM reply_outbox WHERE message_id=?', [job.message_id])).rowCount, 1);
  });

  dbTest('allows recovery after an execution lease expires while fencing both earlier tokens', async ({ store }) => {
    await store.enqueueMany([message('recover-execution')], FLOW);
    const first = await store.claimLeadExtraction();
    const firstExecution = await store.beginLeadExtractionProcessing(first.message_id, first.lease_token);
    await store.driver.query('UPDATE lead_extractions SET lease_expires_at=? WHERE message_id=?', [ago(1000), first.message_id]);
    assert.equal(await store.beginLeadExtractionProcessing(first.message_id, firstExecution), null);
    const retry = await store.claimLeadExtraction();
    assert.equal(retry.message_id, first.message_id);
    assert.equal(retry.attempts, first.attempts + 1);
    assert.equal(await store.beginLeadExtractionProcessing(first.message_id, first.lease_token), null);
    assert.equal(await store.beginLeadExtractionProcessing(first.message_id, firstExecution), null);
    const retryExecution = await store.beginLeadExtractionProcessing(retry.message_id, retry.lease_token);
    assert.ok(retryExecution);
    assert.equal(await turn(store, { ...retry, lease_token: retryExecution }, details()), true);
    assert.equal((await store.getActiveLeadSession('+971501234567')).original_message, 'Synthetic company needs AC maintenance.');
  });

  dbTest('does not consume customer extraction or unauthenticated processing claims', async ({ store }) => {
    await store.enqueueMany([message('customer-execution', { request_lead_workflow: false, request_lead_extraction: true })], FLOW);
    const customer = await store.claimLeadExtraction();
    assert.equal(await store.beginLeadExtractionProcessing(customer.message_id, customer.lease_token), null);
    assert.equal(await store.heartbeatLeadExtraction(customer.message_id, customer.lease_token), true);
    await store.enqueueMany([message('unauthenticated-execution')], FLOW);
    const boss = await store.claimLeadExtraction();
    await store.driver.query('UPDATE whatsapp_messages SET authenticated=FALSE WHERE whatsapp_message_id=?', [boss.message_id]);
    assert.equal(await store.beginLeadExtractionProcessing(boss.message_id, boss.lease_token), null);
    assert.equal((await store.getLeadExtraction(boss.message_id)).lease_token, boss.lease_token);
    assert.equal(await store.getActiveLeadSession('+971501234567'), null);
    assert.equal((await store.listLeads()).total, 0);
  });

  dbTest('upgrades populated version 5 drafts and saved history without changing source data or links', async ({ store, connect }) => {
    const draft = await store.getActiveLeadSession('+971501234567');
    assert.equal(draft.id, 'old-draft');
    assert.equal(draft.state, 'awaiting_confirmation');
    assert.equal(draft.original_message, '  Preserve old draft.\nExactly.  ');
    assert.equal(draft.result.lead.address, null);
    assert.equal(draft.result.lead.trn_no, null);
    assert.equal(draft.result.lead.company_name, 'Synthetic company');
    assert.equal(draft.pending_action, null);
    const lead = await store.getLead('11111111-1111-4111-8111-111111111111');
    assert.equal(lead.company_name, 'Historic company');
    assert.equal(lead.address, null);
    assert.equal(lead.trn_no, null);
    assert.deepEqual((await store.getLeadExtraction('existing-v3')).result, draft.result);
    const conversation = await store.getConversation('+971501234567');
    assert.equal(conversation.archived_sessions[0].id, 'old-saved');
    const history = await store.listConversationMessages('+971501234567');
    assert.equal(history.items.find(row => row.message_id === 'existing-v3').session_id, 'old-draft');
    assert.equal(history.items.find(row => row.message_id === 'legacy-null').lead_id, lead.id);
    assert.ok(history.items.every(row => row.transcription === null && row.extracted_text === null));
    await store.close();
    const reopened = await connect();
    assert.deepEqual(await reopened.getConversation('+971501234567'), conversation);
    await nextTurn(reopened, 'confirm-upgraded', { sessionId: draft.id, state: 'completed', kind: 'confirmation', replyText: 'Saved' });
    assert.equal((await reopened.listLeads()).total, 2);
  }, { versionFive: true });

  dbTest('stores address and TRN separately, enforces their limits, and saves extended source text after confirmation', async ({ store }) => {
    const source = `${'Original details.\n'.repeat(2000)}Address: Warehouse 10, DIP\nTRN: 100000000000003`;
    await nextTurn(store, 'full-details', details({ result: result({ address: 'Warehouse 10, DIP', trn_no: '100000000000003' }),
      originalMessage: source, state: 'awaiting_confirmation' }));
    const draft = await store.getActiveLeadSession('+971501234567');
    await store.enqueueMany([message('invalid-field')], FLOW);
    const invalid = await store.claimLeadExtraction();
    for (const override of [{ address: 'a'.repeat(1001) }, { trn_no: '1'.repeat(41) }]) {
      await assert.rejects(turn(store, invalid, details({ sessionId: draft.id, result: result(override) })), /Invalid/);
    }
    await assert.rejects(turn(store, invalid, details({ sessionId: draft.id, originalMessage: 'a'.repeat(64001) })), /Invalid original message/);
    assert.deepEqual(await store.getActiveLeadSession('+971501234567'), draft);
    await turn(store, invalid, { sessionId: draft.id, state: 'completed', kind: 'confirmation', replyText: 'Saved' });
    const lead = (await store.listLeads()).items[0];
    assert.equal(lead.address, 'Warehouse 10, DIP');
    assert.equal(lead.trn_no, '100000000000003');
    assert.equal(lead.original_message, source);
    assert.equal(lead.zoho_status, 'not_started');
  });

  dbTest('starts an empty draft only for an explicit new lead and preserves pending decisions through greetings and restart', async ({ store, connect }) => {
    await nextTurn(store, 'start', { state: 'collecting', kind: 'new_lead', originalMessage: '', replyText: 'Please send details.' });
    const empty = await store.getActiveLeadSession('+971501234567');
    assert.equal(empty.original_message, '');
    assert.equal(empty.result.is_lead, false);
    assert.deepEqual(empty.validation_result, { valid: false, missing_fields: [], errors: ['NOT_A_LEAD'] });
    await nextTurn(store, 'details', details({ sessionId: empty.id, state: 'awaiting_confirmation' }));
    const before = await store.getActiveLeadSession('+971501234567');
    await nextTurn(store, 'start-again', { sessionId: empty.id, kind: 'new_lead', pendingAction: 'new_lead' });
    const pending = await store.getActiveLeadSession('+971501234567');
    assert.equal(pending.pending_action, 'new_lead');
    assert.equal(pending.state, before.state);
    assert.deepEqual(pending.result, before.result);
    assert.equal(pending.original_message, before.original_message);
    await nextTurn(store, 'hi', { sessionId: empty.id, kind: 'greeting', replyText: 'Hi Boss' });
    assert.deepEqual(await store.getActiveLeadSession('+971501234567'), pending);
    await store.close();
    const reopened = await connect();
    assert.deepEqual(await reopened.getActiveLeadSession('+971501234567'), pending);
    await reopened.enqueueMany([message('reset-attempt')], FLOW);
    const reset = await reopened.claimLeadExtraction();
    await assert.rejects(turn(reopened, reset, { sessionId: empty.id, state: 'collecting', kind: 'new_lead', originalMessage: '' }), /cannot be reset/);
    await turn(reopened, reset, { sessionId: empty.id, kind: 'conversation', pendingAction: null });
    assert.equal((await reopened.getActiveLeadSession('+971501234567')).pending_action, null);
    assert.equal((await reopened.listLeads()).total, 0);
  });

  dbTest('archives discarded drafts without losing text or history and atomically starts a separate empty lead', async ({ store }) => {
    await nextTurn(store, 'old-details', details());
    const old = await store.getActiveLeadSession('+971501234567');
    await store.enqueueMany([message('discard-attempt')], FLOW);
    const attempted = await store.claimLeadExtraction();
    await assert.rejects(turn(store, attempted, { sessionId: old.id, state: 'discarded', kind: 'discard', startNewSession: true }), /not awaiting explicit discard/);
    await turn(store, attempted, { sessionId: old.id, kind: 'new_lead', pendingAction: 'new_lead' });
    const discard = await nextTurn(store, 'discard-confirmed', { sessionId: old.id, state: 'discarded', kind: 'discard', startNewSession: true, replyText: 'Ready for new details.' });
    assert.equal(await turn(store, discard, { sessionId: old.id, state: 'discarded', kind: 'discard', startNewSession: true }), false);
    const fresh = await store.getActiveLeadSession('+971501234567');
    assert.notEqual(fresh.id, old.id);
    assert.equal(fresh.state, 'collecting');
    assert.equal(fresh.original_message, '');
    assert.equal(fresh.pending_action, null);
    assert.deepEqual(fresh.validation_result, { valid: false, missing_fields: [], errors: ['NOT_A_LEAD'] });
    assert.ok(Object.values(fresh.result.lead).every(value => value === null));
    const conversation = await store.getConversation('+971501234567');
    assert.equal(conversation.status, 'collecting');
    const archived = conversation.archived_sessions[0];
    assert.equal(archived.id, old.id);
    assert.equal(archived.state, 'discarded');
    assert.equal(archived.lead_id, null);
    assert.ok(archived.completed_at);
    assert.deepEqual(archived.result, old.result);
    assert.equal(archived.original_message, old.original_message);
    const history = (await store.listConversationMessages('+971501234567')).items;
    assert.ok(history.every(row => row.session_id === old.id));
    assert.equal(history.filter(row => row.direction === 'outgoing' && row.message_id === 'discard-confirmed').length, 1);
    assert.equal((await store.listLeads()).total, 0);
    await nextTurn(store, 'fresh-details', details({ sessionId: fresh.id, result: result({ company_name: 'New company' }) }));
    assert.equal((await store.getActiveLeadSession('+971501234567')).result.lead.company_name, 'New company');
    assert.equal((await store.getConversation('+971501234567')).archived_sessions[0].result.lead.company_name, 'Synthetic company');
    await store.driver.query('ALTER TABLE lead_sessions ADD COLUMN private_marker TEXT');
    const safeConversation = await store.getConversation('+971501234567');
    assert.equal('private_marker' in safeConversation.active_session, false);
    assert.equal('private_marker' in safeConversation.archived_sessions[0], false);
  });

  dbTest('checkpoints media once before retries and fences expired owners without creating replies or sessions', async ({ store, connect }) => {
    await store.enqueueMany([message('media', { message_type: 'audio', message_text: '', media_id: 'voice-1' }), message('later')], FLOW);
    const first = await store.claimLeadExtraction();
    assert.equal(await store.checkpointLeadMedia(first.message_id, first.lease_token, { transcription: 'Company needs 4 SMDB.' }), true);
    assert.equal(await store.getActiveLeadSession('+971501234567'), null);
    assert.equal(await store.getReply(first.message_id), null);
    await store.failLeadWorkflow(first.message_id, first.lease_token, { code: 'AI_UNAVAILABLE', stage: 'extraction', nextAttemptAt: ago(1) });
    const other = await connect();
    const retry = await other.claimLeadExtraction();
    assert.equal(retry.message_id, first.message_id);
    assert.equal(retry.transcription, 'Company needs 4 SMDB.');
    assert.equal(await store.checkpointLeadMedia(first.message_id, first.lease_token, { transcription: 'Stale overwrite' }), false);
    assert.equal(await store.claimLeadExtraction(), null);
    await other.driver.query('UPDATE lead_extractions SET lease_expires_at=? WHERE message_id=?', [ago(1000), retry.message_id]);
    assert.equal(await other.checkpointLeadMedia(retry.message_id, retry.lease_token, { transcription: 'Expired overwrite' }), false);
    const recovered = await store.claimLeadExtraction();
    assert.equal(recovered.transcription, 'Company needs 4 SMDB.');
    await turn(store, recovered, details({ transcription: recovered.transcription, replyText: 'Please continue.' }));
    assert.equal(await store.checkpointLeadMedia(recovered.message_id, recovered.lease_token, { transcription: 'Completed overwrite' }), false);
    assert.equal((await store.listConversationMessages('+971501234567')).items.find(row => row.message_id === 'media').transcription, recovered.transcription);
    assert.equal((await store.claimLeadExtraction()).message_id, 'later');
    assert.equal((await store.driver.query('SELECT id FROM reply_outbox WHERE message_id=?', ['media'])).rowCount, 1);
  });

  dbTest('media checkpoints reject customer and unauthenticated work and preserve explicit empty OCR without a draft', async ({ store }) => {
    await store.enqueueMany([message('customer', { request_lead_workflow: false, request_lead_extraction: true })], FLOW);
    const customer = await store.claimLeadExtraction();
    assert.equal(await store.checkpointLeadMedia(customer.message_id, customer.lease_token, { extractedText: 'Do not store' }), false);
    assert.equal((await store.getMessage('customer')).extracted_text, null);
    await store.enqueueMany([message('image', { message_type: 'image', message_text: '', media_id: 'image-1' })], FLOW);
    const image = await store.claimLeadExtraction();
    await assert.rejects(store.checkpointLeadMedia(image.message_id, image.lease_token, { extractedText: 'x'.repeat(64001) }), /Invalid extracted text/);
    await assert.rejects(store.checkpointLeadMedia(image.message_id, image.lease_token, {}), /requires text/);
    await store.driver.query('UPDATE whatsapp_messages SET authenticated=FALSE WHERE whatsapp_message_id=?', ['image']);
    assert.equal(await store.checkpointLeadMedia(image.message_id, image.lease_token, { extractedText: 'Unauthorized' }), false);
    await store.driver.query('UPDATE whatsapp_messages SET authenticated=TRUE WHERE whatsapp_message_id=?', ['image']);
    await turn(store, image, { kind: 'media_error', extractedText: '', replyText: 'Please resend a clearer image.' });
    assert.equal((await store.getMessage('image')).extracted_text, '');
    assert.equal(await store.getActiveLeadSession('+971501234567'), null);
    const history = (await store.listConversationMessages('+971501234567')).items;
    assert.equal(history.find(row => row.message_id === 'image' && row.direction === 'incoming').extracted_text, '');
    assert.equal(history.find(row => row.message_id === 'image' && row.direction === 'outgoing').extracted_text, null);
  });

  dbTest('greetings preserve existing drafts and never create leads or sessions', async ({ store }) => {
    await nextTurn(store, 'hello', { kind: 'greeting', replyText: 'Hi Boss' }, { message_text: 'Hi' });
    assert.equal(await store.getActiveLeadSession('+971501234567'), null);
    await nextTurn(store, 'details', details());
    const session = await store.getActiveLeadSession('+971501234567');
    await nextTurn(store, 'hello-again', { sessionId: session.id, kind: 'greeting', replyText: 'Hi Boss' });
    assert.deepEqual(await store.getActiveLeadSession('+971501234567'), session);
    assert.equal((await store.getMessage('hello-again')).session_id, session.id);
    assert.equal((await store.listLeads()).total, 0);
  });

  dbTest('merges details and deferral into one draft then saves only stored data after confirmation', async ({ store, connect }) => {
    await nextTurn(store, 'company', details({ validation: { valid: false, missing_fields: ['phone'], errors: [] } }));
    const session = await store.getActiveLeadSession('+971501234567');
    await nextTurn(store, 'contact', details({ sessionId: session.id, result: result({ phone: '+971501234560' }),
      originalMessage: 'Synthetic company needs AC maintenance. Ahmed +971501234560', state: 'awaiting_confirmation', replyText: 'Ready to save?' }));
    assert.equal((await store.listLeads()).total, 0);
    await nextTurn(store, 'not-yet', { sessionId: session.id, state: 'collecting', kind: 'defer' });
    assert.equal((await store.getActiveLeadSession('+971501234567')).state, 'collecting');
    await nextTurn(store, 'more', details({ sessionId: session.id, state: 'awaiting_confirmation', result: result({ quantity: '2' }),
      originalMessage: 'Synthetic company needs 2 AC maintenance visits.', replyText: 'Ready to save?' }));
    const awaiting = await store.getActiveLeadSession('+971501234567');
    await store.close();
    const reopened = await connect();
    assert.deepEqual(await reopened.getActiveLeadSession('+971501234567'), awaiting);
    const confirmation = await nextTurn(reopened, 'yes', { sessionId: session.id, state: 'completed', kind: 'confirmation',
      result: result({ company_name: 'Must not replace stored data' }), replyText: 'Lead saved successfully' }, { message_text: 'Yes' });
    assert.equal(await reopened.getActiveLeadSession('+971501234567'), null);
    const leads = await reopened.listLeads();
    assert.equal(leads.total, 1);
    assert.equal(leads.items[0].company_name, 'Synthetic company');
    assert.equal(leads.items[0].quantity, '2');
    assert.equal(leads.items[0].original_message, awaiting.original_message);
    assert.equal(leads.items[0].zoho_status, 'not_started');
    assert.equal(leads.items[0].whatsapp_message_id, 'company');
    assert.equal(await turn(reopened, confirmation, { sessionId: session.id, state: 'completed', kind: 'confirmation' }), false);
    await nextTurn(reopened, 'next-lead', details());
    assert.notEqual((await reopened.getActiveLeadSession('+971501234567')).id, session.id);
    assert.equal((await reopened.listLeads()).total, 1);
    const history = await reopened.listConversationMessages('+971501234567');
    assert.equal(history.items.find(row => row.message_id === 'contact').lead_id, leads.items[0].id);
    assert.equal(history.items.find(row => row.message_id === 'yes' && row.direction === 'outgoing').text, 'Lead saved successfully');
  });

  dbTest('concurrent confirmation transactions over separate connections save and queue success exactly once', async ({ store, connect }) => {
    const other = await connect();
    const available = partialResult({ email: 'boss-intake@example.com' });
    await nextTurn(store, 'email-draft', details({ state: 'awaiting_confirmation', result: available,
      originalMessage: 'boss-intake@example.com' }));
    const draft = await store.getActiveLeadSession('+971501234567');
    await store.enqueueMany([message('same-confirmation', { message_text: 'yes' })], FLOW);
    const confirmation = await store.claimLeadExtraction();
    const options = { sessionId: draft.id, state: 'completed', kind: 'confirmation',
      replyText: 'Lead saved successfully \u2705' };
    const outcomes = await Promise.all([turn(store, confirmation, options), turn(other, confirmation, options)]);
    assert.deepEqual(outcomes.sort(), [false, true]);
    assert.equal(await store.getActiveLeadSession('+971501234567'), null);
    const leads = await store.listLeads();
    assert.equal(leads.total, 1);
    assert.equal(leads.items[0].whatsapp_message_id, 'email-draft');
    assert.deepEqual(Object.fromEntries(FIELDS.map(field => [field, leads.items[0][field]])), available.lead);
    const archived = (await store.getConversation('+971501234567')).archived_sessions;
    assert.equal(archived.length, 1);
    assert.equal(archived[0].id, draft.id);
    assert.equal(archived[0].state, 'completed');
    assert.equal(archived[0].lead_id, leads.items[0].id);
    assert.ok(archived[0].completed_at);
    assert.equal((await store.driver.query('SELECT id FROM reply_outbox WHERE message_id=?', ['same-confirmation'])).rowCount, 1);
    assert.equal((await store.getReply('same-confirmation')).text, options.replyText);
    const replies = await Promise.all([store.claimReply(BOSS_FLOW), other.claimReply(BOSS_FLOW)]);
    assert.equal(replies.filter(Boolean).length, 1, 'Only one dispatcher can claim the success reply.');
    const reply = replies.find(Boolean);
    assert.equal(await store.finishReply(reply.id, reply.lease_token, { status: 'SENT', provider_message_id: 'synthetic-success' }), true);
    assert.equal(await other.claimReply(BOSS_FLOW), null);
    const history = await store.listConversationMessages('+971501234567');
    assert.equal(history.items.filter(row => row.direction === 'outgoing' && row.message_id === 'same-confirmation').length, 1);
  });

  dbTest('replayed saved confirmation after restart cannot save or change a newer active draft', async ({ store, connect }) => {
    await nextTurn(store, 'first-draft', details({ state: 'awaiting_confirmation' }));
    const first = await store.getActiveLeadSession('+971501234567');
    const confirmationMessage = message('old-confirmation', { message_text: 'yes' });
    await store.enqueueMany([confirmationMessage], FLOW);
    const confirmation = await store.claimLeadExtraction();
    const options = { sessionId: first.id, state: 'completed', kind: 'confirmation', replyText: 'Lead saved successfully \u2705' };
    assert.equal(await turn(store, confirmation, options), true);
    const saved = await store.listLeads();
    const reply = await store.getReply('old-confirmation');
    await nextTurn(store, 'new-draft', details({ state: 'awaiting_confirmation', result: partialResult({ contact_name: 'Nishad' }),
      originalMessage: 'Nishad' }));
    const fresh = await store.getActiveLeadSession('+971501234567');
    assert.notEqual(fresh.id, first.id);
    await store.close();
    const reopened = await connect();
    assert.deepEqual(await reopened.enqueueMany([confirmationMessage], FLOW), { inserted: 0, duplicates: 1 });
    assert.equal(await reopened.claimLeadExtraction(), null);
    assert.equal(await reopened.beginLeadExtractionProcessing(confirmation.message_id, confirmation.lease_token), null);
    assert.equal(await turn(reopened, confirmation, options), false);
    assert.equal(await turn(reopened, confirmation, { ...options, sessionId: fresh.id }), false);
    assert.deepEqual(await reopened.getActiveLeadSession('+971501234567'), fresh);
    assert.deepEqual(await reopened.listLeads(), saved);
    assert.deepEqual(await reopened.getReply('old-confirmation'), reply);
    assert.equal((await reopened.getConversation('+971501234567')).archived_sessions.length, 1);
    assert.equal((await reopened.getLeadExtraction('old-confirmation')).processing_status, 'SUCCESS');
    assert.equal((await reopened.driver.query('SELECT id FROM reply_outbox WHERE message_id=?', ['old-confirmation'])).rowCount, 1);
  });

  dbTest('allows identical customer details in later confirmed sessions of the same boss conversation', async ({ store }) => {
    const customer = result({ company_name: 'Al Noor Contracting', contact_name: 'Ahmed', phone: '+971501234567', email: 'ahmed@example.com' });
    const sessions = [];
    for (let index = 1; index <= 2; index += 1) {
      await nextTurn(store, `repeated-details-${index}`, details({ state: 'awaiting_confirmation', result: customer,
        originalMessage: 'Al Noor Contracting Ahmed +971501234567 ahmed@example.com needs AC maintenance.' }));
      const draft = await store.getActiveLeadSession('+971501234567');
      sessions.push(draft.id);
      assert.equal((await store.listLeads()).total, index - 1, 'Details alone cannot save either session.');
      await nextTurn(store, `repeated-yes-${index}`, { sessionId: draft.id, state: 'completed', kind: 'confirmation',
        replyText: 'Lead saved successfully \u2705' }, { message_text: 'yes' });
      assert.equal(await store.getActiveLeadSession('+971501234567'), null);
    }
    assert.equal(new Set(sessions).size, 2);
    const leads = await store.listLeads();
    assert.equal(leads.total, 2);
    assert.equal(new Set(leads.items.map(lead => lead.id)).size, 2);
    assert.deepEqual(leads.items.map(lead => lead.whatsapp_message_id).sort(), ['repeated-details-1', 'repeated-details-2']);
    for (const lead of leads.items) {
      assert.equal(lead.sender_phone, '+971501234567');
      assert.deepEqual(Object.fromEntries(FIELDS.map(field => [field, lead[field]])), customer.lead);
      assert.equal(lead.zoho_status, 'not_started');
      assert.equal(lead.zoho_lead_id, null);
    }
    const archived = (await store.getConversation('+971501234567')).archived_sessions;
    assert.deepEqual(archived.map(session => session.id).sort(), sessions.sort());
    assert.equal(new Set(archived.map(session => session.lead_id)).size, 2);
    assert.equal((await store.driver.query('SELECT id FROM reply_outbox WHERE text=?', ['Lead saved successfully \u2705'])).rowCount, 2);
  });

  const optionalSubsets = [
    { contact_name: 'Ahmed' },
    { company_name: 'GLOW POWER EQUIPMENT RENTAL LLC' },
    { email: 'procurement@glowpowerrental.com' },
    { phone: '+971501234567' },
    { product_or_service: 'Electrical panels' },
    { requirement: 'Send an installation quotation' },
    { address: 'Business Bay, Dubai' },
    { trn_no: '104249196700003' },
    { project_name: 'Warehouse expansion' },
    { project_location: 'Dubai' },
    { quantity: '2 units' },
    { deadline: 'Next Thursday' },
    { notes: 'Customer requested an afternoon callback' },
    { company_name: 'ABC Contracting', phone: '+971501234567' },
    { company_name: 'ABC Contracting', email: 'abc@example.com', address: 'Dubai' },
  ];
  for (const fields of optionalSubsets) {
    dbTest(`saves optional subset ${Object.keys(fields).join(' + ')} only after explicit confirmation`, async ({ store }) => {
      const available = partialResult(fields);
      const source = Object.values(fields).join('\n');
      const prompt = 'I have the available information for this lead. Is everything complete and ready to save?';
      await nextTurn(store, 'partial-details', details({ result: available, originalMessage: source,
        state: 'awaiting_confirmation', replyText: prompt }), { message_text: source });
      const session = await store.getActiveLeadSession('+971501234567');
      assert.equal(session.state, 'awaiting_confirmation');
      assert.deepEqual(session.result, available);
      assert.equal((await store.listLeads()).total, 0);
      assert.equal((await store.getReply('partial-details')).text, prompt);
      const confirmation = await nextTurn(store, 'save-partial', { sessionId: session.id, state: 'completed',
        kind: 'confirmation', replyText: 'Lead saved successfully ✅' }, { message_text: 'Yes' });
      const saved = (await store.listLeads()).items[0];
      assert.deepEqual(Object.fromEntries(FIELDS.map(field => [field, saved[field]])), available.lead);
      assert.deepEqual(saved.validation_result, VALID);
      assert.equal(saved.original_message, source);
      assert.equal(saved.zoho_status, 'not_started');
      assert.equal(await store.getActiveLeadSession('+971501234567'), null);
      assert.equal(await turn(store, confirmation, { sessionId: session.id, state: 'completed', kind: 'confirmation' }), false);
      assert.equal((await store.listLeads()).total, 1);
      assert.equal((await store.driver.query('SELECT id FROM reply_outbox WHERE message_id=?', ['save-partial'])).rowCount, 1);
    });
  }

  dbTest('refreshes old required-field validation without changing draft details before asking and saving', async ({ store, connect }) => {
    const available = partialResult({ email: 'procurement@glowpowerrental.com' });
    const oldValidation = { valid: false, missing_fields: ['company_name', 'requirement'], errors: [] };
    await nextTurn(store, 'old-partial', details({ result: available, validation: oldValidation,
      originalMessage: 'procurement@glowpowerrental.com' }));
    const before = await store.getActiveLeadSession('+971501234567');
    await store.close();
    const reopened = await connect();
    await nextTurn(reopened, 'ask-again', { sessionId: before.id, state: 'awaiting_confirmation',
      validation: VALID, kind: 'confirmation', replyText: 'Ready to save?' });
    const refreshed = await reopened.getActiveLeadSession('+971501234567');
    assert.deepEqual(refreshed.result, before.result);
    assert.equal(refreshed.original_message, before.original_message);
    assert.deepEqual(refreshed.validation_result, VALID);
    assert.equal((await reopened.listLeads()).total, 0);
    await nextTurn(reopened, 'save-refreshed', { sessionId: before.id, state: 'completed', kind: 'confirmation', replyText: 'Saved' });
    const lead = (await reopened.listLeads()).items[0];
    assert.deepEqual(Object.fromEntries(FIELDS.map(field => [field, lead[field]])), available.lead);
    assert.deepEqual(lead.validation_result, VALID);
  });

  dbTest('uses refreshed validation on confirmation of a pre-existing awaiting draft and preserves stored fields', async ({ store }) => {
    const available = partialResult({ contact_name: 'Ahmed' });
    await nextTurn(store, 'old-awaiting', details({ result: available, state: 'awaiting_confirmation', originalMessage: 'Ahmed' }));
    const draft = await store.getActiveLeadSession('+971501234567');
    await store.driver.query('UPDATE lead_sessions SET validation_result=? WHERE id=?', [
      JSON.stringify({ valid: false, missing_fields: ['requirement'], errors: [] }), draft.id,
    ]);
    await nextTurn(store, 'confirm-old-awaiting', { sessionId: draft.id, state: 'completed', kind: 'confirmation',
      validation: VALID, result: result({ contact_name: 'Must not replace Ahmed' }), replyText: 'Saved' });
    const lead = (await store.listLeads()).items[0];
    assert.deepEqual(Object.fromEntries(FIELDS.map(field => [field, lead[field]])), available.lead);
    assert.deepEqual(lead.validation_result, VALID);
    const archived = (await store.getConversation('+971501234567')).archived_sessions[0];
    assert.deepEqual(archived.validation_result, VALID);
    assert.deepEqual(archived.result, available);
  });

  dbTest('explicit confirmation saves a collecting draft after deferral without requiring another prompt', async ({ store }) => {
    const available = partialResult({ phone: '+971501234567' });
    await nextTurn(store, 'phone-details', details({ result: available, state: 'awaiting_confirmation', originalMessage: '+971501234567' }));
    const draft = await store.getActiveLeadSession('+971501234567');
    await nextTurn(store, 'not-yet', { sessionId: draft.id, state: 'collecting', kind: 'defer', validation: VALID });
    assert.equal((await store.getActiveLeadSession('+971501234567')).state, 'collecting');
    assert.equal((await store.listLeads()).total, 0);
    await nextTurn(store, 'yes-after-no', { sessionId: draft.id, state: 'completed', kind: 'confirmation',
      validation: VALID, replyText: 'Lead saved successfully ✅' }, { message_text: 'Yes' });
    const lead = (await store.listLeads()).items[0];
    assert.deepEqual(Object.fromEntries(FIELDS.map(field => [field, lead[field]])), available.lead);
    assert.equal(await store.getActiveLeadSession('+971501234567'), null);
    assert.equal((await store.getReply('yes-after-no')).text, 'Lead saved successfully ✅');
  });

  dbTest('fresh validation lets explicit confirmation immediately save an old collecting partial draft', async ({ store }) => {
    const available = partialResult({ contact_name: 'Ahmed' });
    await nextTurn(store, 'old-name-only', details({ result: available, originalMessage: 'Ahmed',
      validation: { valid: false, missing_fields: ['requirement'], errors: [] } }));
    const draft = await store.getActiveLeadSession('+971501234567');
    assert.equal(draft.state, 'collecting');
    await nextTurn(store, 'save-old-name', { sessionId: draft.id, state: 'completed', kind: 'confirmation',
      validation: VALID, replyText: 'Lead saved successfully ✅' }, { message_text: 'Save it' });
    const lead = (await store.listLeads()).items[0];
    assert.deepEqual(Object.fromEntries(FIELDS.map(field => [field, lead[field]])), available.lead);
    assert.deepEqual(lead.validation_result, VALID);
    assert.equal(await store.getActiveLeadSession('+971501234567'), null);
    assert.equal((await store.getReply('save-old-name')).text, 'Lead saved successfully ✅');
  });

  dbTest('does not promote or save an all-null result even when supplied valid validation', async ({ store }) => {
    await store.enqueueMany([message('empty-result')], FLOW);
    const job = await store.claimLeadExtraction();
    await assert.rejects(turn(store, job, details({ result: partialResult(), state: 'awaiting_confirmation' })), /Only valid leads/);
    assert.equal(await store.getActiveLeadSession('+971501234567'), null);
    await turn(store, job, details({ result: partialResult() }));
    const draft = await store.getActiveLeadSession('+971501234567');
    await store.enqueueMany([message('confirm-empty')], FLOW);
    const confirmation = await store.claimLeadExtraction();
    for (const state of ['collecting', 'awaiting_confirmation']) {
      await store.driver.query('UPDATE lead_sessions SET state=? WHERE id=?', [state, draft.id]);
      await assert.rejects(turn(store, confirmation, { sessionId: draft.id, state: 'completed', kind: 'confirmation', validation: VALID }), /requires available information/);
    }
    assert.equal((await store.listLeads()).total, 0);
    assert.equal((await store.getLeadExtraction(confirmation.message_id)).lease_token, confirmation.lease_token);
  });

  dbTest('rejects save without explicit confirmation and fences session ownership', async ({ store }) => {
    await nextTurn(store, 'draft', details());
    const session = await store.getActiveLeadSession('+971501234567');
    await store.enqueueMany([message('invalid-confirmation')], FLOW);
    const job = await store.claimLeadExtraction();
    await assert.rejects(turn(store, job, { sessionId: session.id, state: 'completed', kind: 'details' }), /explicit save confirmation/);
    await assert.rejects(turn(store, job, { sessionId: randomUUID(), kind: 'greeting' }), /ownership/);
    assert.equal((await store.getLeadExtraction(job.message_id)).lease_token, job.lease_token);
    assert.equal((await store.listLeads()).total, 0);
    assert.deepEqual(await store.getActiveLeadSession('+971501234567'), session);
  });

  dbTest('preserves receipt order across concurrent workers and blocks later same-sender jobs during retries', async ({ store, connect }) => {
    const other = await connect();
    await store.enqueueMany([message('z-first'), message('a-second'), message('other-sender', { sender_phone: '+971501111111' })], FLOW);
    const claimed = await Promise.all([store.claimLeadExtraction(), other.claimLeadExtraction()]);
    assert.deepEqual(claimed.map(job => job.message_id).sort(), ['other-sender', 'z-first']);
    const first = claimed.find(job => job.message_id === 'z-first');
    assert.equal(await store.claimLeadExtraction(), null);
    assert.equal(await store.failLeadWorkflow(first.message_id, first.lease_token,
      { code: 'AI_UNAVAILABLE', stage: 'extraction', nextAttemptAt: new Date(Date.now() + 60000).toISOString() }), true);
    assert.equal(await other.claimLeadExtraction(), null);
    await store.driver.query('UPDATE lead_extractions SET next_attempt_at=? WHERE message_id=?', [ago(1000), first.message_id]);
    const retry = await other.claimLeadExtraction();
    assert.equal(retry.message_id, 'z-first');
    assert.equal(await turn(store, first, { kind: 'greeting' }), false);
    assert.equal(await turn(other, retry, { kind: 'greeting' }), true);
    assert.equal((await store.claimLeadExtraction()).message_id, 'a-second');
  });

  dbTest('expires abandoned leases and releases exhausted first jobs without placeholder leads', async ({ store }) => {
    await store.enqueueMany([message('first'), message('second')], FLOW);
    const first = await store.claimLeadExtraction({ maxAttempts: 1 });
    await store.driver.query('UPDATE lead_extractions SET lease_expires_at=? WHERE message_id=?', [ago(1000), first.message_id]);
    assert.equal(await turn(store, first, details()), false);
    assert.equal((await store.claimLeadExtraction({ maxAttempts: 1 })).message_id, 'second');
    assert.equal((await store.getMessage('first')).error_message, 'PROCESSING_ATTEMPTS_EXHAUSTED');
    assert.equal((await store.listLeads()).total, 0);
  });

  dbTest('terminal failures and exhausted attempts invalidate earlier save prompts', async ({ store }) => {
    await nextTurn(store, 'awaiting', details({ state: 'awaiting_confirmation' }));
    await store.enqueueMany([message('unsaved-details', { message_text: 'Additional requirements' })], FLOW);
    const failed = await store.claimLeadExtraction();
    assert.equal(await store.failLeadWorkflow(failed.message_id, failed.lease_token,
      { code: 'PERSISTENCE_FAILED', stage: 'persistence' }), true);
    const session = await store.getActiveLeadSession('+971501234567');
    assert.equal(session.state, 'collecting');
    assert.equal(session.original_message, 'Synthetic company needs AC maintenance.');
    await nextTurn(store, 'ready-again', details({ sessionId: session.id, state: 'awaiting_confirmation' }));
    await store.enqueueMany([message('exhausted-details')], FLOW);
    const exhausted = await store.claimLeadExtraction({ maxAttempts: 1 });
    await store.driver.query('UPDATE lead_extractions SET lease_expires_at=? WHERE message_id=?', [ago(1000), exhausted.message_id]);
    assert.equal(await store.claimLeadExtraction({ maxAttempts: 1 }), null);
    assert.equal((await store.getActiveLeadSession('+971501234567')).state, 'collecting');
    assert.equal((await store.listLeads()).total, 0);
    assert.equal((await store.getMessage(failed.message_id)).message_text, 'Additional requirements');
  });

  dbTest('duplicate delivery cannot replace metadata, retag old work, or create another message', async ({ store, connect }) => {
    const other = await connect();
    const input = message('duplicate', { sender_name: 'Original' });
    const results = await Promise.all([store.enqueueMany([input], FLOW), other.enqueueMany([input], FLOW)]);
    assert.equal(results.reduce((sum, item) => sum + item.inserted, 0), 1);
    await other.enqueueMany([message('duplicate', { message_text: 'Changed', sender_name: 'Changed' })], FLOW);
    assert.equal((await store.getMessage('duplicate')).sender_name, 'Original');
    assert.equal((await store.listConversationMessages(input.sender_phone)).total, 1);
    await store.enqueueMany([message('old', { request_lead_workflow: false })]);
    await store.enqueueMany([message('old')], FLOW);
    assert.equal((await store.getMessage('old')).processing_flow, null);
    assert.equal(await store.getLeadExtraction('old'), null);
  });

  dbTest('retains unparsed text and terminal error in a collecting draft atomically', async ({ store }) => {
    await nextTurn(store, 'failed-details', details({ errorCode: 'AI_MALFORMED_RESPONSE', errorStage: 'schema',
      originalMessage: 'Details that must survive an unavailable AI provider.', replyText: 'Details retained. Please continue.' }));
    assert.equal((await store.getActiveLeadSession('+971501234567')).original_message, 'Details that must survive an unavailable AI provider.');
    assert.equal((await store.getLeadExtraction('failed-details')).processing_status, 'FAILED');
    assert.equal((await store.getMessage('failed-details')).error_message, 'AI_MALFORMED_RESPONSE');
    assert.equal((await store.getReply('failed-details')).text, 'Details retained. Please continue.');
    assert.equal((await store.listLeads()).total, 0);
    assert.equal(await store.claimLeadExtraction(), null);
  });

  dbTest('orders boss replies and supports media replies without claiming customer work', async ({ store }) => {
    await nextTurn(store, 'z-image', { kind: 'media_error', replyText: 'Please resend image' },
      { message_type: 'image', message_text: '', media_id: 'media-1' });
    await nextTurn(store, 'a-audio', { kind: 'media_error', replyText: 'Please resend voice' },
      { message_type: 'audio', message_text: '', media_id: 'media-2' });
    assert.equal(await store.claimReply(FLOW), null);
    const reply = await store.claimReply(BOSS_FLOW);
    assert.equal(reply.message_id, 'z-image');
    assert.equal(await store.claimReply(BOSS_FLOW), null);
    assert.equal(await store.finishReply(reply.id, reply.lease_token, { status: 'SENT', provider_message_id: 'provider-1' }), true);
    const history = (await store.listConversationMessages('+971501234567')).items;
    const incoming = history.find(row => row.message_id === 'z-image' && row.direction === 'incoming');
    const outgoing = history.find(row => row.message_id === 'z-image' && row.direction === 'outgoing');
    assert.equal(incoming.whatsapp_message_id, 'z-image');
    assert.equal(incoming.in_reply_to_message_id, null);
    assert.equal(outgoing.whatsapp_message_id, 'provider-1');
    assert.equal(outgoing.in_reply_to_message_id, 'z-image');
    assert.equal((await store.claimReply(BOSS_FLOW)).message_id, 'a-audio');
  });

  dbTest('lists simple conversations and complete paginated text/media history with safe literal search', async ({ store }) => {
    await nextTurn(store, 'hi', { kind: 'greeting', replyText: 'Hi Boss' }, { message_text: 'Hi', sender_name: 'Boss 100%_!' });
    await nextTurn(store, 'voice', { kind: 'media_error', replyText: 'Voice received' }, { message_type: 'audio', message_text: '', media_id: 'voice-1' });
    await store.enqueueMany([message('customer', { sender_phone: '+971500000002', request_lead_workflow: false, sender_name: 'Customer' })], FLOW);
    const conversations = await store.listConversations();
    assert.equal(conversations.total, 2);
    assert.equal((await store.listConversations({ search: '100%_!' })).total, 1);
    assert.equal((await store.listConversations({ search: "' OR 1=1 --" })).total, 0);
    const conversation = await store.getConversation('+971501234567');
    assert.equal(conversation.type, 'boss_lead');
    assert.equal(conversation.sender_name, 'Boss 100%_!');
    assert.equal(conversation.last_message, 'Voice received');
    const history = await store.listConversationMessages(conversation.id, { pageSize: 2 });
    assert.equal(history.total, 4);
    assert.equal(history.totalPages, 2);
    assert.deepEqual(history.items.map(row => row.text), ['Hi', 'Hi Boss']);
    assert.equal((await store.listConversationMessages(conversation.id, { pageSize: 2, page: 2 })).items[0].message_type, 'audio');
    for (const invalid of [{ page: 0 }, { pageSize: 201 }]) await assert.rejects(store.listConversationMessages(conversation.id, invalid));
    assert.equal(await store.getConversation('+971511111111'), null);
    await store.driver.query('ALTER TABLE whatsapp_messages ADD COLUMN private_marker TEXT');
    assert.equal('private_marker' in (await store.listConversationMessages(conversation.id)).items[0], false);
  });

  dbTest('legacy completion still supports old dashboard lead records', async ({ store }) => {
    await store.enqueueMany([message('legacy-compatible')], FLOW);
    const job = await store.claimLeadExtraction();
    assert.equal(await store.completeLeadWorkflow(job.message_id, job.lease_token, { result: result(), validation: VALID, replyText: CONFIRMATION }), true);
    assert.equal((await store.listLeads()).total, 1);
    assert.equal((await store.getLeadStats()).valid, 1);
  });

  dbTest('confirms queued pre-upgrade placeholders without replacing populated historical lead data', async ({ store }) => {
    await store.enqueueMany([message('old-queued')], FLOW);
    const placeholderId = randomUUID();
    await store.driver.query(`INSERT INTO leads(id,whatsapp_message_id,sender_phone,original_message,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`, [placeholderId, 'old-queued', '+971501234567', 'Original queued text', ago(1000), ago(1000)]);
    const oldJob = await store.claimLeadExtraction();
    assert.equal(await turn(store, oldJob, details({ state: 'awaiting_confirmation' })), true);
    const session = await store.getActiveLeadSession('+971501234567');
    await nextTurn(store, 'confirm-old', { sessionId: session.id, state: 'completed', kind: 'confirmation', replyText: 'Saved' });
    assert.equal((await store.listLeads()).total, 1);
    assert.equal((await store.getLead(placeholderId)).company_name, 'Synthetic company');
    assert.equal((await store.getLead(placeholderId)).zoho_status, 'not_started');

    await store.enqueueMany([message('protected')], FLOW);
    await store.driver.query(`INSERT INTO leads(id,whatsapp_message_id,sender_phone,original_message,company_name,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`, [randomUUID(), 'protected', '+971501234567', 'Protected text', 'Saved historical company', ago(1000), ago(1000)]);
    assert.equal(await turn(store, await store.claimLeadExtraction(), details({ state: 'awaiting_confirmation' })), true);
    const protectedSession = await store.getActiveLeadSession('+971501234567');
    await store.enqueueMany([message('confirm-protected')], FLOW);
    const confirmation = await store.claimLeadExtraction();
    await assert.rejects(turn(store, confirmation, { sessionId: protectedSession.id, state: 'completed', kind: 'confirmation' }), /must not be overwritten/);
    assert.equal((await store.listLeads({ search: 'Saved historical company' })).total, 1);
    assert.deepEqual(await store.getActiveLeadSession('+971501234567'), protectedSession);
  });
}
contract('sqlite');
contract('postgres');

test('sqlite: outbox failure rolls back new draft, inbox and extraction ownership together', async t => {
  const { store } = await fixture(t, 'sqlite');
  await store.enqueueMany([message('rollback')], FLOW);
  const job = await store.claimLeadExtraction();
  const before = await store.getLeadExtraction(job.message_id);
  store.driver.db.exec("CREATE TRIGGER reject_session_reply BEFORE INSERT ON reply_outbox BEGIN SELECT RAISE(ABORT,'synthetic outbox failure'); END");
  await assert.rejects(turn(store, job, details({ replyText: 'Ready to save?' })), /synthetic outbox failure/);
  assert.deepEqual(await store.getLeadExtraction(job.message_id), before);
  assert.equal(await store.getActiveLeadSession('+971501234567'), null);
  assert.equal((await store.getMessage(job.message_id)).session_id, null);
  assert.equal((await store.listLeads()).total, 0);
});

test('sqlite: save confirmation outbox failure leaves the existing draft ready and creates no lead', async t => {
  const { store } = await fixture(t, 'sqlite');
  await nextTurn(store, 'draft', details({ state: 'awaiting_confirmation' }));
  const session = await store.getActiveLeadSession('+971501234567');
  await store.enqueueMany([message('confirm')], FLOW);
  const job = await store.claimLeadExtraction();
  store.driver.db.exec("CREATE TRIGGER reject_saved_reply BEFORE INSERT ON reply_outbox BEGIN SELECT RAISE(ABORT,'synthetic outbox failure'); END");
  await assert.rejects(turn(store, job, { sessionId: session.id, state: 'completed', kind: 'confirmation', replyText: 'Saved' }), /synthetic outbox failure/);
  assert.deepEqual(await store.getActiveLeadSession('+971501234567'), session);
  assert.equal((await store.listLeads()).total, 0);
  assert.equal((await store.getLeadExtraction(job.message_id)).lease_token, job.lease_token);
});

test('sqlite: discard outbox failure rolls back closure and new draft while retaining checkpointed media', async t => {
  const { store } = await fixture(t, 'sqlite');
  await nextTurn(store, 'draft', details());
  const draft = await store.getActiveLeadSession('+971501234567');
  await nextTurn(store, 'new-lead', { sessionId: draft.id, kind: 'new_lead', pendingAction: 'new_lead' });
  const pending = await store.getActiveLeadSession('+971501234567');
  await store.enqueueMany([message('discard', { message_type: 'audio', message_text: '', media_id: 'voice-discard' })], FLOW);
  const job = await store.claimLeadExtraction();
  assert.equal(await store.checkpointLeadMedia(job.message_id, job.lease_token, { transcription: 'Discard it' }), true);
  store.driver.db.exec("CREATE TRIGGER reject_discard_reply BEFORE INSERT ON reply_outbox BEGIN SELECT RAISE(ABORT,'synthetic outbox failure'); END");
  await assert.rejects(turn(store, job, { sessionId: draft.id, state: 'discarded', kind: 'discard', startNewSession: true,
    transcription: 'Changed in failed transaction', replyText: 'Ready for another lead.' }), /synthetic outbox failure/);
  assert.deepEqual(await store.getActiveLeadSession('+971501234567'), pending);
  assert.equal((await store.getConversation('+971501234567')).archived_sessions.length, 0);
  assert.equal((await store.driver.query('SELECT id FROM lead_sessions')).rowCount, 1);
  assert.equal((await store.getLeadExtraction(job.message_id)).lease_token, job.lease_token);
  assert.equal((await store.getMessage(job.message_id)).transcription, 'Discard it');
  assert.equal((await store.getMessage(job.message_id)).session_id, null);
  assert.equal((await store.listLeads()).total, 0);
});
