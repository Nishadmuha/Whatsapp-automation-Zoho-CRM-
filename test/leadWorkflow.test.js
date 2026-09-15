'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMessageStore } = require('../src/database');
const { createBossLeadWorkflow } = require('../src/services/leads/bossLeadWorkflow');
const { createLeadExtractor } = require('../src/services/leads/leadExtractor');
const { validateLeadBusiness } = require('../src/services/leads/leadValidator');
const { conversationIntent, GREETING_REPLY, CONFIRMATION_REPLY, SAVED_REPLY } = require('../src/services/leads/bossConversation');
const { LEAD_FIELDS } = require('../src/services/ai/leadExtraction');
const { temporaryStore, incoming } = require('./helpers');

const BOSS = '+971551234567';
const CUSTOMER = '+971561234567';
const PARTS = ['Al Noor Contracting', 'Ahmed, +971501234567', 'Need 2 MDB and 4 SMDB for DIP'];
const TEXT = PARTS.join('\n');
const enquiry = (values = {}, isLead = true) => ({ is_lead: isLead,
  lead: { ...Object.fromEntries(LEAD_FIELDS.map(field => [field, null])), ...values } });
const result = () => enquiry({ company_name: 'Al Noor Contracting', contact_name: 'Ahmed', phone: '+971501234567',
  requirement: PARTS[2], product_or_service: 'MDB', project_location: 'DIP' });
const aiError = (code, retryable = false) => Object.assign(new Error('synthetic-private-provider-payload'), { code, retryable });

async function setup(t, { extract, send, config: overrides = {}, mediaText, mediaMimeTypes = {} } = {}) {
  const { store, databaseUrl } = await temporaryStore(t);
  const config = { enabled: true, aiProvider: 'openai', bossSenders: new Set([BOSS]), allowedSenders: new Set(),
    leaseMs: 30000, maxAttempts: 3, ...overrides };
  const calls = [], sends = [], logs = [], mediaCalls = [], downloads = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, record => logs.push(record)]));
  const ai = { async extractLeadEnquiry(text) { calls.push(text); return extract ? extract(text) : result(); },
    async extractMediaText({ type }) { mediaCalls.push(type); if (mediaText) return typeof mediaText === 'string' ? mediaText : mediaText[type]; throw aiError('AI_REQUEST_FAILED'); },
    generateReply() { assert.fail('Boss messages cannot invoke the customer conversation service.'); },
    extractLead() { assert.fail('Boss messages cannot invoke the legacy CRM extractor.'); } };
  const whatsapp = {
    async downloadMedia(id) { downloads.push(id); return { buffer: Buffer.from('mock media'), mimeType: mediaMimeTypes[id] || 'image/jpeg' }; },
    async sendTextMessage(to, text) { sends.push({ to, text }); return send ? send(to, text)
      : { messages: [{ id: 'wamid.mock-' + sends.length }] }; },
  };
  const processor = createBossLeadWorkflow({ store, ai, whatsapp, config, logger });
  const h = { store, databaseUrl, config, processor, calls, sends, logs, downloads, mediaCalls,
    createProcessor: (targetStore = store) => createBossLeadWorkflow({ store: targetStore, ai, whatsapp, config, logger }),
    session: () => store.getActiveLeadSession(BOSS),
    async enqueue(text = TEXT, overrides = {}) {
      const message = incoming({ sender_phone: BOSS, message_text: text, request_lead_workflow: true, ...overrides });
      await store.enqueueMany([message], { processingFlow: 'conversation' });
      return message;
    },
    async process() {
      const job = await store.claimLeadExtraction({ leaseMs: config.leaseMs, maxAttempts: config.maxAttempts });
      if (job) await processor.processIncomingWhatsAppMessage(job);
      return job;
    },
    async turn(text, overrides) { const message = await h.enqueue(text, overrides); await h.process(); return message; },
    async retry(id) { await store.driver.query('UPDATE lead_extractions SET next_attempt_at=? WHERE message_id=?',
      [new Date(Date.now() - 1000).toISOString(), id]); },
  };
  return h;
}

test('every individual lead field is optional while schema validation and factual grounding remain enforced', async () => {
  for (const field of LEAD_FIELDS) {
    const validation = validateLeadBusiness(enquiry({ [field]: 'Available fact' }));
    assert.equal(validation.valid, true, field);
    assert.deepEqual(validation.missing_fields, [], field);
  }
  assert.equal(validateLeadBusiness(enquiry()).valid, false, 'An empty draft is not meaningful lead information.');
  assert.equal(validateLeadBusiness(enquiry({ contact_name: '  ' })).valid, false);
  assert.equal(validateLeadBusiness(enquiry({ contact_name: 'Ahmed' }, false)).valid, false);
  assert.equal(validateLeadBusiness({ is_lead: true, lead: { contact_name: 42 } }).valid, false);
  let calls = 0;
  const extractor = createLeadExtractor({ ai: { async extractLeadEnquiry() { calls++; return result(); } } });
  assert.deepEqual(await extractor.extract('Need MDB'), enquiry({ product_or_service: 'MDB' }));
  await assert.rejects(extractor.extract('x'.repeat(16385)), { code: 'AI_INPUT_INVALID' });
  assert.equal(calls, 1);
});

test('whole-message intent detection never treats mixed confirmation and details as save consent', () => {
  for (const text of ['Hi', 'Hello!', 'Hey 👋', 'Good morning', 'Good afternoon', 'Good evening', 'Hi Boss']) assert.equal(conversationIntent(text), 'greeting');
  for (const text of ['Yes', 'Yes save', 'Save', 'Save it', 'Complete', 'Confirm', 'Confirmed', 'Okay, save', 'Looks good', 'Proceed', 'Proceed with saving']) assert.equal(conversationIntent(text), 'confirmation');
  for (const text of ['No', 'Not yet', "I'll send more", 'No need', 'Wait', 'One moment', 'Need to add more', 'More details']) assert.equal(conversationIntent(text), 'defer');
  for (const text of ['Thanks', 'Okay', 'Sure']) assert.equal(conversationIntent(text), 'conversation');
  for (const text of ['Yes, add 2 MDB', 'No, the company is Al Noor', 'Hi Ahmed needs MDB',
    'No, add the project location as DIP.', 'Also TRN is 104249196700003 and quantity is 5.',
    'Contact person is Ahmed. Phone is +971501234567', 'Quantity is 10', 'Add Ahmed as contact',
    'Proceed with saving and change quantity to 10']) assert.equal(conversationIntent(text), 'details');
});

test('greetings and conversation messages are stored and answered without extraction or creating a lead session', async t => {
  const h = await setup(t);
  for (const text of ['Hi', 'Hello', 'Hey', 'Good morning', 'Good afternoon', 'Good evening', 'Thanks', 'Okay', 'Wait', 'One moment', 'Yes', 'No']) {
    const message = await h.turn(text);
    assert.equal((await h.store.getMessage(message.whatsapp_message_id)).message_text, text);
    assert.ok(await h.store.getReply(message.whatsapp_message_id));
    assert.equal(await h.session(), null);
  }
  assert.equal(h.calls.length, 0);
  assert.equal((await h.store.listLeads()).total, 0);
});

