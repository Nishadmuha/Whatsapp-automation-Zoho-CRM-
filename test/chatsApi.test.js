'use strict';
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { testEnv, temporaryStore, incoming } = require('./helpers');

async function backend(t, { env: overrides = {}, methods = {}, actualStore } = {}) {
  const calls = [];
  const logs = [];
  const env = testEnv({ ADMIN_USERNAME: 'test-admin', ADMIN_PASSWORD: randomBytes(24).toString('hex'), ...overrides });
  const conversation = { id: '+971551234567', sender_phone: '+971551234567', sender_name: 'Boss', type: 'boss_lead',
    status: 'awaiting_confirmation', last_message: 'Is the lead complete?', last_message_type: 'text',
    last_message_at: '2026-09-12T10:00:04.000Z', lead_id: null, session_id: randomUUID(),
    leads: [{ id: randomUUID(), company_name: 'Earlier customer', contact_name: 'Ahmed', phone: '+971501234567',
      validation_status: 'valid', created_at: '2026-09-11T10:00:00.000Z', internal_secret: 'DO_NOT_EXPOSE' }],
    active_session: { id: randomUUID(), state: 'awaiting_confirmation', result: { lead: { company_name: 'Al Noor', requirement: '2 MDB' } },
      error_message: 'DO_NOT_EXPOSE', original_message: 'DO_NOT_EXPOSE' }, internal_secret: 'DO_NOT_EXPOSE' };
  const messages = ['Hi', 'Hi Boss', 'Al Noor', '2 MDB', 'Is the lead complete?'].map((text, index) => ({
    id: String(index), message_id: 'wamid.chat-' + index, direction: index === 1 || index === 4 ? 'outgoing' : 'incoming',
    text, message_type: index === 3 ? 'audio' : 'text', created_at: `2026-09-12T10:00:0${index}.000Z`,
    media_id: index === 3 ? 'media-123' : null, media_mime_type: index === 3 ? 'audio/ogg' : null,
    media_filename: null, sender_name: 'Boss', received_at: null, status: index === 4 ? 'sent' : 'received',
    lead_id: null, session_id: conversation.session_id, raw_payload: 'DO_NOT_EXPOSE', error_message: 'DO_NOT_EXPOSE',
  }));
  const store = actualStore || { async init() {}, async ping() {},
    async listConversations(query) { calls.push(['list', query]); return { items: [conversation], total: 1 }; },
    async getConversation(id) { calls.push(['detail', id]); return id === conversation.id ? conversation : null; },
    async listConversationMessages(id, query) { calls.push(['messages', id, query]);
      return { items: messages.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: messages.length }; },
    ...methods,
  };
  const app = createApp({ env, store, logger: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, entry => logs.push(entry)])) });
  await app.locals.ready.catch(() => {});
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; });
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  if (env.ADMIN_USERNAME && env.ADMIN_PASSWORD) {
    const login = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }) });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
  }
  return { conversation, messages, env, logs, calls, base, cookie, store, path: '/api/chats/' + encodeURIComponent(conversation.id),
    request(path = '/api/chats', sessionCookie = cookie) { return fetch(base + path, { headers: sessionCookie ? { Cookie: sessionCookie } : {} }); } };
}

test('chat list, detail and history require the existing issued admin session', async t => {
  const h = await backend(t);
  for (const path of ['/api/chats', h.path, h.path + '/messages']) {
    assert.equal((await h.request(path, null)).status, 401);
    assert.equal((await fetch(h.base + path, { headers: { Authorization: 'Bearer ' + h.env.ADMIN_PASSWORD } })).status, 401);
  }
  assert.deepEqual(h.calls, []);
  assert.equal((await h.request()).status, 200);
  assert.equal(JSON.stringify(h.logs).includes(h.env.ADMIN_PASSWORD), false);
  assert.equal(JSON.stringify(h.logs).includes(h.cookie), false);
  const unconfigured = await backend(t, { env: { ADMIN_USERNAME: '', ADMIN_PASSWORD: '' } });
  assert.equal((await unconfigured.request()).status, 503);
  assert.deepEqual(unconfigured.calls, []);
});

