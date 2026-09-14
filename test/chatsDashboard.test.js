'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = new Map(); this.value = ''; this.hidden = false; this._text = ''; this.dataset = {}; this.attributes = {}; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('HTML injection sink is forbidden'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener(event, handler) { this.listeners.set(event, handler); }
  dispatch(event) { return this.listeners.get(event)?.({ preventDefault() {} }); }
  setAttribute(name, value) { this.attributes[name] = value; }
}
function response(data, status = 200) { return { status, ok: status >= 200 && status < 300, async json() { return data; } }; }
async function dashboard(fetch, { authenticated = false, loginStatus = 200, search = '' } = {}) {
  const [html, script] = await Promise.all(['chats.html', 'chats.js'].map(file => fs.readFile(path.resolve(__dirname, '../src/admin', file), 'utf8')));
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  elements.get('workspace').hidden = true;
  const tags = [];
  const document = {
    getElementById(id) { assert.ok(elements.has(id), 'Unknown chat element: ' + id); return elements.get(id); },
    createElement(tag) { tags.push(tag); return new Element(tag); },
  };
  Object.defineProperty(document, 'cookie', { get() { throw new Error('Cookie access is forbidden'); }, set() { throw new Error('Cookie storage is forbidden'); } });
  const window = new Element();
  window.location = { search };
  const requests = [];
  const context = { document, window, URLSearchParams, async fetch(url, options) {
    requests.push({ url, options });
    if (url === '/api/admin/session') return response({ authenticated });
    if (url === '/api/admin/login') return response({ authenticated: loginStatus === 200 }, loginStatus);
    if (url === '/api/admin/logout') return response({ authenticated: false });
    return fetch(url, options);
  } };
  for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(context, name, { get() { throw new Error('Persistent credential storage is forbidden'); } });
  vm.runInNewContext(script, context, { filename: 'admin/chats.js' });
  return { el: id => elements.get(id), tags, window, requests, html };
}
async function settled() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); }
const boss = { id: '+971551234567', sender_phone: '+971551234567', sender_name: 'Boss', type: 'boss_lead', status: 'awaiting_confirmation',
  last_message: 'Is the lead complete?', last_message_type: 'text', last_message_at: '2026-09-12T10:00:00Z' };
function page(items, page = 1, total = items.length, pageSize = 100) {
  return { items, page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) };
}
function signIn(h) {
  h.el('username').value = 'synthetic.operator';
  h.el('password').value = 'synthetic-private-password';
  h.el('login-form').dispatch('submit');
}