test('example accumulates one draft, waits for explicit consent, saves once and starts a new draft afterwards', async t => {
  const h = await setup(t, { extract: text => text === 'Another Company' ? enquiry({ company_name: text }) : result() });
  const greeting = await h.turn('Hi');
  assert.equal((await h.store.getReply(greeting.whatsapp_message_id)).text, GREETING_REPLY);
  let id;
  for (const part of PARTS) {
    const message = await h.turn(part);
    const session = await h.session();
    id ||= session.id;
    assert.equal(session.id, id);
    assert.equal(session.state, 'awaiting_confirmation');
    assert.equal((await h.store.getReply(message.whatsapp_message_id)).text, CONFIRMATION_REPLY);
    assert.equal((await h.store.listLeads()).total, 0);
  }
  const ready = await h.session();
  assert.equal(ready.state, 'awaiting_confirmation');
  assert.equal(ready.original_message, TEXT);
  assert.deepEqual(h.calls, PARTS);
  assert.equal(ready.result.lead.phone, '+971501234567');
  assert.equal(await h.store.claimNext({ processingFlow: 'conversation' }), null);
  const confirmation = await h.turn('Yes');
  assert.equal(await h.session(), null);
  const leads = await h.store.listLeads();
  assert.equal(leads.total, 1);
  assert.equal(leads.items[0].original_message, TEXT);
  assert.equal(leads.items[0].company_name, 'Al Noor Contracting');
  assert.equal(leads.items[0].zoho_status, 'not_started');
  assert.equal(leads.items[0].zoho_lead_id, null);
  assert.equal((await h.store.getReply(confirmation.whatsapp_message_id)).text, SAVED_REPLY);
  assert.equal(h.sends.length, 0);
  await h.turn('Yes');
  assert.equal((await h.store.listLeads()).total, 1);
  await h.turn('Another Company');
  assert.notEqual((await h.session()).id, id);
  assert.equal((await h.session()).original_message, 'Another Company');
});

test('a greeting preserves both collecting and awaiting-confirmation states and excludes chatter from lead data', async t => {
  const h = await setup(t);
  await h.turn(PARTS[0]);
  for (const text of ['Hi', 'Thanks', 'Okay']) {
    const before = await h.session();
    await h.turn(text);
    const after = await h.session();
    for (const key of ['id', 'state', 'result', 'original_message']) assert.deepEqual(after[key], before[key]);
  }
  await h.turn(PARTS[2]);
  const before = await h.session();
  const message = await h.turn('Hello');
  const after = await h.session();
  assert.equal(after.state, 'awaiting_confirmation');
  assert.equal(after.id, before.id);
  assert.equal(after.original_message, before.original_message);
  assert.equal((await h.store.getReply(message.whatsapp_message_id)).text, GREETING_REPLY);
  await h.turn('Not yet');
  const collecting = await h.session();
  await h.turn('Good morning');
  const preserved = await h.session();
  assert.equal(preserved.state, 'collecting');
  for (const key of ['id', 'state', 'result', 'original_message']) assert.deepEqual(preserved[key], collecting[key]);
  assert.equal(h.calls.length, 2);
});

test('all deferrals keep the same facts open and a later explicit Yes saves that available draft', async t => {
  for (const text of ['No', 'Not yet', "I'll send more", 'No need', 'Wait', 'Need to add more', 'More details']) {
    const h = await setup(t, { extract: () => enquiry({ contact_name: 'Ahmed' }) });
    await h.turn('Ahmed');
    const before = await h.session();
    await h.turn(text);
    assert.equal((await h.session()).state, 'collecting');
    assert.equal((await h.session()).id, before.id);
    assert.deepEqual((await h.session()).result, before.result);
    assert.equal((await h.session()).original_message, before.original_message);
    assert.equal(h.calls.length, 1, 'A deferral cannot be extracted as new lead information.');
    assert.equal((await h.store.listLeads()).total, 0);
    const confirmation = await h.turn('Yes');
    assert.equal(await h.session(), null);
    const leads = await h.store.listLeads();
    assert.equal(leads.total, 1);
    for (const field of LEAD_FIELDS) assert.deepEqual(leads.items[0][field], before.result.lead[field]);
    assert.equal((await h.store.getReply(confirmation.whatsapp_message_id)).text, SAVED_REPLY);
    assert.equal(h.calls.length, 1);
  }
});

test('more information after a deferral merges into the retained draft and asks confirmation again without saving', async t => {
  for (const text of ['No', 'Not yet', "I'll send more"]) {
    const updates = [enquiry({ contact_name: 'Ahmed' }), enquiry({ address: 'Business Bay, Dubai' })];
    const h = await setup(t, { extract: () => updates.shift() });
    await h.turn('Ahmed');
    const before = await h.session();
    await h.turn(text);
    const message = await h.turn('Company address is Business Bay, Dubai');
    assert.equal((await h.store.listLeads()).total, 0);
    assert.equal((await h.session()).id, before.id);
    assert.equal((await h.session()).state, 'awaiting_confirmation');
    assert.equal((await h.session()).result.lead.contact_name, 'Ahmed');
    assert.equal((await h.session()).result.lead.address, 'Business Bay, Dubai');
    assert.equal((await h.store.getReply(message.whatsapp_message_id)).text, CONFIRMATION_REPLY);
    await h.turn('Okay, save');
    assert.equal((await h.store.listLeads()).total, 1);
  }
});

test('duplicate receipts and competing workers cannot duplicate extraction, a name-only draft, lead or confirmations', async t => {
  const h = await setup(t, { extract: () => enquiry({ contact_name: 'Ahmed' }) });
  const message = await h.enqueue('Ahmed');
  await Promise.all(Array.from({ length: 5 }, () => h.store.enqueueMany([message], { processingFlow: 'conversation' })));
  await Promise.all(Array.from({ length: 5 }, () => h.process()));
  const confirm = await h.enqueue('Save it');
  await h.store.enqueueMany([confirm], { processingFlow: 'conversation' });
  await Promise.all(Array.from({ length: 5 }, () => h.process()));
  for (let i = 0; i < 5; i++) await h.processor.processNextReply();
  assert.equal(h.calls.length, 1);
  assert.equal(h.sends.length, 2);
  assert.equal((await h.store.listLeads()).total, 1);
  assert.equal(await h.process(), null);
});

test('company, email, phone, screenshot and later additions merge and re-confirm without a requirement until save resets the draft', async t => {
  const turns = [
    { text: 'GLOW POWER', fields: { company_name: 'GLOW POWER' } },
    { text: 'procurement@glowpower.com', fields: { email: 'procurement@glowpower.com' } },
    { text: '+971501234567', fields: { phone: '+971501234567' } },
    { text: '', media: { message_type: 'image', media_id: '77777', media_mime_type: 'image/jpeg' }, fields: { trn_no: '104249196700003' } },
    { text: 'Company address is Business Bay, Dubai', fields: { address: 'Business Bay, Dubai' } },
    { text: 'Quantity is 5', fields: { quantity: '5' } },
  ];
  const updates = turns.map(turn => enquiry(turn.fields));
  updates.push(enquiry({ contact_name: 'Ahmed' }));
  const h = await setup(t, { mediaText: 'TRN is 104249196700003', extract: () => updates.shift() });
  const known = {};
  let sessionId;
  for (const turn of turns) {
    Object.assign(known, turn.fields);
    const message = await h.turn(turn.text, turn.media);
    const draft = await h.session();
    sessionId ||= draft.id;
    assert.equal(draft.id, sessionId);
    assert.equal(draft.state, 'awaiting_confirmation');
    assert.deepEqual(draft.result, enquiry(known));
    assert.equal(draft.result.lead.requirement, null);
    assert.equal(draft.result.lead.product_or_service, null);
    assert.equal((await h.store.getReply(message.whatsapp_message_id)).text, CONFIRMATION_REPLY);
    assert.equal((await h.store.listLeads()).total, 0);
  }
  await h.turn('Yes');
  assert.equal(await h.session(), null);
  const saved = (await h.store.listLeads()).items[0];
  for (const field of LEAD_FIELDS) assert.equal(saved[field], known[field] ?? null, field);
  const next = await h.turn('Ahmed');
  const draft = await h.session();
  assert.notEqual(draft.id, sessionId);
  assert.equal(draft.original_message, 'Ahmed');
  assert.deepEqual(draft.result, enquiry({ contact_name: 'Ahmed' }));
  assert.equal((await h.store.getReply(next.whatsapp_message_id)).text, CONFIRMATION_REPLY);
  await h.turn('Save');
  assert.equal((await h.store.listLeads()).total, 2);
  assert.equal(await h.session(), null);
  assert.equal(h.calls.length, turns.length + 1);
});