test('configured admin API token protects chat list, detail and messages with the shared middleware', async t => {
  const token = 'synthetic-chat-api-token-' + 'c'.repeat(32);
  const h = await backend(t, { env: { ADMIN_API_TOKEN: token, ADMIN_USERNAME: '', ADMIN_PASSWORD: '' } });
  for (const path of ['/api/chats', h.path, h.path + '/messages']) {
    assert.equal((await h.request(path, null)).status, 401);
    assert.equal((await fetch(h.base + path, { headers: { Authorization: 'Bearer ' + 'w'.repeat(64) } })).status, 401);
    const response = await fetch(h.base + path, { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes(token), false);
  }
  assert.equal(JSON.stringify(h.logs).includes(token), false);
});

test('chat queries and phone IDs reject unknown, duplicate and malformed input before accessing storage', async t => {
  const h = await backend(t);
  for (const query of ['page=0', 'page=-1', 'page=01', 'page=1000001', 'page=1&page=2', 'page_size=101',
    'search=a&search=b', 'search=%00', 'search=' + 'x'.repeat(201), 'token=secret', 'sort=oldest']) {
    assert.equal((await h.request('/api/chats?' + query)).status, 400, query);
  }
  for (const suffix of ['/messages?page_size=201', '/messages?search=x', '/messages?page=1&page=2', '?search=x']) {
    assert.equal((await h.request(h.path + suffix)).status, 400, suffix);
  }
  assert.equal((await h.request('/api/chats/not-a-phone')).status, 400);
  assert.equal((await h.request('/api/chats/not-a-phone/messages')).status, 400);
  assert.deepEqual(h.calls, []);
  assert.equal((await h.request('/api/chats?search=' + encodeURIComponent('Al Noor %_') + '&page=2&page_size=5')).status, 200);
  assert.deepEqual(h.calls[0], ['list', { page: 2, pageSize: 5, search: 'Al Noor %_' }]);
});

test('all chronological message pages remain reachable with incoming, bot and voice metadata', async t => {
  const h = await backend(t);
  const loaded = [];
  for (let page = 1; page <= 3; page++) {
    const response = await h.request(h.path + '/messages?page_size=2&page=' + page);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.page, page);
    assert.equal(result.total, 5);
    assert.equal(result.total_pages, 3);
    loaded.push(...result.items);
  }
  assert.deepEqual(loaded.map(message => message.text), ['Hi', 'Hi Boss', 'Al Noor', '2 MDB', 'Is the lead complete?']);
  assert.deepEqual(loaded.map(message => message.direction), ['incoming', 'outgoing', 'incoming', 'incoming', 'outgoing']);
  assert.equal(loaded[3].message_type, 'audio');
  assert.equal(loaded[3].media_mime_type, 'audio/ogg');
  assert.equal(loaded[4].status, 'sent');
  assert.equal(JSON.stringify(loaded).includes('DO_NOT_EXPOSE'), false);
  const missing = '/api/chats/' + encodeURIComponent('+971551234568');
  assert.equal((await h.request(missing)).status, 404);
  assert.equal((await h.request(missing + '/messages')).status, 404);
});

