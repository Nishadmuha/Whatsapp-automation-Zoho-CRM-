'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, validBill } = require('./billFixtures');

const count = (f, operation) => f.calls.filter(call => call[0] === operation).length;

test('all organization customers are reachable through bounded WhatsApp pages and exact current-page IDs', async () => {
  const customers = Array.from({ length: 25 }, (_, i) => ({ contactId: `customer-${i + 1}`, contactName: `Customer ${i + 1}`, organizationId: '828765858' }));
  const f = fixture({ workerAnswers: null, bill: { ...validBill(), customer_details: null }, zohoOverrides: {
    async searchCustomer() { return customers; },
    async getCustomer(id) { return customers.find(customer => customer.contactId === id); },
  } });
  let result = await f.send('Bill');
  const firstId = result.sessionId;
  assert.match(result.replyInteractive.body, /Page 1\/4 \(25 customers\)/);
  const seen = new Set();
  for (let page = 0; page < 4; page++) {
    const rows = result.replyInteractive.sections[0].rows;
    assert.ok(rows.length <= 10);
    rows.filter(row => row.id.startsWith('zoho-customer:')).forEach(row => seen.add(row.id));
    if (page < 3) result = await f.send('More', { interactiveId: 'zoho-customers:next' });
  }
  assert.equal(seen.size, 25);
  const stale = await f.send('Old choice', { interactiveId: 'zoho-customer:customer-1' });
  assert.equal(stale.state, 'WAITING_FOR_CUSTOMER_SELECTION');
  const chosen = await f.send('1');
  assert.equal(chosen.bill.customer_details.contact_id, 'customer-25');
  assert.equal(chosen.state, 'WAITING_FOR_PROJECT_DETAILS');
  assert.equal((await f.billStore.getBillSession(firstId)).bill_data.customer_details.contact_id, 'customer-25');
});

test('manual details work during a failed customer lookup, then project and payment are collected before SAVE', async () => {
  const f = fixture({ workerAnswers: null, bill: { ...validBill(), customer_details: null }, zohoOverrides: {
    async searchCustomer() { throw new Error('offline'); },
  } });
  await f.send('Bill');
  const customer = await f.send('MANUAL: Car Motor LLC; Phone: 0501234567; Email: accounts@example.invalid');
  assert.equal(customer.state, 'WAITING_FOR_PROJECT_DETAILS');
  assert.equal(customer.bill.customer_details.contact_id, null);
  assert.match(customer.replyMessages.join('\n'), /accounts@example.invalid/);
  const project = await f.send('Motor repair, Al Quoz workshop');
  assert.equal(project.state, 'WAITING_FOR_PAYMENT_STATUS');
  assert.equal(count(f, 'create'), 0);
  assert.equal((await f.send('SAVE')).state, 'WAITING_FOR_PAYMENT_STATUS');
  const review = await f.send('UNPAID');
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.match(review.replyText, /Motor repair, Al Quoz workshop/);
  assert.equal(count(f, 'create'), 0);
  const saved = await f.send('SAVE');
  assert.equal(saved.state, 'COMPLETED');
  assert.match(f.calls.find(call => call[0] === 'create')[1].notes, /Project\/site: Motor repair, Al Quoz workshop/);
});

test('a worker can change customer while project is pending and partial details persist their actual waiting state', async () => {
  const f = fixture({ workerAnswers: null, bill: { ...validBill(), customer_details: null }, zohoOverrides: { async searchCustomer() { return []; } } });
  const initial = await f.send('Bill');
  await f.send('MANUAL: Old Customer');
  const partial = await f.send('Customer: Phone: 0501234567');
  assert.equal(partial.state, 'WAITING_FOR_PROJECT_DETAILS');
  const changed = await f.send('MANUAL: New Customer');
  assert.equal(changed.bill.customer_details.customer_name, 'New Customer');
  assert.equal(changed.bill.customer_details.project_site, undefined);
  assert.equal((await f.billStore.getBillSession(initial.sessionId)).state, 'WAITING_FOR_PROJECT_DETAILS');
});

test('invoice OCR and model edits cannot assert the worker paid status', async () => {
  const f = fixture({ workerAnswers: null, bill: { ...validBill(), payment_status: 'paid' }, extractionOverrides: {
    async applyEditInstructions({ currentBill }) { return { success: true, bill: { ...currentBill, payment_status: 'paid', notes: 'changed' } }; },
  } });
  const first = await f.send('Bill');
  assert.equal(first.state, 'WAITING_FOR_PAYMENT_STATUS');
  await f.send('UNPAID');
  await f.send('EDIT');
  const edited = await f.send('Change the notes');
  assert.equal(edited.bill.payment_status, 'unpaid');
});