test('permanent extraction errors retain original draft details with sanitized diagnostics and no saved claim', async t => {
  for (const value of [null, aiError('AI_AUTHENTICATION_ERROR'), aiError('AI_RATE_LIMIT')]) {
    const h = await setup(t, { extract: () => { if (value) throw value; return value; } });
    const message = await h.turn(TEXT);
    assert.equal((await h.session()).state, 'collecting');
    assert.equal((await h.session()).original_message, TEXT);
    assert.equal((await h.store.getLeadExtraction(message.whatsapp_message_id)).processing_status, 'FAILED');
    assert.equal((await h.store.listLeads()).total, 0);
    assert.equal((await h.store.getReply(message.whatsapp_message_id)).text.includes('saved'), false);
    assert.equal(JSON.stringify(h.logs).includes('synthetic-private'), false);
    await h.turn('Yes');
    assert.equal((await h.store.listLeads()).total, 0);
  }
});

test('explicit confirmation after a failed addition saves only the previously available facts without inventing the unread addition', async t => {
  let attempts = 0;
  const h = await setup(t, { extract: () => {
    if (++attempts > 1) throw aiError('AI_AUTHENTICATION_ERROR');
    return enquiry({ contact_name: 'Ahmed' });
  } });
  await h.turn('Ahmed');
  const before = await h.session();
  const failed = await h.turn('Phone is +971501234567');
  const retained = await h.session();
  assert.equal(retained.id, before.id);
  assert.equal(retained.state, 'collecting');
  assert.deepEqual(retained.result, before.result);
  assert.equal((await h.store.getLeadExtraction(failed.whatsapp_message_id)).processing_status, 'FAILED');
  assert.equal((await h.store.listLeads()).total, 0);
  const confirmation = await h.turn('Yes');
  const leads = await h.store.listLeads();
  assert.equal(leads.total, 1);
  for (const field of LEAD_FIELDS) assert.deepEqual(leads.items[0][field], retained.result.lead[field]);
  assert.equal(leads.items[0].phone, null);
  assert.equal(leads.items[0].original_message, retained.original_message);
  assert.ok((await h.store.getReply(confirmation.whatsapp_message_id)).text.toLowerCase().includes('lead saved'));
  assert.equal(await h.session(), null);
  assert.equal(h.calls.length, 2);
});

test('transient failures retry durably before later same-boss messages and never append twice', async t => {
  let attempts = 0;
  const h = await setup(t, { extract: () => { if (++attempts === 1) throw aiError('AI_TIMEOUT', true); return result(); } });
  const first = await h.enqueue(PARTS[0]);
  await h.enqueue(PARTS[2]);
  await h.process();
  assert.equal(await h.store.getReply(first.whatsapp_message_id), null);
  assert.equal(await h.process(), null);
  await h.retry(first.whatsapp_message_id);
  await h.process();
  await h.process();
  assert.equal((await h.session()).original_message, PARTS[0] + '\n' + PARTS[2]);
  assert.equal((await h.session()).state, 'awaiting_confirmation');
});

test('database completion failures cannot claim saving and lost acknowledgements cannot duplicate the lead', async t => {
  for (const afterCommit of [false, true]) {
    const h = await setup(t);
    await h.turn(TEXT);
    const commit = h.store.completeLeadSessionTurn.bind(h.store);
    h.store.completeLeadSessionTurn = async (...args) => { if (afterCommit) await commit(...args); throw new Error('synthetic-private-db'); };
    const message = await h.turn('Yes');
    assert.equal((await h.store.listLeads()).total, afterCommit ? 1 : 0);
    h.store.completeLeadSessionTurn = commit;
    if (!afterCommit) {
      const draft = await h.session();
      assert.ok(draft, 'A failed persistence attempt must retain the active lead.');
      assert.equal(draft.state, 'awaiting_confirmation');
      assert.equal(draft.original_message, TEXT);
      assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
      await h.retry(message.whatsapp_message_id);
      await h.process();
    }
    assert.equal((await h.store.listLeads()).total, 1);
    assert.equal((await h.store.getReply(message.whatsapp_message_id)).text, SAVED_REPLY);
    assert.equal(await h.process(), null);
    assert.equal(JSON.stringify(h.logs).includes('synthetic-private'), false);
  }
});

test('media text joins the same draft and unread media retains only known facts for a later explicit save', async t => {
  const h = await setup(t, { mediaText: PARTS[2] });
  await h.turn(PARTS[0]);
  const id = (await h.session()).id;
  await h.turn('', { message_type: 'image', media_id: '12345', media_mime_type: 'image/jpeg' });
  assert.equal((await h.session()).id, id);
  assert.equal((await h.session()).state, 'awaiting_confirmation');
  const before = await h.session();
  await h.turn('', { message_type: 'video', media_id: '67890' });
  assert.equal((await h.session()).id, id);
  assert.equal((await h.session()).state, 'collecting');
  await h.turn('Yes');
  const leads = await h.store.listLeads();
  assert.equal(leads.total, 1);
  for (const field of LEAD_FIELDS) assert.deepEqual(leads.items[0][field], before.result.lead[field]);
  assert.equal(await h.session(), null);
});

test('authorization and master-switch changes fence pending extraction and outbound replies', async t => {
  for (const stop of ['boss', 'allowlist', 'lease', 'master']) {
    let finish, started;
    const ready = new Promise(resolve => { started = resolve; });
    const h = await setup(t, { extract: () => { started(); return new Promise(resolve => { finish = resolve; }); } });
    const message = await h.enqueue();
    const processing = h.process();
    await ready;
    if (stop === 'boss') h.config.bossSenders.clear();
    if (stop === 'allowlist') h.config.allowedSenders.add(CUSTOMER);
    if (stop === 'master') h.config.enabled = false;
    if (stop === 'lease') await h.store.driver.query('UPDATE lead_extractions SET lease_token=? WHERE message_id=?', ['replacement', message.whatsapp_message_id]);
    finish(result());
    await processing;
    assert.equal(await h.session(), null);
    assert.equal((await h.store.listLeads()).total, 0);
    assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
    assert.equal(h.sends.length, 0);
  }
  for (const stop of ['boss', 'allowlist', 'master']) {
    const h = await setup(t);
    const message = await h.turn('Hi');
    if (stop === 'boss') h.config.bossSenders.clear();
    if (stop === 'allowlist') h.config.allowedSenders.add(CUSTOMER);
    if (stop === 'master') h.config.enabled = false;
    await h.processor.processNextReply();
    assert.equal(h.sends.length, 0);
    assert.equal((await h.store.getReply(message.whatsapp_message_id)).status, stop === 'master' ? 'PENDING' : 'FAILED');
  }
});