test('chats reuse existing login and safely render chronological boss/bot/media history and linked lead information', async () => {
  const injected = '<img src=x onerror="globalThis.injected=true">';
  const messages = [
    { direction: 'incoming', message_type: 'text', text: 'Hi' },
    { direction: 'outgoing', message_type: 'text', text: 'Hi Boss', status: 'sent' },
    { direction: 'incoming', message_type: 'image', text: injected, media_filename: injected, extracted_text: 'Image facts ' + injected },
    { direction: 'incoming', message_type: 'audio', text: 'Need 2 MDB', lead_id: 'lead-1', transcription: 'Voice facts ' + injected },
  ].map((message, index) => ({ ...message, created_at: `2026-09-12T10:00:0${index}Z` }));
  const h = await dashboard(async url => response(url.includes('/messages?') ? page(messages)
    : url.startsWith('/api/chats?') ? page([{ ...boss, sender_name: injected }], 1, 1, 20)
      : { ...boss, active_session: { state: 'awaiting_confirmation', pending_action: 'new_lead',
        lead: { company_name: 'Al Noor', requirement: injected, address: 'Business Bay', trn_no: '104249196700003' } },
        archived_sessions: [{ state: 'discarded', original_message: injected, lead: { company_name: 'Retained draft', notes: injected } }],
        leads: [{ id: 'lead-1', company_name: 'Previous customer', contact_name: 'Ahmed', phone: '+971501234567', validation_status: 'valid' }] }));
  assert.deepEqual(h.requests.map(request => request.url), ['/api/admin/session']);
  signIn(h);
  assert.equal(h.el('password').value, '');
  await settled();
  assert.equal(h.el('workspace').hidden, false);
  assert.match(h.el('conversation-list').textContent, /<img src=x/);
  assert.equal(h.el('message-history').children[0].children[1].textContent, 'Hi');
  assert.equal(h.el('message-history').children[1].children[1].textContent, 'Hi Boss');
  assert.match(h.el('message-history').textContent, /BOSS · INCOMING/);
  assert.match(h.el('message-history').textContent, /BOT · OUTGOING/);
  assert.match(h.el('message-history').textContent, /Image \/ screenshot/);
  assert.match(h.el('message-history').textContent, /Voice message \/ audio/);
  assert.match(h.el('message-history').textContent, /Voice transcription/);
  assert.ok(h.el('message-history').textContent.includes('Voice facts ' + injected));
  assert.match(h.el('message-history').textContent, /Extracted image \/ document text/);
  assert.ok(h.el('message-history').textContent.includes('Image facts ' + injected));
  assert.match(h.el('message-history').textContent, /Lead: Previous customer/);
  assert.match(h.el('linked-leads').textContent, /Current lead · awaiting confirmation/);
  assert.match(h.el('linked-leads').textContent, /Al Noor/);
  assert.match(h.el('linked-leads').textContent, /Saved lead · Previous customer/);
  assert.match(h.el('linked-leads').textContent, /Closed unsaved draft · Retained draft/);
  assert.match(h.el('linked-leads').textContent, /TRN number: 104249196700003/);
  assert.match(h.el('linked-leads').textContent, /Address: Business Bay/);
  assert.match(h.el('linked-leads').textContent, /Waiting for the boss to confirm/);
  assert.ok(h.el('linked-leads').textContent.includes(injected));
  assert.equal(h.tags.includes('img'), false);
  assert.equal(h.tags.includes('script'), false);
  for (const { url, options } of h.requests) {
    assert.ok(url.startsWith('/api/chats') || url.startsWith('/api/admin/'));
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers?.Authorization, undefined);
    assert.equal(url.includes('synthetic-private-password'), false);
  }
  const login = h.requests.find(request => request.url === '/api/admin/login');
  assert.deepEqual(JSON.parse(login.options.body), { username: 'synthetic.operator', password: 'synthetic-private-password' });
  h.el('lock').dispatch('click');
  assert.equal(h.el('workspace').hidden, true);
  assert.equal(h.el('conversation-list').textContent, '');
  assert.equal(h.el('message-history').textContent, '');
  assert.equal(h.el('linked-leads').textContent, '');
  await settled();
  assert.equal(h.requests.at(-1).url, '/api/admin/logout');
});

test('single-field saved and archived leads use available facts in chat labels', async () => {
  const fields = { company_name: 'GLOW POWER', contact_name: 'Ahmed', phone: '+971501234567',
    email: 'procurement@example.test', address: 'Business Bay, Dubai', trn_no: '104249196700003',
    project_name: 'Marina Tower', project_location: 'Dubai', product_or_service: 'Electrical panels',
    requirement: 'Quotation', quantity: '5', deadline: 'Tomorrow', notes: 'Call after 3pm' };
  const leads = Object.entries(fields).map(([field, value], i) => ({ id: 'lead-' + i, [field]: value }));
  const messages = leads.map(lead => ({ direction: 'incoming', message_type: 'text', text: 'Source', lead_id: lead.id }));
  const h = await dashboard(async url => response(url.includes('/messages?') ? page(messages)
    : url.startsWith('/api/chats?') ? page([boss]) : { ...boss, leads,
      archived_sessions: leads.map(lead => ({ state: 'discarded', lead })) }), { authenticated: true });
  await settled();
  const summaries = h.el('linked-leads').children;
  for (const [i, value] of Object.values(fields).entries()) {
    assert.ok(summaries[i].children[0].textContent.includes(value), value);
    assert.ok(summaries[leads.length + i].children[0].textContent.includes(value), value);
    assert.ok(h.el('message-history').children[i].children.at(-1).textContent.includes(value), value);
  }
});