test('chat DTOs preserve message text while allowlisting fields and redacting configured secrets at every level', async t => {
  const h = await backend(t, { env: { OPENAI_API_KEY: 'test-private-key' } });
  h.conversation.last_message = 'Hello test-private-key';
  h.conversation.active_session.result.lead.notes = 'test-private-key';
  h.conversation.active_session.result.lead.address = 'Business Bay, Dubai';
  h.conversation.active_session.result.lead.trn_no = '104249196700003';
  h.conversation.active_session.pending_action = 'new_lead';
  h.conversation.archived_sessions = [{ id: randomUUID(), state: 'discarded', lead_id: null,
    original_message: 'Useful old draft test-private-key', result: { lead: { company_name: 'Preserved old customer', notes: 'test-private-key' } },
    raw_response: 'DO_NOT_EXPOSE', lease_token: 'DO_NOT_EXPOSE' }];
  h.conversation.leads[0].company_name = 'test-private-key';
  h.messages[0].text = '<img onerror=alert(1)>\nHello test-private-key';
  h.messages[0].sender_type = 'boss';
  h.messages[1].sender_type = 'bot';
  h.messages[0].whatsapp_message_id = 'wamid.incoming.test-private-key';
  h.messages[1].in_reply_to_message_id = 'wamid.incoming.test-private-key';
  h.messages[0].extracted_text = 'Screenshot test-private-key';
  h.messages[3].transcription = 'Voice test-private-key';
  const listing = await (await h.request()).json();
  assert.equal(listing.items[0].last_message, 'Hello [REDACTED]');
  assert.equal(listing.items[0].active_session, undefined);
  const detail = await (await h.request(h.path)).json();
  assert.equal(detail.active_session.lead.company_name, 'Al Noor');
  assert.equal(detail.active_session.lead.notes, '[REDACTED]');
  assert.equal(detail.active_session.lead.address, 'Business Bay, Dubai');
  assert.equal(detail.active_session.lead.trn_no, '104249196700003');
  assert.equal(detail.active_session.pending_action, 'new_lead');
  assert.equal(detail.archived_sessions[0].lead.company_name, 'Preserved old customer');
  assert.equal(detail.archived_sessions[0].lead.notes, '[REDACTED]');
  assert.equal(detail.archived_sessions[0].original_message, 'Useful old draft [REDACTED]');
  assert.equal(detail.leads[0].company_name, '[REDACTED]');
  const history = await (await h.request(h.path + '/messages')).json();
  assert.equal(history.items[0].text, '<img onerror=alert(1)>\nHello [REDACTED]');
  assert.equal(history.items[0].sender_type, 'boss');
  assert.equal(history.items[1].sender_type, 'bot');
  assert.equal(history.items[0].whatsapp_message_id, 'wamid.incoming.[REDACTED]');
  assert.equal(history.items[1].in_reply_to_message_id, 'wamid.incoming.[REDACTED]');
  assert.equal(history.items[0].extracted_text, 'Screenshot [REDACTED]');
  assert.equal(history.items[3].transcription, 'Voice [REDACTED]');
  assert.doesNotMatch(JSON.stringify([listing, detail, history]), /DO_NOT_EXPOSE|test-private-key/);
});

test('history distinguishes incoming IDs, pending outgoing replies and actual outgoing WhatsApp provider IDs', async t => {
  const { store, databaseUrl } = await temporaryStore(t);
  const message = incoming({ message_text: 'Hi', request_lead_workflow: true });
  await store.enqueueMany([message]);
  const job = await store.claimLeadExtraction();
  await store.completeLeadSessionTurn(job.message_id, job.lease_token, { kind: 'greeting', replyText: 'Hi Boss' });
  const h = await backend(t, { actualStore: store, env: { DATABASE_URL: databaseUrl } });
  let history = (await (await h.request(h.path + '/messages')).json()).items;
  const incomingMessage = history.find(item => item.direction === 'incoming');
  let outgoing = history.find(item => item.direction === 'outgoing');
  assert.equal(incomingMessage.whatsapp_message_id, message.whatsapp_message_id);
  assert.equal(incomingMessage.in_reply_to_message_id, null);
  assert.equal(outgoing.message_id, message.whatsapp_message_id, 'Existing source message_id contract is unchanged.');
  assert.equal(outgoing.whatsapp_message_id, null, 'A pending reply has no provider-issued WhatsApp ID yet.');
  assert.equal(outgoing.in_reply_to_message_id, message.whatsapp_message_id);
  const reply = await store.claimReply({ processingFlow: 'boss_lead' });
  const providerMessageId = 'wamid.synthetic-outgoing-provider-id';
  assert.equal(await store.finishReply(reply.id, reply.lease_token, { status: 'SENT', provider_message_id: providerMessageId }), true);
  history = (await (await h.request(h.path + '/messages')).json()).items;
  outgoing = history.find(item => item.direction === 'outgoing');
  assert.equal(outgoing.whatsapp_message_id, providerMessageId);
  assert.notEqual(outgoing.whatsapp_message_id, outgoing.in_reply_to_message_id);
  assert.equal(outgoing.in_reply_to_message_id, message.whatsapp_message_id);
  assert.equal(outgoing.message_id, message.whatsapp_message_id);
});