test('failed or uncertain WhatsApp sends keep confirmed lead saved without authorizing retries', async t => {
  for (const deliveryState of ['NOT_ATTEMPTED', 'ATTEMPTED_FAILED', 'UNKNOWN']) {
    const h = await setup(t, { send: () => { throw Object.assign(new Error('private-provider-data'), { deliveryState }); } });
    await h.turn(TEXT);
    await h.processor.processNextReply();
    const confirmation = await h.turn('Confirmed');
    await h.processor.processNextReply();
    assert.equal((await h.store.listLeads()).total, 1);
    assert.equal((await h.store.getReply(confirmation.whatsapp_message_id)).status, deliveryState === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED');
    assert.equal(await h.processor.processNextReply(), false);
    assert.equal(h.sends.length, 2);
  }
});

test('company, email, phone, requirement and location deltas preserve all known values when later fields are null', async t => {
  const company = 'GLOW POWER EQUIPMENT RENTAL LLC';
  const email = 'procurement@glowpowerrental.com';
  const updates = [enquiry({ company_name: company }), enquiry({ email }), enquiry({ phone: '+971501234567' }),
    enquiry({ requirement: 'Need quotation for 2 generators', product_or_service: 'generators', quantity: '2' }),
    enquiry({ project_location: 'Dubai' })];
  const h = await setup(t, { extract: () => updates.shift() });
  let id;
  for (const text of ['Company is ' + company, 'Email ' + email, '+971501234567', 'Need quotation for 2 generators', 'Project in Dubai']) {
    const message = await h.turn(text);
    const draft = await h.session();
    id ||= draft.id;
    assert.equal(draft.id, id);
    assert.equal(draft.result.lead.company_name, company);
    assert.equal((await h.store.listLeads()).total, 0);
    assert.equal(draft.state, 'awaiting_confirmation');
    assert.equal((await h.store.getReply(message.whatsapp_message_id)).text, CONFIRMATION_REPLY);
  }
  const draft = await h.session();
  assert.equal(draft.result.lead.email, email);
  assert.equal(draft.result.lead.phone, '+971501234567');
  assert.equal(draft.result.lead.quantity, '2');
  assert.equal(draft.result.lead.project_location, 'Dubai');
  assert.equal(draft.state, 'awaiting_confirmation');
  await h.turn('Looks good');
  assert.equal(await h.session(), null);
  const saved = (await h.store.listLeads()).items[0];
  for (const field of LEAD_FIELDS) assert.deepEqual(saved[field], draft.result.lead[field]);
});

test('screenshot-only lead confirms and saves readable fields with null requirements and retained original media history', async t => {
  const card = {
    company_name: 'GLOW POWER EQUIPMENT RENTAL LLC',
    address: 'P.O. Box 117543, Business Bay, Empire Heights A, Office 9F-A-04-45, Dubai, UAE',
    trn_no: '104249196700003', email: 'procurement@glowpowerrental.com',
  };
  const raw = 'Company Name: ' + card.company_name + '\nAddress: ' + card.address + '\nTRN No.: ' + card.trn_no + '\nEmail ID: ' + card.email + '\nLicense: ABC-123';
  const h = await setup(t, { mediaText: raw, extract: () => enquiry(card) });
  const message = await h.turn('', { message_type: 'image', media_id: '12345', media_mime_type: 'image/jpeg' });
  const session = await h.session();
  assert.equal(session.state, 'awaiting_confirmation');
  for (const [key, value] of Object.entries(card)) assert.equal(session.result.lead[key], value);
  assert.equal(session.result.lead.phone, null);
  assert.equal(session.result.lead.requirement, null);
  const stored = await h.store.getMessage(message.whatsapp_message_id);
  assert.equal(stored.message_text, '');
  assert.equal(stored.extracted_text, raw);
  assert.equal(stored.media_id, '12345');
  assert.equal(stored.transcription, null);
  assert.equal((await h.store.getReply(message.whatsapp_message_id)).text, CONFIRMATION_REPLY);
  assert.equal((await h.store.listLeads()).total, 0);
  assert.equal((await h.store.listConversationMessages(BOSS)).items.find(row => row.direction === 'incoming').extracted_text, raw);
  const confirmation = await h.turn('Save it');
  assert.equal(await h.session(), null);
  const leads = await h.store.listLeads();
  assert.equal(leads.total, 1);
  for (const field of LEAD_FIELDS) assert.deepEqual(leads.items[0][field], session.result.lead[field]);
  assert.equal(leads.items[0].original_message, raw);
  assert.ok((await h.store.getReply(confirmation.whatsapp_message_id)).text.toLowerCase().includes('lead saved'));
  const history = await h.store.getMessage(message.whatsapp_message_id);
  assert.equal(history.media_id, '12345');
  assert.equal(history.message_text, '');
  assert.equal(history.extracted_text, raw);
  assert.deepEqual(h.downloads, ['12345']);
  assert.deepEqual(h.mediaCalls, ['image']);
});

test('voice-only lead saves the transcribed available name with every missing field null and retains the voice message', async t => {
  const h = await setup(t, { mediaText: 'Ahmed', mediaMimeTypes: { '22222': 'audio/ogg' },
    extract: () => enquiry({ contact_name: 'Ahmed' }) });
  const message = await h.turn('', { message_type: 'audio', media_id: '22222', media_mime_type: 'audio/ogg' });
  const draft = await h.session();
  assert.equal(draft.state, 'awaiting_confirmation');
  assert.equal(draft.original_message, 'Ahmed');
  assert.deepEqual(draft.result, enquiry({ contact_name: 'Ahmed' }));
  assert.equal((await h.store.getReply(message.whatsapp_message_id)).text, CONFIRMATION_REPLY);
  assert.equal((await h.store.listLeads()).total, 0);
  await h.turn('Confirmed');
  assert.equal(await h.session(), null);
  const leads = await h.store.listLeads();
  assert.equal(leads.total, 1);
  for (const field of LEAD_FIELDS) assert.deepEqual(leads.items[0][field], draft.result.lead[field]);
  const stored = await h.store.getMessage(message.whatsapp_message_id);
  assert.equal(stored.message_text, '');
  assert.equal(stored.media_id, '22222');
  assert.equal(stored.transcription, 'Ahmed');
  assert.equal(stored.extracted_text, null);
  assert.deepEqual(h.downloads, ['22222']);
  assert.deepEqual(h.mediaCalls, ['audio']);
});

test('voice transcription is checkpointed before extraction retry and merges without another media call', async t => {
  const voice = 'Ahmed, +971501234567. Need quotation for 2 generators in Dubai.';
  let failed = false;
  const h = await setup(t, { mediaText: voice, mediaMimeTypes: { '22222': 'audio/ogg' }, extract: text => {
    if (!text.includes(voice)) return enquiry({ company_name: 'GLOW POWER EQUIPMENT RENTAL LLC' });
    if (!failed) { failed = true; throw aiError('AI_TIMEOUT', true); }
    return enquiry({ contact_name: 'Ahmed', phone: '+971501234567', requirement: 'Need quotation for 2 generators', project_location: 'Dubai' });
  } });
  await h.turn('GLOW POWER EQUIPMENT RENTAL LLC');
  const id = (await h.session()).id;
  const message = await h.turn('', { message_type: 'audio', media_id: '22222', media_mime_type: 'audio/ogg' });
  assert.equal((await h.store.getMessage(message.whatsapp_message_id)).transcription, voice);
  assert.equal(await h.store.getReply(message.whatsapp_message_id), null);
  assert.equal(await h.process(), null);
  await h.retry(message.whatsapp_message_id);
  await h.process();
  const draft = await h.session();
  assert.equal(draft.id, id);
  assert.equal(draft.result.lead.company_name, 'GLOW POWER EQUIPMENT RENTAL LLC');
  assert.equal(draft.result.lead.phone, '+971501234567');
  assert.equal(draft.state, 'awaiting_confirmation');
  assert.equal(draft.original_message.split(voice).length - 1, 1);
  assert.deepEqual(h.downloads, ['22222']);
  assert.deepEqual(h.mediaCalls, ['audio']);
  await h.processor.processNextReply();
  await h.processor.processNextReply();
  assert.equal(h.sends.length, 2);
  assert.equal(await h.processor.processNextReply(), false);
});

test('mixed image, document and voice messages belong to one draft with separate raw media history', async t => {
  const h = await setup(t, { mediaText: { image: 'GLOW POWER EQUIPMENT RENTAL LLC', document: 'Email: procurement@glowpowerrental.com', audio: 'Need 2 generators in Dubai' },
    mediaMimeTypes: { '33333': 'application/pdf', '44444': 'audio/ogg' }, extract: () => enquiry({
      company_name: 'GLOW POWER EQUIPMENT RENTAL LLC', email: 'procurement@glowpowerrental.com', requirement: 'Need 2 generators in Dubai',
    }) });
  const image = await h.turn('', { message_type: 'image', media_id: '11111' });
  const id = (await h.session()).id;
  const document = await h.turn('', { message_type: 'document', media_id: '33333', media_mime_type: 'application/pdf' });
  const audio = await h.turn('', { message_type: 'audio', media_id: '44444', media_mime_type: 'audio/ogg' });
  assert.equal((await h.session()).id, id);
  assert.equal((await h.session()).state, 'awaiting_confirmation');
  assert.equal((await h.store.getMessage(image.whatsapp_message_id)).extracted_text, 'GLOW POWER EQUIPMENT RENTAL LLC');
  assert.equal((await h.store.getMessage(document.whatsapp_message_id)).extracted_text, 'Email: procurement@glowpowerrental.com');
  assert.equal((await h.store.getMessage(audio.whatsapp_message_id)).transcription, 'Need 2 generators in Dubai');
  await h.turn('Yes save');
  assert.equal((await h.store.listLeads()).total, 1);
});

test('new-customer commands never silently discard an open draft, and ambiguous Yes cannot save it', async t => {
  for (const command of ['New lead', 'New customer', 'Next customer', 'Start another lead']) {
    const h = await setup(t);
    await h.turn(TEXT);
    const before = await h.session();
    await h.turn(command);
    await h.turn('Hi');
    await h.turn('Yes');
    const current = await h.session();
    assert.equal(current.id, before.id);
    assert.equal(current.pending_action, 'new_lead');
    assert.equal(current.original_message, before.original_message);
    assert.deepEqual(current.result, before.result);
    assert.equal((await h.store.listLeads()).total, 0);
    assert.equal(h.calls.length, 1);
    await h.turn('Continue');
    assert.equal((await h.session()).pending_action, null);
    await h.turn('Confirmed');
    assert.equal((await h.store.listLeads()).total, 1);
  }
});

test('explicit discard archives the full unsaved draft and starts exactly one clean session', async t => {
  const h = await setup(t);
  await h.turn(PARTS[0]);
  const old = await h.session();
  await h.turn('Next customer');
  const discard = await h.turn('Discard current lead');
  const fresh = await h.session();
  assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.original_message, '');
  assert.equal(fresh.result.is_lead, false);
  assert.equal(fresh.state, 'collecting');
  assert.equal((await h.store.listLeads()).total, 0);
  await h.store.enqueueMany([discard], { processingFlow: 'conversation' });
  assert.equal(await h.process(), null);
  assert.equal((await h.session()).id, fresh.id);
  await h.turn('Yes');
  assert.equal((await h.session()).id, fresh.id);
  assert.equal((await h.session()).state, 'collecting');
  assert.equal((await h.store.listLeads()).total, 0, 'An empty reset draft has no available lead facts to save.');
  const archived = (await h.store.getConversation(BOSS)).archived_sessions;
  assert.equal(archived.length, 1);
  assert.equal(archived[0].id, old.id);
  assert.equal(archived[0].original_message, old.original_message);
  assert.deepEqual(archived[0].result, old.result);
  await h.turn('Different customer');
  assert.equal((await h.session()).id, fresh.id);
  assert.equal((await h.session()).result.lead.company_name, null);
  assert.equal((await h.session()).original_message, 'Different customer');
});