test('paid bill waits for SAVE, validates account, verifies total and records payment before completion', async () => {
  const events = [];
  const f = fixture({ workerAnswers: null, zohoOverrides: {
    async prepareBillPayment(input) { events.push(['account', input]); },
    async verifyBillTotal(id, input) { events.push(['verify', id, input]); return { total: 105, currencyCode: 'AED' }; },
    async recordBillPayment(input) { events.push(['payment', input]); return { id: 'payment-1', status: 'paid', balance: 0 }; },
  } });
  const first = await f.send('Bill');
  const paid = await f.send('PAID');
  assert.equal(paid.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(events.length, 0);
  assert.equal(count(f, 'create'), 0);
  const saved = await f.send('SAVE');
  assert.equal(saved.state, 'COMPLETED');
  assert.deepEqual(events.map(event => event[0]), ['account', 'verify', 'payment']);
  assert.equal(events[2][1].amount, 105);
  assert.equal(events[2][1].organizationId, '828765858');
  const record = await f.billStore.getBill(first.billId);
  assert.equal(record.zoho_payment_id, 'payment-1');
  assert.equal(record.payment_recording_status, 'RECORDED');
  assert.match(saved.replyText, /Paid.*recorded/i);
});

test('AED 700.02 payment uses the freshly verified Zoho bill total after rounding reconciliation', async () => {
  const payments = [];
  const f = fixture({ workerAnswers: null, bill: { ...validBill(), subtotal: 666.68, tax_amount: 33.34, total_amount: 700.02,
    line_items: [{ name: 'Concrete', quantity: 5, rate: 133.336, amount: 666.68, tax_percentage: 5 }] }, zohoOverrides: {
    async prepareBillPayment() { return { accountId: '101', accountName: 'Petty Cash' }; },
    async verifyBillTotal(_id, input) {
      assert.equal(input.expectedTotal, 700.02);
      return { total: 700.02, currencyCode: 'AED' };
    },
    async recordBillPayment(input) { payments.push(input); return { id: 'payment-1', status: 'paid' }; },
  } });
  const initial = await f.send('Bill');
  await f.send('PAID');
  await f.billStore.updateBill(initial.billId, { zoho_total: 699.99 });
  assert.equal((await f.send('SAVE')).state, 'COMPLETED');
  assert.equal(payments.length, 1);
  assert.equal(payments[0].amount, 700.02);
  assert.equal((await f.billStore.getBill(initial.billId)).zoho_total, 700.02);
});

test('missing payment-account configuration prevents any bill creation', async () => {
  const f = fixture({ workerAnswers: null, zohoOverrides: {
    async prepareBillPayment() { throw Object.assign(new Error('configuration'), { code: 'PAYMENT_ACCOUNT_CONFIG_REQUIRED' }); },
  } });
  await f.send('Bill'); await f.send('PAID');
  const result = await f.send('SAVE');
  assert.equal(result.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.match(result.replyText, /payment account/);
  assert.equal(count(f, 'create'), 0);
});

test('saved-total mismatch never reports success or pays, and verification retry never creates another bill', async () => {
  let failing = true, payments = 0;
  const f = fixture({ workerAnswers: null, zohoOverrides: {
    async prepareBillPayment() {},
    async verifyBillTotal() {
      if (failing) throw Object.assign(new Error('difference'), { code: 'BILL_TOTAL_MISMATCH' });
      return { total: 105, currencyCode: 'AED' };
    },
    async recordBillPayment() { payments++; return { id: 'p1', status: 'paid' }; },
  } });
  const initial = await f.send('Bill'); await f.send('PAID');
  const blocked = await f.send('SAVE');
  assert.equal(blocked.state, 'CREATING_IN_ZOHO');
  assert.doesNotMatch(blocked.replyText, /BILL SAVED/);
  assert.equal((await f.billStore.getBill(initial.billId)).amount_verification_status, 'MISMATCH');
  assert.equal(payments, 0);
  assert.equal(count(f, 'document'), 0);
  failing = false;
  assert.equal((await f.send('SAVE')).state, 'COMPLETED');
  assert.equal(count(f, 'create'), 1);
  assert.equal(payments, 1);
});

test('uncertain payment is reconciled by reading Zoho and never posts a second payment', async () => {
  let payments = 0, confirmed = false;
  const f = fixture({ workerAnswers: null, zohoOverrides: {
    async prepareBillPayment() {},
    async recordBillPayment() { payments++; throw Object.assign(new Error('read failed'), { code: 'PAYMENT_OUTCOME_UNCONFIRMED', paymentId: 'payment-known' }); },
    async getBill() { return { status: confirmed ? 'paid' : 'open', balance: confirmed ? 0 : 105, total: 105, currencyCode: 'AED', vendorId: 'v1' }; },
  } });
  const first = await f.send('Bill'); await f.send('PAID'); await f.send('SAVE');
  assert.equal((await f.billStore.getBill(first.billId)).zoho_payment_id, 'payment-known');
  assert.match((await f.send('SAVE')).replyText, /unconfirmed/);
  confirmed = true;
  assert.equal((await f.send('SAVE')).state, 'COMPLETED');
  assert.equal(payments, 1);
  assert.equal(count(f, 'create'), 1);
});

test('an already-paid verified Zoho bill is accepted without inventing a payment ID', async () => {
  const f = fixture({ workerAnswers: null, zohoOverrides: {
    async prepareBillPayment() {},
    async recordBillPayment() { return { id: null, status: 'paid', alreadyPaid: true }; },
  } });
  const first = await f.send('Bill'); await f.send('PAID');
  assert.equal((await f.send('SAVE')).state, 'COMPLETED');
  const record = await f.billStore.getBill(first.billId);
  assert.equal(record.payment_recording_status, 'RECORDED');
  assert.equal(record.zoho_payment_id, null);
});

for (const code of ['PAYMENT_PREFLIGHT_FAILED', 'PAYMENT_REJECTED']) test(`${code} permits payment retry without another bill`, async () => {
  let attempts = 0;
  const f = fixture({ workerAnswers: null, zohoOverrides: {
    async prepareBillPayment() {},
    async recordBillPayment() {
      if (++attempts === 1) throw Object.assign(new Error('safe failure'), { code });
      return { id: 'p1', status: 'paid' };
    },
  } });
  const initial = await f.send('Bill'); await f.send('PAID'); await f.send('SAVE');
  assert.equal((await f.billStore.getBill(initial.billId)).payment_recording_status, 'FAILED');
  assert.equal((await f.send('SAVE')).state, 'COMPLETED');
  assert.equal(count(f, 'create'), 1);
  assert.equal(attempts, 2);
});

test('missing vendor-payment OAuth scope blocks paid bills before create', async () => {
  const f = fixture({ workerAnswers: null, zohoOverrides: {
    async prepareBillPayment() { throw Object.assign(new Error('missing'), { code: 'PAYMENT_SCOPE_REQUIRED' }); },
  } });
  await f.send('Bill'); await f.send('PAID');
  const result = await f.send('SAVE');
  assert.match(result.replyText, /ZohoBooks.vendorpayments.CREATE/);
  assert.equal(count(f, 'create'), 0);
});

test('organization change clears customer paging cache even when the next lookup fails', async () => {
  const f = fixture({ workerAnswers: null, bill: { ...validBill(), customer_details: null }, zohoOverrides: {
    async searchCustomer({ organizationId }) {
      if (organizationId === '802911060') throw new Error('offline');
      return [{ contactId: 'old-org-customer', contactName: 'Old company', organizationId }];
    },
  } });
  const first = await f.send('Bill');
  await f.send('VOLTRONIX SWITCHGEAR LLC');
  const result = await f.send('NEXT');
  assert.equal(result.replyInteractive, undefined);
  const session = await f.billStore.getBillSession(first.sessionId);
  assert.deepEqual(session.customer_options, []);
  assert.deepEqual(session.customer_all_options, []);
});

test('a different customer requires a new project instead of reusing the previous customer project', async () => {
  const customer = { contactId: 'new-customer', contactName: 'New customer', organizationId: '828765858' };
  const f = fixture({ workerAnswers: null, bill: { ...validBill(), customer_details: {
    customer_name: 'Old Customer', contact_id: 'old-customer', organization_id: '828765858', project_site: 'Old site',
  } }, zohoOverrides: { async searchCustomer() { return [customer]; }, async getCustomer() { return customer; } } });
  await f.send('Bill'); await f.send('UNPAID');
  await f.send('Customer: New');
  const selected = await f.send('1');
  assert.equal(selected.bill.customer_details.contact_id, 'new-customer');
  assert.equal(selected.bill.customer_details.project_site, undefined);
  assert.equal(selected.state, 'WAITING_FOR_PROJECT_DETAILS');
});
