'use strict';

const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { createAiService } = require('../src/services/ai/aiService');
const { createWhatsAppService } = require('../src/services/whatsapp/whatsappService');
const { createBossLeadWorkflow } = require('../src/services/leads/bossLeadWorkflow');
const { CONFIRMATION_REPLY, SAVED_REPLY } = require('../src/services/leads/bossConversation');
const { LEAD_FIELDS } = require('../src/services/ai/leadExtraction');
const { temporaryStore, testEnv } = require('./helpers');

const BOSS = '+971551234567';
const PHONE_ID = '1234567890';
const PRIVATE_FAILURE = 'synthetic-private-media-error';
const FACTS = [
  { text: 'Customer company is ABC Contracting.', fields: { company_name: 'ABC Contracting' } },
  { text: 'Customer phone is +971501234567.', fields: { phone: '+971501234567' } },
  { text: 'Need 2 generators in Dubai.', fields: { requirement: 'Need 2 generators', project_location: 'Dubai' } },
];
const emptyFields = () => Object.fromEntries(LEAD_FIELDS.map(field => [field, null]));
const combine = facts => ({ text: facts.map(fact => fact.text).join('\n'), fields: Object.assign({}, ...facts.map(fact => fact.fields)) });
const completed = text => ({ status: 200, data: { status: 'completed', output: [{
  type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }],
}] } });
const providerFailure = () => Object.assign(new Error(PRIVATE_FAILURE), { response: { status: 503 } });