test('explicit confirmation after a deferral saves existing facts and a new lead command creates an empty session', async t => {
  const h = await setup(t);
  await h.turn(TEXT);
  await h.turn('No');
  const confirmation = await h.turn('Yes');
  assert.equal((await h.store.getReply(confirmation.whatsapp_message_id)).text, SAVED_REPLY);
  assert.equal((await h.store.listLeads()).total, 1);
  assert.equal(await h.session(), null);
  await h.turn('New lead');
  assert.equal((await h.session()).original_message, '');
  assert.equal((await h.session()).state, 'collecting');
  assert.equal((await h.store.listLeads()).total, 1);
});

test('a corrected project location survives an unrelated later extraction using older history', async t => {
  const updates = [enquiry({ company_name: 'Al Noor', requirement: 'Need 2 generators', project_location: 'Dubai' }),
    enquiry({ project_location: 'Abu Dhabi' }),
    enquiry({ company_name: 'Al Noor', requirement: 'Need 2 generators', project_location: 'Dubai', contact_name: 'Ahmed' })];
  const h = await setup(t, { extract: () => updates.shift() });
  await h.turn('Al Noor. Need 2 generators. Project in Dubai.');
  const id = (await h.session()).id;
  await h.turn('Correction: project location is Abu Dhabi.');
  await h.turn('The contact is Ahmed.');
  const draft = await h.session();
  assert.equal(draft.id, id);
  assert.equal(draft.result.lead.project_location, 'Abu Dhabi');
  assert.equal(draft.result.lead.contact_name, 'Ahmed');
  assert.equal(draft.state, 'awaiting_confirmation');
  assert.equal((await h.store.listLeads()).total, 0);
  await h.turn('Save it');
  assert.equal((await h.store.listLeads()).items[0].project_location, 'Abu Dhabi');
});

