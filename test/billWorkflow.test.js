'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, validBill, WORKER } = require('./billFixtures');
const { createBillWorkflow, parseYesNo } = require('../src/services/books/billWorkflow');
const count = (f, name) => f.calls.filter(call => call[0] === name).length;

test('worker greeting requests a bill without extraction or Zoho calls', async () => {
  const f = fixture(); assert.match((await f.send('Hi')).replyText, /send the bill/i); assert.equal(f.calls.length, 0);
});
test('initial text persists pending bill and explicit options without creating it', async () => {
  const f = fixture(); const r = await f.send('Invoice details');
  assert.equal(r.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.match(r.replyText, /1 SAVE\n2 EDIT\n3 DELETE/); assert.match(r.replyText, /AED 105.00/);
  assert.equal((await f.billStore.getBill(r.billId)).status, 'PENDING_REVIEW'); assert.equal(count(f, 'create'), 0);
});
test('SAVE requires payment type and customer details, then accepts both before creation', async () => {
  const f = fixture({ bill: { ...validBill(), payment_type: null, customer_details: null } });
  const first = await f.send('Invoice details');
  assert.match((await f.send('SAVE')).replyText, /payment method and customer details/i);
  await f.send('EDIT');
  const updated = await f.send('Payment method: Bank transfer; Customer: Gulf Client, +971501112233, Abu Dhabi site');
  assert.equal(updated.bill.payment_type, 'Bank Transfer');
  assert.deepEqual(updated.bill.customer_details, { customer_name: 'Gulf Client', customer_phone: '+971501112233', project_site: 'Abu Dhabi site' });
  await f.send('SAVE'); assert.equal(count(f, 'create'), 1); assert.equal((await f.billStore.getBill(first.billId)).payment_type, 'Bank Transfer');
  assert.equal(f.calls.find(call => call[0] === 'create')[1].paymentType, 'Bank Transfer');
  assert.match(f.calls.find(call => call[0] === 'create')[1].notes, /Payment method: Bank Transfer/);
});
test('unsupported payment methods are rejected and not stored', async () => {
  const f = fixture({ bill: { ...validBill(), payment_type: null } }); const r = await f.send('Invoice details');
  const response = await f.send('Payment method: Credit; Customer: ABC Contracting');
  assert.match(response.replyText, /Cash, Bank Remittance, Bank Transfer, Credit Card, Cheque/);
  assert.equal((await f.billStore.getBill(r.billId)).payment_type, null);
});
test('Zoho customer selection is requested before payment and preserves the selected customer', async () => {
  const f = fixture({
    bill: { ...validBill(), payment_type: null, customer_details: null },
    zohoOverrides: { async searchCustomer() { f.calls.push(['customers']); return [{ id: 'cust-1', name: 'Gulf Client', phone: '+971501112233' }]; } },
  });
  const first = await f.send('Invoice details');
  assert.equal(first.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(first.replyInteractive.sections[0].rows[0].id, 'zoho-customer:cust-1');
  const selected = await f.send('Gulf Client', { messageType: 'interactive', interactiveId: 'zoho-customer:cust-1' });
  assert.equal(selected.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.match(selected.replyText, /payment method: Cash \/ Bank Remittance \/ Bank Transfer \/ Credit Card \/ Cheque/i);
  assert.equal(selected.bill.customer_details.customer_id, 'cust-1');
  const method = await f.send('Cash');
  assert.equal(method.bill.payment_type, 'Cash');
  assert.equal((await f.billStore.getBill(first.billId)).payment_type, 'Cash');
});
test('media is persisted and OCR runs even when an image has a caption', async () => {
  const f = fixture(); const r = await f.send('Fuel expense', { messageType: 'image', mediaId: '123' });
  assert.equal(count(f, 'ocr'), 1); assert.match(f.calls.find(c => c[0] === 'extract')[1].text, /Supplier LLC[\s\S]*Fuel expense/);
  assert.equal((await f.billStore.getBillSession(r.sessionId)).attachments.length, 1); assert.equal(f.media.size, 1); assert.match(r.replyText, /SAVE/);
});
test('unreadable or expired media responds honestly without inventing a bill', async () => {
  const f = fixture({ whatsappOverrides: { async downloadMedia() { throw Error('secret-token'); } } });
  const r = await f.send('', { mediaId: '123', messageType: 'image' });
  assert.match(r.replyText, /could not read/); assert.doesNotMatch(r.replyText, /secret-token/); assert.equal(count(f, 'extract'), 0); assert.equal(f.billStore.sessions.size, 0);
});
for (const text of ['YES', 'NO', 'okay', '?']) test(`${text} never authorizes bill creation`, async () => {
  const f = fixture(); await f.send('Bill'); await f.send(text); assert.equal(count(f, 'create'), 0); assert.ok(await f.billStore.getActiveBillSession(WORKER));
});
test('EDIT/2 supports repeated corrections and preserves unrelated fields', async () => {
  const f = fixture(); const initial = await f.send('Bill');
  for (const cmd of ['EDIT', '2']) {
    assert.equal((await f.send(cmd)).state, 'WAITING_FOR_EDIT_INSTRUCTION');
    const result = await f.send('Additional project reference'); assert.match(result.replyText, /1 SAVE/);
    const bill = await f.billStore.getBill(initial.billId); assert.equal(bill.vendor_name, 'Supplier LLC'); assert.equal(bill.total_amount, 105); assert.equal(bill.notes, 'Additional project reference');
  }
  assert.equal(count(f, 'create'), 0);
});
for (const type of ['image', 'audio', 'document']) test(`EDIT accepts ${type} correction and retains original attachment`, async () => {
  const f = fixture(); const first = await f.send('', { messageType: 'image', mediaId: '1' });
  await f.send('EDIT'); await f.send('extra page', { messageType: type, mediaId: '2' });
  assert.equal((await f.billStore.getBillSession(first.sessionId)).attachments.length, 2); assert.equal(count(f, 'merge'), 1); assert.equal(count(f, 'create'), 0);
});
test('unrequested second bill cannot overwrite the current review', async () => {
  const f = fixture(); const first = await f.send('Bill'); const r = await f.send('', { mediaId: '2', messageType: 'image' });
  assert.match(r.replyText, /already pending/); assert.equal(r.sessionId, first.sessionId); assert.equal(count(f, 'extract'), 1);
});
for (const cmd of ['DELETE', '3']) test(`${cmd} cancels only this pending draft and allows a fresh session`, async () => {
  const f = fixture(); const first = await f.send('Bill'); await f.send(cmd);
  assert.equal(await f.billStore.getActiveBillSession(WORKER), undefined); assert.deepEqual((await f.billStore.getBillSession(first.sessionId)).bill_data, {});
  const second = await f.send('Next bill'); assert.notEqual(second.sessionId, first.sessionId); assert.equal(count(f, 'create'), 0);
});
for (const cmd of ['SAVE', '1']) test(`${cmd} creates once, persists ID before PDF, and sends created bytes`, async () => {
  const f = fixture(); const first = await f.send('Bill');
  f.zoho.getBillPdf = async id => { assert.equal((await f.billStore.getBill(first.billId)).zoho_bill_id, id); return { buffer: Buffer.from('%PDF-created-record') }; };
  const result = await f.send(cmd); assert.equal(result.state, 'COMPLETED'); assert.equal(count(f, 'create'), 1);
  const sent = f.calls.find(c => c[0] === 'document'); assert.equal(sent[1], WORKER); assert.equal(sent[2].buffer.toString(), '%PDF-created-record');
  await f.send(cmd); assert.equal(count(f, 'create'), 1); assert.equal(count(f, 'document'), 1);
});
for (const changes of [{ vendor_name: null }, { bill_date: '2026-02-31' }, { total_amount: -1 }, { bill_number: null }, { currency: null }, { line_items: [] }]) test(`incomplete/invalid bill blocks SAVE: ${Object.keys(changes)[0]}`, async () => {
  const f = fixture({ bill: { ...validBill(), ...changes } }); await f.send('Bill'); const r = await f.send('SAVE'); assert.match(r.replyText, /Cannot save/); assert.equal(count(f, 'create'), 0);
});
test('missing and ambiguous vendor never creates a vendor or bill', async () => {
  for (const vendors of [[], [{ id: '1', name: 'Supplier LLC' }, { id: '2', name: 'Supplier LLC' }]]) {
    const f = fixture({ zohoOverrides: { async searchVendor() { return vendors; } } }); await f.send('Bill'); assert.match((await f.send('SAVE')).replyText, /not found or ambiguous/); assert.equal(count(f, 'create'), 0);
  }
});
test('Zoho duplicate or lookup failure prevents POST', async () => {
  for (const check of [async () => ({ found: true, bills: [{ id: 'existing' }] }), async () => { throw Error('secret'); }]) {
    const f = fixture({ zohoOverrides: { checkDuplicateBill: check } }); await f.send('Bill'); await f.send('SAVE'); assert.equal(count(f, 'create'), 0);
  }
});
test('uncertain Zoho create stays locked across retries and cannot be deleted', async () => {
  let creates = 0; const f = fixture({ zohoOverrides: { async createBill() { creates++; throw Error('private'); } } });
  await f.send('Bill'); assert.match((await f.send('SAVE')).replyText, /unconfirmed|could not be confirmed/);
  await f.send('SAVE'); await f.send('DELETE'); assert.equal(creates, 1); assert.equal((await f.billStore.getActiveBillSession(WORKER)).state, 'CREATING_IN_ZOHO');
});
test('missing create ID is uncertain and never retried automatically', async () => {
  let creates = 0; const f = fixture({ zohoOverrides: { async createBill() { creates++; return {}; } } }); await f.send('Bill'); await f.send('SAVE'); await f.send('SAVE'); assert.equal(creates, 1);
});
test('PDF retrieval failure retries PDF only and retains saved bill ID', async () => {
  const f = fixture(); await f.send('Bill'); const getPdf = f.zoho.getBillPdf; f.zoho.getBillPdf = async () => { throw Error('unavailable'); };
  assert.match((await f.send('SAVE')).replyText, /PDF could not be retrieved/); f.zoho.getBillPdf = getPdf;
  assert.equal((await f.send('SAVE')).state, 'COMPLETED'); assert.equal(count(f, 'create'), 1);
});
test('unknown PDF delivery is never auto resent; explicit failure can retry', async () => {
  for (const state of ['UNKNOWN', 'ATTEMPTED_FAILED']) {
    let attempts = 0; const f = fixture({ whatsappOverrides: { async sendDocument() { attempts++; throw Object.assign(Error('delivery'), { deliveryState: state }); } } });
    await f.send('Bill'); await f.send('SAVE'); await f.send('SAVE'); assert.equal(attempts, state === 'UNKNOWN' ? 1 : 2); assert.equal(count(f, 'create'), 1);
  }
});
test('attachment failure is reported but never recreates the saved bill', async () => {
  const f = fixture({ zohoOverrides: { async attachBillFile() { throw Error('upload'); } } }); await f.send('', { mediaId: '1', messageType: 'image' });
  assert.match((await f.send('SAVE')).replyText, /attachment upload failed/); await f.send('SAVE'); assert.equal(count(f, 'create'), 1);
});
test('duplicate message and concurrent SAVE cannot create twice', async () => {
  const f = fixture(); await f.send('Bill', { messageId: 'same' }); assert.equal((await f.send('Bill', { messageId: 'same' })).idempotent, true);
  await Promise.all([f.send('SAVE'), f.send('SAVE')]); assert.equal(count(f, 'create'), 1);
});
test('workers have separate sessions', async () => {
  const f = fixture(); const a = await f.send('Bill'); const b = await f.send('Bill', { senderPhone: '+971501234567' }); assert.notEqual(a.sessionId, b.sessionId);
  await f.send('DELETE'); assert.ok(await f.billStore.getActiveBillSession('+971501234567'));
});
test('defensive authorization blocks a non-worker', async () => {
  const f = fixture(); const flow = createBillWorkflow({ billStore: f.billStore, config: { booksSenders: new Set([WORKER]) } });
  assert.equal((await flow.processMessage({ senderPhone: '+971501234567', text: 'Hi' })).success, false);
});
test('legacy YES/NO parser remains compatible but does not authorize writes', () => {
  assert.equal(parseYesNo(' Yes! '), 'YES'); assert.equal(parseYesNo('no'), 'NO'); assert.equal(parseYesNo('SAVE'), null);
});

test('inferred source fields remain missing in the review instead of becoming facts', async () => {
  const f = fixture({ extractionOverrides: { async extractBillFromText() { return { success: true, bill: validBill(), grounding: { vendor_name: 'inferred', currency: 'inferred' } }; } } });
  const result = await f.send('Bill'); assert.equal(result.bill.vendor_name, null); assert.equal(result.bill.currency, null); await f.send('SAVE'); assert.equal(count(f, 'create'), 0);
});
test('an incomplete edit response cannot erase existing unrelated fields', async () => {
  const f = fixture({ extractionOverrides: { async applyEditInstructions() { return { success: true, bill: { vendor_name: null, line_items: [], notes: 'updated' } }; } } });
  await f.send('Bill'); await f.send('EDIT'); const result = await f.send('notes updated'); assert.equal(result.bill.vendor_name, 'Supplier LLC'); assert.equal(result.bill.line_items.length, 1); assert.equal(result.bill.notes, 'updated');
});