// Only the signed webhook goes over a loopback connection. Every Meta/OpenAI
// request is handled by strict injected HTTP mocks, using synthetic credentials.
async function setup(t) {
  const { store, databaseUrl } = await temporaryStore(t);
  const env = testEnv({
    AUTOMATION_ENABLED: 'true', AI_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-6-astra',
    OPENAI_API_KEY: 'synthetic-openai-media-workflow-token',
    WHATSAPP_ACCESS_TOKEN: 'synthetic-meta-media-workflow-token',
    META_APP_SECRET: 'synthetic-media-workflow-signing-secret',
    WHATSAPP_PHONE_NUMBER_ID: PHONE_ID, META_GRAPH_API_VERSION: 'v25.0',
    AUTHORIZED_BOSS_PHONES: BOSS, DATABASE_URL: databaseUrl,
  });
  const logs = [], calls = [], sends = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, entry => logs.push(entry)]));
  const sources = new Map(), attachments = new Map(), buffers = new Map();
  let nextId = 0;
  const ai = createAiService({ env, logger, http: { async post(url, body, options) {
    assert.equal(options.headers.Authorization, 'Bearer ' + env.OPENAI_API_KEY);
    if (url === 'https://api.openai.com/v1/audio/transcriptions') {
      assert.equal(body.get('model'), 'gpt-4o-mini-transcribe');
      assert.equal(body.get('file').type, 'audio/ogg');
      const record = buffers.get(Buffer.from(await body.get('file').arrayBuffer()).toString('base64'));
      assert.ok(record, 'Audio bytes must come from the authenticated Meta download.');
      calls.push({ kind: 'transcription', id: record.id });
      if (record.failure === 'transcription') throw providerFailure();
      return { status: 200, data: { text: record.failure === 'empty_transcription' ? '' : record.text } };
    }
    assert.equal(url, 'https://api.openai.com/v1/responses', 'No other provider or Zoho endpoint is permitted.');
    assert.equal(body.model, 'gpt-6-astra');
    assert.equal(body.store, false);
    if (body.text?.format?.name === 'lead_enquiry') {
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.strict, true);
      assert.deepEqual(body.text.format.schema.properties.lead.required, LEAD_FIELDS);
      const text = JSON.parse(body.input[1].content).whatsapp_message;
      const record = sources.get(text);
      assert.ok(record, 'Lead extraction must receive this message or media transcript, not invented history.');
      calls.push({ kind: 'extraction', text });
      if (record.failure === 'malformed_extraction') return completed('{invalid-json');
      if (record.failure === 'extraction_timeout_once') {
        record.failure = null;
        throw Object.assign(new Error(PRIVATE_FAILURE), { code: 'ECONNABORTED' });
      }
      return completed(JSON.stringify({ is_lead: true, lead: { ...emptyFields(), ...record.fields } }));
    }
    const input = body.input[1].content[0];
    assert.equal(input.type, 'input_image');
    assert.match(input.image_url, /^data:image\/png;base64,/);
    const record = buffers.get(input.image_url.split(',')[1]);
    assert.ok(record, 'Image bytes must come from the authenticated Meta download.');
    calls.push({ kind: 'vision', id: record.id });
    if (record.failure === 'vision') throw providerFailure();
    return completed(record.text);
  } } });
  const whatsapp = createWhatsAppService({ env, logger, http: {
    async get(url, options) {
      assert.equal(options.headers.Authorization, 'Bearer ' + env.WHATSAPP_ACCESS_TOKEN);
      assert.equal(options.maxRedirects, 0);
      const location = new URL(url);
      const metadata = location.origin === 'https://graph.facebook.com';
      assert.ok(metadata || (location.origin === 'https://lookaside.fbsbx.com' && location.pathname === '/whatsapp_business/attachments/'));
      const id = metadata ? location.pathname.split('/').at(-1) : location.searchParams.get('mid');
      const record = attachments.get(id);
      assert.ok(record);
      calls.push({ kind: metadata ? 'media_lookup' : 'media_download', id });
      if (metadata) {
        assert.equal(location.pathname, '/v25.0/' + id);
        assert.equal(options.params.phone_number_id, PHONE_ID);
        return { status: 200, data: { id, file_size: record.buffer.length, mime_type: record.mimeType,
          url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=' + id } };
      }
      if (record.failure === 'media_download') throw providerFailure();
      return { status: 200, headers: { 'content-type': record.mimeType }, data: record.buffer };
    },
    async post(url, body, options) {
      assert.equal(url, 'https://graph.facebook.com/v25.0/' + PHONE_ID + '/messages');
      assert.equal(options.headers.Authorization, 'Bearer ' + env.WHATSAPP_ACCESS_TOKEN);
      assert.equal(body.messaging_product, 'whatsapp');
      assert.equal(body.to, BOSS);
      assert.equal(body.type, 'text');
      sends.push(body.text.body);
      return { status: 200, data: { messages: [{ id: 'wamid.synthetic-reply-' + sends.length }] } };
    },
  } });
  const app = createApp({ env, store, logger });
  await app.locals.ready;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  const config = app.locals.config;
  const processor = createBossLeadWorkflow({ store, ai, whatsapp, config, logger });
  return {
    store, processor, config, calls, sends, logs,
    make(type, fact, { failure } = {}) {
      const id = String(10000 + ++nextId);
      const record = { ...fact, id, failure };
      sources.set(fact.text, record);
      const message = { from: BOSS.slice(1), id: 'wamid.media-workflow-' + id,
        timestamp: String(Math.floor(Date.now() / 1000)), type };
      if (type === 'text') message.text = { body: fact.text };
      else {
        record.mimeType = type === 'image' ? 'image/png' : 'audio/ogg';
        // Small identifying fixtures; external content analysis is mocked.
        record.buffer = Buffer.concat([type === 'image' ? Buffer.from('89504e470d0a1a0a', 'hex') : Buffer.from('OggS'), Buffer.from(id)]);
        attachments.set(id, record);
        buffers.set(record.buffer.toString('base64'), record);
        message[type] = { id, mime_type: record.mimeType, ...(type === 'audio' ? { voice: true } : {}) };
      }
      return message;
    },
    async post(messages) {
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, messages,
      } }] }] });
      const signature = 'sha256=' + createHmac('sha256', env.META_APP_SECRET).update(body).digest('hex');
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/webhook', {
        method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'EVENT_RECEIVED');
    },
    async processNext() {
      const job = await store.claimLeadExtraction({ leaseMs: config.leaseMs, maxAttempts: config.maxAttempts });
      if (job) await processor.processIncomingWhatsAppMessage(job);
      return job;
    },
    async drain() {
      for (let count = 0; count < 20; count++) {
        if (!(await processor.processNextReply())) return;
      }
      assert.fail('The reply outbox did not drain within the fixture bound.');
    },
  };
}

const sequences = [
  ['text lead', ['text']], ['image lead', ['image']], ['voice lead', ['audio']],
  ['text + text', ['text', 'text']], ['text + image', ['text', 'image']],
  ['text + voice', ['text', 'audio']], ['image + voice', ['image', 'audio']],
  ['text + image + voice', ['text', 'image', 'audio']],
  ['multiple images', ['image', 'image', 'image']], ['multiple voice messages', ['audio', 'audio', 'audio']],
];