test('separate additional requirements remain in the single saved lead and its original chat history', async t => {
  const updates = [enquiry({ company_name: 'Al Noor', requirement: 'Need 2 generators', product_or_service: 'generators' }),
    enquiry({ requirement: 'Also need 4 switches', product_or_service: 'switches' })];
  const h = await setup(t, { extract: () => updates.shift() });
  const first = await h.turn('Al Noor. Need 2 generators.');
  const second = await h.turn('Also need 4 switches');
  assert.equal((await h.store.getMessage(first.whatsapp_message_id)).session_id,
    (await h.store.getMessage(second.whatsapp_message_id)).session_id);
  await h.turn('Looks good');
  const leads = await h.store.listLeads();
  assert.equal(leads.total, 1);
  assert.equal(leads.items[0].requirement, 'Need 2 generators\nAlso need 4 switches');
  assert.equal(leads.items[0].product_or_service, 'generators\nswitches');
  assert.match(leads.items[0].original_message, /Need 2 generators/);
  assert.match(leads.items[0].original_message, /Also need 4 switches/);
});

test('current-turn provider extraction preserves additions to requirements and notes across turns', async t => {
  const updates = [enquiry({ company_name: 'Al Noor', requirement: 'Need 2 generators' }),
    enquiry({ requirement: 'Also need 4 switches', notes: 'Deliver before noon' }),
    enquiry({ notes: 'Gate 4' })];
  const h = await setup(t, { extract: () => updates.shift() });
  await h.turn('Al Noor\nNeed 2 generators');
  const id = (await h.session()).id;
  await h.turn('Also need 4 switches\nDeliver before noon');
  await h.turn('Gate 4');
  const draft = await h.session();
  assert.equal(draft.id, id);
  assert.equal(draft.result.lead.requirement, 'Need 2 generators\nAlso need 4 switches');
  assert.equal(draft.result.lead.notes, 'Deliver before noon\nGate 4');
  assert.equal(draft.state, 'awaiting_confirmation');
  await h.turn('Save it');
  const saved = (await h.store.listLeads()).items[0];
  assert.equal(saved.requirement, draft.result.lead.requirement);
  assert.equal(saved.notes, draft.result.lead.notes);
});

test('the complete literal GLOW POWER example immediately asks the exact confirmation without a scripted intermediate step', async t => {
  const fields = {
    company_name: 'GLOW POWER EQUIPMENT RENTAL LLC',
    address: 'P.O. Box 117543, Business Bay, Empire Heights A, Office 9F-A-04-45, Dubai, UAE',
    trn_no: '104249196700003', email: 'procurement@glowpowerrental.com',
    requirement: 'quotation for electrical panels', product_or_service: 'electrical panels', quantity: '5',
  };
  const text = 'Company Name: GLOW POWER EQUIPMENT RENTAL LLC\n'
    + 'Address: P.O. Box 117543, Business Bay, Empire Heights A, Office 9F-A-04-45, Dubai, UAE\n'
    + 'TRN No.: 104249196700003\nEmail: procurement@glowpowerrental.com\n'
    + 'Requirement: quotation for electrical panels\nQuantity: 5';
  const h = await setup(t, { extract: () => enquiry(fields) });
  const message = await h.turn(text);
  const draft = await h.session();
  assert.equal(draft.state, 'awaiting_confirmation');
  assert.equal(draft.original_message, text);
  for (const [field, value] of Object.entries(fields)) assert.equal(draft.result.lead[field], value);
  assert.equal((await h.store.getReply(message.whatsapp_message_id)).text,
    'I have the available information for this lead. Is everything complete and ready to save?');
  assert.equal((await h.store.listLeads()).total, 0);
  assert.equal(h.calls.length, 1);
  await h.processor.processNextReply();
  assert.equal(h.sends.length, 1);
  assert.equal(await h.processor.processNextReply(), false);
});

test('any available field subset confirms immediately and saves exactly those facts with all absent fields null', async t => {
  for (const { name, text, fields } of [
    { name: 'name only', text: 'Ahmed', fields: { contact_name: 'Ahmed' } },
    { name: 'company only', text: 'GLOW POWER EQUIPMENT RENTAL LLC', fields: { company_name: 'GLOW POWER EQUIPMENT RENTAL LLC' } },
    { name: 'email only', text: 'procurement@glowpowerrental.com', fields: { email: 'procurement@glowpowerrental.com' } },
    { name: 'phone only', text: '+971501234567', fields: { phone: '+971501234567' } },
    { name: 'company and phone', text: 'GLOW POWER EQUIPMENT RENTAL LLC\n+971501234567',
      fields: { company_name: 'GLOW POWER EQUIPMENT RENTAL LLC', phone: '+971501234567' } },
    { name: 'requirement only', text: 'Need quotation for electrical panels', fields: { requirement: 'Need quotation for electrical panels' } },
    { name: 'product only', text: 'Electrical panels', fields: { product_or_service: 'Electrical panels' } },
    { name: 'address only', text: 'Company address is Business Bay, Dubai', fields: { address: 'Business Bay, Dubai' } },
    { name: 'TRN only', text: 'TRN is 104249196700003', fields: { trn_no: '104249196700003' } },
    { name: 'project only', text: 'Project name is Marina Tower', fields: { project_name: 'Marina Tower' } },
    { name: 'location only', text: 'Project location is DIP', fields: { project_location: 'DIP' } },
    { name: 'quantity only', text: 'Quantity is 5', fields: { quantity: '5' } },
    { name: 'deadline only', text: 'Deadline is next week', fields: { deadline: 'next week' } },
    { name: 'notes only', text: 'Use Gate 4 for delivery', fields: { notes: 'Use Gate 4 for delivery' } },
  ]) {
    await t.test(name, async t => {
      const h = await setup(t, { extract: () => enquiry(fields) });
      const message = await h.turn(text);
      const draft = await h.session();
      assert.equal(draft.state, 'awaiting_confirmation');
      assert.equal(draft.original_message, text);
      assert.deepEqual(draft.result, enquiry(fields));
      assert.deepEqual(draft.validation_result, { valid: true, missing_fields: [], errors: [] });
      assert.equal((await h.store.getReply(message.whatsapp_message_id)).text,
        'I have the available information for this lead. Is everything complete and ready to save?');
      assert.equal((await h.store.listLeads()).total, 0);
      const confirmation = await h.turn('Yes');
      assert.equal(await h.session(), null);
      const leads = await h.store.listLeads();
      assert.equal(leads.total, 1);
      for (const field of LEAD_FIELDS) assert.deepEqual(leads.items[0][field], fields[field] ?? null, field);
      assert.equal(leads.items[0].original_message, text);
      assert.ok(['not_started', 'failed', 'saved'].includes(leads.items[0].zoho_status));
      assert.ok((await h.store.getReply(confirmation.whatsapp_message_id)).text.toLowerCase().includes('lead saved'));
      assert.equal(h.calls.length, 1, 'Saving cannot re-extract or invent missing facts.');
    });
  }
});

test('explicit confirmation saves legacy partial drafts after refreshing obsolete mandatory-field validation', async t => {
  for (const state of ['collecting', 'awaiting_confirmation']) {
    const h = await setup(t, { extract: () => enquiry({ company_name: 'GLOW POWER' }) });
    await h.turn('GLOW POWER');
    const before = await h.session();
    await h.store.driver.query('UPDATE lead_sessions SET state=?,validation_result=? WHERE id=?', [state,
      JSON.stringify({ valid: false, missing_fields: ['requirement'], errors: [] }), before.id]);
    const confirmation = await h.turn('Yes');
    assert.ok((await h.store.getReply(confirmation.whatsapp_message_id)).text.toLowerCase().includes('lead saved'));
    assert.equal(await h.session(), null);
    const leads = await h.store.listLeads();
    assert.equal(leads.total, 1);
    for (const field of LEAD_FIELDS) assert.deepEqual(leads.items[0][field], before.result.lead[field]);
    assert.equal(h.calls.length, 1);
  }
});

