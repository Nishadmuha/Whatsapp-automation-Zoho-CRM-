'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, validBill } = require('./billFixtures');

const count = (f, operation) => f.calls.filter(call => call[0] === operation).length;

test('AI payment suggestions and invoice captions require a separate worker method reply before SAVE', async () => {
  for (const source of [{ text: 'Bill' }, { text: 'Payment method: Cheque', messageType: 'image', mediaId: 'bill-image' }]) {
    const f = fixture({ bill: { ...validBill(), payment_type: 'Cheque', payment_method_confirmed: true }, workerAnswers: null, workerPaymentMethod: null });
    const first = await f.send(source.text, source);
    assert.match(first.replyText, /confirm the payment method/i);
    assert.equal(first.bill.payment_method_confirmed, false);
    assert.equal((await f.billStore.getBill(first.billId)).payment_method_confirmed, false);
    for (const command of ['SAVE', '1', 'yes']) {
      const blocked = await f.send(command);
      assert.match(blocked.replyText, /confirm the payment method/i);
      assert.equal(blocked.bill.payment_method_confirmed, false);
    }
    assert.equal(count(f, 'create'), 0);
    const confirmed = await f.send('Cash');
    assert.equal(confirmed.bill.payment_type, 'Cash');
    assert.equal(confirmed.bill.payment_method_confirmed, true);
    assert.equal(confirmed.state, 'WAITING_FOR_PAYMENT_STATUS');
    assert.equal(count(f, 'edit'), 0, 'method replies should not call the AI');
    assert.equal((await f.send('UNPAID')).state, 'AWAITING_FINAL_CONFIRMATION');
    assert.equal((await f.send('SAVE')).state, 'COMPLETED');
    assert.equal(f.calls.find(call => call[0] === 'create')[1].paymentType, 'Cash');
  }
});

test('worker method remains authoritative through AI edits, further invoice pages and save', async () => {
  const f = fixture({ bill: { ...validBill(), payment_type: 'Cheque' }, workerPaymentMethod: null, workerAnswers: null, extractionOverrides: {
    async applyEditInstructions({ currentBill }) { return { success: true, bill: { ...currentBill, notes: 'updated', payment_type: 'Cheque', payment_method_confirmed: false } }; },
    async mergeAdditionalInfo({ currentBill }) { return { success: true, bill: { ...currentBill, payment_type: 'Cheque', payment_method_confirmed: false } }; },
  } });
  await f.send('Bill');
  await f.send('Payment method: Bank Transfer');
  await f.send('UNPAID');
  for (const correction of [{ text: 'Update the notes' }, { text: 'Another invoice page', messageType: 'image', mediaId: 'page-2' }]) {
    await f.send('EDIT');
    const result = await f.send(correction.text, correction);
    assert.equal(result.bill.payment_type, 'Bank Transfer');
    assert.equal(result.bill.payment_method_confirmed, true);
  }
  const explicitChange = await f.send('Payment method: Cash');
  assert.equal(explicitChange.bill.payment_type, 'Cash');
  assert.equal(explicitChange.bill.payment_method_confirmed, true);
  await f.send('SAVE');
  assert.equal(f.calls.find(call => call[0] === 'create')[1].paymentType, 'Cash');
});

