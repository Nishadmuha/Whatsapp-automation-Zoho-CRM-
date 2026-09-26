'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, validBill, memoryStore, WORKER } = require('./billFixtures');
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
test('taxed line missing its percentage is collected before exactly one final review', async () => {
  const bill = validBill();
  bill.line_items = [{ ...bill.line_items[0], tax_percentage: null }];
  let prepared = 0;
  const f = fixture({ bill, zohoOverrides: {
    async prepareBill(candidate) { prepared++; assert.equal(candidate.line_items[0].tax_percentage, 5); },
  } });
  const first = await f.send('Invoice details');
  assert.equal(first.state, 'WAITING_FOR_ADDITIONAL_INFO');
  assert.match(first.replyText, /Tax percentage missing for line 1/);
  assert.doesNotMatch(first.replyText, /BILL DETAILS|1 SAVE/);
  const review = await f.send('Line 1 tax: 5%');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.match(review.replyText, /BILL DETAILS/);
  assert.equal((await f.billStore.getBill(first.billId)).line_items[0].tax_percentage, 5);
  const saved = await f.send('SAVE');
  assert.equal(saved.state, 'COMPLETED');
  assert.equal(prepared, 1);
  assert.equal([first, review, saved].filter(result => /BILL DETAILS/.test(result.replyText)).length, 1);
});
test('currency detected automatically remains normalized and reaches Zoho on SAVE', async () => {
  const f = fixture(); const first = await f.send('Invoice details');
  assert.equal(first.bill.currency, 'AED');
  await f.send('SAVE');
  assert.equal(f.calls.find(call => call[0] === 'create')[1].currency, 'AED');
});
test('missing currency prompts the worker and keeps the pending bill', async () => {
  const f = fixture({ bill: { ...validBill(), currency: null } });
  const result = await f.send('Invoice details');
  assert.equal(result.state, 'WAITING_FOR_CURRENCY');
  assert.match(result.replyText, /Currency not detected\. Please enter the currency \(e\.g\. AED, USD, EUR\)\./);
  assert.equal((await f.billStore.getBillSession(result.sessionId)).state, 'WAITING_FOR_CURRENCY');
  assert.equal(count(f, 'create'), 0);
});
for (const input of ['AED', 'aed']) test(`worker currency input ${input} is stored as AED`, async () => {
  const f = fixture({ bill: { ...validBill(), currency: null } });
  const first = await f.send('Invoice details');
  const result = await f.send(input);
  assert.equal(result.bill.currency, 'AED');
  assert.match(result.replyText, /AED 105\.00/);
  assert.equal((await f.billStore.getBill(first.billId)).currency, 'AED');
});
test('SAVE without currency is blocked before Zoho calls', async () => {
  const f = fixture({ bill: { ...validBill(), currency: null } });
  const first = await f.send('Invoice details');
  const result = await f.send('1');
  assert.equal(result.state, 'WAITING_FOR_CURRENCY');
  assert.match(result.replyText, /Currency not detected/);
  assert.equal(count(f, 'create'), 0);
  assert.equal((await f.billStore.getBill(first.billId)).zoho_bill_id, undefined);
});
test('SAVE after entering currency proceeds with the normalized currency', async () => {
  const f = fixture({ bill: { ...validBill(), currency: null } });
  await f.send('Invoice details'); await f.send('aed');
  const result = await f.send('1');
  assert.equal(result.state, 'COMPLETED');
  assert.equal(count(f, 'create'), 1);
  assert.equal(f.calls.find(call => call[0] === 'create')[1].currency, 'AED');
});
test('currency entry continues customer selection and payment type workflows', async () => {
  const f = fixture({
    bill: { ...validBill(), currency: null, payment_type: null, customer_details: null },
    zohoOverrides: {
      async searchCustomer() { return [{ id: 'customer-1', name: 'Gulf Client', phone: '+971501112233' }]; },
      async getCustomer(id) { assert.equal(id, 'customer-1'); return { id, name: 'Gulf Client', phone: '+971501112233' }; },
    },
  });
  const first = await f.send('Invoice details');
  assert.equal(first.state, 'WAITING_FOR_CURRENCY');
  const currency = await f.send('AED');
  assert.equal(currency.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.doesNotMatch(currency.replyText, /BILL DETAILS|1 SAVE/);
  assert.equal(currency.bill.currency, 'AED');
  const selected = await f.send('Select', { interactiveId: 'zoho-customer:customer-1' });
  assert.equal(selected.state, 'WAITING_FOR_ADDITIONAL_INFO');
  assert.doesNotMatch(selected.replyText, /BILL DETAILS|1 SAVE/);
  const payment = await f.send('Cash');
  assert.equal(payment.bill.payment_type, 'Cash');
  assert.equal(payment.state, 'AWAITING_FINAL_CONFIRMATION');
  await f.send('SAVE');
  assert.equal(count(f, 'create'), 1);
  assert.equal(f.calls.find(call => call[0] === 'create')[1].currency, 'AED');
  assert.equal(f.calls.find(call => call[0] === 'create')[1].customerId, 'customer-1');
  assert.equal((await f.billStore.getBill(first.billId)).payment_type, 'Cash');
});

test('multiple missing fields produce one final review only after currency, customer and payment are complete', async () => {
  const f = fixture({
    bill: { ...validBill(), currency: null, customer_details: null, payment_type: null },
    zohoOverrides: {
      async searchCustomer() { return [{ contactId: 'cust-1', contactName: 'Project Customer', status: 'active' }]; },
    },
  });
  const replies = [await f.send('Invoice details')];
  assert.equal(replies[0].state, 'WAITING_FOR_CURRENCY');
  replies.push(await f.send('AED'));
  assert.equal(replies[1].state, 'WAITING_FOR_CUSTOMER_SELECTION');
  replies.push(await f.send('Select', { interactiveId: 'zoho-customer:cust-1' }));
  assert.equal(replies[2].state, 'WAITING_FOR_ADDITIONAL_INFO');
  replies.push(await f.send('Cash'));
  assert.equal(replies[3].state, 'AWAITING_FINAL_CONFIRMATION');
  assert.deepEqual(replies.map(result => (result.replyText.match(/BILL DETAILS/g) || []).length), [0, 0, 0, 1]);
  assert.deepEqual(replies.map(result => /1 SAVE\n2 EDIT\n3 DELETE/.test(result.replyText)), [false, false, false, true]);
});

test('missing vendor is requested as extraction information, not reported absent from Zoho', async () => {
  const f = fixture({ bill: { ...validBill(), vendor_name: null } });
  const first = await f.send('Invoice details');
  assert.match(first.replyText, /Vendor was not detected/);
  assert.doesNotMatch(first.replyText, /Vendor not found|BILL DETAILS|1 SAVE/);
  assert.equal(count(f, 'vendor'), 0);
  const supplied = await f.send('Vendor: Supplier LLC');
  assert.equal(supplied.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(supplied.bill.vendor_name, 'Supplier LLC');
});

test('explicit customer correction clears the old ID until the new customer is selected', async () => {
  const old = { customer_name: '800 MOTOR GURU', contact_id: 'old-id', customer_id: 'old-id', organization_id: '828765858', customer_phone: '+971500000000', customer_email: 'old@example.invalid' };
  const newCustomer = { contactId: 'new-id', contactName: 'ABC Contact', companyName: 'ABC Contracting', phone: '+971501234567', email: 'new@example.invalid', status: 'active', contactType: 'customer' };
  const f = fixture({ bill: { ...validBill(), customer_details: old }, zohoOverrides: {
    async searchCustomer({ organizationId }) { assert.equal(organizationId, '828765858'); return [newCustomer]; },
    async getCustomer(id, { organizationId }) { assert.equal(id, 'new-id'); assert.equal(organizationId, '828765858'); return newCustomer; },
  } });
  const first = await f.send('Invoice details');
  assert.equal(first.state, 'AWAITING_FINAL_CONFIRMATION');
  const changed = await f.send('Customer: ABC Contracting, 0501234567, Dubai site');
  assert.equal(changed.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(changed.bill.customer_details.customer_name, 'ABC Contracting');
  assert.equal(changed.bill.customer_details.contact_id, undefined);
  assert.equal(changed.bill.customer_details.customer_email, undefined);
  assert.equal((await f.billStore.getBill(first.billId)).customer_details.contact_id, undefined);
  assert.doesNotMatch(changed.replyText, /BILL DETAILS|1 SAVE/);
  const selected = await f.send('Select', { interactiveId: 'zoho-customer:new-id' });
  assert.equal(selected.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(selected.bill.customer_details.contact_id, 'new-id');
  assert.equal(selected.bill.customer_details.customer_email, 'new@example.invalid');
  assert.equal(selected.bill.customer_details.customer_status, 'active');
  await f.send('SAVE');
  assert.equal(f.calls.find(call => call[0] === 'create')[1].customerId, 'new-id');
});

test('customer name supplied during selection replaces stale OCR details and searches the selected organization', async () => {
  const searches = [];
  const f = fixture({ bill: { ...validBill(), customer_details: null }, zohoOverrides: {
    async searchCustomer({ searchText, organizationId }) {
      searches.push([searchText, organizationId]);
      return searchText ? [{ contactId: 'new-customer', contactName: 'ABC Contracting', status: 'active' }]
        : [{ contactId: 'old-customer', contactName: '800 MOTOR GURU', status: 'active' }];
    },
  } });
  const first = await f.send('Invoice details');
  assert.equal(first.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  const updated = await f.send('Customer: ABC Contracting, 0501234567, Dubai site');
  assert.equal(updated.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.deepEqual(searches, [['', '828765858'], ['ABC Contracting', '828765858']]);
  assert.equal(updated.replyInteractive.sections[0].rows[0].id, 'zoho-customer:new-customer');
  const selected = await f.send('Select', { interactiveId: 'zoho-customer:new-customer' });
  assert.equal(selected.bill.customer_details.contact_id, 'new-customer');
});
test('EDIT can change the pending bill currency', async () => {
  const f = fixture();
  await f.send('Invoice details'); await f.send('EDIT');
  const result = await f.send('currency usd');
  assert.equal(result.bill.currency, 'USD');
  assert.match(result.replyText, /USD 105\.00/);
  assert.equal((await f.billStore.getBill(result.billId)).currency, 'USD');
});
test('DELETE clears a pending bill waiting for currency', async () => {
  const f = fixture({ bill: { ...validBill(), currency: null } });
  const first = await f.send('Invoice details'); await f.send('DELETE');
  assert.equal(await f.billStore.getActiveBillSession(WORKER), undefined);
  assert.deepEqual((await f.billStore.getBillSession(first.sessionId)).bill_data, {});
  assert.equal(count(f, 'create'), 0);
});
test('SAVE requires payment type and customer details, then accepts both before creation', async () => {
  const f = fixture({ bill: { ...validBill(), payment_type: null, customer_details: null } });
  const first = await f.send('Invoice details');
  assert.match((await f.send('SAVE')).replyText, /payment method/i);
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
  assert.equal(selected.state, 'WAITING_FOR_ADDITIONAL_INFO');
  assert.match(selected.replyText, /payment method: Cash \/ Bank Remittance \/ Bank Transfer \/ Credit Card \/ Cheque/i);
  assert.doesNotMatch(selected.replyText, /BILL DETAILS|1 SAVE/);
  assert.equal(selected.bill.customer_details.customer_id, 'cust-1');
  const method = await f.send('Cash');
  assert.equal(method.bill.payment_type, 'Cash');
  assert.equal(method.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal((await f.billStore.getBill(first.billId)).payment_type, 'Cash');
});
test('media is persisted and OCR runs even when an image has a caption', async () => {
  const f = fixture(); const r = await f.send('Fuel expense', { messageType: 'image', mediaId: '123' });
  assert.equal(count(f, 'ocr'), 1); assert.match(f.calls.find(c => c[0] === 'extract')[1].text, /Supplier LLC[\s\S]*Fuel expense/);
  assert.equal((await f.billStore.getBillSession(r.sessionId)).attachments.length, 1); assert.equal(f.media.size, 1); assert.match(r.replyText, /SAVE/);
});
test('clear invoice image reaches the existing Zoho customer-selection workflow', async () => {
  const f = fixture({ zohoOverrides: { async searchCustomer() { return [{ id: 'customer-1', name: 'Voltronix Contracting LLC' }]; } } });
  const result = await f.send('', { messageType: 'image', mediaId: 'clear-invoice' });
  assert.equal(result.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(result.bill.vendor_name, 'Supplier LLC');
  assert.equal(result.bill.total_amount, 105);
  assert.equal((await f.billStore.getBillSession(result.sessionId)).attachments.length, 1);
  assert.match(result.replyText, /select the customer/i);
});
test('photographed invoice with a large table falls back to direct vision', async () => {
  const tableBill = { ...validBill(), line_items: Array.from({ length: 24 }, (_, index) => ({ name: `Table item ${index + 1}`, quantity: 1, rate: 10, amount: 10, tax_percentage: null })) };
  const f = fixture({
    zohoOverrides: { async searchCustomer() { return [{ id: 'customer-1', name: 'Voltronix Contracting LLC' }]; } },
    aiOverrides: { async extractMediaText() { return 'TAX INVOICE Supplier LLC Total AED 240 table rows with photographed perspective'; } },
    extractionOverrides: {
      async extractBillFromText(input) { f.calls.push(['extract', input]); return { success: true, bill: { vendor_name: null, total_amount: null, line_items: [] } }; },
      async extractBillFromMedia(input) { f.calls.push(['vision', input]); return { success: true, bill: tableBill }; },
    },
  });
  const result = await f.send('', { messageType: 'image', mediaId: 'large-table-photo' });
  assert.equal(result.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal(result.bill.line_items.length, 24);
  assert.equal(count(f, 'extract'), 1);
  assert.equal(count(f, 'vision'), 1);
});
test('partially unreadable optional fields remain null while customer selection continues', async () => {
  const f = fixture({
    bill: { ...validBill(), bill_number: null, bill_date: null, due_date: null, currency: null, subtotal: null, tax_amount: null },
    zohoOverrides: { async searchCustomer() { return [{ id: 'customer-1', name: 'Voltronix Contracting LLC' }]; } },
  });
  const result = await f.send('', { messageType: 'image', mediaId: 'partial-optional-fields' });
  assert.equal(result.state, 'WAITING_FOR_CURRENCY');
  assert.equal(result.bill.vendor_name, 'Supplier LLC');
  assert.equal(result.bill.total_amount, 105);
  assert.equal(result.bill.bill_number, null);
  assert.equal(result.bill.bill_date, null);
  assert.equal(result.bill.currency, null);
});
test('multi-page PDF keeps every original page for extraction and Zoho attachment', async () => {
  const f = fixture({
    whatsappOverrides: {
      async downloadMedia(id) { f.calls.push(['download', id]); return { buffer: Buffer.from(`%PDF-${id}`), mimeType: 'application/pdf' }; },
    },
    aiOverrides: { async extractMediaText() { throw Object.assign(Error('OCR unavailable'), { code: 'AI_MEDIA_EXTRACTION_FAILED' }); } },
    extractionOverrides: {
      async extractBillFromMedia(input) { f.calls.push(['vision', input]); assert.equal(input.media.length, 2); return { success: true, bill: validBill() }; },
    },
    zohoOverrides: { async searchCustomer() { return [{ id: 'customer-1', name: 'Voltronix Contracting LLC' }]; } },
  });
  const result = await f.send('', { items: [
    { messageType: 'document', mediaId: 'page-1', mediaMimeType: 'application/pdf' },
    { messageType: 'document', mediaId: 'page-2', mediaMimeType: 'application/pdf' },
  ] });
  assert.equal(result.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  assert.equal((await f.billStore.getBillSession(result.sessionId)).attachments.length, 2);
  await f.send('Select customer', { interactiveId: 'zoho-customer:customer-1' });
  await f.send('SAVE');
  const attachments = f.calls.filter(call => call[0] === 'attach').map(call => call[1].buffer.toString());
  assert.deepEqual(attachments, ['%PDF-page-1', '%PDF-page-2']);
});
test('low-quality but readable image falls back from failed OCR to structured vision', async () => {
  const logs = [];
  const f = fixture({
    aiOverrides: { async extractMediaText() { throw Object.assign(Error('unreadable OCR'), { code: 'AI_MEDIA_EXTRACTION_FAILED' }); } },
    logger: { info: (entry) => logs.push(entry), warn: (entry) => logs.push(entry), error: (entry) => logs.push(entry) },
  });
  const result = await f.send('', { messageType: 'image', mediaId: 'low-quality' });
  assert.equal(count(f, 'vision'), 1);
  assert.equal(count(f, 'extract'), 0);
  assert.match(result.replyText, /SAVE/);
  assert.ok(logs.some((entry) => entry.event === 'books.bill_media_pipeline.vision_fallback' && entry.reason === 'OCR_FAILED'));
});
test('partial OCR text uses direct vision and does not require every optional field', async () => {
  const partialBill = { ...validBill(), due_date: null, subtotal: null, tax_amount: null, notes: null };
  const f = fixture({
    bill: partialBill,
    aiOverrides: { async extractMediaText(input) { f.calls.push(['ocr', input]); return 'Supplier LLC INV-100'; } },
  });
  const result = await f.send('', { messageType: 'image', mediaId: 'partial' });
  assert.equal(count(f, 'vision'), 1);
  assert.equal(count(f, 'extract'), 0);
  assert.equal(result.bill.total_amount, 105);
  assert.equal(result.bill.due_date, null);
});
test('malformed AI JSON is logged as category C after media fallback', async () => {
  const logs = [];
  const f = fixture({
    aiOverrides: { async extractMediaText() { throw Object.assign(Error('no OCR'), { code: 'AI_MEDIA_EXTRACTION_FAILED' }); } },
    extractionOverrides: { async extractBillFromMedia(input) { f.calls.push(['vision', input]); return { success: false, bill: null, error: { code: 'AI_MALFORMED_RESPONSE' } }; } },
    logger: { info: (entry) => logs.push(entry), warn: (entry) => logs.push(entry), error: (entry) => logs.push(entry) },
  });
  const result = await f.send('', { messageType: 'image', mediaId: 'malformed' });
  assert.match(result.replyText, /could not read/);
  assert.equal(f.billStore.sessions.size, 0);
  assert.ok(logs.some((entry) => entry.category === 'C_INVALID_AI_JSON' && entry.reason === 'AI_MALFORMED_RESPONSE'));
});
test('genuinely unreadable image is logged as category B without creating a draft', async () => {
  const logs = [];
  const f = fixture({
    aiOverrides: { async extractMediaText() { throw Object.assign(Error('no OCR'), { code: 'AI_MEDIA_EXTRACTION_FAILED' }); } },
    extractionOverrides: { async extractBillFromMedia(input) { f.calls.push(['vision', input]); return { success: false, bill: null, error: { code: 'AI_REQUEST_FAILED' } }; } },
    logger: { info: (entry) => logs.push(entry), warn: (entry) => logs.push(entry), error: (entry) => logs.push(entry) },
  });
  const result = await f.send('', { messageType: 'image', mediaId: 'unreadable' });
  assert.match(result.replyText, /could not read/);
  assert.equal(f.billStore.sessions.size, 0);
  assert.ok(logs.some((entry) => entry.category === 'B_OCR_VISION_EXTRACTION_FAILURE' && entry.reason === 'AI_REQUEST_FAILED'));
});
test('vision output with no bill facts is logged as genuinely insufficient information', async () => {
  const logs = [];
  const emptyBill = { vendor_name: null, bill_number: null, bill_date: null, due_date: null, currency: null, subtotal: null, tax_amount: null, total_amount: null, line_items: [], payment_type: null, notes: null };
  const f = fixture({
    aiOverrides: { async extractMediaText() { throw Object.assign(Error('no OCR'), { code: 'AI_MEDIA_EXTRACTION_FAILED' }); } },
    extractionOverrides: { async extractBillFromMedia(input) { f.calls.push(['vision', input]); return { success: true, bill: emptyBill }; } },
    logger: { info: (entry) => logs.push(entry), warn: (entry) => logs.push(entry), error: (entry) => logs.push(entry) },
  });
  const result = await f.send('', { messageType: 'image', mediaId: 'blank' });
  assert.match(result.replyText, /could not read/);
  assert.equal(f.billStore.sessions.size, 0);
  assert.ok(logs.some((entry) => entry.category === 'D_INSUFFICIENT_BILL_INFORMATION'));
});
test('vision fallback preserves the original media bytes for Zoho attachment', async () => {
  const original = Buffer.from('original-low-quality-image-bytes');
  const f = fixture({
    whatsappOverrides: { async downloadMedia(id) { f.calls.push(['download', id]); return { buffer: original, mimeType: 'image/jpeg' }; } },
    aiOverrides: { async extractMediaText() { throw Object.assign(Error('weak OCR'), { code: 'AI_MEDIA_EXTRACTION_FAILED' }); } },
  });
  await f.send('', { messageType: 'image', mediaId: 'preserved' });
  await f.send('SAVE');
  const vision = f.calls.find((call) => call[0] === 'vision')[1];
  const attachment = f.calls.find((call) => call[0] === 'attach')[1];
  assert.equal(vision.media[0].buffer.equals(original), true);
  assert.equal(attachment.buffer.equals(original), true);
});
test('unreadable or expired media responds honestly without inventing a bill', async () => {
  const logs = [];
  const f = fixture({
    whatsappOverrides: { async downloadMedia() { throw Error('secret-token'); } },
    logger: { info: (entry) => logs.push(entry), warn: (entry) => logs.push(entry), error: (entry) => logs.push(entry) },
  });
  const r = await f.send('', { mediaId: '123', messageType: 'image' });
  assert.match(r.replyText, /could not read/); assert.doesNotMatch(r.replyText, /secret-token/); assert.equal(count(f, 'extract'), 0); assert.equal(f.billStore.sessions.size, 0);
  assert.ok(logs.some((entry) => entry.category === 'A_MEDIA_DOWNLOAD_FAILURE'));
  assert.doesNotMatch(JSON.stringify(logs), /secret-token/);
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
for (const changes of [{ vendor_name: null }, { bill_date: '2026-02-31' }, { total_amount: -1 }, { bill_number: null }, { line_items: [] }]) test(`incomplete/invalid bill blocks SAVE: ${Object.keys(changes)[0]}`, async () => {
  const f = fixture({ bill: { ...validBill(), ...changes } }); const first = await f.send('Bill'); const r = await f.send('SAVE');
  assert.doesNotMatch(first.replyText, /BILL DETAILS|1 SAVE/);
  assert.doesNotMatch(r.replyText, /BILL DETAILS|1 SAVE/);
  assert.equal(count(f, 'create'), 0);
});
test('vendor absent without creation support or ambiguous vendor never creates a bill', async () => {
  const absent = fixture({ zohoOverrides: { async searchVendor() { return []; } } });
  await absent.send('Bill');
  assert.match((await absent.send('SAVE')).replyText, /Vendor not found or ambiguous/);
  assert.equal(count(absent, 'create'), 0);
  const ambiguous = fixture({ zohoOverrides: { async searchVendor() { return [{ id: '1', name: 'Supplier LLC' }, { id: '2', name: 'Supplier LLC' }]; } } });
  const first = await ambiguous.send('Bill');
  assert.match(first.replyText, /Multiple vendors match/);
  assert.doesNotMatch(first.replyText, /BILL DETAILS|1 SAVE/);
  assert.equal(count(ambiguous, 'create'), 0);
});

test('punctuation and case differences reuse the exact existing vendor ID without creating a duplicate', async () => {
  const f = fixture({ bill: { ...validBill(), vendor_name: 'Meitech International FZC' }, zohoOverrides: {
    async searchVendor({ organizationId }) {
      assert.equal(organizationId, '828765858');
      return [{ id: 'meitech-existing', name: 'MEITECH International F.Z.C.', status: 'active', organizationId }];
    },
    async createVendor() { assert.fail('Existing vendor must not be duplicated'); },
  } });
  const first = await f.send('Invoice details');
  assert.equal(first.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(first.bill.zoho_vendor_id, 'meitech-existing');
  await f.send('SAVE');
  assert.equal(f.calls.find(call => call[0] === 'create')[1].vendorId, 'meitech-existing');
  assert.equal((await f.billStore.getBill(first.billId)).zoho_vendor_id, 'meitech-existing');
});

test('vendor absent after complete lookup is created only on SAVE and its new ID is used once', async () => {
  let vendorCreates = 0;
  const f = fixture({ zohoOverrides: {
    async searchVendor({ organizationId }) { assert.equal(organizationId, '828765858'); return []; },
    async createVendor({ name, organizationId }) {
      vendorCreates++;
      assert.equal(name, 'Supplier LLC');
      assert.equal(organizationId, '828765858');
      return { id: 'new-vendor', name, organizationId, status: 'active' };
    },
  } });
  const first = await f.send('Invoice details');
  assert.equal(first.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(vendorCreates, 0);
  await f.send('SAVE');
  assert.equal(vendorCreates, 1);
  assert.equal(f.calls.find(call => call[0] === 'create')[1].vendorId, 'new-vendor');
  assert.equal((await f.billStore.getBill(first.billId)).zoho_vendor_id, 'new-vendor');
  await f.send('SAVE');
  assert.equal(vendorCreates, 1);
  assert.equal(count(f, 'create'), 1);
});

test('two concurrent bill saves reuse one newly created vendor within the same organization', async () => {
  const billStore = memoryStore();
  const tails = new Map();
  const sourceStore = { async withContactLock(key, run) {
    const prior = tails.get(key) || Promise.resolve();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const next = prior.then(() => held);
    tails.set(key, next);
    await prior;
    try { return await run(); } finally { release(); if (tails.get(key) === next) tails.delete(key); }
  } };
  let vendor = null, creates = 0;
  const zohoOverrides = {
    async searchVendor() { return vendor ? [vendor] : []; },
    async createVendor({ name, organizationId }) {
      creates++;
      await new Promise(resolve => setTimeout(resolve, 10));
      vendor = { id: 'shared-vendor', name, organizationId, status: 'active' };
      return vendor;
    },
  };
  const a = fixture({ billStore, sourceStore, zohoOverrides, bill: { ...validBill(), bill_number: 'INV-A' } });
  const b = fixture({ billStore, sourceStore, zohoOverrides, bill: { ...validBill(), bill_number: 'INV-B' } });
  await Promise.all([a.send('Invoice A'), b.send('Invoice B', { senderPhone: '+971501234567' })]);
  const results = await Promise.all([a.send('SAVE'), b.send('SAVE', { senderPhone: '+971501234567' })]);
  assert.deepEqual(results.map(result => result.state), ['COMPLETED', 'COMPLETED']);
  assert.equal(creates, 1);
  assert.equal(a.calls.find(call => call[0] === 'create')[1].vendorId, 'shared-vendor');
  assert.equal(b.calls.find(call => call[0] === 'create')[1].vendorId, 'shared-vendor');
  assert.equal((await billStore.getBill(results[0].billId)).zoho_vendor_id, 'shared-vendor');
  assert.equal((await billStore.getBill(results[1].billId)).zoho_vendor_id, 'shared-vendor');
});

test('ambiguous, inactive, and cross-organization vendor results block review and creation', async () => {
  for (const [vendors, expected] of [
    [[{ id: 'a', name: 'Supplier LLC' }, { id: 'b', name: 'Supplier L.L.C.' }], /Multiple vendors match/],
    [[{ id: 'inactive', name: 'Supplier LLC', status: 'inactive' }], /inactive/],
    [[{ id: 'other-org', name: 'Supplier LLC', organizationId: '802911060' }], /does not belong/],
  ]) {
    const f = fixture({ zohoOverrides: {
      async searchVendor() { return vendors; },
      async createVendor() { assert.fail('Unsafe vendor creation'); },
    } });
    const first = await f.send('Invoice details');
    assert.match(first.replyText, expected);
    assert.doesNotMatch(first.replyText, /BILL DETAILS|1 SAVE/);
    await f.send('SAVE');
    assert.equal(count(f, 'create'), 0);
  }
});

test('worker vendor TRN disambiguates same-name vendors without guessing', async () => {
  const f = fixture({ zohoOverrides: {
    async searchVendor() { return [
      { id: 'wrong-trn', name: 'Supplier LLC', trn: '100000000000001', status: 'active' },
      { id: 'right-trn', name: 'Supplier L.L.C.', trn: '100000000000002', status: 'active' },
    ]; },
  } });
  const first = await f.send('Invoice details');
  assert.equal(first.state, 'WAITING_FOR_ADDITIONAL_INFO');
  const corrected = await f.send('Vendor TRN: 100000000000002');
  assert.equal(corrected.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(corrected.bill.zoho_vendor_id, 'right-trn');
  await f.send('SAVE');
  assert.equal(f.calls.find(call => call[0] === 'create')[1].vendorId, 'right-trn');
});

test('a previously created vendor ID is not discarded or duplicated when a later lookup misses it', async () => {
  let vendorCreates = 0;
  const f = fixture({ zohoOverrides: {
    async searchVendor() { return []; },
    async createVendor({ name }) { vendorCreates++; return { id: 'created-vendor', name }; },
    async createBill() { throw Object.assign(Error('definite validation rejection'), { httpStatus: 400, providerCode: 100 }); },
  } });
  const first = await f.send('Invoice details');
  await f.send('SAVE');
  assert.equal((await f.billStore.getBillSession(first.sessionId)).bill_data.zoho_vendor_id, 'created-vendor');
  const retry = await f.send('SAVE');
  assert.match(retry.replyText, /reviewed vendor has changed/i);
  assert.equal(vendorCreates, 1);
  assert.equal((await f.billStore.getBillSession(first.sessionId)).bill_data.zoho_vendor_id, 'created-vendor');
});

test('uncertain new-vendor creation keeps the draft locked and never retries the vendor POST', async () => {
  let vendorCreates = 0;
  const f = fixture({ zohoOverrides: {
    async searchVendor() { return []; },
    async createVendor() { vendorCreates++; throw Error('uncertain result'); },
  } });
  await f.send('Invoice details');
  assert.match((await f.send('SAVE')).replyText, /locked to prevent duplicate vendors/);
  await f.send('SAVE');
  assert.equal(vendorCreates, 1);
  assert.equal(count(f, 'create'), 0);
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
test('successful attachment upload retains original image bytes, bill ID and organization, without duplicate upload', async () => {
  const original = Buffer.from('original-worker-image');
  let attempts = 0;
  const f = fixture({ whatsappOverrides: {
    async downloadMedia() { return { buffer: original, mimeType: 'image/jpeg' }; },
  }, zohoOverrides: {
    async attachBillFile({ billId, buffer, organizationId }) {
      attempts++;
      assert.equal(billId, '123456');
      assert.equal(organizationId, '828765858');
      assert.equal(buffer.equals(original), true);
      return { attachmentId: 'attachment-1', success: true };
    },
  } });
  const first = await f.send('', { mediaId: 'image-1', messageType: 'image' });
  const result = await f.send('SAVE');
  assert.equal(result.state, 'COMPLETED');
  const saved = await f.billStore.getBill(first.billId);
  assert.equal(saved.zoho_bill_id, '123456');
  assert.equal(saved.attachments[0].zoho_upload_status, 'uploaded');
  assert.equal(saved.attachments[0].zoho_attachment_id, 'attachment-1');
  assert.equal(attempts, 1);
  await f.send('SAVE');
  assert.equal(attempts, 1);
});
test('definite attachment failure retains bill and original PDF, then SAVE retries upload only', async () => {
  const original = Buffer.from('%PDF-worker-original');
  let attempts = 0;
  const f = fixture({ whatsappOverrides: {
    async downloadMedia() { return { buffer: original, mimeType: 'application/pdf' }; },
  }, zohoOverrides: {
    async attachBillFile({ billId, buffer, organizationId }) {
      attempts++;
      assert.equal(billId, '123456');
      assert.equal(organizationId, '828765858');
      assert.equal(buffer.equals(original), true);
      if (attempts === 1) throw Object.assign(Error('rejected'), { httpStatus: 422 });
      return { id: 'pdf-attachment' };
    },
  } });
  const first = await f.send('', { mediaId: 'pdf-1', messageType: 'document' });
  const failed = await f.send('SAVE');
  assert.equal(failed.state, 'CREATING_IN_ZOHO');
  assert.match(failed.replyText, /Attachment upload failed/);
  assert.equal((await f.billStore.getBill(first.billId)).attachments[0].zoho_upload_status, 'failed');
  assert.equal((await f.billStore.getBill(first.billId)).zoho_bill_id, '123456');
  assert.ok(await f.billStore.getActiveBillSession(WORKER));
  const retried = await f.send('SAVE');
  assert.equal(retried.state, 'COMPLETED');
  assert.equal((await f.billStore.getBill(first.billId)).attachments[0].zoho_upload_status, 'uploaded');
  assert.equal(attempts, 2);
  assert.equal(count(f, 'create'), 1);
  assert.equal(count(f, 'document'), 1);
});
test('successful upload with uncertain status persistence does not POST a second time', async () => {
  const billStore = memoryStore();
  const update = billStore.updateBill.bind(billStore);
  let failOnce = true, attempts = 0;
  billStore.updateBill = async (id, values) => {
    if (failOnce && values.attachments?.some(item => item.zoho_upload_status === 'uploaded')) {
      failOnce = false;
      throw Error('write acknowledgement lost');
    }
    return update(id, values);
  };
  const f = fixture({ billStore, zohoOverrides: {
    async attachBillFile() { attempts++; return { id: 'remote-attachment' }; },
  } });
  const first = await f.send('', { mediaId: 'image-1', messageType: 'image' });
  const result = await f.send('SAVE');
  assert.equal(result.state, 'CREATING_IN_ZOHO');
  assert.equal((await billStore.getBill(first.billId)).attachments[0].zoho_upload_status, 'uncertain');
  assert.match(result.replyText, /reconcile/);
  await f.send('SAVE');
  assert.equal(attempts, 1);
  assert.equal(count(f, 'create'), 1);
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