test('all orders of company, requirement and contact information merge into one active draft and check readiness after every message', async t => {
  const fragments = [
    { text: 'Company is GLOW POWER EQUIPMENT RENTAL LLC', fields: { company_name: 'GLOW POWER EQUIPMENT RENTAL LLC' } },
    { text: 'Requirement: quotation for electrical panels', fields: { requirement: 'quotation for electrical panels', product_or_service: 'electrical panels' } },
    { text: 'Contact person is Ahmed. Phone is +971501234567', fields: { contact_name: 'Ahmed', phone: '+971501234567' } },
  ];
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const updates = order.map(index => enquiry(fragments[index].fields));
    const h = await setup(t, { extract: () => updates.shift() });
    const known = {}, history = [];
    let sessionId;
    for (const index of order) {
      const fragment = fragments[index];
      Object.assign(known, fragment.fields);
      history.push(fragment.text);
      const message = await h.turn(fragment.text);
      const draft = await h.session();
      sessionId ||= draft.id;
      assert.equal(draft.id, sessionId);
      assert.equal(draft.original_message, history.join('\n'));
      for (const [field, value] of Object.entries(known)) assert.equal(draft.result.lead[field], value);
      assert.equal(draft.state, 'awaiting_confirmation');
      assert.equal((await h.store.getReply(message.whatsapp_message_id)).text,
        'I have the available information for this lead. Is everything complete and ready to save?');
      assert.equal((await h.store.listLeads()).total, 0);
    }
    assert.equal(h.calls.length, 3);
  }
});

test('sequential additional facts and mixed Yes or No with details keep merging and repeat the exact confirmation', async t => {
  const turns = [
    { text: 'GLOW POWER EQUIPMENT RENTAL LLC needs quotation for electrical panels', fields: {
      company_name: 'GLOW POWER EQUIPMENT RENTAL LLC', requirement: 'quotation for electrical panels', product_or_service: 'electrical panels',
    } },
    { text: 'Also TRN is 104249196700003 and quantity is 5.', fields: { trn_no: '104249196700003', quantity: '5' } },
    { text: 'Contact person is Ahmed. Phone is +971501234567', fields: { contact_name: 'Ahmed', phone: '+971501234567' } },
    { text: 'No, add the project location as DIP.', fields: { project_location: 'DIP' } },
    { text: 'Yes, change quantity to 10.', fields: { quantity: '10' } },
    { text: 'Email is procurement@glowpowerrental.com', fields: { email: 'procurement@glowpowerrental.com' } },
  ];
  const updates = turns.map(turn => enquiry(turn.fields));
  const h = await setup(t, { extract: () => updates.shift() });
  const known = {}, messages = [];
  let sessionId;
  for (const turn of turns) {
    Object.assign(known, turn.fields);
    const message = await h.turn(turn.text);
    messages.push(message);
    const draft = await h.session();
    sessionId ||= draft.id;
    assert.equal(draft.id, sessionId);
    assert.equal(draft.state, 'awaiting_confirmation');
    for (const [field, value] of Object.entries(known)) assert.equal(draft.result.lead[field], value);
    assert.equal((await h.store.getReply(message.whatsapp_message_id)).text,
      'I have the available information for this lead. Is everything complete and ready to save?');
    assert.equal((await h.store.listLeads()).total, 0);
  }
  assert.equal((await h.session()).original_message, turns.map(turn => turn.text).join('\n'));
  for (const message of messages) {
    const stored = await h.store.getMessage(message.whatsapp_message_id);
    assert.equal(stored.message_text, message.message_text);
    assert.equal(stored.session_id, sessionId);
  }
  const confirmation = await h.turn('Proceed with saving');
  assert.equal(await h.session(), null);
  const leads = await h.store.listLeads();
  assert.equal(leads.total, 1);
  assert.equal(leads.items[0].quantity, '10');
  assert.equal(leads.items[0].project_location, 'DIP');
  assert.ok((await h.store.getReply(confirmation.whatsapp_message_id)).text.toLowerCase().includes('lead saved'));
  assert.equal(h.calls.length, turns.length, 'Confirmation must not invoke another extraction.');
});

test('every documented explicit confirmation saves a name-only draft and returns success only after persistence', async t => {
  for (const text of ['yes', 'save', 'save it', 'confirmed', 'confirm', 'complete', 'okay save', 'proceed', 'proceed with saving']) {
    const h = await setup(t, { extract: () => enquiry({ contact_name: 'Ahmed' }) });
    await h.turn('Ahmed');
    const message = await h.turn(text);
    assert.equal((await h.store.listLeads()).total, 1, text);
    assert.equal(await h.session(), null, text);
    assert.ok((await h.store.getReply(message.whatsapp_message_id)).text.toLowerCase().includes('lead saved'), text);
    assert.equal(h.calls.length, 1, text);
  }
});

test('concurrent and later replay of the same claimed inbound job makes one extraction decision and at most one outgoing reply', async t => {
  const h = await setup(t);
  const message = await h.enqueue(TEXT);
  const job = await h.store.claimLeadExtraction({ leaseMs: h.config.leaseMs, maxAttempts: h.config.maxAttempts });
  const competing = h.createProcessor();
  await Promise.all(Array.from({ length: 4 }, (_, index) => (index % 2 ? competing : h.processor).processIncomingWhatsAppMessage(job)));
  for (let i = 0; i < 2; i++) await h.processor.processIncomingWhatsAppMessage(job);
  const draft = await h.session();
  assert.equal(draft.original_message, TEXT);
  assert.equal(h.calls.length, 1);
  assert.equal(h.logs.filter(log => log.event === 'boss_conversation_processed').length, 1);
  assert.equal((await h.store.listLeads()).total, 0);
  for (let i = 0; i < 4; i++) await h.processor.processNextReply();
  assert.equal(h.sends.length, 1);
  assert.equal((await h.store.getReply(message.whatsapp_message_id)).status, 'SENT');
});

test('a later session may save identical customer details because customer fields do not define lead identity', async t => {
  const h = await setup(t);
  const sessions = [], messages = [], confirmations = [];
  for (let index = 0; index < 2; index++) {
    await h.turn('Hi');
    assert.equal(await h.session(), null, 'A greeting after a save must not open another lead.');
    const message = await h.turn(TEXT);
    const draft = await h.session();
    messages.push(message);
    sessions.push(draft);
    assert.equal((await h.store.listLeads()).total, index);
    assert.equal(draft.state, 'awaiting_confirmation');
    assert.equal((await h.store.getReply(message.whatsapp_message_id)).text, CONFIRMATION_REPLY);
    const confirmation = await h.turn('Yes');
    confirmations.push(confirmation);
    assert.equal(await h.session(), null);
    assert.equal((await h.store.listLeads()).total, index + 1);
    assert.equal((await h.store.getReply(confirmation.whatsapp_message_id)).text, SAVED_REPLY);
  }
  const leads = (await h.store.listLeads()).items;
  assert.notEqual(sessions[0].id, sessions[1].id);
  assert.notEqual(leads[0].id, leads[1].id);
  assert.notEqual(leads[0].whatsapp_message_id, leads[1].whatsapp_message_id);
  for (const field of LEAD_FIELDS) assert.deepEqual(leads[0][field], leads[1][field], field);
  assert.equal(leads.every(lead => lead.sender_phone === BOSS && lead.original_message === TEXT), true);
  for (let index = 0; index < 2; index++) {
    const saved = leads.find(lead => lead.whatsapp_message_id === messages[index].whatsapp_message_id);
    const closed = (await h.store.driver.query('SELECT state,lead_id,completed_at FROM lead_sessions WHERE id=?', [sessions[index].id])).rows[0];
    assert.equal(closed.state, 'completed');
    assert.equal(closed.lead_id, saved.id);
    assert.ok(closed.completed_at);
    assert.equal((await h.store.getMessage(confirmations[index].whatsapp_message_id)).session_id, sessions[index].id);
  }
  assert.deepEqual(h.calls, [TEXT, TEXT]);
});