for (const [name, types] of sequences) {
  test('signed media workflow: ' + name + ' merges one draft and waits for explicit text save', async t => {
    const h = await setup(t);
    const facts = types.length === 1 ? [combine(FACTS)]
      : types.length === 2 ? [FACTS[0], combine(FACTS.slice(1))] : FACTS;
    const messages = types.map((type, index) => h.make(type, facts[index]));
    await h.post(messages);
    let sessionId;
    const expected = emptyFields();
    for (const [index, message] of messages.entries()) {
      const job = await h.processNext();
      assert.equal(job.message_id, message.id, 'Different media types retain durable receipt order.');
      const draft = await h.store.getActiveLeadSession(BOSS);
      sessionId ||= draft.id;
      assert.equal(draft.id, sessionId);
      assert.equal(draft.state, 'awaiting_confirmation');
      Object.assign(expected, facts[index].fields);
      assert.deepEqual(draft.result.lead, expected, 'Known values accumulate; all missing fields remain null.');
      assert.equal((await h.store.listLeads()).total, 0);
      const stored = await h.store.getMessage(message.id);
      assert.equal(stored.authenticated, true);
      assert.equal(stored.processing_flow, 'boss_lead');
      assert.equal(stored.session_id, sessionId);
      assert.equal(stored.transcription, message.type === 'audio' ? facts[index].text : null);
      assert.equal(stored.extracted_text, message.type === 'image' ? facts[index].text : null);
      assert.equal((await h.store.getReply(message.id)).text, CONFIRMATION_REPLY);
    }
    assert.equal(await h.processNext(), null);
    const save = h.make('text', { text: 'Save it', fields: {} });
    await h.post([save]);
    await h.processNext();
    assert.equal(await h.store.getActiveLeadSession(BOSS), null);
    const leads = await h.store.listLeads();
    assert.equal(leads.total, 1);
    const saved = leads.items[0];
    assert.deepEqual(Object.fromEntries(LEAD_FIELDS.map(field => [field, saved[field]])), expected);
    assert.equal(saved.zoho_status, 'not_started');
    assert.equal(saved.zoho_lead_id, null);
    assert.equal(saved.original_message, facts.map(fact => fact.text).join('\n'));
    await h.post([...messages, save]);
    assert.equal(await h.processNext(), null);
    assert.equal((await h.store.listLeads()).total, 1);
    await h.drain();
    assert.deepEqual(h.sends, [...types.map(() => CONFIRMATION_REPLY), SAVED_REPLY]);
    assert.equal(h.calls.filter(call => call.kind === 'extraction').length, types.length);
    assert.equal(h.calls.filter(call => call.kind === 'media_download').length, types.filter(type => type !== 'text').length);
  });
}

for (const type of ['image', 'audio']) {
  test('signed media workflow: duplicate ' + type + ' receipts and claimed jobs cannot repeat media analysis', async t => {
    const h = await setup(t);
    const message = h.make(type, combine(FACTS));
    await h.post([message, message]);
    const job = await h.store.claimLeadExtraction();
    await Promise.all([h.processor.processIncomingWhatsAppMessage(job), h.processor.processIncomingWhatsAppMessage(job)]);
    await h.processor.processIncomingWhatsAppMessage(job);
    await h.post([message]);
    assert.equal(await h.processNext(), null);
    for (const kind of ['media_lookup', 'media_download', type === 'image' ? 'vision' : 'transcription', 'extraction']) {
      assert.equal(h.calls.filter(call => call.kind === kind).length, 1, kind + ' must run once.');
    }
    const draft = await h.store.getActiveLeadSession(BOSS);
    assert.equal(draft.original_message, combine(FACTS).text);
    assert.equal((await h.store.listLeads()).total, 0);
    await h.drain();
    assert.deepEqual(h.sends, [CONFIRMATION_REPLY]);
    assert.equal((await h.store.driver.query('SELECT id FROM reply_outbox WHERE message_id=?', [message.id])).rowCount, 1);
  });
}