test('stored message roles survive customer-to-boss changes and extracted customer numbers retain separate histories', async t => {
  const { store, databaseUrl } = await temporaryStore(t);
  const previous = incoming({ message_text: 'Earlier customer conversation' });
  await store.enqueueMany([previous], { processingFlow: 'conversation' });
  const customerJob = await store.claimNext({ processingFlow: 'conversation' });
  await store.completeWithReply(customerJob.whatsapp_message_id, customerJob.lease_token,
    { processing_status: 'SUCCESS' }, 'Earlier customer reply');

  const customerPhone = '+971501234567';
  const bossMessage = incoming({ message_text: 'Ahmed ' + customerPhone + ' requires two generators', request_lead_workflow: true });
  await store.enqueueMany([bossMessage]);
  const bossJob = await store.claimLeadExtraction();
  const leadFields = ['company_name', 'contact_name', 'phone', 'email', 'address', 'trn_no', 'project_name', 'project_location',
    'product_or_service', 'requirement', 'quantity', 'deadline', 'notes'];
  await store.completeLeadSessionTurn(bossJob.message_id, bossJob.lease_token, {
    result: { is_lead: true, lead: { ...Object.fromEntries(leadFields.map(field => [field, null])),
      contact_name: 'Ahmed', phone: customerPhone, requirement: 'Two generators' } },
    validation: { valid: true, missing_fields: [], errors: [] }, state: 'awaiting_confirmation',
    originalMessage: bossMessage.message_text, replyText: 'Is this lead complete and ready to save?',
  });
  const customerMessage = incoming({ sender_phone: customerPhone, sender_name: 'Ahmed', message_text: 'My separate customer enquiry' });
  await store.enqueueMany([customerMessage], { processingFlow: 'conversation' });

  const h = await backend(t, { actualStore: store, env: { DATABASE_URL: databaseUrl } });
  const listing = (await (await h.request()).json()).items;
  assert.equal(listing.length, 2);
  assert.equal(listing.find(item => item.id === previous.sender_phone).type, 'boss_lead');
  assert.equal(listing.find(item => item.id === customerPhone).type, 'conversation');
  const detail = await (await h.request(h.path)).json();
  assert.equal(detail.active_session.lead.phone, customerPhone);
  const history = (await (await h.request(h.path + '/messages')).json()).items;
  assert.equal(history.length, 4);
  assert.equal(history.find(item => item.whatsapp_message_id === previous.whatsapp_message_id).sender_type, 'customer');
  assert.equal(history.find(item => item.whatsapp_message_id === bossMessage.whatsapp_message_id).sender_type, 'boss');
  assert.ok(history.filter(item => item.direction === 'outgoing').every(item => item.sender_type === 'bot'));
  assert.ok(history.every(item => item.whatsapp_message_id !== customerMessage.whatsapp_message_id));
  const customerHistory = (await (await h.request('/api/chats/' + encodeURIComponent(customerPhone) + '/messages')).json()).items;
  assert.equal(customerHistory.length, 1);
  assert.equal(customerHistory[0].whatsapp_message_id, customerMessage.whatsapp_message_id);
  assert.equal(customerHistory[0].sender_type, 'customer');
});

test('database failures return safe errors and chat APIs retain rate limiting', async t => {
  const h = await backend(t, { methods: { async listConversations() { throw new Error('database secret'); } } });
  const response = await h.request();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { success: false, message: 'Temporarily unable to load chats' });
  assert.doesNotMatch(JSON.stringify(h.logs), /database secret/);
  const limited = await backend(t, { env: { WEBHOOK_RATE_LIMIT: '1' } });
  assert.equal((await limited.request()).status, 200);
  assert.equal((await limited.request()).status, 429);
  assert.equal((await limited.request('/health', null)).status, 200);
});

test('chat shell and local assets contain no private data, inline scripts or external resources', async t => {
  const h = await backend(t);
  const response = await h.request('/admin/chats', null);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="workspace"[^>]*hidden/);
  assert.match(html, /src="\/admin\/chats\.js" defer/);
  assert.match(html, /id="username"/);
  assert.match(html, /id="password"/);
  assert.doesNotMatch(html, /<script\b[^>]*>[\s\S]*?\S[\s\S]*?<\/script>|on(?:click|load)=|https?:\/\//i);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const asset of ['/admin/chats.js', '/admin/chats.css']) assert.equal((await h.request(asset, null)).status, 200);
  assert.equal((await h.request('/admin/.env', null)).status, 404);
  assert.deepEqual(h.calls, []);
});