test('the same confirmation across workers, duplicate receipts and restart saves once and cannot close a later draft', async t => {
  const h = await setup(t);
  await h.turn(TEXT);
  const draft = await h.session();
  const other = createMessageStore({ databaseUrl: h.databaseUrl, databaseName: h.store.databaseName });
  let reopened;
  try {
    await other.init();
    const competing = h.createProcessor(other);
    const confirmation = await h.enqueue('Yes');
    await Promise.all([h.store.enqueueMany([confirmation], { processingFlow: 'conversation' }),
      other.enqueueMany([confirmation], { processingFlow: 'conversation' })]);
    const job = await h.store.claimLeadExtraction();
    assert.equal(job.message_id, confirmation.whatsapp_message_id);
    await Promise.all(Array.from({ length: 6 }, (_, index) => (index % 2 ? competing : h.processor).processIncomingWhatsAppMessage(job)));
    assert.equal((await h.store.listLeads()).total, 1);
    assert.equal(await h.session(), null);
    assert.equal(h.calls.length, 1, 'Confirmation must not extract the lead again.');
    assert.equal(h.logs.filter(log => log.event === 'boss_lead_saved').length, 1);
    const closed = (await other.driver.query('SELECT state,lead_id,completed_at FROM lead_sessions WHERE id=?', [draft.id])).rows[0];
    assert.equal(closed.state, 'completed');
    assert.ok(closed.completed_at);
    assert.equal(closed.lead_id, (await other.listLeads()).items[0].id);
    assert.equal((await other.getReply(confirmation.whatsapp_message_id)).text, SAVED_REPLY);
    assert.equal((await other.getLeadExtraction(confirmation.whatsapp_message_id)).processing_status, 'SUCCESS');

    await h.turn('Ahmed');
    const nextDraft = await h.session();
    assert.notEqual(nextDraft.id, draft.id);
    assert.deepEqual(nextDraft.result, enquiry({ contact_name: 'Ahmed' }));
    await Promise.all([competing.processIncomingWhatsAppMessage(job), h.processor.processIncomingWhatsAppMessage(job),
      other.enqueueMany([confirmation], { processingFlow: 'conversation' })]);
    assert.deepEqual(await h.session(), nextDraft, 'An old confirmation cannot save or modify a later draft.');
    for (let index = 0; index < 4; index++) await Promise.all([h.processor.processNextReply(), competing.processNextReply()]);
    assert.equal(h.sends.filter(reply => reply.text === SAVED_REPLY).length, 1);
    assert.equal(h.sends.length, 3);
    assert.equal((await other.getReply(confirmation.whatsapp_message_id)).status, 'SENT');

    await h.store.close();
    await other.close();
    reopened = createMessageStore({ databaseUrl: h.databaseUrl, databaseName: h.store.databaseName });
    await reopened.init();
    const restarted = h.createProcessor(reopened);
    await reopened.enqueueMany([confirmation], { processingFlow: 'conversation' });
    assert.equal(await reopened.claimLeadExtraction(), null);
    await restarted.processIncomingWhatsAppMessage(job);
    assert.equal(await restarted.processNextReply(), false);
    assert.equal((await reopened.listLeads()).total, 1);
    assert.deepEqual(await reopened.getActiveLeadSession(BOSS), nextDraft);
    assert.equal(h.sends.filter(reply => reply.text === SAVED_REPLY).length, 1);
    assert.equal(h.logs.filter(log => log.event === 'boss_lead_saved').length, 1);
    const history = (await reopened.listConversationMessages(BOSS)).items;
    const savedReplies = history.filter(row => row.direction === 'outgoing' && row.message_id === confirmation.whatsapp_message_id);
    assert.equal(savedReplies.length, 1);
    assert.equal(savedReplies[0].text, SAVED_REPLY);
    assert.equal(savedReplies[0].session_id, draft.id);
    assert.equal(savedReplies[0].lead_id, closed.lead_id);
  } finally {
    await other.close();
    await reopened?.close();
  }
});

test('latest email is extracted from its own message and merged into the retained Al Noor draft without historical extraction', async t => {
  const email = 'procurement@example.test';
  const h = await setup(t, { mediaText: TEXT,
    extract: text => text.includes('Al Noor Contracting') ? result() : enquiry({ email }) });
  await h.turn('', { message_type: 'image', media_id: '12345', media_mime_type: 'image/jpeg' });
  const draft = await h.session();
  await h.turn('Hi');
  const addition = await h.turn(email);
  const merged = await h.session();
  assert.equal(merged.id, draft.id);
  assert.equal(merged.result.lead.email, email, 'Older context must not cause the provider to omit the latest email.');
  for (const field of LEAD_FIELDS.filter(field => field !== 'email')) assert.deepEqual(merged.result.lead[field], draft.result.lead[field], field);
  assert.equal(merged.original_message, TEXT + '\n' + email);
  assert.deepEqual(h.calls, [TEXT, email]);
  assert.equal((await h.store.getReply(addition.whatsapp_message_id)).text, CONFIRMATION_REPLY);
  assert.equal((await h.store.listLeads()).total, 0);
  const confirmation = await h.turn('Yes');
  const leads = await h.store.listLeads();
  assert.equal(leads.total, 1);
  assert.equal(leads.items[0].email, email);
  assert.equal(leads.items[0].company_name, 'Al Noor Contracting');
  assert.equal(leads.items[0].original_message, merged.original_message);
  assert.equal((await h.store.getReply(confirmation.whatsapp_message_id)).text, SAVED_REPLY);
  assert.equal(await h.session(), null);
});

test('irrelevant unclassified chatter creates no draft but preserves an existing meaningful draft', async t => {
  const h = await setup(t, { extract: text => text === 'Ahmed' ? enquiry({ contact_name: 'Ahmed' }) : enquiry({}, false) });
  const chatter = await h.turn('oke');
  assert.equal(await h.session(), null);
  assert.equal((await h.store.getMessage(chatter.whatsapp_message_id)).session_id, null);
  assert.equal((await h.store.listLeads()).total, 0);
  await h.turn('Ahmed');
  const draft = await h.session();
  await h.turn('oke');
  const retained = await h.session();
  assert.equal(retained.id, draft.id);
  assert.deepEqual(retained.result, draft.result);
  assert.equal(retained.state, 'awaiting_confirmation');
  await h.turn('Yes');
  assert.equal((await h.store.listLeads()).total, 1);
  await h.turn('oke');
  assert.equal(await h.session(), null);
});