test('conversation search and history pagination make every stored page reachable oldest first', async () => {
  const h = await dashboard(async url => {
    if (url.includes('/messages?')) {
      const number = Number(new URLSearchParams(url.split('?')[1]).get('page'));
      return response(page([{ direction: 'incoming', message_type: 'text', text: 'History page ' + number }], number, 201, 100));
    }
    if (url.startsWith('/api/chats?')) {
      const number = Number(new URLSearchParams(url.split('?')[1]).get('page'));
      return response(page([boss], number, 21, 20));
    }
    return response({ ...boss, leads: [] });
  }, { authenticated: true });
  await settled();
  assert.equal(h.requests.some(request => request.url === '/api/admin/login'), false);
  assert.equal(h.el('older').disabled, true);
  assert.equal(h.el('newer').disabled, false);
  h.el('newer').dispatch('click');
  await settled();
  assert.match(h.el('message-history').textContent, /History page 2/);
  assert.match(h.el('message-page-label').textContent, /101–101 of 201 messages · Oldest first/);
  h.el('newer').dispatch('click');
  await settled();
  assert.equal(h.el('newer').disabled, true);
  assert.match(h.el('message-history').textContent, /History page 3/);
  h.el('older').dispatch('click');
  await settled();
  assert.match(h.el('message-history').textContent, /History page 2/);
  h.el('next').dispatch('click');
  await settled();
  assert.match(h.el('page-label').textContent, /Page 2 of 2/);
  assert.match(h.el('message-history').textContent, /History page 1/);
  h.el('search').value = 'Al Noor %_';
  h.el('filters').dispatch('submit');
  await settled();
  const list = h.requests.filter(request => request.url.startsWith('/api/chats?')).at(-1);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(list.url.split('?')[1])), { search: 'Al Noor %_', page: '1', page_size: '20' });
});

test('signing out immediately clears history and rejects late private responses', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = await dashboard(async url => {
    if (url.startsWith('/api/chats?')) return response(page([boss], 1, 1, 20));
    await gate;
    return response(url.includes('/messages?') ? page([{ text: 'late private message' }]) : { ...boss, sender_name: 'late private name' });
  }, { authenticated: true });
  await settled();
  assert.ok(h.requests.some(request => request.url.includes('/messages?')));
  h.el('lock').dispatch('click');
  release();
  await settled();
  assert.equal(h.el('workspace').hidden, true);
  assert.equal(h.el('conversation-list').textContent, '');
  assert.equal(h.el('message-history').textContent, '');
  assert.equal(h.el('conversation-title').textContent, 'Select a conversation');
});

test('changing conversations cannot replace current history with a stale earlier response', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const customer = { ...boss, id: '+971501234567', sender_phone: '+971501234567', sender_name: 'Customer', type: 'conversation' };
  const h = await dashboard(async url => {
    if (url.startsWith('/api/chats?')) return response(page([boss, customer], 1, 2, 20));
    const first = url.includes(encodeURIComponent(boss.id));
    if (first) await gate;
    return response(url.includes('/messages?') ? page([{ text: first ? 'old boss history' : 'current customer history', direction: 'incoming' }]) : first ? boss : customer);
  }, { authenticated: true });
  await settled();
  h.el('conversation-list').children[1].dispatch('click');
  await settled();
  release();
  await settled();
  assert.equal(h.el('conversation-title').textContent, 'Customer');
  assert.match(h.el('message-history').textContent, /current customer history/);
  assert.doesNotMatch(h.el('message-history').textContent, /old boss history/);
});

test('expired sessions clear private chat state and incorrect logins do not request chats', async () => {
  const expired = await dashboard(async () => response({}, 401), { authenticated: true });
  await settled();
  assert.equal(expired.el('workspace').hidden, true);
  assert.equal(expired.el('message-history').textContent, '');
  assert.equal(expired.el('feedback').textContent, 'Session expired. Please sign in again.');
  const wrong = await dashboard(async () => { throw new Error('Chat data must not be requested'); }, { loginStatus: 401 });
  signIn(wrong);
  await settled();
  assert.equal(wrong.el('workspace').hidden, true);
  assert.equal(wrong.el('password').value, '');
  assert.equal(wrong.el('feedback').textContent, 'Incorrect username or password.');
  assert.equal(wrong.requests.some(request => request.url.startsWith('/api/chats')), false);
});