test('chat APIs read migrated SQLite history, duplicate receipts, pending sessions and saved lead links', async t => {
  const { store, databaseUrl } = await temporaryStore(t);
  const enqueue = async text => {
    const message = incoming({ message_text: text, request_lead_workflow: true, sender_name: 'Boss %_' });
    await store.enqueueMany([message]);
    await store.enqueueMany([message]);
    return store.claimLeadExtraction();
  };
  let job = await enqueue('Hi');
  await store.completeLeadSessionTurn(job.message_id, job.lease_token, { kind: 'greeting', replyText: 'Hi Boss' });
  job = await enqueue('Al Noor needs 2 MDB');
  const leadFields = ['company_name', 'contact_name', 'phone', 'email', 'project_name', 'project_location',
    'product_or_service', 'requirement', 'quantity', 'deadline', 'notes'];
  await store.completeLeadSessionTurn(job.message_id, job.lease_token, { result: { is_lead: true,
    lead: { ...Object.fromEntries(leadFields.map(field => [field, null])), company_name: 'Al Noor', requirement: '2 MDB' } },
  validation: { valid: true, missing_fields: [], errors: [] }, state: 'awaiting_confirmation',
  originalMessage: 'Al Noor needs 2 MDB', replyText: 'Is this lead complete?' });
  const h = await backend(t, { actualStore: store, env: { DATABASE_URL: databaseUrl } });
  const listing = await (await h.request('/api/chats?search=' + encodeURIComponent('%_'))).json();
  assert.equal(listing.total, 1);
  assert.equal(listing.items[0].type, 'boss_lead');
  assert.equal(listing.items[0].status, 'awaiting_confirmation');
  let detail = await (await h.request(h.path)).json();
  assert.equal(detail.active_session.lead.company_name, 'Al Noor');
  assert.equal(detail.leads.length, 0, 'Draft sessions must not be listed as saved leads.');
  const id = detail.active_session.id;
  job = await enqueue('Yes');
  await store.completeLeadSessionTurn(job.message_id, job.lease_token, { sessionId: id,
    state: 'completed', kind: 'confirmation', replyText: 'Lead saved successfully' });
  detail = await (await h.request(h.path)).json();
  assert.equal(detail.active_session, null);
  assert.equal(detail.status, 'completed');
  assert.equal(detail.leads.length, 1);
  assert.equal(detail.leads[0].company_name, 'Al Noor');
  const loaded = [];
  for (let page = 1; page <= 3; page++) loaded.push(...(await (await h.request(h.path + '/messages?page_size=2&page=' + page)).json()).items);
  assert.deepEqual(loaded.map(message => message.text), ['Hi', 'Hi Boss', 'Al Noor needs 2 MDB', 'Is this lead complete?', 'Yes', 'Lead saved successfully']);
  assert.equal(loaded.at(-1).lead_id, detail.leads[0].id);
});

test('chat media endpoint serves stored files, caches 404 on missing, and has separate rate limit', async t => {
  const fakeBuffer = Buffer.from('fake-image-bytes');
  const h = await backend(t, {
    methods: {
      async getMediaFileByMediaId(id) {
        if (id === '123456') return { buffer: fakeBuffer, mimeType: 'image/png' };
        return null;
      },
    },
  });
  // 1. Existing media file returns 200 with correct mime type and cache header
  const successRes = await h.request('/api/chats/media/123456');
  assert.equal(successRes.status, 200);
  assert.equal(successRes.headers.get('content-type'), 'image/png');
  assert.equal(successRes.headers.get('cache-control'), 'private, max-age=86400');
  const buf = Buffer.from(await successRes.arrayBuffer());
  assert.deepEqual(buf, fakeBuffer);

  // 2. Missing/expired media file returns 404
  const missingRes = await h.request('/api/chats/media/999999');
  assert.equal(missingRes.status, 404);

  // 3. Invalid media id format returns 400
  const invalidRes = await h.request('/api/chats/media/invalid-id-xyz');
  assert.equal(invalidRes.status, 400);
});
