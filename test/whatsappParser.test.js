'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseWhatsAppWebhook, parseIncomingMessages } = require('../src/services/whatsapp/whatsappParser');

const now = Date.UTC(2026, 0, 2);
const timestamp = String(now / 1000);
function message(overrides = {}) {
  return { id: 'wamid.parser-1', from: '971501234567', timestamp, type: 'text', text: { body: '  Ahmed needs AC maintenance.\nPlease call.  ' }, ...overrides };
}
function payload(messages = [message()]) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA_ID', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: '1234567890' },
      contacts: [{ wa_id: '971509876543', profile: { name: 'Another sender' } }, { wa_id: '971501234567', profile: { name: 'Ahmed' } }],
      messages,
    } }] }],
  };
}

test('public parser extracts all message fields and matches the sender contact by WhatsApp ID', () => {
  assert.deepEqual(parseWhatsAppWebhook(payload(), { now }), [{
    messageId: 'wamid.parser-1', senderWhatsappId: '971501234567', senderPhone: '+971501234567',
    senderName: 'Ahmed', timestamp, messageType: 'text', text: message().text.body,
    phoneNumberId: '1234567890', wabaId: 'WABA_ID',
  }]);
  const prefixed = payload([message({ from: '+971501234567' })]);
  assert.equal(parseWhatsAppWebhook(prefixed, { now })[0].senderName, 'Ahmed');
});

test('parser traverses all entries, changes and messages without mixing contact names', () => {
  const body = payload([message(), message({ id: 'wamid.parser-2', from: '971509876543' })]);
  body.entry[0].changes.push(...payload([message({ id: 'wamid.parser-3' })]).entry[0].changes);
  body.entry.push(...payload([message({ id: 'wamid.parser-4' })]).entry);
  const parsed = parseWhatsAppWebhook(body, { now });
  assert.deepEqual(parsed.map((item) => item.messageId), ['wamid.parser-1', 'wamid.parser-2', 'wamid.parser-3', 'wamid.parser-4']);
  assert.deepEqual(parsed.map((item) => item.senderName), ['Ahmed', 'Another sender', 'Ahmed', 'Ahmed']);
});

test('optional metadata and invalid or unmatched contacts cannot break valid text parsing', () => {
  for (const contacts of [null, {}, 'bad', [null, [], {}, { wa_id: '971501234567', profile: 'bad' }], [{ wa_id: '971509876543', profile: { name: 'Other person' } }], [{ wa_id: '971501234567', profile: { name: 'x'.repeat(257) } }], [{ wa_id: '971501234567', profile: { name: 'Name\nInjected log' } }]]) {
    const body = payload();
    body.entry[0].id = {};
    body.entry[0].changes[0].value.metadata = [];
    body.entry[0].changes[0].value.contacts = contacts;
    const [parsed] = parseWhatsAppWebhook(body, { now });
    assert.equal(parsed.senderName, '');
    assert.equal(parsed.phoneNumberId, '');
    assert.equal(parsed.wabaId, '');
  }
});

test('malformed JSON-shaped nesting and status events are ignored safely', () => {
  const bodies = [null, undefined, true, 42, 'bad', [], {}, { object: 'other', entry: [] },
    { object: 'whatsapp_business_account', entry: {} },
    { object: 'whatsapp_business_account', entry: [null, [], 1, 'bad', { changes: null }, { changes: [null, [], {}, { field: 'messages', value: null }, { field: 'messages', value: [] }, { field: 'messages', value: { messages: {} } }] }] },
    payload([null, [], 1, 'bad', {}]),
  ];
  const status = payload();
  status.entry[0].changes[0].value = { statuses: [{ id: 'wamid.status', status: 'delivered' }] };
  bodies.push(status);
  for (const body of bodies) assert.deepEqual(parseWhatsAppWebhook(body, { now }), []);
});