test('a lead conversation link loads the authorized sender history even outside the current list page', async () => {
  const customer = { ...boss, id: '+971501234567', sender_phone: '+971501234567', sender_name: 'Unrelated customer', type: 'conversation' };
  const h = await dashboard(async url => response(url.startsWith('/api/chats?') ? page([customer], 1, 1, 20)
    : url.includes('/messages?') ? page([{ text: 'Related boss history', direction: 'incoming' }]) : boss),
  { authenticated: true, search: '?conversation=' + encodeURIComponent(boss.id) });
  await settled();
  assert.equal(h.el('conversation-title').textContent, 'Boss');
  assert.match(h.el('message-history').textContent, /Related boss history/);
  const details = h.requests.filter(({ url }) => url.startsWith('/api/chats/'));
  assert.equal(details.length, 2);
  assert.ok(details.every(({ url }) => url.startsWith('/api/chats/' + encodeURIComponent(boss.id))));
});

test('conversation navigation ignores malformed and duplicate identifiers and still requires login', async () => {
  for (const search of ['?conversation=javascript:alert(1)', '?conversation=%2F%2Fevil.example.test',
    '?conversation=' + encodeURIComponent(boss.id) + '&conversation=' + encodeURIComponent(boss.id)]) {
    const h = await dashboard(async url => response(url.startsWith('/api/chats?') ? page([], 1, 0, 20) : {}), { authenticated: true, search });
    await settled();
    assert.equal(h.requests.some(({ url }) => url.startsWith('/api/chats/')), false);
  }
  const locked = await dashboard(async () => { throw new Error('Chat access must require login'); }, { search: '?conversation=' + encodeURIComponent(boss.id) });
  await settled();
  assert.deepEqual(locked.requests.map(({ url }) => url), ['/api/admin/session']);
});

test('saved lead summaries preserve useful details and link to the exact saved lead without accepting injected IDs', async () => {
  const id = '346770a3-ef6b-4d87-bf45-54a64246a17a';
  const injected = '<img src=x onerror=alert(1)>';
  const lead = { id, company_name: 'GLOW POWER', contact_name: 'Ahmed', phone: '+971501234567',
    email: 'procurement@example.test', project_name: 'Dubai project', project_location: 'Dubai',
    product_or_service: 'Generator rental', quantity: '2', deadline: 'Next week', notes: injected, validation_status: 'valid' };
  const h = await dashboard(async url => response(url.startsWith('/api/chats?') ? page([boss])
    : url.includes('/messages?') ? page([]) : { ...boss, leads: [lead, { ...lead, id: 'javascript:alert(1)' }] }), { authenticated: true });
  await settled();
  const savedLead = h.el('linked-leads').children[0];
  for (const field of ['email', 'project_name', 'project_location', 'product_or_service', 'quantity', 'deadline', 'notes']) {
    assert.ok(savedLead.textContent.includes(lead[field]), field);
  }
  assert.equal(savedLead.children.at(-1).textContent, 'Open this lead');
  assert.equal(savedLead.children.at(-1).href, '/admin/leads?lead=' + id);
  assert.equal(h.el('linked-leads').children[1].children.some(child => child.tagName === 'a'), false);
  assert.equal(h.tags.includes('img'), false);
});

test('message speakers follow the stored intake role when the participant role changes over time', async () => {
  const messages = [
    { direction: 'incoming', sender_type: 'customer', text: 'Previous customer message' },
    { direction: 'incoming', sender_type: 'boss', text: 'Internal lead intake' },
    { direction: 'outgoing', sender_type: 'bot', text: 'Reply' },
    { direction: 'incoming', sender_type: 'participant', text: 'Other WhatsApp message' },
  ];
  const h = await dashboard(async url => response(url.startsWith('/api/chats?') ? page([boss])
    : url.includes('/messages?') ? page(messages) : boss), { authenticated: true });
  await settled();
  assert.deepEqual(h.el('message-history').children.map(bubble => bubble.children[0].textContent),
    ['CUSTOMER · INCOMING', 'BOSS · INCOMING', 'BOT · OUTGOING', 'PARTICIPANT · INCOMING']);
});