for (const [failure, type] of [
  ['media_download', 'image'], ['vision', 'image'], ['transcription', 'audio'],
  ['empty_transcription', 'audio'], ['malformed_extraction', 'image'],
]) {
  test('signed media workflow: ' + failure + ' retains known facts and sends one safe clarification', async t => {
    const h = await setup(t);
    await h.post([h.make('text', FACTS[0])]);
    await h.processNext();
    const before = await h.store.getActiveLeadSession(BOSS);
    const message = h.make(type, combine(FACTS.slice(1)), { failure });
    await h.post([message]);
    await h.processNext();
    const after = await h.store.getActiveLeadSession(BOSS);
    assert.equal(after.id, before.id);
    assert.deepEqual(after.result, before.result);
    assert.equal(after.state, 'collecting');
    assert.equal((await h.store.listLeads()).total, 0);
    const stored = await h.store.getMessage(message.id);
    if (failure === 'malformed_extraction') {
      assert.equal(stored.extracted_text, combine(FACTS.slice(1)).text, 'Readable OCR survives malformed extraction.');
      assert.equal(stored.error_message, 'AI_MALFORMED_RESPONSE');
    } else {
      assert.equal(stored.transcription, null);
      assert.equal(stored.extracted_text, null);
      assert.equal(stored.conversation_kind, 'media_error');
    }
    const reply = (await h.store.getReply(message.id)).text;
    assert.match(reply, failure === 'malformed_extraction' ? /could not validate.*draft is retained/i : /could not read.*resend/i);
    assert.doesNotMatch(reply, /saved successfully/i);
    await h.post([message]);
    assert.equal(await h.processNext(), null);
    await h.drain();
    assert.deepEqual(h.sends, [CONFIRMATION_REPLY, reply]);
    assert.doesNotMatch(JSON.stringify(h.logs), new RegExp(PRIVATE_FAILURE));
    assert.doesNotMatch(JSON.stringify(h.logs), /synthetic-(?:openai|meta)-media-workflow-token/);
    await h.post([h.make('text', { text: 'Save it', fields: {} })]);
    await h.processNext();
    const saved = (await h.store.listLeads()).items[0];
    assert.equal(saved.company_name, FACTS[0].fields.company_name);
    assert.equal(saved.phone, null);
    assert.equal(saved.requirement, null);
    assert.equal(saved.zoho_status, 'not_started');
  });
}

test('signed media workflow: image OCR checkpoint survives an Astra timeout before later voice details', async t => {
  const h = await setup(t);
  const text = h.make('text', FACTS[0]);
  const image = h.make('image', FACTS[1], { failure: 'extraction_timeout_once' });
  const voice = h.make('audio', FACTS[2]);
  await h.post([text, image, voice]);
  await h.processNext();
  const sessionId = (await h.store.getActiveLeadSession(BOSS)).id;
  await h.processNext();
  assert.equal((await h.store.getMessage(image.id)).extracted_text, FACTS[1].text);
  assert.equal(await h.store.getReply(image.id), null);
  const failed = await h.store.getLeadExtraction(image.id);
  assert.equal(failed.processing_status, 'FAILED');
  assert.equal(failed.error_message, 'AI_TIMEOUT');
  assert.ok(failed.next_attempt_at);
  assert.equal(await h.processNext(), null, 'Later voice information cannot overtake a retrying image.');
  await h.store.driver.query('UPDATE lead_extractions SET next_attempt_at=? WHERE message_id=?', ['2000-01-01T00:00:00.000Z', image.id]);
  assert.equal((await h.processNext()).message_id, image.id);
  assert.equal((await h.processNext()).message_id, voice.id);
  const draft = await h.store.getActiveLeadSession(BOSS);
  assert.equal(draft.id, sessionId);
  assert.deepEqual(draft.result.lead, { ...emptyFields(), ...combine(FACTS).fields });
  assert.equal(draft.original_message, combine(FACTS).text);
  assert.equal(h.calls.filter(call => call.kind === 'vision').length, 1);
  assert.equal(h.calls.filter(call => call.kind === 'media_download' && call.id === image.image.id).length, 1);
  assert.equal(h.calls.filter(call => call.kind === 'extraction' && call.text === FACTS[1].text).length, 2);
  assert.equal((await h.store.listLeads()).total, 0);
  await h.drain();
  assert.deepEqual(h.sends, [CONFIRMATION_REPLY, CONFIRMATION_REPLY, CONFIRMATION_REPLY]);
});