test('media and unsupported messages are retained with enum-only diagnostics', () => {
  const diagnostics = [];
  const body = payload([message({ type: 'image' }), message({ type: 'interactive' }), message({ type: 'secret\nunsafe' }), message({ type: 'pastedtoken' }), message({ type: { private: true } }), message({ type: undefined }), message()]);
  const parsed = parseWhatsAppWebhook(body, { now, onUnsupported: (item) => diagnostics.push(item) });
  assert.deepEqual(parsed.map(item => item.messageType), ['image', 'interactive', 'unknown', 'unknown', 'text']);
  assert.deepEqual(diagnostics, [{ messageType: 'interactive' }, { messageType: 'unknown' }, { messageType: 'unknown' }]);
  assert.equal(parsed[0].text, '');
});

test('image and voice envelopes retain bounded private media references and captions', () => {
  const parsed = parseWhatsAppWebhook(payload([
    message({ id: 'wamid.image', type: 'image', image: { id: '123456789', mime_type: 'image/jpeg', caption: 'Customer details' } }),
    message({ id: 'wamid.audio', type: 'audio', audio: { id: '987654321', mime_type: 'audio/ogg; codecs=opus', voice: true } }),
    message({ id: 'wamid.document', type: 'document', document: { id: '123456780', mime_type: 'application/pdf', filename: 'details.pdf' } }),
  ]), { now });
  assert.equal(parsed[0].mediaId, '123456789');
  assert.equal(parsed[0].text, 'Customer details');
  assert.equal(parsed[1].text, '');
  assert.equal(parsed[1].mediaMimeType, 'audio/ogg; codecs=opus');
  assert.equal(parsed[2].mediaFilename, 'details.pdf');
  const [invalid] = parseWhatsAppWebhook(payload([message({ type: 'image', image: { id: 'https://private.invalid', mime_type: 'bad\nheader', filename: 'x'.repeat(256), caption: '\0' } })]), { now });
  assert.equal(invalid.mediaId, '');
  assert.equal(invalid.mediaMimeType, '');
  assert.equal(invalid.mediaFilename, '');
  assert.equal(invalid.text, '');
  assert.deepEqual(parseWhatsAppWebhook(payload([message({ type: 'audio', from: '971509876543' })]), { now, allowedSenders: new Set(['+971501234567']) }), []);
});

test('text validation preserves existing ID, sender, timestamp and size boundaries', () => {
  const invalid = [
    { id: null }, { id: '' }, { id: 'x'.repeat(513) }, { id: 'wamid.\ninvalid' },
    { from: {} }, { from: 'not-a-phone' }, { from: '012345678' }, { from: '1'.repeat(16) },
    { text: null }, { text: [] }, { text: { body: 42 } }, { text: { body: '  \n' } }, { text: { body: 'nul\0body' } }, { text: { body: '😀'.repeat(4097) } },
    { timestamp: 12345 }, { timestamp: '0' }, { timestamp: '-1' }, { timestamp: '1.5' }, { timestamp: '999999999999' }, { timestamp: String(now / 1000 + 301) },
  ];
  for (const overrides of invalid) assert.deepEqual(parseWhatsAppWebhook(payload([message(overrides)]), { now }), []);
  assert.equal(parseWhatsAppWebhook(payload([message({ text: { body: '😀'.repeat(4096) }, timestamp: String(now / 1000 + 300) })]), { now }).length, 1);
});

test('configured sender and destination filters remain enforced', () => {
  const options = { now, phoneNumberId: '1234567890', allowedSenders: new Set(['+971501234567']) };
  assert.equal(parseWhatsAppWebhook(payload(), options).length, 1);
  assert.deepEqual(parseWhatsAppWebhook(payload([message({ from: '971509876543' })]), options), []);
  assert.deepEqual(parseWhatsAppWebhook(payload(), { ...options, phoneNumberId: 'different' }), []);
  const otherProduct = payload();
  otherProduct.entry[0].changes[0].value.messaging_product = 'other';
  assert.deepEqual(parseWhatsAppWebhook(otherProduct, options), []);
});

test('legacy adapter retains the database contract and UTC timestamp conversion', () => {
  assert.deepEqual(parseIncomingMessages(payload(), { now }), [{
    whatsapp_message_id: 'wamid.parser-1', sender_phone: '+971501234567',
    message_text: message().text.body, message_type: 'text', received_at: new Date(now).toISOString(),
  }]);
});