test('worker Cash override replaces AI Cheque on the paid bill and its selected-account payment', async () => {
  const payments = [];
  const f = fixture({ bill: { ...validBill(), payment_type: 'Cheque' }, workerPaymentMethod: null, workerAnswers: null, zohoOverrides: {
    async listPaymentAccounts({ paymentType, organizationId }) {
      return paymentType === 'Cash' ? [{ id: 'cash-1', name: 'Petty Cash', type: 'cash', organizationId }] : [];
    },
    async prepareBillPayment({ paymentType, paymentAccountId, organizationId }) {
      assert.equal(paymentType, 'Cash');
      assert.equal(organizationId, '828765858');
      if (!paymentAccountId) throw Object.assign(new Error('Select account'), { code: 'PAYMENT_ACCOUNT_CONFIG_REQUIRED' });
      assert.equal(paymentAccountId, 'cash-1');
      return { accountId: 'cash-1', accountName: 'Petty Cash' };
    },
    async verifyBillTotal(_billId, { expectedTotal }) {
      assert.equal(expectedTotal, 105);
      return { total: 105, currencyCode: 'AED' };
    },
    async recordBillPayment(input) { payments.push(input); return { id: 'payment-1', status: 'paid' }; },
  } });
  const first = await f.send('Bill');
  assert.equal(first.bill.payment_type, 'Cheque');
  assert.equal(first.bill.payment_method_confirmed, false);
  await f.send('Cash');
  const accounts = await f.send('PAID');
  assert.equal(accounts.state, 'WAITING_FOR_PAYMENT_ACCOUNT');
  assert.equal(payments.length, 0);
  const review = await f.send('Select cash', { interactiveId: 'zoho-payment-account:cash-1' });
  assert.equal(review.state, 'AWAITING_FINAL_CONFIRMATION');
  assert.equal(review.bill.payment_type, 'Cash');
  assert.equal(review.bill.payment_account_id, 'cash-1');
  assert.equal(count(f, 'create'), 0);
  assert.equal((await f.send('SAVE')).state, 'COMPLETED');
  assert.equal(f.calls.find(call => call[0] === 'create')[1].paymentType, 'Cash');
  assert.equal(payments.length, 1);
  assert.equal(payments[0].paymentType, 'Cash');
  assert.equal(payments[0].paymentAccountId, 'cash-1');
  assert.equal(payments[0].amount, 105);
  assert.equal(payments[0].organizationId, '828765858');
  const saved = await f.billStore.getBill(first.billId);
  assert.equal(saved.payment_method_confirmed, true);
  assert.equal(saved.payment_recording_status, 'RECORDED');
  assert.equal(saved.zoho_total, payments[0].amount);
});

test('legacy ready drafts cannot reach PAID preflight or creation without confirmed method', async () => {
  let prepared = 0;
  const f = fixture({ workerPaymentMethod: null, workerAnswers: null, zohoOverrides: {
    async prepareBillPayment() { prepared++; return { accountId: 'cash-1' }; },
  } });
  const first = await f.send('Bill');
  const legacy = { ...first.bill, payment_status: 'paid' };
  delete legacy.payment_method_confirmed;
  await f.billStore.updateBillSession(first.sessionId, { state: 'AWAITING_FINAL_CONFIRMATION', bill_data: legacy });
  const blocked = await f.send('SAVE');
  assert.match(blocked.replyText, /confirm the payment method/i);
  assert.equal(prepared, 0);
  assert.equal(count(f, 'create'), 0);
  await f.send('Cash');
  assert.equal((await f.send('SAVE')).state, 'CREATING_IN_ZOHO');
  assert.equal(prepared, 1);
});

test('customer and vendor names containing a method cannot replace the worker method', async () => {
  const f = fixture({ workerPaymentMethod: null });
  await f.send('Bill');
  await f.send('Cash');
  const updated = await f.send('Vendor: Cheque Printing LLC');
  assert.equal(updated.bill.payment_type, 'Cash');
  assert.equal(updated.bill.payment_method_confirmed, true);
});

test('retrying a created legacy paid bill cannot record an unconfirmed AI payment method', async () => {
  let payments = 0;
  const f = fixture({ workerPaymentMethod: null, workerAnswers: null, zohoOverrides: {
    async recordBillPayment() { payments++; return { id: 'payment', status: 'paid' }; },
  } });
  const first = await f.send('Bill');
  await f.billStore.updateBill(first.billId, { zoho_bill_id: 'existing-bill', payment_status: 'paid', payment_recording_status: 'FAILED' });
  await f.billStore.updateBillSession(first.sessionId, { state: 'CREATING_IN_ZOHO' });
  const result = await f.send('SAVE');
  assert.match(result.replyText, /payment method was never confirmed/);
  assert.equal(payments, 0);
  assert.equal(count(f, 'create'), 0);
});
